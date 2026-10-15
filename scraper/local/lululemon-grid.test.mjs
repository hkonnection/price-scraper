import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrid, combineSections, collectSection, classifyUiState, readUiFacts, productDataPath, SECTIONS } from './lululemon-grid.mjs';

const at = '2026-10-11T15:02:03.456Z';
/** Make one inert synthetic product tile. @param {string} code Product code. @param {string} name Name. @param {string} prices Price markup. @returns {string} HTML. */
function tile(code, name = 'Test Shirt', prices = '<span class="originalPrice">$100</span> $50') {
  return `<div data-testid="product-tile"><a href="/p/test/${code}?color=123">${name}</a>${prices}<img src="https://images.example/item.jpg?width=100"></div>`;
}
/** Make a synthetic product grid. @param {string} contents Tiles. @returns {string} HTML. */
function grid(contents) { return `<div data-testid="product-grid">${contents}</div>`; }
/** Parse a synthetic capture. @param {string} name Section. @param {string} html Tile contents. @returns {object} Capture. */
function capture(name, html) { return parseGrid(grid(html), name, at); }

test('parser reads only grid tile descendants and preserves reference price, code, URL and image semantics', () => {
  const result = parseGrid(grid(tile('prod1', 'Cool &amp; Calm Shirt', '<span class="originalPrice">$1,000</span> $499 $550')) + tile('outside'), 'Women', at);
  assert.deepEqual(result.stats, { cards: 1, usable: 1, duplicates: 0, unusable: 0, priorCategories: 0 });
  assert.equal(result.raw.totalProducts, 1);
  const row = result.raw.deals[0];
  assert.equal(row.product_code, 'prod1'); assert.equal(row.product_name, 'Cool & Calm Shirt');
  assert.equal(row.regular_price, 1000); assert.equal(row.sale_price, 499);
  assert.equal(row.savings_amount, 501); assert.equal(row.savings_percent, 50.1);
  assert.equal(row.product_url, 'https://shop.lululemon.com/en-ca/p/test/prod1?color=123');
  assert.equal(row.image_url, 'https://images.example/item.jpg'); assert.equal(row.scraped_at, at);
});

test('parser reports duplicate and unusable cards, reuses prior categories and never runs scripts', () => {
  const result = parseGrid(grid(tile('x', 'Unknown') + tile('x', 'A Shirt') + tile('bad', 'Invalid', '$50 $50') + '<div data-testid="product-tile">Broken</div><script>throw Error("not executed")</script>'), 'Women', at, new Map([['x', 'Bags']]));
  assert.deepEqual(result.stats, { cards: 4, usable: 2, duplicates: 1, unusable: 2, priorCategories: 2 });
  assert.equal(result.raw.deals.length, 1); assert.equal(result.raw.deals[0].category, 'Bags');
});

test('raw parser preserves the first duplicate tile exactly, leaving cross-section upgrades to the combiner', () => {
  const result = capture('Women', tile('same', 'Unknown') + tile('same', 'Bag', '<span class="originalPrice">$200</span> $60'));
  assert.equal(result.raw.deals[0].product_name, 'Unknown');
  assert.equal(result.raw.deals[0].category, 'Other');
  assert.equal(result.raw.deals[0].sale_price, 50);
  assert.equal(result.stats.duplicates, 1);
});

test('reference name-category precedence and accessory fallback', () => {
  const names = [['Parka Vest', 'Jackets & Outerwear'], ['Half-Zip Crew', 'Hoodies & Sweatshirts'], ['Jogger', 'Pants'], ['Tight', 'Leggings'], ['Short', 'Shorts'], ['Skort', 'Skirts & Dresses'], ['Bra', 'Sports Bras'], ['Tank', 'Tank Tops'], ['Polo', 'Shirts & Tops'], ['Cardigan', 'Sweaters'], ['Sock', 'Socks'], ['Boxer', 'Underwear'], ['Pouch', 'Bags'], ['Scrunchie', 'Hats & Headwear'], ['Sneaker', 'Shoes'], ['Bottle', 'Water Bottles'], ['Yoga Mat', 'Yoga Mats'], ['Unknown', 'Other']];
  for (const [name, category] of names) assert.equal(capture('Women', tile('x', name)).raw.deals[0].category, category, name);
  assert.equal(capture('Accessories', tile('x', 'Unknown')).raw.deals[0].category, 'Accessories');
});

