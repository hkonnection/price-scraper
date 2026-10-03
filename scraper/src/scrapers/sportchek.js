/**
 * Sport Chek scraper.
 * Reads sale and clearance listings from the same public JSON API the
 * storefront uses, then fills regular and sale prices from the public
 * SKU price endpoint. A normal browser user agent is enough; this does
 * not solve challenges or touch paths disallowed by robots.txt.
 */

const SITE_ORIGIN = 'https://www.sportchek.ca';
const API_BASE = `${SITE_ORIGIN}/api`;
const SEARCH_PATH = '/v1/search/v2/search';
const PRICE_PATH = '/v1/product/api/v2/product/sku/Price';

/** Default store id embedded in the public storefront config. */
const STORE_ID = '314';

/** Page size the storefront itself requests. */
const PAGE_SIZE = 40;

/** Families per price request, kept small so payloads stay light. */
const PRICE_BATCH_SIZE = 15;

/** SKUs sent per family. One priced group is enough for a deal row. */
const SKUS_PER_FAMILY = 6;

/** Pause between requests so a full catalog scrape stays polite. */
const REQUEST_DELAY_MS = 400;

/** Hard stop if pagination ignores the page parameter. */
const MAX_PAGES = 200;

/**
 * Public client key from the storefront HTML config, not a secret.
 * The site sends this on every catalog request.
 */
const SUBSCRIPTION_KEY = 'c01ef3612328420c9f5cd9277e815a0e';

const FEEDS = [
  { promoType: 'Clearance', query: 'x1=deals&q1=Clearance' },
  { promoType: 'Sale', query: 'x1=deals&q1=Sale' },
];

/**
 * Builds the headers the storefront sends on catalog requests.
 *
 * @returns {Record<string, string>} Request headers
 */
function apiHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
    baseSiteId: 'SC',
    bannerid: 'SC',
    'service-version': 'v1',
    'service-client': 'sc/web',
    'x-web-host': 'www.sportchek.ca',
    'browse-mode': 'OFF',
  };
}

/**
 * Waits between requests.
 *
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches JSON and throws on a non-OK response.
 *
 * @param {string} url - Absolute URL
 * @param {RequestInit} [options] - Fetch options
 * @returns {Promise<object>} Parsed JSON body
 * @throws {Error} When the response is not OK
 */
