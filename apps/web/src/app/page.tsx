import { getRequestContext } from '@cloudflare/next-on-pages';
import DealsPageClient, { type Deal, type Retailer, type Paging, type SortKey } from './components/DealsPageClient';

export const runtime = 'edge';

type Params = Record<string, string | string[] | undefined>;
interface Query {
  category: string;
  promo: string;
  sort: SortKey;
  direction: 'asc' | 'desc';
  size: number;
  offset: number;
  publications: Array<[number, number | null]> | null;
}
interface PageData extends Paging {
  deals: Deal[];
  retailers: Retailer[];
  retailerDates: Record<string, string | null>;
  retailerPaused: Record<string, boolean>;
  evaluatedAt: string;
  hasLegacyRows: boolean;
  flyerDates: string | null;
  error: string | null;
}
interface Snapshot {
  retailerId: number;
  scrapeId: number | null;
  completedAt: string | null;
}

const SORT_COLUMNS: Record<SortKey, string> = {
  product_name: 'd.product_name', category: 'd.category', retailer_name: 'r.name',
  regular_price: 'd.regular_price', sale_price: 'd.sale_price',
  savings_amount: 'd.savings_amount', savings_percent: 'd.savings_percent',
};

/** Keep caller validation errors separate from database loading errors. */
class PagingError extends Error {
  /** Preserve the error type when TypeScript targets ES5. */
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, PagingError.prototype);
  }
}

/**
 * Validate URL values before any database read. SQL names come only from the allowlist.
 * @param params - Raw URL search parameters.
 * @returns Validated filter, sort, page, and publication values.
 * @throws PagingError for invalid or unsupported options.
 */
function parseQuery(params: Params): Query {
  const supported = ['retailer', 'category', 'promo', 'sort', 'direction', 'size', 'offset', 'publication'];
  for (const key of Object.keys(params)) {
    if (!supported.includes(key)) continue;
    if (params[key] !== undefined && typeof params[key] !== 'string') throw new PagingError('Invalid repeated query value. Use one value per option.');
  }
  const single = params as Record<string, string | undefined>;
  const category = single.category ?? 'all';
  const promo = single.promo ?? 'all';
  if (!category || !promo || category.length > 100 || promo.length > 100) throw new PagingError('Invalid filter value.');
  const sort = single.sort ?? 'savings_percent';
  if (!Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sort)) throw new PagingError('Unsupported sort option.');
  const direction = single.direction ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') throw new PagingError('Unsupported sort direction.');
  const sizeText = single.size ?? '500';
  if (sizeText !== '500' && sizeText !== '1000') throw new PagingError('Invalid page size. Choose 500 or 1000.');
  const offsetText = single.offset ?? '0';
  if (!/^\d{1,10}$/.test(offsetText as string) || Number(offsetText) > 1000000000) throw new PagingError('Invalid page offset. Choose a whole number from 0 to 1000000000.');
  let publications: Query['publications'] = null;
  if (params.publication !== undefined) {
    try {
      if ((params.publication as string).length > 4096) throw new Error();
      const value: unknown = JSON.parse(params.publication as string);
      if (!Array.isArray(value) || value.length > 200) throw new Error();
      const ids = new Set<number>();
      for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || pair[0] < 1 ||
            (pair[1] !== null && (!Number.isSafeInteger(pair[1]) || pair[1] < 1)) || ids.has(pair[0])) throw new Error();
        ids.add(pair[0]);
      }
      publications = value;
    } catch { throw new PagingError('Invalid publication selection. Return to the first page.'); }
  }
  return { category, promo, sort: sort as SortKey, direction, size: Number(sizeText), offset: Number(offsetText), publications };
}

/**
 * Reject explicit D1 failures before rendering partial publication data.
 * @param result - Database result with runtime success metadata.
 * @returns Nothing on success.
 * @throws Error when the database reports failure without throwing.
 */
function requireSuccessfulRead(result: { success?: boolean }): void {
  if (result.success === false) throw new Error('Database read failed');
}