test('cross-section duplicate regression: first record and owner win; only Other upgrades; within-section counts preserved', () => {
  const women = capture('Women', tile('shared', 'Unknown') + tile('women', 'Tank') + tile('women', 'Tank'));
  const men = capture('Men', tile('shared', 'Bag', '<span class="originalPrice">$200</span> $60') + tile('men', 'Shorts') + tile('men', 'Shorts'));
  const accessories = capture('Accessories', tile('shared', 'Hat') + tile('men', 'Bag') + tile('acc', 'Bag') + tile('acc', 'Bag'));
  const before = JSON.stringify([women, men, accessories]);
  const combined = combineSections([women, men, accessories], at);
  assert.deepEqual(combined.payload.deals.map(r => r.product_code), ['shared', 'women', 'men', 'acc']);
  assert.equal(combined.payload.deals[0].category, 'Bags'); assert.equal(combined.payload.deals[0].sale_price, 50);
  assert.equal(combined.payload.deals[2].category, 'Shorts');
  assert.deepEqual(combined.payload.sections, [{ name: 'Women', dealCount: 2 }, { name: 'Men', dealCount: 1 }, { name: 'Accessories', dealCount: 1 }]);
  assert.deepEqual(combined.stats.map(s => [s.cards, s.usable, s.duplicates, s.crossDuplicates, s.unique]), [[3, 3, 1, 0, 2], [3, 3, 1, 1, 1], [4, 4, 1, 2, 1]]);
  assert.equal(combined.payload.totalProducts, 4); assert.equal(JSON.stringify([women, men, accessories]), before);
});

test('capture completion cannot precede an earlier section row if the clock moves backwards', () => {
  const captures = SECTIONS.map(({ name }) => capture(name, tile(name.toLowerCase())));
  assert.throws(() => combineSections(captures, '2026-10-11T15:02:02.456Z'), /capture.*preced|capture.*before/i);
});

test('valid later capture with no new products is accepted but missing/empty/malformed captures are rejected', () => {
  const captures = SECTIONS.map(({ name }) => capture(name, tile('same', 'Unknown')));
  const combined = combineSections(captures, at);
  assert.equal(combined.payload.totalProducts, 1);
  assert.deepEqual(combined.payload.sections.map(s => s.dealCount), [1, 0, 0]);
  assert.equal(combined.payload.deals[0].category, 'Accessories');
  for (const input of [captures.slice(0, 2), [captures[1], captures[0], captures[2]], [captures[0], { raw: { deals: [], totalProducts: 0, sections: [{ name: 'Men', dealCount: 0 }] } }, captures[2]], [captures[0], null, captures[2]]]) assert.throws(() => combineSections(input, at));
  assert.throws(() => parseGrid(grid(''), 'Women', at), /empty/i);
  assert.throws(() => parseGrid('<article>changed markup</article>', 'Women', at), /grid/i);
  assert.throws(() => parseGrid(grid(tile('bad', 'Bad', '$1')), 'Women', at), /usable|empty/i);
  assert.throws(() => parseGrid(grid(tile('x')), 'Unknown', at));
  assert.throws(() => parseGrid(grid(tile('x')), 'Women', 'invalid'));
});

/** Simulate UI states without any browser/network. @param {object[]} states Ordered DOM snapshots. @param {number} status HTTP status. @returns {object} Page double and trace. */
function fakePage(states, status = 200) {
  let index = 0, clicked = false;
  const trace = [], handlers = {};
  return { trace, on: (event, fn) => { handlers[event] = fn; }, off: () => {},
    goto: async url => { trace.push(url); return { status: () => status, ok: () => status === 200 }; },
    evaluate: async () => { const result = states[index]; if (clicked && index < states.length - 1) index++; return result; },
    waitForTimeout: async () => {},
    locator: selector => ({ evaluate: async () => grid(tile('x') + tile('y')), click: async () => { clicked = true; trace.push(selector.includes('view_more') ? 'click' : 'wrong click'); } }),
  };
}
test('collector stops before another click when refusal arrives during ordinary pacing', async () => {
  const page = fakePage([initial]);
  page.waitForTimeout = async () => { page.evaluate = async () => ({ ...initial, refusal: true }); };
  await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 1, pollMs: 1, timeoutMs: 3 }), /refus/i);
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

