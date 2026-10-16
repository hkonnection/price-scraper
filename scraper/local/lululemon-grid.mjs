/** Inert grid parsing and ordinary visible-browser collection for Canadian sale sections. */
import * as cheerio from 'cheerio';

export const SECTIONS = Object.freeze([
  { name: 'Women', url: 'https://shop.lululemon.com/en-ca/c/women-we-made-too-much/n16o10z8mhd' },
  { name: 'Men', url: 'https://shop.lululemon.com/en-ca/c/men-we-made-too-much/n18mhdznrqw' },
  { name: 'Accessories', url: 'https://shop.lululemon.com/en-ca/c/we-made-too-much-accessories/n14w56z8mhd' },
]);
const GRID = '[data-testid="product-grid"]';
const TILE = '[data-testid="product-tile"]';
const VIEW_MORE = '[data-lll-component-name="cdp:view_more_products"]';
// Each View More click fetches the next 40 products from this endpoint for the section's own category id
// (page[limit]=40, page[offset] += 40): one request per click in saved Women and Men captures.
const PRODUCT_DATA_PATH = '/.uf-svc/v1/categories/';

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
  return classifyUiState(await page.evaluate(readUiFacts));
}

/** Runs inside the page: read UI facts only. A document without a body yet (mid-navigation) reads as not settled. @returns {object} Raw UI facts. */
export function readUiFacts() {
    const refusalText = /access denied|request blocked|verify (?:that )?you are human|unusual traffic|captcha|security challenge|temporarily blocked|pardon our interruption/i;
    if (!document.body) return { grids: 0, cards: 0, total: null, buttons: 0, visibleButtons: 0, enabled: false, indicators: [], refusal: refusalText.test(document.title || '') };
    /** Test ordinary rendered visibility. @param {Element} el Element. @returns {boolean} Visible. */
    function visible(el) { return Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden'; }
    const grids = [...document.querySelectorAll('[data-testid="product-grid"]')];
    const buttons = [...document.querySelectorAll('[data-lll-component-name="cdp:view_more_products"]')];
    /** Read the listing's own product total from the page's embedded catalog data. @returns {number|null} Total, or null when absent. */
    function pageTotal() {
      try {
        const queries = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.dehydratedState?.queries || [];
        const total = queries.find(q => q.queryKey?.[0] === 'catalogPageData')?.state?.data?.pages?.[0]?.data?.attributes?.totalCount;
        return Number.isInteger(total) ? total : null;
      } catch { return null; }
    }
    const shown = buttons.filter(visible);
    return { grids: grids.length, cards: grids[0]?.querySelectorAll('[data-testid="product-tile"]').length || 0,
      total: pageTotal(), buttons: buttons.length, visibleButtons: shown.length, enabled: shown.length === 1 && !shown[0].disabled && shown[0].getAttribute('aria-disabled') !== 'true',
      link: shown.length === 1 ? { disabled: Boolean(shown[0].disabled), ariaDisabled: shown[0].getAttribute('aria-disabled') } : null,
      timeOrigin: performance.timeOrigin,
      indicators: [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-testid*="loading"]')].filter(visible).map(el => ({ carousel: Boolean(el.closest('[class*="carousel"]')) })),
      refusal: refusalText.test(document.title + ' ' + document.body.innerText) };
}

/** Derive loading from visible indicators; product image carousel progress bars stay on screen and never mean loading. @param {object} raw Browser-read UI facts. @returns {object} UI state with busy. */
export function classifyUiState(raw) {
  if (!Array.isArray(raw?.indicators)) throw new Error('Malformed UI state.');
  return { ...raw, busy: raw.indicators.some(indicator => !indicator.carousel) };
}


/** Describe a refused page load by its request cookie count and size and the responding server, never by any cookie or header value beyond the server name. Best effort only.
 * @param {import('playwright').Response|null} response Refused document response.
 * @returns {Promise<string>} Parenthesized detail, or empty when the browser exposes none.
 */
export async function refusalShape(response) {
  try {
    const cookie = (await response.request().allHeaders()).cookie || '';
    const server = String(response.headers().server || '').replace(/[^\w ./-]/g, '').slice(0, 40) || 'unknown';
    return ` (request cookies ${cookie ? cookie.split(';').length : 0}, ${Buffer.byteLength(cookie)} bytes; server ${server})`;
  } catch { return ''; }
}

/** Describe the View More link as read by one status check. @param {object} state UI state. @returns {string} Disabled, aria-disabled and enabled facts. */
function linkFacts(state) {
  const link = state.link;
  return `disabled ${link ? link.disabled : 'n/a'}, aria-disabled ${link ? link.ariaDisabled ?? 'none' : 'n/a'}, enabled ${state.enabled}`;
}

/** Keep only a URL's path for logs: no query, fragment, host or control characters. @param {URL} url Parsed URL. @returns {string} Bounded path. */
function logPath(url) { return url.pathname.replace(/[\x00-\x20\x7f]/g, '').slice(0, 200); }

/** Keep a page URL's path and numeric page parameter for logs, never other query values. @param {string} href URL. @returns {string} Bounded path, `?page=N` and a note when other query keys were dropped. */
function pageAt(href) {
  try {
    const url = new URL(href), number = url.searchParams.get('page');
    const other = [...url.searchParams.keys()].some(key => key !== 'page');
    return logPath(url) + (/^\d+$/.test(number || '') ? `?page=${number}` : '') + (other ? ' (other query omitted)' : '');
  } catch { return 'unknown'; }
}

/** Name the product-data request path a section's View More click fires. @param {object} section Official section. @returns {string} Category endpoint path for the section URL's category id. */
export function productDataPath(section) { return PRODUCT_DATA_PATH + new URL(section.url).pathname.split('/').pop(); }

/** Visit once, expand with paced ordinary clicks, and return only grid outerHTML. Never retry retailer requests.
 * Logs each View More click, each View More link check (identical consecutive poll results are counted, not repeated) and the status and path of every retailer XHR after a click.
 * After each click it also logs what the page did: URL and card count before and after, whether the document stayed the same (performance.timeOrigin),
 * main-frame navigations, load and DOMContentLoaded events, main-frame document responses, and request counts by type.
 * A 4xx on the section's product-data request after a click is a refusal; other XHR statuses are only logged. 401, 403 and 429 from any retailer resource still refuse.
 * @param {import('playwright').Page} page Headed Chrome page.
 * @param {object} section Official section.
 * @param {object} settings Bounded waits (overridable for offline tests only) and `log`, the run.log writer.
 * @returns {Promise<string>} Complete grid HTML.
 * @throws {Error} On refusal, empty/missing grid, stalled loading or expansion.
 */
export async function collectSection(page, section, settings = {}) {
  const { paceMs = 1200, pollMs = 250, timeoutMs = 30000, maxClicks = 200, log = () => {} } = settings;
  const dataPath = productDataPath(section);
  let refused = null, clicks = 0, checks = 0, lastFacts = null, repeats = 0, lastRepeat = '', after = null, lastState = null;
  /** Write one diagnostic line without letting a logging failure replace the collector's own outcome. @param {string} line Diagnostic. @returns {void} */
  function note(line) { try { log(line); } catch { /* Diagnostics are best effort. */ } }
  /** Detect refusal responses without inspecting bodies; record status and path of retailer XHRs after a click, marking the product-data request. @param {object} response Browser response. @returns {void} */
  function onResponse(response) {
    const url = new URL(response.url());
    let type = '';
    try { type = response.request().resourceType(); } catch { /* Unknown type is not an XHR. */ }
    if (after) { if (url.hostname === 'shop.lululemon.com') after.retailer[type || 'other'] = (after.retailer[type || 'other'] || 0) + 1; else after.otherHosts++; }
    if (url.hostname !== 'shop.lululemon.com') return;
    const status = response.status();
    if (clicks > 0 && type === 'document') note(`${section.name} document after click ${clicks}: HTTP ${status} ${pageAt(url.href)}`);
    const call = clicks > 0 && (type === 'xhr' || type === 'fetch');
    const productData = call && url.pathname === dataPath;
    if (call) note(`${section.name} ${productData ? 'product-data ' : ''}XHR after click ${clicks}: HTTP ${status} ${logPath(url)}`);
    if (!refused && productData && status >= 400 && status < 500) refused = `View More product-data request HTTP ${status} ${logPath(url)}`;
    else if (!refused && [401, 403, 429].includes(status)) refused = `HTTP ${status} ${logPath(url)}`;
  }
  /** Count main-frame navigations after a click. @param {object} frame Navigated frame. @returns {void} */
  function onNavigated(frame) { try { if (after && !frame.parentFrame()) after.navigations++; } catch { /* Unknown frame is not counted. */ } }
  /** Count page load events after a click. @returns {void} */
  function onLoad() { if (after) after.loads++; }
  /** Count DOMContentLoaded events after a click. @returns {void} */
  function onContentLoaded() { if (after) after.contentLoads++; }
  /** Read the page URL for logs. @returns {string} Sanitized path or unknown. */
  function currentAt() { try { return pageAt(page.url()); } catch { return 'unknown'; } }
  /** Log what the page did since the last click, once per click. @param {object|null} state Latest UI state. @returns {void} */
  function reportAfterClick(state) {
    if (!after) return;
    const a = after; after = null;
    flushRepeats();
    const document = state?.timeOrigin == null || a.timeOrigin == null ? 'unknown' : state.timeOrigin === a.timeOrigin ? 'same (timeOrigin unchanged)' : 'new (timeOrigin changed)';
    const requests = Object.entries(a.retailer).map(([type, count]) => `${type} ${count}`).join(', ') || 'none';
    note(`${section.name} after click ${a.click}: URL ${a.url} → ${currentAt()}, cards ${a.cards} → ${state?.cards ?? 'unknown'}, document ${document}, main-frame navigations ${a.navigations}, load events ${a.loads}, DOMContentLoaded ${a.contentLoads}, retailer requests ${requests}, other-host requests ${a.otherHosts}.`);
  }
  /** Stop on a recorded refusal response or refusal page text. @param {object} state UI state. @returns {void} @throws {Error} On refusal. */
  function stopIfRefused(state) {
    if (refused || state.refusal) throw new Error(`Collection refused by retailer${refused ? ': ' + refused : ''}. No publication.`);
  }
  /** Log the repeat count of the unlogged identical checks, named by the last of them. @returns {void} */
  function flushRepeats() {
    if (repeats) note(`${section.name} View More check ${lastRepeat}: same result repeated ${repeats} more times.`);
    repeats = 0;
  }
  /** Record one View More link check. Poll checks equal to the previous one are only counted. @param {object} state UI state. @param {boolean} preClick Check made just before a click. @returns {void} */
  function checkLink(state, preClick = false) {
    if (!state.buttons) return;
    checks++;
    const facts = `visible ${state.visibleButtons}/${state.buttons}, ${linkFacts(state)}`;
    const label = `${checks} (${preClick ? `pre-click ${clicks + 1}` : clicks ? `after click ${clicks}` : 'before click 1'})`;
    if (!preClick && facts === lastFacts) { repeats++; lastRepeat = label; return; }
    flushRepeats(); lastFacts = facts;
    note(`${section.name} View More check ${label}: ${facts}.`);
  }
  page.on('response', onResponse); page.on('framenavigated', onNavigated); page.on('load', onLoad); page.on('domcontentloaded', onContentLoaded);
  try {
    const response = await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!response?.ok()) throw new Error(`Collection refused: HTTP ${response?.status() ?? 'unknown'}${await refusalShape(response)}.`);
    let previous = 0, expectGrowth = false;
    while (true) {
      let state;
      for (let elapsed = 0; ; elapsed += pollMs) {
        state = lastState = await uiState(page);
        stopIfRefused(state);
        checkLink(state);
        if (state.grids > 1) throw new Error('Unexpected product grid markup.');
        if (state.grids === 1 && !state.busy && state.cards === 0) throw new Error('Empty captured section.');
        const settled = state.grids === 1 && !state.busy && state.cards > 0 && (!expectGrowth || state.cards > previous);
        if (settled && (state.buttons === 0 || state.enabled)) break;
        if (elapsed >= timeoutMs) throw new Error(state.grids === 1 && state.cards === 0 ? 'Empty captured section.' : `Incomplete expansion or stalled loading (cards ${state.cards}, busy ${state.busy}, View More ${state.visibleButtons}/${state.buttons} visible, link ${linkFacts(state)}; ${clicks ? `after click ${clicks} of View More` : 'before the first View More click'}).`);
        await page.waitForTimeout(pollMs);
      }
      reportAfterClick(state);
      if (state.cards < previous) throw new Error('Incomplete expansion: grid shrank.');
      if (state.buttons === 0) {
        await page.waitForTimeout(paceMs);
        const final = await uiState(page);
        stopIfRefused(final);
        if (final.grids !== 1 || final.busy || final.buttons !== 0 || final.cards !== state.cards) throw new Error('Incomplete expansion: grid did not settle.');
        if (!Number.isInteger(final.total) || final.cards !== final.total) throw new Error(`Incomplete section: ${final.cards} of ${final.total ?? 'unknown'} products loaded.`);
        const html = await page.locator(GRID).evaluate(el => el.outerHTML);
        flushRepeats();
        note(`${section.name} complete: ${final.cards} of ${final.total} products after ${clicks} View More clicks.`);
        return html;
      }
      if (state.buttons !== 1 || state.visibleButtons !== 1 || !state.enabled || clicks >= maxClicks) throw new Error('Incomplete expansion: View More is unavailable or limit reached.');
      previous = state.cards; expectGrowth = true;
      await page.waitForTimeout(paceMs);
      const beforeClick = await uiState(page);
      stopIfRefused(beforeClick);
      checkLink(beforeClick, true);
      if (beforeClick.busy || beforeClick.grids !== 1 || beforeClick.cards !== previous || beforeClick.buttons !== 1 || beforeClick.visibleButtons !== 1 || !beforeClick.enabled) throw new Error('Incomplete expansion: UI changed before View More.');
      clicks++;
      note(`${section.name} View More click ${clicks} at ${previous} cards.`);
      after = { click: clicks, url: currentAt(), cards: beforeClick.cards, timeOrigin: beforeClick.timeOrigin, navigations: 0, loads: 0, contentLoads: 0, retailer: {}, otherHosts: 0 };
      await page.locator(VIEW_MORE).click({ timeout: timeoutMs });
    }
  } finally {
    reportAfterClick(lastState); flushRepeats();
    page.off('response', onResponse); page.off('framenavigated', onNavigated); page.off('load', onLoad); page.off('domcontentloaded', onContentLoaded);
  }
}