/**
 * Read a bounded page from completed publications plus legacy unversioned rows.
 * Count, rows, options, and raw publication availability share a read-only batch.
 * Reuse request metadata on reset and conservatively cap all SQL at Free's 50.
 * @param retailerSlug - Selected store or all; unknown stores produce an empty page.
 * @param params - URL filters, sort, size, offset, and publication selection.
 * @returns Page rows, true totals, metadata, and the selected publication token.
 * @throws PagingError for invalid input or repeated publication changes.
 */
async function getData(retailerSlug: string, params: Params = {}): Promise<PageData> {
  const query = parseQuery(params);
  const evaluatedAt = new Date().toISOString();
  if (typeof retailerSlug !== 'string' || !retailerSlug || retailerSlug.length > 100) throw new PagingError('Invalid retailer value.');
  try {
    const { env } = getRequestContext();
    const db = env.DB;
    if (!db) throw new Error('Database unavailable');
    let statementCount = 0;
    /**
     * Bound every prepared SELECT, including each batch member, not just RPCs.
     * @param sql - Internal SQL with bound values.
     * @returns A prepared statement within the request budget.
     * @throws Error before issuing a statement above the conservative limit.
     */
    const prepare = (sql: string) => {
      if (++statementCount > 50) throw new Error('Database read budget exceeded');
      return db.prepare(sql);
    };
    /**
     * Read one result and reject explicit unsuccessful binding responses.
     * @param sql - Internal SQL.
     * @param values - Bound scalar values.
     * @returns One row or null.
     * @throws Error for an unsuccessful read.
     */
    const first = async <T,>(sql: string, values: (string | number | null)[]): Promise<T | null> => {
      const result = await prepare(sql).bind(...values).first<T>();
      if (result) requireSuccessfulRead(result as { success?: boolean });
      return result;
    };
    const retailersResult = await prepare('SELECT id, name, slug, scrape_source FROM retailers WHERE is_active = 1 ORDER BY name').all<Retailer>();
    requireSuccessfulRead(retailersResult);
    const retailers = retailersResult.results || [];
    const relevant = retailers.filter(r => retailerSlug === 'all' || r.slug === retailerSlug);
    const sourcesResult = await prepare(`SELECT ss.id, ss.retailer_id, ss.is_active FROM scrape_sources ss JOIN retailers r ON ss.retailer_id = r.id WHERE r.is_active = 1`).all<{ id: number; retailer_id: number; is_active: number }>();
    requireSuccessfulRead(sourcesResult);
    const sources = sourcesResult.results || [];
    const retailerPaused: Record<string, boolean> = {};
    for (const retailer of retailers) {
      const retailerSources = sources.filter(source => source.retailer_id === retailer.id);
      retailerPaused[retailer.slug] = retailerSources.length > 0 && retailerSources.every(source => source.is_active === 0);
    }
    /**
     * Select completed metadata for one store, preserving the existing tie-break.
     * @param retailerId - Active store identifier.
     * @param scrapeId - Optional completed pin, otherwise the latest completion.
     * @returns Publication identity and its stored date, including unknown dates.
     */
    const snapshotFor = async (retailerId: number, scrapeId?: number): Promise<Snapshot> => {
      const ids = sources.filter(s => s.retailer_id === retailerId).map(s => s.id);
      const row = ids.length ? await first<{ scrape_id: number; completed_at: string | null }>(
        `SELECT sh.id as scrape_id, sh.completed_at FROM scrape_history sh
        WHERE sh.status = 'completed' AND sh.source_id IN (${ids.map(() => '?').join(',')})
        ${scrapeId === undefined ? 'ORDER BY sh.completed_at DESC, sh.id DESC' : 'AND sh.id = ?'} LIMIT 1`,
        [...ids, ...(scrapeId === undefined ? [] : [scrapeId])]) : null;
      return { retailerId, scrapeId: row?.scrape_id ?? null, completedAt: row?.completed_at ?? null };
    };
    const latest: Snapshot[] = [];
    for (const retailer of relevant) latest.push(await snapshotFor(retailer.id));
    const requested = query.publications;
    const scopeMatches = requested !== null && requested.length === relevant.length && relevant.every(r => requested.some(pair => pair[0] === r.id));
    let publicationReset = requested !== null && !scopeMatches;
    let snapshots = [...latest];
    if (scopeMatches) {
      for (let index = 0; index < latest.length; index++) {
        const current = latest[index];
        const id = requested!.find(pair => pair[0] === current.retailerId)![1];
        if (id === null) {
          if (current.scrapeId !== null) publicationReset = true;
        } else if (id !== current.scrapeId) {
          const pinned = await snapshotFor(current.retailerId, id);
          if (pinned.scrapeId === null) publicationReset = true;
          else snapshots[index] = pinned;
        }
      }
    }
    if (publicationReset) snapshots = [...latest];
    let retried = publicationReset;
    let filtersCleared = false;
    const today = evaluatedAt.split('T')[0];
    for (;;) {
      const scopeSQL = `FROM deals d JOIN retailers r ON d.retailer_id = r.id WHERE r.is_active = 1
        AND (d.valid_from IS NULL OR d.valid_from <= ?) AND (d.valid_to IS NULL OR d.valid_to >= ?)
        AND d.regular_price > 0 AND d.savings_percent > 0 AND COALESCE(d.in_stock, 1) = 1
        AND (${snapshots.map(() => '(d.retailer_id = ? AND (d.scrape_id IS NULL OR d.scrape_id = ?))').join(' OR ') || '0'})`;
      const scopeParams: (string | number | null)[] = [today, today, ...snapshots.flatMap(s => [s.retailerId, s.scrapeId])];
      let filteredSQL = scopeSQL;
      const filterParams = [...scopeParams];
      if (query.category !== 'all') { filteredSQL += ' AND d.category = ?'; filterParams.push(query.category); }
      if (query.promo !== 'all') { filteredSQL += ' AND d.promo_type = ?'; filterParams.push(query.promo); }
      const offset = publicationReset ? 0 : query.offset;
      const versioned = snapshots.filter(s => s.scrapeId !== null);
      const statements = [
        prepare(`SELECT COUNT(*) as total, COALESCE(AVG(d.savings_percent), 0) as avgSavings, COALESCE(MAX(d.savings_percent), 0) as topSaving,
          COALESCE(MAX(CASE WHEN d.scrape_id IS NULL THEN 1 ELSE 0 END), 0) as hasLegacyRows ${filteredSQL}`).bind(...filterParams),
        prepare(`SELECT d.id, d.product_code, d.product_name, d.brand, d.regular_price, d.sale_price,
          d.savings_amount, d.savings_percent, d.category, d.promo_type, d.image_url, d.product_url, d.scraped_at, d.scrape_id,
          COALESCE(d.in_stock, 1) as in_stock, r.slug as retailer_slug, r.name as retailer_name
          ${filteredSQL} ORDER BY (${SORT_COLUMNS[query.sort]} IS NULL) ASC, ${SORT_COLUMNS[query.sort]} ${query.direction === 'asc' ? 'ASC' : 'DESC'}, d.id ASC LIMIT ? OFFSET ?`).bind(...filterParams, query.size, offset),
        prepare(`SELECT DISTINCT d.category as value ${scopeSQL} AND d.category IS NOT NULL AND d.category != '' ORDER BY d.category`).bind(...scopeParams),
        prepare(`SELECT DISTINCT d.promo_type as value ${scopeSQL} AND d.promo_type IS NOT NULL AND d.promo_type != '' ORDER BY d.promo_type`).bind(...scopeParams),
        // Raw availability is independent of filters and stock/date eligibility.
        prepare(`SELECT DISTINCT d.retailer_id, d.scrape_id FROM deals d WHERE
          ${versioned.map(() => '(d.retailer_id = ? AND d.scrape_id = ?)').join(' OR ') || '0'}`)
          .bind(...versioned.flatMap(s => [s.retailerId, s.scrapeId])),
      ];
      const batch = await db.batch(statements);
      batch.forEach(requireSuccessfulRead);
      const available = batch[4].results as { retailer_id: number; scrape_id: number }[];
      let changed = false;
      for (let index = 0; index < snapshots.length; index++) {
        const snapshot = snapshots[index];
        if (available.some(row => row.retailer_id === snapshot.retailerId && row.scrape_id === snapshot.scrapeId)) continue;
        // History survives cleanup. Missing rows require a fresh identity check,
        // unless an already selected newer completion establishes the reset.
        const current = latest[index].scrapeId !== snapshot.scrapeId ? latest[index] : await snapshotFor(snapshot.retailerId);
        latest[index] = current;
        if (current.scrapeId !== snapshot.scrapeId) changed = true;
      }
      if (changed) {
        if (retried) throw new PagingError('The publication changed again. Return to the first page to reload deals.');
        snapshots = [...latest];
        publicationReset = true;retried = true;
        continue;
      }
      const categories = (batch[2].results as { value: string }[]).map(row => row.value);
      const promoTypes = (batch[3].results as { value: string }[]).map(row => row.value);
      if ((query.category !== 'all' && !categories.includes(query.category)) || (query.promo !== 'all' && !promoTypes.includes(query.promo))) {
        if (!publicationReset || filtersCleared) throw new PagingError('Unsupported filter option. Choose a category and sale type from the browsing controls.');
        query.category = 'all';query.promo = 'all';filtersCleared = true;
        continue;
      }
      const retailerDates: Record<string, string | null> = {};
      snapshots.forEach(snapshot => {
        if (snapshot.scrapeId !== null) retailerDates[relevant.find(r => r.id === snapshot.retailerId)!.slug] = snapshot.completedAt;
      });
      const costco = snapshots.find(snapshot => relevant.some(r => r.id === snapshot.retailerId && r.slug === 'costco'));
      const flyer = costco?.scrapeId ? await first<{ flyer_dates: string | null }>(
        "SELECT sh.flyer_dates FROM scrape_history sh WHERE sh.status = 'completed' AND sh.id = ? LIMIT 1", [costco.scrapeId]) : null;
      const stats = batch[0].results[0] as { total: number; avgSavings: number; topSaving: number; hasLegacyRows: number };
      const deals = (batch[1].results as unknown as Deal[]).map(row => ({
        ...row, published_at: row.scrape_id === null ? null : retailerDates[row.retailer_slug] || null,
      }));
      return {
        deals, retailers, retailerDates, retailerPaused, evaluatedAt, flyerDates: flyer?.flyer_dates || null, error: null,
        ...stats, hasLegacyRows: stats.hasLegacyRows === 1, categories, promoTypes, retailerSlug, category: query.category, promo: query.promo,
        sort: query.sort, direction: query.direction, size: query.size, offset,
        publication: JSON.stringify(snapshots.map(s => [s.retailerId, s.scrapeId])), publicationReset,
      };
    }
  } catch (error) {
    if (error instanceof PagingError) throw error;
    console.error('Deals database read failed');
    return {
      deals: [], retailers: [], retailerDates: {}, retailerPaused: {}, evaluatedAt, hasLegacyRows: false,
      flyerDates: null, error: 'Deals could not be loaded. Please try again later.',
      total: 0, avgSavings: 0, topSaving: 0, categories: [], promoTypes: [], retailerSlug,
      category: query.category, promo: query.promo, sort: query.sort, direction: query.direction,
      size: query.size, offset: query.offset, publication: '[]', publicationReset: false,
    };
  }
}

/**
 * Render the selected server page or an explicit invalid-query message.
 * @param props - Next.js URL search parameters.
 * @returns The page shell and bounded browsing component.
 */
export default async function Home({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  try {
    const retailerSlug = params.retailer || 'costco';
    if (typeof retailerSlug !== 'string') throw new PagingError('Invalid repeated retailer value.');
    const data = await getData(retailerSlug, params);
    if (data.error) {
      return <main className="container">
        <header><h1>Deals</h1></header>
        <div className="empty-state" role="alert">
          <p>{data.error}</p>
          <p>Saved prices have not been replaced. Reload this page to try again.</p>
          <a href="https://github.com/hkonnection/price-scraper/actions">Actions run history</a>
        </div>
      </main>;
    }
    return <main className="container"><DealsPageClient {...data} /></main>;
  } catch (error) {
    if (!(error instanceof PagingError)) throw error;
    return <main className="container"><div className="empty-state"><p>{error.message}</p><a href="/">Return to the first page</a></div></main>;
  }
}