const initial = { grids: 1, cards: 1, total: 2, buttons: 1, visibleButtons: 1, enabled: true, link: { disabled: false, ariaDisabled: null }, indicators: [], refusal: false };
const loading = [{ carousel: false }];
const complete = { ...initial, cards: 2, buttons: 0, visibleButtons: 0 };

test('HTTP 429 resource refusal halts before clicking without reading any network body', async () => {
  const page = fakePage([initial]); let listener;
  page.on = (event, fn) => { listener = fn; };
  page.waitForTimeout = async () => { listener({ url: () => 'https://shop.lululemon.com/refused-resource', status: () => 429 }); };
  await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 1, pollMs: 1, timeoutMs: 3 }), /refus/i);
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

test('collector visits section once and uses ordinary button through loading before saving outerHTML', async () => {
  const page = fakePage([initial, { ...initial, indicators: loading, visibleButtons: 0 }, complete, complete]);
  const html = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 });
  assert.match(html, /product-grid/);
  assert.deepEqual(page.trace, [SECTIONS[0].url, 'click']);
});

test('collector stops for refusal, HTTP rejection, empty grid, ambiguous markup and stalled/incomplete expansion', async () => {
  const settings = { paceMs: 0, pollMs: 1, timeoutMs: 2 };
  for (const [states, status, expected] of [
    [[{ ...initial, refusal: true }], 200, /refus/i], [[initial], 403, /HTTP|refus/i],
    [[{ ...complete, cards: 0 }], 200, /empty/i], [[{ ...complete, grids: 2 }], 200, /grid/i],
    [[initial], 200, /incomplete|stall/i], [[{ ...initial, visibleButtons: 0 }], 200, /incomplete/i],
    [[initial, { ...complete, cards: 1 }], 200, /incomplete|stall/i], [[initial, { ...complete, cards: 0 }], 200, /empty|incomplete/i],
  ]) await assert.rejects(collectSection(fakePage(states, status), SECTIONS[0], settings), expected);
});

test('a non-OK section page load reports status, request cookie count and size and edge server, never a cookie value', async () => {
  const settings = { paceMs: 0, pollMs: 1, timeoutMs: 2 };
  const page = fakePage([initial], 400); const goto = page.goto;
  page.goto = async url => ({ ...(await goto(url)), headers: () => ({ server: 'AkamaiGHost', 'set-cookie': 'secretthree=1' }),
    request: () => ({ allHeaders: async () => ({ cookie: 'a=secretone; b=secrettwo; c=x' }) }) });
  const error = await collectSection(page, SECTIONS[1], settings).catch(caught => caught);
  assert.equal(error.message, 'Collection refused: HTTP 400 (request cookies 3, 29 bytes; server AkamaiGHost).');
  assert.doesNotMatch(error.message, /secret/);
  assert.deepEqual(page.trace, [SECTIONS[1].url]);
  const bare = fakePage([initial], 400); const bareGoto = bare.goto;
  bare.goto = async url => ({ ...(await bareGoto(url)), headers: () => ({}), request: () => ({ allHeaders: async () => ({}) }) });
  await assert.rejects(collectSection(bare, SECTIONS[1], settings), { message: 'Collection refused: HTTP 400 (request cookies 0, 0 bytes; server unknown).' });
  await assert.rejects(collectSection(fakePage([initial], 400), SECTIONS[1], settings), { message: 'Collection refused: HTTP 400.' });
});

