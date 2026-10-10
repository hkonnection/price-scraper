/** Regression tests for Canada catalog extraction; no browser or remote writes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { clean } from '../cleaners/lululemon.js';

/**
 * Loads private parser boundaries without launching Playwright.
 * @param {object|null} browser - Optional isolated browser stub, never a real launch.
 * @param {object} options - Isolated environment and launch-options recorder.
 * @returns {Promise<object>} Actual scraper functions in an isolated module.
 */
async function parser(browser = null, { env = {}, launches = [], logs = [], messages = [], failPrimaryLog = false } = {}) {
  const context = vm.createContext({ console: { log: (...args) => {
    if (failPrimaryLog && args[0]?.startsWith('WMTM primary failed:')) throw new Error('Synthetic logger failure');
    messages.push(args.join(' ')); console.log(...args);
  },
    warn: (...args) => logs.push(args.join(' ')) }, URL, process: { env },
    fetch: () => { throw new Error('Remote I/O forbidden in replay'); }, setTimeout: fn => { fn(); } });
  const source = await fs.readFile(new URL('./lululemon.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source + '\nexport { fetchPageData, transformProduct, scrapeSectionPages }; const navigation = typeof discoverWmtmPath === "function" ? discoverWmtmPath : undefined; export { navigation as discoverWmtmPath };', { context });
  await module.link(() => new vm.SyntheticModule(['chromium'], function () {
    this.setExport('chromium', { async launch(options) {
      if (!browser) throw new Error('Browser launch forbidden in replay');
      assert.equal(options.args, undefined, 'Do not launch inherited masking flags');
      assert.deepEqual(Object.keys(options).sort(), ['channel', 'headless']);
      assert.equal(options.channel, 'chrome');
      launches.push({ ...options });
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
 * @param {Array<object>} links - Synthetic Men navigation anchors.
 * @returns {object} Minimal Playwright page evaluate boundary.
 */
function page(context, html, status = 200, links = [{
  href: '/en-ca/c/we-made-too-much/n18mhd', text: 'We Made Too Much',
}]) {
  context.fetch = async () => new Response(html, { status });
  context.document = { getElementById: () => {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    return match ? { textContent: match[1] } : null;
  } };
  context.document.body = { innerText: 'Synthetic public response' };
  return {
    async goto() { return { ok: () => status === 200, status: () => status,
      url: () => 'https://shop.lululemon.com/en-ca/c/test' }; },
    url: () => 'https://shop.lululemon.com/en-ca/',
    title: async () => 'Synthetic public title',
    async $$eval(selector, fn) {
      assert.equal(selector, 'a[data-lll-component-name="hdr_mn:l1_we_made_too_much"]');
      return fn(links.map(link => ({ getAttribute: () => link?.href, textContent: link?.text })));
    },
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
 * @param {object} options - Mode, environment, section-distinct IDs and later failure controls.
 * @returns {Promise<object>} Exit, publication, launch, browser-close and local state evidence.
 */
async function entrypointReplay(catalogs, { dry = false, failFinal = null, env = {}, distinctSections = false,
  links, failure = null, failures = {}, failPrimaryLog = false } = {}) {
  let replay;
  let closed = false;
  const browser = {
    async newContext() { return { async newPage() { return replay; } }; },
    async close() { closed = true; },
  };
  const launches = [], diagnostics = [], urls = [], messages = [];
  const { api, context } = await parser(browser, { env, launches, logs: diagnostics, messages, failPrimaryLog });
  const { replay: baseReplay, visited } = paginatedPage(context, catalogs);
  replay = baseReplay;
  if (links !== undefined) replay.$$eval = page(context, html(catalogs[0]), 200, links).$$eval;
  if (distinctSections) {
    replay.goto = async url => {
      const num = Number(new URL(url).searchParams.get('page') || 1);
      const section = new URL(url).pathname.includes('/men-') ? 'Men'
        : new URL(url).pathname.includes('/we-made-too-much-accessories/') ? 'Accessories' : 'Women';
      const data = structuredClone(catalogs[num - 1] ?? {});
      const catalog = data.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.pages?.[0];
      catalog?.included?.forEach(p => { p.id = `${section}-${p.id}`; });
      catalog?.data?.relationships?.products?.data?.forEach(ref => { ref.id = `${section}-${ref.id}`; });
      visited.push(`${section}:${num}`);
      page(context, html(data));
      return { ok: () => true, status: () => 200 };
    };
  }
  if (failFinal) {
    const goto = replay.goto;
    replay.goto = async url => {
      if (Number(new URL(url).searchParams.get('page') || 1) === catalogs.length && new URL(url).pathname.includes('/c/we-made-too-much/')) {
        page(context, html(failFinal));
        return { ok: () => true, status: () => 200 };
      }
      return goto(url);
    };
  }
  const goto = replay.goto;
  replay.goto = async url => {
    urls.push(url);
    const refused = failures[url] ?? (failure && (failure.stage === 'home' ? new URL(url).pathname === '/en-ca/'
      : new URL(url).pathname.includes('/c/we-made-too-much/')) ? failure : null);
    if (refused?.empty) {
      page(context, html(currentData({ totalCount: 0, products: [] })));
      return { ok: () => true, status: () => 200, url: () => url };
    }
    if (refused) {
      if (refused.unavailable) {
        replay.title = async () => { throw new Error('Diagnostic title unavailable'); };
        replay.evaluate = async () => { throw new Error('Diagnostic body unavailable'); };
      } else {
        replay.title = async () => refused.title ?? 'Public service error';
        context.document.body = { innerText: refused.body ?? 'Public request could not be completed' };
      }
      return { ok: () => false, status: () => refused.status, url: () => `${url}?token=SYNTHETIC_SECRET#private` };
    }
    return goto(url);
  };
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
  return { exits, writes, errors, publication, prior, closed, launches, visited, diagnostics, urls, messages };
}

/**
 * Builds complete synthetic current pages with independently supplied per-page totals.
 * All products and later pages are controls, not captured catalog evidence.
 * @param {Array<number>} totals - Validated total count advertised on each page.
 * @param {number} limit - Fixed raw page size.
 * @returns {Array<object>} Synthetic embedded catalog pages.
 */
function driftingCatalogs(totals, limit = 40) {
  return totals.map((totalCount, i) => currentData({ totalCount, limit, offset: i * limit,
    products: currentProducts(i * limit, Math.min(limit, totalCount - i * limit)) }));
}

test('reported 606 to 607 metadata drift accepts disjoint synthetic raw40 pages', async () => {
  const { api, context } = await parser();
  // Only these metadata values reproduce the report; all 607 product identities
  // and complete pages 3-16 are synthetic controls, not captured catalog evidence.
  const catalogs = driftingCatalogs([606, ...Array(15).fill(607)]);
  const { replay, visited } = paginatedPage(context, catalogs);
  const deals = await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' });
  assert.deepEqual(visited, Array.from({ length: 16 }, (_, i) => i + 1));
  assert.equal(deals.length, 607);
  assert.equal(new Set(deals.map(d => d.product_code)).size, 607);
  assert.equal(deals[0].regular_price, 148);
  assert.equal(deals[0].sale_price, 109);
  assert.match(deals[0].image_url, /LW3JCTS_079841_1/);
});

test('anchored three-percent drift covers bounded growth, shrink and page-count crossings', async t => {
  for (const [name, totals, expected] of [
    ['inclusive growth budget', [600, ...Array(15).fill(618)], 618],
    ['inclusive shrink budget', [600, ...Array(14).fill(582)], 582],
    ['newly advertised final page', [600, ...Array(15).fill(601)], 601],
    ['growth first appears on original final page', [...Array(14).fill(600), 601, 601], 601],
    ['shrink removes old final page', [601, ...Array(14).fill(600)], 600],
    ['shrink first appears on newly final page', [...Array(14).fill(601), 600], 600],
  ]) {
    await t.test(name, async () => {
      const { api, context } = await parser();
      const { replay, visited } = paginatedPage(context, driftingCatalogs(totals));
      const deals = await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' });
      assert.deepEqual(visited, totals.map((_, i) => i + 1));
      assert.equal(deals.length, expected);
      assert.equal(new Set(deals.map(d => d.product_code)).size, expected);
    });
  }
});

test('drift beyond the initial budget rejects growth, shrink and cumulative small shifts', async t => {
  for (const [name, totals] of [
    ['one over growth threshold', [600, 619]],
    ['one over shrink threshold', [600, 581]],
    ['small shifts accumulate beyond original anchor', [600, 606, 612, 619]],
  ]) {
    await t.test(name, async () => {
      const { api, context } = await parser();
      const { replay } = paginatedPage(context, driftingCatalogs(totals));
      await assert.rejects(api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' }), /Inconsistent catalog pagination/);
    });
  }
});

test('observed metadata drift allows bounded partial raw overlap with first identity winning', async t => {
  for (const overlap of [1, 18]) {
    await t.test(`overlap ${overlap} within initial budget 18`, async () => {
      const { api, context } = await parser();
      const catalogs = driftingCatalogs([600, ...Array(15).fill(601)]);
      const secondProducts = currentProducts(40 - overlap, 40);
      secondProducts[0].attributes.styles[0].colors[0].price.salePrice = 1;
      catalogs[1] = currentData({ totalCount: 601, offset: 40, products: secondProducts });
      const { replay } = paginatedPage(context, catalogs);
      const deals = await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' });
      assert.equal(deals.length, 601 - overlap);
      assert.equal(new Set(deals.map(d => d.product_code)).size, deals.length);
      assert.notEqual(deals.find(d => d.product_code === `synthetic-${40 - overlap}`).sale_price, 1);
    });
  }
});

test('raw overlap dedupe runs before availability filtering during count movement', async () => {
  const { api, context } = await parser();
  const catalogs = driftingCatalogs([600, ...Array(15).fill(601)]);
  const first = currentProducts(0, 40);
  first[39].attributes.styles.forEach(s => s.colors.forEach(c => { c.availability.isAvailable = false; }));
  catalogs[0] = currentData({ totalCount: 600, products: first });
  // Same ID becomes available on the next page; raw first occurrence still wins.
  catalogs[1] = currentData({ totalCount: 601, offset: 40, products: currentProducts(39, 40) });
  const deals = await api.scrapeSectionPages(paginatedPage(context, catalogs).replay,
    { name: 'Women', path: '/en-ca/c/test' });
  assert.equal(deals.length, 599);
  assert.equal(deals.some(d => d.product_code === 'synthetic-39'), false);
});

test('overlap budget is cumulative and never allows repeated or no-progress pages', async t => {
  const totals = [600, ...Array(15).fill(601)];
  for (const [name, changes] of [
    ['one over overlap budget', [[1, currentProducts(21, 40)]]],
    ['cumulative overlap exceeds budget', [[1, currentProducts(30, 40)], [2, [...currentProducts(61, 9), ...currentProducts(80, 31)]]]],
    ['whole page repeats during drift', [[1, currentProducts(0, 40)]]],
    ['reordered page repeats during drift', [[1, currentProducts(0, 40).reverse()]]],
    ['one-product final page makes no progress', [[15, currentProducts(0, 1)]]],
    ['within-page duplicate despite drift', [[1, [currentProducts(40, 1)[0], ...currentProducts(40, 39)]]]],
  ]) {
    await t.test(name, async () => {
      const { api, context } = await parser();
      const catalogs = driftingCatalogs(totals);
      changes.forEach(([index, products]) => {
        catalogs[index] = currentData({ totalCount: 601, offset: index * 40, products });
      });
      const { replay } = paginatedPage(context, catalogs);
      await assert.rejects(api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' }), /Repeated catalog product|No pagination progress/);
    });
  }
});

test('drift rounding and maximum page cap retain strict boundary checks', async t => {
  for (const [initial, later, accepts] of [[33, 34, false], [34, 35, true], [34, 33, true], [34, 36, false]]) {
    await t.test(`initial ${initial}, later ${later}`, async () => {
      const { api, context } = await parser();
      const count = Math.ceil(later / 10);
      const { replay } = paginatedPage(context, driftingCatalogs([initial, ...Array(count - 1).fill(later)], 10));
      if (accepts) assert.equal((await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' })).length, later);
      else await assert.rejects(api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' }), /Inconsistent catalog pagination/);
    });
  }
  await t.test('200 pages allowed but bounded count growth cannot advertise 201', async () => {
    const { api, context } = await parser();
    const { replay, visited } = paginatedPage(context, driftingCatalogs(Array(200).fill(600), 3));
    assert.equal((await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' })).length, 600);
    assert.equal(visited.length, 200);
    const growing = paginatedPage(context, driftingCatalogs([600, 601], 3)).replay;
    await assert.rejects(api.scrapeSectionPages(growing, { name: 'Women', path: '/en-ca/c/test' }), /Invalid catalog pagination/);
  });
  await t.test('shrink behind the requested offset fails rather than accepting an empty old final page', async () => {
    const { api, context } = await parser();
    const catalogs = driftingCatalogs(Array(16).fill(601));
    catalogs[15] = currentData({ totalCount: 600, offset: 600, products: currentProducts(600, 1) });
    await assert.rejects(api.scrapeSectionPages(paginatedPage(context, catalogs).replay,
      { name: 'Women', path: '/en-ca/c/test' }), /Invalid catalog pagination/);
  });
});

test('drift observation remains section-local even when totals return to the initial anchor', async () => {
  const { api, context } = await parser();
  const totals = [600, 601, ...Array(13).fill(600)];
  const catalogs = driftingCatalogs(totals);
  catalogs[2] = currentData({ totalCount: 600, offset: 80, products: currentProducts(79, 40) });
  const { replay } = paginatedPage(context, catalogs);
  assert.equal((await api.scrapeSectionPages(replay, { name: 'Women', path: '/en-ca/c/test' })).length, 599);
  // A separate stable section cannot borrow the previous section's observed drift.
  const stable = driftingCatalogs(Array(15).fill(600));
  stable[1] = currentData({ totalCount: 600, offset: 40, products: currentProducts(39, 40) });
  await assert.rejects(api.scrapeSectionPages(paginatedPage(context, stable).replay,
    { name: 'Men', path: '/en-ca/c/test' }), /Repeated catalog product/);
});

test('visible Chrome requires explicit environment opt-in with isolated launch stubs', async t => {
  for (const [value, headless] of [[undefined, true], ['1', false], ['0', true], ['false', true],
    ['', true], ['true', true], ['TRUE', true], [' 1 ', true], ['yes', true]]) {
    await t.test(`LULULEMON_VISIBLE_CHROME=${JSON.stringify(value)}`, async () => {
      let replay;
      let closed = false;
      const launches = [];
      const browser = { async newContext(options) {
        assert.equal(options, undefined);
        return { async newPage() { return replay; } };
      }, async close() { closed = true; } };
      const env = value === undefined ? {} : { LULULEMON_VISIBLE_CHROME: value };
      const { api, context } = await parser(browser, { env, launches });
      replay = page(context, html(currentData()));
      assert.equal((await api.scrapeLululemon()).deals.length, 3);
      assert.deepEqual(launches, [{ headless, channel: 'chrome' }]);
      assert.equal(closed, true);
    });
  }
});

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
  assert.equal(result.deals.length, 1);
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

test('subsequent current pages cannot exceed drift budget or change limit or catalog schema', async t => {
  const first = currentData({ totalCount: 5, limit: 3, products: currentProducts(0, 3) });
  for (const [name, second] of [
    ['count changes beyond zero budget for tiny catalog', currentData({ totalCount: 6, limit: 3, offset: 3, products: currentProducts(3, 3) })],
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

test('CAD selection keeps price and image paired to the same available color', async () => {
  const { api } = await parser();
  const product = currentProducts(0, 1)[0];
  const colors = product.attributes.styles[0].colors;
  colors[0].price.currencyCode = 'USD';
  const cad = structuredClone(colors[0]);
  cad.price = { currencyCode: 'CAD', listPrice: 100, salePrice: 75 };
  cad.images = [{ url: 'https://example.invalid/synthetic-cad-color.jpg' }];
  colors.push(cad);
  const deal = api.transformProduct(product, 'Women');
  assert.equal(deal.regular_price, 100);
  assert.equal(deal.sale_price, 75);
  assert.equal(deal.image_url, 'https://example.invalid/synthetic-cad-color.jpg');
});

test('inventory-drift offline smoke runs happy, negative, then publication state checks', async t => {
  const successes = [], rejected = [];
  const exact = driftingCatalogs([606, ...Array(15).fill(607)]);
  const overlap = driftingCatalogs([600, ...Array(15).fill(601)]);
  overlap[1] = currentData({ totalCount: 601, offset: 40, products: currentProducts(39, 40) });
  await t.test('phase 1 happy: exact metadata, growth, shrink and overlap through actual entrypoint', async () => {
    for (const [name, catalogs, count, visible] of [
      ['reported606/607 synthetic controls', exact, 607, true],
      ['growth inclusive18', driftingCatalogs([600, ...Array(15).fill(618)]), 618, false],
      ['shrink inclusive18', driftingCatalogs([600, ...Array(14).fill(582)]), 582, false],
      ['new final page', driftingCatalogs([600, ...Array(15).fill(601)]), 601, false],
      ['removed final page', driftingCatalogs([601, ...Array(14).fill(600)]), 600, false],
      ['partial overlap deduped', overlap, 600, true],
    ]) {
      const result = await entrypointReplay(catalogs, { distinctSections: true,
        env: visible ? { LULULEMON_VISIBLE_CHROME: '1' } : {} });
      assert.deepEqual(result.exits, []);
      assert.equal(result.closed, true);
      assert.equal(result.writes.length, 1);
      assert.equal(result.publication.length, count);
      assert.equal(new Set(result.publication.map(d => d.product_code)).size, count);
      assert.deepEqual(result.launches, [{ headless: !visible, channel: 'chrome' }]);
      assert.ok(result.publication.every(d => d.regular_price > d.sale_price && d.sale_price > 0
        && d.brand === 'Lululemon' && d.promo_type === 'We Made Too Much'));
      const first = result.publication[0];
      assert.equal(first.regular_price, 148);
      assert.equal(first.sale_price, 109);
      assert.match(first.image_url, /LW3JCTS_079841_1/);
      successes.push(result);
      console.log(`DRIFT_SMOKE_HAPPY ${name}: uniqueCADRows=${count} publishCalls=1 headless=${!visible} remoteWrites=0`);
    }
  });
  await t.test('phase 2 negative: moving inventory cannot hide bad pagination or repetition', async () => {
    const wrongOffset = driftingCatalogs([600, 601]);
    wrongOffset[1] = currentData({ totalCount: 601, offset: 0, products: currentProducts(40, 40) });
    const changedLimit = driftingCatalogs([600, 601]);
    changedLimit[1] = currentData({ totalCount: 601, limit: 41, offset: 41, products: currentProducts(40, 41) });
    const shortIntermediate = driftingCatalogs([600, 601]);
    shortIntermediate[1] = currentData({ totalCount: 601, offset: 40, products: currentProducts(40, 39) });
    const repeated = driftingCatalogs([600, 601]);
    repeated[1] = currentData({ totalCount: 601, offset: 40, products: currentProducts(0, 40) });
    const tooMuchOverlap = driftingCatalogs([600, 601]);
    tooMuchOverlap[1] = currentData({ totalCount: 601, offset: 40, products: currentProducts(21, 40) });
    const noProgressFinal = driftingCatalogs([600, ...Array(15).fill(601)]);
    noProgressFinal[15] = currentData({ totalCount: 601, offset: 600, products: currentProducts(0, 1) });
    const shortFinal = driftingCatalogs([606, ...Array(15).fill(607)]);
    shortFinal[15] = currentData({ totalCount: 607, offset: 600, products: currentProducts(600, 6) });
    const withinPageDuplicate = driftingCatalogs([600, 601]);
    withinPageDuplicate[1] = currentData({ totalCount: 601, offset: 40,
      products: [currentProducts(40, 1)[0], ...currentProducts(40, 39)] });
    const unavailable = structuredClone(exact);
    unavailable.forEach(data => data.props.pageProps.dehydratedState.queries[0].state.data.pages[0].included.forEach(p =>
      p.attributes.styles.forEach(s => s.colors.forEach(c => { c.availability.isAvailable = false; }))));
    const negatives = [
      ['growth one over budget', driftingCatalogs([600, 619]), /Inconsistent catalog pagination/],
      ['shrink one over budget', driftingCatalogs([600, 581]), /Inconsistent catalog pagination/],
      ['cumulative total drift', driftingCatalogs([600, 606, 612, 619]), /Inconsistent catalog pagination/],
      ['wrong offset during drift', wrongOffset, /Invalid catalog pagination/],
      ['changed limit during drift', changedLimit, /Inconsistent catalog pagination/],
      ['changed type during drift', [exact[0], legacyData([legacyProduct('legacy')], 16)], /Inconsistent catalog pagination/],
      ['short non-final during drift', shortIntermediate, /Incomplete catalog products/],
      ['short advertised new final page', shortFinal, /Incomplete catalog products/],
      ['whole repeated page during drift', repeated, /No pagination progress/],
      ['partial overlap one over budget', tooMuchOverlap, /Repeated catalog product/],
      ['one-product final no progress', noProgressFinal, /No pagination progress/],
      ['duplicate within drifting page', withinPageDuplicate, /Repeated catalog product/],
      ['200-page cap despite small drift', driftingCatalogs([600, 601], 3), /Invalid catalog pagination/],
      ['whole drift run zero output', unavailable, /No usable Lululemon deals/],
    ];
    for (const [name, catalogs, message] of negatives) {
      for (const dry of [false, true]) {
        const result = await entrypointReplay(catalogs, { dry, distinctSections: true });
        assert.deepEqual(result.exits, [1], name);
        assert.equal(result.closed, true, name);
        assert.equal(result.writes.length, 0, name);
        assert.match(result.errors[0], message, name);
        rejected.push(result);
      }
      console.log(`DRIFT_SMOKE_NEGATIVE ${name}: rejected both modes publishCalls=0 remoteWrites=0`);
    }
    // Harder after the first clean pass: truncate the final page after 15 valid
    // pages, and test overlap accumulation across multiple pages.
    const later = await entrypointReplay(exact, { distinctSections: true,
      failFinal: currentData({ totalCount: 607, offset: 600, products: currentProducts(600, 6) }) });
    assert.deepEqual(later.exits, [1]);
    assert.match(later.errors[0], /we-made-too-much.*page 16.*Incomplete catalog products/);
    assert.equal(later.writes.length, 0);
    rejected.push(later);
    const cumulative = driftingCatalogs([600, 601, 601]);
    cumulative[1] = currentData({ totalCount: 601, offset: 40, products: currentProducts(30, 40) });
    cumulative[2] = currentData({ totalCount: 601, offset: 80,
      products: [...currentProducts(61, 9), ...currentProducts(80, 31)] });
    const accumulated = await entrypointReplay(cumulative);
    assert.deepEqual(accumulated.exits, [1]);
    assert.match(accumulated.errors[0], /Repeated catalog product/);
    assert.equal(accumulated.writes.length, 0);
    rejected.push(accumulated);
    console.log('DRIFT_SMOKE_NEGATIVE harder: truncated final page after 15 valid pages and cumulative overlap19 rejected publishCalls=0 remoteWrites=0');
  });
  await t.test('phase 3 state: prior publication preserved on failure, successful IDs and launch verified', () => {
    assert.equal(successes.length, 6);
    assert.equal(rejected.length, 30);
    rejected.forEach(result => {
      assert.deepEqual(result.publication, result.prior);
      assert.equal(result.writes.length, 0);
    });
    successes.forEach(result => {
      assert.deepEqual(result.publication, structuredClone(result.writes[0]));
      assert.notDeepEqual(result.publication, result.prior);
      assert.equal(new Set(result.publication.map(d => d.product_code)).size, result.publication.length);
      assert.equal(result.launches.length, 1);
    });
    console.log('DRIFT_SMOKE_STATE successfulUniqueReplacements=6 rejectedPriorSnapshotsUnchanged=30 launchOptionsVerified=6 persistenceCallsOnFailure=0 remoteWrites=0');
  });
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
      assert.equal(result.writes[0].length, 2, 'Two filtered deals in the complete unfiltered collection');
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
    // Stronger counterfactual: the final page fails after a valid first page.
    const laterFailure = await entrypointReplay(completeCurrent, {
      failFinal: currentData({ totalCount: 5, limit: 3, offset: 3, products: currentProducts(3, 1) }),
    });
    assert.deepEqual(laterFailure.exits, [1]);
    assert.equal(laterFailure.writes.length, 0);
    assert.match(laterFailure.errors[0], /we-made-too-much.*page 2.*Incomplete catalog products/);
    rejected.push({ name: 'final page truncation', dry: false, result: laterFailure });
    console.log('SMOKE_NEGATIVE final page truncation: first page completed; final page rejected; publishCalls=0 remoteWrites=0');
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

const menPath = '/en-ca/c/we-made-too-much/n18mhd';
const verifiedFutureMenPath = '/en-ca/c/we-made-too-much/synthetic123';

test('non-OK diagnostics retain status and safe final URL with capped readable content', async t => {
  for (const status of [400, 403, 404, 429, 500, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      const logs = [];
      const { api, context } = await parser(null, { logs });
      const replay = page(context, '', status);
      replay.goto = async () => ({ ok: () => false, status: () => status,
        url: () => `https://shop.lululemon.com${menPath}?token=SYNTHETIC_SECRET#private` });
      replay.title = async () => `Public error ${status} ${'word '.repeat(100)}`;
      await assert.rejects(api.fetchPageData(replay, menPath, 1), new RegExp(`page 1: HTTP ${status}$`));
      assert.equal(logs.length, 1);
      assert.match(logs[0], new RegExp(`HTTP ${status}`));
      assert.ok(logs[0].includes(`final URL=https://shop.lululemon.com${menPath}`));
      const text = logs[0].split('title=')[1];
      assert.ok(text.startsWith(`Public error ${status}`));
      assert.equal(text.length, 300);
      assert.doesNotMatch(logs[0], /SYNTHETIC_SECRET|token=|#private|bot block|bad path/i);
    });
  }
});

test('non-OK diagnostics fallback, redaction and diagnostic failures preserve the HTTP error', async t => {
  for (const [name, title, body] of [
    ['empty title reads body', '', 'Public request failed GE401001'],
    ['unavailable title reads body', null, 'Public request failed GE401001'],
    ['unexpected title reads body', {}, 'Public request failed GE401001'],
    ['unavailable body', null, null],
    ['unexpected body type', null, {}],
    ['capped body', '', `Public ${'word '.repeat(500)}`],
    ['quoted sensitive body keys', '', '{"message":"Public request failed", "token":"SYNTHETIC_SECRET", "session_id":"SYNTHETIC_SECRET", "password":"synthetic password"}'],
    ['redact public error values', '', 'Public failure token=SYNTHETIC_SECRET password="synthetic password" Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 email=user@example.test https://user:pass@shop.lululemon.com/en-ca/?session=SYNTHETIC_SECRET#private'],
  ]) {
    await t.test(name, async () => {
      const logs = [];
      const { api, context } = await parser(null, { logs });
      const replay = page(context, '', 400);
      replay.title = async () => { if (title === null) throw new Error('Title unavailable'); return title; };
      context.document.body = { innerText: body };
      if (body === null) replay.evaluate = async () => { throw new Error('Body unavailable'); };
      await assert.rejects(api.fetchPageData(replay, menPath, 1), /page 1: HTTP 400$/);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /HTTP 400.*final URL=/);
      assert.doesNotMatch(logs[0], /SYNTHETIC_SECRET|synthetic password|abcdefghijklmnopqrstuvwxyz123456|user@example.test|user:pass|#private/);
      if (typeof body === 'string') {
        assert.match(logs[0], /body=.*Public/);
        assert.ok(logs[0].split('body=')[1].length <= 300);
        if (name === 'capped body') assert.equal(logs[0].split('body=')[1].length, 300);
      } else assert.match(logs[0], /unavailable/);
    });
  }
  await t.test('missing response is fatal with bounded diagnostics', async () => {
    const logs = [];
    const { api, context } = await parser(null, { logs });
    const replay = page(context, '');
    replay.goto = async () => null;
    await assert.rejects(api.fetchPageData(replay, menPath, 1), /HTTP unknown$/);
    assert.match(logs[0], /HTTP unknown.*final URL=unavailable/);
  });
  await t.test('unavailable final URL and broken logger do not replace failure', async () => {
    const { api, context } = await parser();
    const replay = page(context, '', 429);
    replay.goto = async () => ({ ok: () => false, status: () => 429, url: () => { throw new Error('URL unavailable'); } });
    context.console.warn = () => { throw new Error('Logger unavailable'); };
    await assert.rejects(api.fetchPageData(replay, menPath, 2), /page 2: HTTP 429$/);
  });
  await t.test('off-origin redirect hides credentials and private path values', async () => {
    const logs = [];
    const { api, context } = await parser(null, { logs });
    const replay = page(context, '', 403);
    replay.goto = async () => ({ ok: () => false, status: () => 403,
      url: () => 'https://user:pass@elsewhere.example/private/SYNTHETIC_SECRET?code=SYNTHETIC_SECRET#private' });
    await assert.rejects(api.fetchPageData(replay, menPath, 1), /HTTP 403$/);
    assert.match(logs[0], /final URL=https:\/\/elsewhere.example\/\[redacted path\]/);
    assert.doesNotMatch(logs[0], /SYNTHETIC_SECRET|user:pass|code=|#private/);
  });
});

test('WMTM navigation discovery trusts only the current Canadian unfiltered header sale link', async t => {
  for (const href of [verifiedFutureMenPath, `https://shop.lululemon.com${verifiedFutureMenPath}?icid=public-marketing`]) {
    await t.test(`trusted ${href}`, async () => {
      const { api, context } = await parser();
      const replay = page(context, '', 200, [{ href, text: 'We Made Too Much' }, { href, text: ' We Made Too Much ' }]);
      assert.equal(await api.discoverWmtmPath(replay), verifiedFutureMenPath);
    });
  }
  for (const [name, links, source] of [
    ['ambiguous', [{ href: menPath, text: 'We Made Too Much' }, { href: verifiedFutureMenPath, text: 'We Made Too Much' }], undefined],
    ['wrong locale', [{ href: '/en-us/c/we-made-too-much/synthetic123', text: 'We Made Too Much' }], undefined],
    ['wrong section', [{ href: '/en-ca/c/women-we-made-too-much/synthetic123', text: 'We Made Too Much' }], undefined],
    ['subcategory', [{ href: '/en-ca/c/we-made-too-much-pants/synthetic123', text: 'We Made Too Much' }], undefined],
    ['off origin', [{ href: `https://elsewhere.example${verifiedFutureMenPath}`, text: 'We Made Too Much' }], undefined],
    ['credentials', [{ href: `https://user:pass@shop.lululemon.com${verifiedFutureMenPath}`, text: 'We Made Too Much' }], undefined],
    ['wrong label', [{ href: verifiedFutureMenPath, text: 'Women' }], undefined],
    ['null href', [{ href: null, text: 'We Made Too Much' }], undefined],
    ['unexpected href', [{ href: {}, text: 'We Made Too Much' }], undefined],
    ['unexpected label', [{ href: verifiedFutureMenPath, text: {} }], undefined],
    ['javascript', [{ href: 'javascript:alert(1)', text: 'We Made Too Much' }], undefined],
    ['malformed URL', [{ href: 'https://[invalid', text: 'We Made Too Much' }], undefined],
    ['filtered collection', [{ href: `${verifiedFutureMenPath}?page=2`, text: 'We Made Too Much' }], undefined],
    ['non-Canada source', [{ href: verifiedFutureMenPath, text: 'We Made Too Much' }], 'https://shop.lululemon.com/en-us/'],
    ['off-origin source', [{ href: verifiedFutureMenPath, text: 'We Made Too Much' }], 'https://elsewhere.example/en-ca/'],
  ]) {
    await t.test(name, async () => {
      const { api, context } = await parser();
      const replay = page(context, '', 200, links);
      if (source) replay.url = () => source;
      await assert.rejects(api.discoverWmtmPath(replay), /Lululemon WMTM navigation/);
    });
  }
});

test('WMTM browser setup failures close acquired resources', async () => {
  for (const stage of ['context', 'page']) {
    let closed = false;
    const browser = {
      async newContext() {
        if (stage === 'context') throw new Error('Synthetic context failure');
        return { async newPage() { throw new Error('Synthetic page failure'); } };
      },
      async close() { closed = true; },
    };
    const { api } = await parser(browser);
    await assert.rejects(api.scrapeLululemon(), /Synthetic (context|page) failure/);
    assert.equal(closed, true);
  }
});

test('WMTM primary works without a navigation link and missing fallback does not retry', async () => {
  const result = await entrypointReplay([currentData()], { dry: true, links: [] });
  assert.deepEqual(result.exits, []);
  assert.ok(result.urls.includes('https://shop.lululemon.com' + menPath));
  assert.equal(result.writes.length, 0);
  assert.equal(result.closed, true);
  const refusal = await entrypointReplay([currentData()], { dry: true, links: [], failure: { stage: 'catalog', status: 400 } });
  assert.deepEqual(refusal.exits, [1]);
  assert.equal(refusal.urls.filter(url => url.includes(menPath)).length, 1);
  assert.match(refusal.errors[0], /https:\/\/shop.lululemon.com\/en-ca\/c\/we-made-too-much\/n18mhd.*HTTP 400/);
});

test('WMTM zero products reject with the exact URL and retained previous publication', async () => {
  const result = await entrypointReplay([currentData({ totalCount: 0, products: [] })], { dry: true });
  assert.deepEqual(result.exits, [1]);
  assert.match(result.errors[0], /https:\/\/shop.lululemon.com\/en-ca\/c\/we-made-too-much\/n18mhd.*Empty catalog products/);
  assert.deepEqual(result.publication, result.prior);
  assert.equal(result.closed, true);
});

test('WMTM navigation offline smoke runs happy, negative, then unchanged publication state', async t => {
  const successes = [], rejected = [];
  const links = [{ href: verifiedFutureMenPath, text: 'We Made Too Much' }];
  await t.test('phase 1 happy: primary collection through actual scraper, cleaner and entrypoint', async () => {
    for (const dry of [false, true]) {
      const result = await entrypointReplay([currentData()], { dry, links });
      assert.deepEqual(result.exits, []);
      assert.equal(result.writes.length, dry ? 0 : 1);
      assert.ok(result.urls.includes(`https://shop.lululemon.com${menPath}`));
      assert.equal(result.urls.some(url => url.includes(verifiedFutureMenPath)), false);
      assert.equal(result.closed, true);
      successes.push(result);
      console.log(`MEN_SMOKE_HAPPY dry=${dry} primaryPathUsed=true cleanedRows=3 publishCalls=${result.writes.length} browserClosed=true remoteWrites=0`);
    }
  });
  await t.test('phase 2 negative: refusals, bad navigation and retained completeness rejection', async () => {
    for (const [name, options, message] of [
      ...[400, 403, 429, 500, 503].map(status => [`WMTM HTTP ${status}`, { links, failure: { stage: 'catalog', status } }, new RegExp(`HTTP ${status}`)]),
      ['home HTTP 403', { failure: { stage: 'home', status: 403 } }, /HTTP 403/],
      ['catalog HTTP 404', { failure: { stage: 'catalog', status: 404 } }, /HTTP 404/],
      ['unavailable diagnostics', { links, failure: { stage: 'catalog', status: 400, unavailable: true } }, /HTTP 400/],
      ['ambiguous link', { links: [...links, { href: menPath, text: 'We Made Too Much' }], failure: { stage: 'catalog', status: 404 } }, /Lululemon WMTM navigation/],
      ['off-origin link', { links: [{ href: `https://elsewhere.example${verifiedFutureMenPath}`, text: 'We Made Too Much' }], failure: { stage: 'catalog', status: 404 } }, /Lululemon WMTM navigation/],
      ['retained short raw page', { failFinal: currentData({ totalCount: 3, products: currentProducts(0, 2) }) }, /Incomplete catalog products/],
    ]) {
      for (const dry of [false, true]) {
        const result = await entrypointReplay([currentData()], { ...options, dry });
        assert.deepEqual(result.exits, [1], name);
        assert.match(result.errors[0], message, name);
        assert.equal(result.writes.length, 0, name);
        assert.equal(result.closed, true, name);
        if (options.failure) {
          assert.equal(result.diagnostics.length, options.failure.stage === 'home' ? 1
            : result.urls.filter(url => url.includes('/c/we-made-too-much/')).length, name);
          assert.match(result.diagnostics[0], /HTTP.*final URL=/);
          assert.doesNotMatch(result.diagnostics[0], /SYNTHETIC_SECRET|token=|#private/);
        }
        rejected.push(result);
      }
      console.log(`MEN_SMOKE_NEGATIVE ${name}: rejected both modes publishCalls=0 browserClosed=true remoteWrites=0`);
    }
    // Harder after a clean negative pass: a conflicting bad link must not be ignored
    // just because one valid link exists, and failed collection requests must not retry.
    const mixed = await entrypointReplay([currentData()], { links: [...links, { href: '/en-us/c/we-made-too-much/synthetic123', text: 'We Made Too Much' }], failure: { stage: 'catalog', status: 404 } });
    assert.deepEqual(mixed.exits, [1]);
    assert.match(mixed.errors[0], /Lululemon WMTM navigation/);
    rejected.push(mixed);
    rejected.filter(result => result.errors[0].includes('page 1: HTTP')).forEach(result => {
      const attempted = result.urls.filter(url => url.includes('/c/we-made-too-much/'));
      assert.equal(new Set(attempted).size, attempted.length, 'Never repeat a failed destination');
      assert.equal(result.urls.some(url => /(?:men|women)-we-made-too-much|we-made-too-much-accessories/.test(url)), false);
    });
    console.log('MEN_SMOKE_NEGATIVE harder: mixed invalid link rejected; no repeated failed destination; no separate gender or accessory request');
  });
  await t.test('phase 3 state: failed sections preserve prior synthetic publication and close browser', () => {
    assert.equal(rejected.length, 23);
    rejected.forEach(result => {
      assert.deepEqual(result.publication, result.prior);
      assert.equal(result.writes.length, 0);
      assert.equal(result.closed, true);
    });
    assert.deepEqual(successes[0].publication, structuredClone(successes[0].writes[0]));
    assert.equal(successes[0].publication.length, 3);
    assert.deepEqual(successes[1].publication, successes[1].prior);
    console.log('MEN_SMOKE_STATE successfulReplacementRows=3 successfulDryRunsUnchanged=1 rejectedPriorSnapshotsUnchanged=23 browserClosedAll=true remoteWrites=0');
  });
});

test('primary-first bounded fallback smoke runs happy, negative, then state verification', async t => {
  const primaryUrl = `https://shop.lululemon.com${menPath}`;
  const fallbackUrl = `https://shop.lululemon.com${verifiedFutureMenPath}`;
  const links = [{ href: verifiedFutureMenPath, text: 'We Made Too Much' }];
  const successes = [], rejected = [];
  await t.test('phase 1 happy: fixed primary first, then one distinct navigation fallback if needed', async () => {
    const primary = await entrypointReplay([currentData()], { dry: true, links });
    assert.deepEqual(primary.exits, []);
    assert.deepEqual(primary.urls, ['https://shop.lululemon.com/en-ca/', primaryUrl]);
    assert.ok(primary.messages.includes(`WMTM source=primary; URL=${primaryUrl}`));
    assert.equal(primary.messages.some(message => message.includes('source=fallback-navigation')), false);
    successes.push(primary);
    for (const refusal of [{ status: 400 }, { status: 403 }, { status: 404 }, { status: 429 }, { status: 503 }, { empty: true }]) {
      for (const dry of [false, true]) {
        const result = await entrypointReplay([currentData()], { dry, links, failures: { [primaryUrl]: refusal } });
        assert.deepEqual(result.exits, []);
        assert.deepEqual(result.urls, ['https://shop.lululemon.com/en-ca/', primaryUrl, fallbackUrl]);
        assert.ok(result.messages.includes(`WMTM source=fallback-navigation; URL=${fallbackUrl}`));
        assert.equal(result.writes.length, dry ? 0 : 1);
        assert.equal(result.closed, true);
        successes.push(result);
      }
    }
    // A later-page refusal must discard primary partial rows and start the distinct
    // fallback collection from page 1. Never merge incomplete primary rows.
    const catalogs = [currentData({ totalCount: 5, limit: 3, products: currentProducts(0, 3) }),
      currentData({ totalCount: 5, limit: 3, offset: 3, products: currentProducts(3, 2) })];
    const later = await entrypointReplay(catalogs, { links, failures: { [`${primaryUrl}?page=2`]: { status: 400 } } });
    assert.deepEqual(later.exits, []);
    assert.equal(later.publication.length, 5);
    assert.ok(later.messages.some(message => message.includes(`${primaryUrl}?page=2`) && message.includes('HTTP 400')),
      'Successful fallback must retain the exact failed primary URL');
    assert.equal(new Set(later.publication.map(row => row.product_code)).size, 5);
    assert.deepEqual(later.urls, ['https://shop.lululemon.com/en-ca/', primaryUrl, `${primaryUrl}?page=2`, fallbackUrl, `${fallbackUrl}?page=2`]);
    successes.push(later);
    console.log('PRIMARY_SMOKE_HAPPY primaryUsedFirst=true refusalOrEmptyFallbackControls=12 laterPageFallbackUniqueRows=5 fallbackAttemptsAtMostOne=true remoteWrites=0');
  });
  await t.test('phase 2 negative: no repeated destination, no unsafe navigation, no guard-error fallback', async () => {
    for (const [name, fallbackLinks, failures, message] of [
      ['missing', [], { [primaryUrl]: { status: 404 } }, /HTTP 404/],
      ['same path', [{ href: menPath, text: 'We Made Too Much' }], { [primaryUrl]: { status: 400 } }, /HTTP 400/],
      ['same path with tracking', [{ href: `${menPath}?icid=public`, text: 'We Made Too Much' }], { [primaryUrl]: { status: 404 } }, /HTTP 404/],
      ['ambiguous', [...links, { href: menPath, text: 'We Made Too Much' }], { [primaryUrl]: { status: 400 } }, /HTTP 400/],
      ['off origin', [{ href: `https://elsewhere.example${verifiedFutureMenPath}`, text: 'We Made Too Much' }], { [primaryUrl]: { status: 403 } }, /HTTP 403/],
      ['fallback refused', links, { [primaryUrl]: { status: 404 }, [fallbackUrl]: { status: 503 } }, /HTTP 404.*HTTP 503/],
      ['fallback empty', links, { [primaryUrl]: { status: 400 }, [fallbackUrl]: { empty: true } }, /HTTP 400.*Empty catalog products/],
    ]) {
      for (const dry of [false, true]) {
        const result = await entrypointReplay([currentData()], { dry, links: fallbackLinks, failures });
        assert.deepEqual(result.exits, [1], name);
        assert.match(result.errors[0], message, name);
        assert.ok(result.errors[0].includes(primaryUrl), name);
        assert.equal(result.urls.filter(url => url === primaryUrl).length, 1, name);
        assert.ok(result.urls.filter(url => url === fallbackUrl).length <= 1, name);
        if (name.startsWith('fallback')) assert.ok(result.errors[0].includes(fallbackUrl), name);
        assert.equal(result.closed, true, name);
        assert.equal(result.writes.length, 0, name);
        rejected.push(result);
      }
    }
    const malformed = currentData({ totalCount: 0, products: [] });
    malformed.props.pageProps.dehydratedState.queries[0].state.data.pages[0].included = null;
    const badShape = await entrypointReplay([malformed], { links });
    assert.deepEqual(badShape.exits, [1]);
    assert.equal(badShape.urls.includes(fallbackUrl), false, 'Malformed catalog is not a moved link');
    rejected.push(badShape);
    for (const options of [{ totalCount: 3 }, { totalCount: 0, limit: 0 }, { totalCount: 0, offset: 1 }]) {
      const invalidEmpty = await entrypointReplay([currentData({ ...options, products: [] })], { links });
      assert.deepEqual(invalidEmpty.exits, [1]);
      assert.equal(invalidEmpty.urls.includes(fallbackUrl), false, 'Invalid metadata or raw truncation is not link drift');
      rejected.push(invalidEmpty);
    }
    for (const totalPages of [0, undefined]) {
      const invalidLegacy = legacyData([], 1);
      invalidLegacy.props.pageProps.dehydratedState.queries[0].state.data.pages[0].totalProductPages = totalPages;
      const result = await entrypointReplay([invalidLegacy], { links });
      assert.deepEqual(result.exits, [1]);
      assert.equal(result.urls.includes(fallbackUrl), false, 'Invalid legacy pagination cannot activate fallback');
      rejected.push(result);
    }
    const truncated = await entrypointReplay([currentData({ totalCount: 3, products: currentProducts(0, 2) })], { links });
    assert.deepEqual(truncated.exits, [1]);
    assert.match(truncated.errors[0], /Incomplete catalog products/);
    assert.equal(truncated.urls.includes(fallbackUrl), false);
    rejected.push(truncated);
    // Harder after a clean first pass: empty final page must not be treated as a
    // moved collection, and a repeated primary page-2 refusal must never be retried.
    const emptyFinal = await entrypointReplay([
      currentData({ totalCount: 5, limit: 3, products: currentProducts(0, 3) }),
      currentData({ totalCount: 5, limit: 3, offset: 3, products: [] }),
    ], { links });
    assert.deepEqual(emptyFinal.exits, [1]);
    assert.equal(emptyFinal.urls.includes(fallbackUrl), false);
    rejected.push(emptyFinal);
    const repeated = await entrypointReplay([
      currentData({ totalCount: 5, limit: 3, products: currentProducts(0, 3) }),
      currentData({ totalCount: 5, limit: 3, offset: 3, products: currentProducts(3, 2) }),
    ], { links: [{ href: menPath, text: 'We Made Too Much' }], failures: { [`${primaryUrl}?page=2`]: { status: 400 } } });
    assert.deepEqual(repeated.exits, [1]);
    assert.equal(repeated.urls.filter(url => url === `${primaryUrl}?page=2`).length, 1);
    rejected.push(repeated);
    const brokenLogger = await entrypointReplay([currentData()], { failPrimaryLog: true,
      failures: { [primaryUrl]: { status: 400 } } });
    assert.deepEqual(brokenLogger.exits, [1]);
    assert.match(brokenLogger.errors[0], /HTTP 400/);
    assert.equal(brokenLogger.urls.filter(url => url === primaryUrl).length, 1);
    rejected.push(brokenLogger);
    console.log('PRIMARY_SMOKE_NEGATIVE rejected=24 repeatedPrimaryRequests=0 unsafeDestinations=0 rawGuardFallbacks=0 fallbackRetries=0 remoteWrites=0');
  });
  await t.test('phase 3 state: failed attempts preserve prior publication and successful fallback replaces once', () => {
    assert.equal(successes.length, 14);
    assert.equal(rejected.length, 24);
    [...successes, ...rejected].forEach(result => assert.equal(result.closed, true));
    rejected.forEach(result => {
      assert.deepEqual(result.publication, result.prior);
      assert.equal(result.writes.length, 0);
    });
    successes.forEach(result => {
      if (result.writes.length) {
        assert.equal(result.writes.length, 1);
        assert.deepEqual(result.publication, structuredClone(result.writes[0]));
      } else assert.deepEqual(result.publication, result.prior);
    });
    console.log('PRIMARY_SMOKE_STATE successfulControls=14 rejectedPriorSnapshotsUnchanged=24 noPartialMerge=true browserClosedAll=true remoteWrites=0');
  });
});
