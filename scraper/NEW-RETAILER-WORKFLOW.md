# New Retailer Worktree Workflow

**Trigger command:** `@new-retailer [retailer-name]`

Follow this workflow to create a new retailer scraper in an isolated git worktree.

## Step 1: Validate Retailer (BEFORE Creating Worktree)

**DO NOT create a worktree until validation passes.** First, explore the retailer's website to confirm it's scrapable:

1. Navigate to the retailer's deals/sale page
2. Check for essential data availability:
   - **Original prices** (`compare_at_price` for Shopify, or equivalent)
   - **Sale prices**
   - **Product names and brands**
   - **Images**
   - **Product URLs** (link to product page - required for clickable titles)
3. For Shopify sites, test the JSON endpoints:
   - `/collections/[sale-collection].json` - collection metadata
   - `/collections/[sale-collection]/products.json` - product data with pricing
4. Verify `compare_at_price` is populated (not null) - this is required to calculate savings percentages

**If validation fails** (e.g., no original prices available):
- Report the issue to John with specifics
- Wait for decision before proceeding
- Do NOT create the worktree

**If validation passes:**
- Summarize the data structure found
- Recommend scraping approach
- Proceed to Step 2

## Step 2: Create the Worktree
```bash
git worktree add ../price-scraper-[retailer-slug] -b feature/[retailer-slug]-retailer
```

## Step 3: Determine Scraping Approach
Based on validation findings, choose the implementation approach:
- **Playwright** (JavaScript-rendered sites) - runs on GitHub Actions
- **Cheerio/fetch** (static HTML sites, JSON endpoints) - simpler, faster
- **Manual extraction** (complex auth/anti-bot) - browser console script

Document the specific endpoints/pages to scrape and the data mapping.

## Step 4: Create Required Files
In the worktree directory, create:

| File | Purpose |
|------|---------|
| `scraper/src/scrapers/[retailer].js` | Scraper logic (fetch/parse deals) |
| `scraper/src/cleaners/[retailer].js` | Data normalizer (calculate savings %) |
| `scraper/src/[retailer]-index.js` | Entry point |
| `.github/workflows/scrape-[retailer].yml` | GitHub Actions workflow |

Update existing files:
| File | Change |
|------|--------|
| `scraper/src/cleaners/index.js` | Register new cleaner |
| `scraper/package.json` | Add scripts, dependencies if needed |

## Step 5: Database Setup (Manual on Cloudflare D1)
Check `db/schema.sql` for exact column names, then provide SQL:
```sql
-- Add retailer
INSERT OR IGNORE INTO retailers (name, slug, website, scrape_source, is_active) VALUES
  ('[Retailer Name]', '[slug]', 'https://[website]', '[scrape-method]', 1);

-- Add scrape source
INSERT OR IGNORE INTO scrape_sources (retailer_id, name, slug, url) VALUES
  ((SELECT id FROM retailers WHERE slug = '[slug]'), '[Source Name]', '[source-slug]', '[deals-url]');
```

## Step 6: Test Locally
```bash
cd ../price-scraper-[retailer-slug]/scraper
npm install
# If using Playwright:
npx playwright install chromium
npm run scrape:[retailer]:dry
```

## Step 7: Commit and Merge
```bash
git add -A
git commit -m "feat(scraper): add [retailer] scraper"
git push -u origin feature/[retailer-slug]-retailer
gh pr create --base main
# After merge:
git worktree remove ../price-scraper-[retailer-slug]
```

## Data Standards

### Required Fields
Each deal must include:
- `product_name` - Product title
- `brand` - Manufacturer/brand name
- `regular_price` - Original price before discount
- `sale_price` - Current sale price
- `savings_amount` - Dollar amount saved (regular - sale)
- `savings_percent` - Percentage saved (**two decimal places**: e.g., 31.52%)
- `image_url` - Product image
- `product_url` - Link to product page (enables clickable titles)

### Savings Percentage Calculation
Always calculate to **two decimal places**:
```javascript
const savingsPercent = Math.round((savingsAmount / regularPrice) * 10000) / 100;
// Result: 31.52 (not 31.5 or 32)
```

## Key Reminders
- Always check `db/schema.sql` before writing SQL (column names!)
- Test with `--dry-run` before pushing to D1
- Playwright scrapers need `npx playwright install chromium` step in GitHub Actions
- Each worktree needs its own `npm install`
- Always capture `product_url` for clickable product titles
