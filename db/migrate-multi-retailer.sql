-- Migration: Add multi-retailer support
-- Adds brand and promo_type columns, Carter's retailer + source

-- Add new columns to deals table
ALTER TABLE deals ADD COLUMN brand TEXT;
ALTER TABLE deals ADD COLUMN promo_type TEXT;

-- Add new indexes
CREATE INDEX IF NOT EXISTS idx_deals_promo_type ON deals(promo_type);
CREATE INDEX IF NOT EXISTS idx_deals_brand ON deals(brand);

-- Add Carter's Oshkosh as active retailer
INSERT OR IGNORE INTO retailers (name, slug, website, scrape_source, is_active) VALUES
  ('Carter''s Oshkosh', 'carters', 'https://www.cartersoshkosh.ca', 'manual', 1);

-- Add manual extract source for Carter's
INSERT OR IGNORE INTO scrape_sources (retailer_id, name, slug, url) VALUES
  ((SELECT id FROM retailers WHERE slug = 'carters'), 'Manual Extract', 'manual-extract', NULL);

-- Set promo_type for existing Costco deals
UPDATE deals SET promo_type = 'Instant Savings' WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'costco') AND promo_type IS NULL;
