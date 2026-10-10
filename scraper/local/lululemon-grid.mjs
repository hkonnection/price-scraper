/** Inert grid parsing and ordinary visible-browser collection for Canadian sale sections. */
import * as cheerio from 'cheerio';

export const SECTIONS = Object.freeze([
  { name: 'Women', url: 'https://shop.lululemon.com/en-ca/c/women-we-made-too-much/n16o10z8mhd' },
  { name: 'Men', url: 'https://shop.lululemon.com/en-ca/c/men-we-made-too-much/n18mhdznrqw' },
  { name: 'Accessories', url: 'https://shop.lululemon.com/en-ca/c/we-made-too-much-accessories/n14w56z8mhd' },
]);
const GRID = '[data-testid="product-grid"]';
const TILE = '[data-testid="product-tile"]';

/** Require an actual UTC timestamp, never a scheduled date. @param {string} at Timestamp. @returns {void} @throws {Error} On malformed date. */
export function validateCaptureTime(at) {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw new Error('Invalid UTC capture timestamp.');
}

/** Apply the saved-grid reference name rules in their original order. @param {string} name Name. @param {string} section Section. @returns {string} Category. */
function categoryFor(name, section) {
  const rules = [
    [/jacket|outerwear|coat|vest|parka/i, 'Jackets & Outerwear'],
    [/hoodie|sweatshirt|pullover|half zip|half-zip|crew/i, 'Hoodies & Sweatshirts'],
    [/pant|trouser|jogger/i, 'Pants'], [/legging|tight/i, 'Leggings'], [/short/i, 'Shorts'],
    [/skirt|dress|skort/i, 'Skirts & Dresses'], [/\bbra\b|bras\b/i, 'Sports Bras'],
    [/tank|sleeveless/i, 'Tank Tops'], [/shirt|top|tee|polo|bodysuit|long sleeve|long-sleeve/i, 'Shirts & Tops'],
    [/sweater|cardigan/i, 'Sweaters'], [/sock/i, 'Socks'], [/underwear|boxer|brief|thong/i, 'Underwear'],
    [/bag|backpack|belt bag|tote|crossbody|pouch|duffle/i, 'Bags'],
    [/hat|headband|cap|beanie|toque|scrunchie|hair/i, 'Hats & Headwear'],
    [/shoe|sandal|sneaker|slide/i, 'Shoes'], [/bottle/i, 'Water Bottles'], [/\bmat\b/i, 'Yoga Mats'],
  ];
  return rules.find(([pattern]) => pattern.test(name))?.[1] || (section === 'Accessories' ? 'Accessories' : 'Other');
}

/** Keep the first row, allowing only a category upgrade. @param {Map} keep Retained rows. @param {object} row Later row. @returns {boolean} Whether newly retained. */
function retain(keep, row) {
  const previous = keep.get(row.product_code);
  if (!previous) { keep.set(row.product_code, { ...row }); return true; }
  if (previous.category === 'Other' && row.category !== 'Other') previous.category = row.category;
  return false;
}

