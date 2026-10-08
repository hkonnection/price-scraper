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
  in_stock: number;
  retailer_slug: string;
  retailer_name: string;
}

// Mock data for local development
const MOCK_RETAILERS: Retailer[] = [
  { id: 1, name: 'Costco West', slug: 'costco', scrape_source: 'scraper' },
  { id: 2, name: "Carter's Oshkosh", slug: 'carters', scrape_source: 'manual' },
];

const MOCK_DEALS: Deal[] = [
  { id: 1, product_code: '1627198', product_name: 'DURACELL POWER BOOST AAA BATTERIES PACK OF 40', brand: 'Costco', regular_price: 25.99, sale_price: 19.99, savings_amount: 6, savings_percent: 23.1, category: 'Other', promo_type: 'Instant Savings', image_url: null, product_url: null, scraped_at: new Date().toISOString(), in_stock: 1, retailer_slug: 'costco', retailer_name: 'Costco West' },
  { id: 2, product_code: '2945480', product_name: 'MONDETTA CORDUROY PANT WOMENS SIZES XL-XXL', brand: 'Costco', regular_price: 17.99, sale_price: 7.99, savings_amount: 10, savings_percent: 55.6, category: 'Other', promo_type: 'Instant Savings', image_url: null, product_url: null, scraped_at: new Date().toISOString(), in_stock: 1, retailer_slug: 'costco', retailer_name: 'Costco West' },
];

/**
 * Fetches active retailers and current deals from D1.
 * When a specific retailer is selected, fetches only that retailer's deals (no LIMIT).
 * Reads only the newest completed publication per retailer, plus legacy unversioned rows.
 * For "all" view, applies LIMIT 2000 to stay within Worker resource limits.
 * Falls back to mock data for local development.
 *
 * @param {string} retailerSlug - Retailer slug to filter by, or 'all' for all retailers
 * @returns {Promise<{ deals: Deal[], retailers: Retailer[], retailerDates: Record<string, string>, flyerDates: string | null }>}
 */
async function getData(retailerSlug: string): Promise<{
  deals: Deal[];
  retailers: Retailer[];
  retailerDates: Record<string, string>;
  flyerDates: string | null;
}> {
  try {
    const { env } = getRequestContext();
    const db = env.DB;

    if (!db) {
      console.log('D1 not bound - using mock data for local preview');
      return {
        deals: MOCK_DEALS,
        retailers: MOCK_RETAILERS,
        retailerDates: { costco: new Date().toISOString(), carters: new Date().toISOString() },
        flyerDates: 'January 19-25, 2026',
      };
    }

    // Get active retailers
    const retailersResult = await db
      .prepare('SELECT id, name, slug, scrape_source FROM retailers WHERE is_active = 1 ORDER BY name')
      .all<Retailer>();
    const retailers = retailersResult.results || [];

    // Small source configuration read; avoid a history-table join that SQLite
    // can reorder into a full history scan for every retailer.
    const sourcesResult = await db.prepare(`
      SELECT ss.id, ss.retailer_id
      FROM scrape_sources ss
      JOIN retailers r ON ss.retailer_id = r.id
      WHERE r.is_active = 1
    `).all<{ id: number; retailer_id: number }>();
    const sources = sourcesResult.results || [];

    // One bounded result per active retailer, constrained by indexed source ids.
    // Keep displayed rows and timestamp tied to the same completed publication.
    const retailerDates: Record<string, string> = {};
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
      `).bind(...sourceIds).first<{ scrape_id: number; completed_at: string }>();
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
    const today = new Date().toISOString().split('T')[0];
    const isAllRetailers = retailerSlug === 'all';

    const dealsQuery = isAllRetailers
      ? db.prepare(`
          SELECT d.id, d.product_code, d.product_name, d.brand, d.regular_price, d.sale_price,
                 d.savings_amount, d.savings_percent, d.category, d.promo_type, d.image_url,
                 d.product_url, d.scraped_at, COALESCE(d.in_stock, 1) as in_stock,
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
                 d.product_url, d.scraped_at, COALESCE(d.in_stock, 1) as in_stock,
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

    return {
      deals: dealsResult.results || [],
      retailers,
      retailerDates,
      flyerDates,
    };
  } catch (error) {
    console.log('D1 error - using mock data:', error);
    return {
      deals: MOCK_DEALS,
      retailers: MOCK_RETAILERS,
      retailerDates: { costco: new Date().toISOString(), carters: new Date().toISOString() },
      flyerDates: 'January 19-25, 2026',
    };
  }
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ retailer?: string }>;
}) {
  const params = await searchParams;
  const retailerSlug = params.retailer || 'costco';
  const { deals, retailers, retailerDates, flyerDates } = await getData(retailerSlug);

  return (
    <main className="container">
      <DealsPageClient
        deals={deals}
        retailers={retailers}
        retailerDates={retailerDates}
        flyerDates={flyerDates}
      />
    </main>
  );
}
