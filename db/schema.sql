-- Costco Deals Database Schema
-- Run this in Cloudflare D1 to create the tables

-- Deals table: stores all scraped deals
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_name TEXT NOT NULL,
  regular_price REAL NOT NULL,
  sale_price REAL NOT NULL,
  savings_amount REAL NOT NULL,
  savings_percent REAL NOT NULL,
  category TEXT,
  source TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  scraped_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_deals_source ON deals(source);
CREATE INDEX IF NOT EXISTS idx_deals_savings_percent ON deals(savings_percent DESC);
CREATE INDEX IF NOT EXISTS idx_deals_category ON deals(category);
CREATE INDEX IF NOT EXISTS idx_deals_scraped_at ON deals(scraped_at DESC);

-- Scrape history: tracks when scrapes ran
CREATE TABLE IF NOT EXISTS scrape_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  deals_count INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT DEFAULT 'running',
  error_message TEXT
);
