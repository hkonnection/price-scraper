/**
 * Indigo Canada clearance collector for the Shopify storefront.
 * The public collection theme uses Constructor browse/group_id, not product tiles.
 * Read the public key and CAD context from the collection, then validate every page
 * before returning a snapshot. No browser, credentials, redirect, or retry is used.
 */
import { load } from 'cheerio';

const BASE_URL = 'https://www.indigo.ca';
const COLLECTION = 'shop-all-sale';
const PAGE_SIZE = 24;
const DELAY_MS = 600;
// The storefront collection client uses this public browse service and route.
const BROWSE_URL = `https://ac.cnstrc.com/browse/group_id/${COLLECTION}`;

/**
 * Fetch one public response. Any failure stops collection before publication.
 * Ordinary Shopify captcha form-registration strings are not a challenge.
 * @param {string} url Source-backed public URL.
 * @returns {Promise<string>} Response text.
 * @throws {Error} For HTTP errors, redirects, transport failure, or challenges.
 */
async function fetchPublic(url) {
  let response;
  let body;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { Accept: 'text/html,application/json', 'Accept-Language': 'en-CA,en;q=0.9' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.text();
  } catch (error) {
    throw new Error(`Indigo request failed: ${error.message}`);
  }
  const $ = load(body);
  const challengeMarkup = $('form[action*="/challenge"], script[src*="challenge-platform"], [id^="cf-chl-"], #px-captcha, iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"]').length > 0;
  $('script, style, template').remove();
  const visible = $.text().replace(/\s+/g, ' ').trim();
  if (challengeMarkup || /verify (?:that )?you are human|access denied|request blocked|unusual traffic|enable javascript and cookies to continue|complete (?:the|this) captcha|press and hold|incapsula incident/i.test(visible)
    || /^captcha[.!\s]*$/i.test(visible)) {
    throw new Error('Indigo access refusal or challenge; collection stopped without retry.');
  }
  return body;
}

/**
 * Verify collection identity, Canadian currency, and the public theme browse key.
 * Never evaluate retailer scripts or obtain a private storefront token.
 * @param {string} html Public collection HTML.
 * @returns {string} Public Constructor browse key.
 * @throws {Error} If the expected product-loading configuration is absent.
 */
