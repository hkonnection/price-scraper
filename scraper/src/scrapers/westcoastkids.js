/**
 * West Coast Kids Scraper
 * Scrapes sale items from westcoastkids.ca using Playwright.
 * The site uses Constructor.io to dynamically load products,
 * requiring browser rendering to extract pricing data.
 */

import { chromium } from 'playwright';

const SALE_URL = 'https://www.westcoastkids.ca/sale?products=1';
const PRODUCTS_PER_PAGE = 48;

/**
 * Scrapes all sale items from West Coast Kids.
 * Uses Playwright to render the page and extract product data from the DOM.
 *
 * @returns {Promise<{deals: Array<Deal>, totalProducts: number}>}
 */
export async function scrapeWestcoastkids() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const allDeals = [];

  try {
    console.log(`Navigating to ${SALE_URL}...`);
    // Use 'load' instead of 'networkidle' - site has constant analytics traffic
    await page.goto(SALE_URL, { waitUntil: 'load', timeout: 60000 });

    // Close newsletter modal if it appears
    await closeModalIfPresent(page);

    // Wait for Constructor.io to load products (they load dynamically)
    console.log('Waiting for products to load...');
    await page.waitForSelector('.js-product-item', { timeout: 60000 });

    // Get total product count from page
    const totalText = await page.textContent('.toolbar-amount');
    const totalMatch = totalText?.match(/of\s+(\d+)/);
    const totalProducts = totalMatch ? parseInt(totalMatch[1]) : 0;
    console.log(`Total products in sale: ${totalProducts}`);

    const totalPages = Math.ceil(totalProducts / PRODUCTS_PER_PAGE);
    console.log(`Total pages to scrape: ${totalPages}`);

    // Scrape first page
    const firstPageDeals = await extractDealsFromPage(page);
    allDeals.push(...firstPageDeals);
    console.log(`Page 1: Found ${firstPageDeals.length} deals`);

    // Scrape remaining pages
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      const pageUrl = `${SALE_URL}&p=${pageNum}`;
      console.log(`Navigating to page ${pageNum}...`);

      await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
      await closeModalIfPresent(page);
      await page.waitForSelector('.js-product-item', { timeout: 60000 });

      const pageDeals = await extractDealsFromPage(page);
      allDeals.push(...pageDeals);
      console.log(`Page ${pageNum}: Found ${pageDeals.length} deals`);

      // Small delay to be respectful to the server
      await page.waitForTimeout(1000);
    }

    console.log(`\nTotal deals scraped: ${allDeals.length}`);

  } finally {
    await browser.close();
  }

  return {
    deals: allDeals,
    totalProducts: allDeals.length,
  };
}

/**
 * Closes the newsletter modal if it appears.
 *
 * @param {import('playwright').Page} page - Playwright page
 */
async function closeModalIfPresent(page) {
  try {
    // Try pressing Escape to close any modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } catch {
    // Modal might not be present, continue
  }
}

/**
 * Extracts deal data from all products on the current page.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @returns {Promise<Array<Deal>>}
 */
async function extractDealsFromPage(page) {
  return await page.evaluate(() => {
    const deals = [];
    const items = document.querySelectorAll('.js-product-item');

    items.forEach(item => {
      const info = item.querySelector('.js-product-item-info, .product-item-info');
      if (!info) return;

      // Get data from Constructor.io attributes
      const productId = info.getAttribute('data-cnstrc-item-id');
      const productName = info.getAttribute('data-cnstrc-item-name');

      // Get brand from DOM
      const brandEl = item.querySelector('.brand-name');
      const brand = brandEl?.textContent?.trim() || null;

      // Get prices from DOM
      const salePriceEl = item.querySelector('.special-price .price');
      const originalPriceEl = item.querySelector('.old-price .price');

      // Parse prices (remove "CA$" and commas)
      const parsePrice = (text) => {
        if (!text) return null;
        const cleaned = text.replace(/[CA$,]/g, '').trim();
        return parseFloat(cleaned) || null;
      };

      const salePrice = parsePrice(salePriceEl?.textContent);
      const originalPrice = parsePrice(originalPriceEl?.textContent);

      // Get product link and image
      const linkEl = item.querySelector('a.product-item-link, a.product-item-photo');
      const productUrl = linkEl?.getAttribute('href') || null;

      const imageEl = item.querySelector('img.product-image-photo');
      const imageUrl = imageEl?.getAttribute('src') || null;

      // Only include items with valid pricing data
      if (productName && salePrice && originalPrice && salePrice < originalPrice) {
        const savingsAmount = Math.round((originalPrice - salePrice) * 100) / 100;
        const savingsPercent = Math.round((savingsAmount / originalPrice) * 10000) / 100;

        deals.push({
          product_code: productId,
          product_name: productName,
          brand: brand,
          regular_price: originalPrice,
          sale_price: salePrice,
          savings_amount: savingsAmount,
          savings_percent: savingsPercent,
          category: categorizeProduct(productName),
          image_url: imageUrl,
          product_url: productUrl,
          scraped_at: new Date().toISOString(),
        });
      }
    });

    /**
     * Categorizes a product based on keywords in its name.
     * @param {string} productName
     * @returns {string}
     */
    function categorizeProduct(productName) {
      const name = productName.toLowerCase();

      if (/stroller|pram|buggy/i.test(name)) return 'Strollers';
      if (/car seat|carseat|booster/i.test(name)) return 'Car Seats';
      if (/crib|bassinet|cradle/i.test(name)) return 'Cribs & Bassinets';
      if (/high chair|highchair|booster seat/i.test(name)) return 'Feeding';
      if (/bottle|nipple|formula/i.test(name)) return 'Feeding';
      if (/diaper|wipes|changing/i.test(name)) return 'Diapering';
      if (/sleeper|pajama|onesie|bodysuit|romper/i.test(name)) return 'Clothing';
      if (/swaddle|blanket|sleep sack/i.test(name)) return 'Sleep';
      if (/toy|play|rattle|teether/i.test(name)) return 'Toys';
      if (/monitor|camera/i.test(name)) return 'Safety & Monitors';
      if (/bath|towel|washcloth/i.test(name)) return 'Bath';
      if (/carrier|wrap|sling/i.test(name)) return 'Baby Carriers';
      if (/sampler|bundle|kit/i.test(name)) return 'Bundles';

      return 'Other';
    }

    return deals;
  });
}
