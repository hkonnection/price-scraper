/** Offline saved-publication and manual release workflow tests. No real credentials or network. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { clean } from '../src/cleaners/lululemon.js';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'scraper/local/publish-lululemon.mjs');
const workflowFile = path.join(root, '.github/workflows/publish-lululemon.yml');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

/** Create an entirely synthetic deal using the collector's saved field shape. @returns {object} Raw deal. */
function deal() {
  return { product_code: 'synthetic-overlap', product_name: 'Synthetic saved item', brand: 'Lululemon',
    regular_price: 100, sale_price: 75, savings_amount: 25, savings_percent: 25, category: 'Other',
    image_url: 'https://example.invalid/image', product_url: 'https://example.invalid/item',
    valid_from: null, valid_to: null, in_stock: 1, scraped_at: '2026-10-08T12:00:00.000Z' };
}

/** Build isolated CLI files and a module-boundary publisher stub. @returns {object} Paths and cleanup. */
function fixture() {
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.cache/publish-test-'));
  const trace = path.join(dir, 'trace.jsonl');
  const preload = path.join(dir, 'deny-network.mjs');
  const stubSource = `import fs from 'node:fs'; /** Record synthetic publication only. @param {object[]} deals Rows. @param {string} slug Retailer. @param {string|null} flyerDates Flyer dates. @param {string|undefined} capturedAt Optional capture time. @returns {Promise<void>} Stub completion. */ export async function pushToD1(deals, slug, flyerDates, capturedAt) { fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({deals,slug,...(capturedAt === undefined ? {} : {capturedAt})})+'\\n'); if (process.env.STUB_FAIL) throw new Error('synthetic sensitive remote body'); }`;
  fs.writeFileSync(preload, `import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs'; import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
/** Reject outbound I/O. @returns {never} @throws {Error} Always. */
const deny = () => { throw new Error('Network forbidden'); };
globalThis.fetch = deny; net.connect = deny; net.createConnection = deny;
http.request = deny; http.get = deny; https.request = deny; https.get = deny; syncBuiltinESMExports();
registerHooks({ /** Replace only the publisher module and forbid retailer modules. @param {string} url Module URL. @param {object} context Loader context. @param {Function} nextLoad Real loader. @returns {object} Module source. */ load(url, context, nextLoad) {
  if (url.includes('/scrapers/')) throw new Error('Retailer module forbidden');
  if (url.endsWith('/scraper/src/db/d1.js')) return { format: 'module', shortCircuit: true,
    source: ${JSON.stringify(stubSource)} };
  return nextLoad(url, context);
}});
`);
  return { dir, trace, preload, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Write one explicit synthetic JSON input. @param {object} f Fixture. @param {string} name Filename. @param {*} data JSON. @returns {string} File path. */
function input(f, name, data) {
  const file = path.join(f.dir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

/** Run the real production CLI under denied network and a publisher-only stub. @param {object} f Fixture. @param {string[]} args CLI arguments. @param {object} extra Synthetic env. @returns {object} Child result. */
function run(f, args, extra = {}) {
  return spawnSync(process.execPath, ['--import', f.preload, cli, ...args], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: f.dir, ...extra },
  });
}

/** Read stub calls without requiring a trace to exist. @param {object} f Fixture. @returns {object[]} Calls. */
function calls(f) {
  return fs.existsSync(f.trace) ? fs.readFileSync(f.trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

/** Parse the production workflow; tests execute its actual shell text below. @returns {object} Workflow. */
function workflow() { return yaml.load(fs.readFileSync(workflowFile, 'utf8')); }

/** Execute the actual workflow downloader shell with fake gh, never contacting GitHub. @param {object} f Fixture. @param {object} overrides Input env. @returns {object} Result plus gh trace. */
function download(f, overrides = {}) {
  const ghTrace = path.join(f.dir, 'gh.jsonl');
  const bin = path.join(f.dir, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(ghTrace)},JSON.stringify(args)+'\\n');
const dir=args[args.indexOf('--dir')+1], name=args[args.indexOf('--pattern')+1];
fs.writeFileSync(path.join(dir,name),${JSON.stringify(JSON.stringify(clean([deal()]))) });\n`, { mode: 0o755 });
  const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', workflow().jobs.publish.steps.find(s => s.id === 'download').run], {
    encoding: 'utf8', cwd: root, env: { PATH: `${bin}:${process.env.PATH}`, HOME: f.dir,
      RUNNER_TEMP: f.dir, GITHUB_OUTPUT: path.join(f.dir, 'output'), GITHUB_REPOSITORY: 'hkonnection/price-scraper',
      RELEASE_TAG: 'saved-fixtures-v1', ASSET_NAMES: 'women.json\nmen.json\naccessories.json', DRY_RUN: 'true', ...overrides },
  });
  return { ...result, ghCalls: fs.existsSync(ghTrace) ? fs.readFileSync(ghTrace, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('combines raw envelope and cleaned arrays once, preserves overlap and per-file counts', () => {
  const f = fixture();
  try {
    const raw = deal(), cleaned = { ...clean([deal()])[0], colour: 'Synthetic colour' };
    const a = input(f, 'women.json', { deals: [raw], totalProducts: 1, sections: [{ name: 'Women', dealCount: 1 }] });
    const b = input(f, 'men.json', [cleaned]);
    const c = input(f, 'accessories.json', [deal()]);
    const result = run(f, ['--publish', '--', a, b, c]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(f), [{ slug: 'lululemon', deals: [...clean([raw]), cleaned, ...clean([deal()])] }]);
    for (const file of [a, b, c]) assert.ok(result.stdout.includes(`Submitted ${JSON.stringify(file)}: 1`));
    assert.match(result.stdout, /Submitted total: 3/);
    assert.match(result.stdout, /not independently verified persisted section counts/);
  } finally { f.cleanup(); }
});

test('successful saved processing transfers its exact total only after success', () => {
  const f = fixture();
  try {
    const a = input(f, 'first.json', [deal(), deal()]);
    const b = input(f, 'second.json', [deal()]);
    const output = path.join(f.dir, 'submitted-output');
    for (const mode of ['--dry-run', '--publish']) {
      fs.writeFileSync(output, 'existing=kept\n');
      const result = run(f, [mode, '--', a, b], { GITHUB_OUTPUT: output });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(output, 'utf8'), 'existing=kept\nsubmitted_total=3\n');
    }
    for (const args of [ ['--publish', a, input(f, 'bad.json', [])], ['--publish', a] ]) {
      fs.writeFileSync(output, 'existing=kept\n');
      const result = run(f, args, { GITHUB_OUTPUT: output, STUB_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.equal(fs.readFileSync(output, 'utf8'), 'existing=kept\n');
    }
  } finally { f.cleanup(); }
});

test('dry-run and default mode use real cleaner but require no credentials or network', () => {
  const f = fixture();
  try {
    const a = input(f, 'raw.json', [deal()]);
    for (const args of [[a], ['--dry-run', '--', a]]) {
      const result = run(f, args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Dry run.*no D1 call/i);
      assert.equal(calls(f).length, 0);
    }
  } finally { f.cleanup(); }
});

test('rejects all invalid input before publication, including a bad later file', () => {
  const f = fixture();
  try {
    const good = input(f, 'good.json', clean([deal()]));
    const cases = [[], null, {}, { deals: [deal()] }, { deals: [], totalProducts: 0, sections: [] }, [null], [42],
      [deal(), { ...deal(), sale_price: '75' }], [{ ...deal(), product_name: null }], [{ ...deal(), category: [] }],
      [{ ...deal(), savings_percent: '0); DELETE FROM deals; --' }], [{ ...deal(), in_stock: '1); --' }],
      [{ ...deal(), valid_to: "2026-01-01'); DELETE FROM deals; --" }], [{ ...deal(), scraped_at: 'not a date' }],
      [{ ...deal(), image_url: {} }], [{ ...deal(), sale_price: 100 }], [{ ...deal(), regular_price: -1 }],
      [{ ...deal(), scraped_at: '2026-02-30' }], [{ ...deal(), sale_price: 0 }], [true], [[]],
      { deals: [deal()], totalProducts: 1, sections: [null] }];
    for (const [index, data] of cases.entries()) {
      const bad = input(f, `bad-${index}.json`, data);
      const result = run(f, ['--publish', '--', good, bad]);
      assert.equal(result.status, 1, JSON.stringify(data));
      assert.match(result.stderr, /empty|invalid|expected/i);
      assert.ok(result.stderr.includes(path.basename(bad)));
      assert.equal(calls(f).length, 0);
    }
    const malformed = path.join(f.dir, 'malformed.json'); fs.writeFileSync(malformed, '{private row content');
    const unreadable = input(f, 'unreadable.json', [deal()]); fs.chmodSync(unreadable, 0o000);
    for (const file of [malformed, path.join(f.dir, 'missing.json'), f.dir, unreadable]) {
      const result = run(f, ['--publish', good, file]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /read|JSON/i);
      assert.doesNotMatch(result.stderr, /private row content/);
      assert.equal(calls(f).length, 0);
    }
  } finally { f.cleanup(); }
});

test('CLI rejects absent files, unknown/conflicting flags and duplicate resolved inputs', () => {
  const f = fixture();
  try {
    const a = input(f, 'one.json', [deal()]);
    const alias = path.join(f.dir, 'alias.json'); fs.symlinkSync(a, alias);
    for (const args of [[], ['--publish'], ['--bogus', a], ['--publish', '--dry-run', a], [a, path.join(f.dir, '.', 'one.json')], ['--publish', a, alias]]) {
      const result = run(f, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^Error: .*file|^Error: .*argument|^Error: .*mode|^Error: .*duplicate/im);
      assert.equal(calls(f).length, 0);
    }
  } finally { f.cleanup(); }
});

test('publisher failure returns nonzero without exposing remote body or claiming rollback', () => {
  const f = fixture();
  try {
    const result = run(f, ['--publish', input(f, 'one.json', [deal()])], { STUB_FAIL: '1' });
    assert.equal(result.status, 1);
    assert.equal(calls(f).length, 1);
    assert.doesNotMatch(result.stderr, /synthetic sensitive remote body/);
    assert.match(result.stderr, /publication.*failed|publication.*error/i);
    assert.match(result.stderr, /may already|may have/i);
  } finally { f.cleanup(); }
});

test('workflow is manual only, dry by default, scoped read token and exact secret mapping', () => {
  const w = workflow();
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch']);
  assert.equal(w.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(w.permissions, { contents: 'read' });
  const steps = w.jobs.publish.steps;
  const dl = steps.find(s => s.id === 'download');
  assert.equal(dl.env.GH_TOKEN, '${{ github.token }}');
  const pub = steps.find(s => s.name === 'Validate and publish saved deals');
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_D1_DATABASE_ID']) {
    assert.equal(pub.env[key], '${{ secrets.' + key + ' }}');
    assert.equal(dl.env[key], undefined);
  }
  for (const step of steps.filter(s => s.run)) {
    assert.doesNotMatch(step.run, /\$\{\{/);
    assert.doesNotMatch(step.run, /scrape:lululemon|lululemon-index|tar |unzip |eval |curl /);
  }
});

test('workflow downloads only three exact same-repository assets with separate arguments', () => {
  const f = fixture();
  try {
    const result = download(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.ghCalls.length, 3);
    for (const [index, args] of result.ghCalls.entries()) {
      assert.deepEqual(args.slice(0, 7), ['release', 'download', 'saved-fixtures-v1', '--repo', 'hkonnection/price-scraper', '--pattern', ['women.json', 'men.json', 'accessories.json'][index]]);
    }
  } finally { f.cleanup(); }
});

test('workflow publisher shell consumes exact downloaded files, capture input and explicit dry_run mode', () => {
  for (const dry of ['true', 'false']) for (const capturedAt of ['', '2026-10-10T14:17:00.000Z', '$(touch PWNED)', "2026-10-10T14:17:00.000Z';touch PWNED", '2026-10-10T14:17:00.000Z\n--publish']) {
    const f = fixture();
    try {
      const downloaded = download(f, { DRY_RUN: dry });
      assert.equal(downloaded.status, 0, downloaded.stderr);
      const directory = fs.readFileSync(path.join(f.dir, 'output'), 'utf8').trim().slice('directory='.length);
      const bin = path.join(f.dir, 'bin');
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(f.preload)} "$@"\n`, { mode: 0o755 });
      const pub = workflow().jobs.publish.steps.find(s => s.name === 'Validate and publish saved deals');
      const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', pub.run], {
        cwd: root, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: f.dir,
          DIRECTORY: directory, ASSET_NAMES: 'women.json\nmen.json\naccessories.json', DRY_RUN: dry, CAPTURED_AT: capturedAt },
      });
      if (capturedAt && capturedAt !== '2026-10-10T14:17:00.000Z') {
        assert.equal(result.status, 1); assert.match(result.stderr, /captured_at/);
        assert.equal(calls(f).length, 0);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Submitted total: 3/);
        assert.equal(calls(f).length, dry === 'true' ? 0 : 1);
        if (dry === 'false') assert.deepEqual(calls(f), [{ slug: 'lululemon', deals: clean([deal(), deal(), deal()]), ...(capturedAt ? { capturedAt } : {}) }]);
      }
      assert.equal(fs.existsSync(path.join(root, 'PWNED')), false);
    } finally { f.cleanup(); }
  }
});

