/**
 * Whole Foods Market Canada Scraper
 * Scrapes weekly sales from wholefoodsmarket.com sales flyer page.
 * Extracts promotions data from embedded __NEXT_DATA__ JSON.
 *
 * Note: Canadian weekly sales run Wednesday to Tuesday.
 * Deals are the same across all Canadian stores.
 */

import { load } from 'cheerio';

// Cambie store in Vancouver - Canadian deals are the same across all CA stores
const DEFAULT_STORE_ID = '10248';
const SALES_FLYER_URL = 'https://www.wholefoodsmarket.com/sales-flyer';

/**
 * Scrapes weekly sales promotions from Whole Foods Canada.
 * Fetches the sales flyer page and extracts __NEXT_DATA__ JSON.
 *
 * @param {string} [storeId] - Whole Foods store ID (defaults to Cambie, Vancouver)
 * @returns {Promise<{deals: Array<object>, totalProducts: number, flyerDates: string|null}>}
 */
export async function scrapeWholefoods(storeId = DEFAULT_STORE_ID) {
  const url = `${SALES_FLYER_URL}?store-id=${storeId}`;
  console.log(`Fetching sales flyer for store ${storeId}...`);
  console.log(`URL: ${url}`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch sales flyer: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const promotions = extractPromotions(html);

  if (promotions.length === 0) {
    console.log('No promotions found in page data.');
    return { deals: [], totalProducts: 0, flyerDates: null };
  }

  console.log(`Found ${promotions.length} raw promotions`);

  // Build flyer dates from first promotion's date range
  const flyerDates = buildFlyerDates(promotions[0]);

  // Transform promotions into deals, filtering out unparseable ones
  const deals = promotions
    .map(promo => transformPromotion(promo))
    .filter(Boolean);

  console.log(`Transformed ${deals.length} deals (skipped ${promotions.length - deals.length} with unparseable prices)`);

  return {
    deals,
    totalProducts: deals.length,
    flyerDates,
  };
}

/**
 * Extracts the promotions array from the page's __NEXT_DATA__ JSON.
 *
 * @param {string} html - Raw HTML of the sales flyer page
 * @returns {Array<object>} Promotions array
 */
function extractPromotions(html) {
  const $ = load(html);
  const nextDataScript = $('#__NEXT_DATA__').html();

  if (!nextDataScript) {
    console.error('Could not find __NEXT_DATA__ script tag');
    return [];
  }

  try {
    const nextData = JSON.parse(nextDataScript);
    const promotions = nextData?.props?.pageProps?.promotions || [];
    return promotions;
  } catch (err) {
    console.error('Failed to parse __NEXT_DATA__ JSON:', err.message);
    return [];
  }
}

/**
 * Builds a human-readable flyer dates string from a promotion.
 *
 * @param {object} promo - Promotion object with startDate/endDate
 * @returns {string|null} Flyer dates string (e.g., "February 4-10, 2026")
 */
function buildFlyerDates(promo) {
  if (!promo?.startDate || !promo?.endDate) return null;

  const start = new Date(promo.startDate);
  const end = new Date(promo.endDate);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  if (start.getMonth() === end.getMonth()) {
    return `${months[start.getMonth()]} ${start.getDate()}-${end.getDate()}, ${start.getFullYear()}`;
  }

  return `${months[start.getMonth()]} ${start.getDate()} - ${months[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

/**
 * Transforms a Whole Foods promotion object into a deal object.
 * Skips promotions where prices cannot be parsed to numeric values.
 *
 * @param {object} promo - Promotion object from __NEXT_DATA__
 * @returns {object|null} Deal object or null if prices are unparseable
 */
function transformPromotion(promo) {
  const regularPrice = parsePrice(promo.regularPrice);
  const salePrice = parseSalePrice(promo.salePrice, regularPrice);

  // Skip if we can't determine both prices
  if (regularPrice === null || salePrice === null || regularPrice <= 0 || salePrice <= 0) {
    return null;
  }

  // Skip if sale price >= regular price (bad data)
  if (salePrice >= regularPrice) {
    return null;
  }

  const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;
  const savingsPercent = Math.round((savingsAmount / regularPrice) * 10000) / 100;

  return {
    product_code: promo.promotionId || '',
    product_name: buildProductName(promo),
    brand: promo.originBrandName || null,
    regular_price: regularPrice,
    sale_price: salePrice,
    savings_amount: savingsAmount,
    savings_percent: savingsPercent,
    category: categorizeByName(promo.productName || ''),
    image_url: promo.productImage || null,
    product_url: null,
    valid_from: promo.startDate ? promo.startDate.split('T')[0] : null,
    valid_to: promo.endDate ? promo.endDate.split('T')[0] : null,
    in_stock: 1,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * Builds a product name, including package size if present.
 *
 * @param {object} promo - Promotion object
 * @returns {string} Product name
 */
function buildProductName(promo) {
  const name = promo.productName || 'Unknown Product';
  // packageSize is sometimes already in the product name
  if (promo.packageSize && !name.includes(promo.packageSize)) {
    return `${name}, ${promo.packageSize}`;
  }
  return name;
}

/**
 * Parses a price string into a numeric value.
 * Handles formats: "$3.49/lb", "$14.99 ea", "$14.99", etc.
 * Returns null for "Varies" or unparseable strings.
 *
 * @param {string} priceStr - Price string from the promotion
 * @returns {number|null} Parsed price or null
 */
function parsePrice(priceStr) {
  if (!priceStr || priceStr.toLowerCase() === 'varies') return null;

  // Match dollar amount: $3.49, $14.99, etc.
  const match = priceStr.match(/\$(\d+(?:\.\d{1,2})?)/);
  if (match) {
    return parseFloat(match[1]);
  }

  return null;
}

/**
 * Parses a sale price string, handling special formats like "2 for $X".
 * Falls back to regular price parsing for standard formats.
 *
 * @param {string} salePriceStr - Sale price string
 * @param {number|null} regularPrice - Regular price for context
 * @returns {number|null} Parsed sale price or null
 */
function parseSalePrice(salePriceStr, regularPrice) {
  if (!salePriceStr) return null;

  // Handle "X for $Y" format (e.g., "2 for $5")
  const multiMatch = salePriceStr.match(/(\d+)\s+for\s+\$(\d+(?:\.\d{1,2})?)/i);
  if (multiMatch) {
    const quantity = parseInt(multiMatch[1], 10);
    const totalPrice = parseFloat(multiMatch[2]);
    return Math.round((totalPrice / quantity) * 100) / 100;
  }

  // Handle percentage-only (e.g., "30% off") - calculate from regular price
  const pctMatch = salePriceStr.match(/(\d+)%\s*off/i);
  if (pctMatch && regularPrice) {
    const pctOff = parseInt(pctMatch[1], 10);
    return Math.round(regularPrice * (1 - pctOff / 100) * 100) / 100;
  }

  // Standard price format
  return parsePrice(salePriceStr);
}

/**
 * Categorizes a product based on keywords in its name.
 *
 * @param {string} productName - Product name
 * @returns {string} Category
 */
function categorizeByName(productName) {
  const name = productName.toLowerCase();

  if (/chicken|beef|pork|steak|sausage|bacon|ground|lamb|turkey/i.test(name)) return 'Meat';
  if (/salmon|shrimp|lobster|crab|fish|seafood|oyster|tuna|cod/i.test(name)) return 'Seafood';
  if (/orange|apple|banana|berry|fruit|avocado|mango|grape|lemon|lime|pear/i.test(name)) return 'Fruit';
  if (/lettuce|spinach|kale|broccoli|carrot|potato|cucumber|tomato|pepper|onion|celery|squash|sweet potato|brussels/i.test(name)) return 'Vegetables';
  if (/cheese|yogurt|milk|cream|butter|egg/i.test(name)) return 'Dairy';
  if (/bread|bagel|muffin|biscuit|croissant|pastry|cake|cookie|baked/i.test(name)) return 'Bakery';
  if (/chip|cracker|puff|pretzel|popcorn|snack|thin/i.test(name)) return 'Snacks';
  if (/sauce|oil|vinegar|spice|seasoning|salt|pepper|cinnamon|herb/i.test(name)) return 'Pantry';
  if (/tea|coffee|water|juice|soda|beverage|kombucha|sparkling/i.test(name)) return 'Beverages';
  if (/pizza|ravioli|pasta|noodle|frozen|ice cream/i.test(name)) return 'Frozen';
  if (/chocolate|candy|truffle|gummy/i.test(name)) return 'Sweets';
  if (/soap|shampoo|lotion|bath|body|skincare|essential oil|candle|condom|lubricant/i.test(name)) return 'Body & Wellness';
  if (/supplement|vitamin|tincture|probiotic/i.test(name)) return 'Supplements';
  if (/wine|beer|cider|spirits/i.test(name)) return 'Alcohol';
  if (/dip|hummus|salsa|guacamole/i.test(name)) return 'Dips & Spreads';

  return 'Other';
}
