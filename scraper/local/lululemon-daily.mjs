#!/usr/bin/env node
/** Capture three Canadian sale grids daily and optionally dispatch their one complete saved snapshot.
 * Usage: node scraper/local/lululemon-daily.mjs --output-dir /private/durable/directory [--dry-run | --publish] [--prior /private/saved.json ...]
 * Defaults to local capture only. No schedule installation, direct database calls or automatic retries.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SECTIONS, collectSection, parseGrid, combineSections } from './lululemon-grid.mjs';
import { loadDeals } from './publish-lululemon.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/publish-lululemon.yml');

/** Reject ambiguous or non-normalized private paths. @param {string} value Path. @returns {string} Validated path. @throws {Error} On unsafe path. */
function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a normalized absolute private path.');
  return value;
}

/** Parse the non-shell daily interface; credentials and setup flags are not supported. @param {string[]} argv Arguments. @returns {object} Options. @throws {Error} On unknown, duplicate or missing arguments. */
export function parseArgs(argv) {
  const options = { publish: false, priorFiles: [] }; let mode = false;
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--output-dir' && !options.outputDir) options.outputDir = absolutePath(args.shift());
    else if (arg === '--prior') options.priorFiles.push(absolutePath(args.shift()));
    else if (['--publish', '--dry-run'].includes(arg) && !mode) { options.publish = arg === '--publish'; mode = true; }
    else throw new Error('Unknown or duplicate argument. Use --output-dir /private/directory [--dry-run | --publish] [--prior /private/saved.json].');
  }
  if (!options.outputDir || new Set(options.priorFiles).size !== options.priorFiles.length) throw new Error('One private --output-dir and distinct prior paths are required.');
  return options;
}

/** Verify no symlink, writable ancestor or repository destination is used. @param {string} target Existing path. @param {number} uid User ID. @param {boolean} directory Directory expected. @returns {void} @throws {Error} On unsafe state. */
function privatePath(target, uid, directory) {
  absolutePath(target);
  const repo = fs.realpathSync(ROOT);
  const relative = path.relative(repo, target);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Saved data and logs must stay outside the repository.');
  let current = path.parse(target).root;
  for (const part of target.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || ![0, uid].includes(stat.uid) || (stat.mode & 0o022)) throw new Error('Unsafe private path ownership, permissions or symlink.');
  }
  const stat = fs.lstatSync(target);
  if (stat.uid !== uid || (directory ? !stat.isDirectory() || (stat.mode & 0o777) !== 0o700 : !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077))) throw new Error('Use a private user-owned directory (700) or regular saved file (600).');
}

/** Load category hints only from explicit/local saved data, never production queries. @param {string[]} files Saved paths. @param {number} uid User ID. @returns {Map<string,string>} Categories. @throws {Error} On corrupt saved data. */
function priorCategories(files, uid) {
  const prior = new Map();
  for (const file of files) {
    privatePath(file, uid, false);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(data) ? data : data?.deals;
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.product_code !== 'string' || !row.product_code.trim() || typeof row.category !== 'string' || !row.category.trim())) throw new Error('Malformed prior saved category file.');
    for (const row of rows) prior.set(row.product_code, row.category);
  }
  return prior;
}

/** Write a new private artifact without clobbering an existing path. @param {string} file Path. @param {*} data JSON or text. @returns {void} */
function save(file, data) { fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }

/** Execute the existing GitHub CLI authentication context without shell evaluation or secret environment inheritance. @param {string[]} args CLI arguments. @returns {object} Exit status. */
function github(args) {
  return spawnSync('gh-axi', [...args, '--repo', 'hkonnection/price-scraper'], { encoding: 'utf8', stdio: 'pipe',
    env: { HOME: os.homedir(), PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + path.join(os.homedir(), '.local', 'bin') }, timeout: 120000 });
}