/** Make a synthetic browser response. @param {string} url URL. @param {number} status Status. @param {string} type Resource type. @returns {object} Response double. */
function response(url, status, type = 'xhr') { return { url: () => url, status: () => status, request: () => ({ resourceType: () => type }) }; }
/** Make a page whose View More click delivers the given responses to the collector's listener. @param {object[]} states UI states. @param {object[]} afterClick Responses fired on click. @param {object[]} beforeClick Responses fired on load. @returns {object} Page double. */
function clickingPage(states, afterClick, beforeClick = []) {
  const page = fakePage(states); let listener;
  page.on = (event, fn) => { listener = fn; };
  const goto = page.goto; page.goto = async url => { const result = await goto(url); beforeClick.forEach(r => listener(r)); return result; };
  const locator = page.locator; page.locator = selector => { const real = locator(selector); return { ...real, click: async () => { await real.click(); afterClick.forEach(r => listener(r)); } }; };
  return page;
}

test('run.log records each View More click, each link check and the expansion total', async () => {
  const log = [];
  const page = fakePage([initial, { ...initial, indicators: loading, visibleButtons: 0, link: null }, complete, complete]);
  await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) });
  assert.ok(log.includes('Women View More check 1 (before click 1): visible 1/1, disabled false, aria-disabled none, enabled true.'), log.join('\n'));
  assert.ok(log.includes('Women View More check 2 (pre-click 1): visible 1/1, disabled false, aria-disabled none, enabled true.'), log.join('\n'));
  assert.ok(log.includes('Women View More click 1 at 1 cards.'));
  assert.ok(log.some(line => /^Women View More check \d+ \(after click 1\): visible 0\/1, disabled n\/a, aria-disabled n\/a, enabled true\.$/.test(line)), log.join('\n'));
  assert.equal(log.at(-1), 'Women complete: 2 of 2 products after 1 View More clicks.');
});

test('a repeat count names the last repeated check and the click it followed, even when flushed by the next click', async () => {
  const log = [];
  const one = { ...initial, total: 3 }, two = { ...one, cards: 2 }, done = { ...one, cards: 3, buttons: 0, visibleButtons: 0, link: null };
  // Before click 1: check 1 (poll), check 2 (pre-click). After click 1: checks 3-5 read 1 card, check 6 reads 2 cards (same link facts).
  // Check 7 is pre-click 2; check 8 follows click 2; then the link is gone.
  const reads = [one, one, one, one, one, two, two, two, done];
  const page = fakePage([]); let index = 0; page.evaluate = async () => reads[Math.min(index++, reads.length - 1)];
  await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) });
  const repeat1 = 'Women View More check 6 (after click 1): same result repeated 4 more times.';
  assert.deepEqual(log, [
    'Women View More check 1 (before click 1): visible 1/1, disabled false, aria-disabled none, enabled true.',
    'Women View More check 2 (pre-click 1): visible 1/1, disabled false, aria-disabled none, enabled true.',
    'Women View More click 1 at 1 cards.',
    repeat1,
    'Women View More check 7 (pre-click 2): visible 1/1, disabled false, aria-disabled none, enabled true.',
    'Women View More click 2 at 2 cards.',
    'Women View More check 8 (after click 2): same result repeated 1 more times.',
    'Women complete: 3 of 3 products after 2 View More clicks.',
  ]);
});

test('repeated identical link checks are counted, and a stall says the click count and last link state', async () => {
  const log = [];
  const stuck = { ...initial, link: { disabled: false, ariaDisabled: null } };
  const error = await collectSection(fakePage([stuck, stuck]), SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 6, log: line => log.push(line) }).catch(caught => caught);
  assert.equal(error.message, 'Incomplete expansion or stalled loading (cards 1, busy false, View More 1/1 visible, link disabled false, aria-disabled none, enabled true; after click 1 of View More).');
  assert.ok(log.some(line => /^Women View More check \d+ \(after click 1\): same result repeated \d+ more times\.$/.test(line)), log.join('\n'));
  const disabled = { ...initial, enabled: false, link: { disabled: false, ariaDisabled: 'true' } };
  await assert.rejects(collectSection(fakePage([disabled]), SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2 }),
    { message: 'Incomplete expansion or stalled loading (cards 1, busy false, View More 1/1 visible, link disabled false, aria-disabled true, enabled false; before the first View More click).' });
});

