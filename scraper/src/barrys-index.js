/**
 * Barry's Scraper Entry Point
 * Fetches sale deals from shop.barrys.com and pushes to Cloudflare D1.
 */

import { scrapeBarrys } from './scrapers/barrys.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log("Starting Barry's scraper...");
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    // Scrape deals from Barry's
    console.log('\nFetching sale deals from shop.barrys.com...');
    const { deals: rawDeals, totalProducts } = await scrapeBarrys();
    console.log(`Found ${rawDeals.length} deals`);

    // Clean deals with Barry's-specific cleaner
    const cleaner = await getCleaner('barrys');
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

    // Show brand breakdown
    const brands = {};
    deals.forEach(deal => {
      brands[deal.brand] = (brands[deal.brand] || 0) + 1;
    });
    console.log('\nBrand breakdown:');
    Object.entries(brands)
      .sort((a, b) => b[1] - a[1])
      .forEach(([brand, count]) => {
        console.log(`  - ${brand}: ${count}`);
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
      await pushToD1(deals, 'barrys', null);
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
