/**
 * Nike Canada Scraper
 * Fetches sale products from Nike's Discover API for the Canadian marketplace.
 * Uses direct REST API calls — no Playwright required.
 */

const BASE_API_URL = 'https://api.nike.com/discover/product_wall/v1/marketplace/CA/language/en-GB/consumerChannelId/d9a5bc42-4b9c-4976-858a-f159cf99c647';
const SALE_PATH = '/ca/w/sale-3yaep';
const SALE_ATTRIBUTE_ID = '5b21a62a-0503-400c-8336-3ccfbff2a684';
const PAGE_SIZE = 24;
const REQUEST_DELAY_MS = 600;

/**
 * Fetches a single page of sale products from Nike's Discover API.
 *
 * @param {number} anchor - Pagination offset (0, 24, 48, ...)
 * @returns {Promise<{ groupings: Array, totalResources: number, totalPages: number }>}
 */
async function fetchPage(anchor) {
  const url = `${BASE_API_URL}?path=${encodeURIComponent(SALE_PATH)}&attributeIds=${SALE_ATTRIBUTE_ID}&queryType=PRODUCTS&anchor=${anchor}&count=${PAGE_SIZE}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'nike-api-caller-id': 'com.nike.commerce.nikedotcom.web',
    },
  });

  if (!response.ok) {
    throw new Error(`Nike API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const groupings = data.productGroupings || [];
  const pages = data.pages || {};

  return {
    groupings,
    totalResources: pages.totalResources || 0,
    totalPages: pages.totalPages || 0,
  };
}

/**
 * Extracts individual deals from a product grouping.
 * Each grouping may contain multiple colorways — each becomes a separate deal.
 *
 * @param {object} grouping - A productGroupings item from Nike API
 * @returns {Array<object>} Flat array of deal objects
 */
function extractDealsFromGrouping(grouping) {
  const products = grouping.products || [];
  const deals = [];

  for (const product of products) {
    const prices = product.prices || {};
    const currentPrice = prices.currentPrice;
    const initialPrice = prices.initialPrice;

    // Skip products that aren't actually on sale
    if (!currentPrice || !initialPrice || currentPrice >= initialPrice) {
      continue;
    }

    const savingsAmount = Math.round((initialPrice - currentPrice) * 100) / 100;
    const savingsPercent = Math.round((savingsAmount / initialPrice) * 10000) / 100;

    deals.push({
      product_code: product.productCode || '',
      product_name: product.copy?.title || 'Unknown',
      category: product.copy?.subTitle || product.productType || 'Other',
      brand: 'Nike',
      regular_price: initialPrice,
      sale_price: currentPrice,
      savings_amount: savingsAmount,
      savings_percent: savingsPercent,
      image_url: product.colorwayImages?.squarishURL || '',
      product_url: product.pdpUrl?.url || '',
      scraped_at: new Date().toISOString(),
      in_stock: 1,
    });
  }

  return deals;
}

/**
 * Scrapes all sale products from Nike Canada.
 * Paginates through the Discover API and flattens all colorways into individual deals.
 *
 * @returns {Promise<{ deals: Array<object>, totalProducts: number }>}
 */
export async function scrapeNike() {
  console.log('Fetching page 1...');
  const firstPage = await fetchPage(0);
  const { totalResources, totalPages } = firstPage;

  console.log(`Total: ${totalResources} products across ${totalPages} pages`);

  let allDeals = [];

  // Process first page
  for (const grouping of firstPage.groupings) {
    allDeals.push(...extractDealsFromGrouping(grouping));
  }
  console.log(`  Page 1: ${firstPage.groupings.length} groupings → ${allDeals.length} deals so far`);

  // Fetch remaining pages
  for (let anchor = PAGE_SIZE; anchor < totalResources; anchor += PAGE_SIZE) {
    const pageNum = Math.floor(anchor / PAGE_SIZE) + 1;

    // Delay between requests to be polite
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));

    console.log(`Fetching page ${pageNum}/${totalPages}...`);
    try {
      const page = await fetchPage(anchor);
      for (const grouping of page.groupings) {
        allDeals.push(...extractDealsFromGrouping(grouping));
      }
      console.log(`  Page ${pageNum}: ${page.groupings.length} groupings → ${allDeals.length} deals so far`);
    } catch (error) {
      console.error(`  Error on page ${pageNum}: ${error.message}`);
    }
  }

  // Deduplicate by product_code (same colorway listed in multiple pages)
  const seen = new Map();
  for (const deal of allDeals) {
    if (!seen.has(deal.product_code)) {
      seen.set(deal.product_code, deal);
    }
  }
  const uniqueDeals = Array.from(seen.values());

  console.log(`\nTotal deals: ${allDeals.length} → ${uniqueDeals.length} after dedup`);
  return {
    deals: uniqueDeals,
    totalProducts: totalResources,
  };
}
