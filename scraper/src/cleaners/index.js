/**
 * Cleaner registry.
 * Returns the appropriate data cleaning module for a given retailer slug.
 *
 * @param {string} retailerSlug - Retailer slug (e.g., 'carters', 'costco')
 * @returns {Promise<{ clean: Function }>} Cleaning module with a clean() function
 * @throws {Error} If no cleaner is registered for the given slug
 */
export async function getCleaner(retailerSlug) {
  const cleaners = {
    carters: () => import('./carters.js'),
    costco: () => import('./costco.js'),
  };

  const loader = cleaners[retailerSlug];
  if (!loader) {
    throw new Error(`No cleaner registered for retailer: ${retailerSlug}. Available: ${Object.keys(cleaners).join(', ')}`);
  }

  return await loader();
}