const MEN_DATA = 'https://shop.lululemon.com/.uf-svc/v1/categories/n18mhdznrqw?filter%5Bsku.availability%5D=true%2Cfalse&page%5Blimit%5D=40&page%5Boffset%5D=40&slug=men-we-made-too-much&token=secretvalue';

test('each section product-data request is the category endpoint named by the section URL category id', () => {
  assert.deepEqual(SECTIONS.map(productDataPath), ['/.uf-svc/v1/categories/n16o10z8mhd', '/.uf-svc/v1/categories/n18mhdznrqw', '/.uf-svc/v1/categories/n14w56z8mhd']);
});

test('a 4xx on the View More product-data request (the section category) stops the run, logging only status and path', async () => {
  for (const status of [400, 404, 418, 499]) {
    const log = [];
    const page = clickingPage([initial, initial], [response(MEN_DATA, status, status % 2 ? 'fetch' : 'xhr')]);
    const error = await collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) }).catch(caught => caught);
    assert.equal(error.message, `Collection refused by retailer: View More product-data request HTTP ${status} /.uf-svc/v1/categories/n18mhdznrqw. No publication.`);
    assert.ok(log.includes(`Men product-data XHR after click 1: HTTP ${status} /.uf-svc/v1/categories/n18mhdznrqw`), log.join('\n'));
    assert.doesNotMatch(log.join('\n') + error.message, /secret|offset|slug|\?/);
    assert.deepEqual(page.trace, [SECTIONS[1].url, 'click']);
  }
});

test('a 4xx on any other retailer XHR after a click is logged and expansion continues', async () => {
  const log = [];
  const page = clickingPage([initial, { ...initial, indicators: loading, visibleButtons: 0, link: null }, complete, complete], [
    response('https://shop.lululemon.com/api/dataenablement/profile', 404), response('https://shop.lululemon.com/api/graphql', 400, 'fetch'),
    response('https://shop.lululemon.com/.uf-svc/v1/categories/n16o10z8mhd?page%5Boffset%5D=40', 400),
    response('https://shop.lululemon.com/.uf-svc/v1/stores?filter%5Bcountry%5D=CA', 410),
  ]);
  assert.match(await collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) }), /product-grid/);
  assert.deepEqual(log.filter(line => line.includes('XHR')), [
    'Men XHR after click 1: HTTP 404 /api/dataenablement/profile', 'Men XHR after click 1: HTTP 400 /api/graphql',
    'Men XHR after click 1: HTTP 400 /.uf-svc/v1/categories/n16o10z8mhd', 'Men XHR after click 1: HTTP 410 /.uf-svc/v1/stores',
  ]);
  assert.equal(log.at(-1), 'Men complete: 2 of 2 products after 1 View More clicks.');
});

test('successful, non-XHR, other-host and pre-click responses do not stop expansion; only post-click retailer XHRs are logged', async () => {
  const log = [];
  const page = clickingPage([initial, { ...initial, indicators: loading, visibleButtons: 0 }, complete, complete], [
    response('https://shop.lululemon.com/.uf-svc/v1/categories/n16o10z8mhd?page%5Boffset%5D=40', 200), response('https://shop.lululemon.com/api/next', 304, 'fetch'),
    response('https://shop.lululemon.com/missing.png', 404, 'image'), response('https://analytics.example/collect', 400),
  ], [response('https://shop.lululemon.com/.uf-svc/v1/categories/n16o10z8mhd', 404)]);
  assert.match(await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) }), /product-grid/);
  assert.deepEqual(log.filter(line => line.includes('XHR')), ['Women product-data XHR after click 1: HTTP 200 /.uf-svc/v1/categories/n16o10z8mhd', 'Women XHR after click 1: HTTP 304 /api/next']);
});

test('401, 403 and 429 from any retailer resource still refuse, before or after a click, product data or not', async () => {
  for (const [status, url, type, when] of [[429, 'https://shop.lululemon.com/missing.png', 'image', 'after'], [403, 'https://shop.lululemon.com/api/dataenablement/profile', 'xhr', 'after'],
    [401, 'https://shop.lululemon.com/api/graphql', 'fetch', 'before'], [403, MEN_DATA, 'xhr', 'after']]) {
    const path = new URL(url).pathname;
    const page = clickingPage([initial, initial], when === 'after' ? [response(url, status, type)] : [], when === 'before' ? [response(url, status, type)] : []);
    const expected = url === MEN_DATA ? `View More product-data request HTTP ${status} ${path}` : `HTTP ${status} ${path}`;
    await assert.rejects(collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 50 }), { message: `Collection refused by retailer: ${expected}. No publication.` });
  }
});

