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

/** Read a tile's product link: the first product anchor with text, its name, href and store product id (code). @param {Function} $ Cheerio root. @param {object} tile Cheerio tile. @returns {object} Name, href and code (undefined when absent). */
function tileProduct($, tile) {
  const anchor = tile.find('a[href*="/p/"]').toArray().find(a => $(a).text().trim());
  const name = anchor ? $(anchor).text().trim() : '';
  const href = anchor ? $(anchor).attr('href') : '';
  return { name, href, code: href?.match(/\/p\/[^/]+\/([^/?#]+)/)?.[1] };
}

/** Count a saved grid's cards and its distinct store product ids, read the same way parseGrid reads them. Repeated cards and tiles without a product id add no product.
 * @param {string} html Grid outerHTML. @returns {object} `cards` (tiles) and `unique` (distinct product ids).
 */
export function gridProducts(html) {
  const $ = cheerio.load(html);
  const tiles = $(GRID).first().find(TILE).toArray();
  return { cards: tiles.length, unique: new Set(tiles.map(element => tileProduct($, $(element)).code).filter(Boolean)).size };
}

/** Combine a re-paged grid with an earlier pass of the same section: keep every tile of the new grid and add the earlier pass's tiles
 * whose store product id the new grid lacks, in their earlier order. @param {string} html New grid outerHTML. @param {string} earlier Earlier pass grid outerHTML.
 * @returns {string} Combined grid outerHTML.
 */
export function mergeGrids(html, earlier) {
  const $ = cheerio.load(html), $earlier = cheerio.load(earlier);
  const target = $(GRID).first();
  const have = new Set(target.find(TILE).toArray().map(element => tileProduct($, $(element)).code).filter(Boolean));
  for (const element of $earlier(GRID).first().find(TILE).toArray()) {
    const code = tileProduct($earlier, $earlier(element)).code;
    if (code && !have.has(code)) { have.add(code); target.append($earlier.html(element)); }
  }
  return $.html(target);
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
    const { name, href, code } = tileProduct($, tile);
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

/** Independent budget for each passive document read, never a timeout that skips unreadable frames. */
const UI_READ_MS = 2000;

/** Keep only a bounded DNS hostname or IPv4 address; reject URL content and unknown identity.
 * @param {*} value Hostname, not a URL. @returns {string} Lowercase host without a trailing dot, or unknown.
 */
export function sanitizeStopHost(value) {
  if (typeof value !== 'string' || value.length > 254) return 'unknown';
  const host = value.toLowerCase().replace(/\.$/, '');
  return host && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : 'unknown';
}

/** Read only a document's sanitized HTTP host, never retain its URL or browser diagnostics.
 * @param {object} target Page or frame. @returns {string} Host or unknown when identity is unavailable.
 */
function documentHost(target) {
  try { const url = new URL(target.url()); return ['http:', 'https:'].includes(url.protocol) ? sanitizeStopHost(url.hostname) : 'unknown'; }
  catch { return 'unknown'; }
}

/** Read listing and child-frame refusal facts with independent bounded reads, never frame controls.
 * @param {import('playwright').Page} page Browser page. @returns {Promise<object>} Expansion/refusal status and safe implicated host.
 * @throws {Error} With inspection-unavailable metadata on a deadline or unreadable attached frame; proven detachments are ignored.
 */
async function uiState(page) {
  /** Stop when passive inspection cannot establish safety, without claiming a detected challenge.
   * @param {string} frameHost Sanitized host. @returns {Error} Bounded inspection failure.
   */
  function unreadable(frameHost) { return Object.assign(new Error('Collection stopped: passive refusal inspection unavailable. Human attention required. No publication.'), { challenge: 'inspection-unavailable', frameHost }); }
  /** Give one document its own budget; race handlers consume late rejections and the timer is always cleared.
   * @param {import('playwright').Page|import('playwright').Frame} target Document. @param {boolean} refusalOnly Child-frame mode.
   * @returns {Promise<object>} UI facts and sanitized identity. @throws {Error} On a deadline or failed evaluation.
   */
  async function read(target, refusalOnly) {
    const frameHost = documentHost(target);
    let timer;
    try {
      const facts = await Promise.race([target.evaluate(readUiFacts, { refusalOnly }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(unreadable(frameHost)), UI_READ_MS); })]);
      if (facts.unavailable && !facts.refusal) throw unreadable(frameHost);
      return { ...facts, frameHost };
    } catch { throw unreadable(frameHost); }
    finally { clearTimeout(timer); }
  }
  let raw = await read(page, false);
  if (raw.refusal) return classifyUiState(raw);
  let frames, main;
  try { frames = page.frames(); main = page.mainFrame(); }
  catch { throw unreadable(documentHost(page)); }
  for (const frame of frames) {
    if (frame === main) continue;
    let facts;
    try { facts = await read(frame, true); }
    catch (error) {
      let detached = false;
      try { detached = frame.isDetached?.() === true; } catch { /* Missing native proof is not a detachment. */ }
      if (detached) continue;
      throw error; // An unreadable attached frame may contain a challenge, but none was detected.
    }
    if (facts.refusal) {
      raw = { ...raw, refusal: true, frameHost: facts.frameHost, ...(facts.challenge === 'press-and-hold' ? { challenge: 'press-and-hold' } : {}) };
      break;
    }
  }
  return classifyUiState(raw);
}

/** Runs inside the page: read UI facts only. A document without a body yet (mid-navigation) reads as not settled.
 * `link.handled` says whether the page script has taken over the View More link: React puts its props on every element it has hydrated.
 * Before that, a click on the server-rendered link is an ordinary navigation to `?page=2` and no product-data request is sent.
 * Press & Hold is a refusal, never an interaction target. Only its bounded kind leaves the reader, not the rendered text.
 * @param {object} [options={}] Reader mode. @param {boolean} [options.refusalOnly=false] Read only title and rendered refusal text for a child frame.
 * @returns {object} Raw UI facts with optional challenge kind, or bounded refusal facts with unavailable set for a child document without a body.
 */
export function readUiFacts({ refusalOnly = false } = {}) {
    const refusalText = /access denied|access to this page has been denied|request blocked|verify (?:that )?you are (?:a )?human|are you a robot\?|unusual traffic|captcha|security challenge|temporarily blocked|pardon our interruption/i;
    const text = (document.title || '') + ' ' + (document.body?.innerText || '');
    const challenge = /\bpress[\s\u200b-]*(?:&|\uFF06|and)[\s\u200b-]*hold\b/i.test(text) ? { challenge: 'press-and-hold' } : {};
    const refusal = refusalText.test(text) || Boolean(challenge.challenge);
    if (refusalOnly) return { refusal, ...challenge, ...(!document.body ? { unavailable: true } : {}) };
    if (!document.body) return { grids: 0, cards: 0, total: null, buttons: 0, visibleButtons: 0, enabled: false, indicators: [], refusal, ...challenge };
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
      link: shown.length === 1 ? { disabled: Boolean(shown[0].disabled), ariaDisabled: shown[0].getAttribute('aria-disabled'), handled: Object.keys(shown[0]).some(key => key.startsWith('__reactProps$')) } : null,
      timeOrigin: performance.timeOrigin,
      indicators: [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-testid*="loading"]')].filter(visible).map(el => ({ carousel: Boolean(el.closest('[class*="carousel"]')) })),
      refusal, ...challenge };
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

/** Describe the View More link as read by one status check. @param {object} state UI state. @returns {string} Disabled, aria-disabled, enabled and page handler facts. */
function linkFacts(state) {
  const link = state.link;
  return `disabled ${link ? link.disabled : 'n/a'}, aria-disabled ${link ? link.ariaDisabled ?? 'none' : 'n/a'}, enabled ${state.enabled}, page handler ${link ? link.handled : 'n/a'}`;
}

/** Whether View More can be clicked: enabled and already taken over by the page script. @param {object} state UI state. @returns {boolean} Clickable. */
function clickable(state) { return state.enabled && state.link?.handled === true; }

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

/** Decide the product total a finished section must match. Without a View More click the page's own embedded total is the
 * only source. After clicks it is the total reported by the last of the section's product-data responses (`data.attributes.totalCount`):
 * the embedded total is built before the page loads more products and can count items the product-data service no longer returns,
 * and the product-data total moves while the list changes, so the latest one counts. Only distinct store product ids count: offset
 * paging over a list that changes while it is read repeats some cards and skips other products. After clicks the section is complete
 * when its unique products (across all passes) are at least that total; products that left the list between passes can make the union
 * larger. A missing, zero, negative or unsafe-integer product-data total, or no product-data response at all, stops the section. Without a click the
 * unique products must equal the embedded total, which describes the same server-rendered page as the tiles.
 * @param {object} products `cards` loaded and `unique` distinct product ids among them (gridProducts). @param {number} clicks View More clicks made. @param {Array<number|null>} dataTotals Totals read from product-data responses in arrival order (null when unreadable).
 * @param {number|null} pageTotal Embedded page total, for comparison. @returns {object} `total` to match and `note`, the totals seen for run.log.
 * @throws {Error} When no trustworthy total exists or the unique products fall short of it; `short` is set when a clicked section has fewer unique products than its total.
 */
export function expectedTotal({ cards, unique }, clicks, dataTotals, pageTotal) {
  const shown = `page total ${pageTotal ?? 'unknown'}`, counted = `${cards} cards, ${cards - unique} repeated`;
  if (!clicks) {
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || unique !== pageTotal) throw new Error(`Incomplete section: ${unique} of ${pageTotal ?? 'unknown'} unique products loaded (${counted}).`);
    return { total: pageTotal, note: `page total, no product-data request; ${shown}` };
  }
  if (!dataTotals.length) throw new Error(`Incomplete section: no product-data response after ${clicks} View More clicks (${cards} cards loaded; ${shown}).`);
  if (dataTotals.some(total => !Number.isSafeInteger(total) || total < 1)) throw new Error(`Incomplete section: a product-data response gave no product total (${cards} cards loaded; ${shown}).`);
  const total = dataTotals.at(-1);
  const note = `last product-data total; product-data totals seen ${[...new Set(dataTotals)].join(', ')} in ${dataTotals.length} responses; ${shown}`;
  if (unique < total) throw Object.assign(new Error(`Incomplete section: ${unique} of ${total} unique products loaded (${counted}; ${note}).`), { short: true });
  return { total, note };
}

/** Name the product-data request path a section's View More click fires. @param {object} section Official section. @returns {string} Category endpoint path for the section URL's category id. */
export function productDataPath(section) { return PRODUCT_DATA_PATH + new URL(section.url).pathname.split('/').pop(); }

/** Visit once, expand with paced ordinary clicks, and return only grid outerHTML. Never retry retailer requests.
 * Logs each View More click, each View More link check (identical consecutive poll results are counted, not repeated) and the status and path of every retailer XHR after a click.
 * After each click it also logs what the page did: URL and card count before and after, whether the document stayed the same (performance.timeOrigin),
 * main-frame navigations, load and DOMContentLoaded events, main-frame document responses, and request counts by type.
 * A 4xx on the section's product-data request after a click is a refusal; other XHR statuses are only logged. 401, 403 and 429 from any retailer resource still refuse.
 * From each successful product-data response it reads only the product total, which decides completeness (see expectedTotal).
 * With `settings.earlier` (the union of this section's earlier short passes) the saved grid is the union with this pass by product id (mergeGrids).
 * A clicked section with fewer unique products than its total throws an error with `short` set and `grid`, the grid it collected.
 * View More is clicked only once the page script has taken over the link. A click before then is a plain `?page=2` page load that never
 * grows the grid, which is how the stalled screen-locked runs ended. The wait before the first click is bounded by readyTimeoutMs.
 * @param {import('playwright').Page} page Headed Chrome page.
 * @param {object} section Official section.
 * @param {object} settings Bounded waits (overridable for offline tests only: timeoutMs after a click, readyTimeoutMs before the first), `log`, the run.log writer, and optional `earlier` grid HTML.
 * @returns {Promise<string>} Complete grid HTML.
 * @throws {Error} On refusal or unreadable passive inspection (with a bounded challenge kind), empty/missing grid, stalled loading or expansion. A failed listing click permits one bounded passive inspection, never a click retry.
 */
export async function collectSection(page, section, settings = {}) {
  const { paceMs = 1200, pollMs = 250, timeoutMs = 30000, readyTimeoutMs = 60000, maxClicks = 200, log = () => {}, earlier } = settings;
  const dataPath = productDataPath(section);
  const dataTotals = [];
  let refused = null, clicks = 0, checks = 0, lastFacts = null, repeats = 0, lastRepeat = '', after = null, lastState = null;
  /** Write one diagnostic line without letting a logging failure replace the collector's own outcome. @param {string} line Diagnostic. @returns {void} */
  function note(line) { try { log(line); } catch { /* Diagnostics are best effort. */ } }
  /** Detect refusal responses; record status and path of retailer XHRs after a click, marking the product-data request, and read only the product total from a successful product-data body. @param {object} response Browser response. @returns {void} */
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
    if (!refused && productData && status >= 400 && status < 500) refused = { reason: `View More product-data request HTTP ${status}`, frameHost: sanitizeStopHost(url.hostname) };
    else if (!refused && [401, 403, 429].includes(status)) refused = { reason: `HTTP ${status}`, frameHost: sanitizeStopHost(url.hostname) };
    if (productData && status >= 200 && status < 300) {
      dataTotals.push(Promise.resolve().then(() => response.json()).then(body => (Number.isInteger(body?.data?.attributes?.totalCount) ? body.data.attributes.totalCount : null), () => null));
    }
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
  /** Stop on a refusal and expose only its bounded kind and host for private operator reporting. @param {object} state UI state. @returns {void} @throws {Error} On refusal, never marked for re-paging. */
  function stopIfRefused(state) {
    if (refused || state.refusal) throw Object.assign(new Error(`Collection refused by retailer${refused ? ': ' + refused.reason : ''}. No publication.`),
      { challenge: state.challenge === 'press-and-hold' ? 'press-and-hold' : 'retailer-refusal', frameHost: state.refusal ? sanitizeStopHost(state.frameHost) : refused?.frameHost ?? 'unknown' });
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
    if (!response?.ok()) throw Object.assign(new Error(`Collection refused: HTTP ${response?.status() ?? 'unknown'}${await refusalShape(response)}.`), { challenge: 'retailer-refusal', frameHost: documentHost(page) });
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
        if (settled && (state.buttons === 0 || clickable(state))) break;
        if (elapsed >= (clicks ? timeoutMs : readyTimeoutMs)) throw new Error(state.grids === 1 && state.cards === 0 ? 'Empty captured section.' : `Incomplete expansion or stalled loading (cards ${state.cards}, busy ${state.busy}, View More ${state.visibleButtons}/${state.buttons} visible, link ${linkFacts(state)}; ${clicks ? `after click ${clicks} of View More` : 'before the first View More click'}).`);
        await page.waitForTimeout(pollMs);
      }
      reportAfterClick(state);
      if (state.cards < previous) throw new Error('Incomplete expansion: grid shrank.');
      if (state.buttons === 0) {
        await page.waitForTimeout(paceMs);
        const final = await uiState(page);
        stopIfRefused(final);
        if (final.grids !== 1 || final.busy || final.buttons !== 0 || final.cards !== state.cards) throw new Error('Incomplete expansion: grid did not settle.');
        const totals = await Promise.all(dataTotals);
        const own = await page.locator(GRID).evaluate(el => el.outerHTML);
        const html = earlier ? mergeGrids(own, earlier) : own;
        const products = gridProducts(html);
        flushRepeats();
        if (earlier) {
          const pass = gridProducts(own);
          note(`${section.name} pass ${settings.pass ?? 2}: ${pass.unique} unique products in ${pass.cards} cards; with ${products.unique - pass.unique} more from earlier passes the section has ${products.unique}.`);
        }
        let expected;
        try { expected = expectedTotal(products, clicks, totals, final.total); } catch (error) { if (error.short) error.grid = html; throw error; }
        const count = products.unique === expected.total ? `${products.unique} of ${expected.total} unique products` : `${products.unique} unique products, at least the last product-data total of ${expected.total}`;
        note(`${section.name} complete: ${count} (${products.cards} cards, ${products.cards - products.unique} repeated) after ${clicks} View More clicks (${expected.note}).`);
        return html;
      }
      if (state.buttons !== 1 || state.visibleButtons !== 1 || !clickable(state) || clicks >= maxClicks) throw new Error('Incomplete expansion: View More is unavailable or limit reached.');
      previous = state.cards; expectGrowth = true;
      await page.waitForTimeout(paceMs);
      const beforeClick = await uiState(page);
      stopIfRefused(beforeClick);
      checkLink(beforeClick, true);
      if (beforeClick.busy || beforeClick.grids !== 1 || beforeClick.cards !== previous || beforeClick.buttons !== 1 || beforeClick.visibleButtons !== 1 || !clickable(beforeClick)) throw new Error('Incomplete expansion: UI changed before View More.');
      clicks++;
      note(`${section.name} View More click ${clicks} at ${previous} cards.`);
      after = { click: clicks, url: currentAt(), cards: beforeClick.cards, timeOrigin: beforeClick.timeOrigin, navigations: 0, loads: 0, contentLoads: 0, retailer: {}, otherHosts: 0 };
      try { await page.locator(VIEW_MORE).click({ timeout: timeoutMs }); }
      catch (error) {
        if (!refused && !error?.challenge) {
          let inspected;
          try { inspected = await uiState(page); }
          catch (readError) { if (readError?.challenge) throw readError; }
          if (inspected) stopIfRefused(inspected);
        }
        throw error;
      }
    }
  } catch (error) {
    // A recorded retailer refusal outranks a later navigation, evaluation or click failure.
    if (refused && (!error?.challenge || error.challenge === 'inspection-unavailable')) stopIfRefused({ refusal: false });
    throw error;
  } finally {
    reportAfterClick(lastState); flushRepeats();
    page.off('response', onResponse); page.off('framenavigated', onNavigated); page.off('load', onLoad); page.off('domcontentloaded', onContentLoaded);
  }
}
