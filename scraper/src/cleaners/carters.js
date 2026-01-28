/**
 * Carter's Oshkosh data cleaner.
 * Normalizes raw JSON extracted from cartersoshkosh.ca browser console.
 *
 * Expected input format per item:
 *   { product_code, brand, product_name, sale_price, regular_price, discount, image_url }
 *
 * @param {Array<object>} rawDeals - Raw deal objects from browser extraction
 * @returns {Array<object>} Cleaned deals ready for D1 insertion
 */
export function clean(rawDeals) {
  return rawDeals.map(product => {
    // Extract numeric discount percentage from text like "Percent of discount\n\n69% off"
    let savingsPercent = 0;
    if (product.discount) {
      const match = product.discount.match(/(\d+)%/);
      if (match) {
        savingsPercent = parseInt(match[1], 10);
      }
    }

    const regularPrice = parseFloat(product.regular_price) || 0;
    const salePrice = parseFloat(product.sale_price) || 0;
    const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;

    // Recalculate percent if not parsed from text
    if (!savingsPercent && regularPrice > 0) {
      savingsPercent = Math.round((savingsAmount / regularPrice) * 100);
    }

    return {
      product_code: product.product_code || '',
      product_name: product.product_name || '',
      brand: product.brand || '',
      regular_price: regularPrice,
      sale_price: salePrice,
      savings_amount: savingsAmount,
      savings_percent: savingsPercent,
      category: product.promo || 'Clearance',
      promo_type: product.promo || 'Clearance',
      image_url: product.image_url || null,
      valid_from: new Date().toISOString().split('T')[0],
      valid_to: null,
      scraped_at: new Date().toISOString(),
    };
  });
}
