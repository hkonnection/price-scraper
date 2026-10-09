/** Offline read-only count and workflow-shell regressions; synthetic secrets only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '../..');
const yaml = createRequire(import.meta.url)('js-yaml');
const fixedSQL = "SELECT COUNT(*) AS persisted_count FROM deals d JOIN retailers r ON d.retailer_id = r.id WHERE r.slug = 'lululemon'";
const syntheticEnv = { CLOUDFLARE_ACCOUNT_ID: 'synthetic-account', CLOUDFLARE_API_TOKEN: 'synthetic-token',
  CLOUDFLARE_D1_DATABASE_ID: 'synthetic-database', SUBMITTED_TOTAL: '3', DRY_RUN: 'false' };

/** Parse the actual workflow. @returns {object} Workflow document. */
function workflow() { return yaml.load(fs.readFileSync(path.join(root, '.github/workflows/publish-lululemon.yml'), 'utf8')); }

/** Build the documented synthetic API response. @param {*} count Count value. @returns {object} Envelope. */
function envelope(count) { return { success: true, errors: [], result: [{ success: true, results: [{ persisted_count: count }] }] }; }

/** Invoke the production helper against exactly one mocked request. @param {object} options Case overrides. @returns {Promise<object>} Logs, calls and result/error. */
async function probe(options = {}) {
  const { verifyCount } = await import('./verify-lululemon-count.mjs');
  const calls = [], logs = [];
  try {
    const count = await verifyCount({ env: { ...syntheticEnv, ...options.env }, log: line => logs.push(line),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (options.transport) throw new Error('synthetic-token synthetic-account synthetic-database remote body');
        return { ok: options.ok ?? true, status: 503, json: async () => {
          if (options.badJSON) throw new Error('synthetic-token invalid private response');
          return options.body === undefined ? envelope(options.count ?? 3) : options.body;
        } };
      } });
    return { count, calls, logs };
  } catch (error) { return { error, calls, logs }; }
}

/** Assert rejected input/response cannot leak sensitive strings or retry. @param {object} result Probe evidence. @param {number} requests Expected requests. @returns {void} */
function rejected(result, requests = 1) {
  assert.ok(result.error, 'must reject');
  assert.equal(result.calls.length, requests);
  assert.match(result.error.message, /count|D1|secret|submitted|dry_run/i);
  assert.doesNotMatch(result.error.message + result.logs.join('\n'), /synthetic-token|synthetic-account|synthetic-database|private response|remote body/);
}

test('one fixed SELECT counts raw retailer rows, not visibility or history', async () => {
  const result = await probe();
  assert.ifError(result.error); assert.equal(result.count, 3); assert.equal(result.calls.length, 1);
  const { url, init } = result.calls[0];
  assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/synthetic-account/d1/database/synthetic-database/query');
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
  assert.deepEqual(init.headers, { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(init.body), { sql: fixedSQL });
  assert.match(result.logs.join('\n'), /Persisted lululemon rows: 3/);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
    db.exec("INSERT INTO retailers(id,name,slug,is_active) VALUES (91,'Synthetic Lulu','lululemon',0), (92,'Other','other',1)");
    db.exec("INSERT INTO scrape_history(id,source_id,started_at,status) VALUES (888,1,'2026-01-01','failed'), (999,1,'2026-01-01','running')");
    const insert = db.prepare('INSERT INTO deals(retailer_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,scrape_id,in_stock,valid_to) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const [id, scrape, stock, validTo] of [[91,null,0,'2000-01-01'],[91,888,1,null],[91,999,0,'2000-01-01'],[92,null,1,null]]) {
      insert.run(id, 'Synthetic', 0, 0, 0, 0, '2026-01-01', scrape, stock, validTo);
    }
    const before = db.prepare('SELECT * FROM deals ORDER BY id').all();
    assert.equal(db.prepare(JSON.parse(init.body).sql).get().persisted_count, 3);
    assert.deepEqual(db.prepare('SELECT * FROM deals ORDER BY id').all(), before);
  } finally { db.close(); }
});