test('workflow refuses injection, patterns, paths, duplicates and invalid mode before gh', () => {
  const attacks = [ { RELEASE_TAG: '--repo=evil/other' }, { RELEASE_TAG: 'tag; touch PWNED' },
    { RELEASE_TAG: '$(touch PWNED)' }, { ASSET_NAMES: '*.json' }, { ASSET_NAMES: '../women.json' },
    { ASSET_NAMES: 'https://evil.invalid/women.json' }, { ASSET_NAMES: 'women.json\nmen.json;touch PWNED' },
    { ASSET_NAMES: '' }, { ASSET_NAMES: 'women.json\nwomen.json' }, { ASSET_NAMES: '--women.json' },
    { ASSET_NAMES: 'women.json\n' }, { DRY_RUN: 'false;touch PWNED' } ];
  for (const attack of attacks) {
    const f = fixture();
    try {
      const result = download(f, attack);
      assert.notEqual(result.status, 0, JSON.stringify(attack));
      assert.match(result.stderr, /Invalid|Duplicate/);
      assert.equal(result.ghCalls.length, 0);
      assert.equal(fs.existsSync(path.join(root, 'PWNED')), false);
    } finally { f.cleanup(); }
  }
});

/** Create the actual writer and UI against synthetic SQLite only. @param {RegExp|null} failOn Rejected SQL. @returns {Promise<object>} Isolated state. */
async function capturedState(failOn = null) {
  const { fixture: readFixture } = require('../../apps/web/tests/fixtures.cjs');
  const { appLoader } = require('../../apps/web/tests/load-app.cjs');
  const state = readFixture();
  state.db.exec(`INSERT INTO retailers(id,name,slug,scrape_source) VALUES(30,'Lululemon','lululemon','direct');
    INSERT INTO scrape_sources(id,retailer_id,name,slug) VALUES(30,30,'Synthetic Lululemon','lululemon');
    INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,deals_count) VALUES
    (301,30,'completed','2026-10-10T14:30:00.000Z','2026-10-10T14:36:05.000Z',1);
    INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,category)
    VALUES(30,301,'Synthetic previous',100,75,25,25,'2026-10-10T14:17:00.000Z','Other');`);
  const sqlCalls = [];
  const context = vm.createContext({ console: { log() {} }, process: { env: {
    CLOUDFLARE_ACCOUNT_ID: 'synthetic', CLOUDFLARE_API_TOKEN: 'synthetic', CLOUDFLARE_D1_DATABASE_ID: 'synthetic',
  } }, fetch: async (_url, options) => {
    const { sql } = JSON.parse(options.body); sqlCalls.push(sql);
    if (failOn?.test(sql)) return Response.json({ success: false, errors: [{ message: 'Synthetic failure' }] });
    if (/^\s*SELECT/i.test(sql)) return Response.json({ success: true, result: [{ results: state.db.prepare(sql).all() }] });
    state.db.exec(sql); return Response.json({ success: true, result: [{}] });
  } });
  const module = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'scraper/src/db/d1.js'), 'utf8'), { context });
  await module.link(() => { throw Error('Unexpected import'); }); await module.evaluate();
  return { ...state, sqlCalls, push: module.namespace.pushToD1, page: appLoader({ db: state.facade, retailer: 'lululemon' })('page.tsx') };
}

