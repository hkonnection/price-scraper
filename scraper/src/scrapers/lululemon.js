/**
 * lululemon Canada Scraper
 * Scrapes "We Made Too Much" (WMTM) deals from shop.lululemon.com/en-ca.
 * Uses Playwright to bypass Akamai bot protection, then fetches paginated
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
 * Launches Playwright to establish an Akamai session, then uses
 * in-browser fetch() to paginate through all WMTM sections.
 *
 * @returns {Promise<{deals: Array<object>, totalProducts: number, sections: Array<object>}>}
 */
export async function scrapeLululemon() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-CA',
  });
  const page = await context.newPage();

  // Mask webdriver property to avoid bot detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

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
 * Scrapes all pages for a single WMTM section using in-browser fetch.
 * Fetches page 1 HTML, extracts __NEXT_DATA__ to get totalProductPages,
 * then fetches remaining pages.
 *
 * @param {import('playwright').Page} page - Playwright page with active session
 * @param {{name: string, path: string}} section - WMTM section config
 * @returns {Promise<Array<object>>} Array of deal objects
 */
async function scrapeSectionPages(page, section) {
  const sectionDeals = [];

  // Fetch page 1 to get total page count
  const firstPageData = await fetchPageData(page, section.path, 1);

  if (!firstPageData) {
    console.log(`  Could not fetch ${section.name} page 1, skipping section.`);
    return [];
  }

  const { products, totalProductPages } = firstPageData;
  console.log(`  ${section.name}: ${totalProductPages} pages to scrape`);

  // Process page 1 products
  const page1Deals = products.map((p) => transformProduct(p, section.name));
  sectionDeals.push(...page1Deals.filter(Boolean));
  console.log(`  Page 1: ${page1Deals.filter(Boolean).length} deals`);

  // Fetch remaining pages
  for (let pageNum = 2; pageNum <= totalProductPages; pageNum++) {
    const pageData = await fetchPageData(page, section.path, pageNum);

    if (!pageData || !pageData.products) {
      console.log(`  Page ${pageNum}: fetch failed, skipping`);
      continue;
    }

    const pageDeals = pageData.products
      .map((p) => transformProduct(p, section.name))
      .filter(Boolean);
    sectionDeals.push(...pageDeals);
    console.log(`  Page ${pageNum}: ${pageDeals.length} deals`);

    // Small delay between pages to be respectful
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return sectionDeals;
}

/**
 * Fetches a single page of WMTM products via in-browser fetch.
 * Extracts __NEXT_DATA__ JSON from the HTML response.
 *
 * @param {import('playwright').Page} page - Playwright page with active session
 * @param {string} sectionPath - URL path for the WMTM section
 * @param {number} pageNum - Page number to fetch
 * @returns {Promise<{products: Array<object>, totalProductPages: number}|null>}
 */
async function fetchPageData(page, sectionPath, pageNum) {
  try {
    const result = await page.evaluate(
      async ({ path, num }) => {
        const url = num === 1 ? path : `${path}?page=${num}`;
        const resp = await fetch(url, { headers: { Accept: 'text/html' } });
        if (!resp.ok) return null;

        const html = await resp.text();
        const match = html.match(
          /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/
        );
        if (!match) return null;

        const data = JSON.parse(match[1]);
        const queries =
          data.props?.pageProps?.dehydratedState?.queries || [];
        const catQuery = queries.find(
          (q) => q.queryKey?.[0] === 'CategoryPageDataQuery'
        );
        if (!catQuery) return null;

        const pageData = catQuery.state?.data?.pages?.[0];
        if (!pageData) return null;

        return {
          products: pageData.products || [],
          totalProductPages: pageData.totalProductPages || 1,
        };
      },
      { path: sectionPath, num: pageNum }
    );

    return result;
  } catch (err) {
    console.error(`  Error fetching page ${pageNum}: ${err.message}`);
    return null;
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
  if (!product.productOnSale) return null;

  const regularPrice = parseFloat(product.listPrice?.[0]);
  const salePrice = parseFloat(product.productSalePrice?.[0]);

  if (!regularPrice || !salePrice || isNaN(regularPrice) || isNaN(salePrice)) {
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
