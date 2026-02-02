/**
 * Cocowest.ca Scraper
 * Scrapes Costco West deals from multiple Cocowest blog posts.
 * Uses content-based detection to identify deals posts rather than rigid URL patterns.
 */

import * as cheerio from 'cheerio';

const COCOWEST_URL = 'https://cocowest.ca/';

/**
 * Month name lookup supporting both full and abbreviated names.
 */
const MONTH_NAMES = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11
};

/**
 * Normalizes a month name to its full capitalized form.
 * @param {string} month - Month name (full or abbreviated)
 * @returns {string} Full month name capitalized
 */
function normalizeMonthName(month) {
  const fullNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthNum = MONTH_NAMES[month.toLowerCase()];
  return monthNum !== undefined ? fullNames[monthNum] : month;
}

/**
 * Parses date range from text using flexible patterns.
 * Looks for common date range formats in titles, URLs, or content.
 * @param {string} text - Text containing potential date range
 * @returns {{ validFrom: string, validTo: string, displayDates: string } | null}
 */
function parseDateRange(text) {
  // Flexible month pattern (full or abbreviated)
  const monthPattern = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec)';

  // Cross-month patterns: "January 26 – February 1, 2026" or "january-26-feb-1-2026"
  const crossMonthPatterns = [
    // Title format with various separators (em dash, en dash, hyphen, "to")
    new RegExp(`${monthPattern}\\s+(\\d{1,2})\\s*[–—-]\\s*${monthPattern}\\s+(\\d{1,2}),?\\s*(\\d{4})`, 'i'),
    new RegExp(`${monthPattern}\\s+(\\d{1,2})\\s+to\\s+${monthPattern}\\s+(\\d{1,2}),?\\s*(\\d{4})`, 'i'),
    // URL format: "january-26-february-1-2026" or "january-26-feb-1-2026"
    new RegExp(`${monthPattern}[\\s-]+(\\d{1,2})[\\s-]+${monthPattern}[\\s-]+(\\d{1,2})[\\s-]+(\\d{4})`, 'i'),
  ];

  for (const pattern of crossMonthPatterns) {
    const match = text.match(pattern);
    if (match) {
      const startMonth = MONTH_NAMES[match[1].toLowerCase()];
      const startDay = parseInt(match[2]);
      const endMonth = MONTH_NAMES[match[3].toLowerCase()];
      const endDay = parseInt(match[4]);
      const year = parseInt(match[5]);

      if (startMonth === undefined || endMonth === undefined) continue;

      const validFrom = new Date(year, startMonth, startDay);
      const endYear = endMonth < startMonth ? year + 1 : year;
      const validTo = new Date(endYear, endMonth, endDay, 23, 59, 59);

      return {
        validFrom: validFrom.toISOString().split('T')[0],
        validTo: validTo.toISOString().split('T')[0],
        displayDates: `${normalizeMonthName(match[1])} ${startDay} - ${normalizeMonthName(match[3])} ${endDay}, ${endYear}`
      };
    }
  }

  // Same-month patterns: "January 19-25, 2026" or "january-19-25-2026"
  const sameMonthPatterns = [
    new RegExp(`${monthPattern}\\s+(\\d{1,2})\\s*[–—-]\\s*(\\d{1,2}),?\\s*(\\d{4})`, 'i'),
    new RegExp(`${monthPattern}[\\s-]+(\\d{1,2})[\\s-]+(\\d{1,2})[\\s-]+(\\d{4})`, 'i'),
  ];

  for (const pattern of sameMonthPatterns) {
    const match = text.match(pattern);
    if (match) {
      const month = MONTH_NAMES[match[1].toLowerCase()];
      const startDay = parseInt(match[2]);
      const endDay = parseInt(match[3]);
      const year = parseInt(match[4]);

      if (month === undefined) continue;

      const validFrom = new Date(year, month, startDay);
      const validTo = new Date(year, month, endDay, 23, 59, 59);

      return {
        validFrom: validFrom.toISOString().split('T')[0],
        validTo: validTo.toISOString().split('T')[0],
        displayDates: `${normalizeMonthName(match[1])} ${startDay}-${endDay}, ${year}`
      };
    }
  }

  return null;
}