test('the browser-side reader reports the View More link disabled and aria-disabled attributes', () => {
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  /** Make a visible element double. @param {object} extra Fields. @returns {object} Element. */
  const element = (extra = {}) => ({ getClientRects: () => [1], closest: () => null, querySelectorAll: () => [], getAttribute: () => null, ...extra });
  try {
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    const link = element({ getAttribute: name => (name === 'aria-disabled' ? 'true' : null) });
    globalThis.document = { title: '', body: { innerText: '' }, getElementById: () => null,
      querySelectorAll: selector => (selector.includes('view_more') ? [link] : selector.includes('product-grid') ? [element()] : []) };
    const facts = readUiFacts();
    assert.deepEqual(facts.link, { disabled: false, ariaDisabled: 'true' });
    assert.equal(facts.enabled, false);
  } finally { Object.assign(globalThis, saved); }
});

test('permanent product image carousel progress bars are not loading, but any other visible indicator is', () => {
  const carousels = Array.from({ length: 6 }, () => ({ carousel: true }));
  assert.equal(classifyUiState({ ...initial, indicators: carousels }).busy, false);
  assert.equal(classifyUiState({ ...initial, indicators: [...carousels, ...loading] }).busy, true);
  assert.throws(() => classifyUiState({ ...initial, indicators: undefined }), /malformed/i);
});

test('live Women page state (2026-10-14): permanent carousel bars do not block the View More link expansion', async () => {
  const carousels = Array.from({ length: 6 }, () => ({ carousel: true }));
  const probe = { ...initial, cards: 40, total: 80, indicators: carousels };
  const done = { ...probe, cards: 80, buttons: 0, visibleButtons: 0, enabled: false };
  const page = fakePage([probe, { ...probe, indicators: [...carousels, ...loading] }, done, done]);
  const html = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 });
  assert.match(html, /product-grid/);
  assert.deepEqual(page.trace, [SECTIONS[0].url, 'click']);
});

test('a section is complete only when loaded cards equal the page total; anything short or unknown stops', async () => {
  const settings = { paceMs: 0, pollMs: 1, timeoutMs: 3 };
  const short = { ...initial, cards: 40, total: 609, buttons: 0, visibleButtons: 0, enabled: false };
  await assert.rejects(collectSection(fakePage([short, short]), SECTIONS[0], settings), /Incomplete section: 40 of 609/);
  await assert.rejects(collectSection(fakePage([{ ...short, total: null }, { ...short, total: null }]), SECTIONS[0], settings), /40 of unknown/);
  const full = { ...short, total: 40 };
  assert.match(await collectSection(fakePage([full, full]), SECTIONS[0], settings), /product-grid/);
});

test('a page document without a body yet reads as not settled, and a refusal title is still caught', async () => {
  const saved = globalThis.document;
  try {
    globalThis.document = { body: null, title: '' };
    assert.deepEqual(readUiFacts(), { grids: 0, cards: 0, total: null, buttons: 0, visibleButtons: 0, enabled: false, indicators: [], refusal: false });
    globalThis.document = { body: null, title: 'Access Denied' };
    assert.equal(readUiFacts().refusal, true);
  } finally { globalThis.document = saved; }
  const noBody = { grids: 0, cards: 0, total: null, buttons: 0, visibleButtons: 0, enabled: false, indicators: [], refusal: false };
  const full = { ...initial, cards: 2, total: 2, buttons: 0, visibleButtons: 0, enabled: false };
  const page = fakePage([full]);
  let reads = 0; const read = page.evaluate; page.evaluate = async () => (reads++ === 0 ? noBody : read());
  assert.match(await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }), /product-grid/);
  await assert.rejects(collectSection(fakePage([noBody]), SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 3 }), /incomplete|stall/i);
});
