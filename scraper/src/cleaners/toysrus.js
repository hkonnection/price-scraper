/**
 * Toys R Us Canada data cleaner.
 * Normalizes raw product data from the Toys R Us scraper.
 *
 * Expected input format per item:
 *   { product_id, product_name, list_price, sale_price, brand, category, image_url, rating }
 *
 * @param {Array<object>} rawDeals - Raw deal objects from scraper
 * @returns {Array<object>} Cleaned deals ready for D1 insertion
 */
export function clean(rawDeals) {
  return rawDeals.map(product => {
    // Parse prices (remove $ and convert to float)
    const regularPrice = parsePrice(product.list_price);
    const salePrice = parsePrice(product.sale_price);

    // Calculate savings
    const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;
    const savingsPercent = regularPrice > 0
      ? Math.round((savingsAmount / regularPrice) * 100)
      : 0;

    // Extract or infer brand from product name if not provided
    const brand = product.brand || inferBrand(product.product_name);

    // Map category or use default
    const category = mapCategory(product.category);

    return {
      product_code: product.product_id || '',
      product_name: product.product_name || '',
      brand: brand,
      regular_price: regularPrice,
      sale_price: salePrice,
      savings_amount: savingsAmount,
      savings_percent: savingsPercent,
      category: category,
      promo_type: 'Sale',
      image_url: product.image_url || null,
      valid_from: new Date().toISOString().split('T')[0],
      valid_to: null,
      scraped_at: new Date().toISOString(),
    };
  });
}

/**
 * Parses a price string to a float.
 * @param {string} priceStr - Price string (e.g., "$39.99")
 * @returns {number} Parsed price
 */
function parsePrice(priceStr) {
  if (!priceStr) return 0;
  const cleaned = priceStr.replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
}

/**
 * Attempts to infer brand from product name.
 * @param {string} productName - Product name
 * @returns {string|null} Inferred brand or null
 */
function inferBrand(productName) {
  if (!productName) return null;

  // Common toy brands to look for at the start of product names
  const brands = [
    'Melissa & Doug',
    'LEGO',
    'Barbie',
    'Hot Wheels',
    'Fisher-Price',
    'Nerf',
    'Play-Doh',
    'Hasbro',
    'Mattel',
    'VTech',
    'Little Tikes',
    'Paw Patrol',
    'Disney',
    'Marvel',
    'Star Wars',
    'Pokemon',
    'Nintendo',
    'Funko',
    'Ravensburger',
    'Crayola',
  ];

  const nameLower = productName.toLowerCase();
  for (const brand of brands) {
    if (nameLower.startsWith(brand.toLowerCase()) || nameLower.includes(brand.toLowerCase())) {
      return brand;
    }
  }

  // Check if brand is at the start (pattern: "Brand - Product Name")
  const dashMatch = productName.match(/^([^-]+)\s*-\s*/);
  if (dashMatch && dashMatch[1].length < 30) {
    return dashMatch[1].trim();
  }

  return null;
}

/**
 * Maps raw category to standardized category.
 * @param {string} rawCategory - Raw category from scraper
 * @returns {string} Mapped category
 */
function mapCategory(rawCategory) {
  if (!rawCategory) return 'Toys';

  const categoryMap = {
    'action figures': 'Action Figures',
    'arts & crafts': 'Arts & Crafts',
    'baby toys': 'Baby & Toddler',
    'board games': 'Games & Puzzles',
    'building sets': 'Building Toys',
    'dolls': 'Dolls & Accessories',
    'educational': 'Educational Toys',
    'electronic toys': 'Electronics',
    'games': 'Games & Puzzles',
    'outdoor': 'Outdoor Play',
    'plush': 'Plush & Stuffed Animals',
    'pretend play': 'Pretend Play',
    'puzzles': 'Games & Puzzles',
    'ride-ons': 'Ride-Ons',
    'vehicles': 'Vehicles',
  };

  const lower = rawCategory.toLowerCase();
  for (const [key, value] of Object.entries(categoryMap)) {
    if (lower.includes(key)) {
      return value;
    }
  }

  return rawCategory;
}
