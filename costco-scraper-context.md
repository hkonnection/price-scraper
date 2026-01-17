# Costco Price Scraper - Project Context

This document summarizes the requirements and decisions from our planning conversation for building a Costco.ca price scraper web app.

## Project Overview

A bespoke web app for Angela (John's wife) to track Costco deals and savings.

## Core Requirements

1. **Scrape costco.ca for prices** - authenticated scraping using Costco member login
2. **Calculate percentage savings** - this is the PRIMARY value Angela wants
3. **Calculate unit pricing** - per gram, per box, per item, etc. (secondary priority)

## Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scraping scope | Deals/sale section only | Angela primarily cares about % savings, not full catalog |
| Environment | Local for testing, server when ready | Keep credentials secure during dev |
| Login approach | Fully automated first | Accept it may break and need maintenance |
| Bot detection | Monitor and decide later | "Works until it doesn't" approach accepted |

## Technical Approach

### Why Playwright/Puppeteer?
- Costco.ca is JavaScript-heavy
- Prices render client-side, so simple HTTP requests won't work
- Need a real browser to execute JS and render prices

### Scraping Flow
```
1. Launch headless browser
2. Login with credentials (stored in .env, not hardcoded)
3. Navigate to deals/sale section
4. Wait for price elements to render
5. Parse HTML, extract product data
6. Rate-limit between requests to avoid detection
7. Generate HTML output with sortable results
```

## Data Model

### What counts as "on sale"
- Items with strikethrough original price + sale price
- "Save $X" badges
- Warehouse instant savings vs online pricing

### Percentage calculation
```
savings_percent = (original_price - sale_price) / original_price * 100
```

### Unit pricing (lower priority, messier problem)
Costco product titles are inconsistent:
- "Kirkland Signature Olive Oil, 2 x 1L"
- "Bounty Paper Towels, 12-count"
- "Chicken Breast, ~2kg" (variable weight)

Options discussed:
- Best-effort regex/AI parsing (accept some errors)
- Manual override system where Angela can correct
- Only show unit price when confidence is high

## Project Structure (Scaffolded)

```
costco-scraper/
├── src/
│   ├── index.ts      # Entry point - orchestrates everything
│   ├── auth.ts       # Login flow
│   ├── scraper.ts    # Deal extraction (selectors need validation)
│   ├── output.ts     # HTML generation with sorting/filtering UI
│   └── types.ts      # TypeScript interfaces
├── public/           # Generated HTML output goes here
├── .env.example      # Credential template
├── SPEC.md           # Full spec document
└── README.md         # Setup instructions
```

## Output Features

The HTML output should include:
- Sortable columns (% off, price, dollar savings)
- Search/filter controls
- Visual indicator for high-value deals (e.g., cards turn green for 30%+ deals)

## Setup Instructions

```bash
# Install dependencies
npm install

# Install Playwright browsers (first time only)
npx playwright install chromium

# Copy environment template and add credentials
cp .env.example .env
```

### Environment Variables (.env)
```
COSTCO_EMAIL=your@email.com
COSTCO_PASSWORD=your_password
HEADLESS=false  # Set true for production
```

## Known Challenges

1. **Selectors will need updating** - Costco can change their website structure at any time. First run will likely fail until actual selectors are identified for:
   - Login form field IDs
   - Deals page URL
   - Product card selectors
   - Price element selectors

2. **Bot detection** - Costco may block scraping, require CAPTCHA, or rate-limit. Build in:
   - Delays between requests
   - Session cookie reuse
   - Headed mode fallback for manual CAPTCHA solving

3. **Maintenance overhead** - Accept this is a "works until it doesn't" tool requiring periodic fixes

## Phase 1 Research Needed

Before the scraper will work, need to identify:
1. Actual login form field IDs on Costco.ca
2. Exact URL for the deals/sale section
3. CSS selectors for product cards
4. CSS selectors for original price, sale price, product name

**Recommendation:** Run in headed mode (`HEADLESS=false`) and inspect elements manually to get correct selectors.

## Future Ideas (Not in initial scope)

- [ ] Price history tracking with SQLite
- [ ] Category filtering interface
- [ ] Email alerts for deals above threshold
- [ ] Docker containerization
- [ ] Scheduled runs (cron)
- [ ] Cross-product comparison (e.g., "all olive oils ranked by $/L")

## Troubleshooting Guide

**Login fails:**
- Check credentials in `.env`
- Costco may require CAPTCHA - run in headed mode and complete manually
- Session may have expired - try again

**No deals found:**
- Page structure may have changed
- Run in headed mode to inspect the actual HTML
- Update selectors in `scraper.ts`

**Rate limited:**
- Add delays between requests in `scraper.ts`
- Don't run too frequently

---

*Original conversation: https://claude.ai/chat/8a1a4b4d-a5b8-4c75-ab1c-6c09d4014dbe*
