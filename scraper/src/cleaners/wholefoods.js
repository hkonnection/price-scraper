/**
 * Whole Foods Market Canada data cleaner.
 * Normalizes deals scraped from wholefoodsmarket.com sales flyer.
 *
 * @param {Array<object>} deals - Deals from Whole Foods scraper
 * @returns {Array<object>} Normalized deals
 */
export function clean(deals) {
  return deals.map(deal => ({
    ...deal,
    promo_type: 'Weekly Sale',
    // Ensure brand is set (fallback if missing)
    brand: deal.brand || 'Whole Foods Market',
  }));
}
