/**
 * Costco data cleaner.
 * Normalizes deals already parsed by the Cocowest scraper.
 * Adds brand and promo_type fields for multi-retailer support.
 *
 * @param {Array<object>} deals - Deals from Cocowest scraper
 * @returns {Array<object>} Deals with brand and promo_type added
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    brand: /kirkland/i.test(deal.product_name) ? 'Kirkland Signature' : 'Costco',
    promo_type: 'Instant Savings',
  }));
}
