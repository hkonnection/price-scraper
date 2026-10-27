import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrid, combineSections, collectSection, classifyUiState, readUiFacts, productDataPath, gridProducts, expectedTotal, SECTIONS } from './lululemon-grid.mjs';

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

/** Make a synthetic browser response. @param {string} url URL. @param {number} status Status. @param {string} type Resource type. @param {*} body JSON body, if any. @returns {object} Response double. */
function response(url, status, type = 'xhr', body) { return { url: () => url, status: () => status, request: () => ({ resourceType: () => type }), json: async () => body }; }
/** Make the section's View More product-data response. @param {string} sectionUrl Section page URL. @param {*} total Product total it reports. @param {number} offset Page offset. @returns {object} Response double. */
function productData(sectionUrl, total, offset = 40) {
  return response(`https://shop.lululemon.com/.uf-svc/v1/categories/${new URL(sectionUrl).pathname.split('/').pop()}?page%5Blimit%5D=40&page%5Boffset%5D=${offset}`, 200, 'xhr', { data: { attributes: { totalCount: total } } });
}
/** Simulate UI states without any browser/network. Each View More click delivers a product-data response reporting
 * `page.productData` (default: the last state's total); set it to false for none. @param {object[]} states Ordered DOM snapshots. @param {number} status HTTP status. @returns {object} Page double and trace. */
function fakePage(states, status = 200) {
  let index = 0, clicked = false;
  const trace = [], listeners = {};
  const page = { trace, frames: () => [], mainFrame: () => null, on: (event, fn) => { (listeners[event] ||= []).push(fn); }, off: () => {}, url: () => trace[0] ?? 'about:blank',
    emit: (event, value) => (listeners[event] || []).forEach(fn => fn(value)),
    goto: async url => { trace.push(url); return { status: () => status, ok: () => status === 200 }; },
    evaluate: async () => { const result = states[index]; if (clicked && index < states.length - 1) index++; return result; },
    waitForTimeout: async () => {},
    // The saved grid holds one distinct product per card of the state read last, unless a test sets page.html.
    locator: selector => ({ evaluate: async () => page.html ?? grid(Array.from({ length: (await page.evaluate())?.cards ?? 2 }, (_, i) => tile('p' + i)).join('')), click: async () => {
      clicked = true; trace.push(selector.includes('view_more') ? 'click' : 'wrong click');
      if (page.productData !== false) page.emit('response', productData(trace[0], page.productData ?? states.at(-1)?.total));
    } }),
  };
  return page;
}
test('collector stops before another click when refusal arrives during ordinary pacing', async () => {
  const page = fakePage([initial]);
  page.waitForTimeout = async () => { page.evaluate = async () => ({ ...initial, refusal: true }); };
  await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 1, pollMs: 1, timeoutMs: 3 }), /refus/i);
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

/** Read synthetic rendered text through the real browser-side reader. @param {string} text Body text. @param {string} title Title. @param {boolean} body Whether a body exists. @returns {object} UI facts. */
function renderedFacts(text, title = '', body = true) {
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  const link = { getClientRects: () => [1], getAttribute: () => null, __reactProps$test: {} };
  try {
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    globalThis.document = { title, body: body ? { innerText: text } : null,
      getElementById: () => ({ textContent: JSON.stringify({ props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['catalogPageData'], state: { data: { pages: [{ data: { attributes: { totalCount: 2 } } }] } } }] } } } }) }),
      querySelectorAll: selector => selector.includes('product-grid') ? [{ querySelectorAll: () => [1] }] : selector.includes('view_more') ? [link] : [] };
    return readUiFacts();
  } finally { Object.assign(globalThis, saved); }
}

/** Verify actual rendered challenge detection stops collection before any interaction. */
test('Press & Hold rendered body, title and missing-body title stop without clicking or retry metadata', async () => {
  for (const text of ['Press & Hold', 'PRESS AND HOLD', 'Press\n&\u00a0Hold', 'press&hold']) {
    for (const facts of [renderedFacts(text), renderedFacts('', text), renderedFacts('', text, false)]) {
      assert.equal(facts.refusal, true, text);
      assert.equal(facts.challenge, 'press-and-hold');
      const page = fakePage([facts]);
      const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2, readyTimeoutMs: 2 }).catch(caught => caught);
      assert.match(error.message, /refused/i);
      assert.equal(error.challenge, 'press-and-hold');
      assert.equal(error.short, undefined);
      assert.deepEqual(page.trace, [SECTIONS[0].url]);
    }
  }
  assert.equal(renderedFacts('Shop sale shirts and bags').refusal, false);
});

/** Require passive child-frame detection without interacting with challenge controls or leaking frame data. */
test('frame-only Press & Hold stops before listing clicks and ignores detached frames', async () => {
  for (const afterClick of [false, true]) {
    const page = fakePage(afterClick ? [initial, complete] : [initial]);
    const top = { evaluate: async () => { throw Error('main frame must not be read twice'); } };
    const detached = { isDetached: () => true, evaluate: async () => { throw Error('detached frame with private visitor URL'); } };
    let frameReads = 0;
    const challenge = { evaluate: async (reader, options) => {
      assert.equal(reader, readUiFacts);
      assert.deepEqual(options, { refusalOnly: true });
      frameReads++;
      return renderedFacts(afterClick && !page.trace.includes('click') ? 'Ordinary embedded content' : 'Press & Hold');
    } };
    page.mainFrame = () => top;
    page.frames = () => [top, detached, challenge];
    const error = await collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(caught => caught);
    assert.equal(error.challenge, 'press-and-hold');
    assert.equal(error.short, undefined);
    assert.doesNotMatch(error.message, /private|visitor/);
    assert.equal(page.trace.filter(item => item === 'click').length, afterClick ? 1 : 0);
    assert.ok(frameReads > 0);
    assert.equal(initial.refusal, false, 'frame results must not mutate the listing snapshot');
    assert.equal(initial.challenge, undefined);
  }
});

/** Keep detached or ordinary child frames from rejecting an otherwise complete listing. */
test('ordinary and detached child frames do not change positive listing completion', async () => {
  const page = fakePage([initial, complete]);
  page.frames = () => [{ isDetached: () => true, evaluate: async () => { throw Error('Frame was detached'); } }, { isDetached: () => false, evaluate: async () => ({ refusal: false }) }];
  assert.match(await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2 }), /product-grid/);
});

