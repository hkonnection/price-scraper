/**
 * Update-chain regressions using actual SQL on isolated, in-memory SQLite.
 * Requires Node 22.13+ for node:sqlite; production scrapers remain Node 20 compatible.
 * Run with: node --experimental-vm-modules --test scraper/src/scrapers/*.test.js scraper/src/update-visibility.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

/**
 * Creates the local D1 read facade and synthetic publication state.
 * @returns {object} Database, query recorder and D1-compatible facade.
 */
async function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(await fs.readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO retailers (id,name,slug,is_active) VALUES (14,'Sport Chek','sportchek',1),(15,'Disabled','disabled',0);
    INSERT INTO scrape_sources (id,retailer_id,name,slug) VALUES (14,14,'test','test'),(15,15,'disabled','disabled');
    INSERT INTO scrape_history (id,source_id,status,started_at,completed_at) VALUES
      (400,14,'completed','2026-10-07T21:00:00Z','2026-10-07T21:40:46.000Z'),
      (401,14,'completed','2026-10-07T21:01:00Z','2026-10-07T21:40:46.000Z'),
      (402,14,'completed','2026-10-07T21:02:00Z','2026-10-07T21:40:46.000Z'),
      (403,14,'running','2026-10-07T22:00:00Z',NULL),
      (404,14,'failed','2026-10-07T23:00:00Z','2026-10-07T23:01:00Z');`);
  const insert = db.prepare(`INSERT INTO deals (retailer_id,scrape_id,product_code,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,in_stock,valid_to)
    VALUES (?,?,?,?,100,75,25,25,'2026-10-07T21:40:00Z',?,?)`);
  for (const id of [400,401,402,403,404]) insert.run(14,id,'same','Synthetic publication '+id,1,null);
  insert.run(14,null,'legacy','Synthetic legacy',1,null);
  insert.run(14,402,'soldout','Synthetic unavailable',0,null);
  insert.run(14,402,'expired','Synthetic expired',1,'2000-01-01');
  insert.run(15,null,'hidden','Synthetic disabled',1,null);
  const queries = [];
  const facade = {
    /** Execute the website's read-only batch in one isolated transaction. */
    async batch(statements) {
      db.exec('BEGIN');
      try { return await Promise.all(statements.map(statement => statement.all())); }
      finally { db.exec('ROLLBACK'); }
    },
    prepare(sql) {
    assert.match(sql.trim(), /^SELECT/i, 'Website must never persist');
    queries.push(sql);
    let params = [];
    return { bind(...args) { params = args; return this; }, async all() { return { results: db.prepare(sql).all(...params) }; }, async first() { return db.prepare(sql).get(...params) || null; } };
  } };
  return { db, facade, queries };
}

/**
 * Loads the actual page data function with only Cloudflare's binding stubbed.
 * @param {object} facade - Isolated database facade.
 * @returns {Promise<Function>} Actual getData function.
 */
async function pageData(facade) {
  const source = await fs.readFile(new URL('../../apps/web/src/app/page.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source + '\nexport { getData };', { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, console, require(name) {
    if (name === '@cloudflare/next-on-pages') return { getRequestContext: () => ({ env: { DB: facade } }) };
    if (name === 'react/jsx-runtime') return { jsx() {} };
    return {};
  } });
  return exports.getData;
}

/**
 * Loads the real D1 writer with an isolated SQLite-backed HTTP boundary.
 * @param {DatabaseSync} db - Local database only.
 * @param {RegExp|null} failOn - SQL boundary to reject before execution.
 * @returns {Promise<object>} Actual writer and persistence call recorder.
 */
async function writer(db, failOn = null) {
  const calls = [];
  const context = vm.createContext({ console: { log() {} }, process: { env: {
    CLOUDFLARE_ACCOUNT_ID: 'synthetic', CLOUDFLARE_API_TOKEN: 'synthetic', CLOUDFLARE_D1_DATABASE_ID: 'synthetic',
  } }, fetch: async (_url, options) => {
    const { sql } = JSON.parse(options.body);
    calls.push(sql);
    if (failOn?.test(sql)) return Response.json({ success: false, errors: [{ message: 'Synthetic persistence failure' }] });
    if (/^\s*SELECT/i.test(sql)) return Response.json({ success: true, result: [{ results: db.prepare(sql).all() }] });
    db.exec(sql);
    return Response.json({ success: true, result: [{}] });
  } });
  const source = await fs.readFile(new URL('./db/d1.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => { throw new Error('Unexpected import'); });
  await module.evaluate();
  return { push: module.namespace.pushToD1, calls };
}

/**
 * Creates one synthetic publishable row for isolated writer tests.
 * @returns {object} Normalized deal in the actual database schema.
 */
function syntheticDeal() {
  return { product_code: 'new', product_name: 'Synthetic new publication', regular_price: 100, sale_price: 75, savings_amount: 25, savings_percent: 25, category: 'Other', scraped_at: '2026-10-07T23:30:00Z', in_stock: 1 };
}

test('failed deal insertion keeps the last completed rows instead of deleting them', async () => {
  const { db, facade } = await database();
  try {
    const previous = db.prepare('SELECT COUNT(*) AS count FROM deals WHERE retailer_id=14').get().count;
    const { push } = await writer(db, /INSERT INTO deals/);
    await assert.rejects(push([syntheticDeal()], 'sportchek'), /Synthetic persistence failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deals WHERE retailer_id=14').get().count, previous);
    assert.equal(db.prepare('SELECT status FROM scrape_history ORDER BY id DESC LIMIT 1').get().status, 'failed');
    const result = await (await pageData(facade))('sportchek');
    assert.equal(result.deals.length, 2);
  } finally { db.close(); }
});

test('empty replacement is rejected before any persistence call', async () => {
  const { db } = await database();
  try {
    const { push, calls } = await writer(db);
    await assert.rejects(push([], 'sportchek'), /empty/i);
    assert.equal(calls.length, 0);
  } finally { db.close(); }
});

test('completion update failure retains old rows and hides staged replacement', async () => {
  const { db, facade } = await database();
  try {
    const { push } = await writer(db, /status = 'completed'/);
    await assert.rejects(push([syntheticDeal()], 'sportchek'), /Synthetic persistence failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deals WHERE product_code=\'new\'').get().count, 1);
    const result = await (await pageData(facade))('sportchek');
    assert.deepEqual(result.deals.map(d => d.product_name).sort(), ['Synthetic legacy','Synthetic publication 402']);
    assert.equal(db.prepare('SELECT status FROM scrape_history ORDER BY id DESC LIMIT 1').get().status, 'failed');
  } finally { db.close(); }
});

test('successful replacement becomes visible and removes only older retailer rows', async () => {
  const { db, facade } = await database();
  try {
    const { push } = await writer(db);
    await push([syntheticDeal()], 'sportchek');
    const result = await (await pageData(facade))('sportchek');
    assert.deepEqual(result.deals.map(d => d.product_name), ['Synthetic new publication']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deals WHERE retailer_id=14').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deals WHERE retailer_id=15').get().count, 1);
  } finally { db.close(); }
});

test('cleanup failure does not mark an already published complete snapshot failed', async () => {
  const { db } = await database();
  try {
    const { push } = await writer(db, /DELETE FROM deals/);
    await assert.rejects(push([syntheticDeal()], 'sportchek'), /Synthetic persistence failure/);
    const latest = db.prepare('SELECT id,status,deals_count FROM scrape_history ORDER BY id DESC LIMIT 1').get();
    assert.equal(latest.status, 'completed');
    assert.equal(latest.deals_count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deals WHERE scrape_id=?').get(latest.id).count, 1);
  } finally { db.close(); }
});

test('snapshot selection never accepts another retailer\'s completed history id', async () => {
  const { db, facade } = await database();
  try {
    db.exec("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at) VALUES (1,1,'completed','2026-10-07','2026-10-07T22:00:00Z')");
    db.exec("INSERT INTO deals(retailer_id,scrape_id,product_code,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at) VALUES (14,1,'mislinked','Synthetic mismatched snapshot',100,75,25,25,'2026-10-07')");
    const getData = await pageData(facade);
    for (const slug of ['sportchek','all']) {
      assert.equal((await getData(slug)).deals.some(d=>d.product_code==='mislinked'), false);
    }
  } finally { db.close(); }
});

test('completed history selection transfers at most one row per active retailer', async () => {
  const { db, facade, queries } = await database();
  try {
    for (let i=500; i<10500; i++) db.prepare("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at) VALUES (?,14,'completed','2000-01-01','2000-01-01')").run(i);
    await (await pageData(facade))('sportchek');
    for (const sql of queries.filter(sql => sql.includes('scrape_history') && !sql.includes('flyer_dates'))) {
      assert.match(sql, /LIMIT 1/i, 'Do not transfer an unbounded scrape history into the Worker');
      const plan = db.prepare('EXPLAIN QUERY PLAN '+sql).all(14).map(row=>row.detail).join('\n');
      assert.match(plan, /SEARCH.*idx_scrape_history_source/, 'Constrain history by source so the existing index can serve the lookup');
      assert.doesNotMatch(plan, /SCAN sh/);
    }
  } finally { db.close(); }
});

test('selected and all-store website reads expose only latest completed snapshot plus legacy rows', async () => {
  const { db, facade } = await database();
  try {
    const getData = await pageData(facade);
    for (const slug of ['sportchek','all']) {
      const result = await getData(slug);
      assert.deepEqual(result.deals.map(d => d.product_name).sort(), ['Synthetic legacy','Synthetic publication 402']);
      assert.equal(result.retailerDates.sportchek, '2026-10-07T21:40:46.000Z');
    }
  } finally { db.close(); }
});

test('newest completion wins over largest id and unknown retailer remains empty', async () => {
  const { db, facade } = await database();
  try {
    db.exec("UPDATE scrape_history SET completed_at='2026-10-07T21:50:00Z' WHERE id=400");
    const getData = await pageData(facade);
    const result = await getData('sportchek');
    assert.deepEqual(result.deals.map(d => d.product_name).sort(), ['Synthetic legacy','Synthetic publication 400']);
    assert.equal(result.retailerDates.sportchek, '2026-10-07T21:50:00Z');
    assert.equal((await getData("' OR 1=1 --")).deals.length, 0);
    assert.equal((await getData('disabled')).deals.length, 0);
  } finally { db.close(); }
});

test('Sport Chek workflow serializes publications without cancelling an active run', async () => {
  const yaml = await fs.readFile(new URL('../../.github/workflows/scrape-sportchek.yml', import.meta.url), 'utf8');
  assert.match(yaml, /concurrency:\s*\n\s+group: scrape-sportchek\s*\n\s+cancel-in-progress: false/);
});

test('empty cleaned Lululemon result fails before persistence in both modes', async () => {
  const source = await fs.readFile(new URL('./lululemon-index.js', import.meta.url), 'utf8');
  for (const dry of [false,true]) {
    const exits = [], writes = [];
    const context = vm.createContext({ console: { log() {}, error() {} }, process: { argv: dry ? ['node','script','--dry-run'] : ['node','script'], exit: code => exits.push(code) } });
    const module = new vm.SourceTextModule(source.replace(/main\(\);\s*$/, 'await main();'), { context });
    await module.link(spec => {
      const names = spec.includes('/scrapers/') ? ['scrapeLululemon'] : spec.includes('/db/') ? ['pushToD1'] : ['getCleaner'];
      return new vm.SyntheticModule(names, function () {
        const value = names[0] === 'scrapeLululemon' ? async () => ({ deals: [], totalProducts: 0, sections: [] }) : names[0] === 'pushToD1' ? async (...args) => writes.push(args) : async () => ({ clean: rows => rows });
        this.setExport(names[0], value);
      }, { context });
    });
    await module.evaluate();
    assert.deepEqual(exits, [1], 'Zero-result run must be red');
    assert.equal(writes.length, 0);
  }
});
