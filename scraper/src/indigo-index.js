/**
 * Indigo Canada Scraper Entry Point
 * Fetches markdown deals from indigo.ca Sale & Clearance and pushes to Cloudflare D1.
 */

import { scrapeIndigo } from './scrapers/indigo.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('Starting Indigo Canada scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    // Scrape deals from Indigo
    console.log('\nFetching markdown deals from Indigo Sale & Clearance...');
    const { deals: rawDeals, totalProducts, totalPages } = await scrapeIndigo();
    console.log(`Found ${rawDeals.length} markdown deals across ${totalPages} pages`);

    // Clean deals with Indigo-specific cleaner
    const cleaner = await getCleaner('indigo');
    const deals = cleaner.clean(rawDeals);

    if (deals.length === 0) {
      console.log('No deals found. Exiting.');
      return;
    }

    // Show sample of deals
    console.log('\nSample deals:');
    deals.slice(0, 5).forEach(deal => {
      console.log(`  - ${deal.product_name} (${deal.brand}): $${deal.sale_price.toFixed(2)} (was $${deal.regular_price.toFixed(2)}, save ${deal.savings_percent}%)`);
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

    // Price range summary
    const prices = deals.map(d => d.savings_percent);
    const avgSavings = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(1);
    const maxSavings = Math.max(...prices).toFixed(1);
    console.log(`\nSavings range: avg ${avgSavings}%, max ${maxSavings}%`);

    if (DRY_RUN) {
      console.log('\nDry run complete. No data pushed to D1.');
      console.log(`Would have pushed ${deals.length} deals.`);
    } else {
      // Push to D1
      console.log('\nPushing deals to D1...');
      await pushToD1(deals, 'indigo', null);
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
