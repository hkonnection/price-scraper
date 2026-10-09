/** Offline saved-publication and manual release workflow tests. No real credentials or network. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
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
  const stubSource = `import fs from 'node:fs'; /** Record synthetic publication only. @param {object[]} deals Rows. @param {string} slug Retailer. @returns {Promise<void>} Stub completion. */ export async function pushToD1(deals, slug) { fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({deals,slug})+'\\n'); if (process.env.STUB_FAIL) throw new Error('synthetic sensitive remote body'); }`;
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

test('workflow publisher shell consumes exact downloaded files and explicit dry_run mode', () => {
  for (const dry of ['true', 'false']) {
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
          DIRECTORY: directory, ASSET_NAMES: 'women.json\nmen.json\naccessories.json', DRY_RUN: dry },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Submitted total: 3/);
      assert.equal(calls(f).length, dry === 'true' ? 0 : 1);
      if (dry === 'false') assert.deepEqual(calls(f), [{ slug: 'lululemon', deals: clean([deal(), deal(), deal()]) }]);
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
