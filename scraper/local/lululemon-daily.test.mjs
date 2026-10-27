import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { parseArgs, runDaily, SECTION_PAUSE_MS, SECTION_PASSES } from './lululemon-daily.mjs';
import { loadDeals, main as savedMain } from './publish-lululemon.mjs';
import { SECTIONS, collectSection } from './lululemon-grid.mjs';

const artifacts = process.env.LULU_TEST_ARTIFACTS || fs.mkdtempSync(path.join(os.homedir(), '.lulu-daily-test-'));
const at = '2026-10-11T15:02:03.456Z';
/** Build synthetic runtime dependencies with no external calls. @param {object} changes Runtime overrides. @returns {object} Fixture. */
function fixture(changes = {}) {
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const outputDir = fs.mkdtempSync(path.join(artifacts, 'daily-'));
  const calls = [], visits = [], logs = []; let contexts = 0;
  const browser = { close: async () => { calls.push(['close']); },
    newContext: async () => { const id = ++contexts; calls.push(['context', id]); return { newPage: async () => ({ context: id }), close: async () => { calls.push(['context-close', id]); } }; } };
  const runtime = { now: () => new Date(at), platform: 'darwin', uid: process.getuid(), workflowText: 'on:\n  workflow_dispatch:\n    inputs:\n      captured_at:\n        type: string\n', emit: line => logs.push(line),
    launch: async options => { calls.push(['launch', options]); return browser; },
    sleep: async ms => { calls.push(['sleep', ms]); },
    capture: async (page, section) => { visits.push(section.name); calls.push(['capture', section.name, page.context]); return `<div data-testid="product-grid"><div data-testid="product-tile"><a href="/p/test/same">${section.name === 'Accessories' ? 'Bag' : 'Unknown'}</a><span class="originalPrice">$100</span>$50</div></div>`; },
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

/** Observe the real GitHub adapter at its subprocess boundary without remote execution. */
test('GitHub subprocess appends user-local bin after the exact fixed system PATH', async t => {
  const f = fixture(); delete f.runtime.github;
  const subprocesses = [];
  const spawn = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    subprocesses.push({ command, args, options });
    return { status: 0 };
  });
  syncBuiltinESMExports();
  try {
    await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime);
    assert.equal(subprocesses.length, 3);
    assert.deepEqual(subprocesses.map(call => call.args.slice(0, 2)), [['release', 'create'], ['release', 'upload'], ['workflow', 'run']]);
    const prefix = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    for (const { command, args, options } of subprocesses) {
      assert.equal(command, 'gh-axi');
      assert.deepEqual(args.slice(-2), ['--repo', 'hkonnection/price-scraper']);
      assert.equal(options.env.PATH.slice(0, prefix.length + 1), prefix + ':');
      assert.equal(options.env.PATH.split(':').at(-1), path.join(os.homedir(), '.local', 'bin'));
      assert.deepEqual(options, { encoding: 'utf8', stdio: 'pipe', env: { HOME: os.homedir(), PATH: prefix + ':' + path.join(os.homedir(), '.local', 'bin') }, timeout: 120000 });
    }
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
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

test('each section loads in its own fresh browser context, closed before a named pause of a few minutes', async () => {
  assert.equal(SECTION_PAUSE_MS, 180000);
  const f = fixture();
  await runDaily({ outputDir: f.outputDir, publish: false, priorFiles: [] }, f.runtime);
  assert.deepEqual(f.calls.filter(c => c[0] !== 'launch'), [
    ['context', 1], ['capture', 'Women', 1], ['context-close', 1], ['sleep', SECTION_PAUSE_MS],
    ['context', 2], ['capture', 'Men', 2], ['context-close', 2], ['sleep', SECTION_PAUSE_MS],
    ['context', 3], ['capture', 'Accessories', 3], ['context-close', 3], ['close'],
  ]);
  assert.equal(f.logs.filter(line => /^Pausing 180 s before (Men|Accessories)\.$/.test(line)).length, 2);
  assert.deepEqual(f.logs.filter(line => / page load at \d{4}-\d{2}-\d{2}T/.test(line)).map(line => line.split(' ')[0]), ['Women', 'Men', 'Accessories']);
});

test('the collector receives the run.log writer so expansion detail lands in run.log', async () => {
  const f = fixture(); const capture = f.runtime.capture;
  f.runtime.capture = async (page, section, settings) => { settings.log(`${section.name} View More click 1 at 40 cards.`); return capture(page, section); };
  const result = await runDaily({ outputDir: f.outputDir, publish: false, priorFiles: [] }, f.runtime);
  const runLog = fs.readFileSync(path.join(result.directory, 'run.log'), 'utf8');
  for (const name of ['Women', 'Men', 'Accessories']) assert.match(runLog, new RegExp(`^${name} View More click 1 at 40 cards\\.$`, 'm'));
});

test('a refused first section stops before any pause, second context or publication', async () => {
  const f = fixture();
  f.runtime.capture = async (page, section) => { f.visits.push(section.name); throw new Error('Collection refused: HTTP 400.'); };
  await assert.rejects(runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime), /HTTP 400/);
  assert.deepEqual(f.visits, ['Women']);
  assert.deepEqual(f.calls.filter(c => c[0] !== 'launch'), [['context', 1], ['context-close', 1], ['close']]);
  assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
});

/** Verify safe notices survive failed runs without changing the last complete snapshot. */
test('retailer challenge saves only bounded section and time, never retries or publishes, and preserves latest', async () => {
  for (const kind of ['press-and-hold', 'retailer-refusal', 'inspection-unavailable']) for (const stopped of SECTIONS) {
    const f = fixture();
    await runDaily({ outputDir: f.outputDir, publish: false, priorFiles: [] }, f.runtime);
    const latest = fs.readFileSync(path.join(f.outputDir, 'latest.json'));
    f.calls.length = 0; f.visits.length = 0; f.logs.length = 0;
    const capture = f.runtime.capture;
    f.runtime.capture = async (page, section, settings) => {
      if (section.name !== stopped.name) return capture(page, section, settings);
      f.visits.push(section.name);
      throw Object.assign(new Error('synthetic-private-token cookie=private page text'), { challenge: kind, short: true, grid: 'private partial HTML' });
    };
    await assert.rejects(runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime));
    assert.deepEqual(f.visits, SECTIONS.slice(0, SECTIONS.indexOf(stopped) + 1).map(s => s.name));
    const dirs = fs.readdirSync(f.outputDir).filter(name => name.startsWith('capture-'));
    const failed = dirs.map(name => path.join(f.outputDir, name)).find(dir => fs.existsSync(path.join(dir, 'challenge.json')));
    assert.ok(failed, 'durable challenge notice must exist');
    const file = path.join(failed, 'challenge.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { section: stopped.name, detected_at: at, kind, frame_host: 'unknown', requires_human: true });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const log = fs.readFileSync(path.join(failed, 'run.log'), 'utf8');
    assert.ok(log.includes(`Human attention required: ${kind} in ${stopped.name} at ${at}; frame host unknown. No publication or automated retry.`));
    assert.doesNotMatch(log + fs.readFileSync(file, 'utf8'), /synthetic-private-token|cookie=|private page text|private partial HTML/);
    assert.equal(f.calls.some(c => ['release', 'workflow'].includes(c[0])), false);
    assert.equal(f.calls.filter(c => c[0] === 'context').length, SECTIONS.indexOf(stopped) + 1);
    assert.equal(f.calls.filter(c => c[0] === 'sleep').length, SECTIONS.indexOf(stopped));
    assert.equal(fs.existsSync(path.join(failed, 'publish')), false);
    assert.deepEqual(fs.readFileSync(path.join(f.outputDir, 'latest.json')), latest);
    assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
    assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  }
});

/** Propagate only a bounded host and distinguish unavailable inspection in both notice channels. */
test('inspection notices sanitize host metadata and preserve the unavailable kind', async () => {
  for (const [frameHost, expected] of [['slow.example', 'slow.example'], ['SLOW.EXAMPLE.', 'slow.example'],
    ['user:secret@slow.example/path?token=secret#private', 'unknown'], ['https://slow.example/private', 'unknown'],
    ['bad\nhost', 'unknown'], ['', 'unknown'], [undefined, 'unknown']]) {
    const f = fixture();
    const failure = Object.assign(Error('private rendered text'), { challenge: 'inspection-unavailable', frameHost, short: true, grid: 'private partial HTML' });
    f.runtime.capture = async () => { throw failure; };
    const error = await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime).catch(error => error);
    assert.equal(error, failure);
    const dir = fs.readdirSync(f.outputDir).find(name => name.startsWith('capture-'));
    const notice = JSON.parse(fs.readFileSync(path.join(f.outputDir, dir, 'challenge.json')));
    assert.deepEqual(notice, { section: 'Women', detected_at: at, kind: 'inspection-unavailable', frame_host: expected, requires_human: true });
    const log = fs.readFileSync(path.join(f.outputDir, dir, 'run.log'), 'utf8');
    assert.ok(log.includes(`frame host ${expected}`));
    assert.doesNotMatch(log + JSON.stringify(notice), /secret|private|token|https?:|partial HTML/);
    assert.equal(f.calls.some(call => ['release', 'workflow', 'sleep'].includes(call[0])), false);
    assert.equal(fs.existsSync(path.join(f.outputDir, 'latest.json')), false);
    assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
  }
});

