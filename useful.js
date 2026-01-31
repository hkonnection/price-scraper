/**
 * Useful JavaScript Snippets
 * Browser console scripts and utilities for manual data extraction.
 */

// =============================================================================
// CARTER'S OSHKOSH CANADA - Product Extraction
// =============================================================================
// URL: https://www.cartersoshkosh.ca/en_CA/carters-deals?sz=2000
// Note: Site caps at 2000 DOM elements. If "Show More" button appears, click it
//       to load remaining products before running this script.
// -----------------------------------------------------------------------------

const cartersExtract = () => {
  const products = [];
  document.querySelectorAll('.product[data-pid]').forEach(tile => {
    const pid = tile.dataset.pid || '';
    const brand = tile.querySelector('.product-tile-brand')?.textContent?.trim() || '';
    const name = tile.querySelector('.product-tile-title')?.textContent?.trim() || '';
    const salePrice = tile.querySelector('.product-tile-price-sale .value')?.getAttribute('content') || '';
    const origPrice = tile.querySelector('.product-tile-price-original .value')?.getAttribute('content') || '';
    const discount = tile.querySelector('.discount')?.textContent?.trim() || '';
    const image = tile.querySelector('.tile-image')?.src || '';
    const promo = tile.querySelector('.promotion-callout-text')?.textContent?.trim() || '';
    const productUrl = tile.querySelector('a[itemprop="url"]')?.href || '';
    if (name) {
      products.push({
        product_code: pid,
        brand,
        product_name: name,
        sale_price: parseFloat(salePrice) || 0,
        regular_price: parseFloat(origPrice) || 0,
        discount,
        promo,
        image_url: image,
        product_url: productUrl
      });
    }
  });

  // Download as JSON file
  const blob = new Blob([JSON.stringify(products, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `carters-deals-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);

  console.log(`✅ Downloaded ${products.length} products`);
  return products;
};

// Run: cartersExtract()
