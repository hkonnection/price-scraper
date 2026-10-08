import { getRequestContext } from '@cloudflare/next-on-pages';
import DealsPageClient, { type Deal, type Retailer } from './components/DealsPageClient';

export const runtime = 'edge';

interface DealRow {
  id: number;
  product_code: string;
  product_name: string;
  brand: string | null;
  regular_price: number;
  sale_price: number;
  savings_amount: number;
  savings_percent: number;
  category: string;
  promo_type: string | null;
  image_url: string | null;
  product_url: string | null;
  scraped_at: string;
  scrape_id: number | null;
  in_stock: number;
  retailer_slug: string;
  retailer_name: string;
}

/**
 * Reject an explicitly failed database result, even when the binding did not throw.
 * @param result - D1 result with runtime success metadata.
 * @returns Nothing on success.
 * @throws Error if the database reports failure.
 */
function requireSuccessfulRead(result: { success?: boolean }): void {
  if (result.success === false) throw new Error('Database read failed');
}

/**
 * Fetches active retailers and current deals from D1.
 * When a specific retailer is selected, fetches only that retailer's deals (no LIMIT).
 * Reads only the newest completed publication per retailer, plus legacy unversioned rows.
 * For "all" view, applies LIMIT 2000 to stay within Worker resource limits.
 * Returns a safe loading error if a binding or database read fails.
 *
 * @param {string} retailerSlug - Retailer slug to filter by, or 'all' for all retailers
 * @returns Published rows, per-store metadata, and a safe error on read failure.
 */
