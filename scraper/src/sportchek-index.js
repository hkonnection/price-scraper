/**
 * Sport Chek scraper entry point.
 * Fetches sale and clearance deals and pushes them to Cloudflare D1.
 */

import { scrapeSportchek } from './scrapers/sportchek.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Runs the Sport Chek scrape and either prints or stores the deals.
 *
 * @returns {Promise<void>}
 */
async function main() {
  console.log('Starting Sport Chek scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    console.log('\nFetching sale and clearance deals from sportchek.ca...');
    const { deals: rawDeals } = await scrapeSportchek();
    console.log(`Found ${rawDeals.length} deals`);

    const cleaner = await getCleaner('sportchek');
    const deals = cleaner.clean(rawDeals);

    if (deals.length === 0) {
      console.log('No deals found. Exiting.');
      return;
    }

    console.log('\nSample deals:');
    deals.slice(0, 5).forEach(deal => {
      console.log(`  - ${deal.product_name} (${deal.brand}): $${deal.sale_price.toFixed(2)} (was $${deal.regular_price.toFixed(2)}, save ${deal.savings_percent}%)`);
    });

    const brands = {};
    deals.forEach(deal => {
      brands[deal.brand] = (brands[deal.brand] || 0) + 1;
    });
    console.log('\nBrand breakdown:');
    Object.entries(brands)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([brand, count]) => {
        console.log(`  - ${brand}: ${count}`);
      });

    const promos = {};
    deals.forEach(deal => {
      promos[deal.promo_type] = (promos[deal.promo_type] || 0) + 1;
    });
    console.log('\nPromo breakdown:');
    Object.entries(promos).forEach(([promo, count]) => {
      console.log(`  - ${promo}: ${count}`);
    });

    const percents = deals.map(deal => deal.savings_percent);
    const avgSavings = (percents.reduce((sum, value) => sum + value, 0) / percents.length).toFixed(2);
    const maxSavings = Math.max(...percents).toFixed(2);
    console.log(`\nSavings range: avg ${avgSavings}%, max ${maxSavings}%`);

    if (DRY_RUN) {
      console.log('\nDry run complete. No data pushed to D1.');
      console.log(`Would have pushed ${deals.length} deals.`);
    } else {
      console.log('\nPushing deals to D1...');
      await pushToD1(deals, 'sportchek', null);
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
