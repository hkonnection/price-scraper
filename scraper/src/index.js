/**
 * Costco West Scraper
 * Fetches deals from Cocowest.ca and pushes to Cloudflare D1
 */

import { scrapeCocowest } from './scrapers/cocowest.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('Starting Costco West scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    // Scrape deals from Cocowest
    console.log('\nFetching deals from Cocowest...');
    const { deals: rawDeals, flyerDates } = await scrapeCocowest();
    console.log(`Found ${rawDeals.length} deals`);

    // Clean deals with Costco-specific cleaner (adds brand, promo_type)
    const costcoCleaner = await getCleaner('costco');
    const deals = costcoCleaner.clean(rawDeals);
    if (flyerDates) {
      console.log(`Flyer valid: ${flyerDates}`);
    }

    if (deals.length === 0) {
      console.log('No deals found. Exiting.');
      return;
    }

    // Show sample of deals
    console.log('\nSample deals:');
    deals.slice(0, 5).forEach(deal => {
      console.log(`  - ${deal.product_name}: $${deal.sale_price} (${deal.savings_percent}% off)`);
    });

    if (DRY_RUN) {
      console.log('\nDry run complete. No data pushed to D1.');
      console.log(`Would have pushed ${deals.length} deals.`);
    } else {
      // Push to D1
      console.log('\nPushing deals to D1...');
      await pushToD1(deals, 'costco', flyerDates);
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
