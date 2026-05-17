/**
 * Gourmet Warehouse Scraper
 * Scrapes sale items from gourmetwarehouse.ca (BigCommerce).
 * Walks both curated sale pages (e.g., "May Sale") and all top-level catalog
 * categories so that sale-priced items outside curated sale landing pages
 * (e.g., a single discounted cookie sheet in /bakeware/bakesheets-racks/cookie-sheets/)
 * are also captured. Deduplicates by product ID, with curated sale pages
 * winning priority for the sale_source label.
 */

import { load } from 'cheerio';

const BASE_URL = 'https://gourmetwarehouse.ca';
const HOMEPAGE_URL = BASE_URL;
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_SOURCE = 20;
const REQUEST_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Builds a paginated URL preserving the source's base path.
 *
 * @param {string} baseUrl - Source URL (e.g., https://gourmetwarehouse.ca/bakeware/)
 * @param {number} page - 1-indexed page number
 * @returns {string} URL with limit and page query params
 */
function paginatedUrl(baseUrl, page) {
  const u = new URL(baseUrl);
  u.searchParams.set('limit', String(PAGE_LIMIT));
  u.searchParams.set('page', String(page));
  return u.toString();
}

/**
 * Discovers top-level catalog categories from the homepage main nav.
 * Looks for navPages-action links pointing to single-segment paths
 * (e.g., /bakeware/, /cookware/). Skips informational pages like /gw-home/.
 *
 * @returns {Promise<Array<{url: string, title: string}>>} Discovered categories
 */
async function discoverCategoryPages() {
  console.log('Discovering top-level catalog categories from homepage nav...');
  const html = await fetchHTML(HOMEPAGE_URL);
  const $ = load(html);

  const categories = new Map(); // url → title
  $('a.navPages-action').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    if (!href.startsWith(BASE_URL)) return;

    const path = href.replace(BASE_URL, '');
    const segments = path.split('/').filter(Boolean);
    // Only top-level: a single path segment
    if (segments.length !== 1) return;

    const title = $el.text().trim() || segments[0];
    categories.set(href, title);
  });

  const result = [...categories.entries()].map(([url, title]) => ({ url, title }));
  console.log(`  Found ${result.length} top-level categories: ${result.map(c => c.title).join(', ')}`);
  return result;
}

/**
 * Discovers curated sale page URLs from the homepage banners.
 * Scans homepage links containing "sale" in the URL, then verifies each
 * page actually has products with sale pricing.
 *
 * @returns {Promise<Array<{url: string, title: string}>>} Discovered sale pages
 */
async function discoverSalePages() {
  console.log('Discovering curated sale pages from homepage banners...');
  const html = await fetchHTML(HOMEPAGE_URL);
  const $ = load(html);

  const candidates = new Set();
  $('a[href*="sale"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.includes('javascript:') && !href.includes('#')) {
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (fullUrl.includes('gourmetwarehouse.ca')) {
        candidates.add(fullUrl);
      }
    }
  });

  const salePages = [];
  for (const url of candidates) {
    try {
      const pageHtml = await fetchHTML(url);
      const page$ = load(pageHtml);
      const saleProductCount = page$('article.card .price--rrp').length;

      if (saleProductCount > 0) {
        const title = page$('h1').first().text().trim() || url;
        salePages.push({ url, title });
        console.log(`  ✓ ${title}: ${saleProductCount} sale products on first page`);
      }

      await sleep(REQUEST_DELAY_MS);
    } catch (error) {
      console.log(`  ✗ ${url}: fetch failed (${error.message}), skipping`);
    }
  }

  return salePages;
}

/**
 * Parses one product page HTML into structured product cards.
 *
 * @param {string} html - Page HTML
 * @param {string} saleName - Source name to tag deals with
 * @returns {{deals: Array<object>, productIds: Set<string>}} Parsed sale deals and all product IDs seen
 */