test('capture CLI forwards exact override once and defaults preserve the ordinary call', () => {
  const f = fixture();
  try {
    const files = ['women', 'men', 'accessories'].map(name => input(f, `${name}.json`, [{ ...deal(), scraped_at: '2026-10-10T14:17:00.000Z' }]));
    for (const capturedAt of ['2026-10-10T14:17:00.000Z', '2026-10-10T14:17:00Z', '', undefined]) {
      const flags = capturedAt === undefined ? [] : ['--captured-at', capturedAt];
      const result = run(f, ['--publish', ...flags, '--', ...files]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(calls(f).at(-1), { slug: 'lululemon', deals: clean(files.map(() => ({ ...deal(), scraped_at: '2026-10-10T14:17:00.000Z' }))), ...(capturedAt ? { capturedAt: '2026-10-10T14:17:00.000Z' } : {}) });
    }
    assert.equal(calls(f).length, 4);
    const dateOnly = input(f, 'default-date-only.json', [{ ...deal(), scraped_at: '2026-10-10' }]);
    assert.equal(run(f, ['--publish', '--captured-at', '', '--', dateOnly]).status, 0);
    assert.equal(calls(f).at(-1).capturedAt, undefined);
  } finally { f.cleanup(); }
});

test('capture validation rejects malformed, future, latest-row and invalid bounds before any publisher call', () => {
  const f = fixture();
  try {
    const a = input(f, 'first.json', [{ ...deal(), scraped_at: '2026-10-10T14:16:00.000Z' }]);
    const b = input(f, 'last.json', [{ ...deal(), scraped_at: '2026-10-10T14:17:00.000Z' }]);
    for (const value of ['tomorrow', '2026-10-10', '2026-10-10T07:17:00-07:00', '2026-02-30T14:17:00.000Z', '2026-10-10T24:00:00.000Z', '2026-10-10T14:17:60.000Z', '2026-10-10T14:17:00.00Z', '2026-10-10T14:17:00.000z', ' 2026-10-10T14:17:00.000Z', '2999-01-01T00:00:00.000Z', '2026-10-10T14:16:59.999Z', "');DELETE FROM deals;--"]) {
      const result = run(f, ['--publish', '--captured-at', value, '--', a, b]);
      assert.equal(result.status, 1, value); assert.match(result.stderr, /captured_at/);
      assert.equal(calls(f).length, 0);
    }
    for (const scraped_at of [undefined, null, 42, 'bad', '2026-10-10', '2026-02-30T14:17:00.000Z', '2026-10-10T24:00:00.000Z', '2026-10-10T14:17:00+00:00', '2999-01-01T00:00:00.000Z']) {
      const later = input(f, 'invalid-bounds.json', [{ ...deal(), scraped_at }]);
      const result = run(f, ['--publish', '--captured-at', '2026-10-10T14:17:00.000Z', '--', a, b, later]);
      assert.equal(result.status, 1, String(scraped_at)); assert.match(result.stderr, /scraped_at|captured_at/);
      assert.equal(calls(f).length, 0);
    }
    for (const flags of [['--captured-at'], ['--captured-at', '--publish', a], ['--captured-at', '', '--captured-at', '', a]]) {
      assert.equal(run(f, flags).status, 1); assert.equal(calls(f).length, 0);
    }
  } finally { f.cleanup(); }
});

test('workflow declares an optional empty captured_at string via environment, not interpolation', () => {
  const w = workflow();
  assert.deepEqual(w.on.workflow_dispatch.inputs.captured_at, { description: 'Optional capture time in UTC ISO format (YYYY-MM-DDTHH:mm:ss[.SSS]Z); blank uses publication time', required: false, type: 'string', default: '' });
  assert.equal(w.jobs.publish.steps.find(s => s.id === 'submit').env.CAPTURED_AT, '${{ inputs.captured_at }}');
  assert.equal(w.jobs.publish.steps.at(-1).run, 'node scraper/local/verify-lululemon-count.mjs');
});

test('actual writer stores capture history; actual view selects it over later prior wall time', async () => {
  const { db, push, page } = await capturedState();
  try {
    await push(clean([{ ...deal(), scraped_at: '2026-10-10T14:17:00.000Z' }]), 'lululemon', null, '2026-10-10T14:17:00.000Z');
    const history = db.prepare('SELECT * FROM scrape_history ORDER BY id DESC LIMIT 1').get();
    assert.equal(history.started_at, '2026-10-10T14:17:00.000Z'); assert.equal(history.completed_at, history.started_at);
    assert.equal(history.status, 'completed'); assert.equal(history.deals_count, 1);
    const result = await page.getData('lululemon');
    assert.equal(result.retailerDates.lululemon, history.completed_at); assert.equal(result.total, 1);
    const { renderToStaticMarkup } = require('react-dom/server');
    const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ retailer: 'lululemon' }) }));
    assert.match(html, /Last updated: Oct 10, 2026, 7:17:00 AM PCT/);
    assert.doesNotMatch(html, /7:36:05/);
  } finally { db.close(); }
});