/** Keep the bounded human notice and original refusal even if its JSON file cannot be written. */
test('failed challenge notice write retains human log and refusal without publishing', async t => {
  for (const code of ['ENOSPC', 'EACCES']) {
    const f = fixture();
    const refusal = Object.assign(new Error('Collection refused by retailer. No publication.'), { challenge: 'press-and-hold' });
    f.runtime.capture = async (_page, section) => { f.visits.push(section.name); throw refusal; };
    const original = fs.writeFileSync;
    const mock = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (String(file).endsWith('challenge.json')) throw Object.assign(new Error('private filesystem diagnostics'), { code });
      return original(file, ...args);
    });
    let error;
    try { error = await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime).catch(caught => caught); }
    finally { mock.mock.restore(); }
    assert.equal(error, refusal, code);
    const dir = fs.readdirSync(f.outputDir).find(name => name.startsWith('capture-'));
    const log = fs.readFileSync(path.join(f.outputDir, dir, 'run.log'), 'utf8');
    assert.match(log, /Human attention required: press-and-hold in Women at/);
    assert.ok(f.logs.some(line => line.includes('Human attention required')));
    assert.doesNotMatch(log + f.logs.join('\n'), /private filesystem/);
    assert.deepEqual(f.visits, ['Women']);
    assert.equal(f.calls.some(c => ['release', 'workflow', 'sleep'].includes(c[0])), false);
    assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
    assert.equal(fs.existsSync(path.join(f.outputDir, 'latest.json')), false);
  }
});

