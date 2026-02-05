/**
 * Nike Canada data cleaner.
 * Normalizes deals scraped from Nike.com/ca sale section.
 *
 * @param {Array<object>} deals - Deals from Nike scraper
 * @returns {Array<object>} Normalized deals with promo_type set
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    brand: deal.brand || 'Nike',
    promo_type: 'Sale',
  }));
}
