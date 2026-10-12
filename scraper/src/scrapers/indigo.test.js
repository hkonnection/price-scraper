/** Offline Indigo regressions. All product and transport data below are synthetic. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { load } from 'cheerio';
import { clean } from '../cleaners/indigo.js';

const shell = `<script>var Shopify = {}; Shopify.currency = {"active":"CAD","rate":"1.0"};
Shopify.country = "CA"; SDG.Data.constructorKey = "key_synthetic";
Shopify.forms = ["recaptcha-v3-token", "g-recaptcha-response", "h-captcha-response", "data-nocaptcha"];</script>
<div class="result-count"><br></div><div class="js-constructor-product-grid"
data-collection-handle="shop-all-sale" data-results-per-page="24"><span role="status">Loading products</span></div>`;

/** Create a synthetic storefront product with independently priced variants.
 * @param {number} id Unique product index. @param {object} overrides Data changes.
 * @returns {object} Public catalog shape, not a retained retailer product.
 */
function product(id, overrides = {}) {
  const data = { sku: `sku-${id}`, variation_id: `sku-${id}`, __shopify_variant_id: 1000 + id,
    price: 12.5, compare_at_price: 25, InventoryATS: 2, availableInStores: ['0001'],
    inventoryPolicy: 'DENY', image_url: 'https://cdn.shopify.com/synthetic.jpg', ...overrides };
  return { value: `Synthetic puzzle ${id}`, data: { id: `product-${id}`, __shopify_product_id: 2000 + id,
    handle: `synthetic-${id}`, url: `https://www.indigo.ca/products/synthetic-${id}`, brand: 'Synthetic',
    groups: [{ group_id: 'shop-all-sale' }], ...data }, variations: [{ value: `Synthetic puzzle ${id}`, data }] };
}

/** Create exact synthetic raw page metadata before deal filtering.
 * @param {number} total Raw product total. @param {number} page Page number.
 * @param {Array<object>} results Raw products. @returns {object} Catalog response.
 */
function catalog(total = 1, page = 1, results = [product(1)]) {
  return { request: { browse_filter_name: 'group_id', browse_filter_value: 'shop-all-sale',
    page, num_results_per_page: 24, section: 'Products' }, response: { total_num_results: total, results } };
}

/** Load the real collector with no real network, secrets, or timer delay.
 * @param {Array<*>} responses Response bodies, Responses, or errors in order.
 * @returns {Promise<object>} Collector API and request recorder.
 */
async function collector(responses) {
  const calls = [];
  const context = vm.createContext({ console: { log() {}, error() {} }, URL, URLSearchParams, AbortSignal,
    setTimeout: callback => { callback(); }, fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      assert.ok(responses.length, 'No unplanned transport, retry, or alternate source');
      const item = responses.shift();
      if (item instanceof Error) throw item;
      return item instanceof Response ? item : new Response(typeof item === 'string' ? item : JSON.stringify(item));
    } });
  const module = new vm.SourceTextModule(await fs.readFile(new URL('./indigo.js', import.meta.url), 'utf8'), { context });
  await module.link(() => new vm.SyntheticModule(['load'], function () { this.setExport('load', load); }, { context }));
  await module.evaluate();
  assert.equal(calls.length, 0, 'Imports must be inert');
  return { api: module.namespace, calls };
}

/** Run the real entrypoint with only an inert publisher and real Indigo cleaner.
 * @param {Function} scrape Scraper replay or synthetic result.
 * @param {boolean} dry Dry-run mode. @returns {Promise<object>} Exit, errors, writes, and fake state.
 */
