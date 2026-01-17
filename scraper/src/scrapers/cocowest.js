/**
 * Cocowest.ca Scraper
 * Scrapes Costco West deals from the Cocowest blog
 */

import * as cheerio from 'cheerio';

const COCOWEST_URL = 'https://cocowest.ca/';

/**
 * Fetches and parses deals from Cocowest
 * @returns {Promise<Array<Deal>>} Array of deal objects
 */
export async function scrapeCocowest() {
  // First, find the latest deals post
  const response = await fetch(COCOWEST_URL);
  const html = await response.text();
  const $ = cheerio.load(html);

  // Find the latest flyer post link
  // Cocowest typically titles these "Costco Flyer & Costco Sale Items for..."
  const latestPostLink = $('a[href*="costco-flyer-costco-sale-items"]').first().attr('href')
    || $('a[href*="weekend-update-costco-sale-items"]').first().attr('href');

  if (!latestPostLink) {
    console.log('Could not find latest deals post. Trying homepage content...');
    return parseDealsFromPage($, 'homepage');
  }

  console.log(`Found latest post: ${latestPostLink}`);

  // Fetch the actual deals post
  const postResponse = await fetch(latestPostLink);
  const postHtml = await postResponse.text();
  const post$ = cheerio.load(postHtml);

  return parseDealsFromPage(post$, latestPostLink);
}

/**
 * Parses deals from a Cocowest page
 * @param {CheerioAPI} $ - Cheerio instance
 * @param {string} source - Source URL for logging
 * @returns {Array<Deal>}
 */
function parseDealsFromPage($, source) {
  const deals = [];

  // Cocowest typically lists deals in the post content
  // Look for price patterns like "$XX.XX" with savings info
  const content = $('.entry-content').html() || $('article').html() || $('body').html();

  if (!content) {
    console.log('No content found on page');
    return deals;
  }

  // Extract text content and look for deal patterns
  // Pattern: "Product Name ... $XX.XX ... Save $X.XX" or similar
  const text = $('.entry-content').text() || $('article').text();

  // Simple regex-based extraction (will need refinement based on actual page structure)
  // Looking for patterns like: "Product Name $XX.XX Save $X.XX"
  const pricePattern = /([A-Za-z][\w\s&\-\+\/\(\),'\.]+?)\s*\$(\d+\.?\d*)\s*(?:Save\s*\$(\d+\.?\d*))?/gi;

  let match;
  while ((match = pricePattern.exec(text)) !== null) {
    const productName = match[1].trim();
    const price = parseFloat(match[2]);
    const savings = match[3] ? parseFloat(match[3]) : 0;

    // Skip if product name is too short or looks like noise
    if (productName.length < 3 || /^(and|the|for|with)$/i.test(productName)) {
      continue;
    }

    const regularPrice = price + savings;
    const savingsPercent = savings > 0 ? (savings / regularPrice) * 100 : 0;

    deals.push({
      product_name: productName,
      regular_price: regularPrice,
      sale_price: price,
      savings_amount: savings,
      savings_percent: Math.round(savingsPercent * 10) / 10,
      category: categorizeProduct(productName),
      source: 'cocowest',
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