/** Parse only tile descendants of one grid without executing markup or fetching resources. @param {string} html Grid outerHTML. @param {string} section Section name. @param {string} at Actual UTC timestamp. @param {Map<string,string>} prior Saved categories. @returns {object} Raw envelope and card accounting. @throws {Error} On missing/empty/unusable grids. */
export function parseGrid(html, section, at, prior = new Map()) {
  validateCaptureTime(at);
  if (!SECTIONS.some(s => s.name === section) || typeof html !== 'string' || !(prior instanceof Map)) throw new Error('Invalid grid capture input.');
  const $ = cheerio.load(html);
  const grids = $(GRID);
  if (grids.length !== 1) throw new Error('Expected exactly one product grid.');
  const tiles = grids.find(TILE);
  const stats = { cards: tiles.length, usable: 0, duplicates: 0, unusable: 0, priorCategories: 0 };
  const keep = new Map();
  for (const element of tiles.toArray()) {
    const tile = $(element);
    const anchor = tile.find('a[href*="/p/"]').toArray().find(a => $(a).text().trim());
    const name = anchor ? $(anchor).text().trim() : '';
    const href = anchor ? $(anchor).attr('href') : '';
    const code = href?.match(/\/p\/[^/]+\/([^/?#]+)/)?.[1];
    const prices = (tile.text().replace(/\s+/g, ' ').match(/\$[\d,]+(?:\.\d+)?/g) || []).map(s => Number(s.replace(/[$,]/g, '')));
    const original = tile.find('[class*="originalPrice"]').first();
    const regular = original.length ? Number(original.text().replace(/[^\d.]/g, '')) : Math.max(...prices);
    const sale = Math.min(...prices);
    if (!code || !name || !Number.isFinite(sale) || !Number.isFinite(regular) || sale <= 0 || regular <= sale) { stats.unusable++; continue; }
    const pathname = href.replace(/^https?:\/\/[^/]+/, '');
    const saved = prior.get(code);
    const category = typeof saved === 'string' && saved.trim() ? saved : categoryFor(name, section);
    if (typeof saved === 'string' && saved.trim()) stats.priorCategories++;
    const image = tile.find('img').first().attr('src') || tile.find('img').first().attr('data-src');
    const savings = Math.round((regular - sale) * 100) / 100;
    const row = { product_code: code, product_name: name, brand: 'Lululemon', regular_price: regular, sale_price: sale,
      savings_amount: savings, savings_percent: Math.round(savings / regular * 10000) / 100, category,
      image_url: image && /^https?:/.test(image) ? image.split('?')[0] : null,
      product_url: 'https://shop.lululemon.com' + (pathname.startsWith('/en-ca') ? pathname : '/en-ca' + pathname),
      valid_from: null, valid_to: null, in_stock: 1, scraped_at: at };
    stats.usable++;
    if (keep.has(code)) stats.duplicates++;
    else keep.set(code, row);
  }
  if (!keep.size) throw new Error(`Empty or no usable products in ${section} grid.`);
  const deals = [...keep.values()];
  return { raw: { deals, totalProducts: deals.length, sections: [{ name: section, dealCount: deals.length }] }, stats };
}

/** Require all three genuine captures and keep each code once with first ownership. @param {object[]} captures Ordered parsed captures. @param {string} at Set's actual UTC capture completion. @returns {object} One publish envelope and section accounting. @throws {Error} On incomplete or malformed captures. */
export function combineSections(captures, at) {
  validateCaptureTime(at);
  if (!Array.isArray(captures) || captures.length !== SECTIONS.length) throw new Error('All three captured sections are required.');
  const keep = new Map(), owners = new Map(), stats = [];
  for (const [index, capture] of captures.entries()) {
    const name = SECTIONS[index].name;
    const raw = capture?.raw, counts = capture?.stats;
    if (!raw || !Array.isArray(raw.deals) || !raw.deals.length || raw.totalProducts !== raw.deals.length || raw.sections?.length !== 1 || raw.sections[0]?.name !== name || raw.sections[0]?.dealCount !== raw.deals.length ||
        !counts || !['cards', 'usable', 'duplicates', 'unusable', 'priorCategories'].every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0) || counts.cards !== counts.usable + counts.unusable || counts.usable !== raw.deals.length + counts.duplicates) throw new Error(`Missing, empty or malformed ${name} capture.`);
    const codes = new Set(); let crossDuplicates = 0;
    for (const row of raw.deals) {
      if (!row || typeof row.product_code !== 'string' || !row.product_code.trim() || typeof row.category !== 'string' || !row.category.trim() || codes.has(row.product_code)) throw new Error(`Invalid product identity in ${name} capture.`);
      validateCaptureTime(row.scraped_at);
      if (Date.parse(row.scraped_at) > Date.parse(at)) throw new Error('Capture completion precedes a captured section row.');
      codes.add(row.product_code);
      if (retain(keep, row)) owners.set(row.product_code, name); else crossDuplicates++;
    }
    stats.push({ name, ...counts, crossDuplicates, unique: raw.deals.length - crossDuplicates });
  }
  const deals = [...keep.values()];
  return { payload: { deals, totalProducts: deals.length, sections: SECTIONS.map(({ name }) => ({ name, dealCount: [...owners.values()].filter(owner => owner === name).length })) }, stats };
}

/** Read only UI status, not product data or network payloads. @param {import('playwright').Page} page Browser page. @returns {Promise<object>} Expansion/refusal status. */
async function uiState(page) {
  return page.evaluate(() => {
    /** Test ordinary rendered visibility. @param {Element} el Element. @returns {boolean} Visible. */
    function visible(el) { return Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden'; }
    const grids = [...document.querySelectorAll('[data-testid="product-grid"]')];
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(b => /^view more$/i.test((b.textContent || b.getAttribute('aria-label') || '').trim()));
    const shown = buttons.filter(visible);
    return { grids: grids.length, cards: grids[0]?.querySelectorAll('[data-testid="product-tile"]').length || 0,
      buttons: buttons.length, visibleButtons: shown.length, enabled: shown.length === 1 && !shown[0].disabled && shown[0].getAttribute('aria-disabled') !== 'true',
      busy: [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-testid*="loading"]')].some(visible),
      refusal: /access denied|request blocked|verify (?:that )?you are human|unusual traffic|captcha|security challenge|temporarily blocked|pardon our interruption/i.test(document.title + ' ' + document.body.innerText) };
  });
}

/** Visit once, expand with paced ordinary clicks, and return only grid outerHTML. Never retry retailer requests. @param {import('playwright').Page} page Headed Chrome page. @param {object} section Official section. @param {object} settings Bounded waits, overridable for offline tests only. @returns {Promise<string>} Complete grid HTML. @throws {Error} On refusal, empty/missing grid, stalled loading or expansion. */
export async function collectSection(page, section, settings = {}) {
  const { paceMs = 1200, pollMs = 250, timeoutMs = 30000, maxClicks = 200 } = settings;
  let refused = false;
  /** Detect explicit refusal responses without inspecting response bodies. @param {object} response Browser response. @returns {void} */
  function onResponse(response) {
    if (new URL(response.url()).hostname === 'shop.lululemon.com' && [401, 403, 429].includes(response.status())) refused = true;
  }
  page.on('response', onResponse);
  try {
    const response = await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!response?.ok()) throw new Error(`Collection refused: HTTP ${response?.status() ?? 'unknown'}.`);
    let previous = 0, clicks = 0, expectGrowth = false;
    while (true) {
      let state;
      for (let elapsed = 0; ; elapsed += pollMs) {
        state = await uiState(page);
        if (refused || state.refusal) throw new Error('Collection refused by retailer. No publication.');
        if (state.grids > 1) throw new Error('Unexpected product grid markup.');
        if (state.grids === 1 && !state.busy && state.cards === 0) throw new Error('Empty captured section.');
        if (state.grids === 1 && !state.busy && state.cards > 0 && (!expectGrowth || state.cards > previous) && (state.buttons === 0 || state.enabled || state.visibleButtons === 0)) break;
        if (elapsed >= timeoutMs) throw new Error(state.grids === 1 && state.cards === 0 ? 'Empty captured section.' : 'Incomplete expansion or stalled loading.');
        await page.waitForTimeout(pollMs);
      }
      if (state.cards < previous) throw new Error('Incomplete expansion: grid shrank.');
      if (state.buttons === 0) {
        await page.waitForTimeout(paceMs);
        const final = await uiState(page);
        if (refused || final.refusal) throw new Error('Collection refused by retailer. No publication.');
        if (final.grids !== 1 || final.busy || final.buttons !== 0 || final.cards !== state.cards) throw new Error('Incomplete expansion: grid did not settle.');
        return await page.locator(GRID).evaluate(el => el.outerHTML);
      }
      if (state.buttons !== 1 || state.visibleButtons !== 1 || !state.enabled || clicks >= maxClicks) throw new Error('Incomplete expansion: View More is unavailable or limit reached.');
      previous = state.cards; expectGrowth = true; clicks++;
      await page.waitForTimeout(paceMs);
      const beforeClick = await uiState(page);
      if (refused || beforeClick.refusal) throw new Error('Collection refused by retailer. No publication.');
      if (beforeClick.busy || beforeClick.grids !== 1 || beforeClick.cards !== previous || beforeClick.buttons !== 1 || beforeClick.visibleButtons !== 1 || !beforeClick.enabled) throw new Error('Incomplete expansion: UI changed before View More.');
      await page.getByRole('button', { name: /^view more$/i }).click({ timeout: timeoutMs });
    }
  } finally { page.off('response', onResponse); }
}