test('Lululemon selector retains completed guards, explicit pins and cleanup paging resets; other retailers unchanged', async () => {
  const { db, page } = await capturedState();
  try {
    db.exec(`INSERT INTO scrape_history(id,source_id,status,started_at,completed_at) VALUES
      (302,30,'completed','2026-10-10T14:17:00.000Z','2026-10-10T14:17:00.000Z'),
      (303,30,'running','2026-10-11',NULL),(304,30,'failed','2026-10-11','2026-10-11'),
      (305,14,'completed','2026-09-01','2026-09-01');
      INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,category)
      VALUES(30,302,'Synthetic captured',100,75,25,25,'2026-10-10T14:17:00.000Z','Other');`);
    const latest = await page.getData('lululemon');
    assert.equal(latest.publication, '[[30,302]]'); assert.equal(latest.total, 1);
    const pinned = await page.getData('lululemon', { publication: '[[30,301]]' });
    assert.equal(pinned.publication, '[[30,301]]'); assert.equal(pinned.total, 1);
    db.exec('DELETE FROM deals WHERE retailer_id=30 AND scrape_id=301');
    const reset = await page.getData('lululemon', { publication: '[[30,301]]', offset: '500' });
    assert.equal(reset.publication, '[[30,302]]'); assert.equal(reset.publicationReset, true); assert.equal(reset.offset, 0); assert.equal(reset.total, 1);
    for (const pin of [303,304,305]) {
      const invalid = await page.getData('lululemon', { publication: `[[30,${pin}]]` });
      assert.equal(invalid.publication, '[[30,302]]'); assert.equal(invalid.publicationReset, true);
    }
    const other = await page.getData('sportchek'); assert.equal(other.publication, '[[14,101]]');
    const all = await page.getData('all'); assert.ok(all.deals.some(row => row.retailer_slug === 'lululemon' && row.scrape_id === 302));
    db.exec("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at) VALUES(306,30,'completed','2026-10-12','2026-10-12')");
    assert.equal((await page.getData('lululemon')).publication, '[[30,306]]', 'Ordinary later history supersedes captured history');
  } finally { db.close(); }
});

