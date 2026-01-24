export const runtime = 'edge';

interface Deal {
  id: number;
  retailer_id: number;
  retailer_name?: string;
  product_name: string;
  regular_price: number;
  sale_price: number;
  savings_amount: number;
  savings_percent: number;
  category: string;
  valid_from: string;
  valid_to: string;
}

export default async function Home() {
  // TODO: Fetch deals from D1 via API route
  const deals: Deal[] = [];

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Price Scraper - Western Canada</h1>
      <p style={{ color: '#666' }}>
        Tracking deals from Costco, Superstore, Save-On-Foods & more
      </p>

      {deals.length === 0 ? (
        <div style={{ marginTop: '2rem', padding: '2rem', background: '#f5f5f5', borderRadius: '8px' }}>
          <p>No deals loaded yet. Run the scraper to populate data.</p>
          <code style={{ display: 'block', marginTop: '1rem', background: '#eee', padding: '0.5rem' }}>
            npm run scrape
          </code>
        </div>
      ) : (
        <table style={{ width: '100%', marginTop: '2rem', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f0f0f0' }}>
              <th style={{ padding: '0.75rem', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Product</th>
              <th style={{ padding: '0.75rem', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Regular</th>
              <th style={{ padding: '0.75rem', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Sale</th>
              <th style={{ padding: '0.75rem', textAlign: 'right', borderBottom: '2px solid #ddd' }}>$ Off</th>
              <th style={{ padding: '0.75rem', textAlign: 'right', borderBottom: '2px solid #ddd' }}>% Off</th>
            </tr>
          </thead>
          <tbody>
            {deals.map((deal) => (
              <tr
                key={deal.id}
                style={{
                  background: deal.savings_percent >= 30 ? '#e8f5e9' : 'transparent'
                }}
              >
                <td style={{ padding: '0.75rem', borderBottom: '1px solid #eee' }}>{deal.product_name}</td>
                <td style={{ padding: '0.75rem', textAlign: 'right', borderBottom: '1px solid #eee' }}>
                  ${deal.regular_price.toFixed(2)}
                </td>
                <td style={{ padding: '0.75rem', textAlign: 'right', borderBottom: '1px solid #eee', fontWeight: 'bold' }}>
                  ${deal.sale_price.toFixed(2)}
                </td>
                <td style={{ padding: '0.75rem', textAlign: 'right', borderBottom: '1px solid #eee', color: '#388e3c' }}>
                  ${deal.savings_amount.toFixed(2)}
                </td>
                <td style={{ padding: '0.75rem', textAlign: 'right', borderBottom: '1px solid #eee', fontWeight: 'bold', color: deal.savings_percent >= 30 ? '#2e7d32' : '#666' }}>
                  {deal.savings_percent.toFixed(0)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
