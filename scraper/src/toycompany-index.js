/**
 * Granville Island Toy Company Scraper Entry Point
 * Fetches deals from toycompany.com and pushes to Cloudflare D1
 */

import { scrapeToycompany } from './scrapers/toycompany.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('Starting Granville Island Toy Company scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    // Scrape deals from Toy Company
    console.log('\nFetching deals from Toy Company (50% off collection)...');
    const { deals: rawDeals, totalProducts } = await scrapeToycompany();
    console.log(`Found ${rawDeals.length} products (${totalProducts} total)`);

    // Clean deals with Toy Company-specific cleaner
    const cleaner = await getCleaner('toycompany');
    const deals = cleaner.clean(rawDeals);

    if (deals.length === 0) {
      console.log('No deals found. Exiting.');
      return;
    }

    // Show stock breakdown
    const inStock = deals.filter(d => d.in_stock === 1).length;
    const outOfStock = deals.filter(d => d.in_stock === 0).length;
    console.log(`\nStock status: ${inStock} in stock, ${outOfStock} out of stock`);

    // Show sample of deals
    console.log('\nSample deals (in stock):');
    deals
      .filter(d => d.in_stock === 1)
      .slice(0, 5)
      .forEach(deal => {
        console.log(`  - ${deal.product_name} (${deal.brand}): $${deal.sale_price} (was $${deal.regular_price})`);
      });

    // Show category breakdown
    const categories = {};
    deals.forEach(deal => {
      categories[deal.category] = (categories[deal.category] || 0) + 1;
    });
    console.log('\nCategory breakdown:');
    Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        console.log(`  - ${cat}: ${count}`);
      });

    if (DRY_RUN) {
      console.log('\nDry run complete. No data pushed to D1.');
      console.log(`Would have pushed ${deals.length} deals.`);
    } else {
      // Push to D1
      console.log('\nPushing deals to D1...');
      await pushToD1(deals, 'toycompany', null);
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
