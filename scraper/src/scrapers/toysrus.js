/**
 * Toys R Us Canada Scraper
 * Uses Playwright to scrape deals from toysrus.ca (requires JavaScript rendering)
 */

import { chromium } from 'playwright';

const RETAILERS = [
  { url: 'https://www.toysrus.ca/en/toysrus/Deals', name: 'Toys R Us', slug: 'toysrus' },
  { url: 'https://www.babiesrus.ca/en/babiesrus/Deals', name: 'Babies R Us', slug: 'babiesrus' },
];
const PRODUCTS_PER_PAGE = 24;

/**
 * Dismisses the OneTrust cookie consent banner if present.
 * @param {Page} page - Playwright page instance
 */
async function dismissCookieConsent(page) {
  try {
    // Look for the "Accept All Cookies" button
    const acceptButton = await page.$('#onetrust-accept-btn-handler, [id*="accept"], .onetrust-close-btn-handler');
    if (acceptButton) {
      const isVisible = await acceptButton.isVisible();
      if (isVisible) {
        console.log('Dismissing cookie consent banner...');
        await acceptButton.click();
        await page.waitForTimeout(1000);
      }
    }
  } catch (error) {
    // Ignore errors - banner may not be present
    console.log('No cookie consent banner found or already dismissed');
  }
}

/**
 * Extracts product data from the current page using browser context.
 * @param {Page} page - Playwright page instance
 * @returns {Promise<Array<object>>} Array of raw product data
 */
async function extractProductsFromPage(page) {
  return await page.evaluate(() => {
    const products = [];
    const productTiles = document.querySelectorAll('.b-product_tile');

    productTiles.forEach((tile) => {
      const productId = tile.dataset.pid;

      // Try multiple selectors for product name
      const nameEl = tile.querySelector('.b-product_tile-title_link')
        || tile.querySelector('.js-pdp-link')
        || tile.querySelector('.b-product_tile-name a')
        || document.getElementById(`tile-product-name-${productId}`);

      // Try multiple selectors for prices
      const listPriceEl = tile.querySelector('.js-list-price-value')
        || tile.querySelector('[class*="list-price"]')
        || tile.querySelector('.b-price-item_old .b-price-value');

      const salePriceEl = tile.querySelector('.js-sales-price-value')
        || tile.querySelector('[class*="sales-price"]')
        || tile.querySelector('.b-price-item_sale .b-price-value');

      const imageEl = tile.querySelector('img');
      const ratingEl = tile.querySelector('[class*="rating"]');

      // Extract brand from GTM dataLayer if available
      let brand = null;
      let category = null;
      if (window.dataLayer) {
        const impressions = window.dataLayer.find(d => d.ecommerce?.impressions)?.ecommerce?.impressions;
        if (impressions) {
          const match = impressions.find(i => i.id === productId);
          if (match) {
            brand = match.brand;
            category = match.category;
          }
        }
      }

      // Get product name from any text content if still not found
      let productName = nameEl?.textContent?.trim();
      if (!productName) {
        const linkWithTitle = tile.querySelector('a[title]');
        productName = linkWithTitle?.getAttribute('title');
      }

      // Get prices - be more lenient
      const listPrice = listPriceEl?.textContent?.trim();
      const salePrice = salePriceEl?.textContent?.trim();

      // Only require product ID and some price info
      if (productId && (salePrice || listPrice)) {
        products.push({
          product_id: productId,
          product_name: productName || `Product ${productId}`,
          list_price: listPrice,
          sale_price: salePrice || listPrice,
          brand: brand,
          category: category,
          image_url: imageEl?.src || imageEl?.dataset?.src,
          rating: ratingEl?.textContent?.trim(),
        });
      }
    });

    return products;
  });
}

/**
 * Gets the total number of products from the page.
 * @param {Page} page - Playwright page instance
 * @returns {Promise<number>} Total product count
 */
async function getTotalProductCount(page) {
  return await page.evaluate(() => {
    // Look for "Showing X of Y products" text
    const countText = document.querySelector('[class*="results-count"], .b-load_more-count')?.textContent;
    if (countText) {
      const match = countText.match(/of\s+(\d+)/i);
      if (match) return parseInt(match[1], 10);
    }
    // Fallback: check aria-setsize on product tiles
    const tile = document.querySelector('.b-product_tile[aria-setsize]');
    if (tile) {
      return parseInt(tile.getAttribute('aria-setsize'), 10);
    }
    return 0;
  });
}

