/**
 * Cocowest.ca Scraper
 * Scrapes Costco West deals from multiple Cocowest blog posts
 */

import * as cheerio from 'cheerio';

const COCOWEST_URL = 'https://cocowest.ca/';

/**
 * Parses date range from post title/URL.
 * @param {string} text - Post title or URL containing dates
 * @returns {{ validFrom: string, validTo: string } | null} ISO date strings or null
 */
function parseDateRange(text) {
  const monthNames = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };
  const monthPattern = '(january|february|march|april|may|june|july|august|september|october|november|december)';

  // Cross-month patterns (must check before same-month patterns)
  const crossMonthPatterns = [
    // Title format: "January 26 – February 1, 2026" (em dash, en dash, or hyphen)
    new RegExp(`${monthPattern}\\s+(\\d{1,2})\\s*[–—-]\\s*${monthPattern}\\s+(\\d{1,2}),?\\s*(\\d{4})`, 'i'),
    // URL format: "for-january-26-february-1-2026"
    new RegExp(`for-${monthPattern}-(\\d{1,2})-${monthPattern}-(\\d{1,2})-(\\d{4})`, 'i'),
  ];

  for (const pattern of crossMonthPatterns) {
    const match = text.match(pattern);
    if (match) {
      const startMonth = monthNames[match[1].toLowerCase()];
      const startDay = parseInt(match[2]);
      const endMonth = monthNames[match[3].toLowerCase()];
      const endDay = parseInt(match[4]);
      const year = parseInt(match[5]);

      const validFrom = new Date(year, startMonth, startDay);
      // Handle year rollover (December → January)
      const endYear = endMonth < startMonth ? year + 1 : year;
      const validTo = new Date(endYear, endMonth, endDay, 23, 59, 59);

      const startMonthName = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
      const endMonthName = match[3].charAt(0).toUpperCase() + match[3].slice(1).toLowerCase();

      return {
        validFrom: validFrom.toISOString().split('T')[0],
        validTo: validTo.toISOString().split('T')[0],
        displayDates: `${startMonthName} ${startDay} - ${endMonthName} ${endDay}, ${endYear}`
      };
    }
  }

  // Same-month patterns
  const sameMonthPatterns = [
    // Title format: "January 19-25, 2026"
    new RegExp(`${monthPattern}\\s+(\\d{1,2})-(\\d{1,2}),?\\s*(\\d{4})`, 'i'),
    // URL format: "january-19-25-2026"
    new RegExp(`for-${monthPattern}-(\\d{1,2})-(\\d{1,2})-(\\d{4})`, 'i'),
  ];

  for (const pattern of sameMonthPatterns) {
    const match = text.match(pattern);
    if (match) {
      const month = monthNames[match[1].toLowerCase()];
      const startDay = parseInt(match[2]);
      const endDay = parseInt(match[3]);
      const year = parseInt(match[4]);

      const validFrom = new Date(year, month, startDay);
      const validTo = new Date(year, month, endDay, 23, 59, 59);

      return {
        validFrom: validFrom.toISOString().split('T')[0],
        validTo: validTo.toISOString().split('T')[0],
        displayDates: `${match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()} ${startDay}-${endDay}, ${year}`
      };
    }
  }
  return null;
}

/**
 * Finds all valid sales posts from the homepage.
 * @param {CheerioAPI} $ - Cheerio instance of homepage
 * @returns {Array<{url: string, title: string, validFrom: string, validTo: string, displayDates: string}>}
 */
function findSalesPosts($) {
  const posts = [];
  const seen = new Set();

  // Find all post links that look like sales posts
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text() || '';

    // Skip if already seen this URL
    if (seen.has(href)) return;

    // Must be a sales post (flyer or weekend update)
    const isSalesPost =
      href.includes('costco-flyer-costco-sale-items') ||
      href.includes('costco-sale-items-for') ||
      href.includes('weekend-update-costco-sale-items');

    if (!isSalesPost) return;

    // Try to parse date range from URL or text
    const dateRange = parseDateRange(href) || parseDateRange(text);
    if (!dateRange) return;

    seen.add(href);
    posts.push({
      url: href,
      title: text.trim(),
      ...dateRange
    });
  });

  return posts;
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
 * Scrapes multiple posts and returns all deals with validity dates.
 * @returns {Promise<{deals: Array<Deal>, posts: Array}>} Deals with validity dates
 */
export async function scrapeCocowest() {
  // Fetch homepage
  const response = await fetch(COCOWEST_URL);
  const html = await response.text();
  const $ = cheerio.load(html);

  // Find all sales posts
  const allPosts = findSalesPosts($);
  console.log(`Found ${allPosts.length} sales posts on homepage`);

  // Filter to only currently valid posts
  const validPosts = filterValidPosts(allPosts);
  console.log(`${validPosts.length} posts are currently valid`);

  if (validPosts.length === 0) {
    console.log('No valid posts found. Using most recent post as fallback.');
    if (allPosts.length > 0) {
      validPosts.push(allPosts[0]);
    }
  }

  // Scrape each valid post
  const allDeals = [];
  for (const post of validPosts) {
    console.log(`\nScraping: ${post.displayDates}`);
    console.log(`  URL: ${post.url}`);

    try {
      const postResponse = await fetch(post.url);
      const postHtml = await postResponse.text();
      const post$ = cheerio.load(postHtml);

      const deals = parseDealsFromPage(post$, post.url);
      console.log(`  Found ${deals.length} deals`);

      // Tag each deal with validity dates
      for (const deal of deals) {
        deal.valid_from = post.validFrom;
        deal.valid_to = post.validTo;
        deal.source_post = post.displayDates;
        allDeals.push(deal);
      }
    } catch (error) {
      console.error(`  Error scraping post: ${error.message}`);
    }
  }

  // Deduplicate by product code (keep the one with latest valid_to)
  const deduped = deduplicateDeals(allDeals);
  console.log(`\nTotal unique deals: ${deduped.length}`);

  return {
    deals: deduped,
    posts: validPosts,
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
 * Parses deals from a Cocowest page
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

    // Extract product code from alt text (e.g., "1627198 DURACELL...")
    const codeMatch = alt.match(/^(\d{6,7})\s/);
    if (codeMatch && imageSrc && !imageSrc.startsWith('data:')) {
      imageMap[codeMatch[1]] = imageSrc;
    }
  });

  // Get the main content text
  const text = $('.entry-content').text() || $('article').text();

  if (!text) {
    console.log('No content found on page');
    return deals;
  }

  // Cocowest format: "1627198 DURACELL POWER BOOST AAA BATTERIES PACK OF 40 ($6.00 INSTANT SAVINGS EXPIRES ON 2026-01-25) $19.99"
  // Pattern: {product_code} {PRODUCT NAME} (${savings} INSTANT SAVINGS EXPIRES ON {date}) ${sale_price}
  const dealPattern = /(\d{6,7})\s+([A-Z][A-Z0-9\s&\-\+\/,'\.x×]+?)\s+\(\$(\d+\.?\d*)\s+INSTANT SAVINGS[^)]+\)\s+\$(\d+\.?\d*)/gi;

  let match;
  while ((match = dealPattern.exec(text)) !== null) {
    const productCode = match[1];
    const productName = match[2].trim();
    const savingsAmount = parseFloat(match[3]);
    const salePrice = parseFloat(match[4]);

    // Skip if product name is too short
    if (productName.length < 5) {
      continue;
    }

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
 * Simple product categorization based on keywords
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
