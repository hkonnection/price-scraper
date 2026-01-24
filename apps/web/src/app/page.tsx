import { getRequestContext } from '@cloudflare/next-on-pages';
import DealsTable from './components/DealsTable';

export const runtime = 'edge';

interface Deal {
  id: number;
  product_code: string;
  product_name: string;
  regular_price: number;
  sale_price: number;
  savings_amount: number;
  savings_percent: number;
  category: string;
  image_url: string | null;
}

interface ScrapeHistory {
  id: number;
  completed_at: string;
  deals_count: number;
  flyer_dates: string | null;
}

// Mock data for local development
const MOCK_DEALS: Deal[] = [
  { id: 1, product_code: '1627198', product_name: 'DURACELL POWER BOOST AAA BATTERIES PACK OF 40', regular_price: 25.99, sale_price: 19.99, savings_amount: 6, savings_percent: 23.1, category: 'Other', image_url: 'https://west.cocowest1.ca/2026/01/DURACELL_POWER_BOOST_AAA_BATTERIES_PACK_OF_40_20260119_240443.jpeg' },
  { id: 2, product_code: '2945480', product_name: 'MONDETTA CORDUROY PANT WOMENS SIZES XL-XXL', regular_price: 17.99, sale_price: 7.99, savings_amount: 10, savings_percent: 55.6, category: 'Other', image_url: null },
  { id: 3, product_code: '485090', product_name: 'PREMIER NUTRITION PROTEIN SHAKE 18 x 325 mL', regular_price: 44.99, sale_price: 34.99, savings_amount: 10, savings_percent: 22.2, category: 'Food & Grocery', image_url: 'https://west.cocowest1.ca/2026/01/PREMIER_NUTRITION_PROTEIN_SHAKE_18_x_325_mL_20260119_240445.jpeg' },
  { id: 4, product_code: '1749979', product_name: 'VEGA ORGANIC PROTEIN & GREENS 2 KG', regular_price: 59.99, sale_price: 42.99, savings_amount: 17, savings_percent: 28.3, category: 'Health & Wellness', image_url: null },
  { id: 5, product_code: '2555706', product_name: 'SONICARE CONFIDENT CLEAN DUAL HANDLES', regular_price: 169.99, sale_price: 134.99, savings_amount: 35, savings_percent: 20.6, category: 'Electronics', image_url: null },
  { id: 6, product_code: '1730860', product_name: 'AVEENO MOISTURIZING LOTION 2 X 710ML', regular_price: 21.99, sale_price: 16.99, savings_amount: 5, savings_percent: 22.7, category: 'Health & Wellness', image_url: null },
  { id: 7, product_code: '597726', product_name: 'YOUTHEORY ADVANCED COLLAGEN 390 TABLETS', regular_price: 26.99, sale_price: 20.99, savings_amount: 6, savings_percent: 22.2, category: 'Health & Wellness', image_url: null },
  { id: 8, product_code: '2150013', product_name: 'HP OMNIBOOK 7 MICROSOFT COPILOT+ PC', regular_price: 1649.99, sale_price: 1499.99, savings_amount: 150, savings_percent: 9.1, category: 'Electronics', image_url: null },
];

/**
 * Fetches deals from D1 database.
 * Returns mock data for local development when D1 is not available.
 */
async function getDeals(): Promise<{ deals: Deal[]; lastUpdated: string | null; flyerDates: string | null }> {
  try {
    const { env } = getRequestContext();
    const db = env.DB;

    if (!db) {
      // Return mock data for local development
      console.log('D1 not bound - using mock data for local preview');
      return { deals: MOCK_DEALS, lastUpdated: new Date().toISOString(), flyerDates: 'January 19-25, 2026' };
    }

    // Get latest scrape info
    const scrapeResult = await db
      .prepare('SELECT id, completed_at, deals_count, flyer_dates FROM scrape_history WHERE status = ? ORDER BY id DESC LIMIT 1')
      .bind('completed')
      .first<ScrapeHistory>();

    const lastUpdated = scrapeResult?.completed_at || null;
    const flyerDates = scrapeResult?.flyer_dates || null;

    // Get deals from latest scrape
    const dealsResult = await db
      .prepare(`
        SELECT id, product_code, product_name, regular_price, sale_price,
               savings_amount, savings_percent, category, image_url
        FROM deals
        ORDER BY savings_percent DESC
      `)
      .all<Deal>();

    return {
      deals: dealsResult.results || [],
      lastUpdated,
      flyerDates,
    };
  } catch (error) {
    // Fallback to mock data on error (e.g., local dev)
    console.log('D1 error - using mock data:', error);
    return { deals: MOCK_DEALS, lastUpdated: new Date().toISOString(), flyerDates: 'January 19-25, 2026' };
  }
}

export default async function Home() {
  const { deals, lastUpdated, flyerDates } = await getDeals();

  const totalDeals = deals.length;
  const avgSavings = deals.length > 0
    ? deals.reduce((sum, d) => sum + d.savings_percent, 0) / deals.length
    : 0;
  const topSaving = deals.length > 0 ? Math.max(...deals.map(d => d.savings_percent)) : 0;

  return (
    <main className="container">
      <header>
        <h1>Costco Deals - Western Canada</h1>
        <p>Current sale items from Costco (BC, AB, SK, MB)</p>
        {flyerDates && (
          <p style={{ marginTop: '0.5rem', fontSize: '1.1rem', fontWeight: 500, color: '#10b981' }}>
            📅 Valid: {flyerDates}
          </p>
        )}
      </header>

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

      <DealsTable deals={deals} lastUpdated={lastUpdated} />
    </main>
  );
}
