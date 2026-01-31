'use client';

import { useState, useMemo } from 'react';
import DealsTable from './DealsTable';
import ImportModal from './ImportModal';

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
  retailer_slug: string;
  retailer_name: string;
}

interface DealsPageClientProps {
  deals: Deal[];
  retailers: Retailer[];
  lastUpdated: string | null;
  flyerDates: string | null;
}

/**
 * Client-side wrapper that manages retailer/category/sale-type filters,
 * stats display, import modal, and renders the DealsTable.
 */
export default function DealsPageClient({ deals, retailers, lastUpdated, flyerDates }: DealsPageClientProps) {
  const [selectedRetailer, setSelectedRetailer] = useState('costco');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedPromoType, setSelectedPromoType] = useState('all');
  const [showImportModal, setShowImportModal] = useState(false);

  const filteredDeals = useMemo(() => {
    return deals.filter(deal => {
      if (selectedRetailer !== 'all' && deal.retailer_slug !== selectedRetailer) return false;
      if (selectedCategory !== 'all' && deal.category !== selectedCategory) return false;
      if (selectedPromoType !== 'all' && deal.promo_type !== selectedPromoType) return false;
      return true;
    });
  }, [deals, selectedRetailer, selectedCategory, selectedPromoType]);

  const categories = useMemo(() => {
    const relevant = selectedRetailer === 'all' ? deals : deals.filter(d => d.retailer_slug === selectedRetailer);
    return Array.from(new Set(relevant.map(d => d.category).filter(Boolean))).sort();
  }, [deals, selectedRetailer]);

  const promoTypes = useMemo(() => {
    const relevant = selectedRetailer === 'all' ? deals : deals.filter(d => d.retailer_slug === selectedRetailer);
    return Array.from(new Set(relevant.map(d => d.promo_type).filter(Boolean) as string[])).sort();
  }, [deals, selectedRetailer]);

  const activeRetailer = retailers.find(r => r.slug === selectedRetailer);
  const showImportButton = activeRetailer?.scrape_source === 'manual';

  const totalDeals = filteredDeals.length;
  const avgSavings = totalDeals > 0
    ? filteredDeals.reduce((sum, d) => sum + d.savings_percent, 0) / totalDeals
    : 0;
  const topSaving = totalDeals > 0 ? Math.max(...filteredDeals.map(d => d.savings_percent)) : 0;

  const headerTitle = selectedRetailer === 'all'
    ? 'All Retailer Deals'
    : `${activeRetailer?.name || selectedRetailer} Deals`;

  const headerSubtitle = selectedRetailer === 'costco'
    ? 'Current sale items from Costco (BC, AB, SK, MB)'
    : selectedRetailer === 'all'
      ? 'Deals across all retailers'
      : `Current deals from ${activeRetailer?.name || selectedRetailer}`;

  /**
   * Resets category/promo filters when retailer changes.
   */
  const handleRetailerChange = (slug: string) => {
    setSelectedRetailer(slug);
    setSelectedCategory('all');
    setSelectedPromoType('all');
  };

  return (
    <>
      <header>
        <div className="header-row">
          <div>
            <h1>{headerTitle}</h1>
            <p>{headerSubtitle}</p>
          </div>
          <div className="header-actions">
            {showImportButton && (
              <button className="import-button" onClick={() => setShowImportModal(true)}>
                Import Deals
              </button>
            )}
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
            onChange={(e) => handleRetailerChange(e.target.value)}
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
              onChange={(e) => setSelectedCategory(e.target.value)}
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
              onChange={(e) => setSelectedPromoType(e.target.value)}
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
          <div className="value">{totalDeals}</div>
          <div className="label">Total Deals</div>
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

      <DealsTable
        deals={filteredDeals}
        lastUpdated={lastUpdated}
        showRetailer={selectedRetailer === 'all'}
      />

      {showImportModal && activeRetailer && (
        <ImportModal
          retailerSlug={activeRetailer.slug}
          retailerName={activeRetailer.name}
          onClose={() => setShowImportModal(false)}
          onSuccess={() => window.location.reload()}
        />
      )}
    </>
  );
}
