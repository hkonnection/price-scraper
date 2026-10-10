import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runDaily } from './lululemon-daily.mjs';
import { loadDeals, main as savedMain } from './publish-lululemon.mjs';
import { SECTIONS } from './lululemon-grid.mjs';

const artifacts = process.env.LULU_TEST_ARTIFACTS || fs.mkdtempSync(path.join(os.homedir(), '.lulu-daily-test-'));
const at = '2026-10-11T15:02:03.456Z';
/** Build synthetic runtime dependencies with no external calls. @param {object} changes Runtime overrides. @returns {object} Fixture. */
function fixture(changes = {}) {
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const outputDir = fs.mkdtempSync(path.join(artifacts, 'daily-'));
  const calls = [], visits = [], logs = [];
  const browser = { newPage: async () => ({}), close: async () => { calls.push(['close']); } };
  const runtime = { now: () => new Date(at), platform: 'darwin', uid: process.getuid(), workflowText: 'on:\n  workflow_dispatch:\n    inputs:\n      captured_at:\n        type: string\n', emit: line => logs.push(line),
    launch: async options => { calls.push(['launch', options]); return browser; },
    capture: async (page, section) => { visits.push(section.name); return `<div data-testid="product-grid"><div data-testid="product-tile"><a href="/p/test/same">${section.name === 'Accessories' ? 'Bag' : 'Unknown'}</a><span class="originalPrice">$100</span>$50</div></div>`; },
    github: async args => { calls.push(args); return { status: 0 }; },
    ...changes,
  };
  return { outputDir, runtime, calls, visits, logs };
}

test('the CLI entry uses the same locally exercised argument vector and complete-set pipeline', async () => {
  const { main } = await import('./lululemon-daily.mjs');
  const f = fixture();
  const result = await main(['--output-dir', f.outputDir, '--publish'], f.runtime);
  assert.equal(result.payload.totalProducts, 1);
  assert.equal(f.calls.filter(c => c[0] === 'workflow').length, 1);
});

test('daily argument interface refuses unsafe/ambiguous modes and requires private absolute output', () => {
  assert.deepEqual(parseArgs(['--output-dir', '/private/output']), { outputDir: '/private/output', publish: false, priorFiles: [] });
  assert.equal(parseArgs(['--publish', '--output-dir', '/private/output', '--prior', '/private/prior.json']).publish, true);
  for (const args of [[], ['--output-dir', 'relative'], ['--output-dir', '/a', '--output-dir', '/b'], ['--output-dir', '/a', '--publish', '--dry-run'], ['--output-dir', '/a', '--bogus'], ['--output-dir', '/a', '--prior'], ['--output-dir', '/a', '--credentials', '/private/file'], ['setup'], ['--output-dir', '/a/../b']]) assert.throws(() => parseArgs(args));
});

test('complete captures produce distinct raw files and one publish-ready submission including zero-new-product sections', async () => {
  const f = fixture();
  const result = await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime);
  assert.deepEqual(f.visits, ['Women', 'Men', 'Accessories']);
  assert.deepEqual(f.calls[0], ['launch', { channel: 'chrome', headless: false }]);
  for (const name of ['women', 'men', 'accessories']) {
    const raw = JSON.parse(fs.readFileSync(path.join(result.directory, 'raw', name + '.json')));
    assert.equal(raw.deals.length, 1); assert.equal(raw.totalProducts, 1);
    assert.match(fs.readFileSync(path.join(result.directory, 'raw', name + '.html'), 'utf8'), /product-grid/);
  }
  const deals = loadDeals(result.publishFile);
  assert.equal(deals.length, 1); assert.equal(deals[0].category, 'Bags');
  assert.deepEqual(result.payload.sections.map(s => s.dealCount), [1, 0, 0]);
  assert.equal(await savedMain(['--dry-run', '--', result.publishFile]), 1);
  const dispatches = f.calls.filter(c => c[0] === 'workflow');
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0], ['workflow', 'run', 'publish-lululemon.yml', '--ref', 'main', '--field', `release_tag=${result.releaseTag}`, '--field', 'asset_names=combined.json', '--field', 'dry_run=false', '--field', `captured_at=${at}`]);
  assert.equal(f.calls.filter(c => c[0] === 'release' && c[1] === 'upload').length, 1);
  assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.directory, 'manifest.json')));
  assert.equal(manifest.submitted_total, 1); assert.equal(manifest.captured_at, at); assert.equal(manifest.status, 'dispatched');
});

test('landed capture-time workflow and saved publisher accept the actual completed set and unique count', async () => {
  const f = fixture(); delete f.runtime.workflowText;
  const result = await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime);
  const workflow = fs.readFileSync(new URL('../../.github/workflows/publish-lululemon.yml', import.meta.url), 'utf8');
  assert.match(workflow, /CAPTURED_AT: \$\{\{ inputs.captured_at \}\}/);
  assert.match(workflow, /--captured-at "\$\{CAPTURED_AT:-\}"/);
  const now = Date.now;
  Date.now = () => Date.parse(at) + 5000;
  try { assert.equal(await savedMain(['--dry-run', '--captured-at', result.capturedAt, '--', result.publishFile]), result.payload.totalProducts); }
  finally { Date.now = now; }
  assert.equal(f.calls.filter(c => c[0] === 'workflow').length, 1);
});

