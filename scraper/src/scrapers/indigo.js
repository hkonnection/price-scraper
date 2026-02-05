/**
 * Indigo Canada Scraper
 * Scrapes clearance/markdown deals from indigo.ca Sale & Clearance section.
 * Uses fetch + Cheerio (Salesforce Commerce Cloud / Demandware platform).
 *
 * Only captures items with explicit markdown pricing (original + sale price).
 * Skips bundle/promo deals (e.g., "3 for $20") that lack individual original prices.
 */

import { load } from 'cheerio';

const BASE_URL = 'https://www.indigo.ca';
const SALE_PATH = '/en-ca/sale/shop-all/';
const PAGE_SIZE = 24;
const DELAY_MS = 600;

/**
 * Fetches HTML from a URL with browser-like headers.
 *
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} HTML content
 * @throws {Error} If fetch fails
 */
async function fetchHTML(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-CA,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return await response.text();
}

/**
 * Extracts the total item count from the sale page HTML.
 *
 * @param {object} $ - Cheerio instance
 * @returns {number} Total item count
 */
function extractTotalItems($) {
  const countText = $('.result-count').first().text().trim();
  const match = countText.match(/([\d,]+)\s*items/);
  if (match) {
    return parseInt(match[1].replace(/,/g, ''), 10);
  }
  return 0;
}

/**
 * Parses product tiles from a page of HTML.
 * Only returns items with explicit markdown pricing (sale-true class).
 *
 * @param {string} html - Page HTML
 * @returns {Array<object>} Array of deal objects
 */
function parseProducts(html) {
  const $ = load(html);
  const deals = [];

  $('.product-tile').each((_, tile) => {
    const $tile = $(tile);

    // Only process items with markdown pricing (sale-true = has strikethrough price)
    const $sales = $tile.find('.sales.sale-true');
    if ($sales.length === 0) return;

    const $strikethrough = $tile.find('.strike-through .value');
    if ($strikethrough.length === 0) return;

    // Extract prices from content attributes
    const salePrice = parseFloat($sales.find('.value').attr('content'));
    const regularPrice = parseFloat($strikethrough.attr('content'));

    if (isNaN(salePrice) || isNaN(regularPrice) || salePrice >= regularPrice) return;

    // Product info
    const productName = $tile.find('.pdp-link a h3').text().trim();
    if (!productName) return;

    const productPath = $tile.find('.pdp-link a').attr('href') || '';
    const productUrl = productPath.startsWith('http') ? productPath : `${BASE_URL}${productPath}`;
    const productCode = $tile.attr('data-cnstrc-item-id') || '';
    const brand = $tile.find('.tile-text-light.label-4').first().text().trim() || null;
    const imageUrl = $tile.find('.tile-image').attr('src') || null;

    const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;
    const savingsPercent = Math.round((savingsAmount / regularPrice) * 10000) / 100;

    deals.push({
      product_code: productCode,
      product_name: productName,
      brand,
      regular_price: regularPrice,
      sale_price: salePrice,
      savings_amount: savingsAmount,
      savings_percent: savingsPercent,
      category: categorizeProduct(productName, brand),
      image_url: imageUrl,
      product_url: productUrl,
      in_stock: 1,
      scraped_at: new Date().toISOString(),
    });
  });

  return deals;
}

/**
 * Categorizes a product by name/brand keywords.
 *
 * @param {string} productName - Product name
 * @param {string|null} brand - Brand name
 * @returns {string} Category
 */
function categorizeProduct(productName, brand) {
  const name = (productName || '').toLowerCase();

  if (/book|novel|memoir|stories|poetry|graphic novel|paperback|hardcover/i.test(name)) return 'Books';
  if (/toy|game|puzzle|lego|playset|doll|figurine|plush/i.test(name)) return 'Toys & Games';
  if (/card|stationery|notebook|journal|pen|pencil|marker/i.test(name)) return 'Stationery';
  if (/mug|candle|throw|pillow|blanket|decor|ornament|frame|vase/i.test(name)) return 'Home & Decor';
  if (/bag|tote|backpack|wallet|purse/i.test(name)) return 'Bags & Accessories';
  if (/baby|infant|toddler|onesie|bib/i.test(name)) return 'Baby';
  if (/kobo|e-reader|tablet/i.test(name)) return 'Electronics';
  if (/robe|pajama|slipper|sock/i.test(name)) return 'Apparel';
  if (/craft|kit|paint|diy|activity/i.test(name)) return 'Crafts & Activities';
  if (/cracker|wrap|gift/i.test(name)) return 'Gift & Seasonal';

  return 'Other';
}

/**
 * Scrapes all markdown deals from Indigo Canada Sale & Clearance.
 * Paginates through all pages, filtering to only items with both original and sale prices.
 *
 * @returns {Promise<{deals: Array<object>, totalProducts: number, totalPages: number, markdownCount: number}>}
 */
export async function scrapeIndigo() {
  console.log('Fetching first page to determine total items...');
  const firstPageUrl = `${BASE_URL}${SALE_PATH}?start=0&sz=${PAGE_SIZE}&page=1`;
  const firstPageHtml = await fetchHTML(firstPageUrl);

  const $ = load(firstPageHtml);
  const totalItems = extractTotalItems($);
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

  console.log(`Total sale items: ${totalItems} across ${totalPages} pages`);

  // Parse first page
  const allDeals = parseProducts(firstPageHtml);
  console.log(`Page 1/${totalPages}: ${allDeals.length} markdown deals`);

  // Fetch remaining pages
  for (let page = 2; page <= totalPages; page++) {
    const start = (page - 1) * PAGE_SIZE;
    const url = `${BASE_URL}${SALE_PATH}?start=${start}&sz=${PAGE_SIZE}&page=${page}`;

    try {
      const html = await fetchHTML(url);
      const pageDeals = parseProducts(html);
      allDeals.push(...pageDeals);

      if (page % 10 === 0 || page === totalPages) {
        console.log(`Page ${page}/${totalPages}: ${allDeals.length} total markdown deals so far`);
      }
    } catch (error) {
      console.error(`Failed to fetch page ${page}: ${error.message}`);
    }

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }

  console.log(`\nScraping complete: ${allDeals.length} markdown deals from ${totalItems} total sale items`);

  return {
    deals: allDeals,
    totalProducts: allDeals.length,
    totalPages,
    markdownCount: allDeals.length,
  };
}