function collectionKey(html) {
  const $ = load(html);
  const grid = $('.js-constructor-product-grid');
  const currency = html.match(/Shopify\.currency\s*=\s*(\{[^;]+\})\s*;/);
  const country = html.match(/Shopify\.country\s*=\s*["']CA["']/);
  const key = html.match(/SDG\.Data\.constructorKey\s*=\s*["'](key_[a-zA-Z0-9]+)["']/);
  let cad = false;
  try { cad = JSON.parse(currency?.[1] || 'null')?.active === 'CAD'; } catch { /* Reject invalid context below. */ }
  if (grid.length !== 1 || grid.attr('data-collection-handle') !== COLLECTION
    || Number(grid.attr('data-results-per-page')) !== PAGE_SIZE
    || grid.attr('data-override-collection-handle') || grid.attr('data-contributor-id') || grid.attr('data-series-id')
    || !cad || !country || !key) {
    throw new Error('Indigo product data configuration missing or invalid: expected shop-all-sale in CA/CAD with a public browse key.');
  }
  return key[1];
}

/**
 * Check exact raw pagination metadata before filtering any variants.
 * @param {object} data Public browse response.
 * @param {number} page Requested page.
 * @param {number|null} total Expected stable raw total, or null for page one.
 * @returns {{results: Array<object>, total: number}} Complete raw page.
 * @throws {Error} For wrong collection, drift, or incomplete data.
 */
function catalogPage(data, page, total) {
  const request = data?.request;
  const response = data?.response;
  if (!request || !response || !Array.isArray(response.results)) {
    throw new Error(`Indigo page ${page}: missing product data or metadata.`);
  }
  if (request.browse_filter_name !== 'group_id' || request.browse_filter_value !== COLLECTION || request.section !== 'Products') {
    throw new Error(`Indigo page ${page}: wrong collection metadata.`);
  }
  const count = response.total_num_results;
  if (!Number.isSafeInteger(count) || count < 0 || request.page !== page
    || request.num_results_per_page !== PAGE_SIZE || (total !== null && count !== total)) {
    throw new Error(`Indigo page ${page}: invalid or changed pagination metadata.`);
  }
  if (count === 0) throw new Error('Indigo collection is empty; existing publication was not changed.');
  const expected = Math.min(PAGE_SIZE, count - (page - 1) * PAGE_SIZE);
  if (expected <= 0 || response.results.length !== expected) {
    throw new Error(`Indigo page ${page}: incomplete product data, expected ${expected}, received ${response.results.length}.`);
  }
  return { results: response.results, total: count };
}

/**
 * Parse a positive CAD price without accepting coercion or partial numeric strings.
 * @param {*} value Price in dollars, not Shopify Ajax cents.
 * @returns {number} Finite positive price.
 * @throws {Error} For malformed or nonpositive prices.
 */
function price(value) {
  if (!((typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value))) || Number(value) <= 0) {
    throw new Error('Indigo invalid variant price; collection stopped.');
  }
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 1e-8) {
    throw new Error('Indigo invalid sub-cent or unsafe variant price.');
  }
  return amount;
}

/**
 * Validate each raw member and all variants, then emit stocked markdown variants.
 * The theme uses price as current price and compare_at_price as regular price.
 * availableInStores is its public availability filter; InventoryATS is also retained
 * in the catalog. Zero inventory and no available locations is not in stock.
 * @param {object} item Raw product with collection membership and variations.
 * @param {object} seen Raw product, variant, and SKU identity sets.
 * @returns {Array<object>} Normalized CAD markdown rows.
 * @throws {Error} For missing, malformed, duplicate, or nonmember product data.
 */
function productDeals(item, seen) {
  const data = item?.data;
  if (!data || typeof data.id !== 'string' || !data.id.trim() || seen.products.has(data.id)) {
    throw new Error('Indigo missing or duplicate product identifier.');
  }
  seen.products.add(data.id);
  if (!Array.isArray(data.groups) || !data.groups.some(group => group?.group_id === COLLECTION)) {
    throw new Error('Indigo product collection membership missing.');
  }
  let productUrl;
  try { productUrl = new URL(data.url); } catch { /* Reject invalid URLs below. */ }
  if (typeof item.value !== 'string' || !item.value.trim() || typeof data.handle !== 'string'
    || !/^[^/?#\s\\]+$/u.test(data.handle) || typeof data.url !== 'string'
    || /[?#\s\\]/.test(data.url) || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(data.url)
    || !productUrl || productUrl.protocol !== 'https:' || productUrl.origin !== BASE_URL
    || productUrl.username || productUrl.password || productUrl.port || productUrl.search || productUrl.hash
    || productUrl.pathname !== `/products/${encodeURIComponent(data.handle)}`) {
    throw new Error('Indigo invalid product name or public product URL.');
  }
  if (data.brand != null && typeof data.brand !== 'string') throw new Error('Indigo invalid product brand.');
  if (!Array.isArray(item.variations) || item.variations.length === 0) {
    throw new Error('Indigo missing variant product data.');
  }
  const deals = [];
  for (const variation of item.variations) {
    const variant = variation?.data;
    const code = typeof variant?.sku === 'string' ? variant.sku.trim()
      : Number.isSafeInteger(variant?.sku) && variant.sku > 0 ? String(variant.sku) : '';
    if (!code || !Number.isSafeInteger(variant?.__shopify_variant_id) || variant.__shopify_variant_id <= 0) {
      throw new Error('Indigo missing variant identifier.');
    }
    if (typeof variation.value !== 'string' || !variation.value.trim()) {
      throw new Error('Indigo missing variant product name.');
    }
    const current = price(variant.price);
    const regular = variant.compare_at_price == null ? null : price(variant.compare_at_price);
    if (variant.currency !== undefined && variant.currency !== 'CAD') {
      throw new Error('Indigo variant currency is not CAD.');
    }
    const eligible = regular !== null && current < regular;
    const identity = JSON.stringify([data.id, code, current, regular, variation.value.trim(), productUrl.href]);
    const prior = seen.variants.get(variant.__shopify_variant_id);
    // The feed can repeat a full-price variant with alternate unused stock fields.
    // Only matching non-deal identities are harmless. Sale or conflicting duplicates fail.
    if (prior !== undefined || seen.codes.has(code)) {
      if (prior === identity && !eligible) continue;
      throw new Error('Indigo duplicate variant identifier or SKU; collection stopped.');
    }
    seen.variants.set(variant.__shopify_variant_id, identity);
    seen.codes.add(code);
    // Full-price variants can omit availability fields; they are not deal rows.
    if (!eligible) continue;
    // Like the theme availability filter, an absent indexed location list is empty.
    const locations = variant.availableInStores === undefined ? [] : variant.availableInStores;
    if (!Number.isSafeInteger(variant.InventoryATS) || variant.InventoryATS < 0
      || !Array.isArray(locations)
      || locations.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('Indigo invalid or missing stock data.');
    }
    if (variant.InventoryATS === 0 && locations.length === 0) continue;
    const image = variant.image_url || data.image_url || null;
    if (image !== null && (typeof image !== 'string' || !/^https:\/\//.test(image))) {
      throw new Error('Indigo invalid product image URL.');
    }
    const savingsAmount = Math.round((regular - current) * 100) / 100;
    deals.push({ product_code: code, product_name: variation.value.trim(), brand: data.brand || null,
      regular_price: regular, sale_price: current, savings_amount: savingsAmount,
      savings_percent: Math.round((savingsAmount / regular) * 10000) / 100,
      category: categorizeProduct(variation.value, data.brand), currency: 'CAD',
      image_url: image,
      product_url: `${productUrl.href}?variant=${variant.__shopify_variant_id}`,
      in_stock: 1, scraped_at: new Date().toISOString() });
  }
  return deals;
}

/**
 * Categorizes a product by name/brand keywords.
 * @param {string} productName Product name.
 * @param {string|null} brand Brand name.
 * @returns {string} Existing Indigo category.
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
 * Collect the complete public Indigo clearance inventory before returning deals.
 * No later request or partial result is possible after any refused or invalid page.
 * @returns {Promise<{deals: Array<object>, totalProducts: number, totalPages: number, markdownCount: number}>} Complete snapshot.
 * @throws {Error} For empty deals, missing data, incomplete collection, or refusal.
 */
export async function scrapeIndigo() {
  const key = collectionKey(await fetchPublic(`${BASE_URL}/collections/${COLLECTION}`));
  const seen = { products: new Set(), variants: new Map(), codes: new Set() };
  const deals = [];
  let total = null;
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    if (page > 1) await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    const url = new URL(BROWSE_URL);
    url.search = new URLSearchParams({ key, page: String(page), num_results_per_page: String(PAGE_SIZE) }).toString();
    const text = await fetchPublic(url.href);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Indigo page ${page}: invalid JSON product data.`); }
    const raw = catalogPage(data, page, total);
    total = raw.total;
    totalPages = Math.ceil(total / PAGE_SIZE);
    for (const item of raw.results) deals.push(...productDeals(item, seen));
    console.log(`Indigo page ${page}/${totalPages}: ${raw.results.length} products, ${deals.length} CAD markdown deals so far`);
  }
  if (seen.products.size !== total) throw new Error('Indigo incomplete collection; existing publication was not changed.');
  if (deals.length === 0) throw new Error('Indigo has no eligible in-stock markdown deals; existing publication was not changed.');
  console.log(`Scraping complete: ${deals.length} CAD markdown deals from ${total} sale products`);
  return { deals, totalProducts: total, totalPages, markdownCount: deals.length };
}
