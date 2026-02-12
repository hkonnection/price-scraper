/**
 * Barry's Scraper
 * Scrapes sale products from shop.barrys.com Shopify store.
 * Uses standard Shopify JSON API — no Playwright required.
 *
 * Sale collection: /collections/sale/products.json
 * All products have compare_at_price populated.
 */

const SHOP_BASE = 'https://shop.barrys.com';
const SALE_COLLECTION = '/collections/sale/products.json';
const PAGE_LIMIT = 250;

/**
 * Fetches a page of sale products from the Shopify JSON endpoint.
 *
 * @param {number} page - Page number (1-based)
 * @returns {Promise<Array<object>>} Array of Shopify product objects
 */
async function fetchSalePage(page) {
  const url = `${SHOP_BASE}${SALE_COLLECTION}?limit=${PAGE_LIMIT}&page=${page}&currency=CAD`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Barry's API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.products || [];
}

/**
 * Extracts deal objects from a Shopify product.
 * Uses the first variant's pricing (compare_at_price vs price).
 * Skips products without a valid discount.
 *
 * @param {object} product - Shopify product object
 * @returns {object|null} Deal object or null if no valid discount
 */
function extractDeal(product) {
  const variant = product.variants?.[0];
  if (!variant) return null;

  const salePrice = parseFloat(variant.price);
  const regularPrice = parseFloat(variant.compare_at_price);

  if (!regularPrice || !salePrice || isNaN(regularPrice) || isNaN(salePrice)) {
    return null;
  }

  if (salePrice >= regularPrice) return null;

  const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;
  const savingsPercent = Math.round((savingsAmount / regularPrice) * 10000) / 100;

  const imageUrl = product.images?.[0]?.src || '';
  const productUrl = `${SHOP_BASE}/products/${product.handle}`;
  const brand = normalizeBrand(product.vendor || "Barry's");

  return {
    product_code: variant.sku || String(product.id),
    product_name: product.title,
    brand,
    regular_price: regularPrice,
    sale_price: salePrice,
    savings_amount: savingsAmount,
    savings_percent: savingsPercent,
    category: categorizeProduct(product),
    image_url: imageUrl,
    product_url: productUrl,
    in_stock: variant.available ? 1 : 0,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * Normalizes vendor names from Shopify to clean brand names.
 *
 * @param {string} vendor - Raw vendor string from Shopify
 * @returns {string} Normalized brand name
 */
function normalizeBrand(vendor) {
  const mapping = {
    "BARRY'S": "Barry's",
    "RHONE APPAREL": "Rhone",
    "LAUREN MOSHI": "Lauren Moshi",
    "LULULEMON": "Lululemon",
    "NIKE": "Nike",
    "VUORI": "Vuori",
    "STRUT THIS": "Strut This",
    "LSKD": "LSKD",
    "TEN THOUSAND": "Ten Thousand",
    "PE NATION": "PE Nation",
    "ALO": "Alo",
    "PACIFIC APPAREL TRADING PAT PAT": "Barry's",
    "PACIFIC APPAREL TRADING PAT PACIFIC APPAREL TRADING PAT PAT": "Barry's",
  };

  const upper = vendor.toUpperCase();
  for (const [key, val] of Object.entries(mapping)) {
    if (upper === key) return val;
  }

  // Title case fallback for unknown vendors
  return vendor
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Categorizes a product based on tags and title.
 *
 * @param {object} product - Shopify product object
 * @returns {string} Category name
 */
function categorizeProduct(product) {
  const title = (product.title || '').toLowerCase();
  const tags = (product.tags || []).map(t => t.toLowerCase());

  if (/tank/.test(title)) return 'Tanks';
  if (/tee|t-shirt/.test(title)) return 'Tees';
  if (/short/.test(title)) return 'Shorts';
  if (/jogger|pant|sweat/.test(title)) return 'Pants & Joggers';
  if (/legging|tight/.test(title)) return 'Leggings';
  if (/hoodie|pullover|crew/.test(title)) return 'Hoodies & Sweatshirts';
  if (/jacket|windbreaker|vest/.test(title)) return 'Jackets & Outerwear';
  if (/bra/.test(title)) return 'Sports Bras';
  if (/hat|cap|headband|beanie/.test(title)) return 'Hats & Headwear';
  if (/sock/.test(title)) return 'Socks';
  if (/bag|backpack|tote/.test(title)) return 'Bags';
  if (/bottle|mug|shaker/.test(title)) return 'Drinkware';
  if (/mat|band|dumbbell|equipment/.test(title)) return 'Equipment';
  if (/polo/.test(title)) return 'Polos';
  if (/long sleeve/.test(title)) return 'Long Sleeves';

  if (tags.some(t => t.includes("men's"))) return 'Apparel';
  if (tags.some(t => t.includes("women's"))) return 'Apparel';

  return 'Other';
}

/**
 * Scrapes all sale products from Barry's Shopify store.
 * Paginates through the /collections/sale/products.json endpoint.
 *
 * @returns {Promise<{deals: Array<object>, totalProducts: number}>}
 */
export async function scrapeBarrys() {
  console.log('Fetching sale products from shop.barrys.com...');

  let allDeals = [];
  let page = 1;

  while (true) {
    console.log(`Fetching page ${page}...`);
    const products = await fetchSalePage(page);

    if (products.length === 0) break;

    for (const product of products) {
      const deal = extractDeal(product);
      if (deal) {
        allDeals.push(deal);
      }
    }

    console.log(`  Page ${page}: ${products.length} products → ${allDeals.length} deals so far`);

    // If we got fewer than PAGE_LIMIT, we've reached the last page
    if (products.length < PAGE_LIMIT) break;

    page++;

    // Rate limit between pages
    await new Promise(resolve => setTimeout(resolve, 600));
  }

  console.log(`\nScraping complete: ${allDeals.length} deals`);

  return {
    deals: allDeals,
    totalProducts: allDeals.length,
  };
}