async function entrypoint(scrape, dry = false) {
  const exits = [], errors = [], writes = [];
  const prior = [{ product_code: 'prior', product_name: 'Synthetic previous snapshot' }];
  let state = structuredClone(prior);
  const context = vm.createContext({ console: { log() {}, error: (_label, error) => errors.push(error.message) },
    process: { argv: dry ? ['node', 'offline', '--dry-run'] : ['node', 'offline'], exit: code => exits.push(code) } });
  const source = await fs.readFile(new URL('../indigo-index.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source.replace(/main\(\);\s*$/, 'await main();'), { context });
  await module.link(spec => {
    const name = spec.includes('/scrapers/') ? 'scrapeIndigo' : spec.includes('/db/') ? 'pushToD1' : 'getCleaner';
    return new vm.SyntheticModule([name], function () {
      this.setExport(name, name === 'scrapeIndigo' ? scrape : name === 'getCleaner' ? async slug => {
        assert.equal(slug, 'indigo'); return { clean };
      } : async (rows, slug, dates) => {
        assert.equal(slug, 'indigo'); assert.equal(dates, null);
        writes.push(structuredClone(rows)); state = structuredClone(rows);
      });
    }, { context });
  });
  await module.evaluate();
  return { exits, errors, writes, state, prior };
}

/** Check failure before publication with exact request count and preserved state.
 * @param {Array<*>} responses Synthetic responses. @param {RegExp} error Expected cause.
 * @param {number} count Expected transports. @returns {Promise<void>} Assertions.
 */
async function rejectSnapshot(responses, error, count) {
  const { api, calls } = await collector(responses);
  const result = await entrypoint(api.scrapeIndigo);
  assert.deepEqual(result.exits, [1]);
  assert.match(result.errors.join(' '), error);
  assert.equal(calls.length, count);
  assert.equal(result.writes.length, 0);
  assert.deepEqual(result.state, result.prior);
}

test('loading shell without product configuration fails instead of green empty scrape', async () => {
  await rejectSnapshot(['<div class="result-count"><br></div><span>Loading products</span>'], /Indigo.*(?:configuration|product data)/i, 1);
});

test('ordinary Shopify captcha form strings do not block valid public CAD deals', async () => {
  const { api, calls } = await collector([shell, catalog()]);
  const result = await entrypoint(api.scrapeIndigo);
  assert.deepEqual(result.exits, []);
  assert.equal(result.writes.length, 1);
  const row = result.writes[0][0];
  assert.equal(row.product_code, 'sku-1');
  assert.equal(row.sale_price, 12.5); assert.equal(row.regular_price, 25);
  assert.equal(row.savings_amount, 12.5); assert.equal(row.savings_percent, 50);
  assert.equal(row.currency, 'CAD'); assert.equal(row.in_stock, 1);
  assert.equal(row.promo_type, 'Sale & Clearance'); assert.equal(row.category, 'Toys & Games');
  assert.equal(calls[0].url, 'https://www.indigo.ca/collections/shop-all-sale');
  assert.equal(new URL(calls[1].url).hostname, 'ac.cnstrc.com');
  assert.equal(new URL(calls[1].url).pathname, '/browse/group_id/shop-all-sale');
  assert.equal(new URL(calls[1].url).searchParams.get('key'), 'key_synthetic');
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Cookie, undefined);
    assert.equal(call.options.headers.Authorization, undefined);
  }
});

test('empty source inventory and empty eligible output both fail usefully', async () => {
  await rejectSnapshot([shell, catalog(0, 1, [])], /Indigo.*empty/i, 2);
  await rejectSnapshot([shell, catalog(1, 1, [product(1, { compare_at_price: null })])], /Indigo.*no.*deals/i, 2);
  await rejectSnapshot([shell, catalog(1, 1, [product(1, { price: 25, compare_at_price: 25 })])], /Indigo.*no.*deals/i, 2);
});

test('entrypoint rejects empty scraper output even when transport is replaced', async () => {
  const result = await entrypoint(async () => ({ deals: [], totalProducts: 0, totalPages: 0 }));
  assert.deepEqual(result.exits, [1]); assert.match(result.errors[0], /Indigo.*no.*deals/i);
  assert.equal(result.writes.length, 0); assert.deepEqual(result.state, result.prior);
});

test('malformed catalog, missing product data, and untrusted collection reject', async () => {
  for (const payload of [{}, { response: { results: [] } }, 'not JSON', '<html>Loading products</html>']) {
    await rejectSnapshot([shell, payload], /Indigo.*(?:JSON|product data|metadata)/i, 2);
  }
  const wrong = catalog(); wrong.request.browse_filter_value = 'other';
  await rejectSnapshot([shell, wrong], /Indigo.*collection/i, 2);
  const nonmember = product(1); nonmember.data.groups = [{ group_id: 'other' }];
  await rejectSnapshot([shell, catalog(1, 1, [nonmember])], /Indigo.*membership/i, 2);
  for (const bad of [shell.replace('CAD', 'USD'), shell.replace('"CA"', '"US"'), shell.replace('shop-all-sale', 'other')]) {
    await rejectSnapshot([bad], /Indigo.*configuration/i, 1);
  }
});

test('source-backed Unicode handles use encoded public product URLs', async () => {
  const item = product(1);
  item.data.handle = 'synthetic-bottle-®';
  item.data.url = 'https://www.indigo.ca/products/synthetic-bottle-%C2%AE';
  const { api } = await collector([shell, catalog(1, 1, [item])]);
  const result = await api.scrapeIndigo();
  assert.equal(result.deals[0].product_url, `${item.data.url}?variant=1001`);
  for (const url of ['https://foreign.example/products/synthetic-1', 'javascript:alert(1)',
    'https://www.indigo.ca/products/other', 'https://www.indigo.ca/products/synthetic-1?market=US']) {
    const unsafe = product(1); unsafe.data.url = url;
    await rejectSnapshot([shell, catalog(1, 1, [unsafe])], /Indigo.*product URL/i, 2);
  }
});

