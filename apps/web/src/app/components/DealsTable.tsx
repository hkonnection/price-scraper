'use client';

import { useState, useMemo } from 'react';

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
  retailer_slug: string;
  retailer_name: string;
}

interface DealsTableProps {
  deals: Deal[];
  lastUpdated: string | null;
  showRetailer?: boolean;
}

type SortKey = 'product_name' | 'regular_price' | 'sale_price' | 'savings_amount' | 'savings_percent' | 'category' | 'retailer_name';
type SortDirection = 'asc' | 'desc';

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
 * Sortable deals table component.
 * Displays product deals with clickable column headers for sorting.
 * Optionally shows retailer column when viewing all retailers.
 */
export default function DealsTable({ deals, lastUpdated, showRetailer = false }: DealsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('savings_percent');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [modalImage, setModalImage] = useState<{ url: string; name: string } | null>(null);

  const sortedDeals = useMemo(() => {
    return [...deals].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];

      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }

      return 0;
    });
  }, [deals, sortKey, sortDirection]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection(key === 'product_name' || key === 'category' || key === 'retailer_name' ? 'asc' : 'desc');
    }
  };

  const getSortClass = (key: SortKey) => {
    if (sortKey !== key) return 'sortable';
    return sortDirection === 'asc' ? 'sortable sorted-asc' : 'sortable sorted-desc';
  };

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
            {sortedDeals.map((deal) => (
              <tr key={deal.id}>
                {showRetailer && (
                  <td>
                    <span className={getRetailerBadgeClass(deal.retailer_slug)}>
                      {deal.retailer_name}
                    </span>
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
                      <div className="product-name">{deal.product_name}</div>
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