/** Bound pending frame work before and after listing interaction without mistaking unreadability for safety. */
test('passive inspection deadline stops pending frames without a retry', async t => {
  for (const mode of ['pending-navigation', 'busy-frame', 'after-click', 'renavigation']) await t.test(mode, async () => {
    const page = fakePage([initial, complete]);
    let frameReads = 0, guard;
    const frame = { isDetached: () => false, evaluate: async () => {
      frameReads++;
      if (['after-click', 'renavigation'].includes(mode) && !page.trace.includes('click')) return { refusal: false };
      return new Promise(() => {});
    } };
    page.frames = () => [frame];
    const started = performance.now();
    const failure = await Promise.race([
      collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(error => error),
      new Promise(resolve => { guard = setTimeout(() => resolve(Error('test guard: collector did not return')), 3200); }),
    ]).finally(() => clearTimeout(guard));
    assert.equal(failure.challenge, 'inspection-unavailable');
    assert.equal(failure.frameHost, 'unknown');
    assert.equal(failure.short, undefined);
    assert.ok(performance.now() - started < 3000, 'passive inspection must have a bounded exit');
    assert.equal(page.trace.filter(value => value === 'click').length, ['after-click', 'renavigation'].includes(mode) ? 1 : 0);
    assert.equal(frameReads, ['after-click', 'renavigation'].includes(mode) ? 3 : 1);
    assert.doesNotMatch(failure.message, /private|iframe|https?:/);
  });
});

/** Give readable frames independent bounded time even when their combined read exceeds two seconds. */
test('passive inspection gives ordinary slow frames independent budgets', async () => {
  const page = fakePage([complete]);
  let reads = 0;
  page.frames = () => Array.from({ length: 2 }, () => ({ isDetached: () => false, evaluate: async () => {
    reads++;
    await new Promise(resolve => setTimeout(resolve, 1100));
    return { refusal: false };
  } }));
  const started = performance.now();
  assert.match(await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2 }), /product-grid/);
  assert.equal(reads, 4, 'both frames must be inspected at initial and final settling');
  assert.ok(performance.now() - started >= 4000);
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

/** Stop distinctly on unreadable frames and never expose URL content in stop metadata. */
test('unavailable inspection reports only the implicated sanitized host or unknown', async () => {
  for (const [href, host] of [
    ['https://user:secret@SLOW.Example:8443/private/path?token=secret#fragment', 'slow.example'],
    ['https://frame.example./private', 'frame.example'],
    ['data:text/html,private-secret', 'unknown'], ['about:blank', 'unknown'], ['not a URL', 'unknown'],
  ]) {
    const page = fakePage([initial]);
    page.frames = () => [{ url: () => href, isDetached: () => false, evaluate: async () => { throw Error('private-secret rendered text'); } }];
    const error = await collectSection(page, SECTIONS[0]).catch(error => error);
    assert.equal(error.challenge, 'inspection-unavailable');
    assert.equal(error.frameHost, host);
    assert.equal(error.short, undefined);
    assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /secret|private|path|token|fragment|8443|https?:/);
    assert.deepEqual(page.trace, [SECTIONS[0].url]);
  }
});

/** Exercise actual framed reader output and retain safe identity without challenge input. */
test('framed Press and Hold retains its host and detected kind', async () => {
  const page = fakePage([initial]);
  const frame = { url: () => 'https://user:secret@challenge.example/check?secret#private', isDetached: () => false,
    evaluate: async (reader, options) => {
      const saved = globalThis.document;
      try { globalThis.document = { title: '', body: { innerText: 'Press and Hold' } }; return reader(options); }
      finally { globalThis.document = saved; }
    } };
  page.frames = () => [frame];
  const error = await collectSection(page, SECTIONS[0]).catch(error => error);
  assert.equal(error.challenge, 'press-and-hold');
  assert.equal(error.frameHost, 'challenge.example');
  assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /secret|private|check|https?:/);
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

/** Attribute a detected framed challenge to its own host even when an HTTP refusal was also observed. */
test('detected framed challenge retains its own host beside an HTTP refusal', async () => {
  const page = fakePage([initial, complete]);
  const frame = { url: () => 'https://challenge.example/private?secret', isDetached: () => false,
    evaluate: async () => page.trace.includes('click') ? { refusal: true, challenge: 'press-and-hold' } : { refusal: false } };
  page.frames = () => [frame];
  const locator = page.locator;
  page.locator = selector => ({ ...locator(selector), click: async () => {
    page.trace.push('click'); page.emit('response', response('https://shop.lululemon.com/private?secret', 403));
  } });
  const error = await collectSection(page, SECTIONS[0], { paceMs: 0 }).catch(error => error);
  assert.equal(error.challenge, 'press-and-hold');
  assert.equal(error.frameHost, 'challenge.example');
  assert.equal(page.trace.filter(value => value === 'click').length, 1);
});

/** Run the real framed fixture only in an explicit offline headed browser validation session. */
test('headed offline framed Press and Hold fixture stops without input', { skip: process.env.LULU_HEADED_FIXTURES !== '1' }, async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: ['--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--disable-background-networking'] });
  let inputs = 0, listingClicks = 0, unexpectedRoutes = 0;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.exposeBinding('fixtureInput', () => { inputs++; });
    await context.exposeBinding('fixtureListingClick', () => { listingClicks++; });
    await context.addInitScript(() => {
      for (const event of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'keydown']) {
        addEventListener(event, () => { if (location.hostname === 'challenge.example') globalThis.fixtureInput(); }, true);
      }
    });
    await context.route('**/*', async route => {
      const host = new URL(route.request().url()).hostname;
      if (host === 'challenge.example') return route.fulfill({ contentType: 'text/html', body: '<html><body><button>Press and Hold</button></body></html>' });
      if (host === 'shop.lululemon.com') return route.fulfill({ contentType: 'text/html', body: grid(tile('fixture').replace(/<img[^>]*>/, '')) +
        '<button data-lll-component-name="cdp:view_more_products" onclick="fixtureListingClick()">View More</button><iframe src="https://challenge.example/private?token=synthetic#fragment"></iframe>' });
      unexpectedRoutes++; await route.abort();
    });
    const page = await context.newPage();
    const goto = page.goto.bind(page);
    page.goto = async (...args) => { const response = await goto(...args); await page.waitForLoadState('load'); return response; };
    const error = await collectSection(page, SECTIONS[0], { paceMs: 0, readyTimeoutMs: 1 }).catch(error => error);
    assert.equal(error.challenge, 'press-and-hold');
    assert.equal(error.frameHost, 'challenge.example');
    assert.equal(error.short, undefined);
    assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /private|token|fragment|synthetic|https?:/);
    assert.equal(inputs, 0); assert.equal(listingClicks, 0); assert.equal(unexpectedRoutes, 0);
  } finally { await browser.close(); }
});