test('shared writer absent override retains wall times and invalid overrides refuse before SQL', async () => {
  const { db, push, sqlCalls } = await capturedState();
  try {
    for (const capturedAt of ['bad', '', "2026-10-10T14:17:00.000Z';DELETE FROM deals;--", '2026-02-30T00:00:00.000Z', '2999-01-01T00:00:00.000Z']) {
      await assert.rejects(push(clean([deal()]), 'lululemon', null, capturedAt), /captured_at/); assert.equal(sqlCalls.length, 0);
    }
    for (const scraped_at of [null, 'bad', '2026-10-10', '2026-10-10T24:00:00.000Z', '2026-10-10T14:17:00.001Z']) {
      await assert.rejects(push(clean([deal(), { ...deal(), scraped_at }]), 'lululemon', null, '2026-10-10T14:17:00.000Z'), /captured_at/); assert.equal(sqlCalls.length, 0);
    }
    for (const args of [[], [null], [undefined]]) {
      const before = Date.now(); await push(clean([{ ...deal(), scraped_at: '2026-10-10' }]), 'sportchek', null, ...args); const after = Date.now();
      const history = db.prepare('SELECT * FROM scrape_history ORDER BY id DESC LIMIT 1').get();
      for (const timestamp of [history.started_at, history.completed_at]) assert.ok(Date.parse(timestamp) >= before && Date.parse(timestamp) <= after);
      assert.equal(history.status, 'completed');
    }
  } finally { db.close(); }
});

