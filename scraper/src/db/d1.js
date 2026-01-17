/**
 * Cloudflare D1 Database Operations
 * Uses Cloudflare API to write deals to D1
 */

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

/**
 * Pushes deals to Cloudflare D1
 * @param {Array<Deal>} deals - Array of deal objects
 */
export async function pushToD1(deals) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;

  if (!accountId || !apiToken || !databaseId) {
    throw new Error(
      'Missing environment variables. Required: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID'
    );
  }

  // Clear existing deals and insert new ones
  const sql = `
    DELETE FROM deals WHERE source = 'cocowest';

    ${deals.map(deal => `
      INSERT INTO deals (product_name, regular_price, sale_price, savings_amount, savings_percent, category, source, scraped_at)
      VALUES (
        '${escapeSql(deal.product_name)}',
        ${deal.regular_price},
        ${deal.sale_price},
        ${deal.savings_amount},
        ${deal.savings_percent},
        '${escapeSql(deal.category)}',
        '${escapeSql(deal.source)}',
        '${deal.scraped_at}'
      );
    `).join('\n')}
  `;

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

  console.log(`Successfully pushed ${deals.length} deals to D1`);
}

/**
 * Escapes single quotes for SQL
 * @param {string} str
 * @returns {string}
 */
function escapeSql(str) {
  return str.replace(/'/g, "''");
}