/** Treat a loading child document or failed frame inventory as unavailable, never as proof of safety. */
test('loading frame and frame churn fail closed with bounded metadata', async t => {
  for (const mode of ['missing-body', 'inventory-failed', 'detachment-check-failed']) await t.test(mode, async () => {
    const page = fakePage([initial]);
    const frame = { url: () => 'https://loading.example/private?secret',
      isDetached: () => { if (mode === 'detachment-check-failed') throw Error('private browser diagnostics'); return false; },
      evaluate: async (reader, options) => {
        if (mode === 'detachment-check-failed') throw Error('private read failure');
        const saved = globalThis.document;
        try { globalThis.document = { title: '', body: null }; return reader(options); }
        finally { globalThis.document = saved; }
      } };
    page.frames = () => { if (mode === 'inventory-failed') throw Error('private frame inventory'); return [frame]; };
    const error = await collectSection(page, SECTIONS[0], { readyTimeoutMs: 1, timeoutMs: 1, paceMs: 0 }).catch(error => error);
    assert.equal(error.challenge, 'inspection-unavailable', mode);
    assert.equal(error.frameHost, mode === 'inventory-failed' ? 'shop.lululemon.com' : 'loading.example');
    assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /private|secret|diagnostics/);
    assert.deepEqual(page.trace, [SECTIONS[0].url]);
  });
});

/** Clear deadline timers and consume a frame rejection that arrives after collection has stopped. */
test('passive deadline clears timers and consumes late evaluation rejection', async t => {
  const page = fakePage([initial]);
  let rejectLate;
  const outstanding = new Set();
  const start = globalThis.setTimeout, clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = start(callback, ms, ...args); outstanding.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { outstanding.delete(timer); return clear(timer); });
  page.frames = () => [{ isDetached: () => false, evaluate: () => new Promise((_, reject) => { rejectLate = reject; }) }];
  const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(error => error);
  assert.equal(error.challenge, 'inspection-unavailable');
  assert.equal(outstanding.size, 0);
  rejectLate(Error('private late frame error'));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
});

/** Bound the main document too, including the one inspection permitted after a failed click. */
test('failed listing click passive inspection deadline cannot hang on the main document', async () => {
  const page = fakePage([initial]);
  let failed = false, attempts = 0;
  page.evaluate = async () => failed ? new Promise(() => {}) : initial;
  const locator = page.locator;
  page.locator = selector => ({ ...locator(selector), click: async () => { failed = true; attempts++; throw Error('click timed out'); } });
  const started = performance.now();
  const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(error => error);
  assert.equal(error.challenge, 'inspection-unavailable');
  assert.equal(error.frameHost, 'shop.lululemon.com');
  assert.equal(attempts, 1);
  assert.ok(performance.now() - started < 2800);
});

/** Stop on unknown frame read failures rather than silently skipping a possible challenge. */
test('unreadable non-detached frame fails closed even when its error claims detachment', async () => {
  const page = fakePage([initial, complete]);
  page.frames = () => [{ isDetached: () => false, evaluate: async () => { throw Error('Frame was detached private visitor URL'); } }];
  const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(error => error);
  assert.equal(error.challenge, 'inspection-unavailable');
  assert.equal(error.frameHost, 'unknown');
  assert.doesNotMatch(error.message, /private|visitor|detached/);
  assert.equal(page.trace.includes('click'), false);
});

/** Inspect once after a failed listing click, without retrying the click or masking an ordinary failure. */
test('failed listing click receives one passive refusal inspection and no click retry', async () => {
  for (const mode of ['frame', 'main', 'ordinary', 'read-failure']) {
    const page = fakePage([initial]);
    const clickError = Error('Original listing click timed out');
    let failed = false, attempts = 0, readsAfter = 0, frameReadsAfter = 0;
    page.evaluate = async () => {
      if (failed) {
        readsAfter++;
        if (mode === 'read-failure') throw Error('Temporary navigation failure');
        if (mode === 'main') return { ...initial, refusal: true, challenge: 'press-and-hold' };
      }
      return initial;
    };
    page.frames = () => mode === 'frame' && failed ? [{ isDetached: () => false, evaluate: async () => {
      frameReadsAfter++;
      return { refusal: true, challenge: 'press-and-hold' };
    } }] : [];
    const locator = page.locator;
    page.locator = selector => ({ ...locator(selector), click: async () => { attempts++; failed = true; throw clickError; } });
    const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(error => error);
    assert.equal(attempts, 1, mode);
    assert.equal(readsAfter, 1, mode);
    assert.equal(frameReadsAfter, mode === 'frame' ? 1 : 0);
    if (['frame', 'main'].includes(mode)) assert.equal(error.challenge, 'press-and-hold', mode);
    else if (mode === 'read-failure') assert.equal(error.challenge, 'inspection-unavailable');
    else assert.equal(error, clickError, mode);
  }
});

/** Use only frame title and rendered text when no listing state is requested. */
test('frame refusal reader needs no grid, product, or link DOM query', () => {
  const saved = globalThis.document;
  try {
    globalThis.document = { title: '', body: { innerText: 'Press & Hold' },
      querySelectorAll: () => { throw Error('frame DOM query forbidden'); } };
    assert.deepEqual(readUiFacts({ refusalOnly: true }), { refusal: true, challenge: 'press-and-hold' });
  } finally { globalThis.document = saved; }
});

/** Preserve an already observed refusal when navigation, evaluation or click fails next. */
test('recorded refusal survives a failed browser call with bounded metadata', async () => {
  for (const failedCall of ['goto', 'evaluate', 'click']) {
    const page = fakePage([initial]);
    const blocked = response('https://shop.lululemon.com/blocked?private-visitor=secret', 403, 'document');
    const failure = Object.assign(new Error('Execution context destroyed <iframe src="private-visitor-secret">'), { short: true, grid: 'private HTML' });
    if (failedCall === 'goto') page.goto = async () => { page.emit('response', blocked); throw failure; };
    else {
      const locator = page.locator;
      page.locator = selector => ({ ...locator(selector), click: async () => {
        page.emit('response', blocked);
        if (failedCall === 'click') throw failure;
        page.evaluate = async () => { throw failure; };
      } });
    }
    const error = await collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(caught => caught);
    assert.equal(error.challenge, 'retailer-refusal', failedCall);
    assert.equal(error.short, undefined);
    assert.match(error.message, /HTTP 403/);
    assert.equal(error.frameHost, 'shop.lululemon.com');
    assert.doesNotMatch(error.message, /blocked/);
    assert.doesNotMatch(error.message, /private|secret|iframe|context/);
  }
});

