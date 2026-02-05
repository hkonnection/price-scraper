/**
 * Granville Island Toy Company Scraper
 * Scrapes the 50% off collection from toycompany.com using Shopify JSON API.
 *
 * Note: This store applies 50% discount at checkout rather than setting
 * compare_at_price, so we hardcode the 50% discount calculation.
 */

const COLLECTION_URL = 'https://toycompany.com/collections/50-off/products.json';
const PRODUCTS_PER_PAGE = 250; // Shopify max

/**
 * Scrapes all products from the 50% off collection.
 * Uses Shopify's JSON API endpoint for efficient data retrieval.
 *
 * @returns {Promise<{deals: Array<Deal>, totalProducts: number}>}
 */
export async function scrapeToycompany() {
  console.log('Fetching from Shopify JSON API...');

  const allDeals = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${COLLECTION_URL}?limit=${PRODUCTS_PER_PAGE}&page=${page}`;
    console.log(`Fetching page ${page}...`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const products = data.products || [];

    if (products.length === 0) {
      hasMore = false;
      break;
    }

    const pageDeals = products.map(product => transformProduct(product)).filter(Boolean);
    allDeals.push(...pageDeals);
    console.log(`Page ${page}: Found ${pageDeals.length} products`);

    // If we got fewer than the limit, we've reached the end
    if (products.length < PRODUCTS_PER_PAGE) {
      hasMore = false;
    } else {
      page++;
      // Small delay to be respectful
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`\nTotal products scraped: ${allDeals.length}`);

  return {
    deals: allDeals,
    totalProducts: allDeals.length,
  };
}

/**
 * Transforms a Shopify product into a deal object.
 * Hardcodes 50% discount since compare_at_price is not set.
 *
 * @param {object} product - Shopify product object
 * @returns {object|null} Deal object or null if invalid
 */
function transformProduct(product) {
  const variant = product.variants?.[0];
  if (!variant) return null;

  const regularPrice = parseFloat(variant.price);
  if (!regularPrice || regularPrice <= 0) return null;

  // 50% discount applied at checkout - API price is the original price
  const salePrice = Math.round(regularPrice * 0.5 * 100) / 100;
  const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;
  const savingsPercent = 50; // Hardcoded

  // Extract category from tags (e.g., "CAT_Cars & Trucks")
  const categoryTag = product.tags?.find(tag => tag.startsWith('CAT_'));
  const category = categoryTag ? categoryTag.replace('CAT_', '') : categorizeByName(product.title);

  // Build product URL
  const productUrl = `https://toycompany.com/products/${product.handle}`;

  // Get image URL
  const imageUrl = product.images?.[0]?.src || null;

  return {
    product_code: variant.sku || String(product.id),
    product_name: product.title,
    brand: product.vendor || null,
    regular_price: regularPrice,
    sale_price: salePrice,
    savings_amount: savingsAmount,
    savings_percent: savingsPercent,
    category: category,
    image_url: imageUrl,
    product_url: productUrl,
    in_stock: variant.available ? 1 : 0,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * Categorizes a product based on keywords in its name.
 * Fallback when no CAT_ tag is present.
 *
 * @param {string} productName - Product name
 * @returns {string} Category
 */
function categorizeByName(productName) {
  const name = productName.toLowerCase();

  if (/diecast|car|truck|vehicle|hummer|jeep|bus/i.test(name)) return 'Cars & Trucks';
  if (/doll|barbie|fashion/i.test(name)) return 'Dolls';
  if (/puzzle|jigsaw/i.test(name)) return 'Puzzles';
  if (/game|board/i.test(name)) return 'Games';
  if (/plush|stuffed|teddy/i.test(name)) return 'Plush';
  if (/lego|block|building/i.test(name)) return 'Building';
  if (/craft|art|paint|draw/i.test(name)) return 'Arts & Crafts';
  if (/book|story/i.test(name)) return 'Books';
  if (/outdoor|sand|water|pool/i.test(name)) return 'Outdoor';
  if (/baby|infant|toddler/i.test(name)) return 'Baby';
  if (/action|figure|superhero/i.test(name)) return 'Action Figures';
  if (/train|track|railway/i.test(name)) return 'Trains';
  if (/science|stem|experiment/i.test(name)) return 'STEM';
  if (/musical|instrument|music/i.test(name)) return 'Musical';

  return 'Other';
}
