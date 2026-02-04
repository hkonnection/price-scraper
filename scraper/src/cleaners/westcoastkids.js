/**
 * West Coast Kids data cleaner.
 * Normalizes deals scraped from westcoastkids.ca.
 * Adds promo_type field for multi-retailer support.
 *
 * @param {Array<object>} deals - Deals from West Coast Kids scraper
 * @returns {Array<object>} Normalized deals
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    promo_type: 'Sale',
    // Ensure brand is set (fallback to retailer name if missing)
    brand: deal.brand || 'West Coast Kids',
  }));
}
