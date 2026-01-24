/**
 * Cloudflare D1 Database Operations
 * Uses Cloudflare API to write deals to D1
 */

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

/**
 * Gets retailer ID by slug.
 * @param {string} slug - Retailer slug (e.g., 'costco')
 * @returns {Promise<number>} Retailer ID
 */
export async function getRetailerId(slug) {
  const result = await queryD1(`SELECT id FROM retailers WHERE slug = '${slug}'`);

  if (!result.results || result.results.length === 0) {
    throw new Error(`Retailer not found: ${slug}`);
  }

  return result.results[0].id;
}

/**
 * Pushes deals to Cloudflare D1.
 * @param {Array<Deal>} deals - Array of deal objects
 * @param {string} retailerSlug - Retailer slug (e.g., 'costco')
 */
export async function pushToD1(deals, retailerSlug = 'costco') {
  // Get retailer ID
  const retailerId = await getRetailerId(retailerSlug);
  console.log(`Retailer ID for ${retailerSlug}: ${retailerId}`);

  // Clear existing deals for this retailer and insert new ones
  const deleteSQL = `DELETE FROM deals WHERE retailer_id = ${retailerId};`;

  const insertStatements = deals.map(deal => `
    INSERT INTO deals (retailer_id, product_code, product_name, regular_price, sale_price, savings_amount, savings_percent, category, image_url, scraped_at)
    VALUES (
      ${retailerId},
      '${escapeSql(deal.product_code || '')}',
      '${escapeSql(deal.product_name)}',
      ${deal.regular_price},
      ${deal.sale_price},
      ${deal.savings_amount},
      ${deal.savings_percent},
      '${escapeSql(deal.category)}',
      '${escapeSql(deal.image_url || '')}',
      '${deal.scraped_at}'
    );
  `).join('\n');

  await queryD1(deleteSQL);
  await queryD1(insertStatements);

  console.log(`Successfully pushed ${deals.length} deals for ${retailerSlug}`);
}

/**
 * Executes a SQL query against D1.
 * @param {string} sql - SQL query
 * @returns {Promise<object>} Query result
 */
async function queryD1(sql) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;

  if (!accountId || !apiToken || !databaseId) {
    throw new Error(
      'Missing environment variables. Required: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID'
    );
  }

  const response = await fetch(
    `${CLOUDFLARE_API_URL}/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`D1 API error: ${response.status} - ${error}`);
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(result.errors)}`);
  }

  return result.result[0] || {};
}

/**
 * Escapes single quotes for SQL.
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeSql(str) {
  if (!str) return '';
  return str.replace(/'/g, "''");
}