/**
 * Clicks the "Load More" button if available.
 * @param {Page} page - Playwright page instance
 * @returns {Promise<boolean>} True if more products were loaded
 */
async function loadMoreProducts(page) {
  const loadMoreButton = await page.$('.b-load_more-button, [class*="load-more"] button');
  if (loadMoreButton) {
    const isVisible = await loadMoreButton.isVisible();
    const isEnabled = await loadMoreButton.isEnabled();

    if (isVisible && isEnabled) {
      await loadMoreButton.click();
      // Wait for new products to load
      await page.waitForTimeout(2000);
      return true;
    }
  }
  return false;
}

/**
 * Scrapes deals from a single retailer URL.
 * @param {Page} page - Playwright page instance
 * @param {object} retailer - Retailer config { url, name, slug }
 * @param {number} maxProducts - Maximum products to scrape
 * @returns {Promise<{products: Array<object>, totalCount: number, slug: string}>}
 */
async function scrapeDealsFromRetailer(page, retailer, maxProducts) {
  const { url, name, slug } = retailer;
  console.log(`\nScraping ${name}...`);
  console.log(`Navigating to ${url}...`);

  await page.goto(url, { waitUntil: 'networkidle' });

  // Dismiss cookie consent banner if present
  await dismissCookieConsent(page);

  // Check if products exist on this page
  const hasProducts = await page.$('.b-product_tile');
  if (!hasProducts) {
    console.log(`No products found on ${name}`);
    return { products: [], totalCount: 0, slug };
  }

  // Wait for products to load
  await page.waitForSelector('.b-product_tile', { timeout: 30000 });

  const totalCount = await getTotalProductCount(page);
  console.log(`${name}: ${totalCount} products available`);

  if (totalCount === 0) {
    return { products: [], totalCount: 0, slug };
  }

  const allProducts = [];
  let previousCount = 0;
  let attempts = 0;
  const maxAttempts = 50;

  while (allProducts.length < totalCount && allProducts.length < maxProducts && attempts < maxAttempts) {
    const products = await extractProductsFromPage(page);

    // Dedupe by product_id
    const existingIds = new Set(allProducts.map(p => p.product_id));
    const newProducts = products.filter(p => !existingIds.has(p.product_id));
    allProducts.push(...newProducts);

    console.log(`${name}: Loaded ${allProducts.length}/${totalCount} products`);

    if (allProducts.length >= totalCount || allProducts.length >= maxProducts) {
      break;
    }

    const loaded = await loadMoreProducts(page);
    if (!loaded) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      const newCount = (await extractProductsFromPage(page)).length;
      if (newCount === previousCount) {
        console.log(`${name}: No more products to load`);
        break;
      }
    }

    previousCount = allProducts.length;
    attempts++;
  }

  return { products: allProducts, totalCount, slug };
}

/**
 * Scrapes all deals from Toys R Us and Babies R Us Canada.
 * Returns results grouped by retailer slug for separate DB insertion.
 * @param {object} options - Scraper options
 * @param {boolean} options.headless - Run browser in headless mode (default: true)
 * @param {number} options.maxProducts - Maximum products to scrape per retailer (default: all)
 * @returns {Promise<{retailers: Array<{slug: string, name: string, deals: Array, totalCount: number}>}>}
 */
export async function scrapeToysRUs(options = {}) {
  const { headless = true, maxProducts = Infinity } = options;

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    const results = [];

    // Scrape each retailer
    for (const retailer of RETAILERS) {
      const { products, totalCount, slug } = await scrapeDealsFromRetailer(page, retailer, maxProducts);
      results.push({
        slug,
        name: retailer.name,
        deals: products,
        totalCount,
      });
    }

    const grandTotal = results.reduce((sum, r) => sum + r.deals.length, 0);
    console.log(`\nScraped ${grandTotal} products total from all retailers`);

    return { retailers: results };
  } finally {
    await browser.close();
  }
}