test('backwards capture clock prevents release upload or dispatch', async () => {
  const f = fixture(); let ticks = 0;
  f.runtime.now = () => new Date(Date.parse(at) - (ticks++ >= 5 ? 1000 : 0));
  await assert.rejects(runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime), /capture.*preced/i);
  assert.equal(f.calls.some(c => ['release', 'workflow'].includes(c[0])), false);
});

test('dry-run captures locally but never contacts GitHub or D1', async () => {
  const f = fixture(); const result = await runDaily({ outputDir: f.outputDir, publish: false, priorFiles: [] }, f.runtime);
  assert.equal(result.payload.deals.length, 1); assert.equal(f.calls.some(c => ['release', 'workflow'].includes(c[0])), false);
});

test('first refusal, missing/empty capture, malformed data and stalled expansion stop immediately without publishing', async () => {
  for (const failure of ['refused', 'empty', 'missing', 'bad-price', 'stalled']) {
    const f = fixture();
    f.runtime.capture = async (page, section) => {
      f.visits.push(section.name);
      if (section.name === 'Men') {
        if (failure === 'refused' || failure === 'stalled') throw new Error(failure);
        if (failure === 'missing') return '<div>no grid</div>';
        if (failure === 'empty') return '<div data-testid="product-grid"></div>';
        return '<div data-testid="product-grid"><div data-testid="product-tile"><a href="/p/test/bad">Bad</a>$0 $0</div></div>';
      }
      return '<div data-testid="product-grid"><div data-testid="product-tile"><a href="/p/test/ok">Tank</a>$100 $50</div></div>';
    };
    await assert.rejects(runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime));
    assert.deepEqual(f.visits, ['Women', 'Men']); assert.equal(f.calls.some(c => ['release', 'workflow'].includes(c[0])), false);
    assert.equal(f.calls.filter(c => c[0] === 'close').length, 1); assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
    const folder = fs.readdirSync(f.outputDir).find(n => n.startsWith('capture-'));
    assert.equal(fs.existsSync(path.join(f.outputDir, folder, 'publish', 'combined.json')), false);
  }
});

test('today, root, unsupported host, unsafe output, lock and malformed prior data refuse before browser start', async () => {
  for (const attack of ['today', 'root', 'linux', 'symlink', 'permissions', 'lock', 'prior']) {
    const f = fixture(); const options = { outputDir: f.outputDir, publish: true, priorFiles: [] };
    if (attack === 'today') f.runtime.now = () => new Date('2026-10-11T06:59:59.999Z');
    if (attack === 'root') f.runtime.uid = 0;
    if (attack === 'linux') f.runtime.platform = 'linux';
    if (attack === 'symlink') { options.outputDir += '-link'; fs.symlinkSync(f.outputDir, options.outputDir); }
    if (attack === 'permissions') fs.chmodSync(f.outputDir, 0o777);
    if (attack === 'lock') fs.mkdirSync(path.join(f.outputDir, 'run.lock'), { mode: 0o700 });
    if (attack === 'prior') { const file = path.join(f.outputDir, 'prior.json'); fs.writeFileSync(file, '{"bad":true}', { mode: 0o600 }); options.priorFiles = [file]; }
    await assert.rejects(runDaily(options, f.runtime)); assert.equal(f.calls.length, 0, attack);
  }
});

test('GitHub create/upload/dispatch failure is never retried or reported successful', async () => {
  for (const failed of ['create', 'upload', 'run']) {
    const f = fixture(); f.runtime.github = async args => { f.calls.push(args); return { status: args[1] === failed ? 1 : 0 }; };
    await assert.rejects(runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime), /GitHub|publication|dispatch/i);
    assert.equal(f.calls.filter(c => c[1] === failed).length, 1);
    if (failed !== 'run') assert.equal(f.calls.some(c => c[0] === 'workflow'), false);
    assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
  }
});

test('prior saved categories are used without production category queries', async () => {
  const f = fixture(); const file = path.join(f.outputDir, 'prior.json');
  fs.writeFileSync(file, JSON.stringify([{ product_code: 'same', category: 'Yoga Mats' }]), { mode: 0o600 });
  const result = await runDaily({ outputDir: f.outputDir, publish: false, priorFiles: [file] }, f.runtime);
  assert.equal(result.payload.deals[0].category, 'Yoga Mats'); assert.equal(f.calls.some(c => c[0] === 'workflow'), false);
});

test('daily npm entry points to the complete-set command, not the legacy collector', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.scripts['scrape:lululemon:daily'], 'node local/lululemon-daily.mjs');
});

test('existing saved workflow independently checks persisted count with actual submitted_total', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/publish-lululemon.yml', import.meta.url), 'utf8');
  assert.match(workflow, /SUBMITTED_TOTAL: \$\{\{ steps.submit.outputs.submitted_total \}\}/);
  assert.match(workflow, /node scraper\/local\/verify-lululemon-count.mjs/);
  assert.equal(SECTIONS.length, 3);
});
