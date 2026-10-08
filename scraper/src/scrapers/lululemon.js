/**
 * lululemon Canada Scraper
 * Scrapes "We Made Too Much" (WMTM) deals from shop.lululemon.com/en-ca.
 * Uses ordinary Playwright navigation to read paginated public Canada
 * product data from __NEXT_DATA__ JSON embedded in each page.
 *
 * Uses the unfiltered WMTM collection for Women, Men, and Accessories.
 */

import { chromium } from 'playwright';

const BASE_URL = 'https://shop.lululemon.com';
// Initial-section anchor, rounded down: no cumulative widening on later pages.
const MAX_SECTION_DRIFT_RATIO = 0.03;

// Used only before navigation when the homepage has no sale link.
const SAVED_WMTM_PATH = '/en-ca/c/we-made-too-much/n18mhd';

/**
 * Scrapes all WMTM deals from lululemon Canada.
 * Launches Chrome with normal browser defaults and navigates each WMTM page.
 * Set LULULEMON_VISIBLE_CHROME=1 for visible Chrome; all other values stay headless.
 * Reads the unfiltered sale link from the Canadian header on each run.
 * A missing link permits the saved fallback before navigation, never after refusal.
 * Does not mask fingerprints or solve retailer challenges.
 *
 * @returns {Promise<{deals: Array<object>, totalProducts: number, sections: Array<object>}>}
 * @throws {Error} When ordinary access or any section's catalog cannot be read.
 */
export async function scrapeLululemon() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: process.env.LULULEMON_VISIBLE_CHROME !== '1',
    channel: 'chrome',
  });
  const allDeals = [];
  const sectionSummaries = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Navigate to homepage first to establish cookies, then go to WMTM.
    console.log('Navigating to lululemon homepage...');
    await navigatePage(page, `${BASE_URL}/en-ca/`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const path = await discoverWmtmPath(page);
    console.log('Session established.\n');

    // The site's unfiltered collection includes Women, Men and Accessories.
    // Do not infer gender labels from the request path or product names.
    for (const section of [{ name: 'We Made Too Much', path }]) {
      console.log(`--- Scraping ${section.name} WMTM ---`);
      const sectionDeals = await scrapeSectionPages(page, section);
      allDeals.push(...sectionDeals);

      sectionSummaries.push({
        name: section.name,
        dealCount: sectionDeals.length,
      });

      console.log(`  ${section.name}: ${sectionDeals.length} deals\n`);

      // Small delay between sections
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(`Total deals scraped: ${allDeals.length}`);
  } finally {
    await browser.close();
  }

  return {
    deals: allDeals,
    totalProducts: allDeals.length,
    sections: sectionSummaries,
  };
}

/**
 * Reads only the site's unfiltered header sale link on an ordinary Canadian page.
 * Allows identical duplicate links and a saved fallback only when the link is absent.
 * Invalid or conflicting marked links fail before any collection navigation.
 * @param {import('playwright').Page} page - Loaded Canadian retailer homepage.
 * @returns {Promise<string>} Same-origin unfiltered Canada collection path.
 * @throws {Error} When the source or any marked link is not trustworthy.
 */
async function discoverWmtmPath(page) {
  try {
    const source = new URL(page.url());
    if (source.origin !== BASE_URL || !source.pathname.startsWith('/en-ca/')) throw new Error();
    const selector = 'a[data-lll-component-name="hdr_mn:l1_we_made_too_much"]';
    const links = await page.$$eval(selector, anchors => anchors.map(anchor => ({
      href: anchor.getAttribute('href'), text: anchor.textContent,
    })));
    if (!Array.isArray(links)) throw new Error();
    if (links.length === 0) {
      console.log(`WMTM link source=saved fallback; URL=${BASE_URL}${SAVED_WMTM_PATH}`);
      return SAVED_WMTM_PATH;
    }
    const paths = new Set();
    for (const link of links) {
      if (typeof link?.href !== 'string' || typeof link.text !== 'string' ||
          link.text.replace(/\s+/g, ' ').trim() !== 'We Made Too Much') throw new Error();
      const url = new URL(link.href, BASE_URL);
      if (url.origin !== BASE_URL || url.username || url.password ||
          !/^\/en-ca\/c\/we-made-too-much\/[a-z0-9]+$/.test(url.pathname) ||
          [...url.searchParams.keys()].some(key => key !== 'icid')) throw new Error();
      paths.add(url.pathname);
    }
    if (paths.size !== 1) throw new Error();
    const path = [...paths][0];
    console.log(`WMTM link source=discovered; URL=${BASE_URL}${path}`);
    return path;
  } catch {
    throw new Error('Lululemon WMTM navigation: invalid or ambiguous Canada sale link');
  }
}

