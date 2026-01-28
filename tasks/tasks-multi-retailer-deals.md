## Relevant Files

- `db/schema.sql` - Database schema; needs `brand` and `promo_type` columns added to deals, Carter's retailer/source seed data
- `scraper/src/db/d1.js` - D1 database operations; needs updated INSERT to include `brand` and `promo_type` fields
- `scraper/src/utils/cleanCartersData.js` - Carter's data cleaning utility; needs to be adapted as a retailer-specific cleaner
- `apps/web/src/app/page.tsx` - Main page server component; needs retailer filter query param support and dynamic header
- `apps/web/src/app/components/DealsTable.tsx` - Deals table; needs retailer column/badge, filter state, updated stats
- `apps/web/src/app/components/RetailerFilter.tsx` - New: retailer dropdown + sale type + category filter bar
- `apps/web/src/app/components/ImportModal.tsx` - New: JSON import modal for manual-source retailers
- `apps/web/src/app/api/import-deals/route.ts` - New: API endpoint for importing deal JSON
- `apps/web/src/app/globals.css` - Styling updates for filter bar, retailer badges, import modal

### Notes

- No test framework is currently set up in this project. Testing will be done via dry-run scripts and manual verification.
- D1 queries use string interpolation with `escapeSql()` — not parameterized. Be mindful of this when adding new queries.
- The frontend runs on Cloudflare Pages (edge). Server components can access D1 directly via `getRequestContext()`.

## Instructions for Completing Tasks

**IMPORTANT:** As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout a new branch: `git checkout -b feature/multi-retailer-deals`

- [ ] 1.0 Database schema changes
  - [ ] 1.1 Add `brand` column (TEXT, nullable) to the `deals` table in `db/schema.sql`
  - [ ] 1.2 Add `promo_type` column (TEXT, nullable) to the `deals` table in `db/schema.sql` for sale type filtering (e.g., "Clearance", "Instant Savings", "Doorcrasher")
  - [ ] 1.3 Add Carter's Oshkosh Canada to the `retailers` seed data (name: "Carter's Oshkosh", slug: "carters", website: "https://www.cartersoshkosh.ca", scrape_source: "manual", is_active: 1)
  - [ ] 1.4 Add a scrape source record for Carter's (name: "Manual Extract", slug: "manual-extract", retailer_id referencing Carter's)
  - [ ] 1.5 Add index on `deals(promo_type)` for sale type filtering performance
  - [ ] 1.6 Add index on `deals(brand)` for brand filtering performance
  - [ ] 1.7 Run the schema migration against the D1 database (ALTER TABLE for existing data, INSERT for new records)

- [ ] 2.0 Build retailer-specific data cleaning architecture
  - [ ] 2.1 Create `scraper/src/cleaners/` directory for retailer-specific cleaning modules
  - [ ] 2.2 Create `scraper/src/cleaners/carters.js` — move and adapt cleaning logic from `scraper/src/utils/cleanCartersData.js`. Must: extract numeric discount %, calculate savings_amount, set promo_type to "Clearance", set brand from input data, set valid_from to import date, set valid_to to null
  - [ ] 2.3 Create `scraper/src/cleaners/costco.js` — extract cleaning logic for Costco deals. Must: set promo_type to "Instant Savings", set brand to "Costco/Kirkland" as appropriate
  - [ ] 2.4 Create `scraper/src/cleaners/index.js` — cleaner registry that exports a `getCleaner(retailerSlug)` function returning the appropriate cleaning module for a given retailer
  - [ ] 2.5 Update `scraper/src/db/d1.js` `pushToD1()` function to include `brand` and `promo_type` fields in the INSERT statement

- [ ] 3.0 Build deal import API endpoint
  - [ ] 3.1 Create `apps/web/src/app/api/import-deals/route.ts` with a POST handler
  - [ ] 3.2 The POST handler must accept JSON body with: `retailer` (slug string) and `deals` (array of deal objects)
  - [ ] 3.3 Validate that `retailer` is a valid, active retailer with source type "manual"
  - [ ] 3.4 Validate that `deals` is a non-empty array with required fields (product_name, sale_price, regular_price at minimum)
  - [ ] 3.5 Look up the appropriate cleaner for the retailer using the cleaner registry
  - [ ] 3.6 Clean/normalize the deal data using the retailer-specific cleaner
  - [ ] 3.7 Call `pushToD1()` with the cleaned deals, retailer slug, and import metadata
  - [ ] 3.8 Return success response with count of imported deals, or error response with validation details
  - [ ] 3.9 Add environment variables/bindings needed for D1 access in the API route

