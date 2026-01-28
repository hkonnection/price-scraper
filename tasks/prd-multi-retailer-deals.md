# PRD: Multi-Retailer Deal Aggregator

## Introduction/Overview

The Price Scraper currently supports a single retailer (Costco via Cocowest). This feature expands the platform into a **multi-retailer deal aggregator** — a unified interface where users can browse deals across multiple Canadian retailers (Costco, Carter's Oshkosh, and future retailers), filter by retailer/category/sale type, and always see the best discounts first.

Some retailers (like Costco) can be scraped automatically. Others (like Carter's Oshkosh) require manual data extraction due to enterprise bot protection (PerimeterX). The system must support both automated and manual import pipelines, with each retailer potentially having its own unique import method.

**Problem it solves:** Angela (primary user) wants to quickly find the best deals across multiple stores without visiting each retailer's website individually. Currently, only Costco deals are available.

---

## Goals

1. **Unified deal browsing** — All retailer deals in one sortable, filterable list, sorted by discount percentage by default
2. **Multi-retailer support** — Add Carter's Oshkosh Canada as the second retailer, with architecture to easily add more
3. **Per-retailer import pipelines** — Each retailer can have its own data acquisition method (automated scraping, manual JSON import, etc.)
4. **Manual import UI** — A retailer-specific import modal that accepts JSON data for retailers that can't be scraped automatically
5. **Flexible filtering** — Filter by retailer, sale type (Clearance, Doorcrasher, etc.), and product category
6. **Low-maintenance** — Manual imports happen monthly or ad-hoc; automated scrapes continue on schedule

---

## User Stories

1. **As Angela**, I want to see all deals from all retailers in one list sorted by best discount so I can quickly find the best bargains without checking multiple websites.

2. **As Angela**, I want to filter deals by retailer (e.g., show only Carter's) so I can focus on a specific store when I know what I'm looking for.

3. **As Angela**, I want to filter by sale type (Clearance, Doorcrasher, Surprise Sale) and category (clothing, food, electronics) so I can narrow down relevant deals.

4. **As John**, I want to import Carter's deal data by pasting JSON into a modal so I can update the deal list manually without needing developer tools or database access.

5. **As John**, I want each retailer's import to be independent so that updating one retailer doesn't affect another's data.

6. **As John**, I want the system to be easily extensible so I can add new retailers in the future with their own import methods.

7. **As Angela**, I want to optionally share this tool with friends in the future (not in scope now, but the system should not have hard blockers for this).

---

## Functional Requirements

### FR1: Retailer Management
1.1. The system must support multiple active retailers in the database.
1.2. Each retailer must have a name, slug, website URL, scrape source type, and active/inactive status.
1.3. Carter's Oshkosh Canada must be added as an active retailer with source type "manual".
1.4. Each retailer must have its own independent scrape/import history.

### FR2: Unified Deal List
2.1. The default view must show **Costco** deals (the primary retailer). Users can switch to "All Retailers" via the dropdown to see a combined list from every active retailer.
2.2. Both single-retailer and combined views must be sorted by `savings_percent` descending (best deals first) by default.
2.3. Each deal row must display: product name, brand (for multi-brand retailers like Carter's), retailer name/logo, regular price, sale price, dollar savings, percent savings, and sale type badge.
2.4. Product images must be displayed (clickable to enlarge, using existing image modal).
2.5. The existing sortable column headers (Product, Category, Regular Price, Sale Price, $ Off, % Off) must continue to work.

### FR3: Retailer Filter Dropdown
3.1. A `<select>` dropdown must be displayed above the deals table.
3.2. The default selected option must be **"Costco"** (the primary retailer).
3.3. The dropdown must include an **"All Retailers"** option that combines deals from every active retailer into one unified list. This combined list must remain fully sortable by all columns (Product, Category, Regular Price, Sale Price, $ Off, % Off).
3.4. The dropdown must list all active retailers as individual filter options (e.g., Costco, Carter's Oshkosh, and any future retailers).
3.5. Selecting a different retailer must filter the deal list to show only that retailer's deals.
3.6. The "All Retailers" combined view must display a retailer identifier (name or badge) on each deal row so the user can tell which store a deal belongs to.
3.7. The deal count and summary stats (total deals, avg savings %, best deal %) must update to reflect the current filter selection.

### FR4: Additional Filters
4.1. A **sale type** filter must allow filtering by promotion type (e.g., Clearance, Doorcrasher, Surprise Sale, Instant Savings). These values come from the `category` or a new `promo_type` field on deals.
4.2. A **category** filter must allow filtering by product category (e.g., Clothing, Food & Grocery, Electronics, Health & Wellness, Household, etc.).
4.3. Filters must be combinable — e.g., show only Carter's + Clearance + Clothing.
4.4. Regardless of active filters, the list must always be sortable by any column, with discount percentage as the default sort.

### FR5: Manual Import (JSON Paste Modal)
5.1. When a retailer with source type "manual" is selected in the retailer dropdown, an **Import** button must appear.
5.2. Clicking the Import button must open a modal dialog.
5.3. The modal must contain a large text area for pasting JSON data.
5.4. The modal must have a "Submit" button that sends the JSON to the backend for processing.
5.5. The backend must validate the JSON structure before importing.
5.6. On successful import, the system must:
   - Clean/normalize the data (strip extra text from discount fields, calculate savings, etc.)
   - Create a scrape history record for audit trail
   - Delete old deals for that retailer
   - Insert new deals
   - Return a success message with the count of imported deals
5.7. On validation failure, the system must display a clear error message indicating what's wrong.
5.8. The import must be retailer-specific — each retailer may have its own JSON shape and cleaning logic.

### FR6: Retailer-Specific Import Logic
6.1. The system must support registering different data cleaning/normalization functions per retailer.
6.2. For Carter's Oshkosh, the expected JSON format is an array of objects with: `product_code`, `brand`, `product_name`, `sale_price`, `regular_price`, `discount`, `image_url`.
6.3. The cleaning logic for Carter's must: extract numeric discount percentage from the `discount` text field, calculate `savings_amount`, set `category` to "Clearance", set `valid_from` to import date, set `valid_to` to null.
6.4. Future retailers must be able to define their own JSON format and cleaning logic without modifying existing retailer code.

### FR7: Database Changes
7.1. Add Carter's Oshkosh Canada to the `retailers` table (name: "Carter's Oshkosh", slug: "carters", website: "https://www.cartersoshkosh.ca", scrape_source: "manual", is_active: 1).
7.2. Add a scrape source record for Carter's (name: "Manual Extract", slug: "manual-extract").
7.3. The `deals` table must support a `brand` field (for multi-brand retailers — Carter's has Carter's, OshKosh, Otter Avenue, Little Planet, Skip Hop brands).
7.4. The `deals` table should support a `promo_type` field (Clearance, Doorcrasher, Surprise Sale, Instant Savings, etc.) separate from `category`.

---

## Non-Goals (Out of Scope)

- **Automated scraping of Carter's** — PerimeterX bot protection makes this impractical. Manual JSON import is the chosen approach.
- **User authentication** — The app is for family use. No login/auth system needed now.
- **Visual extraction guide** — Step-by-step screenshots/graphics showing how to extract data from each retailer's website. This is a future milestone after the baseline is built.
- **Push notifications or deal alerts** — Not in scope for this phase.
- **Price history tracking** — Each import replaces old deals; historical price trend tracking is not included.
- **Adding more retailers beyond Carter's** — The architecture must support it, but only Carter's is being added now.
- **Mobile app** — Web-only, responsive design is sufficient.

---

## Design Considerations

### UI Layout
- **Filter bar** at the top of the deals table: Retailer dropdown (left), Sale Type filter, Category filter, and Import button (right, conditional).
- **Import modal**: Clean, simple dialog with a large `<textarea>`, retailer name in the header, a Submit button, and a Cancel button. Show a spinner during import. Show success/error feedback inline in the modal.
- **Retailer badges**: Each deal row should show the retailer name (small text or colored badge) so deals are identifiable in the "All Retailers" combined view.

### Responsive Design
- Filters should stack vertically on mobile.
- The existing horizontal scroll on the deals table should continue to work on mobile.

---

## Technical Considerations

### Existing Architecture
- **Frontend**: Next.js 15 on Cloudflare Pages (Server Components + Client Components)
- **Database**: Cloudflare D1 (SQLite) via REST API
- **Scraper**: Node.js + Cheerio, triggered by GitHub Actions
- **Current schema**: Already has `retailers`, `scrape_sources`, `deals`, `scrape_history` tables with proper foreign keys

### API Changes
- The page query must accept an optional `retailer` parameter (slug or "all").
- The page query must accept optional `promo_type` and `category` filter parameters.
- A new API route (`POST /api/import-deals`) must handle JSON imports, scoped to a specific retailer.

### Data Cleaning Architecture
- Create a registry/map of retailer-specific cleaning functions (e.g., `cleaners/carters.js`, `cleaners/costco.js`).
- The import API route looks up the appropriate cleaner by retailer slug and applies it before inserting into D1.

### Schema Migration
- Add `brand` column to `deals` table (TEXT, nullable).
- Add `promo_type` column to `deals` table (TEXT, nullable — e.g., "Clearance", "Instant Savings").
- Insert Carter's retailer and scrape source records.

### Existing Costco Integration
- Costco deals from Cocowest must continue to work unchanged.
- Costco's `category` field (Health & Wellness, Electronics, etc.) maps to the category filter.
- Costco's promo type is "Instant Savings" (all Cocowest deals follow this format).

---

## Success Metrics

1. **All retailers visible in one view** — Deals from Costco and Carter's appear together in the default "All Retailers" view, sorted by discount %.
2. **Filtering works correctly** — Selecting a retailer filters the list; combining filters (retailer + sale type + category) narrows results appropriately.
3. **Manual import works end-to-end** — John can paste Carter's JSON into the modal, submit it, and see the deals appear in the table within seconds.
4. **No regression** — Costco automated scraping continues to work on its Monday/Thursday schedule without changes.
5. **Extensible** — Adding a third retailer requires only: a new retailer DB record, a new cleaning function, and optionally a browser console extraction script. No core system changes needed.

---

## Open Questions

1. **Brand vs. Retailer display**: In the combined view, should we show "Carter's" (the retailer) or "OshKosh" (the brand within Carter's) as the identifier? Or both?
2. **Stale data handling**: Carter's imports are monthly/ad-hoc. Should deals older than X days be auto-hidden or marked as "potentially outdated"?
3. **Future sharing**: If Angela shares with friends, do we need any level of access control, or is a public URL acceptable?
4. **Additional retailers**: Which other Canadian retailers is Angela interested in? This informs whether we need more automated scrapers or mostly manual import flows.