/**
 * Checks if a URL looks like it could be a sales/deals post.
 * Uses broad keyword matching rather than exact patterns.
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isPotentialSalesUrl(url) {
  const lowerUrl = url.toLowerCase();

  // Must be a cocowest.ca post URL
  if (!lowerUrl.includes('cocowest.ca/')) return false;

  // Look for sales-related keywords
  const salesKeywords = ['sale', 'flyer', 'deals', 'update', 'savings'];
  return salesKeywords.some(keyword => lowerUrl.includes(keyword));
}

/**
 * Finds all potential sales post URLs from the homepage.
 * Uses broad keyword matching - verification happens after fetching content.
 * @param {CheerioAPI} $ - Cheerio instance of homepage
 * @returns {Array<{url: string, title: string}>}
 */
function findPotentialSalesPosts($) {
  const posts = [];
  const seen = new Set();

  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text() || '';

    if (seen.has(href)) return;
    if (!isPotentialSalesUrl(href)) return;

    seen.add(href);
    posts.push({
      url: href,
      title: text.trim()
    });
  });

  return posts;
}

/**
 * Checks if page content contains deal patterns.
 * A deals page has product codes (6-7 digits) followed by prices and "INSTANT SAVINGS".
 * @param {string} text - Page text content
 * @returns {boolean}
 */
function hasDealContent(text) {
  // Pattern: product code + price pattern with INSTANT SAVINGS
  const dealPattern = /\d{6,7}\s+[A-Z].*?\$\d+\.?\d*\s+INSTANT SAVINGS/gi;
  const matches = text.match(dealPattern) || [];

  // Require at least 5 deals to consider it a deals page
  return matches.length >= 5;
}

/**
 * Extracts date range from a page's title or content.
 * Tries multiple sources: og:title, page title, h1, entry title, URL.
 * @param {CheerioAPI} $ - Cheerio instance
 * @param {string} url - Page URL as fallback
 * @returns {{ validFrom: string, validTo: string, displayDates: string } | null}
 */
function extractDateRangeFromPage($, url) {
  // Try various sources for the date
  const sources = [
    $('meta[property="og:title"]').attr('content'),
    $('title').text(),
    $('h1.entry-title').text(),
    $('h1').first().text(),
    $('.entry-title').first().text(),
    url
  ];

  for (const source of sources) {
    if (source) {
      const dateRange = parseDateRange(source);
      if (dateRange) return dateRange;
    }
  }

  return null;
}

/**
 * Filters posts to only those valid for the current date.
 * @param {Array} posts - Array of post objects with validFrom/validTo
 * @returns {Array} Posts where today falls within the valid range
 */
function filterValidPosts(posts) {
  const today = new Date().toISOString().split('T')[0];
  return posts.filter(post => post.validFrom <= today && post.validTo >= today);
}

/**
 * Fetches and parses deals from Cocowest.
 * Uses content-based detection: finds potential posts, verifies they have deals,
 * then extracts dates from the verified pages.
 * @returns {Promise<{deals: Array<Deal>, posts: Array, flyerDates: string}>}
 */
export async function scrapeCocowest() {
  // Fetch homepage
  const response = await fetch(COCOWEST_URL);
  const html = await response.text();
  const $ = cheerio.load(html);

  // Find potential sales posts (broad keyword match)
  const potentialPosts = findPotentialSalesPosts($);
  console.log(`Found ${potentialPosts.length} potential sales posts`);

  // Verify each post has deal content and extract dates
  const verifiedPosts = [];
  for (const post of potentialPosts) {
    try {
      const postResponse = await fetch(post.url);
      const postHtml = await postResponse.text();
      const post$ = cheerio.load(postHtml);
      const text = post$('.entry-content').text() || post$('article').text();

      // Skip if no deal content
      if (!hasDealContent(text)) {
        continue;
      }

      // Extract date range from the page
      const dateRange = extractDateRangeFromPage(post$, post.url);
      if (!dateRange) {
        console.log(`  Skipping (no date found): ${post.url}`);
        continue;
      }

      verifiedPosts.push({
        ...post,
        ...dateRange,
        html: postHtml
      });
      console.log(`  Verified: ${dateRange.displayDates}`);
    } catch (error) {
      console.error(`  Error checking post: ${error.message}`);
    }
  }

  console.log(`${verifiedPosts.length} posts verified with deal content`);

  // Filter to only currently valid posts
  const validPosts = filterValidPosts(verifiedPosts);
  console.log(`${validPosts.length} posts are currently valid`);

  // Fallback to most recent if none valid
  if (validPosts.length === 0 && verifiedPosts.length > 0) {
    console.log('No valid posts found. Using most recent post as fallback.');
    validPosts.push(verifiedPosts[0]);
  }

  // Parse deals from each valid post
  const allDeals = [];
  for (const post of validPosts) {
    console.log(`\nScraping: ${post.displayDates}`);
    console.log(`  URL: ${post.url}`);

    const post$ = cheerio.load(post.html);
    const deals = parseDealsFromPage(post$, post.url);
    console.log(`  Found ${deals.length} deals`);

    for (const deal of deals) {
      deal.valid_from = post.validFrom;
      deal.valid_to = post.validTo;
      deal.source_post = post.displayDates;
      allDeals.push(deal);
    }
  }

  // Deduplicate by product code (keep the one with latest valid_to)
  const deduped = deduplicateDeals(allDeals);
  console.log(`\nTotal unique deals: ${deduped.length}`);

  return {
    deals: deduped,
    posts: validPosts.map(p => ({ url: p.url, displayDates: p.displayDates, validFrom: p.validFrom, validTo: p.validTo })),
    flyerDates: validPosts.map(p => p.displayDates).join(' + ')
  };
}

