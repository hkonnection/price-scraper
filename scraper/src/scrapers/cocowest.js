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
