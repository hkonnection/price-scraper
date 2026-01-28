# Price Scraper - Project Memory

Work sessions in descending order.

---

## 2026-01-28 (Tuesday) — Multi-Retailer Deploy & Carter's Import Testing

**Goal:** Deploy multi-retailer feature, run D1 migrations, test Carter's import

### What was done:

**Database Migration (run manually on Cloudflare D1 console):**
- Added `brand` and `promo_type` columns to deals table
- Added Carter's Oshkosh retailer (id=3, scrape_source='manual')
- Added Manual Extract scrape source for Carter's (retailer_id=3)
- Created indexes on brand and promo_type columns

**Code Deployment:**
- Committed and merged `feature/multi-retailer-deals` branch to main
- Commit `b870655`: feat: multi-retailer support with Carter's import
- Cloudflare Pages auto-deployed

**New Files Created:**
- `apps/web/src/app/components/DealsPageClient.tsx` — Client wrapper with filters
- `apps/web/src/app/components/ImportModal.tsx` — JSON paste import modal
- `apps/web/src/app/api/import-deals/route.ts` — POST endpoint for imports
- `scraper/src/cleaners/carters.js` — Carter's data cleaner
- `scraper/src/cleaners/costco.js` — Costco data cleaner
- `scraper/src/cleaners/index.js` — Cleaner registry

**UI Features Deployed:**
- Retailer dropdown (defaults to Costco, includes "All Retailers")
- Category and sale type filters (dynamic based on selected retailer)
- Import button (only shows for manual-source retailers)
- Retailer badges in "All Retailers" view
- Brand display in product cells

**Carter's Extraction Testing:**
- New sale URL: `https://www.cartersoshkosh.ca/en_CA/carters-sale?sz=3000`
- Discovered DOM render limit: site caps at 2000 product tiles regardless of sz parameter
- Total inventory shows 2,648 but only 2,000 extractable
- Extracted 2,000 products for initial import test

