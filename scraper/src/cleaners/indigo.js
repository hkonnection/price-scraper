/**
 * Indigo Canada data cleaner.
 * Normalizes deals scraped from indigo.ca Sale & Clearance section.
 *
 * @param {Array<object>} deals - Deals from Indigo scraper
 * @returns {Array<object>} Normalized deals
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    promo_type: 'Sale & Clearance',
    brand: deal.brand || 'Indigo',
  }));
}