/** Avoid replacing the refusal with a secondary diagnostic failure after the human line was persisted. */
test('notice write failure needs no follow-up logger to preserve the refusal', async t => {
  const f = fixture();
  const refusal = Object.assign(new Error('Collection refused by retailer. No publication.'), { challenge: 'press-and-hold' });
  f.runtime.capture = async () => { throw refusal; };
  const write = fs.writeFileSync, log = fs.writeSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).endsWith('challenge.json')) throw Object.assign(Error('private disk failure'), { code: 'ENOSPC' });
    return write(file, ...args);
  });
  t.mock.method(fs, 'writeSync', (fd, data, ...args) => {
    if (String(data).startsWith('Challenge notice could not be saved.')) throw Object.assign(Error('private secondary logger failure'), { code: 'EIO' });
    return log(fd, data, ...args);
  });
  const error = await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime).catch(caught => caught);
  assert.equal(error, refusal);
  assert.ok(f.logs.some(line => line.startsWith('Human attention required:')));
  assert.equal(f.calls.some(c => ['release', 'workflow'].includes(c[0])), false);
  assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
});

/** Keep notice channels independent and retain the original refusal when some or all logging writes fail. */
test('human notice logging failure preserves refusal and independently writable JSON', async t => {
  for (const mode of ['human-log', 'emitter', 'all-log', 'both-channels']) await t.test(mode, async sub => {
    const f = fixture();
    await runDaily({ outputDir: f.outputDir, publish: false, priorFiles: [] }, f.runtime);
    const latest = fs.readFileSync(path.join(f.outputDir, 'latest.json'));
    f.calls.length = 0; f.visits.length = 0;
    const refusal = Object.assign(Error('Collection refused by retailer. No publication.'), { challenge: 'press-and-hold', frameHost: 'challenge.example' });
    f.runtime.capture = async (_page, section) => { f.visits.push(section.name); throw refusal; };
    const write = fs.writeSync, save = fs.writeFileSync;
    let failedLog;
    sub.mock.method(fs, 'writeSync', (fd, data, ...args) => {
      if (String(data).startsWith('Human attention required:') && mode !== 'emitter') failedLog = fd;
      if (fd === failedLog && (String(data).startsWith('Human attention required:') || ['all-log', 'both-channels'].includes(mode))) throw Object.assign(Error('private log EIO'), { code: 'EIO' });
      return write(fd, data, ...args);
    });
    if (mode === 'both-channels') sub.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (String(file).endsWith('challenge.json')) throw Object.assign(Error('private notice ENOSPC'), { code: 'ENOSPC' });
      return save(file, ...args);
    });
    if (mode === 'emitter') f.runtime.emit = line => { if (line.startsWith('Human attention required:')) throw Error('private emitter failure'); };
    const error = await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime).catch(error => error);
    assert.equal(error, refusal, mode);
    const dirs = fs.readdirSync(f.outputDir).filter(name => name.startsWith('capture-'));
    const notices = dirs.map(dir => path.join(f.outputDir, dir, 'challenge.json')).filter(file => fs.existsSync(file));
    assert.equal(notices.length, mode === 'both-channels' ? 0 : 1);
    for (const file of notices) {
      assert.deepEqual(JSON.parse(fs.readFileSync(file)), { section: 'Women', detected_at: at, kind: 'press-and-hold', frame_host: 'challenge.example', requires_human: true });
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual(f.visits, ['Women']);
    assert.equal(f.calls.some(call => ['release', 'workflow', 'sleep'].includes(call[0])), false);
    assert.deepEqual(fs.readFileSync(path.join(f.outputDir, 'latest.json')), latest);
    assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
  });
});