- [ ] 4.0 Add retailer filter dropdown to frontend
  - [ ] 4.1 Create `apps/web/src/app/components/RetailerFilter.tsx` as a client component
  - [ ] 4.2 Add a `<select>` dropdown with "Costco" as the default selected option
  - [ ] 4.3 Add "All Retailers" as an option that shows the combined deal list
  - [ ] 4.4 Dynamically populate retailer options by querying the `retailers` table for active retailers
  - [ ] 4.5 On selection change, filter the displayed deals by `retailer_id` (client-side filtering from the full dataset, or re-query with param)
  - [ ] 4.6 Update page header text dynamically to reflect the selected retailer (e.g., "Costco Deals" → "Carter's Oshkosh Deals" → "All Retailer Deals")
  - [ ] 4.7 Update summary stats (total deals, avg savings %, best deal %) to reflect the filtered dataset
  - [ ] 4.8 Integrate the RetailerFilter component into `page.tsx` above the DealsTable

- [ ] 5.0 Add sale type and category filters to frontend
  - [ ] 5.1 Add a sale type filter (dropdown or multi-select) to `RetailerFilter.tsx` with options derived from distinct `promo_type` values in the deals data (e.g., Clearance, Instant Savings, Doorcrasher)
  - [ ] 5.2 Add a category filter (dropdown or multi-select) to `RetailerFilter.tsx` with options derived from distinct `category` values in the deals data
  - [ ] 5.3 Implement combined filtering logic — all filters (retailer + sale type + category) must work together. Deals must match ALL active filters
  - [ ] 5.4 Ensure the default sort remains `savings_percent` descending regardless of which filters are active
  - [ ] 5.5 Style the filter bar to be responsive — filters stack vertically on mobile, display inline on desktop

- [ ] 6.0 Build JSON import modal for manual-source retailers
  - [ ] 6.1 Create `apps/web/src/app/components/ImportModal.tsx` as a client component
  - [ ] 6.2 Add an "Import" button that is only visible when a retailer with source type "manual" is selected in the retailer dropdown
  - [ ] 6.3 Clicking "Import" opens a modal dialog with: retailer name in the header, a large `<textarea>` for pasting JSON, a "Submit" button, and a "Cancel" button
  - [ ] 6.4 On submit, POST the JSON to `/api/import-deals` with the selected retailer slug
  - [ ] 6.5 Show a loading spinner during the import request
  - [ ] 6.6 On success, display the count of imported deals and close the modal. Refresh the deal list
  - [ ] 6.7 On error, display the error message inline in the modal (do not close)
  - [ ] 6.8 Add basic JSON validation on the client side before submitting (must be valid JSON, must be an array)

- [ ] 7.0 Update deal list to support multi-retailer display
  - [ ] 7.1 Add a "Retailer" column or badge to each deal row in `DealsTable.tsx` — visible in "All Retailers" view, optionally hidden when a single retailer is selected
  - [ ] 7.2 Add a "Brand" column or sub-text for multi-brand retailers (Carter's has Carter's, OshKosh, Otter Avenue, Little Planet, Skip Hop)
  - [ ] 7.3 Ensure all column sorting (Product, Category, Regular Price, Sale Price, $ Off, % Off) works correctly in both single-retailer and combined views
  - [ ] 7.4 Update the `Deal` interface/type to include `brand`, `promo_type`, and `retailer_name` fields
  - [ ] 7.5 Update `page.tsx` query to JOIN retailers table and return `retailer_name` with each deal
  - [ ] 7.6 Style retailer badges with distinct colors or icons so deals are visually identifiable in the combined view

- [ ] 8.0 Import initial Carter's data and verify end-to-end flow
  - [ ] 8.1 Ensure Carter's retailer and source records exist in D1 (run migration from task 1.7)
  - [ ] 8.2 Use the import modal to paste the contents of `carter-cleaned.json` (1,145 products)
  - [ ] 8.3 Verify Carter's deals appear in the table when "Carter's Oshkosh" is selected in the dropdown
  - [ ] 8.4 Verify "All Retailers" shows both Costco and Carter's deals combined, sorted by discount %
  - [ ] 8.5 Verify filters (sale type, category) work correctly with Carter's data
  - [ ] 8.6 Verify Costco automated scraping still works (trigger a manual refresh and confirm no regression)
  - [ ] 8.7 Update `memory.md` with completion notes
