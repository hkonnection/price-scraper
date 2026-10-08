'use client';

import { useState } from 'react';
import type { SortKey } from './DealsPageClient';

interface Deal {
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

interface DealsTableProps {
  deals: Deal[];
  lastUpdated: string | null;
  showRetailer?: boolean;
  sortKey: SortKey;
  sortDirection: 'asc' | 'desc';
  pending: boolean;
  onSort: (key: SortKey, direction: 'asc' | 'desc') => void;
}

/**
 * Formats a date string to "Jan 24, 2026, 9:18:52 PM" format.
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) + ', ' + date.toLocaleTimeString('en-US');
}

/**
 * Formats a date string to short format "Jan 24" or "Jan 24, 2025" if not current year.
 */
function formatShortDate(dateString: string): string {
  const date = new Date(dateString);
  const currentYear = new Date().getFullYear();
  const dateYear = date.getFullYear();

  if (dateYear === currentYear) {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Returns a CSS class for the retailer badge based on slug.
 *
 * @param {string} slug - Retailer slug
 * @returns {string} CSS class name
 */
function getRetailerBadgeClass(slug: string): string {
  const map: Record<string, string> = {
    costco: 'retailer-badge-costco',
    carters: 'retailer-badge-carters',
  };
  return `retailer-badge ${map[slug] || ''}`;
}

/**
 * Render the server-ordered page and request full-result sorting through its parent.
 * @param props - Bounded rows, selected sort, publication date, and navigation callback.
 * @returns The existing table and image modal.
 */
export default function DealsTable({ deals, lastUpdated, showRetailer = false, sortKey, sortDirection, pending, onSort }: DealsTableProps) {
  const [modalImage, setModalImage] = useState<{ url: string; name: string } | null>(null);

  /** Request a server sort with the existing text and numeric defaults. */
  const handleSort = (key: SortKey) => {
    if (pending) return;
    onSort(key, sortKey === key ? (sortDirection === 'asc' ? 'desc' : 'asc')
      : (key === 'product_name' || key === 'category' || key === 'retailer_name' ? 'asc' : 'desc'));
  };

  /** Return the class for the selected server sort. */
  const getSortClass = (key: SortKey) => {
    if (sortKey !== key) return 'sortable';
    return sortDirection === 'asc' ? 'sortable sorted-asc' : 'sortable sorted-desc';
  };

  /** Return the existing savings badge class. */
  const getSavingsClass = (percent: number) => {
    if (percent >= 40) return 'savings-percent very-high';
    if (percent >= 30) return 'savings-percent high';
    return 'savings-percent';
  };

  if (deals.length === 0) {
    return (
      <div className="empty-state">
        <p>No deals found. Run the scraper or import deals to populate data.</p>
      </div>
    );
  }

  return (
    <>
      {lastUpdated && (
        <p className="last-updated">
          Last updated: {formatDate(lastUpdated)}
        </p>
      )}
      <p className="scroll-hint">Swipe to see more</p>
      <div className="deals-table-wrapper">
        <table className="deals-table">
          <thead>
            <tr>
              {showRetailer && (
                <th
                  className={getSortClass('retailer_name')}
                  onClick={() => handleSort('retailer_name')}
                >
                  Retailer
                </th>
              )}
              {showRetailer && (
                <th style={{ whiteSpace: 'nowrap' }}>
                  Updated
                </th>
              )}
              <th
                className={getSortClass('product_name')}
                onClick={() => handleSort('product_name')}
              >
                Product
              </th>
              <th
                className={getSortClass('category')}
                onClick={() => handleSort('category')}
              >
                Category
              </th>
              <th
                className={getSortClass('regular_price')}
                onClick={() => handleSort('regular_price')}
                style={{ textAlign: 'right' }}
              >
                Regular
              </th>
              <th
                className={getSortClass('sale_price')}
                onClick={() => handleSort('sale_price')}
                style={{ textAlign: 'right' }}
              >
                Sale
              </th>
              <th
                className={getSortClass('savings_amount')}
                onClick={() => handleSort('savings_amount')}
                style={{ textAlign: 'right' }}
              >
                $ Off
              </th>
              <th
                className={getSortClass('savings_percent')}
                onClick={() => handleSort('savings_percent')}
                style={{ textAlign: 'right' }}
              >
                % Off
              </th>
            </tr>
          </thead>
          <tbody>
            {deals.map((deal) => (
              <tr key={deal.id} className={deal.in_stock === 0 ? 'sold-out-row' : ''}>
                {showRetailer && (
                  <td>
                    <span className={getRetailerBadgeClass(deal.retailer_slug)}>
                      {deal.retailer_name}
                    </span>
                  </td>
                )}
                {showRetailer && (
                  <td className="updated-cell">
                    {formatShortDate(deal.scraped_at)}
                  </td>
                )}
                <td>
                  <div className="product-cell">
                    {deal.image_url && (
                      <img
                        src={deal.image_url}
                        alt={deal.product_name}
                        className="product-image"
                        loading="lazy"
                        onClick={() => setModalImage({ url: deal.image_url!, name: deal.product_name })}
                        style={{ cursor: 'pointer' }}
                      />
                    )}
                    <div>
                      {deal.in_stock === 0 && (
                        <span className="sold-out-badge">Sold Out</span>
                      )}
                      {deal.product_url ? (
                        <a href={deal.product_url} target="_blank" rel="noopener noreferrer" className="product-name product-link">
                          {deal.product_name}
                        </a>
                      ) : (
                        <div className="product-name">{deal.product_name}</div>
                      )}
                      {deal.brand && <div className="product-brand">{deal.brand}</div>}
                      {deal.product_code && (
                        <div className="product-code">#{deal.product_code}</div>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  <span className="category-badge">{deal.category}</span>
                </td>
                <td className="price">
                  <span className="price-regular">${deal.regular_price.toFixed(2)}</span>
                </td>
                <td className="price">
                  <span className="price-sale">${deal.sale_price.toFixed(2)}</span>
                </td>
                <td className="savings">
                  ${deal.savings_amount.toFixed(2)}
                </td>
                <td className="savings">
                  <span className={getSavingsClass(deal.savings_percent)}>
                    {deal.savings_percent.toFixed(0)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Image Modal */}
      {modalImage && (
        <div className="modal-overlay" onClick={() => setModalImage(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModalImage(null)}>x</button>
            <img src={modalImage.url} alt={modalImage.name} className="modal-image" />
            <p className="modal-caption">{modalImage.name}</p>
          </div>
        </div>
      )}
    </>
  );
}