/** Capture a complete set under an exclusive local lock, validate with the saved publisher, then upload/dispatch exactly once. @param {object} options Validated options. @param {object} overrides Offline dependency injection, not CLI flags. @returns {Promise<object>} Saved set and dispatch details. @throws {Error} On any incomplete capture, unsafe state or uncertain remote operation; never retries. */
export async function runDaily(options, overrides = {}) {
  const r = { now: () => new Date(), platform: process.platform, uid: process.getuid?.(), capture: collectSection,
    launch: async settings => (await import('playwright')).chromium.launch(settings), github, emit: console.log, ...overrides };
  if (!options || typeof options.publish !== 'boolean' || !Array.isArray(options.priorFiles)) throw new Error('Invalid daily command options.');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(r.now());
  if (day < '2026-10-11') throw new Error('Daily collection cannot start before October 11, 2026, Pacific time.');
  if (r.platform !== 'darwin' || !r.uid || Number(process.versions.node.split('.')[0]) < 20) throw new Error('Use Node 20 or newer as a normal logged-in macOS desktop user.');
  privatePath(options.outputDir, r.uid, true);
  if (options.publish) {
    const workflow = r.workflowText ?? fs.readFileSync(WORKFLOW, 'utf8');
    if (!/^\s+captured_at:\s*$/m.test(workflow)) throw new Error('The saved workflow capture-time change must be installed before daily publication.');
  }
  const latest = path.join(options.outputDir, 'latest.json');
  const prior = priorCategories([...(fs.existsSync(latest) ? [latest] : []), ...options.priorFiles], r.uid);
  const lock = path.join(options.outputDir, 'run.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('Daily capture is busy or run.lock needs operator verification. No process was killed.'); }
  let browser, directory, log;
  try {
    const id = r.now().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    directory = path.join(options.outputDir, 'capture-' + id);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(path.join(directory, 'raw'), { mode: 0o700 });
    log = fs.openSync(path.join(directory, 'run.log'), 'wx', 0o600);
    /** Emit metrics to durable private output and the caller. @param {string} text Diagnostic. @returns {void} */
    function emit(text) { fs.writeSync(log, text + '\n'); r.emit(text); }
    emit(`Started ${r.now().toISOString()} ordinary headed Chrome; counts are observed cards, not advertised coverage.`);
    browser = await r.launch({ channel: 'chrome', headless: false });
    const page = await browser.newPage();
    const captures = []; let capturedAt;
    for (const section of SECTIONS) {
      const html = await r.capture(page, section);
      capturedAt = r.now().toISOString();
      const stem = section.name.toLowerCase();
      save(path.join(directory, 'raw', stem + '.html'), html);
      const capture = parseGrid(html, section.name, capturedAt, prior);
      captures.push(capture);
      save(path.join(directory, 'raw', stem + '.json'), capture.raw);
      emit(`${section.name} ${JSON.stringify(capture.stats)}`);
    }
    await browser.close(); browser = null;
    const { payload, stats } = combineSections(captures, capturedAt);
    fs.mkdirSync(path.join(directory, 'publish'), { mode: 0o700 });
    const publishFile = path.join(directory, 'publish', 'combined.json');
    save(publishFile, payload);
    const submittedTotal = loadDeals(publishFile).length;
    if (submittedTotal !== payload.totalProducts) throw new Error('Saved publisher submitted-count mismatch.');
    const releaseTag = 'lulu-grid-' + id;
    const manifest = { captured_at: capturedAt, submitted_total: submittedTotal, sections: stats, release_tag: releaseTag, status: 'captured' };
    save(path.join(directory, 'manifest.json'), manifest);
    emit(`Complete ${JSON.stringify(stats)} submitted_total=${submittedTotal} captured_at=${capturedAt}`);
    const candidate = path.join(directory, 'latest.json'); save(candidate, payload);
    if (fs.existsSync(latest)) privatePath(latest, r.uid, false);
    fs.renameSync(candidate, latest);
    if (options.publish) {
      /** Run one checked remote step, suppressing remote bodies and never retrying uncertain writes. @param {string[]} args GitHub command. @returns {Promise<void>} Completion. @throws {Error} On failure. */
      async function checked(args) {
        const result = await r.github(args);
        if (result?.error || result?.status !== 0) throw new Error('GitHub saved publication failed or is uncertain. Inspect release/workflow state before any manual retry.');
      }
      manifest.status = 'dispatching'; fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      await checked(['release', 'create', releaseTag, '--target', 'main', '--latest=false', '--title', 'Lululemon complete grid capture', '--notes', 'Complete Canadian Women, Men and Accessories saved grid snapshot.']);
      await checked(['release', 'upload', releaseTag, publishFile]);
      await checked(['workflow', 'run', 'publish-lululemon.yml', '--ref', 'main', '--field', `release_tag=${releaseTag}`, '--field', 'asset_names=combined.json', '--field', 'dry_run=false', '--field', `captured_at=${capturedAt}`]);
      manifest.status = 'dispatched'; fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      emit('One complete saved set dispatched. Persisted-count check runs in GitHub; remote completion is not yet verified.');
    } else emit('Local capture complete: no GitHub dispatch or database call.');
    return { directory, publishFile, payload, stats, releaseTag, capturedAt };
  } catch (error) {
    if (log !== undefined) fs.writeSync(log, 'Stopped: capture/publication failed. No automatic retry. Inspect saved state before any manual retry.\n');
    throw error;
  } finally {
    try { if (browser) await browser.close(); }
    finally { if (log !== undefined) fs.closeSync(log); fs.rmdirSync(lock); }
  }
}

/** Exercise the exact CLI argument vector with injectable offline dependencies. @param {string[]} argv Arguments. @param {object} overrides Offline dependencies. @returns {Promise<object>} Capture result. @throws {Error} On validation, capture or dispatch failure. */
export async function main(argv, overrides = {}) { return runDaily(parseArgs(argv), overrides); }

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`Daily collection stopped: ${error.code || error instanceof SyntaxError ? 'Check private paths and saved inputs.' : error.message}`); process.exitCode = 1; }
}
