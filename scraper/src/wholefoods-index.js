/**
 * Whole Foods Market Canada Scraper Entry Point
 * Fetches weekly sales from wholefoodsmarket.com and pushes to Cloudflare D1
 */

import { scrapeWholefoods } from './scrapers/wholefoods.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('Starting Whole Foods Market Canada scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    // Scrape deals from Whole Foods sales flyer
    console.log('\nFetching weekly sales from Whole Foods Canada...');
    const { deals: rawDeals, totalProducts, flyerDates } = await scrapeWholefoods();
    console.log(`Found ${rawDeals.length} deals (${totalProducts} total)`);

    if (flyerDates) {
      console.log(`Flyer dates: ${flyerDates}`);
    }

    // Clean deals with Whole Foods-specific cleaner
    const cleaner = await getCleaner('wholefoods');
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

    if (DRY_RUN) {
      console.log('\nDry run complete. No data pushed to D1.');
      console.log(`Would have pushed ${deals.length} deals.`);
    } else {
      // Push to D1
      console.log('\nPushing deals to D1...');
      await pushToD1(deals, 'wholefoods', flyerDates);
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