test('real equality enforced but dry-run differing count allowed; zero and maximum safe count', async () => {
  for (const count of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const result = await probe({ count, env: { DRY_RUN: 'true' } });
    assert.ifError(result.error); assert.equal(result.count, count); assert.equal(result.calls.length, 1);
  }
  const equal = await probe({ count: Number.MAX_SAFE_INTEGER, env: { SUBMITTED_TOTAL: String(Number.MAX_SAFE_INTEGER) } });
  assert.ifError(equal.error);
  const mismatch = await probe({ count: 2 }); rejected(mismatch);
  assert.match(mismatch.logs.join('\n'), /Persisted lululemon rows: 2/);
  assert.match(mismatch.error.message, /expected 3.*observed 2/i);
  assert.match(mismatch.error.message, /may already|may have/i);
});

test('strict count types and response shape fail closed without coercion', async () => {
  for (const count of [null, '3', true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, {}, [], undefined]) {
    const body = envelope(count); rejected(await probe({ body }));
  }
  const bodies = [null, [], {}, { success: false, errors: [{ message: 'remote body synthetic-token' }] },
    { ...envelope(3), success: 'true' }, { ...envelope(3), errors: [{ message: 'private response' }] },
    { ...envelope(3), result: [] }, { ...envelope(3), result: [envelope(3).result[0], envelope(3).result[0]] },
    { ...envelope(3), result: [{ success: false, results: [{ persisted_count: 3 }] }] },
    { ...envelope(3), result: [{ results: [{ persisted_count: 3 }] }] },
    { ...envelope(3), result: [{ success: true, results: [] }] },
    { ...envelope(3), result: [{ success: true, results: [{ persisted_count: 3 }, { persisted_count: 3 }] }] },
    { ...envelope(3), result: [{ success: true, results: [null] }] }];
  for (const body of bodies) rejected(await probe({ body }));
});

test('missing secrets and invalid submitted total/mode never issue a request', async () => {
  for (const key of ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','CLOUDFLARE_D1_DATABASE_ID']) {
    for (const value of [undefined, '', '   ']) rejected(await probe({ env: { [key]: value } }), 0);
  }
  for (const total of [undefined, '', '0', '-1', '3.5', '03', '3e0', '3\n', '3;DELETE FROM deals', String(Number.MAX_SAFE_INTEGER + 1)]) {
    rejected(await probe({ env: { SUBMITTED_TOTAL: total } }), 0);
  }
  for (const dry of [undefined, '', 'TRUE', '0', 'false;touch PWNED']) rejected(await probe({ env: { DRY_RUN: dry } }), 0);
});

test('transport, HTTP, JSON and D1 failures are sanitized and never retried', async () => {
  for (const options of [{ transport: true }, { ok: false }, { badJSON: true }, { body: { success: false, errors: ['synthetic-token remote body'] } }]) {
    rejected(await probe(options));
  }
});

