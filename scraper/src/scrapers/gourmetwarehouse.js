/**
 * Gourmet Warehouse Scraper
 * Scrapes sale items from gourmetwarehouse.ca (BigCommerce).
 * Auto-discovers current sale pages from the homepage,
 * then scrapes product data using Cheerio (server-rendered HTML).
 */

import { load } from 'cheerio';

const BASE_URL = 'https://gourmetwarehouse.ca';
const HOMEPAGE_URL = BASE_URL;

/**
 * Fetches HTML from a URL with standard browser headers.
 *
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} HTML content
 */
async function fetchHTML(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return await response.text();
}

/**
 * Discovers current sale page URLs from the homepage.
 * Scans carousel/banner links for pages containing "sale" in the URL,
 * then verifies each page actually has products with sale pricing.
 *
 * @returns {Promise<Array<{url: string, title: string}>>} Discovered sale pages
 */
async function discoverSalePages() {
  console.log('Discovering sale pages from homepage...');
  const html = await fetchHTML(HOMEPAGE_URL);
  const $ = load(html);

  // Collect candidate URLs from homepage links containing "sale"
  const candidates = new Set();
  $('a[href*="sale"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.includes('javascript:') && !href.includes('#')) {
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      // Only include gourmetwarehouse.ca URLs
      if (fullUrl.includes('gourmetwarehouse.ca')) {
        candidates.add(fullUrl);
      }
    }
  });

  console.log(`Found ${candidates.size} candidate sale URLs`);

  // Verify each candidate has actual sale products (products with .price--rrp)
  const salePages = [];
  for (const url of candidates) {
    try {
      const pageHtml = await fetchHTML(url);
      const page$ = load(pageHtml);
      const saleProductCount = page$('article.card .price--rrp').length;

      if (saleProductCount > 0) {
        const title = page$('h1').first().text().trim() || url;
        salePages.push({ url, title, productCount: saleProductCount });
        console.log(`  ✓ ${title}: ${saleProductCount} sale products`);
      } else {
        console.log(`  ✗ ${url}: no sale products, skipping`);
      }

      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.log(`  ✗ ${url}: fetch failed (${error.message}), skipping`);
    }
  }

  return salePages;
}

/**
 * Extracts deal data from all products on a sale page.
 *
 * @param {string} url - Sale page URL
 * @param {string} saleName - Name of the sale (for logging)
 * @returns {Promise<Array<object>>} Array of deal objects
 */
async function scrapePageDeals(url, saleName) {
  const html = await fetchHTML(url);
  const $ = load(html);
  const deals = [];

  $('main article.card').each((_, article) => {
    const $article = $(article);

    const brand = $article.find('.prod-brand').text().trim() || null;
    const productName = $article.find('.prod-name a').text().trim();
    const productUrl = $article.find('.prod-name a').attr('href') || null;
    const imageUrl = $article.find('.card-image').attr('src') || $article.find('.card-image').attr('data-src') || null;
    const productId = $article.find('[data-product-id]').attr('data-product-id') || null;

    // Parse prices
    const rrpText = $article.find('.price--rrp').text().trim();
    const salePriceText = $article.find('.price--withoutTax').text().trim();

    const regularPrice = parsePrice(rrpText);
    const salePrice = parsePrice(salePriceText);

    // Only include items with valid sale pricing
    if (productName && salePrice && regularPrice && salePrice < regularPrice) {
      const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;
      const savingsPercent = Math.round((savingsAmount / regularPrice) * 10000) / 100;

      const fullProductUrl = productUrl
        ? (productUrl.startsWith('http') ? productUrl : `${BASE_URL}${productUrl}`)
        : null;

      deals.push({
        product_code: productId,
        product_name: productName,
        brand,
        regular_price: regularPrice,
        sale_price: salePrice,
        savings_amount: savingsAmount,
        savings_percent: savingsPercent,
        category: categorizeProduct(productName, brand),
        image_url: imageUrl,
        product_url: fullProductUrl,
        sale_source: saleName,
        scraped_at: new Date().toISOString(),
      });
    }
  });

  return deals;
}

/**
 * Parses a price string like "$490.00" or "CA$490.00" into a float.
 *
 * @param {string} text - Price text
 * @returns {number|null} Parsed price or null
 */
function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/[CA$,\s]/g, '').trim();
  const price = parseFloat(cleaned);
  return isNaN(price) ? null : price;
}

/**
 * Categorizes a product based on its name and brand.
 *
 * @param {string} productName - Product name
 * @param {string|null} brand - Brand name
 * @returns {string} Category
 */
function categorizeProduct(productName, brand) {
  const name = (productName || '').toLowerCase();
  const b = (brand || '').toLowerCase();

  if (/wok|pan|skillet|saucepan|pot|dutch oven|braiser|roaster|fry/i.test(name)) return 'Cookware';
  if (/kettle/i.test(name)) return 'Kettles';
  if (/bake|muffin|cake|tart|pie|rolling|cookie|loaf/i.test(name)) return 'Bakeware';
  if (/knife|knives|sharpener|steel|block/i.test(name)) return 'Knives';
  if (/mug|cup|tumbler|glass|goblet|wine|carafe|pitcher|bottle/i.test(name)) return 'Drinkware';
  if (/plate|bowl|platter|dish|baker|ramekin|casserole/i.test(name)) return 'Dinnerware';
  if (/spoon|spatula|tongs|whisk|peeler|grater|ladle|turner|tool/i.test(name)) return 'Kitchen Tools';
  if (/blender|mixer|processor|toaster|espresso|coffee maker/i.test(name)) return 'Electrics';
  if (/wine|spirit|champagne|beer|cocktail|non-alcoholic|sparkling/i.test(name)) return 'Beverages';
  if (/oil|vinegar|sauce|condiment|mustard|ketchup/i.test(name)) return 'Condiments';
  if (/chocolate|candy|sweet|sugar|cookie|biscuit/i.test(name)) return 'Sweets';
  if (/spice|seasoning|salt|pepper|herb/i.test(name)) return 'Spices';
  if (/pasta|rice|grain|flour/i.test(name)) return 'Pantry';
  if (/candle|fragrance|lamp|diffuser|scent/i.test(name)) return 'Home Fragrance';
  if (/towel|linen|apron|mitt|cloth/i.test(name)) return 'Kitchen Textiles';

  return 'Other';
}

/**
 * Scrapes all sale items from Gourmet Warehouse.
 * Auto-discovers sale pages from the homepage, then scrapes each one.
 *
 * @returns {Promise<{deals: Array<object>, totalProducts: number, salePages: Array<object>}>}
 */
export async function scrapeGourmetwarehouse() {
  // Phase 1: Discover sale pages
  const salePages = await discoverSalePages();

  if (salePages.length === 0) {
    console.log('No active sale pages found.');
    return { deals: [], totalProducts: 0, salePages: [] };
  }

  console.log(`\nFound ${salePages.length} active sale pages. Scraping...`);

  // Phase 2: Scrape each sale page
  const allDeals = [];
  for (const salePage of salePages) {
    console.log(`\nScraping: ${salePage.title} (${salePage.url})`);
    const deals = await scrapePageDeals(salePage.url, salePage.title);
    allDeals.push(...deals);
    console.log(`  Found ${deals.length} deals`);

    // Small delay between pages
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`\nTotal deals scraped: ${allDeals.length}`);

  return {
    deals: allDeals,
    totalProducts: allDeals.length,
    salePages,
  };
}
