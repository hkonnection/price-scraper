/**
 * Sport Chek data cleaner.
 * Normalizes deals scraped from the Sport Chek sale and clearance feeds.
 *
 * @param {Array<object>} deals - Deals from the Sport Chek scraper
 * @returns {Array<object>} Normalized deals with brand and promo type set
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    brand: deal.brand || 'Sport Chek',
    promo_type: deal.promo_type || 'Sale',
    savings_percent: Math.round(Number(deal.savings_percent) * 100) / 100,
  }));
}
