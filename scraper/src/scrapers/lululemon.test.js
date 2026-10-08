/** Regression tests for Canada catalog extraction; no browser or remote writes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';

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

test('current captured catalog yields CAD deals and thirteen pages, not green zero', async () => {
  const { api, context } = await parser();
  const result = await api.fetchPageData(page(context, html(captured)), '/en-ca/c/women-we-made-too-much/n16o10z8mhd', 1);
  assert.ok(result, 'Observed catalogPageData must not be rejected');
  assert.equal(result.totalProductPages, 13);
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
  const legacy = { props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['CategoryPageDataQuery'], state: { data: { pages: [{ products: [{ productOnSale: true, displayName: 'Synthetic startup control', listPrice: [100], productSalePrice: [75] }], totalProductPages: 1 }] } } }] } } } };
  replay = page(context, html(legacy));
  const result = await api.scrapeLululemon();
  assert.equal(result.deals.length, 3);
  assert.equal(closed, true);
});

test('ordinary navigation reads embedded products even when same-session fetch is rejected', async () => {
  const { api, context } = await parser();
  const replay = page(context, html(captured));
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
    const data = structuredClone(captured);
    mutation(data.props.pageProps.dehydratedState.queries[0].state.data.pages[0]);
    await assert.rejects(api.fetchPageData(page(context, html(data)), '/en-ca/c/test', 1));
  }
});

test('current product rejects non-CAD, unavailable and invalid price colors without mismatching regular and sale', async () => {
  const { api, context } = await parser();
  const result = await api.fetchPageData(page(context, html(captured)), '/en-ca/c/test', 1);
  assert.ok(result);
  for (const mutate of [c => { c.price.currencyCode = 'USD'; }, c => { c.availability.isAvailable = false; }, c => { c.price.salePrice = c.price.listPrice; }, c => { c.price.listPrice = null; }]) {
    const product = structuredClone(result.products[0]);
    mutate(product.attributes.styles[0].colors[0]);
    assert.equal(api.transformProduct(product, 'Women'), null);
  }
});

test('all thirteen page boundaries are visited and repeated first-page metadata is rejected', async () => {
  const { api, context } = await parser();
  const visited = [];
  const replay = page(context, html(captured));
  replay.goto = async url => {
    const num = Number(new URL(url).searchParams.get('page') || 1);
    visited.push(num);
    const data = structuredClone(captured);
    // Synthetic pagination control using faithful products, not a claim of live pages.
    data.props.pageProps.dehydratedState.queries[0].state.data.pages[0].data.attributes.offset = (num - 1) * 40;
    context.document = { getElementById: () => ({ textContent: JSON.stringify(data) }) };
    return { ok: () => true, status: () => 200 };
  };
  const deals = await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' });
  assert.deepEqual(visited, Array.from({ length: 13 }, (_, i) => i+1));
  assert.equal(deals.length, 39);
  // A retailer ignoring ?page must not produce thirteen copies of page one.
  await assert.rejects(api.fetchPageData(page(context, html(captured)), '/en-ca/c/test', 2), /Invalid catalog pagination/);
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
  const replayPage = page(context, html(captured));
  context.fetch = async () => ++calls === 1 ? new Response(html(captured)) : new Response('failure', { status: 503 });
  replayPage.goto = async () => { calls++; return { ok: () => calls === 1, status: () => calls === 1 ? 200 : 503 }; };
  await assert.rejects(api.scrapeSectionPages(replayPage, { name: 'Women', path: '/en-ca/c/test' }));
  assert.equal(calls, 2);
});
