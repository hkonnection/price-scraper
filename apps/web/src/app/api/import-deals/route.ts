import { getRequestContext } from '@cloudflare/next-on-pages';

export const runtime = 'edge';

interface RawDeal {
  product_code?: string;
  brand?: string;
  product_name: string;
  sale_price: number;
  regular_price: number;
  discount?: string;
  promo?: string;
  image_url?: string;
  product_url?: string;
}

interface ImportRequest {
  retailer: string;
  deals: RawDeal[];
  pulledDate?: string;
}

/**
 * Cleans Carter's raw deal data into normalized format.
 * Extracts discount %, calculates savings, sets promo_type.
 *
 * @param {RawDeal[]} rawDeals - Raw deals from browser console extraction
 * @param {string} pulledDate - Date when data was pulled (YYYY-MM-DD format)
 * @returns {object[]} Cleaned deals ready for D1 insertion
 */
function cleanCartersDeals(rawDeals: RawDeal[], pulledDate: string) {
  const scrapedAt = pulledDate ? new Date(pulledDate).toISOString() : new Date().toISOString();

  return rawDeals.map(product => {
    let savingsPercent = 0;
    if (product.discount) {
      const match = product.discount.match(/(\d+)%/);
      if (match) savingsPercent = parseInt(match[1], 10);
    }

    const regularPrice = Number(product.regular_price) || 0;
    const salePrice = Number(product.sale_price) || 0;
    const savingsAmount = Math.round((regularPrice - salePrice) * 100) / 100;

    if (!savingsPercent && regularPrice > 0) {
      savingsPercent = Math.round((savingsAmount / regularPrice) * 100);
    }

    return {
      product_code: product.product_code || '',
      product_name: product.product_name || '',
      brand: product.brand || '',
      regular_price: regularPrice,
      sale_price: salePrice,
      savings_amount: savingsAmount,
      savings_percent: savingsPercent,
      category: product.promo || 'Clearance',
      promo_type: product.promo || 'Clearance',
      image_url: product.image_url || '',
      product_url: product.product_url || '',
      valid_from: new Date().toISOString().split('T')[0],
      valid_to: null as string | null,
      scraped_at: scrapedAt,
    };
  });
}

/** Map of retailer slugs to their cleaning functions. */
const cleaners: Record<string, (deals: RawDeal[], pulledDate: string) => ReturnType<typeof cleanCartersDeals>> = {
  carters: cleanCartersDeals,
};

/**
 * Escapes single quotes for SQL strings.
 *
 * @param {string} str - Input string
 * @returns {string} Escaped string
 */
function escapeSql(str: string): string {
  if (!str) return '';
  return str.replace(/'/g, "''");
}

/**
 * POST /api/import-deals
 * Imports deal data for a manual-source retailer.
 * Accepts JSON with { retailer: string, deals: array }.
 */
export async function POST(request: Request) {
  try {
    const { env } = getRequestContext();
    const db = (env as { DB?: D1Database }).DB;

    if (!db) {
      return Response.json({ error: 'Database not available' }, { status: 500 });
    }

    const body: ImportRequest = await request.json();
    const { retailer, deals, pulledDate } = body;

    // Validate retailer
    if (!retailer || typeof retailer !== 'string') {
      return Response.json({ error: 'Missing or invalid "retailer" field' }, { status: 400 });
    }

    // Validate deals array
    if (!Array.isArray(deals) || deals.length === 0) {
      return Response.json({ error: 'Missing or empty "deals" array' }, { status: 400 });
    }

    // Validate required fields on first deal as sanity check
    const sample = deals[0];
    if (!sample.product_name || sample.sale_price === undefined || sample.regular_price === undefined) {
      return Response.json({
        error: 'Deals must have product_name, sale_price, and regular_price fields',
      }, { status: 400 });
    }

    // Look up retailer
    const retailerRow = await db
      .prepare("SELECT id, scrape_source FROM retailers WHERE slug = ? AND is_active = 1")
      .bind(retailer)
      .first<{ id: number; scrape_source: string }>();

    if (!retailerRow) {
      return Response.json({ error: `Retailer "${retailer}" not found or inactive` }, { status: 404 });
    }

    if (retailerRow.scrape_source !== 'manual') {
      return Response.json({ error: `Retailer "${retailer}" does not support manual import` }, { status: 400 });
    }

    // Get cleaner
    const cleanFn = cleaners[retailer];
    if (!cleanFn) {
      return Response.json({ error: `No cleaner registered for retailer "${retailer}"` }, { status: 400 });
    }

    // Clean the deals (use pulledDate or default to today)
    const effectiveDate = pulledDate || new Date().toISOString().split('T')[0];
    const cleanedDeals = cleanFn(deals, effectiveDate);

    // Get source ID
    const sourceRow = await db
      .prepare("SELECT id FROM scrape_sources WHERE retailer_id = ? LIMIT 1")
      .bind(retailerRow.id)
      .first<{ id: number }>();

    const sourceId = sourceRow?.id || 1;

    // Create scrape history record
    const startedAt = new Date().toISOString();
    await db
      .prepare("INSERT INTO scrape_history (source_id, started_at, status, flyer_dates) VALUES (?, ?, 'running', ?)")
      .bind(sourceId, startedAt, `Manual import ${new Date().toISOString().split('T')[0]}`)
      .run();

    const scrapeRow = await db
      .prepare("SELECT MAX(id) as id FROM scrape_history WHERE source_id = ?")
      .bind(sourceId)
      .first<{ id: number }>();

    const scrapeId = scrapeRow?.id || 1;

    // Delete old deals for this retailer
    await db
      .prepare("DELETE FROM deals WHERE retailer_id = ?")
      .bind(retailerRow.id)
      .run();

    // Insert new deals in batches (D1 has statement size limits)
    const BATCH_SIZE = 50;
    for (let i = 0; i < cleanedDeals.length; i += BATCH_SIZE) {
      const batch = cleanedDeals.slice(i, i + BATCH_SIZE);
      const statements = batch.map(deal =>
        db.prepare(
          `INSERT INTO deals (retailer_id, scrape_id, product_code, product_name, brand, regular_price, sale_price, savings_amount, savings_percent, category, promo_type, image_url, product_url, valid_from, valid_to, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          retailerRow.id,
          scrapeId,
          deal.product_code,
          deal.product_name,
          deal.brand || null,
          deal.regular_price,
          deal.sale_price,
          deal.savings_amount,
          deal.savings_percent,
          deal.category,
          deal.promo_type || null,
          deal.image_url || null,
          deal.product_url || null,
          deal.valid_from || null,
          deal.valid_to || null,
          deal.scraped_at,
        )
      );
      await db.batch(statements);
    }

    // Mark scrape as completed
    await db
      .prepare("UPDATE scrape_history SET status = 'completed', deals_count = ?, completed_at = ? WHERE id = ?")
      .bind(cleanedDeals.length, new Date().toISOString(), scrapeId)
      .run();

    return Response.json({
      success: true,
      message: `Imported ${cleanedDeals.length} deals for ${retailer}`,
      count: cleanedDeals.length,
    });

  } catch (error) {
    console.error('Import error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
