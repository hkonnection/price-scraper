/**
 * lululemon Canada data cleaner.
 * Normalizes deals scraped from shop.lululemon.com WMTM section.
 *
 * @param {Array<object>} deals - Deals from lululemon scraper
 * @returns {Array<object>} Normalized deals
 */
export function clean(deals) {
  return deals.map((deal) => ({
    ...deal,
    promo_type: 'We Made Too Much',
    brand: 'lululemon',
  }));
}
