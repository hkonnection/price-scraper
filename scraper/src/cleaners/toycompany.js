/**
 * Granville Island Toy Company data cleaner.
 * Normalizes deals scraped from toycompany.com.
 *
 * @param {Array<object>} deals - Deals from Toy Company scraper
 * @returns {Array<object>} Normalized deals
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    promo_type: '50% Off Sale',
    // Ensure brand is set (fallback if missing)
    brand: deal.brand || 'Granville Island Toy Company',
  }));
}