test('capture writer failures preserve previous publication and completed-only selection', async () => {
  for (const failOn of [/INSERT INTO deals/, /status = 'completed'/, /DELETE FROM deals/]) {
    const { db, push, page } = await capturedState(failOn);
    try {
      await assert.rejects(push(clean([deal()]), 'lululemon', null, '2026-10-10T14:17:00.000Z'), /Synthetic failure/);
      const history = db.prepare('SELECT * FROM scrape_history ORDER BY id DESC LIMIT 1').get();
      const completed = /DELETE/.test(failOn.source);
      assert.equal(history.status, completed ? 'completed' : 'failed');
      assert.equal(history.started_at, '2026-10-10T14:17:00.000Z'); assert.equal(history.completed_at, history.started_at);
      assert.equal((await page.getData('lululemon')).publication, completed ? `[[30,${history.id}]]` : '[[30,301]]');
    } finally { db.close(); }
  }
});

test('ordered capture smoke: actual CLI happy, rejected bounds, 921-row state and rendered time', async () => {
  const f = fixture();
  const { db, push, page } = await capturedState();
  try {
    const capturedAt = '2026-10-10T14:17:00.000Z';
    const files = ['women', 'men', 'accessories'].map((name, section) => {
      const rows = Array.from({ length: 307 }, (_, index) => ({ ...deal(), product_code: `synthetic-${section}-${index}`, scraped_at: capturedAt }));
      return input(f, `${name}.json`, section === 0 ? { deals: rows, totalProducts: rows.length, sections: [{ name, dealCount: rows.length }] } : clean(rows));
    });
    const before = files.map(file => fs.readFileSync(file));
    const happy = run(f, ['--publish', '--captured-at', capturedAt, '--', ...files]);
    assert.equal(happy.status, 0, happy.stderr); assert.match(happy.stdout, /Submitted total: 921/); assert.equal(calls(f).length, 1);
    const submitted = calls(f)[0]; await push(submitted.deals, submitted.slug, null, submitted.capturedAt);
    const history = db.prepare('SELECT * FROM scrape_history ORDER BY id DESC LIMIT 1').get();
    assert.equal(history.started_at, capturedAt); assert.equal(history.completed_at, capturedAt); assert.equal(history.status, 'completed');
    console.log('CAPTURE_SMOKE_HAPPY actualCLI=true files=3 submitted=921 publisherCalls=1 actualWriterSQLite=true started_at=2026-10-10T14:17:00.000Z completed_at=2026-10-10T14:17:00.000Z');

    for (const scraped_at of [null, '2026-10-10T14:17:00.001Z', '2026-10-10T24:00:00.000Z']) {
      const invalid = input(f, 'last-invalid.json', [{ ...deal(), scraped_at }]);
      const negative = run(f, ['--publish', '--captured-at', capturedAt, '--', ...files, invalid]);
      assert.equal(negative.status, 1); assert.match(negative.stderr, /scraped_at|captured_at/); assert.equal(calls(f).length, 1);
    }
    const empty = run(f, ['--dry-run', '--captured-at', '', '--', ...files]);
    assert.equal(empty.status, 0, empty.stderr); assert.match(empty.stdout, /Submitted total: 921/); assert.equal(calls(f).length, 1);
    const future = run(f, ['--publish', '--captured-at', '2999-01-01T00:00:00.000Z', '--', ...files]);
    assert.equal(future.status, 1); assert.match(future.stderr, /future/); assert.equal(calls(f).length, 1);
    console.log('CAPTURE_SMOKE_NEGATIVE missingBounds=refused laterRow1ms=refused impossibleRow=refused future=refused emptyOptional=defaultDryRun callsAdded=0 errorsUsable=true');

    const count = db.prepare('SELECT COUNT(*) AS count, COUNT(DISTINCT product_code) AS uniqueCount FROM deals WHERE retailer_id=30').get();
    assert.equal(count.count, 921); assert.equal(count.uniqueCount, 921); assert.equal(history.deals_count, 921);
    const first = await page.getData('lululemon'); const next = await page.getData('lululemon', { publication: first.publication, offset: '500' });
    assert.equal(first.total, 921); assert.equal(first.deals.length, 500); assert.equal(next.deals.length, 421);
    assert.equal(first.retailerDates.lululemon, capturedAt); assert.equal(next.retailerDates.lululemon, capturedAt);
    assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
    const { renderToStaticMarkup } = require('react-dom/server');
    const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ retailer: 'lululemon' }) }));
    assert.match(html, /Last updated: Oct 10, 2026, 7:17:00 AM PCT/); assert.doesNotMatch(html, /7:36:05/);
    console.log('CAPTURE_SMOKE_STATE persistedSynthetic=921 uniqueSynthetic=921 firstPage=500 secondPage=421 inputsByteIdentical=true olderWallTimeNotSelected=true Last updated: Oct 10, 2026, 7:17:00 AM PCT remoteWrites=0');
  } finally { f.cleanup(); db.close(); }
});

