/**
 * lululemon Canada Scraper Entry Point
 * Scrapes "We Made Too Much" deals from shop.lululemon.com/en-ca
 * and pushes to Cloudflare D1.
 */

import { scrapeLululemon } from './scrapers/lululemon.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('Starting Lululemon Canada WMTM scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    // Scrape all WMTM sections
    console.log('\nFetching "We Made Too Much" deals...');
    const { deals: rawDeals, totalProducts, sections } =
      await scrapeLululemon();
    console.log(`Found ${rawDeals.length} deals (${totalProducts} total)`);

    // Show section breakdown
    console.log('\nSection breakdown:');
    sections.forEach((s) => {
      console.log(`  - ${s.name}: ${s.dealCount} deals`);
    });

    // Clean deals
    const cleaner = await getCleaner('lululemon');
    const deals = cleaner.clean(rawDeals);

    if (deals.length === 0) {
      console.log('No deals found. Exiting.');
      return;
    }

    // Show sample deals
    console.log('\nSample deals:');
    deals.slice(0, 5).forEach((deal) => {
      console.log(
        `  - ${deal.product_name}: $${deal.sale_price.toFixed(2)} (was $${deal.regular_price.toFixed(2)}, save ${deal.savings_percent}%)`
      );
    });

    // Show category breakdown
    const categories = {};
    deals.forEach((deal) => {
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
      console.log('\nPushing deals to D1...');
      await pushToD1(deals, 'lululemon');
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