/** Recognize narrowly related challenge spelling and human-verification variants. */
test('review challenge wording variants refuse without listing interaction', async t => {
  for (const [text, kind] of [
    ['Press-and-Hold', 'press-and-hold'], ['Press ＆ Hold', 'press-and-hold'], ['Press\u200b & Hold', 'press-and-hold'],
    ['Please verify you are a human', 'retailer-refusal'], ['Access to this page has been denied', 'retailer-refusal'],
    ['Are you a robot? Complete the check to continue.', 'retailer-refusal'],
  ]) await t.test(text, async () => {
    for (const facts of [renderedFacts(text), renderedFacts('', text, false)]) {
      assert.equal(facts.refusal, true, text);
      const page = fakePage([facts]);
      const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2, readyTimeoutMs: 2 }).catch(caught => caught);
      assert.equal(error.challenge, kind, text);
      assert.deepEqual(page.trace, [SECTIONS[0].url]);
    }
  });
});

/** Refuse zero product-data totals after Show More rather than certifying positive captures. */
test('zero total after Show More cannot certify a section or trigger re-paging', async () => {
  for (const totals of [[0], [120, 0], [0, 2]]) assert.throws(() => expectedTotal({ cards: 2, unique: 2 }, totals.length, totals, 2), /no product total/i);
  const page = fakePage([initial, complete]); page.productData = 0;
  const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(caught => caught);
  assert.match(error.message, /no product total/i);
  assert.equal(error.short, undefined);
  assert.equal(expectedTotal({ cards: 3, unique: 3 }, 1, [2], 3).total, 2);
});

/** Verify challenge detection at every interaction boundary. */
test('Press & Hold during pacing, after expansion and final settling prevents the next interaction', async () => {
  const challenge = { ...initial, ...renderedFacts('Press & Hold'), cards: 2, buttons: 0, visibleButtons: 0 };
  for (const boundary of ['pacing', 'after-click', 'final']) {
    const page = fakePage([initial]); let reads = 0;
    const states = boundary === 'pacing' ? [initial, challenge] : boundary === 'after-click' ? [initial, initial, challenge] : [complete, challenge];
    page.evaluate = async () => states[Math.min(reads++, states.length - 1)];
    const error = await collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(caught => caught);
    assert.equal(error.challenge, 'press-and-hold', boundary);
    assert.equal(error.short, undefined);
    assert.equal(page.trace.filter(item => item === 'click').length, boundary === 'after-click' ? 1 : 0);
  }
});

const initial = { grids: 1, cards: 1, total: 2, buttons: 1, visibleButtons: 1, enabled: true, link: { disabled: false, ariaDisabled: null, handled: true }, indicators: [], refusal: false };
const loading = [{ carousel: false }];
const complete = { ...initial, cards: 2, buttons: 0, visibleButtons: 0 };

test('HTTP 429 resource refusal halts before clicking without reading any network body', async () => {
  const page = fakePage([initial]); let listener;
  page.on = (event, fn) => { if (event === 'response') listener = fn; };
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

/** Make a page whose View More click delivers only the given responses to the collector's listener. @param {object[]} states UI states. @param {object[]} afterClick Responses fired on click. @param {object[]} beforeClick Responses fired on load. @returns {object} Page double. */
function clickingPage(states, afterClick, beforeClick = []) {
  const page = fakePage(states); page.productData = false;
  const goto = page.goto; page.goto = async url => { const result = await goto(url); beforeClick.forEach(r => page.emit('response', r)); return result; };
  const locator = page.locator; page.locator = selector => { const real = locator(selector); return { ...real, click: async () => { await real.click(); afterClick.forEach(r => page.emit('response', r)); } }; };
  return page;
}

test('run.log records each View More click, each link check and the expansion total', async () => {
  const log = [];
  const page = fakePage([initial, { ...initial, indicators: loading, visibleButtons: 0, link: null }, complete, complete]);
  await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) });
  assert.ok(log.includes('Women View More check 1 (before click 1): visible 1/1, disabled false, aria-disabled none, enabled true, page handler true.'), log.join('\n'));
  assert.ok(log.includes('Women View More check 2 (pre-click 1): visible 1/1, disabled false, aria-disabled none, enabled true, page handler true.'), log.join('\n'));
  assert.ok(log.includes('Women View More click 1 at 1 cards.'));
  assert.ok(log.some(line => /^Women View More check \d+ \(after click 1\): visible 0\/1, disabled n\/a, aria-disabled n\/a, enabled true, page handler n\/a\.$/.test(line)), log.join('\n'));
  assert.equal(log.at(-1), 'Women complete: 2 of 2 unique products (2 cards, 0 repeated) after 1 View More clicks (last product-data total; product-data totals seen 2 in 1 responses; page total 2).');
});