function parseProductCards(html, saleName) {
  const $ = load(html);
  const deals = [];
  const productIds = new Set();

  $('main article.card').each((_, article) => {
    const $article = $(article);

    const productId = $article.find('[data-product-id]').attr('data-product-id') || null;
    if (productId) productIds.add(productId);

    const brand = $article.find('.prod-brand').text().trim() || null;
    const productName = $article.find('.prod-name a').text().trim();
    const productUrl = $article.find('.prod-name a').attr('href') || null;
    // BigCommerce lazy-loads images: src holds a loading.svg placeholder until JS runs,
    // and the real URL lives in data-src. Cheerio doesn't run JS, so prefer data-src.
    const $img = $article.find('.card-image');
    const imageUrl = $img.attr('data-src') || $img.attr('src') || null;

    const rrpText = $article.find('.price--rrp').text().trim();
    const salePriceText = $article.find('.price--withoutTax').text().trim();

    const regularPrice = parsePrice(rrpText);
    const salePrice = parsePrice(salePriceText);

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

  return { deals, productIds };
}

/**
 * Walks a source URL paginating with ?limit=500&page=N until no new products
 * are returned (compared to previously-seen product IDs on this source).
 *
 * @param {string} baseUrl - Source URL (sale page or category)
 * @param {string} sourceName - Source name used as sale_source on deals
 * @returns {Promise<Array<object>>} All sale deals from the source
 */
async function scrapeAllPages(baseUrl, sourceName) {
  const allDeals = [];
  const seenInThisSource = new Set();

  for (let page = 1; page <= MAX_PAGES_PER_SOURCE; page++) {
    const pageUrl = paginatedUrl(baseUrl, page);
    let html;
    try {
      html = await fetchHTML(pageUrl);
    } catch (error) {
      console.log(`  Page ${page}: fetch failed (${error.message}), stopping`);
      break;
    }

    const { deals, productIds } = parseProductCards(html, sourceName);

    let newProductCount = 0;
    for (const id of productIds) {
      if (!seenInThisSource.has(id)) {
        seenInThisSource.add(id);
        newProductCount++;
      }
    }

    // Only keep deals for products we haven't already collected
    const newDeals = deals.filter(d => !allDeals.some(existing => existing.product_code === d.product_code));
    allDeals.push(...newDeals);

    console.log(`  Page ${page}: ${productIds.size} cards (${newProductCount} new), ${newDeals.length} sale deals`);

    // Stop if this page had no new products (we've walked past the end)
    if (page > 1 && newProductCount === 0) break;
    // Also stop if first page returned nothing at all
    if (productIds.size === 0) break;

    await sleep(REQUEST_DELAY_MS);
  }

  return allDeals;
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
 * Scrapes all sale items from Gourmet Warehouse across curated sale pages
 * AND every top-level catalog category. Dedupes by product_code, with
 * curated sale pages taking priority for the sale_source label.
 *
 * @returns {Promise<{deals: Array<object>, totalProducts: number, salePages: Array<object>}>}
 */
export async function scrapeGourmetwarehouse() {
  const curatedSales = await discoverSalePages();
  const categories = await discoverCategoryPages();

  if (curatedSales.length === 0 && categories.length === 0) {
    console.log('No sources discovered. Exiting.');
    return { deals: [], totalProducts: 0, salePages: [] };
  }

  // dealsByCode: product_code → { deal, sourceType }
  // sourceType priority: 'curated' beats 'category'
  const dealsByCode = new Map();
  const dealsByUrl = new Map(); // fallback dedup for products without product_code

  function mergeDeal(deal, sourceType) {
    if (deal.product_code) {
      const existing = dealsByCode.get(deal.product_code);
      if (!existing || (sourceType === 'curated' && existing.sourceType !== 'curated')) {
        dealsByCode.set(deal.product_code, { deal, sourceType });
      }
    } else if (deal.product_url) {
      if (!dealsByUrl.has(deal.product_url)) {
        dealsByUrl.set(deal.product_url, { deal, sourceType });
      }
    }
  }

  // Phase 1: curated sale pages (e.g., "May Sale Shop Now and Save")
  console.log(`\n=== Phase 1: Curated sale pages (${curatedSales.length}) ===`);
  const sourceSummary = [];
  for (const sale of curatedSales) {
    console.log(`\nScraping curated sale: ${sale.title}`);
    console.log(`  URL: ${sale.url}`);
    const deals = await scrapeAllPages(sale.url, sale.title);
    deals.forEach(d => mergeDeal(d, 'curated'));
    sourceSummary.push({ ...sale, productCount: deals.length, type: 'curated' });
    console.log(`  Total sale deals on this curated sale: ${deals.length}`);
    await sleep(REQUEST_DELAY_MS);
  }

  // Phase 2: top-level catalog categories
  console.log(`\n=== Phase 2: Catalog categories (${categories.length}) ===`);
  for (const cat of categories) {
    console.log(`\nScraping category: ${cat.title}`);
    console.log(`  URL: ${cat.url}`);
    const deals = await scrapeAllPages(cat.url, cat.title);
    deals.forEach(d => mergeDeal(d, 'category'));
    sourceSummary.push({ ...cat, productCount: deals.length, type: 'category' });
    console.log(`  Total sale deals in this category: ${deals.length}`);
    await sleep(REQUEST_DELAY_MS);
  }

  const allDeals = [
    ...[...dealsByCode.values()].map(v => v.deal),
    ...[...dealsByUrl.values()].map(v => v.deal),
  ];

  console.log(`\n=== Done: ${allDeals.length} unique sale deals across ${sourceSummary.length} sources ===`);

  return {
    deals: allDeals,
    totalProducts: allDeals.length,
    salePages: sourceSummary,
  };
}
