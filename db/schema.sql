-- Price Scraper Database Schema
-- Supports multiple retailers and scrape sources

-- Retailers table (Costco, Superstore, etc.)
CREATE TABLE IF NOT EXISTS retailers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  website TEXT,
  scrape_source TEXT,
  region TEXT DEFAULT 'Western Canada',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Scrape sources table (cocowest, flipp, direct, etc.)
CREATE TABLE IF NOT EXISTS scrape_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  url TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (retailer_id) REFERENCES retailers(id)
);

-- Deals table
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer_id INTEGER NOT NULL,
  source_id INTEGER,
  scrape_id INTEGER,
  product_code TEXT,
  product_name TEXT NOT NULL,
  regular_price REAL NOT NULL,
  sale_price REAL NOT NULL,
  savings_amount REAL NOT NULL,
  savings_percent REAL NOT NULL,
  category TEXT,
  image_url TEXT,
  valid_from TEXT,
  valid_to TEXT,
  scraped_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (retailer_id) REFERENCES retailers(id),
  FOREIGN KEY (source_id) REFERENCES scrape_sources(id),
  FOREIGN KEY (scrape_id) REFERENCES scrape_history(id)
);

-- Scrape history table
CREATE TABLE IF NOT EXISTS scrape_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  deals_count INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT DEFAULT 'running',
  error_message TEXT,
  FOREIGN KEY (source_id) REFERENCES scrape_sources(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_deals_retailer ON deals(retailer_id);
CREATE INDEX IF NOT EXISTS idx_deals_source ON deals(source_id);
CREATE INDEX IF NOT EXISTS idx_deals_scrape ON deals(scrape_id);
CREATE INDEX IF NOT EXISTS idx_deals_savings_percent ON deals(savings_percent DESC);
CREATE INDEX IF NOT EXISTS idx_deals_category ON deals(category);
CREATE INDEX IF NOT EXISTS idx_scrape_history_source ON scrape_history(source_id);

-- Seed data
INSERT OR IGNORE INTO retailers (name, slug, website, scrape_source) VALUES
  ('Costco', 'costco', 'https://costco.ca', 'cocowest');

INSERT OR IGNORE INTO retailers (name, slug, website, scrape_source, is_active) VALUES
  ('Real Canadian Superstore', 'superstore', 'https://realcanadiansuperstore.ca', 'flipp', 0),
  ('Save-On-Foods', 'save-on-foods', 'https://saveonfoods.com', 'flipp', 0),
  ('Walmart', 'walmart', 'https://walmart.ca', 'direct', 0);

INSERT OR IGNORE INTO scrape_sources (retailer_id, name, slug, url) VALUES
  (1, 'Cocowest Blog', 'cocowest', 'https://cocowest.ca');