test('a repeat count names the last repeated check and the click it followed, even when flushed by the next click', async () => {
  const log = [];
  const one = { ...initial, total: 3 }, two = { ...one, cards: 2 }, done = { ...one, cards: 3, buttons: 0, visibleButtons: 0, link: null };
  // Before click 1: check 1 (poll), check 2 (pre-click). After click 1: checks 3-5 read 1 card, check 6 reads 2 cards (same link facts).
  // Check 7 is pre-click 2; check 8 follows click 2; then the link is gone.
  const reads = [one, one, one, one, one, two, two, two, done];
  const page = fakePage([]); let index = 0; page.evaluate = async () => reads[Math.min(index++, reads.length - 1)]; page.productData = 3;
  await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) });
  const repeat1 = 'Women View More check 6 (after click 1): same result repeated 4 more times.';
  assert.deepEqual(log, [
    'Women View More check 1 (before click 1): visible 1/1, disabled false, aria-disabled none, enabled true, page handler true.',
    'Women View More check 2 (pre-click 1): visible 1/1, disabled false, aria-disabled none, enabled true, page handler true.',
    'Women View More click 1 at 1 cards.',
    'Women product-data XHR after click 1: HTTP 200 /.uf-svc/v1/categories/n16o10z8mhd',
    repeat1,
    `Women after click 1: URL ${WOMEN_PATH} → ${WOMEN_PATH}, cards 1 → 2, document unknown, main-frame navigations 0, load events 0, DOMContentLoaded 0, retailer requests xhr 1, other-host requests 0.`,
    'Women View More check 7 (pre-click 2): visible 1/1, disabled false, aria-disabled none, enabled true, page handler true.',
    'Women View More click 2 at 2 cards.',
    'Women product-data XHR after click 2: HTTP 200 /.uf-svc/v1/categories/n16o10z8mhd',
    'Women View More check 8 (after click 2): same result repeated 1 more times.',
    `Women after click 2: URL ${WOMEN_PATH} → ${WOMEN_PATH}, cards 2 → 3, document unknown, main-frame navigations 0, load events 0, DOMContentLoaded 0, retailer requests xhr 1, other-host requests 0.`,
    'Women complete: 3 of 3 unique products (3 cards, 0 repeated) after 2 View More clicks (last product-data total; product-data totals seen 3 in 2 responses; page total 3).',
  ]);
});

test('repeated identical link checks are counted, and a stall says the click count and last link state', async () => {
  const log = [];
  const stuck = { ...initial, link: { disabled: false, ariaDisabled: null, handled: true } };
  const error = await collectSection(fakePage([stuck, stuck]), SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 6, log: line => log.push(line) }).catch(caught => caught);
  assert.equal(error.message, 'Incomplete expansion or stalled loading (cards 1, busy false, View More 1/1 visible, link disabled false, aria-disabled none, enabled true, page handler true; after click 1 of View More).');
  assert.ok(log.some(line => /^Women View More check \d+ \(after click 1\): same result repeated \d+ more times\.$/.test(line)), log.join('\n'));
  const disabled = { ...initial, enabled: false, link: { disabled: false, ariaDisabled: 'true', handled: true } };
  await assert.rejects(collectSection(fakePage([disabled]), SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 2, readyTimeoutMs: 2 }),
    { message: 'Incomplete expansion or stalled loading (cards 1, busy false, View More 1/1 visible, link disabled false, aria-disabled true, enabled false, page handler true; before the first View More click).' });
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
    assert.equal(error.message, `Collection refused by retailer: View More product-data request HTTP ${status}. No publication.`);
    assert.equal(error.frameHost, 'shop.lululemon.com');
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
    response('https://shop.lululemon.com/.uf-svc/v1/stores?filter%5Bcountry%5D=CA', 410), productData(SECTIONS[1].url, 2),
  ]);
  assert.match(await collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) }), /product-grid/);
  assert.deepEqual(log.filter(line => line.includes('XHR')), [
    'Men XHR after click 1: HTTP 404 /api/dataenablement/profile', 'Men XHR after click 1: HTTP 400 /api/graphql',
    'Men XHR after click 1: HTTP 400 /.uf-svc/v1/categories/n16o10z8mhd', 'Men XHR after click 1: HTTP 410 /.uf-svc/v1/stores',
    'Men product-data XHR after click 1: HTTP 200 /.uf-svc/v1/categories/n18mhdznrqw',
  ]);
  assert.equal(log.at(-1), 'Men complete: 2 of 2 unique products (2 cards, 0 repeated) after 1 View More clicks (last product-data total; product-data totals seen 2 in 1 responses; page total 2).');
});

test('successful, non-XHR, other-host and pre-click responses do not stop expansion; only post-click retailer XHRs are logged', async () => {
  const log = [];
  const page = clickingPage([initial, { ...initial, indicators: loading, visibleButtons: 0 }, complete, complete], [
    productData(SECTIONS[0].url, 2), response('https://shop.lululemon.com/api/next', 304, 'fetch'),
    response('https://shop.lululemon.com/missing.png', 404, 'image'), response('https://analytics.example/collect', 400),
  ], [response('https://shop.lululemon.com/.uf-svc/v1/categories/n16o10z8mhd', 404)]);
  assert.match(await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) }), /product-grid/);
  assert.deepEqual(log.filter(line => line.includes('XHR')), ['Women product-data XHR after click 1: HTTP 200 /.uf-svc/v1/categories/n16o10z8mhd', 'Women XHR after click 1: HTTP 304 /api/next']);
});

test('401, 403 and 429 from any retailer resource still refuse, before or after a click, product data or not', async () => {
  for (const [status, url, type, when] of [[429, 'https://shop.lululemon.com/missing.png', 'image', 'after'], [403, 'https://shop.lululemon.com/api/dataenablement/profile', 'xhr', 'after'],
    [401, 'https://shop.lululemon.com/api/graphql', 'fetch', 'before'], [403, MEN_DATA, 'xhr', 'after']]) {
    const page = clickingPage([initial, initial], when === 'after' ? [response(url, status, type)] : [], when === 'before' ? [response(url, status, type)] : []);
    const expected = url === MEN_DATA ? `View More product-data request HTTP ${status}` : `HTTP ${status}`;
    await assert.rejects(collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 50 }), { message: `Collection refused by retailer: ${expected}. No publication.` });
  }
});

const WOMEN_PATH = '/en-ca/c/women-we-made-too-much/n16o10z8mhd';
const WOMEN_DATA = 'https://shop.lululemon.com/.uf-svc/v1/categories/n16o10z8mhd?page%5Blimit%5D=40&page%5Boffset%5D=40';
/** Make a page that records every event listener and runs a scripted reaction when View More is clicked. @param {object[]} states UI states. @param {Function} onClick Receives (emit, page) on click. @returns {object} Page double. */
function scriptedPage(states, onClick) {
  const page = fakePage(states); page.productData = false;
  const locator = page.locator;
  page.locator = selector => { const real = locator(selector); return { ...real, click: async () => { await real.click(); onClick(page.emit, page); } }; };
  return page;
}