async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...apiHeaders(), ...(options.headers || {}) },
  });

  if (!response.ok) {
    throw new Error(`Sport Chek API error: ${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

/**
 * Title-cases an all-caps vendor name. Falls back to Sport Chek.
 *
 * @param {string|null|undefined} brand - Raw brand label
 * @returns {string} Display brand
 */
export function normalizeBrand(brand) {
  const raw = typeof brand === 'string' ? brand.trim() : '';
  if (!raw) return 'Sport Chek';

  return raw
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolves a product path to an absolute Sport Chek URL.
 *
 * @param {string|null|undefined} path - Relative or absolute product URL
 * @returns {string} Absolute URL, or empty string when missing
 */
export function productPageUrl(path) {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${SITE_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Reads the first image URL from either an image object or an array.
 *
 * @param {object|Array<object>|null|undefined} images - Search image payload
 * @returns {string} Image URL, or empty string
 */
export function productImageUrl(images) {
  if (!images) return '';
  if (Array.isArray(images)) return images[0]?.url || '';
  return images.url || '';
}

/**
 * Parses a price value that may be a number or `{ value }`.
 *
 * @param {number|{value?: number}|null|undefined} price - API price field
 * @returns {number|null} Positive rounded price, or null
 */
function money(price) {
  const raw = price && typeof price === 'object' ? price.value : price;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100) / 100;
}

/**
 * Maps a title to a coarse category. The search payload does not include one.
 *
 * @param {string} title - Product title
 * @returns {string} Category name
 */
function categorize(title) {
  const name = title.toLowerCase();
  if (/shoe|boot|cleat|sandal|clog/.test(name)) return 'Footwear';
  if (/jacket|coat|parka|vest|hoodie/.test(name)) return 'Outerwear';
  if (/pant|short|tight|legging|jogger/.test(name)) return 'Bottoms';
  if (/shirt|tee|jersey|top|bra/.test(name)) return 'Tops';
  if (/glove|mitt|hat|toque|cap|sock/.test(name)) return 'Accessories';
  if (/stick|skate|helmet|ball|racket|club|bag/.test(name)) return 'Equipment';
  return 'Other';
}

/**
 * Builds a normalized deal from a listing and a price group.
 * Returns null when the row cannot support a savings calculation.
 *
 * @param {object|null|undefined} listing - Search product
 * @param {object|null|undefined} priceGroup - SKU price group
 * @param {string} promoType - `Sale` or `Clearance`
 * @returns {object|null} Deal row, or null when the discount is not usable
 */
export function buildDeal(listing, priceGroup, promoType) {
  if (!listing || !priceGroup) return null;

  const productName = (listing.title || listing.name || '').trim();
  if (!productName) return null;

  const regularPrice = money(priceGroup.originalPrice);
  const salePrice = money(priceGroup.currentPrice);
  if (!regularPrice || !salePrice || salePrice >= regularPrice) return null;

  const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;
  const savingsPercent = Math.round((savingsAmount / regularPrice) * 10000) / 100;
  const brandLabel = listing.brand?.label || listing.brand || '';

  return {
    product_code: listing.code || '',
    product_name: productName,
    brand: normalizeBrand(brandLabel),
    regular_price: regularPrice,
    sale_price: salePrice,
    savings_amount: savingsAmount,
    savings_percent: savingsPercent,
    category: categorize(productName),
    promo_type: promoType,
    image_url: productImageUrl(listing.images),
    product_url: productPageUrl(listing.url || listing.pdpUrl),
    in_stock: 1,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * Collects up to a few SKU codes from a search product.
 *
 * @param {object} product - Search product
 * @returns {string[]} SKU codes
 */
function skuCodes(product) {
  return (product.skus || [])
    .map(sku => sku?.code)
    .filter(Boolean)
    .slice(0, SKUS_PER_FAMILY);
}

/**
 * Fetches one page of a sale or clearance feed.
 *
 * @param {string} query - Deal filter query string
 * @param {number} page - 1-based page number
 * @returns {Promise<{products: Array<object>, totalPages: number}>}
 */
async function fetchListingPage(query, page) {
  const url = `${API_BASE}${SEARCH_PATH}?store=${STORE_ID}&lang=en_CA&site=SC&format=json&${query}&count=${PAGE_SIZE}&page=${page}`;
  const data = await fetchJson(url);
  return {
    products: Array.isArray(data.products) ? data.products : [],
    totalPages: Number(data.pagination?.total) || 1,
  };
}

/**
 * Loads every product listing for one feed.
 *
 * @param {{promoType: string, query: string}} feed - Deal feed
 * @returns {Promise<Map<string, {product: object, promoType: string}>>}
 */
async function fetchFeed(feed) {
  const listings = new Map();

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await delay(REQUEST_DELAY_MS);

    const { products, totalPages } = await fetchListingPage(feed.query, page);
    console.log(`  ${feed.promoType} page ${page}/${totalPages}: ${products.length} products`);

    for (const product of products) {
      if (product?.type && product.type !== 'PRODUCT') continue;
      if (!product?.code || listings.has(product.code)) continue;
      if (skuCodes(product).length === 0) continue;
      listings.set(product.code, { product, promoType: feed.promoType });
    }

    if (products.length === 0 || products.length < PAGE_SIZE || page >= totalPages) break;
  }

  return listings;
}

/**
 * Asks the price endpoint for one batch of families.
 *
 * @param {Array<{product: object}>} batch - Listings to price
 * @returns {Promise<object>} productFamilies map from the API
 */
async function fetchPriceBatch(batch) {
  const body = {
    productFamilies: batch.map(({ product }) => ({
      code: product.code,
      brand: product.brand?.label || '',
      skuSets: [skuCodes(product)],
    })),
  };

  const url = `${API_BASE}${PRICE_PATH}?lang=en_CA&storeId=${STORE_ID}`;
  const data = await fetchJson(url, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return data.productFamilies || {};
}

/**
 * Picks the first price group that has a usable discount.
 *
 * @param {Array<object>|undefined} groups - Price groups for one family
 * @returns {object|null} First usable group
 */
function firstDiscountedGroup(groups) {
  if (!Array.isArray(groups)) return null;
  return groups.find(group => {
    const regular = money(group?.originalPrice);
    const sale = money(group?.currentPrice);
    return regular && sale && sale < regular;
  }) || null;
}

/**
 * Scrapes Sport Chek clearance and sale deals.
 *
 * @returns {Promise<{deals: Array<object>, totalProducts: number}>}
 */
export async function scrapeSportchek() {
  console.log('Fetching Sport Chek sale and clearance listings...');
  const listings = new Map();

  for (const feed of FEEDS) {
    const feedListings = await fetchFeed(feed);
    for (const [code, entry] of feedListings) {
      if (!listings.has(code)) listings.set(code, entry);
    }
    await delay(REQUEST_DELAY_MS);
  }

  const entries = [...listings.values()];
  console.log(`Pricing ${entries.length} products...`);
  const deals = [];

  for (let i = 0; i < entries.length; i += PRICE_BATCH_SIZE) {
    if (i > 0) await delay(REQUEST_DELAY_MS);
    const batch = entries.slice(i, i + PRICE_BATCH_SIZE);
    const priced = await fetchPriceBatch(batch);

    for (const entry of batch) {
      const group = firstDiscountedGroup(priced[entry.product.code]);
      const deal = buildDeal(entry.product, group, entry.promoType);
      if (deal) deals.push(deal);
    }

    console.log(`  Priced ${Math.min(i + PRICE_BATCH_SIZE, entries.length)}/${entries.length}, ${deals.length} deals`);
  }

  console.log(`\nScraping complete: ${deals.length} deals`);
  return { deals, totalProducts: deals.length };
}
