/**
 * Gourmet Warehouse data cleaner.
 * Normalizes deals scraped from gourmetwarehouse.ca.
 *
 * @param {Array<object>} deals - Deals from Gourmet Warehouse scraper
 * @returns {Array<object>} Normalized deals
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    promo_type: deal.sale_source || 'Sale',
    brand: deal.brand || 'Gourmet Warehouse',
  }));
}
