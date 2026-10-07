/**
 * Nike Canada request regression and scraper boundary tests.
 * Run with: node --test scraper/src/scrapers/*.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { scrapeNike } from './nike.js';

/**
 * Creates a synthetic discounted Canadian product in the Discover API shape.
 * @param {string} code - Unique colorway code.
 * @returns {object} Synthetic product with CAD prices and a Canada product URL.
 */
function product(code = 'TEST-001') {
  return {
    productCode: code,
    copy: { title: 'Synthetic shoe', subTitle: 'Shoes' },
    prices: { currency: 'CAD', currentPrice: 75, initialPrice: 100 },
    pdpUrl: { url: `https://www.nike.com/ca/t/test/${code}` },
  };
}

/**
 * Stubs fetch with sequential API responses and records request URLs.
 * @param {object} t - Node test context, which restores mocks after the test.
 * @param {Array<object>} pages - JSON page responses in request order.
 * @returns {Array<URL>} Mutable list of captured request URLs.
 */
function mockPages(t, pages) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(new URL(url));
    assert.ok(requests.length <= pages.length, 'Unexpected extra page request');
    return Response.json(pages[requests.length - 1]);
  });
  return requests;
}

test('requests the CAN marketplace while preserving Canada sale parameters and headers', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url);
    // Reproduce the real service rejecting the obsolete marketplace code.
    if (!request.pathname.includes('/marketplace/CAN/')) {
      return Response.json({ errors: [{ code: 'INVALID_MARKETPLACE_NO_MERCH_GROUP' }] }, {
        status: 400, statusText: 'Bad Request',
      });
    }
    assert.equal(request.origin, 'https://api.nike.com');
    assert.equal(request.pathname, '/discover/product_wall/v1/marketplace/CAN/language/en-GB/consumerChannelId/d9a5bc42-4b9c-4976-858a-f159cf99c647');
    assert.deepEqual(Object.fromEntries(request.searchParams), {
      path: '/ca/w/sale-3yaep',
      attributeIds: '5b21a62a-0503-400c-8336-3ccfbff2a684',
      queryType: 'PRODUCTS', anchor: '0', count: '24',
    });
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.headers['nike-api-caller-id'], 'com.nike.commerce.nikedotcom.web');
    assert.match(options.headers['User-Agent'], /Chrome\/131/);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body, undefined);
    return Response.json({
      productGroupings: [{ products: [product()] }],
      pages: { totalResources: 1, totalPages: 1 },
    });
  });
  const result = await scrapeNike();
  assert.equal(result.totalProducts, 1);
  assert.equal(result.deals.length, 1);
  assert.equal(result.deals[0].sale_price, 75);
  assert.equal(result.deals[0].savings_percent, 25);
  assert.match(result.deals[0].product_url, /^https:\/\/www.nike.com\/ca\//);
});

test('paginates through the last partial page and deduplicates colorways', async t => {
  const requests = mockPages(t, [
    { productGroupings: [{ products: [product('A'), product('B')] }], pages: { totalResources: 49, totalPages: 3 } },
    { productGroupings: [{ products: [product('B'), product('C')] }] },
    { productGroupings: [{ products: [product('D')] }] },
  ]);
  const result = await scrapeNike();
  assert.deepEqual(requests.map(url => url.searchParams.get('anchor')), ['0', '24', '48']);
  assert.ok(requests.every(url => url.pathname.includes('/marketplace/CAN/language/en-GB/')));
  assert.deepEqual(result.deals.map(deal => deal.product_code), ['A', 'B', 'C', 'D']);
});

test('does not request another page at the exact page-size boundary', async t => {
  const requests = mockPages(t, [{ productGroupings: [], pages: { totalResources: 24, totalPages: 1 } }]);
  assert.deepEqual(await scrapeNike(), { deals: [], totalProducts: 24 });
  assert.equal(requests.length, 1);
});

test('empty pages and missing optional page fields return no deals', async t => {
  for (const page of [{ productGroupings: [], pages: { totalResources: 0, totalPages: 0 } }, {}]) {
    const requests = mockPages(t, [page]);
    assert.deepEqual(await scrapeNike(), { deals: [], totalProducts: 0 });
    assert.equal(requests.length, 1);
    t.mock.restoreAll();
  }
});

test('missing prices and non-discounted colorways are skipped', async t => {
  mockPages(t, [{ productGroupings: [{}, { products: [
    {},
    { prices: { currentPrice: 75 } },
    { prices: { currentPrice: 100, initialPrice: 100 } },
    { prices: { currentPrice: 110, initialPrice: 100 } },
    { prices: { currentPrice: 0, initialPrice: 100 } },
    product(),
  ] }] }]);
  const { deals } = await scrapeNike();
  assert.equal(deals.length, 1);
  assert.equal(deals[0].product_code, 'TEST-001');
});

test('first-page request failures retain the HTTP status in the error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 400, statusText: 'Bad Request' }));
  await assert.rejects(scrapeNike(), { message: 'Nike API error: 400 Bad Request' });
});

test('later-page failures are logged and preserve the existing partial-result behavior', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1
      ? Response.json({ productGroupings: [{ products: [product()] }], pages: { totalResources: 25, totalPages: 2 } })
      : new Response('', { status: 503, statusText: 'Service Unavailable' });
  });
  const errors = [];
  t.mock.method(console, 'error', message => errors.push(message));
  assert.equal((await scrapeNike()).deals.length, 1);
  assert.equal(calls, 2);
  assert.deepEqual(errors, ['  Error on page 2: Nike API error: 503 Service Unavailable']);
});

test('invalid JSON is rejected instead of returning an empty successful result', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'));
  await assert.rejects(scrapeNike(), SyntaxError);
});

test('malformed non-array groupings and products are rejected', async t => {
  for (const page of [{ productGroupings: {} }, { productGroupings: [{ products: {} }] }]) {
    mockPages(t, [page]);
    await assert.rejects(scrapeNike(), /not iterable/);
    t.mock.restoreAll();
  }
});

test('network failures propagate without being presented as zero deals', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Synthetic network failure'); });
  await assert.rejects(scrapeNike(), { message: 'Synthetic network failure' });
});