test('ordered actual CLI smoke: happy, negative and final state', () => {
  const f = fixture();
  try {
    const a = input(f, 'raw women.json', { deals: [deal()], totalProducts: 1, sections: [{ name: 'Women', dealCount: 1 }] });
    const b = input(f, 'cleaned-men.json', clean([{ ...deal(), colour: 'Synthetic' }]));
    const before = [a,b].map(file => fs.readFileSync(file));
    const happy = run(f, ['--publish', '--', a, b]);
    assert.equal(happy.status, 0, happy.stderr);
    assert.equal(calls(f).length, 1);
    assert.match(happy.stdout, /Submitted total: 2/);
    console.log('SAVED_SMOKE_HAPPY actualCLI=true rawAndCleanedFiles=2 submittedTotal=2 publisherCalls=1 retailerAccess=0');
    const bad = input(f, '$(touch PWNED).json', [{ ...deal(), sale_price: null }]);
    const negative = run(f, ['--publish', '--', a, bad]);
    assert.equal(negative.status, 1); assert.match(negative.stderr, /sale_price/);
    const harder = run(f, ['--publish', '--', b, input(f, 'date-injection.json', [{ ...deal(), valid_from: "');DELETE FROM deals;--" }])]);
    assert.equal(harder.status, 1); assert.match(harder.stderr, /valid_from/);
    assert.equal(calls(f).length, 1);
    assert.equal(fs.existsSync(path.join(root, 'PWNED')), false);
    console.log('SAVED_SMOKE_NEGATIVE badLaterFile=1 dateInjection=1 callsAdded=0 shellExecution=0 errorsUsable=true');
    const literal = input(f, '$(touch PWNED)-valid.json', clean([deal()]));
    const dryLiteral = run(f, ['--dry-run', '--', literal]); assert.equal(dryLiteral.status, 0, dryLiteral.stderr);
    assert.equal(fs.existsSync(path.join(root, 'PWNED')), false);
    const dry = run(f, ['--dry-run', '--', a, b]); assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(calls(f), [{ slug: 'lululemon', deals: [...clean([deal()]), ...clean([{ ...deal(), colour: 'Synthetic' }])] }]);
    assert.deepEqual([a,b].map(file => fs.readFileSync(file)), before);
    console.log('SAVED_SMOKE_STATE inputsByteIdentical=true combinedStubArrayExact=true dryRunCallsAdded=0 remoteWrites=0');
  } finally { f.cleanup(); }
});