test('after each click run.log reports URL, cards, document identity, navigation and load events and request counts (in-page growth)', async () => {
  const log = [];
  const page = scriptedPage([{ ...initial, timeOrigin: 7 }, { ...complete, timeOrigin: 7 }], emit => {
    emit('response', response(WOMEN_DATA, 200, 'xhr', { data: { attributes: { totalCount: 2 } } })); emit('response', response('https://shop.lululemon.com/metrics/ca/ga/g/c', 204, 'fetch'));
    emit('response', response('https://images.lululemon.com/x.jpg', 200, 'image'));
  });
  await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) });
  assert.ok(log.includes(`Women after click 1: URL ${WOMEN_PATH} → ${WOMEN_PATH}, cards 1 → 2, document same (timeOrigin unchanged), main-frame navigations 0, load events 0, DOMContentLoaded 0, retailer requests xhr 1, fetch 1, other-host requests 1.`), log.join('\n'));
  assert.ok(log.indexOf('Women View More click 1 at 1 cards.') < log.findIndex(line => line.startsWith('Women after click 1:')));
});

test('a click that loads a new document is reported as a navigation with the URL change, and the stall still stops the run', async () => {
  const log = []; let url = 'https://shop.lululemon.com' + WOMEN_PATH;
  const page = scriptedPage([{ ...initial, timeOrigin: 7 }, { ...initial, timeOrigin: 9 }], (emit, p) => {
    url = `https://shop.lululemon.com${WOMEN_PATH}?page=2&utm_token=secretvalue`; p.url = () => url;
    emit('response', response(url, 200, 'document')); emit('framenavigated', { parentFrame: () => null }); emit('framenavigated', { parentFrame: () => ({}) });
    emit('domcontentloaded'); emit('load'); emit('response', response('https://shop.lululemon.com/api/graphql', 200));
  });
  page.url = () => url;
  const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 4, log: line => log.push(line) }).catch(caught => caught);
  assert.match(error.message, /^Incomplete expansion or stalled loading \(cards 1, .*after click 1 of View More\)\.$/);
  assert.ok(log.includes(`Women document after click 1: HTTP 200 ${WOMEN_PATH}?page=2 (other query omitted)`), log.join('\n'));
  assert.ok(log.includes(`Women after click 1: URL ${WOMEN_PATH} → ${WOMEN_PATH}?page=2 (other query omitted), cards 1 → 1, document new (timeOrigin changed), main-frame navigations 1, load events 1, DOMContentLoaded 1, retailer requests document 1, xhr 1, other-host requests 0.`), log.join('\n'));
  assert.doesNotMatch(log.join('\n'), /secret|utm/);
});

test('requests during the pause before a click are not labelled as after that click', async () => {
  const log = []; let fired = false;
  const page = fakePage([initial, complete, complete]);
  page.waitForTimeout = async () => { if (!fired) { fired = true; page.emit('response', response('https://shop.lululemon.com/akam/13/pixel_x', 200)); } };
  await collectSection(page, SECTIONS[0], { paceMs: 1, pollMs: 1, timeoutMs: 50, log: line => log.push(line) });
  assert.ok(!log.some(line => line.includes('/akam/')), log.join('\n'));
  assert.ok(log.includes('Women View More click 1 at 1 cards.'));
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
    assert.deepEqual(facts.link, { disabled: false, ariaDisabled: 'true', handled: false });
    assert.equal(facts.timeOrigin, performance.timeOrigin);
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
  await assert.rejects(collectSection(fakePage([noBody]), SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 3, readyTimeoutMs: 3 }), /incomplete|stall/i);
});

test('the browser-side reader reports whether the page script has taken over the View More link (React props on the element)', () => {
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  /** Make a visible element double. @param {object} extra Fields. @returns {object} Element. */
  const element = (extra = {}) => ({ getClientRects: () => [1], closest: () => null, querySelectorAll: () => [], getAttribute: () => null, ...extra });
  try {
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    for (const [extra, handled] of [[{}, false], [{ __reactFiber$x1: {} }, false], [{ __reactProps$x1: { onClick() {} } }, true], [{ __reactProps$x1: {} }, true]]) {
      const link = element(extra);
      globalThis.document = { title: '', body: { innerText: '' }, getElementById: () => null,
        querySelectorAll: selector => (selector.includes('view_more') ? [link] : selector.includes('product-grid') ? [element()] : []) };
      assert.deepEqual(readUiFacts().link, { disabled: false, ariaDisabled: null, handled }, JSON.stringify(Object.keys(extra)));
    }
  } finally { Object.assign(globalThis, saved); }
});

test('the first View More click waits until the page script has taken over the link, logging the handler state', async () => {
  const log = [];
  const bare = { ...initial, link: { ...initial.link, handled: false } };
  const reads = [bare, bare, bare, initial, initial, complete, complete];
  const page = fakePage([]); let index = 0; page.evaluate = async () => reads[Math.min(index++, reads.length - 1)];
  const locator = page.locator; page.locator = selector => ({ ...locator(selector), click: async () => { page.trace.push(`click at read ${index}`); page.emit('response', productData(SECTIONS[0].url, 2)); } });
  assert.match(await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) }), /product-grid/);
  assert.deepEqual(page.trace, [SECTIONS[0].url, 'click at read 5']);
  assert.deepEqual(log.slice(0, 5), [
    'Women View More check 1 (before click 1): visible 1/1, disabled false, aria-disabled none, enabled true, page handler false.',
    'Women View More check 3 (before click 1): same result repeated 2 more times.',
    'Women View More check 4 (before click 1): visible 1/1, disabled false, aria-disabled none, enabled true, page handler true.',
    'Women View More check 5 (pre-click 1): visible 1/1, disabled false, aria-disabled none, enabled true, page handler true.',
    'Women View More click 1 at 1 cards.',
  ]);
});

test('a View More link the page script never takes over stops the section before any click, after the longer first wait', async () => {
  const bare = { ...initial, link: { ...initial.link, handled: false } };
  let reads = 0;
  const page = fakePage([bare]); const read = page.evaluate; page.evaluate = async () => { reads++; return read(); };
  await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 3, readyTimeoutMs: 20 }),
    { message: 'Incomplete expansion or stalled loading (cards 1, busy false, View More 1/1 visible, link disabled false, aria-disabled none, enabled true, page handler false; before the first View More click).' });
  assert.equal(reads, 21);
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

test('a link that loses its page handler during the pause before a click is not clicked', async () => {
  const bare = { ...initial, link: { ...initial.link, handled: false } };
  const reads = [initial, bare];
  const page = fakePage([]); let index = 0; page.evaluate = async () => reads[Math.min(index++, reads.length - 1)];
  await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 3 }), { message: 'Incomplete expansion: UI changed before View More.' });
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