/**
 * Deduplicates deals by product code, keeping the one with latest valid_to date.
 * @param {Array} deals - Array of deals
 * @returns {Array} Deduplicated deals
 */
function deduplicateDeals(deals) {
  const byCode = new Map();

  for (const deal of deals) {
    const key = deal.product_code || deal.product_name;
    const existing = byCode.get(key);

    if (!existing || deal.valid_to > existing.valid_to) {
      byCode.set(key, deal);
    }
  }

  return Array.from(byCode.values());
}

/**
 * Parses deals from a Cocowest page.
 * Looks for the pattern: product_code PRODUCT NAME ($X INSTANT SAVINGS...) $price
 * @param {CheerioAPI} $ - Cheerio instance
 * @param {string} source - Source URL for logging
 * @returns {Array<Deal>}
 */
function parseDealsFromPage($, source) {
  const deals = [];

  // Build image map from product codes in alt text
  const imageMap = {};
  $('img').each((i, el) => {
    const alt = $(el).attr('alt') || '';
    const imageSrc = $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('src') || '';

    const codeMatch = alt.match(/^(\d{6,7})\s/);
    if (codeMatch && imageSrc && !imageSrc.startsWith('data:')) {
      imageMap[codeMatch[1]] = imageSrc;
    }
  });

  const text = $('.entry-content').text() || $('article').text();
  if (!text) {
    console.log('No content found on page');
    return deals;
  }

  // Pattern: {product_code} {PRODUCT NAME} (${savings} INSTANT SAVINGS...) ${sale_price}
  const dealPattern = /(\d{6,7})\s+([A-Z][A-Z0-9\s&\-\+\/,'\.x×]+?)\s+\(\$(\d+\.?\d*)\s+INSTANT SAVINGS[^)]+\)\s+\$(\d+\.?\d*)/gi;

  let match;
  while ((match = dealPattern.exec(text)) !== null) {
    const productCode = match[1];
    const productName = match[2].trim();
    const savingsAmount = parseFloat(match[3]);
    const salePrice = parseFloat(match[4]);

    if (productName.length < 5) continue;

    const regularPrice = salePrice + savingsAmount;
    const savingsPercent = (savingsAmount / regularPrice) * 100;

    deals.push({
      product_code: productCode,
      product_name: productName,
      regular_price: Math.round(regularPrice * 100) / 100,
      sale_price: salePrice,
      savings_amount: savingsAmount,
      savings_percent: Math.round(savingsPercent * 10) / 10,
      category: categorizeProduct(productName),
      image_url: imageMap[productCode] || null,
      scraped_at: new Date().toISOString(),
    });
  }

  return deals;
}

/**
 * Categorizes a product based on keywords in its name.
 * @param {string} productName
 * @returns {string}
 */
function categorizeProduct(productName) {
  const name = productName.toLowerCase();

  if (/vitamin|supplement|medicine|tylenol|advil|cold-fx|centrum/i.test(name)) {
    return 'Health & Wellness';
  }
  if (/tv|laptop|phone|tablet|gaming|computer|printer|camera/i.test(name)) {
    return 'Electronics';
  }
  if (/chicken|beef|pork|salmon|cheese|milk|bread|fruit|vegetable/i.test(name)) {
    return 'Food & Grocery';
  }
  if (/detergent|paper towel|tissue|cleaning|bounty|purex/i.test(name)) {
    return 'Household';
  }
  if (/kirkland/i.test(name)) {
    return 'Kirkland Signature';
  }

  return 'Other';
}