async function getData(retailerSlug: string): Promise<{
  deals: Deal[];
  retailers: Retailer[];
  retailerDates: Record<string, string | null>;
  retailerPaused: Record<string, boolean>;
  evaluatedAt: string;
  flyerDates: string | null;
  error: string | null;
}> {
  const evaluatedAt = new Date().toISOString();
  try {
    const { env } = getRequestContext();
    const db = env.DB;

    if (!db) throw new Error('Database unavailable');

    // Get active retailers
    const retailersResult = await db
      .prepare('SELECT id, name, slug, scrape_source FROM retailers WHERE is_active = 1 ORDER BY name')
      .all<Retailer>();
    requireSuccessfulRead(retailersResult);
    const retailers = retailersResult.results || [];

    // Small source configuration read; avoid a history-table join that SQLite
    // can reorder into a full history scan for every retailer.
    const sourcesResult = await db.prepare(`
      SELECT ss.id, ss.retailer_id, ss.is_active
      FROM scrape_sources ss
      JOIN retailers r ON ss.retailer_id = r.id
      WHERE r.is_active = 1
    `).all<{ id: number; retailer_id: number; is_active: number }>();
    requireSuccessfulRead(sourcesResult);
    const sources = sourcesResult.results || [];
    const retailerPaused: Record<string, boolean> = {};
    for (const retailer of retailers) {
      const retailerSources = sources.filter(source => source.retailer_id === retailer.id);
      retailerPaused[retailer.slug] = retailerSources.length > 0 && retailerSources.every(source => source.is_active === 0);
    }

    // One bounded result per active retailer, constrained by indexed source ids.
    // Keep displayed rows and timestamp tied to the same completed publication.
    const retailerDates: Record<string, string | null> = {};
    const latestSnapshots: Array<{ retailerId: number; scrapeId: number }> = [];
    for (const retailer of retailers) {
      const sourceIds = sources.filter(source => source.retailer_id === retailer.id).map(source => source.id);
      if (sourceIds.length === 0) continue;
      const latest = await db.prepare(`
        SELECT sh.id as scrape_id, sh.completed_at
        FROM scrape_history sh
        WHERE sh.status = 'completed' AND sh.source_id IN (${sourceIds.map(() => '?').join(',')})
        ORDER BY sh.completed_at DESC, sh.id DESC
        LIMIT 1
      `).bind(...sourceIds).first<{ scrape_id: number; completed_at: string | null }>();
      if (!latest) continue;
      retailerDates[retailer.slug] = latest.completed_at;
      latestSnapshots.push({ retailerId: retailer.id, scrapeId: latest.scrape_id });
    }
    // Pair retailer and history ids: a mislinked row must not qualify through
    // another retailer's completed snapshot. Before a first scrape, keep legacy rows.
    const snapshotFilter = `AND (d.scrape_id IS NULL OR ${latestSnapshots.map(() => '(d.retailer_id = ? AND d.scrape_id = ?)').join(' OR ') || '0'})`;
    const snapshotParams = latestSnapshots.flatMap(snapshot => [snapshot.retailerId, snapshot.scrapeId]);

    // Get Costco flyer dates separately (simple single-row query)
    const flyerResult = await db
      .prepare(`
        SELECT sh.flyer_dates
        FROM scrape_history sh
        JOIN scrape_sources ss ON sh.source_id = ss.id
        JOIN retailers r ON ss.retailer_id = r.id
        WHERE sh.status = 'completed' AND r.slug = 'costco'
        ORDER BY sh.id DESC LIMIT 1
      `)
      .first<{ flyer_dates: string | null }>();

    const flyerDates = flyerResult?.flyer_dates || null;

    // Get current deals with retailer info
    // When a specific retailer is selected, filter server-side (no LIMIT needed)
    // For "all" view, apply LIMIT 2000 to stay within Worker resource limits
    const today = evaluatedAt.split('T')[0];
    const isAllRetailers = retailerSlug === 'all';

    const dealsQuery = isAllRetailers
      ? db.prepare(`
          SELECT d.id, d.product_code, d.product_name, d.brand, d.regular_price, d.sale_price,
                 d.savings_amount, d.savings_percent, d.category, d.promo_type, d.image_url,
                 d.product_url, d.scraped_at, d.scrape_id, COALESCE(d.in_stock, 1) as in_stock,
                 r.slug as retailer_slug, r.name as retailer_name
          FROM deals d
          JOIN retailers r ON d.retailer_id = r.id
          WHERE r.is_active = 1
            AND (d.valid_from IS NULL OR d.valid_from <= ?)
            AND (d.valid_to IS NULL OR d.valid_to >= ?)
            AND d.regular_price > 0
            AND d.savings_percent > 0
            AND COALESCE(d.in_stock, 1) = 1
          ${snapshotFilter}
          ORDER BY d.savings_percent DESC
          LIMIT 2000
        `).bind(today, today, ...snapshotParams)
      : db.prepare(`
          SELECT d.id, d.product_code, d.product_name, d.brand, d.regular_price, d.sale_price,
                 d.savings_amount, d.savings_percent, d.category, d.promo_type, d.image_url,
                 d.product_url, d.scraped_at, d.scrape_id, COALESCE(d.in_stock, 1) as in_stock,
                 r.slug as retailer_slug, r.name as retailer_name
          FROM deals d
          JOIN retailers r ON d.retailer_id = r.id
          WHERE r.is_active = 1
            AND r.slug = ?
            AND (d.valid_from IS NULL OR d.valid_from <= ?)
            AND (d.valid_to IS NULL OR d.valid_to >= ?)
            AND d.regular_price > 0
            AND d.savings_percent > 0
            AND COALESCE(d.in_stock, 1) = 1
          ${snapshotFilter}
          ORDER BY d.savings_percent DESC
        `).bind(retailerSlug, today, today, ...snapshotParams);

    const dealsResult = await dealsQuery.all<DealRow>();

    requireSuccessfulRead(dealsResult);
    return {
      deals: (dealsResult.results || []).map(row => ({
        ...row,
        published_at: row.scrape_id === null ? null : retailerDates[row.retailer_slug] || null,
      })),
      retailers,
      retailerDates,
      retailerPaused,
      evaluatedAt,
      flyerDates,
      error: null,
    };
  } catch {
    // Do not expose database errors or replace failed reads with demo products.
    console.error('Deals database read failed');
    return {
      deals: [],
      retailers: [],
      retailerDates: {},
      retailerPaused: {},
      evaluatedAt,
      flyerDates: null,
      error: 'Deals could not be loaded. Please try again later.',
    };
  }
}

/** Render published deals or a safe, visible database loading error. */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ retailer?: string }>;
}) {
  const params = await searchParams;
  const retailerSlug = params.retailer || 'costco';
  const { deals, retailers, retailerDates, retailerPaused, evaluatedAt, flyerDates, error } = await getData(retailerSlug);

  if (error) {
    return (
      <main className="container">
        <header><h1>Deals</h1></header>
        <div className="empty-state" role="alert">
          <p>{error}</p>
          <p>Saved prices have not been replaced. Reload this page to try again.</p>
          <a href="https://github.com/hkonnection/price-scraper/actions">Actions run history</a>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <DealsPageClient
        deals={deals}
        retailers={retailers}
        retailerDates={retailerDates}
        retailerPaused={retailerPaused}
        evaluatedAt={evaluatedAt}
        flyerDates={flyerDates}
      />
    </main>
  );
}
