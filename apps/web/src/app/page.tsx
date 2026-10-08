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
  retailerDates: Record<string, string>;
  flyerDates: string | null;
}
interface Snapshot {
  retailerId: number;
  scrapeId: number | null;
  completedAt: string | null;
  hasRows: boolean;
}

const SORT_COLUMNS: Record<SortKey, string> = {
  product_name: 'd.product_name', category: 'd.category', retailer_name: 'r.name',
  regular_price: 'd.regular_price', sale_price: 'd.sale_price',
  savings_amount: 'd.savings_amount', savings_percent: 'd.savings_percent',
};

/** A caller error must not enter the existing database preview fallback. */
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
    if (!supported.includes(key)) throw new PagingError('Unsupported query option. Use the browsing controls to try again.');
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

// Mock data for local development. Database fallback behavior is unchanged here.
const MOCK_RETAILERS: Retailer[] = [
  { id: 1, name: 'Costco West', slug: 'costco', scrape_source: 'scraper' },
  { id: 2, name: "Carter's Oshkosh", slug: 'carters', scrape_source: 'manual' },
];
const MOCK_DEALS: Deal[] = [
  { id: 1, product_code: '1627198', product_name: 'DURACELL POWER BOOST AAA BATTERIES PACK OF 40', brand: 'Costco', regular_price: 25.99, sale_price: 19.99, savings_amount: 6, savings_percent: 23.1, category: 'Other', promo_type: 'Instant Savings', image_url: null, product_url: null, scraped_at: new Date().toISOString(), in_stock: 1, retailer_slug: 'costco', retailer_name: 'Costco West' },
  { id: 2, product_code: '2945480', product_name: 'MONDETTA CORDUROY PANT WOMENS SIZES XL-XXL', brand: 'Costco', regular_price: 17.99, sale_price: 7.99, savings_amount: 10, savings_percent: 55.6, category: 'Other', promo_type: 'Instant Savings', image_url: null, product_url: null, scraped_at: new Date().toISOString(), in_stock: 1, retailer_slug: 'costco', retailer_name: 'Costco West' },
];

/**
 * Keep the existing local preview available, with the same bounded page contract.
 * @param retailerSlug - Selected store or all.
 * @param query - Validated URL query.
 * @returns Preview page with totals separated from loaded rows.
 */
function previewData(retailerSlug: string, query: Query): PageData {
  const relevant = MOCK_DEALS.filter(d => retailerSlug === 'all' || d.retailer_slug === retailerSlug);
  const matches = relevant.filter(d => (query.category === 'all' || d.category === query.category) && (query.promo === 'all' || d.promo_type === query.promo));
  matches.sort((a, b) => {
    const aValue = a[query.sort], bValue = b[query.sort];
    const comparison = typeof aValue === 'string' && typeof bValue === 'string' ? aValue.localeCompare(bValue) : Number(aValue) - Number(bValue);
    return (query.direction === 'asc' ? comparison : -comparison) || a.id - b.id;
  });
  return {
    deals: matches.slice(query.offset, query.offset + query.size), retailers: MOCK_RETAILERS,
    retailerDates: { costco: new Date().toISOString(), carters: new Date().toISOString() }, flyerDates: 'January 19-25, 2026',
    total: matches.length, avgSavings: matches.length ? matches.reduce((sum, d) => sum + d.savings_percent, 0) / matches.length : 0,
    topSaving: matches.length ? Math.max(...matches.map(d => d.savings_percent)) : 0,
    categories: Array.from(new Set(relevant.map(d => d.category))), promoTypes: Array.from(new Set(relevant.map(d => d.promo_type).filter(Boolean) as string[])),
    retailerSlug, category: query.category, promo: query.promo, sort: query.sort, direction: query.direction,
    size: query.size, offset: query.offset, publication: '[]', publicationReset: false,
  };
}

/**
 * Read a bounded page from completed publications plus legacy unversioned rows.
 * Count, rows, filter options, and publication availability share one read-only batch.
 * The writer retains history after cleanup, so row existence also validates a pin.
 * @param retailerSlug - Selected store or all; unknown stores produce an empty page.
 * @param params - URL filters, sort, size, offset, and publication selection.
 * @param retry - Internal bounded retry after publication cleanup.
 * @returns Page rows, matching totals, controls, and the selected publication token.
 * @throws PagingError for invalid input or repeated publication changes.
 */