test('a clicked section is complete when its cards equal the product-data total, even when the page shows a larger total', async () => {
  const log = [];
  const shown = { ...initial, total: 5 }, done = { ...complete, total: 5 };
  const page = fakePage([shown, done, done]); page.productData = 2;
  assert.match(await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) }), /product-grid/);
  assert.equal(log.at(-1), 'Women complete: 2 of 2 unique products (2 cards, 0 repeated) after 1 View More clicks (last product-data total; product-data totals seen 2 in 1 responses; page total 5).');
});

test('a clicked section stops when the product-data total is larger than the cards loaded, or the total is missing or not an integer', async () => {
  const shown = { ...initial, total: 5 }, done = { ...complete, total: 5 };
  const missing = 'Incomplete section: a product-data response gave no product total (2 cards loaded; page total 5).';
  for (const [body, message] of [
    [{ data: { attributes: { totalCount: 3 } } }, 'Incomplete section: 2 of 3 unique products loaded (2 cards, 0 repeated; last product-data total; product-data totals seen 3 in 1 responses; page total 5).'],
    [{ data: { attributes: {} } }, missing], [{ data: { attributes: { totalCount: '2' } } }, missing], [{ data: { attributes: { totalCount: 2.5 } } }, missing], [null, missing],
  ]) {
    const page = clickingPage([shown, done, done], [{ ...productData(SECTIONS[0].url, 0), json: async () => body }]);
    await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }), { message }, JSON.stringify(body));
  }
  const broken = clickingPage([shown, done, done], [{ ...productData(SECTIONS[0].url, 2), json: async () => { throw new SyntaxError('Unexpected token'); } }]);
  await assert.rejects(collectSection(broken, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }), { message: 'Incomplete section: a product-data response gave no product total (2 cards loaded; page total 5).' });
});

test('a clicked section stops when no product-data response arrived, and judges changing totals by the last one', async () => {
  const shown = { ...initial, total: 5 }, done = { ...complete, total: 5 };
  const none = clickingPage([shown, done, done], []);
  await assert.rejects(collectSection(none, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }), { message: 'Incomplete section: no product-data response after 1 View More clicks (2 cards loaded; page total 5).' });
  const one = { ...initial, total: 5 }, two = { ...one, cards: 2 }, three = { ...one, cards: 3, buttons: 0, visibleButtons: 0, link: null };
  /** Expand 1 → 2 → 3 cards with two clicks whose product-data responses report the given totals. @param {number[]} totals Totals per click. @param {string[]} log Run.log lines. @returns {Promise<string>} Collector outcome. */
  function run(totals, log = []) {
    const page = fakePage([]); const reads = [one, one, two, two, three, three]; let index = 0, offset = 0;
    page.evaluate = async () => reads[Math.min(index++, reads.length - 1)];
    const locator = page.locator; page.locator = selector => ({ ...locator(selector), click: async () => { page.emit('response', productData(SECTIONS[0].url, totals[offset / 40], offset + 40)); offset += 40; } });
    return collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) });
  }
  const log = [];
  assert.match(await run([4, 3], log), /product-grid/);
  assert.equal(log.at(-1), 'Women complete: 3 of 3 unique products (3 cards, 0 repeated) after 2 View More clicks (last product-data total; product-data totals seen 4, 3 in 2 responses; page total 5).');
  await assert.rejects(run([3, 4]), { message: 'Incomplete section: 3 of 4 unique products loaded (3 cards, 0 repeated; last product-data total; product-data totals seen 3, 4 in 2 responses; page total 5).' });
  await assert.rejects(run([3, null]), { message: 'Incomplete section: a product-data response gave no product total (3 cards loaded; page total 5).' });
});

test('product-data totals come only from the section own successful product-data responses after a click', async () => {
  const shown = { ...initial, total: 5 }, done = { ...complete, total: 5 };
  const other = response('https://shop.lululemon.com/.uf-svc/v1/categories/n18mhdznrqw?page%5Boffset%5D=40', 200, 'xhr', { data: { attributes: { totalCount: 9 } } });
  const graphql = response('https://shop.lululemon.com/api/graphql', 200, 'fetch', { data: { attributes: { totalCount: 9 } } });
  const before = productData(SECTIONS[0].url, 9, 0);
  const page = clickingPage([shown, done, done], [other, graphql, productData(SECTIONS[0].url, 2)], [before]);
  assert.match(await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }), /product-grid/);
});

/** Reject impossible retailer totals instead of accepting any nonnegative captured count as complete. */
test('negative and unsafe retailer totals cannot certify a complete section', () => {
  for (const total of [-1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => expectedTotal({ cards: 2, unique: 2 }, 1, [total], 2), /no product total/i);
    assert.throws(() => expectedTotal({ cards: 2, unique: 2 }, 2, [total, 2], 2), /no product total/i);
    assert.throws(() => expectedTotal({ cards: total, unique: total }, 0, [], total), /Incomplete section/i);
  }
});

/** Preserve bounded metadata for operator notices on every existing refusal path. */
test('HTTP and generic rendered refusals expose only the bounded retailer-refusal kind', async () => {
  for (const page of [fakePage([initial], 403), fakePage([{ ...initial, refusal: true }]), clickingPage([initial], [response(MEN_DATA, 429)])]) {
    const error = await collectSection(page, SECTIONS[1], { paceMs: 0, pollMs: 1, timeoutMs: 2 }).catch(caught => caught);
    assert.equal(error.challenge, 'retailer-refusal');
    assert.equal(error.short, undefined);
    assert.match(error.message, /refus/i);
  }
});

test('the grid product count is distinct store product ids among tiles, the id parseGrid keeps', () => {
  assert.deepEqual(gridProducts(grid(tile('a') + tile('b') + tile('a') + '<div data-testid="product-tile">No link</div>')), { cards: 4, unique: 2 });
  assert.deepEqual(gridProducts(grid(tile('a', 'One') + tile('a', 'Other name', '$5 $9'))), { cards: 2, unique: 1 });
  assert.deepEqual(gridProducts(grid('') + tile('outside')), { cards: 0, unique: 0 });
});

test('repeated cards do not count toward the total: a clicked section stops unless its unique products equal the product-data total', async () => {
  const shown = { ...initial, total: 3 }, done = { ...complete, cards: 3, total: 3 };
  const short = fakePage([shown, done, done]); short.productData = 3; short.html = grid(tile('a') + tile('b') + tile('a'));
  await assert.rejects(collectSection(short, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }),
    { message: 'Incomplete section: 2 of 3 unique products loaded (3 cards, 1 repeated; last product-data total; product-data totals seen 3 in 1 responses; page total 3).' });
  const log = [];
  const full = fakePage([shown, done, done]); full.productData = 2; full.html = grid(tile('a') + tile('b') + tile('a'));
  assert.match(await collectSection(full, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, log: line => log.push(line) }), /product-grid/);
  assert.equal(log.at(-1), 'Women complete: 2 of 2 unique products (3 cards, 1 repeated) after 1 View More clicks (last product-data total; product-data totals seen 2 in 1 responses; page total 3).');
});

