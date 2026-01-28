# Price Scraper - Project Memory

Work sessions in descending order.

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
- [ ] Add Carter's to retailers table (active)
- [ ] Build retailer dropdown filter on frontend
- [ ] Update API to support `?retailer=all|costco|carters` filter
- [ ] Create import script to push Carter's cleaned data to D1
- [ ] Build manual import UI (paste JSON / upload file)
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
- Add Carter's as retailer in D1 database
- Create import script to push cleaned data to D1
- Build manual import UI (paste JSON / upload file workflow)

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
| Current scrapers | Cocowest (Costco deals) |
| Pending scrapers | Carter's Oshkosh Canada (manual extract) |
