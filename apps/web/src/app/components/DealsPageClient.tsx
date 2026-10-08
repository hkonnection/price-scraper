'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import DealsTable from './DealsTable';

export interface Retailer {
  id: number;
  name: string;
  slug: string;
  scrape_source: string;
}

export interface Deal {
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

export type SortKey = 'product_name' | 'regular_price' | 'sale_price' | 'savings_amount' | 'savings_percent' | 'category' | 'retailer_name';

export interface Paging {
  total: number;
  avgSavings: number;
  topSaving: number;
  categories: string[];
  promoTypes: string[];
  retailerSlug: string;
  category: string;
  promo: string;
  sort: SortKey;
  direction: 'asc' | 'desc';
  size: number;
  offset: number;
  publication: string;
  publicationReset: boolean;
}

interface DealsPageClientProps extends Paging {
  deals: Deal[];
  retailers: Retailer[];
  retailerDates: Record<string, string>;
  flyerDates: string | null;
}

/**
 * Render the read-only server page and send browsing controls back to the server.
 * @param props - Rows, full matching totals, options, and validated page state.
 * @returns The existing deals layout with bounded URL-driven browsing.
 */
export default function DealsPageClient({ deals, retailers, retailerDates, flyerDates, total, avgSavings, topSaving,
  categories, promoTypes, retailerSlug: selectedRetailer, category: selectedCategory, promo: selectedPromoType,
  sort, direction, size: pageSize, offset, publication, publicationReset }: DealsPageClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.floor(offset / pageSize) + 1;

  /**
   * Navigate with the current server scope; reset the offset for control changes.
   * @param changes - Validated UI control values to replace.
   * @returns Nothing; starts a server navigation.
   */
  const navigate = (changes: Record<string, string>) => {
    const params = new URLSearchParams({ retailer: selectedRetailer, category: selectedCategory, promo: selectedPromoType,
      sort, direction, size: String(pageSize), offset: '0', publication, ...changes });
    if (changes.retailer !== undefined) {
      params.delete('publication');
      params.set('category', 'all');
      params.set('promo', 'all');
    }
    startTransition(() => router.replace(`/?${params.toString()}`, { scroll: false }));
  };

  const activeRetailer = retailers.find(r => r.slug === selectedRetailer);

  const headerTitle = selectedRetailer === 'all'
    ? 'All Retailer Deals'
    : `${activeRetailer?.name || selectedRetailer} Deals`;

  const headerSubtitle = selectedRetailer === 'costco'
    ? 'Current sale items from Costco (BC, AB, SK, MB)'
    : selectedRetailer === 'all'
      ? 'Deals across all retailers'
      : `Current deals from ${activeRetailer?.name || selectedRetailer}`;

  // Get the last updated date for the selected retailer (null for "all" view)
  const lastUpdated = selectedRetailer === 'all'
    ? null
    : retailerDates[selectedRetailer] || null;

  return (
    <>
      <header>
        <div className="header-row">
          <div>
            <h1>{headerTitle}</h1>
            <p>{headerSubtitle}</p>
          </div>
        </div>
        {flyerDates && selectedRetailer === 'costco' && (
          <p style={{ marginTop: '0.5rem', fontSize: '1.1rem', fontWeight: 500, color: '#10b981' }}>
            Valid: {flyerDates}
          </p>
        )}
      </header>

      <div className="filter-bar">
        <div className="filter-group">
          <label htmlFor="retailer-filter">Retailer</label>
          <select
            id="retailer-filter"
            value={selectedRetailer}
            disabled={pending}
            onChange={(e) => navigate({ retailer: e.target.value })}
          >
            <option value="all">All Retailers</option>
            {retailers.map(r => (
              <option key={r.slug} value={r.slug}>{r.name}</option>
            ))}
          </select>
        </div>

        {categories.length > 1 && (
          <div className="filter-group">
            <label htmlFor="category-filter">Category</label>
            <select
              id="category-filter"
              value={selectedCategory}
              disabled={pending}
              onChange={(e) => navigate({ category: e.target.value })}
            >
              <option value="all">All Categories</option>
              {categories.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        )}

        {promoTypes.length > 1 && (
          <div className="filter-group">
            <label htmlFor="promo-filter">Sale Type</label>
            <select
              id="promo-filter"
              value={selectedPromoType}
              disabled={pending}
              onChange={(e) => navigate({ promo: e.target.value })}
            >
              <option value="all">All Types</option>
              {promoTypes.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="stats">
        <div className="stat-card">
          <div className="value">{total}</div>
          <div className="label">Total Matches</div>
        </div>
        <div className="stat-card">
          <div className="value">{avgSavings.toFixed(0)}%</div>
          <div className="label">Avg Savings</div>
        </div>
        <div className="stat-card">
          <div className="value">{topSaving.toFixed(0)}%</div>
          <div className="label">Best Deal</div>
        </div>
      </div>

      {publicationReset && <p role="status">The publication changed. Browsing restarted at the first page.</p>}
      <div className="pagination-controls" aria-busy={pending}>
        <div className="pagination-info">
          Loaded {deals.length} of {total} matching deals
          {currentPage <= totalPages ? ` (Page ${currentPage} of ${totalPages})` : ' (No matches at this offset)'}
          {pending && ' Loading...'}
        </div>
        <div className="pagination-actions">
          <label htmlFor="page-size">Per page:</label>
          <select
            id="page-size"
            value={pageSize}
            disabled={pending}
            onChange={(e) => navigate({ size: e.target.value })}
          >
            <option value={500}>500</option>
            <option value={1000}>1000</option>
          </select>
          <button
            onClick={() => navigate({ offset: String(Math.max(0, offset - pageSize)) })}
            disabled={pending || offset === 0}
            className="pagination-button"
          >
            ← Prev
          </button>
          <button
            onClick={() => navigate({ offset: String(offset + pageSize) })}
            disabled={pending || offset + pageSize >= total}
            className="pagination-button"
          >
            Next →
          </button>
        </div>
      </div>

      <DealsTable
        deals={deals}
        sortKey={sort}
        sortDirection={direction}
        pending={pending}
        onSort={(key, nextDirection) => navigate({ sort: key, direction: nextDirection })}
        lastUpdated={lastUpdated}
        showRetailer={selectedRetailer === 'all'}
      />
    </>
  );
}
