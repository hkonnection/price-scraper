/**
 * Nike Canada Scraper Entry Point
 * Fetches sale deals from Nike.com/ca and pushes to Cloudflare D1.
 */

import { scrapeNike } from './scrapers/nike.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('Starting Nike Canada scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    // Scrape deals from Nike Canada sale
    console.log('\nFetching deals from Nike Canada sale...');
    const { deals: rawDeals, totalProducts } = await scrapeNike();
    console.log(`Found ${rawDeals.length} deals from ${totalProducts} total products`);

    // Clean deals with Nike-specific cleaner
    const cleaner = await getCleaner('nike');
    const deals = cleaner.clean(rawDeals);

    if (deals.length === 0) {
      console.log('No deals found. Exiting.');
      return;
    }

    // Show sample of deals
    console.log('\nSample deals:');
    deals.slice(0, 5).forEach(deal => {
      console.log(`  - ${deal.product_name} (${deal.category}): $${deal.sale_price} was $${deal.regular_price} (${deal.savings_percent}% off)`);
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
      await pushToD1(deals, 'nike', null);
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
