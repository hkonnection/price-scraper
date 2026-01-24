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
 * Gets source ID by retailer ID.
 * @param {number} retailerId - Retailer ID
 * @returns {Promise<number>} Source ID
 */
async function getSourceId(retailerId) {
  const result = await queryD1(`SELECT id FROM scrape_sources WHERE retailer_id = ${retailerId} LIMIT 1`);
  return result.results?.[0]?.id || null;
}

/**
 * Creates a scrape history record.
 * @param {number} sourceId - Source ID
 * @param {string|null} flyerDates - Flyer date range (e.g., "January 19-25, 2026")
 * @returns {Promise<number>} Scrape history ID
 */
async function createScrapeHistory(sourceId, flyerDates = null) {
  const startedAt = new Date().toISOString();
  const flyerDatesPart = flyerDates ? `'${escapeSql(flyerDates)}'` : 'NULL';
  await queryD1(`
    INSERT INTO scrape_history (source_id, started_at, status, flyer_dates)
    VALUES (${sourceId}, '${startedAt}', 'running', ${flyerDatesPart})
  `);

  // Get the ID of the record we just created
  const result = await queryD1(`SELECT MAX(id) as id FROM scrape_history WHERE source_id = ${sourceId}`);
  return result.results[0].id;
}

/**
 * Updates scrape history with completion status.
 * @param {number} scrapeId - Scrape history ID
 * @param {string} status - Status ('completed' or 'failed')
 * @param {number} dealsCount - Number of deals scraped
 * @param {string} errorMessage - Error message if failed
 */
async function updateScrapeHistory(scrapeId, status, dealsCount = 0, errorMessage = null) {
  const completedAt = new Date().toISOString();
  const errorPart = errorMessage ? `error_message = '${escapeSql(errorMessage)}',` : '';
  await queryD1(`
    UPDATE scrape_history
    SET status = '${status}',
        ${errorPart}
        deals_count = ${dealsCount},
        completed_at = '${completedAt}'
    WHERE id = ${scrapeId}
  `);
}

/**
 * Pushes deals to Cloudflare D1.
 * @param {Array<Deal>} deals - Array of deal objects
 * @param {string} retailerSlug - Retailer slug (e.g., 'costco')
 * @param {string|null} flyerDates - Flyer date range (e.g., "January 19-25, 2026")
 */
export async function pushToD1(deals, retailerSlug = 'costco', flyerDates = null) {
  // Get retailer ID
  const retailerId = await getRetailerId(retailerSlug);
  console.log(`Retailer ID for ${retailerSlug}: ${retailerId}`);

  // Get source ID and create scrape history record
  const sourceId = await getSourceId(retailerId);
  const scrapeId = await createScrapeHistory(sourceId || 1, flyerDates);
  console.log(`Created scrape history record: ${scrapeId}`);

  try {
    // Clear existing deals for this retailer
    const deleteSQL = `DELETE FROM deals WHERE retailer_id = ${retailerId};`;
    await queryD1(deleteSQL);

    // Insert new deals with scrape_id
    const insertStatements = deals.map(deal => `
      INSERT INTO deals (retailer_id, scrape_id, product_code, product_name, regular_price, sale_price, savings_amount, savings_percent, category, image_url, scraped_at)
      VALUES (
        ${retailerId},
        ${scrapeId},
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

    await queryD1(insertStatements);

    // Mark scrape as completed
    await updateScrapeHistory(scrapeId, 'completed', deals.length);
    console.log(`Successfully pushed ${deals.length} deals for ${retailerSlug} (scrape_id: ${scrapeId})`);
  } catch (error) {
    // Mark scrape as failed
    await updateScrapeHistory(scrapeId, 'failed', 0, error.message);
    throw error;
  }
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
