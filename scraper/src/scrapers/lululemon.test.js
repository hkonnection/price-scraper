/** Regression tests for Canada catalog extraction; no browser or remote writes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { clean } from '../cleaners/lululemon.js';

/**
 * Loads private parser boundaries without launching Playwright.
 * @param {object|null} browser - Optional isolated browser stub, never a real launch.
 * @returns {Promise<object>} Actual scraper functions in an isolated module.
 */
async function parser(browser = null) {
  const context = vm.createContext({ console, URL, setTimeout: fn => { fn(); } });
  const source = await fs.readFile(new URL('./lululemon.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source + '\nexport { fetchPageData, transformProduct, scrapeSectionPages };', { context });
  await module.link(() => new vm.SyntheticModule(['chromium'], function () {
    this.setExport('chromium', { async launch(options) {
      if (!browser) throw new Error('Browser launch forbidden in replay');
      assert.equal(options.args, undefined, 'Do not launch inherited masking flags');
      return browser;
    } });
  }, { context }));
  await module.evaluate();
  return { api: module.namespace, context };
}

/**
 * Replays exactly the HTML body supplied, without network access.
 * @param {object} context - Isolated JavaScript context.
 * @param {string} html - Public fixture or deliberately invalid HTML.
 * @param {number} status - Simulated HTTP response status.
 * @returns {object} Minimal Playwright page evaluate boundary.
 */
function page(context, html, status = 200) {
  context.fetch = async () => new Response(html, { status });
  context.document = { getElementById: () => {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    return match ? { textContent: match[1] } : null;
  } };
  return {
    async goto() { return { ok: () => status === 200, status: () => status }; },
    async waitForSelector() {},
    evaluate: (fn, args) => vm.runInContext(`(${fn.toString()})`, context)(args),
  };
}

/**
 * Wraps a NEXT_DATA object in the real script element shape.
 * @param {object} data - Embedded public product/catalog data.
 * @returns {string} HTML for offline replay.
 */
function html(data) { return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`; }

const captured = JSON.parse(await fs.readFile(new URL('./fixtures/lululemon-catalog.json', import.meta.url), 'utf8'));

/**
 * Builds synthetic complete-page metadata around projected product fields.
 * The committed three-product projection is NOT a full 504/40 captured page.
 * @param {object} options - Synthetic pagination and raw product overrides.
 * @returns {object} Offline NEXT_DATA; never a claim of a full retailer capture.
 */
function currentData({ totalCount = 3, limit = 40, offset = 0,
  products = captured.props.pageProps.dehydratedState.queries[0].state.data.pages[0].included } = {}) {
  const data = structuredClone(captured);
  const catalog = data.props.pageProps.dehydratedState.queries[0].state.data.pages[0];
  Object.assign(catalog.data.attributes, { totalCount, limit, offset });
  catalog.included = structuredClone(products);
  catalog.data.relationships.products.data = products.map(p => ({ id: p.id, type: 'products' }));
  return data;
}

/**
 * Builds uniquely identified synthetic products using projected CAD fields.
 * @param {number} start - First synthetic product index.
 * @param {number} count - Raw product count for this synthetic page.
 * @returns {Array<object>} Synthetic products, not captured retailer pages.
 */
function currentProducts(start, count) {
  const templates = captured.props.pageProps.dehydratedState.queries[0].state.data.pages[0].included;
  return Array.from({ length: count }, (_, i) => {
    const product = structuredClone(templates[i % templates.length]);
    product.id = `synthetic-${start + i}`;
    product.attributes.name = `Synthetic product ${start + i}`;
    return product;
  });
}

/**
 * Wraps synthetic legacy products in their supported embedded query shape.
 * @param {Array<object>} products - Raw legacy products.
 * @param {number} totalProductPages - Synthetic advertised page count.
 * @returns {object} Offline legacy NEXT_DATA.
 */
function legacyData(products, totalProductPages = 1) {
  return { props: { pageProps: { dehydratedState: { queries: [{
    queryKey: ['CategoryPageDataQuery'], state: { data: { pages: [{ products, totalProductPages }] } }
  }] } } } };
}

/**
 * Creates one identified synthetic legacy product before sale filtering.
 * @param {string} id - Raw product identity.
 * @param {boolean} onSale - Whether this product passes sale filtering.
 * @returns {object} Synthetic raw product.
 */
function legacyProduct(id, onSale = true) {
  return { productOnSale: onSale, productId: id, displayName: `Synthetic ${id}`,
    listPrice: [100], productSalePrice: [75], pdpUrl: `/p/${id}` };
}

/**
 * Replays requested page numbers from local embedded data without any fetch.
 * @param {object} context - Isolated JavaScript context.
 * @param {Array<object>} catalogs - Synthetic pages in request order.
 * @returns {object} Stub page and visited page-number recorder.
 */
function paginatedPage(context, catalogs) {
  const replay = page(context, html(catalogs[0]));
  const visited = [];
  replay.goto = async url => {
    const num = Number(new URL(url).searchParams.get('page') || 1);
    visited.push(num);
    page(context, html(catalogs[num - 1] ?? {}));
    return { ok: () => true, status: () => 200 };
  };
  return { replay, visited };
}

/**
 * Runs the actual scraper, cleaner and entrypoint with local browser/publisher stubs.
 * No real browser, credential, remote fetch, or database writer is available.
 * @param {Array<object>} catalogs - Synthetic embedded pages for each section.
 * @param {object} options - Dry-run flag and optional failing later-section data.
 * @returns {Promise<object>} Exit, publication, browser-close and local state evidence.
 */
async function entrypointReplay(catalogs, { dry = false, failMen = null } = {}) {
  let replay;
  let closed = false;
  const browser = {
    async newContext() { return { async newPage() { return replay; } }; },
    async close() { closed = true; },
  };
  const { api, context } = await parser(browser);
  replay = paginatedPage(context, catalogs).replay;
  if (failMen) {
    const goto = replay.goto;
    replay.goto = async url => {
      if (new URL(url).pathname.includes('/men-we-made-too-much/')) {
        page(context, html(failMen));
        return { ok: () => true, status: () => 200 };
      }
      return goto(url);
    };
  }
  const prior = [{ product_code: 'prior', product_name: 'Synthetic prior completed publication' }];
  let publication = structuredClone(prior);
  const exits = [], writes = [], errors = [];
  const runtime = vm.createContext({ console: { log() {}, error: (_label, error) => errors.push(error.message) },
    process: { argv: dry ? ['node', 'offline', '--dry-run'] : ['node', 'offline'], exit: code => exits.push(code) } });
  const source = await fs.readFile(new URL('../lululemon-index.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source.replace(/main\(\);\s*$/, 'await main();'), { context: runtime });
  await module.link(spec => {
    const name = spec.includes('/scrapers/') ? 'scrapeLululemon' : spec.includes('/db/') ? 'pushToD1' : 'getCleaner';
    return new vm.SyntheticModule([name], function () {
      const value = name === 'scrapeLululemon' ? api.scrapeLululemon : name === 'getCleaner' ? async slug => {
        assert.equal(slug, 'lululemon');
        return { clean };
      } : async (rows, slug) => {
        assert.equal(slug, 'lululemon');
        writes.push(rows);
        publication = structuredClone(rows);
      };
      this.setExport(name, value);
    }, { context: runtime });
  });
  await module.evaluate();
  return { exits, writes, errors, publication, prior, closed };
}

test('projected CAD products parse with explicitly synthetic complete-page metadata', async () => {
  const { api, context } = await parser();
  const result = await api.fetchPageData(page(context, html(currentData())), '/en-ca/c/women-we-made-too-much/n16o10z8mhd', 1);
  assert.equal(result.totalProductPages, 1);
  assert.equal(result.products.length, 3);
  const deals = result.products.map(p => api.transformProduct(p, 'Women'));
  assert.equal(deals.filter(Boolean).length, 3);
  assert.equal(deals[0].product_code, 'brr0e930oy');
  assert.equal(deals[0].regular_price, 148);
  assert.equal(deals[0].sale_price, 109);
  assert.equal(deals[1].regular_price, 108);
  assert.equal(deals[1].sale_price, 69);
  assert.match(deals[0].product_url, /^https:\/\/shop.lululemon.com\/en-ca\/p\//);
  assert.match(deals[0].image_url, /LW3JCTS_079841_1/);
});

test('scraper startup uses ordinary browser defaults with no fingerprint masking', async () => {
  let replay;
  let closed = false;
  const browser = {
    async newContext(options) {
      assert.equal(options, undefined, 'Do not override user agent, viewport or locale');
      return { async newPage() { return replay; } };
    },
    async close() { closed = true; },
  };
  const { api, context } = await parser(browser);
  const legacy = { props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['CategoryPageDataQuery'], state: { data: { pages: [{ products: [{ productOnSale: true, productId: 'startup', displayName: 'Synthetic startup control', listPrice: [100], productSalePrice: [75] }], totalProductPages: 1 }] } } }] } } } };
  replay = page(context, html(legacy));
  const result = await api.scrapeLululemon();
  assert.equal(result.deals.length, 3);
  assert.equal(closed, true);
});

test('ordinary navigation reads embedded products even when same-session fetch is rejected', async () => {
  const { api, context } = await parser();
  const replay = page(context, html(currentData()));
  context.fetch = async () => new Response('GE401001', { status: 400 });
  const result = await api.fetchPageData(replay, '/en-ca/c/test', 1);
  assert.equal(result.products.length, 3);
});

test('legacy category page remains readable', async () => {
  const { api, context } = await parser();
  const product = { productOnSale: true, productId: 'legacy', displayName: 'Legacy pants', listPrice: ['100'], productSalePrice: ['75'], pdpUrl: '/p/legacy', parentCategoryUnifiedId: 'pants' };
  const data = { props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['CategoryPageDataQuery'], state: { data: { pages: [{ products: [product], totalProductPages: 1 }] } } }] } } } };
  const result = await api.fetchPageData(page(context, html(data)), '/en-ca/c/legacy', 1);
  assert.equal(api.transformProduct(result.products[0], 'Women').sale_price, 75);
});

test('upstream errors, missing NEXT_DATA and unsupported catalogs fail rather than skip', async () => {
  const { api, context } = await parser();
  for (const [body, status] of [['blocked', 403], ['<html>No catalog</html>', 200], ['<script id="__NEXT_DATA__">not JSON</script>', 200], [html({}), 200]]) {
    await assert.rejects(api.fetchPageData(page(context, body, status), '/en-ca/c/test', 1));
  }
});

test('empty or malformed current catalog and missing relationship products are rejected', async () => {
  const { api, context } = await parser();
  for (const mutation of [p => { p.included = []; }, p => { p.data.attributes.limit = 0; }, p => { p.data.attributes.totalCount = 'invalid'; }, p => { p.data.relationships.products.data = []; }]) {
    const data = currentData();
    mutation(data.props.pageProps.dehydratedState.queries[0].state.data.pages[0]);
    await assert.rejects(api.fetchPageData(page(context, html(data)), '/en-ca/c/test', 1));
  }
});

test('current product rejects non-CAD, unavailable and invalid price colors without mismatching regular and sale', async () => {
  const { api, context } = await parser();
  const result = await api.fetchPageData(page(context, html(currentData())), '/en-ca/c/test', 1);
  assert.ok(result);
  for (const mutate of [c => { c.price.currencyCode = 'USD'; }, c => { c.availability.isAvailable = false; }, c => { c.price.salePrice = c.price.listPrice; }, c => { c.price.listPrice = null; }]) {
    const product = structuredClone(result.products[0]);
    mutate(product.attributes.styles[0].colors[0]);
    assert.equal(api.transformProduct(product, 'Women'), null);
  }
});

test('all thirteen synthetic complete pages are visited with a partial final page', async () => {
  const { api, context } = await parser();
  // Synthetic 504/40 traversal with distinct products; NOT captured retailer pages.
  const catalogs = Array.from({ length: 13 }, (_, i) => currentData({
    totalCount: 504, limit: 40, offset: i * 40,
    products: currentProducts(i * 40, Math.min(40, 504 - i * 40)),
  }));
  const { replay, visited } = paginatedPage(context, catalogs);
  const deals = await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' });
  assert.deepEqual(visited, Array.from({ length: 13 }, (_, i) => i + 1));
  assert.equal(deals.length, 504);
  assert.equal(new Set(deals.map(d => d.product_code)).size, 504);
  // A retailer ignoring ?page must not produce copies of page one.
  await assert.rejects(api.fetchPageData(page(context, html(catalogs[0])), '/en-ca/c/test', 2), /Invalid catalog pagination/);
});

test('null, empty names and non-finite or negative legacy prices cannot become deals', async () => {
  const { api } = await parser();
  assert.equal(api.transformProduct(null, 'Women'), null);
  for (const bad of [{ listPrice: [Infinity] }, { productSalePrice: [-1] }, { listPrice: [-100] }, { displayName: '   ' }, { displayName: 123 }]) {
    const product = { productOnSale: true, productId: 'synthetic', displayName: 'Synthetic legacy', listPrice: [100], productSalePrice: [75], ...bad };
    assert.equal(api.transformProduct(product, 'Women'), null);
  }
});

test('failed later pages abort the section rather than publish partial data', async () => {
  const { api, context } = await parser();
  let calls = 0;
  const data = currentData({ totalCount: 5, limit: 3 });
  const replayPage = page(context, html(data));
  context.fetch = async () => ++calls === 1 ? new Response(html(data)) : new Response('failure', { status: 503 });
  replayPage.goto = async () => { calls++; return { ok: () => calls === 1, status: () => calls === 1 ? 200 : 503 }; };
  await assert.rejects(api.scrapeSectionPages(replayPage, { name: 'Women', path: '/en-ca/c/test' }));
  assert.equal(calls, 2);
});

test('short raw current catalog rejects before publication', async () => {
  const { api, context } = await parser();
  const data = structuredClone(captured);
  const catalog = data.props.pageProps.dehydratedState.queries[0].state.data.pages[0];
  catalog.data.attributes.totalCount = 3;
  catalog.data.relationships.products.data = catalog.data.relationships.products.data.slice(0, 1);
  await assert.rejects(api.scrapeSectionPages(page(context, html(data)),
    { name: 'Women', path: '/en-ca/c/test' }));
});

test('repeated successful legacy pages reject', async () => {
  const { api, context } = await parser();
  const product = { productOnSale: true, productId: 'same', displayName: 'Synthetic repeated',
    listPrice: [100], productSalePrice: [75] };
  const data = { props: { pageProps: { dehydratedState: { queries: [{
    queryKey: ['CategoryPageDataQuery'], state: { data: { pages: [{
      products: [product], totalProductPages: 3
    }] } }
  }] } } } };
  await assert.rejects(api.scrapeSectionPages(page(context, html(data)),
    { name: 'Women', path: '/en-ca/c/test' }));
});

test('original three-product projection is not a complete 504/40 captured page', async () => {
  const { api, context } = await parser();
  const catalog = captured.props.pageProps.dehydratedState.queries[0].state.data.pages[0];
  assert.equal(catalog.data.attributes.totalCount, 504);
  assert.equal(catalog.data.attributes.limit, 40);
  assert.equal(catalog.data.relationships.products.data.length, 3);
  await assert.rejects(api.fetchPageData(page(context, html(captured)), '/en-ca/c/test', 1), /Incomplete catalog products/);
});

test('current raw page counts reject nonempty truncation and oversized pages', async t => {
  for (const [name, totalCount, limit, offset, count, num] of [
    ['short first page', 5, 3, 0, 2, 1],
    ['oversized first page', 5, 3, 0, 4, 1],
    ['short final page', 5, 3, 3, 1, 2],
    ['oversized final page', 5, 3, 3, 3, 2],
    ['empty final page', 5, 3, 3, 0, 2],
    ['past final page', 5, 3, 6, 1, 3],
  ]) {
    await t.test(name, async () => {
      const { api, context } = await parser();
      const data = currentData({ totalCount, limit, offset, products: currentProducts(offset, count) });
      await assert.rejects(api.fetchPageData(page(context, html(data)), '/en-ca/c/test', num));
    });
  }
});

test('current metadata must contain positive safe integers and the requested offset', async t => {
  for (const [key, value] of [
    ['totalCount', 0], ['totalCount', -1], ['totalCount', null], ['totalCount', 3.5], ['totalCount', '3'],
    ['limit', 0], ['limit', -1], ['limit', null], ['limit', 3.5], ['limit', '40'], ['limit', Number.MAX_SAFE_INTEGER + 1],
    ['offset', -1], ['offset', 1], ['offset', null], ['offset', 0.5], ['offset', '0'],
  ]) {
    await t.test(`${key}=${JSON.stringify(value)}`, async () => {
      const { api, context } = await parser();
      const data = currentData({ [key]: value });
      await assert.rejects(api.fetchPageData(page(context, html(data)), '/en-ca/c/test', 1), /Invalid catalog pagination/);
    });
  }
  const { api, context } = await parser();
  await assert.rejects(api.fetchPageData(page(context, html(currentData({
    totalCount: Number.MAX_SAFE_INTEGER + 1, limit: Number.MAX_SAFE_INTEGER + 1,
  }))), '/en-ca/c/test', 1), /Invalid catalog pagination/);
  await assert.rejects(api.fetchPageData(page(context, html(currentData({ totalCount: 201, limit: 1 }))), '/en-ca/c/test', 1), /Invalid catalog pagination/);
});

test('subsequent current pages cannot change total count, limit, or catalog schema', async t => {
  const first = currentData({ totalCount: 5, limit: 3, products: currentProducts(0, 3) });
  for (const [name, second] of [
    ['totalCount changes but page count stays two', currentData({ totalCount: 6, limit: 3, offset: 3, products: currentProducts(3, 3) })],
    ['limit changes but page count stays two', currentData({ totalCount: 5, limit: 4, offset: 4, products: currentProducts(4, 1) })],
    ['catalog switches to legacy', legacyData([legacyProduct('new')], 2)],
  ]) {
    await t.test(name, async () => {
      const { api, context } = await parser();
      const { replay } = paginatedPage(context, [first, second]);
      await assert.rejects(api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' }), /Inconsistent catalog pagination/);
    });
  }
});

test('current repeated raw identities reject even with mutated offsets, order, or sale filtering', async t => {
  const products = currentProducts(0, 3);
  for (const [name, secondProducts] of [
    ['same raw page at new offset', products],
    ['same raw page reordered', [...products].reverse()],
    ['single overlapping product', [products[2], ...currentProducts(3, 2)]],
    ['repeated product now unavailable', products.map(p => {
      const product = structuredClone(p);
      product.attributes.styles.forEach(s => s.colors.forEach(c => { c.availability.isAvailable = false; }));
      return product;
    })],
  ]) {
    await t.test(name, async () => {
      const { api, context } = await parser();
      const { replay } = paginatedPage(context, [
        currentData({ totalCount: 6, limit: 3, products }),
        currentData({ totalCount: 6, limit: 3, offset: 3, products: secondProducts }),
      ]);
      await assert.rejects(api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' }), /Repeated catalog product/);
    });
  }
});

test('duplicate raw identities cannot inflate current or legacy page counts', async () => {
  const { api, context } = await parser();
  const products = currentProducts(0, 2);
  for (const data of [
    currentData({ products: [products[0], products[0], products[1]] }),
    legacyData([legacyProduct('same'), legacyProduct('same')]),
  ]) {
    await assert.rejects(api.scrapeSectionPages(page(context, html(data)), { name: 'Women', path: '/en-ca/c/test' }), /Repeated catalog product/);
  }
});

test('missing raw identities reject rather than making repetition undetectable', async () => {
  const { api, context } = await parser();
  const product = currentProducts(0, 1)[0];
  delete product.id;
  const legacy = legacyProduct('missing');
  delete legacy.productId;
  for (const data of [currentData({ totalCount: 1, products: [product] }), legacyData([legacy])]) {
    await assert.rejects(api.scrapeSectionPages(page(context, html(data)), { name: 'Women', path: '/en-ca/c/test' }), /Missing catalog product identity/);
  }
});

test('legacy page count and non-final raw page size stay consistent', async t => {
  const products = [legacyProduct('first'), legacyProduct('second')];
  for (const [name, catalogs] of [
    ['changed page count', [legacyData(products, 2), legacyData([legacyProduct('third')], 3)]],
    ['short intermediate page', [legacyData(products, 3), legacyData([legacyProduct('third')], 3), legacyData([legacyProduct('fourth')], 3)]],
    ['oversized final page', [legacyData(products, 2), legacyData([legacyProduct('third'), legacyProduct('fourth'), legacyProduct('fifth')], 2)]],
    ['empty final page', [legacyData(products, 2), legacyData([], 2)]],
  ]) {
    await t.test(name, async () => {
      const { api, context } = await parser();
      const { replay } = paginatedPage(context, catalogs);
      await assert.rejects(api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' }));
    });
  }
});

test('legacy overlapping products reject before sale filtering even when not on sale', async () => {
  const { api, context } = await parser();
  const { replay } = paginatedPage(context, [
    legacyData([legacyProduct('first'), legacyProduct('overlap', false)], 2),
    legacyData([legacyProduct('overlap', false), legacyProduct('third')], 2),
  ]);
  await assert.rejects(api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' }), /Repeated catalog product/);
});

test('complete current final pages allow normal CAD and availability filtering', async () => {
  const { api, context } = await parser();
  const products = currentProducts(0, 5);
  products[1].attributes.styles.forEach(s => s.colors.forEach(c => { c.price.currencyCode = 'USD'; }));
  products[2].attributes.styles.forEach(s => s.colors.forEach(c => { c.availability.isAvailable = false; }));
  products[3].attributes.styles.forEach(s => s.colors.forEach(c => { c.price.salePrice = c.price.listPrice; }));
  const { replay, visited } = paginatedPage(context, [
    currentData({ totalCount: 5, limit: 3, products: products.slice(0, 3) }),
    currentData({ totalCount: 5, limit: 3, offset: 3, products: products.slice(3) }),
  ]);
  const deals = await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' });
  assert.deepEqual(visited, [1, 2]);
  assert.deepEqual(Array.from(deals, d => d.product_code), ['synthetic-0', 'synthetic-4']);
  assert.equal(deals[0].regular_price, 148);
  assert.equal(deals[0].sale_price, 109);
});

test('complete legacy final pages may be short and filtered', async () => {
  const { api, context } = await parser();
  const { replay } = paginatedPage(context, [
    legacyData([legacyProduct('first'), legacyProduct('full-price', false)], 2),
    legacyData([legacyProduct('last')], 2),
  ]);
  const deals = await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' });
  assert.deepEqual(Array.from(deals, d => d.product_code), ['first', 'last']);
});

test('complete raw current sections may legitimately have zero sale deals', async () => {
  const { api, context } = await parser();
  const products = currentProducts(0, 3);
  products.forEach(p => p.attributes.styles.forEach(s => s.colors.forEach(c => { c.availability.isAvailable = false; })));
  const deals = await api.scrapeSectionPages(page(context, html(currentData({ products }))), { name: 'Women', path: '/en-ca/c/test' });
  assert.equal(deals.length, 0);
});

test('offline entrypoint smoke completes happy, negative, then state verification phases', async t => {
  const products = currentProducts(0, 5);
  products[1].attributes.styles.forEach(s => s.colors.forEach(c => { c.price.currencyCode = 'USD'; }));
  products[2].attributes.styles.forEach(s => s.colors.forEach(c => { c.availability.isAvailable = false; }));
  products[3].attributes.styles.forEach(s => s.colors.forEach(c => { c.price.salePrice = c.price.listPrice; }));
  const completeCurrent = [
    currentData({ totalCount: 5, limit: 3, products: products.slice(0, 3) }),
    currentData({ totalCount: 5, limit: 3, offset: 3, products: products.slice(3) }),
  ];
  const completeLegacy = [
    legacyData([legacyProduct('first'), legacyProduct('full-price', false)], 2),
    legacyData([legacyProduct('last')], 2),
  ];
  const successes = [], rejected = [];
  await t.test('phase 1 happy: actual current and legacy traversal, cleaner and entrypoint', async () => {
    for (const [name, catalogs] of [['current', completeCurrent], ['legacy', completeLegacy]]) {
      const result = await entrypointReplay(catalogs);
      assert.deepEqual(result.exits, []);
      assert.equal(result.writes.length, 1);
      assert.equal(result.writes[0].length, 6, 'Two filtered deals per section, across three complete sections');
      assert.ok(result.writes[0].every(d => d.brand === 'Lululemon' && d.promo_type === 'We Made Too Much'));
      assert.equal(result.closed, true);
      successes.push(result);
      console.log(`SMOKE_HAPPY ${name}: cleanedRows=${result.writes[0].length} publishCalls=${result.writes.length} failureExits=${result.exits.length} remoteWrites=0`);
    }
  });
  await t.test('phase 2 negative: invalid pages reject before publication', async () => {
    const truncated = structuredClone(captured);
    const catalog = truncated.props.pageProps.dehydratedState.queries[0].state.data.pages[0];
    catalog.data.attributes.totalCount = 3;
    catalog.data.relationships.products.data = catalog.data.relationships.products.data.slice(0, 1);
    const repeatedLegacy = legacyData([legacyProduct('same')], 3);
    const first = currentData({ totalCount: 5, limit: 3, products: currentProducts(0, 3) });
    const allUnavailable = currentProducts(0, 3);
    allUnavailable.forEach(p => p.attributes.styles.forEach(s => s.colors.forEach(c => { c.availability.isAvailable = false; })));
    const negatives = [
      ['reviewer current truncation', [truncated], /Incomplete catalog products/],
      ['reviewer repeated legacy', [repeatedLegacy, repeatedLegacy, repeatedLegacy], /Repeated catalog product/],
      ['short final page', [first, currentData({ totalCount: 5, limit: 3, offset: 3, products: currentProducts(3, 1) })], /Incomplete catalog products/],
      ['empty final page', [first, currentData({ totalCount: 5, limit: 3, offset: 3, products: [] })], /Empty or malformed catalog products/],
      ['changed count', [first, currentData({ totalCount: 6, limit: 3, offset: 3, products: currentProducts(3, 3) })], /Inconsistent catalog pagination/],
      ['changed limit', [first, currentData({ totalCount: 5, limit: 4, offset: 4, products: currentProducts(4, 1) })], /Inconsistent catalog pagination/],
      ['wrong offset', [first, currentData({ totalCount: 5, limit: 3, offset: 0, products: currentProducts(3, 2) })], /Invalid catalog pagination/],
      ['repeated current with changed offset', [first, currentData({ totalCount: 5, limit: 3, offset: 3, products: currentProducts(0, 2) })], /Repeated catalog product/],
      ['partial current overlap', [first, currentData({ totalCount: 5, limit: 3, offset: 3, products: currentProducts(2, 2) })], /Repeated catalog product/],
      ['legacy short intermediate', [legacyData([legacyProduct('a'), legacyProduct('b')], 3), legacyData([legacyProduct('c')], 3)], /Inconsistent category product count/],
      ['missing raw identity', [legacyData([{ ...legacyProduct('a'), productId: null }])], /Missing catalog product identity/],
      ['all-filtered repeat still fails raw gate', [currentData({ totalCount: 6, limit: 3, products: allUnavailable }), currentData({ totalCount: 6, limit: 3, offset: 3, products: allUnavailable })], /Repeated catalog product/],
      ['valid all-filtered whole run retains zero guard', [currentData({ products: allUnavailable })], /No usable Lululemon deals/],
    ];
    for (const [name, catalogs, message] of negatives) {
      // Verify both execution modes; these are VM replays, never live scrapers.
      for (const dry of [false, true]) {
        const result = await entrypointReplay(catalogs, { dry });
        assert.deepEqual(result.exits, [1], name);
        assert.equal(result.writes.length, 0, name);
        assert.match(result.errors[0], message, name);
        assert.equal(result.closed, true);
        rejected.push({ name, dry, result });
      }
      console.log(`SMOKE_NEGATIVE ${name}: rejected in both modes; publishCalls=0 remoteWrites=0`);
    }
    // Stronger counterfactual: a later section fails after an earlier one completed.
    const laterFailure = await entrypointReplay(completeCurrent, { failMen: truncated });
    assert.deepEqual(laterFailure.exits, [1]);
    assert.equal(laterFailure.writes.length, 0);
    assert.match(laterFailure.errors[0], /men-we-made-too-much.*Incomplete catalog products/);
    rejected.push({ name: 'later section truncation', dry: false, result: laterFailure });
    console.log('SMOKE_NEGATIVE later section truncation: Women completed; Men rejected; publishCalls=0 remoteWrites=0');
  });
  await t.test('phase 3 state: failure leaves prior local publication unchanged', () => {
    assert.equal(successes.length, 2);
    assert.equal(rejected.length, 27);
    successes.forEach(result => {
      assert.deepEqual(result.publication, structuredClone(result.writes[0]));
      assert.notDeepEqual(result.publication, result.prior);
    });
    rejected.forEach(({ name, result }) => {
      assert.deepEqual(result.publication, result.prior, name);
      assert.equal(result.writes.length, 0, name);
    });
    console.log(`SMOKE_STATE successfulReplacements=${successes.length} rejectedPriorSnapshotsUnchanged=${rejected.length} persistenceCallsOnFailure=0 remoteWrites=0`);
  });
});