test('raw Unicode product URLs normalize without weakening product URL boundaries', async () => {
  const item = product(1);
  item.data.handle = 'synthetic-tote-™';
  item.data.url = 'https://www.indigo.ca/products/synthetic-tote-™';
  const { api } = await collector([shell, catalog(1, 1, [item])]);
  const result = await api.scrapeIndigo();
  assert.equal(result.deals[0].product_url, 'https://www.indigo.ca/products/synthetic-tote-%E2%84%A2?variant=1001');
  for (const url of ['http://www.indigo.ca/products/synthetic-1', 'javascript:alert(1)',
    'https://foreign.example/products/synthetic-1', 'https://www.indigo.ca:8443/products/synthetic-1',
    'https://user:pass@www.indigo.ca/products/synthetic-1', 'https://www.indigo.ca/products/other',
    'https://www.indigo.ca/products/synthetic-1?market=US', 'https://www.indigo.ca/products/synthetic-1#fragment',
    'https://www.indigo.ca/products/../synthetic-1', 'https://www.indigo.ca/products/%2e%2e/synthetic-1',
    'https://www.indigo.ca/products/other/../synthetic-1', 'https://www.indigo.ca/products/other/%2e%2e/synthetic-1',
    'https://www.indigo.ca/products/synthetic-1/../../customer_authentication/login']) {
    const unsafe = product(1); unsafe.data.url = url;
    await rejectSnapshot([shell, catalog(1, 1, [unsafe])], /Indigo.*product URL/i, 2);
  }
  const traversal = product(1); traversal.data.handle = '..'; traversal.data.url = 'https://www.indigo.ca/products/..';
  await rejectSnapshot([shell, catalog(1, 1, [traversal])], /Indigo.*product URL/i, 2);
});

test('real refusals and challenges stop immediately with no retry or publisher call', async () => {
  for (const status of [403, 429, 503]) {
    await rejectSnapshot([new Response('Access denied', { status }), shell], /Indigo.*(?:HTTP|refus)/i, 1);
    await rejectSnapshot([shell, new Response('Access denied', { status }), catalog()], /Indigo.*(?:HTTP|refus)/i, 2);
  }
  for (const body of ['<h1>Verify you are human</h1>', '<h1>Access denied</h1>', '<h1>CAPTCHA</h1>',
    '<h1>Just a moment...</h1><script src="/cdn-cgi/challenge-platform/x"></script>',
    '<form action="/challenge"><button>Continue</button></form>', '<h1>Press and hold to confirm you are human</h1>']) {
    await rejectSnapshot([body, shell], /Indigo.*(?:challenge|refus)/i, 1);
    await rejectSnapshot([shell, body, catalog()], /Indigo.*(?:challenge|refus)/i, 2);
  }
});

test('invalid and missing variant fields fail the whole snapshot, not one row', async () => {
  for (const changes of [{ price: null }, { price: -1 }, { price: 0 }, { price: '12x' }, { price: true },
    { compare_at_price: 'unknown' }, { compare_at_price: -1 }, { InventoryATS: undefined },
    { InventoryATS: -1 }, { availableInStores: null }, { sku: '' }, { __shopify_variant_id: null }]) {
    await rejectSnapshot([shell, catalog(2, 1, [product(1), product(2, changes)])], /Indigo.*(?:price|stock|identifier)/i, 2);
  }
  const missing = product(2); missing.variations = [];
  await rejectSnapshot([shell, catalog(2, 1, [product(1), missing])], /Indigo.*variant/i, 2);
});

test('absent source availability list is empty, but explicit invalid stock data still fails', async () => {
  const { api } = await collector([shell, catalog(2, 1, [product(1), product(2, { InventoryATS: 0, availableInStores: undefined })])]);
  const result = await api.scrapeIndigo();
  assert.equal(result.deals.length, 1);
  assert.equal(result.deals[0].product_code, 'sku-1');
});

test('repeated full-price source variants are ignored only with matching identity and prices', async () => {
  const item = product(1);
  const regular = product(2, { compare_at_price: undefined }).variations[0];
  item.variations.push(regular, structuredClone(regular));
  item.variations[2].data.availableInStores = undefined;
  item.variations[2].data.InventoryATS = 100;
  const { api } = await collector([shell, catalog(1, 1, [item])]);
  const result = await api.scrapeIndigo();
  assert.equal(result.deals.length, 1);
  item.variations[2].data.price = 99;
  await rejectSnapshot([shell, catalog(1, 1, [item])], /Indigo.*duplicate/i, 2);
  item.variations[2].data.price = regular.data.price;
  item.variations[2].data.currency = 'USD';
  await rejectSnapshot([shell, catalog(1, 1, [item])], /Indigo.*currency/i, 2);
});