test('a section with no View More click is judged by unique products against the page total', async () => {
  const settings = { paceMs: 0, pollMs: 1, timeoutMs: 3 };
  const page = { ...initial, cards: 3, total: 3, buttons: 0, visibleButtons: 0, enabled: false };
  const repeated = fakePage([page, page]); repeated.html = grid(tile('a') + tile('b') + tile('a'));
  await assert.rejects(collectSection(repeated, SECTIONS[2], settings), { message: 'Incomplete section: 2 of 3 unique products loaded (3 cards, 1 repeated).' });
  const log = [];
  assert.match(await collectSection(fakePage([page, page]), SECTIONS[2], { ...settings, log: line => log.push(line) }), /product-grid/);
  assert.equal(log.at(-1), 'Accessories complete: 3 of 3 unique products (3 cards, 0 repeated) after 0 View More clicks (page total, no product-data request; page total 3).');
});

test('503 cards with 21 repeats against a product-data total of 503 stops: only unique store product ids count', async () => {
  const codes = Array.from({ length: 482 }, (_, i) => 'w' + i);
  const html = grid([...codes, ...codes.slice(345, 366)].map(code => tile(code)).join(''));
  const shown = { ...initial, cards: 40, total: 522 }, done = { ...complete, cards: 503, total: 522 };
  const page = fakePage([shown, done, done]); page.productData = 503; page.html = html;
  await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }),
    { message: 'Incomplete section: 482 of 503 unique products loaded (503 cards, 21 repeated; last product-data total; product-data totals seen 503 in 1 responses; page total 522).' });
});

test('a short clicked section reports its grid so it can be re-paged; other stops are not marked short', async () => {
  const shown = { ...initial, total: 3 }, done = { ...complete, cards: 3, total: 3 };
  const short = fakePage([shown, done, done]); short.productData = 3; short.html = grid(tile('a') + tile('b') + tile('a'));
  const error = await collectSection(short, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }).catch(caught => caught);
  assert.equal(error.short, true); assert.equal(error.grid, short.html);
  const missing = clickingPage([shown, done, done], [{ ...productData(SECTIONS[0].url, 0), json: async () => ({}) }]); missing.html = short.html;
  assert.equal((await collectSection(missing, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }).catch(caught => caught)).short, undefined);
  const noClick = { ...initial, cards: 3, total: 3, buttons: 0, visibleButtons: 0, enabled: false };
  const repeated = fakePage([noClick, noClick]); repeated.html = short.html;
  assert.equal((await collectSection(repeated, SECTIONS[2], { paceMs: 0, pollMs: 1, timeoutMs: 3 }).catch(caught => caught)).short, undefined);
});

test('a re-paged section combines both passes by store product id and is complete only when the union equals the last product-data total', async () => {
  const shown = { ...initial, total: 6 }, done = { ...complete, cards: 6, total: 6 };
  const earlier = grid(['a', 'b', 'c', 'd', 'a'].map(code => tile(code)).join(''));
  const log = [];
  const page = fakePage([shown, done, done]); page.productData = 6; page.html = grid(['a', 'b', 'c', 'e', 'f', 'c'].map(code => tile(code)).join(''));
  const html = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, earlier, log: line => log.push(line) });
  assert.deepEqual(gridProducts(html), { cards: 7, unique: 6 });
  for (const code of ['a', 'b', 'c', 'd', 'e', 'f']) assert.match(html, new RegExp(`/p/test/${code}\\?`));
  assert.ok(log.includes('Women pass 2: 5 unique products in 6 cards; with 1 more from earlier passes the section has 6.'), log.join('\n'));
  assert.equal(log.at(-1), 'Women complete: 6 of 6 unique products (7 cards, 1 repeated) after 1 View More clicks (last product-data total; product-data totals seen 6 in 1 responses; page total 6).');
  const still = fakePage([shown, done, done]); still.productData = 7; still.html = page.html;
  const error = await collectSection(still, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, earlier }).catch(caught => caught);
  assert.equal(error.message, 'Incomplete section: 6 of 7 unique products loaded (7 cards, 1 repeated; last product-data total; product-data totals seen 7 in 1 responses; page total 6).');
  assert.equal(error.short, true);
});

test('502 unique products against a last product-data total of 503 stops the pass as short', async () => {
  const codes = Array.from({ length: 502 }, (_, i) => 'w' + i);
  const shown = { ...initial, cards: 40, total: 522 }, done = { ...complete, cards: 503, total: 522 };
  const page = fakePage([shown, done, done]); page.productData = 503; page.html = grid([...codes, codes[0]].map(code => tile(code)).join(''));
  const error = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 }).catch(caught => caught);
  assert.equal(error.message, 'Incomplete section: 502 of 503 unique products loaded (503 cards, 1 repeated; last product-data total; product-data totals seen 503 in 1 responses; page total 522).');
  assert.equal(error.short, true);
});

test('a union of 507 unique products across passes against a final product-data total of 502 is complete', async () => {
  const codes = Array.from({ length: 507 }, (_, i) => 'w' + i);
  const earlier = grid(codes.slice(0, 502).map(code => tile(code)).join(''));
  const own = grid([...codes.slice(43), ...codes.slice(43, 81)].map(code => tile(code)).join(''));
  const shown = { ...initial, cards: 40, total: 522 }, done = { ...complete, cards: 502, total: 522 };
  const log = [];
  const page = fakePage([shown, done, done]); page.productData = 502; page.html = own;
  const html = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50, earlier, log: line => log.push(line) });
  assert.equal(gridProducts(html).unique, 507);
  assert.ok(log.includes('Women pass 2: 464 unique products in 502 cards; with 43 more from earlier passes the section has 507.'), log.join('\n'));
  assert.match(log.at(-1), /^Women complete: 507 unique products, at least the last product-data total of 502 \(545 cards, 38 repeated\) after 1 View More clicks \(last product-data total; product-data totals seen 502 in 1 responses; page total 522\)\.$/);
});