/** Reproduce a recorded HTTP refusal followed by a navigation failure through the actual collector and daily notice path. */
test('daily recorded-response navigation failure saves a bounded challenge notice', async () => {
  const f = fixture();
  f.runtime.capture = async (_page, section, settings) => {
    f.visits.push(section.name);
    let onResponse;
    const page = { on: (event, handler) => { if (event === 'response') onResponse = handler; }, off() {},
      goto: async () => {
        onResponse({ url: () => 'https://shop.lululemon.com/blocked?secret=private', status: () => 403, request: () => ({ resourceType: () => 'document' }) });
        throw Error('Execution context destroyed private browser URL');
      } };
    return collectSection(page, section, settings);
  };
  const error = await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime).catch(caught => caught);
  assert.equal(error.challenge, 'retailer-refusal');
  assert.doesNotMatch(error.message, /private|secret|destroyed/);
  const dir = fs.readdirSync(f.outputDir).find(name => name.startsWith('capture-'));
  const notice = JSON.parse(fs.readFileSync(path.join(f.outputDir, dir, 'challenge.json')));
  assert.deepEqual(notice, { section: 'Women', detected_at: at, kind: 'retailer-refusal', frame_host: 'shop.lululemon.com', requires_human: true });
  assert.match(fs.readFileSync(path.join(f.outputDir, dir, 'run.log'), 'utf8'), /Human attention required/);
  assert.equal(f.calls.some(c => ['release', 'workflow', 'sleep'].includes(c[0])), false);
  assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
});

