/**
 * Toys R Us / Babies R Us Canada Scraper Entry Point
 * Fetches deals from toysrus.ca and babiesrus.ca, pushes to Cloudflare D1
 */

import { scrapeToysRUs } from './scrapers/toysrus.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_PRODUCTS = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

async function main() {
  console.log('Starting Toys R Us / Babies R Us Canada scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);
  if (MAX_PRODUCTS < Infinity) {
    console.log(`Product limit per retailer: ${MAX_PRODUCTS}`);
  }

  try {
    // Scrape deals from both retailers
    console.log('\nFetching deals...');
    const { retailers } = await scrapeToysRUs({
      headless: true,
      maxProducts: MAX_PRODUCTS,
    });

    // Get the cleaner (same cleaner works for both)
    const cleaner = await getCleaner('toysrus');

    // Process each retailer
    for (const retailer of retailers) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`Processing ${retailer.name}: ${retailer.deals.length} deals`);
      console.log(`${'='.repeat(50)}`);

      if (retailer.deals.length === 0) {
        console.log(`No deals found for ${retailer.name}. Skipping.`);
        continue;
      }

      // Clean the deals
      const deals = cleaner.clean(retailer.deals);

      // Show sample
      console.log('\nSample deals:');
      deals.slice(0, 3).forEach(deal => {
        console.log(`  - ${deal.product_name}: $${deal.sale_price} (${deal.savings_percent}% off)`);
      });

      // Show savings distribution
      const savingsRanges = {
        '0-10%': deals.filter(d => d.savings_percent <= 10).length,
        '11-25%': deals.filter(d => d.savings_percent > 10 && d.savings_percent <= 25).length,
        '26-50%': deals.filter(d => d.savings_percent > 25 && d.savings_percent <= 50).length,
        '51%+': deals.filter(d => d.savings_percent > 50).length,
      };
      console.log('\nSavings distribution:');
      Object.entries(savingsRanges).forEach(([range, count]) => {
        console.log(`  ${range}: ${count} deals`);
      });

      if (DRY_RUN) {
        console.log(`\nDry run: Would push ${deals.length} deals to ${retailer.slug}`);
      } else {
        console.log(`\nPushing ${deals.length} deals to D1 for ${retailer.slug}...`);
        await pushToD1(deals, retailer.slug);
        console.log(`Done with ${retailer.name}!`);
      }
    }

    // Summary
    const totalDeals = retailers.reduce((sum, r) => sum + r.deals.length, 0);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`COMPLETE: ${totalDeals} total deals across ${retailers.length} retailers`);
    if (DRY_RUN) {
      console.log('(Dry run - no data pushed)');
    }

  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
