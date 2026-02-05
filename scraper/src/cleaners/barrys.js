/**
 * Barry's data cleaner.
 * Normalizes deals scraped from shop.barrys.com sale section.
 *
 * @param {Array<object>} deals - Deals from Barry's scraper
 * @returns {Array<object>} Normalized deals with promo_type set
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    promo_type: 'Sale',
    brand: deal.brand || "Barry's",
  }));
}