async function getData(retailerSlug: string, params: Params = {}, retry = false): Promise<PageData> {
  const query = parseQuery(params);
  if (typeof retailerSlug !== 'string' || !retailerSlug || retailerSlug.length > 100) throw new PagingError('Invalid retailer value.');
  try {
    const { env } = getRequestContext();
    const db = env.DB;
    if (!db) return previewData(retailerSlug, query);
    const retailers = (await db.prepare('SELECT id, name, slug, scrape_source FROM retailers WHERE is_active = 1 ORDER BY name').all<Retailer>()).results || [];
    const relevant = retailers.filter(r => retailerSlug === 'all' || r.slug === retailerSlug);
    const sources = (await db.prepare(`SELECT ss.id, ss.retailer_id FROM scrape_sources ss JOIN retailers r ON ss.retailer_id = r.id WHERE r.is_active = 1`).all<{ id: number; retailer_id: number }>()).results || [];
    let publicationReset = retry;
    const requested = query.publications;
    const scopeMatches = requested !== null && requested.length === relevant.length && relevant.every(r => requested.some(pair => pair[0] === r.id));
    if (requested && !scopeMatches) publicationReset = true;
    const snapshots: Snapshot[] = [];
    const retailerDates: Record<string, string> = {};
    for (const retailer of relevant) {
      const sourceIds = sources.filter(s => s.retailer_id === retailer.id).map(s => s.id);
      const historySQL = `SELECT sh.id as scrape_id, sh.completed_at, sh.deals_count FROM scrape_history sh
        WHERE sh.status = 'completed' AND sh.source_id IN (${sourceIds.map(() => '?').join(',') || 'NULL'})`;
      const latest = sourceIds.length ? await db.prepare(`${historySQL} ORDER BY sh.completed_at DESC, sh.id DESC LIMIT 1`).bind(...sourceIds).first<{ scrape_id: number; completed_at: string; deals_count: number | null }>() : null;
      let selected = latest;
      if (scopeMatches) {
        const requestedId = requested!.find(pair => pair[0] === retailer.id)![1];
        if (requestedId === null) {
          if (latest) publicationReset = true;
        } else if (requestedId !== latest?.scrape_id) {
          selected = await db.prepare(`${historySQL} AND sh.id = ? LIMIT 1`).bind(...sourceIds, requestedId).first<{ scrape_id: number; completed_at: string; deals_count: number | null }>();
          if (!selected) publicationReset = true;
        }
      }
      const hasRows = selected ? !!await db.prepare('SELECT id FROM deals WHERE retailer_id = ? AND scrape_id = ? LIMIT 1').bind(retailer.id, selected.scrape_id).first() : false;
      if (scopeMatches && selected && selected.scrape_id !== latest?.scrape_id && !hasRows) publicationReset = true;
      snapshots.push({ retailerId: retailer.id, scrapeId: selected?.scrape_id ?? null, completedAt: selected?.completed_at ?? null, hasRows });
      if (selected) retailerDates[retailer.slug] = selected.completed_at;
    }
    // An invalid pin resets the entire scope, not just one store in an all-store page.
    if (publicationReset && !retry) return { ...await getData(retailerSlug, { ...params, publication: undefined, offset: '0' }, true), publicationReset: true };
    const today = new Date().toISOString().split('T')[0];
    const snapshotFilter = snapshots.map(() => '(d.retailer_id = ? AND (d.scrape_id IS NULL OR d.scrape_id = ?))').join(' OR ') || '0';
    const scopeSQL = `FROM deals d JOIN retailers r ON d.retailer_id = r.id WHERE r.is_active = 1
      AND (d.valid_from IS NULL OR d.valid_from <= ?) AND (d.valid_to IS NULL OR d.valid_to >= ?)
      AND d.regular_price > 0 AND d.savings_percent > 0 AND COALESCE(d.in_stock, 1) = 1 AND (${snapshotFilter})`;
    const scopeParams: (string | number | null)[] = [today, today, ...snapshots.flatMap(s => [s.retailerId, s.scrapeId])];
    let filteredSQL = scopeSQL;
    const filterParams = [...scopeParams];
    if (query.category !== 'all') { filteredSQL += ' AND d.category = ?'; filterParams.push(query.category); }
    if (query.promo !== 'all') { filteredSQL += ' AND d.promo_type = ?'; filterParams.push(query.promo); }
    const offset = retry ? 0 : query.offset;
    const withRows = snapshots.filter(s => s.hasRows);
    const withoutRows = snapshots.filter(s => !s.hasRows);
    const statements = [
      db.prepare(`SELECT COUNT(*) as total, COALESCE(AVG(d.savings_percent), 0) as avgSavings, COALESCE(MAX(d.savings_percent), 0) as topSaving ${filteredSQL}`).bind(...filterParams),
      db.prepare(`SELECT d.id, d.product_code, d.product_name, d.brand, d.regular_price, d.sale_price,
        d.savings_amount, d.savings_percent, d.category, d.promo_type, d.image_url, d.product_url, d.scraped_at,
        COALESCE(d.in_stock, 1) as in_stock, r.slug as retailer_slug, r.name as retailer_name
        ${filteredSQL} ORDER BY (${SORT_COLUMNS[query.sort]} IS NULL) ASC, ${SORT_COLUMNS[query.sort]} ${query.direction === 'asc' ? 'ASC' : 'DESC'}, d.id ASC LIMIT ? OFFSET ?`).bind(...filterParams, query.size, offset),
      db.prepare(`SELECT DISTINCT d.category as value ${scopeSQL} AND d.category IS NOT NULL AND d.category != '' ORDER BY d.category`).bind(...scopeParams),
      db.prepare(`SELECT DISTINCT d.promo_type as value ${scopeSQL} AND d.promo_type IS NOT NULL AND d.promo_type != '' ORDER BY d.promo_type`).bind(...scopeParams),
      ...withRows.map(s => db.prepare('SELECT id FROM deals WHERE retailer_id = ? AND scrape_id = ? LIMIT 1').bind(s.retailerId, s.scrapeId)),
      // A real empty publication is valid. An empty result from cleanup during
      // metadata selection is not: compare the current identity in the same batch.
      ...withoutRows.map(s => {
        const ids = sources.filter(source => source.retailer_id === s.retailerId).map(source => source.id);
        return db.prepare(`SELECT sh.id FROM scrape_history sh WHERE sh.status = 'completed'
          AND sh.source_id IN (${ids.map(() => '?').join(',') || 'NULL'})
          ORDER BY sh.completed_at DESC, sh.id DESC LIMIT 1`).bind(...ids);
      }),
    ];
    const batch = await db.batch(statements);
    const rowsRemoved = batch.slice(4, 4 + withRows.length).some(result => !result.results?.length);
    const emptyScopeChanged = withoutRows.some((snapshot, index) =>
      ((batch[4 + withRows.length + index].results?.[0] as { id: number } | undefined)?.id ?? null) !== snapshot.scrapeId);
    if (rowsRemoved || emptyScopeChanged) {
      if (retry) throw new PagingError('The publication changed again. Return to the first page to reload deals.');
      return { ...await getData(retailerSlug, { ...params, publication: undefined, offset: '0' }, true), publicationReset: true };
    }
    const categories = (batch[2].results as { value: string }[]).map(row => row.value);
    const promoTypes = (batch[3].results as { value: string }[]).map(row => row.value);
    // On replacement, a previously valid filter may no longer exist. Clear it with the page reset.
    if ((query.category !== 'all' && !categories.includes(query.category)) || (query.promo !== 'all' && !promoTypes.includes(query.promo))) {
      if (retry) return { ...await getData(retailerSlug, { ...params, category: 'all', promo: 'all', publication: undefined, offset: '0' }, true), publicationReset: true };
      throw new PagingError('Unsupported filter option. Choose a category and sale type from the browsing controls.');
    }
    const flyer = await db.prepare(`SELECT sh.flyer_dates FROM scrape_history sh JOIN scrape_sources ss ON sh.source_id = ss.id
      JOIN retailers r ON ss.retailer_id = r.id WHERE sh.status = 'completed' AND r.slug = 'costco' ORDER BY sh.id DESC LIMIT 1`).first<{ flyer_dates: string | null }>();
    const stats = batch[0].results[0] as { total: number; avgSavings: number; topSaving: number };
    return {
      deals: batch[1].results as unknown as Deal[], retailers, retailerDates, flyerDates: flyer?.flyer_dates || null,
      ...stats, categories, promoTypes, retailerSlug, category: query.category, promo: query.promo,
      sort: query.sort, direction: query.direction, size: query.size, offset,
      publication: JSON.stringify(snapshots.map(s => [s.retailerId, s.scrapeId])), publicationReset,
    };
  } catch (error) {
    if (error instanceof PagingError) throw error;
    console.log('D1 error - using mock data:', error);
    return previewData(retailerSlug, query);
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
    const retailerSlug = params.retailer ?? 'costco';
    if (typeof retailerSlug !== 'string') throw new PagingError('Invalid repeated retailer value.');
    const data = await getData(retailerSlug, params);
    return <main className="container"><DealsPageClient {...data} /></main>;
  } catch (error) {
    if (!(error instanceof PagingError)) throw error;
    return <main className="container"><div className="empty-state"><p>{error.message}</p><a href="/">Return to the first page</a></div></main>;
  }
}