/**
 * Retains only public Canada collection paths in diagnostic URLs.
 * Drops credentials, query values, fragments and unrecognized private paths.
 * @param {unknown} value - Final response URL or URL in public error text.
 * @returns {string} Safe bounded destination evidence, or unavailable.
 */
function diagnosticUrl(value) {
  try {
    if (typeof value !== 'string') return 'unavailable';
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return 'unavailable';
    const publicPath = url.origin === BASE_URL &&
      /^\/en-ca\/(?:c\/[a-z0-9-]+\/[a-z0-9]+)?$/.test(url.pathname);
    return `${url.origin}${publicPath ? url.pathname : '/[redacted path]'}`.slice(0, 300);
  } catch { return 'unavailable'; }
}

/**
 * Normalizes and caps public title/body evidence while masking reflected values.
 * @param {unknown} value - Plain readable title or body prefix, never page JSON.
 * @returns {string} At most 300 readable characters without common secret values.
 */
function diagnosticText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/["']?[\w.-]*(?:token|secret|password|cookie|authorization|session|api[_-]?key)[\w.-]*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '[redacted value]')
    .replace(/https?:\/\/[^\s<>"']+/gi, diagnosticUrl)
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/\b[\w.-]+\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, '[redacted value]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi, '[redacted email]')
    .replace(/[a-z0-9_-]{24,}/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Navigates once and records bounded, sanitized evidence for a non-OK response.
 * Diagnostics are best effort; their failure cannot replace the fatal HTTP error.
 * @param {import('playwright').Page} page - Ordinary browser page.
 * @param {string} url - Trusted public destination.
 * @returns {Promise<void>} Resolves only for an OK navigation response.
 * @throws {Error} On transport failure or a non-OK HTTP response, without retry.
 */
async function navigatePage(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (response?.ok()) return;
  const status = response?.status() ?? 'unknown';
  let finalUrl = 'unavailable', text = '', kind = 'title';
  try { finalUrl = diagnosticUrl(response?.url()); } catch { /* Keep the HTTP failure. */ }
  try { text = diagnosticText(await page.title()); } catch { /* Read body if title is unavailable. */ }
  if (!text) {
    kind = 'body';
    try {
      text = diagnosticText(await page.evaluate(() => {
        const body = document.body?.innerText;
        return typeof body === 'string' ? body.slice(0, 1500) : '';
      }));
    } catch { /* Diagnostics are optional, not a second failure. */ }
  }
  try {
    console.warn(`Lululemon HTTP ${status}: final URL=${finalUrl}; ${kind}=${text || 'unavailable'}`);
  } catch { /* A failed logger must not hide the original status. */ }
  throw new Error(`HTTP ${status}`);
}

/**
 * Scrapes all pages for a single WMTM section using ordinary navigation.
 * Reads page 1 embedded catalog metadata, then visits each remaining page.
 * Anchors count drift and cumulative cross-page overlap to floor(initial total * 3%).
 * Current pages may move their final page within that count budget. Partial overlap
 * requires observed count movement and raw progress; first identity wins before filtering.
 * Legacy pages have no measurable total, so retain strict pagination/repeat checks.
 * Rejects malformed, truncated or repeated pages; moving data is not an atomic snapshot.
 *
 * @param {import('playwright').Page} page - Playwright page with active session
 * @param {{name: string, path: string}} section - WMTM section config
 * @returns {Promise<Array<object>>} Array of deal objects
 * @throws {Error} When a required page or its catalog pagination is unusable.
 */
async function scrapeSectionPages(page, section) {
  const sectionDeals = [];
  const seenProducts = new Set();
  const firstPageData = await fetchPageData(page, section.path, 1);
  const { products, totalProductPages } = firstPageData;
  const driftBudget = firstPageData.catalogType === 'current'
    ? Math.floor(firstPageData.totalCount * MAX_SECTION_DRIFT_RATIO) : 0;
  let finalPage = totalProductPages;
  let observedDrift = false;
  let totalOverlap = 0;
  console.log(`  ${section.name}: ${totalProductPages} pages to scrape`);

  for (let pageNum = 1; pageNum <= finalPage; pageNum++) {
    const pageData = pageNum === 1 ? firstPageData : await fetchPageData(page, section.path, pageNum);
    if (pageData.catalogType !== firstPageData.catalogType || pageData.limit !== firstPageData.limit ||
        (pageData.catalogType === 'current'
          ? Math.abs(pageData.totalCount - firstPageData.totalCount) > driftBudget
          : pageData.totalProductPages !== totalProductPages)) {
      throw new Error(`Lululemon ${section.path} page ${pageNum}: Inconsistent catalog pagination`);
    }
    // fetchPageData validates raw size against THIS page's offset/limit/count.
    // Following its validated final page covers bounded growth and shrink.
    finalPage = pageData.totalProductPages;
    if (pageData.catalogType === 'current' && pageData.totalCount !== firstPageData.totalCount) {
      observedDrift = true;
    }
    // Legacy pages expose no totalCount/limit; require full intermediate pages
    // and allow a nonempty final page no larger than the first page.
    if (pageData.catalogType === 'legacy' && (pageData.products.length > products.length ||
        (pageNum < finalPage && pageData.products.length !== products.length))) {
      throw new Error(`Lululemon ${section.path} page ${pageNum}: Inconsistent category product count`);
    }
    // Raw identities, not filtered deals, detect repeats even when offsets or
    // prices change. Scope these sets to one section, not overlapping sections.
    const pageIdentities = new Set();
    const newProducts = [];
    let overlap = 0;
    for (const product of pageData.products) {
      const id = pageData.catalogType === 'current' ? product?.id : product?.productId;
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error(`Lululemon ${section.path} page ${pageNum}: Missing catalog product identity`);
      }
      if (pageIdentities.has(id)) {
        throw new Error(`Lululemon ${section.path} page ${pageNum}: Repeated catalog product ${id}`);
      }
      pageIdentities.add(id);
      if (seenProducts.has(id)) overlap++;
      else newProducts.push(product);
    }
    if (newProducts.length === 0) {
      throw new Error(`Lululemon ${section.path} page ${pageNum}: Repeated catalog products; No pagination progress`);
    }
    if (overlap > 0 && (!observedDrift || totalOverlap + overlap > driftBudget)) {
      throw new Error(`Lululemon ${section.path} page ${pageNum}: Repeated catalog products exceed inventory drift allowance`);
    }
    totalOverlap += overlap;
    for (const id of pageIdentities) seenProducts.add(id);
    const pageDeals = newProducts
      .map((p) => transformProduct(p, section.name))
      .filter(Boolean);
    sectionDeals.push(...pageDeals);
    console.log(`  Page ${pageNum}: ${pageDeals.length} deals`);

    // Small delay between pages to be respectful
    if (pageNum > 1) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return sectionDeals;
}

/**
 * Navigates to a single WMTM page and reads its embedded public NEXT_DATA.
 * Validates legacy/current catalog schemas, page offsets and raw reference counts.
 * Non-OK navigation logs safe bounded evidence and still rejects the whole run.
 *
 * @param {import('playwright').Page} page - Playwright page with active session
 * @param {string} sectionPath - URL path for the WMTM section
 * @param {number} pageNum - Page number to fetch
 * @returns {Promise<{products: Array<object>, totalProductPages: number, catalogType: string, totalCount?: number, limit?: number, offset?: number}>}
 * @throws {Error} When HTTP, embedded data or catalog pagination is unusable.
 */
async function fetchPageData(page, sectionPath, pageNum) {
  try {
    const url = `${BASE_URL}${sectionPath}${pageNum === 1 ? '' : `?page=${pageNum}`}`;
    await navigatePage(page, url);
    await page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: 30000 });
    const result = await page.evaluate(
      ({ num }) => {
        const embedded = document.getElementById('__NEXT_DATA__');
        if (!embedded?.textContent) throw new Error('Missing NEXT_DATA');
        const data = JSON.parse(embedded.textContent);
        const queries =
          data.props?.pageProps?.dehydratedState?.queries || [];
        if (!Number.isSafeInteger(num) || num < 1) throw new Error('Invalid catalog pagination');
        const currentQuery = queries.find(q => q.queryKey?.[0] === 'catalogPageData');
        if (currentQuery) {
          const catalog = currentQuery.state?.data?.pages?.[0];
          const attributes = catalog?.data?.attributes;
          const references = catalog?.data?.relationships?.products?.data;
          if (!Array.isArray(catalog?.included) || !Array.isArray(references) || references.length === 0) {
            throw new Error('Empty or malformed catalog products');
          }
          const { totalCount, limit, offset } = attributes || {};
          const totalProductPages = Math.ceil(totalCount / limit);
          if (!Number.isSafeInteger(totalCount) || totalCount <= 0 || !Number.isSafeInteger(limit) || limit <= 0 ||
              !Number.isSafeInteger(offset) || offset !== (num - 1) * limit || offset >= totalCount ||
              totalProductPages > 200 || num > totalProductPages) {
            throw new Error('Invalid catalog pagination');
          }
          if (references.length !== Math.min(limit, totalCount - offset)) {
            throw new Error('Incomplete catalog products: raw reference count does not match pagination');
          }
          if (references.some(ref => ref?.type !== 'products' || typeof ref.id !== 'string' || !ref.id.trim())) {
            throw new Error('Missing catalog product identity');
          }
          const byId = new Map(catalog.included.filter(p => p?.type === 'products').map(p => [p.id, p]));
          const products = references.map(ref => byId.get(ref.id));
          if (products.some(p => !p?.attributes)) throw new Error('Missing referenced catalog product');
          return { products, totalProductPages, catalogType: 'current', totalCount, limit, offset };
        }

        const legacyQuery = queries.find(q => q.queryKey?.[0] === 'CategoryPageDataQuery');
        const legacy = legacyQuery?.state?.data?.pages?.[0];
        if (!Array.isArray(legacy?.products) || legacy.products.length === 0) {
          throw new Error('Unsupported or empty category catalog');
        }
        const totalProductPages = legacy.totalProductPages;
        if (!Number.isInteger(totalProductPages) || totalProductPages < 1 || totalProductPages > 200 || num > totalProductPages) {
          throw new Error('Invalid category pagination');
        }
        return { products: legacy.products, totalProductPages, catalogType: 'legacy' };
      },
      { num: pageNum }
    );

    return result;
  } catch (err) {
    throw new Error(`Lululemon ${BASE_URL}${sectionPath}${pageNum === 1 ? '' : `?page=${pageNum}`} page ${pageNum}: ${err.message}`);
  }
}

/**
 * Transforms a lululemon product object into a deal object.
 * Skips products without valid pricing data.
 *
 * @param {object} product - Product from __NEXT_DATA__
 * @param {string} sectionName - WMTM section name (Women, Men, Accessories)
 * @returns {object|null} Deal object or null if invalid
 */
function transformProduct(product, sectionName) {
  // The current catalog keeps matched prices and images on each style/color.
  if (product?.type === 'products') {
    const attributes = product.attributes;
    if (!attributes?.name || !attributes.url || !Array.isArray(attributes.styles)) return null;
    const colors = attributes.styles.flatMap(style => Array.isArray(style.colors) ? style.colors : []);
    const color = colors.find(color => {
      const price = color?.price;
      return color?.availability?.isAvailable === true && price?.currencyCode === 'CAD' &&
        Number.isFinite(price.listPrice) && Number.isFinite(price.salePrice) &&
        price.listPrice > 0 && price.salePrice > 0 && price.salePrice < price.listPrice;
    });
    if (!color) return null;
    const colorId = color.id?.split('-').at(-1);
    product = {
      productOnSale: true,
      productId: product.id,
      displayName: attributes.name,
      listPrice: [color.price.listPrice],
      productSalePrice: [color.price.salePrice],
      pdpUrl: attributes.url + (colorId ? `?color=${Number(colorId)}` : ''),
      swatches: [{ primaryImage: color.images?.[0]?.url || null }],
      parentCategoryUnifiedId: attributes.parentCategory?.unifiedId || '',
    };
  }
  if (!product?.productOnSale || typeof product.displayName !== 'string' || !product.displayName.trim()) return null;

  const regularPrice = parseFloat(product.listPrice?.[0]);
  const salePrice = parseFloat(product.productSalePrice?.[0]);

  if (!Number.isFinite(regularPrice) || !Number.isFinite(salePrice) || regularPrice <= 0 || salePrice <= 0) {
    return null;
  }

  if (salePrice >= regularPrice) return null;

  const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;
  const savingsPercent =
    Math.round((savingsAmount / regularPrice) * 10000) / 100;

  const imageUrl = product.swatches?.[0]?.primaryImage || null;
  const productUrl = product.pdpUrl
    ? `${BASE_URL}/en-ca${product.pdpUrl}`
    : null;

  const category = mapCategory(
    product.parentCategoryUnifiedId || '',
    sectionName
  );

  return {
    product_code: product.productId || '',
    product_name: product.displayName,
    brand: 'Lululemon',
    regular_price: regularPrice,
    sale_price: salePrice,
    savings_amount: savingsAmount,
    savings_percent: savingsPercent,
    category,
    image_url: imageUrl,
    product_url: productUrl,
    valid_from: null,
    valid_to: null,
    in_stock: 1,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * Maps lululemon's parentCategoryUnifiedId to a human-readable category.
 *
 * @param {string} categoryId - lululemon category identifier
 * @param {string} sectionName - WMTM section (Women, Men, Accessories)
 * @returns {string} Category name
 */
function mapCategory(categoryId, sectionName) {
  const id = categoryId.toLowerCase();

  if (id.includes('jacket') || id.includes('outerwear') || id.includes('coat'))
    return 'Jackets & Outerwear';
  if (id.includes('hoodie') || id.includes('sweatshirt'))
    return 'Hoodies & Sweatshirts';
  if (id.includes('pant') || id.includes('trouser') || id.includes('jogger'))
    return 'Pants';
  if (id.includes('legging') || id.includes('tight')) return 'Leggings';
  if (id.includes('short')) return 'Shorts';
  if (id.includes('skirt') || id.includes('dress')) return 'Skirts & Dresses';
  if (id.includes('bra')) return 'Sports Bras';
  if (id.includes('tank') || id.includes('sleeveless')) return 'Tank Tops';
  if (id.includes('shirt') || id.includes('top') || id.includes('tee'))
    return 'Shirts & Tops';
  if (id.includes('sweater')) return 'Sweaters';
  if (id.includes('sock')) return 'Socks';
  if (id.includes('underwear')) return 'Underwear';
  if (id.includes('bag') || id.includes('backpack')) return 'Bags';
  if (id.includes('hat') || id.includes('headband')) return 'Hats & Headwear';
  if (id.includes('shoe') || id.includes('sandal')) return 'Shoes';
  if (id.includes('bottle')) return 'Water Bottles';
  if (id.includes('mat')) return 'Yoga Mats';
  if (id.includes('accessori')) return 'Accessories';

  if (sectionName === 'Accessories') return 'Accessories';
  return 'Other';
}
