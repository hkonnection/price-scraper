/**
 * Gourmet Warehouse Scraper Entry Point
 * Auto-discovers sale pages and fetches deals from gourmetwarehouse.ca, then pushes to Cloudflare D1.
 */

import { scrapeGourmetwarehouse } from './scrapers/gourmetwarehouse.js';
import { pushToD1 } from './db/d1.js';
import { getCleaner } from './cleaners/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('Starting Gourmet Warehouse scraper...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no database writes)' : 'LIVE'}`);

  try {
    // Scrape deals from Gourmet Warehouse
    console.log('\nDiscovering and scraping deals from Gourmet Warehouse...');
    const { deals: rawDeals, totalProducts, salePages } = await scrapeGourmetwarehouse();
    console.log(`Found ${rawDeals.length} deals across ${salePages.length} sale pages`);

    // Clean deals with Gourmet Warehouse-specific cleaner
    const cleaner = await getCleaner('gourmetwarehouse');
    const deals = cleaner.clean(rawDeals);

    if (deals.length === 0) {
      console.log('No deals found. Exiting.');
      return;
    }

    // Show sample of deals
    console.log('\nSample deals:');
    deals.slice(0, 5).forEach(deal => {
      console.log(`  - ${deal.product_name} (${deal.brand}): $${deal.sale_price} (${deal.savings_percent}% off)`);
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

    // Show sale page breakdown
    console.log('\nSale pages scraped:');
    salePages.forEach(sp => {
      console.log(`  - ${sp.title}: ${sp.productCount} products`);
    });

    if (DRY_RUN) {
      console.log('\nDry run complete. No data pushed to D1.');
      console.log(`Would have pushed ${deals.length} deals.`);
    } else {
      // Push to D1
      console.log('\nPushing deals to D1...');
      await pushToD1(deals, 'gourmetwarehouse', null);
      console.log('Done!');
    }
  } catch (error) {
    console.error('Scraper failed:', error);
    process.exit(1);
  }
}

main();