test('sub-cent prices and malformed display fields cannot reach publication', async () => {
  for (const changes of [{ price: 12.001 }, { compare_at_price: 25.001 }, { image_url: {} }]) {
    await rejectSnapshot([shell, catalog(2, 1, [product(1), product(2, changes)])], /Indigo.*(?:price|image)/i, 2);
  }
  const badBrand = product(1); badBrand.data.brand = {};
  await rejectSnapshot([shell, catalog(1, 1, [badBrand])], /Indigo.*brand/i, 2);
  const badName = product(1); badName.variations[0].value = null;
  await rejectSnapshot([shell, catalog(1, 1, [badName])], /Indigo.*name/i, 2);
});

test('numeric source SKU and distinct variant names retain product identity', async () => {
  const item = product(1);
  const second = product(2, { sku: 123456789012 }).variations[0];
  second.value = 'Synthetic puzzle blue';
  item.variations.push(second);
  const regular = product(3, { compare_at_price: undefined, InventoryATS: undefined, availableInStores: undefined }).variations[0];
  item.variations.push(regular);
  const { api } = await collector([shell, catalog(1, 1, [item])]);
  const result = await api.scrapeIndigo();
  assert.equal(result.deals.length, 2);
  assert.equal(result.deals[1].product_code, '123456789012');
  assert.equal(result.deals[1].product_name, 'Synthetic puzzle blue');
});

test('each stocked markdown variant keeps its own identifier and price pair', async () => {
  const item = product(1);
  item.variations.push(product(2, { price: 10, compare_at_price: 30 }).variations[0]);
  item.variations.push(product(3, { InventoryATS: 0, availableInStores: [] }).variations[0]);
  item.variations.push(product(4, { compare_at_price: null }).variations[0]);
  const { api } = await collector([shell, catalog(1, 1, [item])]);
  const result = await api.scrapeIndigo();
  assert.equal(result.deals.length, 2);
  assert.equal(result.deals[1].product_code, 'sku-2');
  assert.equal(result.deals[1].sale_price, 10); assert.equal(result.deals[1].regular_price, 30);
  assert.match(result.deals[1].product_url, /\?variant=1002$/);
  assert.equal(result.totalProducts, 1); assert.equal(result.markdownCount, 2);
});

test('pagination first, exact boundary, and last page all collect complete raw inventory', async () => {
  for (const total of [1, 24, 25, 48, 49]) {
    const pages = Math.ceil(total / 24);
    const responses = [shell];
    for (let page = 1; page <= pages; page++) {
      responses.push(catalog(total, page, Array.from({ length: Math.min(24, total - (page - 1) * 24) }, (_, i) => product((page - 1) * 24 + i + 1))));
    }
    const { api, calls } = await collector(responses);
    const result = await api.scrapeIndigo();
    assert.equal(result.totalProducts, total); assert.equal(result.totalPages, pages);
    assert.equal(result.deals.length, total); assert.equal(calls.length, pages + 1);
    assert.deepEqual(calls.slice(1).map(c => Number(new URL(c.url).searchParams.get('page'))), Array.from({ length: pages }, (_, i) => i + 1));
  }
});

test('incomplete pages, metadata drift, duplicate raw and variant identities fail closed', async () => {
  const first = catalog(25, 1, Array.from({ length: 24 }, (_, i) => product(i + 1)));
  for (const later of [catalog(25, 2, []), catalog(26, 2, [product(25), product(26)]),
    catalog(25, 1, [product(25)]), catalog(25, 2, [product(1)]), new Error('Transport failed')]) {
    await rejectSnapshot([shell, structuredClone(first), later, catalog()], /Indigo.*(?:incomplete|metadata|duplicate|request)/i, 3);
  }
  const duplicate = product(2); duplicate.variations[0].data.sku = 'sku-1';
  await rejectSnapshot([shell, catalog(2, 1, [product(1), duplicate])], /Indigo.*duplicate/i, 2);
  const duplicateVariant = product(2); duplicateVariant.variations[0].data.__shopify_variant_id = 1001;
  await rejectSnapshot([shell, catalog(2, 1, [product(1), duplicateVariant])], /Indigo.*duplicate/i, 2);
  await rejectSnapshot([shell, structuredClone(first), new Response('Denied', { status: 429 }), catalog()], /Indigo.*HTTP 429/i, 3);
});

test('dry run does not call even an inert publisher or replace prior state', async () => {
  const { api } = await collector([shell, catalog()]);
  const result = await entrypoint(api.scrapeIndigo, true);
  assert.deepEqual(result.exits, []); assert.equal(result.writes.length, 0); assert.deepEqual(result.state, result.prior);
});
