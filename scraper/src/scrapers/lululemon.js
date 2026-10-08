/**
 * lululemon Canada Scraper
 * Scrapes "We Made Too Much" (WMTM) deals from shop.lululemon.com/en-ca.
 * Uses ordinary Playwright navigation to read paginated public Canada
 * product data from __NEXT_DATA__ JSON embedded in each page.
 *
 * Covers three WMTM sections: Women, Men, and Accessories.
 */

import { chromium } from 'playwright';

const BASE_URL = 'https://shop.lululemon.com';

const WMTM_SECTIONS = [
  {
    name: 'Women',
    path: '/en-ca/c/women-we-made-too-much/n16o10z8mhd',
  },
  {
    name: 'Men',
    path: '/en-ca/c/men-we-made-too-much/n18mhdznrqw',
  },
  {
    name: 'Accessories',
    path: '/en-ca/c/we-made-too-much-accessories/n14w56z8mhd',
  },
];

/**
 * Scrapes all WMTM deals from lululemon Canada.
 * Launches Chrome with normal browser defaults and navigates each WMTM page.
 * Does not mask fingerprints or solve retailer challenges.
 *
 * @returns {Promise<{deals: Array<object>, totalProducts: number, sections: Array<object>}>}
 * @throws {Error} When ordinary access or any section's catalog cannot be read.
 */
export async function scrapeLululemon() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const allDeals = [];
  const sectionSummaries = [];

  try {
    // Navigate to homepage first to establish cookies, then go to WMTM
    console.log('Navigating to lululemon homepage...');
    await page.goto(`${BASE_URL}/en-ca/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const firstUrl = `${BASE_URL}${WMTM_SECTIONS[0].path}`;
    console.log(`Navigating to ${firstUrl}...`);
    await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for __NEXT_DATA__ to be attached (script tags are never "visible")
    await page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: 30000 });
    console.log('Session established.\n');

    // Scrape each WMTM section
    for (const section of WMTM_SECTIONS) {
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
 * Scrapes all pages for a single WMTM section using ordinary navigation.
 * Reads page 1 embedded catalog metadata, then visits each remaining page.
 * Checks stable raw pagination and unique product identities before sale filtering.
 * Rejects incomplete or overlapping pagination instead of publishing a partial section.
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
  console.log(`  ${section.name}: ${totalProductPages} pages to scrape`);

  for (let pageNum = 1; pageNum <= totalProductPages; pageNum++) {
    const pageData = pageNum === 1 ? firstPageData : await fetchPageData(page, section.path, pageNum);
    if (pageData.catalogType !== firstPageData.catalogType || pageData.totalProductPages !== totalProductPages ||
        pageData.totalCount !== firstPageData.totalCount || pageData.limit !== firstPageData.limit) {
      throw new Error(`Lululemon ${section.path} page ${pageNum}: Inconsistent catalog pagination`);
    }
    // Legacy pages expose no totalCount/limit; require full intermediate pages
    // and allow a nonempty final page no larger than the first page.
    if (pageData.catalogType === 'legacy' && (pageData.products.length > products.length ||
        (pageNum < totalProductPages && pageData.products.length !== products.length))) {
      throw new Error(`Lululemon ${section.path} page ${pageNum}: Inconsistent category product count`);
    }
    // Raw identities, not filtered deals, detect repeats even when offsets or
    // prices change. Scope this set to one section, not overlapping sections.
    for (const product of pageData.products) {
      const id = pageData.catalogType === 'current' ? product?.id : product?.productId;
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error(`Lululemon ${section.path} page ${pageNum}: Missing catalog product identity`);
      }
      if (seenProducts.has(id)) {
        throw new Error(`Lululemon ${section.path} page ${pageNum}: Repeated catalog product ${id}`);
      }
      seenProducts.add(id);
    }
    const pageDeals = pageData.products
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
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? 'unknown'}`);
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
    throw new Error(`Lululemon ${sectionPath} page ${pageNum}: ${err.message}`);
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