### Pending / Future Enhancements:
- [ ] Import with sale category selector (Clearance, $10 & Under, Valentine's, etc.)
- [ ] Deduplication with category merging (same product in multiple sales)
- [ ] R2 image storage (free tier: 10GB storage, 10M reads/month)
- [ ] Multi-category import workflow for Carter's sections

### Key Learning:
- `PRAGMA table_info(tablename);` — SQLite command to inspect table schema
- Carter's DOM caps at 2000 rendered products regardless of URL parameters

---

## 2026-01-27 (Monday) — Angela's Feature Requirements

**Source:** Requirements from Angela (John's wife)

### Requirements:
1. **Unified deal list across all retailers** — One large combined list, sorted by best discount % by default
2. **Retailer dropdown filter** — Selector with "All Retailers" (default) plus individual retailer options
3. **Multi-retailer support** — Each retailer has its own scrape history and data pipeline
4. **Easy to add new retailers** — Some automated (Costco via Cocowest), some manual (Carter's via console extract)

### Implementation notes:
- DB schema already supports multi-retailer (retailers, scrape_sources, deals with retailer_id FK)
- Frontend needs: retailer filter dropdown, combined query sorted by savings_percent
- Backend needs: API query with optional retailer filter param
- Need manual import UI for retailers blocked by bot protection (Carter's, possibly others)
- Each new retailer needs: retailer record, scrape_source record, scraper or import method

### Pending work:
- [x] Add Carter's to retailers table (active) — Done 2026-01-28
- [x] Build retailer dropdown filter on frontend — Done 2026-01-28
- [x] Update API to support retailer filtering — Done 2026-01-28 (client-side filtering)
- [x] Create import endpoint to push Carter's data to D1 — Done 2026-01-28
- [x] Build manual import UI (paste JSON) — Done 2026-01-28
- [ ] Research additional Canadian retailers for scrapeability

---

## 2026-01-26 (Sunday) — Carter's Oshkosh Canada Scraping Research

**Goal:** Figure out scraping plan for https://www.cartersoshkosh.ca/

### What was done:
- Explored full project architecture (tech stack, DB schema, scraper patterns, GitHub Actions workflow)
- Investigated cartersoshkosh.ca for scrapeability
  - Discovered **PerimeterX** enterprise bot protection (px-cloud.net)
  - Simple HTTP fetch returns 403
  - Playwright headless browser blocked on category pages with "Press & Hold" CAPTCHA
  - Even navigating from homepage to clearance triggers CAPTCHA
- Searched all Canadian deal aggregator sites for Carter's data:
  - Flyerdeals.ca — no active flyer
  - SmartCanucks — only stale 2019 flyers
  - Shopping-Canada.com — no active flyers
  - RedFlagDeals — no offers listed
  - Flipp — Carter's not on platform at all
- **Conclusion:** No third-party aggregator has Carter's Canada data. Deals exist only on their protected site.
- Decided on **manual extraction** approach
- Discovered `?sz=1200` URL parameter to load all products in a single page load
- Built browser console extraction script with exact Salesforce Commerce Cloud (Demandware SFRA) selectors
- Successfully extracted **1,145 clearance products** manually
- Created `cleanCartersData.js` utility to normalize raw data (fix discount text, calculate savings)
- Output: `carter-cleaned.json` with all 1,145 products cleaned and ready for import

### Key findings:
- Carter's Canada runs on Salesforce Commerce Cloud (SFRA) with Vue.js
- PerimeterX blocks automated access — not worth fighting
- Manual flow: browse `?sz=1200` → solve CAPTCHA → run console script → paste JSON
- Clearance items have no end date (prices as marked)

### Pending:
- [x] Add Carter's as retailer in D1 database — Done 2026-01-28
- [x] Create import endpoint to push cleaned data to D1 — Done 2026-01-28
- [x] Build manual import UI (paste JSON workflow) — Done 2026-01-28

---

## 2026-01-25 (Saturday) — Bug Fix

### What was done:
- Fixed type assertion in RefreshButton response for Cloudflare Pages build

### Commits:
- `c36a191` fix(web): add type assertion to RefreshButton response

---

## 2026-01-24 (Saturday) — Major Feature Build

**Goal:** Get the scraper fully functional with frontend

### What was done:
- Fixed Cocowest parser to match actual page format
- Merged D1 database setup branch (PR #1)
- Added product images and product codes to scraper output
- Added scrape history tracking with batch IDs for audit trail
- Set up weekly auto-scrape GitHub Actions schedule (Monday & Thursday 9am PST)
- Built full Next.js frontend with sortable deals table
- Fixed D1 type declarations for Cloudflare Pages build
- Added image modal and improved date formatting in UI
- Implemented multi-post scraping with validity dates + manual trigger button

### Commits:
- `1660548` feat: multi-post scraping with validity dates + trigger button
- `2859189` feat(web): add image modal and improve date format
- `ee2dbb7` chore: update package-lock.json for workers-types
- `87c5c8f` fix(web): add D1 type declarations for Cloudflare Pages build
- `e43d330` feat(web): add frontend with sortable deals table
- `afe6742` feat(workflow): add weekly auto-scrape schedule
- `8045466` feat(scraper): add scrape history tracking with batch IDs
- `ee9ce28` feat(scraper): add product images and product codes
- `8bd52ac` Merge branch 'chore/d1-database-setup'
- `adb6ec9` fix(scraper): update Cocowest parser to match actual page format
- `c0be104` Merge pull request #1 from hkonnection/chore/d1-database-setup

---

## 2026-01-17 (Saturday) — Project Inception

**Goal:** Set up the price scraper project from scratch

### What was done:
- Initial project scaffold for Costco price scraper
- Set up Cloudflare D1 database with multi-retailer schema (retailers, scrape_sources, deals, scrape_history tables)
- Configured GitHub Actions scrape workflow
- Multiple Next.js compatibility fixes for Cloudflare Pages (v14 → v15)

### Commits:
- `9df63e4` Initial project scaffold for Costco price scraper
- `eba6867` chore: set up D1 database with multi-retailer schema
- `976e0be` fix: update Next.js to ^14.3.0 for cloudflare compatibility
- `6abb72c` Update scrape.yml
- `76e29b6` Update scrape.yml
- `db1e927` Update scrape.yml
- `b4ed3f7` fix(web): update Next.js to ^15.0.0 for Cloudflare compatibility

---

## Architecture Reference

| Component | Technology |
|-----------|-----------|
| Frontend | Next.js 15 on Cloudflare Pages |
| Database | Cloudflare D1 (SQLite) |
| Scraper | Node.js + Cheerio |
| Automation | GitHub Actions (cron + webhook) |
| Active retailers | Costco (auto via Cocowest), Carter's Oshkosh (manual import) |
| Image storage | Hotlinked (future: Cloudflare R2) |

## Browser Console Extraction Script (Carter's)

URL: `https://www.cartersoshkosh.ca/en_CA/carters-sale?sz=3000`

```javascript
const products = [];
document.querySelectorAll('.product[data-pid]').forEach(tile => {
  const pid = tile.dataset.pid || '';
  const brand = tile.querySelector('.product-tile-brand')?.textContent?.trim() || '';
  const name = tile.querySelector('.product-tile-title')?.textContent?.trim() || '';
  const salePrice = tile.querySelector('.product-tile-price-sale .value')?.getAttribute('content') || '';
  const origPrice = tile.querySelector('.product-tile-price-original .value')?.getAttribute('content') || '';
  const discount = tile.querySelector('.discount')?.textContent?.trim() || '';
  const image = tile.querySelector('.tile-image')?.src || '';
  const promo = tile.querySelector('.promotion-callout-text')?.textContent?.trim() || '';
  if (name) {
    products.push({ product_code: pid, brand, product_name: name, sale_price: parseFloat(salePrice) || 0, regular_price: parseFloat(origPrice) || 0, discount, promo, image_url: image });
  }
});
copy(products);
console.log(`Extracted ${products.length} products - copied to clipboard`);
```

Note: Site caps at 2000 DOM elements regardless of sz parameter.