/** Make a short-section error as the collector throws it. @param {string} grid Grid of the short pass. @returns {Error} Error. */
function shortError(grid) { return Object.assign(new Error('Incomplete section: 1 of 2 unique products loaded (2 cards, 1 repeated; last product-data total).'), { short: true, grid }); }
/** One pass only: with no further pass allowed, a short section stops after its first pass. */
test('with no further pass allowed, 502 unique against a total of 503 after one pass stops the run', async () => {
  const f = fixture(); let attempts = 0;
  f.runtime.sectionPasses = 1;
  f.runtime.capture = async () => { attempts++; throw Object.assign(new Error('Incomplete section: 502 of 503 unique products loaded (503 cards, 1 repeated; last product-data total).'), { short: true, grid: '<div data-testid="product-grid"></div>' }); };
  await assert.rejects(runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime), /502 of 503 unique products/);
  assert.equal(attempts, 1); assert.equal(f.calls.some(c => c[0] === 'sleep' || c[0] === 'workflow'), false);
});

const PASS1 = '<div data-testid="product-grid"><div data-testid="product-tile"><a href="/p/test/one">Tank</a><span class="originalPrice">$100</span>$50</div></div>';

test('a short section is re-paged in a fresh context after the pause, with the grid so far handed to the collector, and stops paging once complete', async () => {
  const f = fixture(); const settings = []; const capture = f.runtime.capture; let women = 0;
  f.runtime.capture = async (page, section, options) => {
    settings.push([section.name, options.earlier ?? null]);
    if (section.name === 'Women' && ++women === 1) { f.calls.push(['capture', 'Women', page.context]); throw shortError(PASS1); }
    return capture(page, section, options);
  };
  const result = await runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime);
  assert.equal(result.stats.length, 3);
  assert.deepEqual(settings, [['Women', null], ['Women', PASS1], ['Men', null], ['Accessories', null]]);
  assert.deepEqual(f.calls.filter(c => ['context', 'context-close', 'sleep', 'capture'].includes(c[0])).slice(0, 8), [
    ['context', 1], ['capture', 'Women', 1], ['context-close', 1], ['sleep', SECTION_PAUSE_MS], ['context', 2], ['capture', 'Women', 2], ['context-close', 2], ['sleep', SECTION_PAUSE_MS]]);
  assert.ok(f.logs.includes('Women pass 1 short: Incomplete section: 1 of 2 unique products loaded (2 cards, 1 repeated; last product-data total). Re-paging Women in a fresh browser context after 180 s (pass 2 of 3); all passes are combined by product id.'), f.logs.join('\n'));
  assert.equal(f.calls.filter(c => c[0] === 'workflow').length, 1);
});

test('3 passes ending below the final product-data total stop the run without a fourth pass or publication; other stops are never re-paged', async () => {
  assert.equal(SECTION_PASSES, 3);
  const f = fixture(); let attempts = 0; const grids = [];
  f.runtime.capture = async (page, section, options) => { f.visits.push(section.name); grids.push(options.earlier ?? null); attempts++; throw shortError(PASS1 + attempts); };
  await assert.rejects(runDaily({ outputDir: f.outputDir, publish: true, priorFiles: [] }, f.runtime), /1 of 2 unique products/);
  assert.equal(attempts, 3); assert.deepEqual(f.visits, ['Women', 'Women', 'Women']);
  assert.deepEqual(grids, [null, PASS1 + 1, PASS1 + 2]);
  assert.equal(f.calls.filter(c => c[0] === 'sleep').length, 2);
  assert.equal(f.calls.some(c => ['release', 'workflow'].includes(c[0])), false);
  assert.equal(fs.existsSync(path.join(f.outputDir, 'run.lock')), false);
  for (const error of [new Error('Collection refused by retailer: HTTP 429 /x. No publication.'), Object.assign(new Error('Incomplete section: a product-data response gave no product total.'), { grid: PASS1 }), Object.assign(new Error('short without grid'), { short: true })]) {
    const g = fixture(); let tries = 0;
    g.runtime.capture = async () => { tries++; throw error; };
    await assert.rejects(runDaily({ outputDir: g.outputDir, publish: true, priorFiles: [] }, g.runtime));
    assert.equal(tries, 1, error.message);
    assert.equal(g.calls.some(c => c[0] === 'sleep'), false);
  }
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
    assert.deepEqual(f.calls.filter(c => c[0] === 'sleep'), [['sleep', SECTION_PAUSE_MS]], 'no pause or third section after the first failure');
    assert.deepEqual(f.calls.filter(c => c[0] === 'context-close'), [['context-close', 1], ['context-close', 2]]);
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