test('identifier path injection cannot redirect query or change literal SQL', async () => {
  const result = await probe({ env: { CLOUDFLARE_ACCOUNT_ID: '../evil?x=1', CLOUDFLARE_D1_DATABASE_ID: 'db/../../?redirect=evil' } });
  assert.ifError(result.error);
  assert.equal(result.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/..%2Fevil%3Fx%3D1/d1/database/db%2F..%2F..%2F%3Fredirect%3Devil/query');
  assert.equal(result.calls[0].init.redirect, 'error'); assert.deepEqual(JSON.parse(result.calls[0].init.body), { sql: fixedSQL });
});

test('workflow verification follows successful publication, uses hosted secrets and exact CLI total', () => {
  const w = workflow(), steps = w.jobs.publish.steps;
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch']); assert.equal(w.on.workflow_dispatch.inputs.dry_run.default, true);
  const pub = steps.find(s => s.name === 'Validate and publish saved deals');
  assert.equal(pub.id, 'submit');
  const verify = steps.find(s => s.name === 'Verify persisted Lululemon row count');
  assert.ok(verify); assert.ok(steps.indexOf(verify) > steps.indexOf(pub));
  assert.equal(verify.if, undefined, 'default success gate; never always()');
  assert.equal(verify.env.SUBMITTED_TOTAL, '${{ steps.submit.outputs.submitted_total }}');
  assert.equal(verify.env.DRY_RUN, '${{ inputs.dry_run }}');
  for (const key of ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','CLOUDFLARE_D1_DATABASE_ID']) assert.equal(verify.env[key], '${{ secrets.' + key + ' }}');
  assert.match(verify.run, /node scraper\/local\/verify-lululemon-count\.mjs/);
  assert.doesNotMatch(verify.run, /\$\{\{|eval|curl|retry|INSERT|UPDATE|DELETE|scrape:/i);
  const source = fs.readFileSync(path.join(root, 'scraper/local/verify-lululemon-count.mjs'), 'utf8');
  assert.doesNotMatch(source, /import.*(?:db\/d1|scrapers|cleaners)|\b(?:INSERT|UPDATE|DELETE)\b|process\.env\.(?:ASSET_NAMES|RELEASE_TAG)/i);
});

/** Create a synthetic SQLite snapshot, real helper preload and publisher stub for actual workflow shells. @returns {object} Isolated fixture and cleanup. */
function smokeFixture() {
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.cache/count-smoke-'));
  const database = path.join(dir, 'synthetic.sqlite');
  const db = new DatabaseSync(database);
  db.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
  db.exec("INSERT INTO retailers(id,name,slug) VALUES (91,'Synthetic Lulu','lululemon')");
  for (let i=0; i<3; i++) db.prepare('INSERT INTO deals(retailer_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,in_stock) VALUES (91,?,0,0,0,0,?,0)').run('Synthetic', '2026-01-01');
  db.close();
  const row = { product_name: 'Synthetic', category: 'Other', regular_price: 10, sale_price: 5, savings_amount: 5, savings_percent: 50, scraped_at: '2026-01-01' };
  fs.writeFileSync(path.join(dir, 'women.json'), JSON.stringify([row, row]));
  fs.writeFileSync(path.join(dir, 'men.json'), JSON.stringify([row]));
  const trace = path.join(dir, 'trace.jsonl'), publishers = path.join(dir, 'publishers.jsonl');
  const preload = path.join(dir, 'mock.mjs');
  const stub = `import fs from 'node:fs'; /** Record a synthetic combined publisher call. @param {object[]} rows Input rows. @returns {Promise<void>} Stub completion. */ export async function pushToD1(rows) { fs.appendFileSync(${JSON.stringify(publishers)}, JSON.stringify(rows)+'\\n'); }`;
  fs.writeFileSync(preload, `import fs from 'node:fs'; import { DatabaseSync } from 'node:sqlite';
import { registerHooks, syncBuiltinESMExports } from 'node:module'; import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
/** Deny real network transport. @returns {never} @throws {Error} Always. */ const deny = () => {throw new Error('Real network forbidden');};
net.connect=deny; net.createConnection=deny; http.get=deny; http.request=deny; https.get=deny; https.request=deny; syncBuiltinESMExports();
/** Serve only the fixed SELECT from a read-only synthetic database. @param {string} url URL. @param {object} init Request. @returns {Promise<object>} Mock response. */
globalThis.fetch = async (url, init) => {
 const body=JSON.parse(init.body); if(body.sql!==${JSON.stringify(fixedSQL)}) throw new Error('Unexpected SQL');
 fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({sql:body.sql})+'\\n');
 const db=new DatabaseSync(${JSON.stringify(database)}, {readOnly:true}); const count=db.prepare(body.sql).get().persisted_count; db.close();
 if(process.env.MOCK_MODE==='transport') throw new Error('synthetic-token private remote failure');
 return {ok:process.env.MOCK_MODE!=='http', json:async()=>({success:true,errors:[],result:[{success:true,results:[{persisted_count:process.env.MOCK_MODE==='malformed'?'3':count}]}]})};
};
registerHooks({/** Substitute only the publisher; reject all collectors. @param {string} url Module URL. @param {object} context Loader context. @param {Function} next Loader. @returns {object} Module. */ load(url,context,next) {
 if(url.includes('/scrapers/')) throw new Error('Collector forbidden');
 if(url.endsWith('/scraper/src/db/d1.js')) return {format:'module',shortCircuit:true,source:${JSON.stringify(stub)}};
 return next(url,context);
}});
`);
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(preload)} "$@"\n`, { mode: 0o755 });
  return { dir, database, trace, publishers, bin, cleanup: () => fs.rmSync(dir, {recursive:true,force:true}) };
}

/** Execute an actual workflow shell with explicit synthetic environment only. @param {object} f Fixture. @param {object} step Workflow step. @param {object} extra Overrides. @returns {object} Child exit and logs. */
function shell(f, step, extra = {}) {
  return spawnSync('/bin/bash', ['-e','-o','pipefail','-c',step.run], { cwd: root, encoding: 'utf8', env: {
    ...syntheticEnv, PATH: `${f.bin}:${process.env.PATH}`, HOME: f.dir,
    ASSET_NAMES: 'women.json\nmen.json', DIRECTORY: f.dir, GITHUB_OUTPUT: path.join(f.dir,'output'), ...extra,
  } });
}

/** Read trace lines, including the absent-file case. @param {string} file Trace filename. @returns {object[]} Records. */
function records(file) { return fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }

test('ordered count smoke: actual submit/helper workflow shells, happy, negative, state', () => {
  const f = smokeFixture();
  try {
    const files = [f.database, path.join(f.dir,'women.json'),path.join(f.dir,'men.json')];
    const before = files.map(file => fs.readFileSync(file));
    const steps = workflow().jobs.publish.steps;
    const pub = steps.find(s=>s.name==='Validate and publish saved deals');
    const verify = steps.find(s=>s.name==='Verify persisted Lululemon row count');
    assert.ok(verify);
    const submitted = shell(f,pub); assert.equal(submitted.status,0,submitted.stderr);
    const total = fs.readFileSync(path.join(f.dir,'output'),'utf8').trim().split('=')[1]; assert.equal(total,'3');
    assert.equal(records(f.publishers).length,1); assert.equal(records(f.publishers)[0].length,3);
    const happy = shell(f,verify,{SUBMITTED_TOTAL:total}); assert.equal(happy.status,0,happy.stderr);
    assert.match(happy.stdout,/Persisted lululemon rows: 3/); assert.equal(records(f.trace).length,1);
    console.log('COUNT_SMOKE_HAPPY actualWorkflowShells=true files=2 submittedTotal=3 actualMockPersisted=3 combinedPublisherCalls=1 queryCalls=1 exit=0');
    const negatives = [ {SUBMITTED_TOTAL:'4'}, {MOCK_MODE:'malformed'}, {MOCK_MODE:'http'}, {MOCK_MODE:'transport'},
      {SUBMITTED_TOTAL:'3;touch PWNED'}, {DRY_RUN:'false;touch PWNED'}, {CLOUDFLARE_API_TOKEN:''} ];
    for (const extra of negatives) {
      const start = records(f.trace).length, result = shell(f,verify,extra);
      assert.equal(result.status,1); assert.match(result.stderr,/count|D1|secret|submitted|dry_run/i);
      assert.doesNotMatch(result.stderr+result.stdout,/synthetic-token|synthetic-account|synthetic-database|private remote/);
      assert.ok(records(f.trace).length-start<=1);
      assert.equal(records(f.publishers).length,1);
    }
    const dry = shell(f,verify,{DRY_RUN:'true',SUBMITTED_TOTAL:'4'}); assert.equal(dry.status,0,dry.stderr);
    assert.match(dry.stdout,/Persisted lululemon rows: 3/);
    console.log('COUNT_SMOKE_NEGATIVE realMismatch=nonzero malformed=nonzero http=nonzero transport=nonzero injectionRejected=true missingSecret=nonzero dryMismatch=allowed retries=0 leaks=0');
    assert.deepEqual(files.map(file=>fs.readFileSync(file)),before);
    assert.equal(records(f.publishers).length,1);
    for (const record of records(f.trace)) assert.equal(record.sql,fixedSQL);
    assert.equal(fs.existsSync(path.join(root,'PWNED')),false);
    console.log('COUNT_SMOKE_STATE databaseAndInputBytesUnchanged=true fixedReadOnlySQL=true publisherCallsAddedByVerification=0 realNetwork=0');
  } finally { f.cleanup(); }
});
