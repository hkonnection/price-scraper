import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, parseCredentials, makePlist, hostZone } from './lululemon-macos.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = process.env.LULU_TEST_ARTIFACTS || fs.mkdtempSync(path.join(os.homedir(), '.lulu-offline-'));
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const credentials = {
  CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'SYNTHETIC_INVALID_TOKEN_NEVER_USE_000000000',
  CLOUDFLARE_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000000',
};
const envText = Object.entries(credentials).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
let serial = 0;

/** Create a private synthetic home, offline scraper graph and fake system tools. @returns {object} Test runtime and state. */
function fixture() {
  const base = fs.mkdtempSync(path.join(artifacts, `case-${++serial}-`));
  const repo = path.join(base, 'repo with spaces');
  const home = path.join(base, 'home with spaces');
  fs.mkdirSync(path.join(repo, 'scraper/src/scrapers'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scraper/src/cleaners'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scraper/src/db'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scraper/local'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(path.join(repo, 'scraper/package.json'), '{"type":"module"}');
  for (const file of ['lululemon-index.js', 'scrapers/lululemon.js', 'cleaners/index.js', 'cleaners/lululemon.js']) {
    fs.copyFileSync(path.join(sourceRoot, 'scraper/src', file), path.join(repo, 'scraper/src', file));
  }
  fs.copyFileSync(new URL('./lululemon-macos.mjs', import.meta.url), path.join(repo, 'scraper/local/lululemon-macos.mjs'));
  const control = path.join(base, 'control.json');
  fs.writeFileSync(control, JSON.stringify({ mode: 'happy' }));
  const trace = path.join(base, 'trace.jsonl');
  const packageDir = path.join(repo, 'scraper/node_modules/playwright');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), '{"type":"module","main":"index.js"}');
  // This browser never opens a socket. The actual collector and entrypoint are copied unchanged.
  fs.writeFileSync(path.join(packageDir, 'index.js'), `
import fs from 'node:fs';
import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
const denied=()=>{throw new Error('Network denied in synthetic browser');};
globalThis.fetch=denied; net.Socket.prototype.connect=denied; http.request=denied; https.request=denied;
globalThis.setTimeout=(fn)=>{queueMicrotask(fn);return 0;};
const control = ${JSON.stringify(control)}, trace = ${JSON.stringify(trace)};
export const chromium = { async launch(options) {
  const {mode} = JSON.parse(fs.readFileSync(control));
  fs.appendFileSync(trace, JSON.stringify({kind:'browser',options,argv:process.argv,env:process.env})+'\\n');
  if (mode === 'hold') await new Promise(resolve => { const timer = setInterval(() => { if (JSON.parse(fs.readFileSync(control)).mode !== 'hold') { clearInterval(timer); resolve(); } }, 20); });
  const product = {productOnSale:true,productId:'synthetic-1',displayName:'Synthetic Test Shirt',listPrice:[100],productSalePrice:[50],pdpUrl:'/p/synthetic',parentCategoryUnifiedId:'shirt'};
  const data = {props:{pageProps:{dehydratedState:{queries:[{queryKey:['CategoryPageDataQuery'],state:{data:{pages:[{products:mode==='empty'?[]:[product],totalProductPages:1}]}}}]}}}};
  globalThis.document = {getElementById:()=>({textContent:JSON.stringify(data)}),body:{innerText:'Synthetic refusal'}};
  const page = { async goto(url){ if(mode==='exit7') process.exit(7); return {ok:()=>mode!=='refused',status:()=>403,url:()=>url}; },
    async waitForSelector(){}, async evaluate(fn,args){return fn(args);}, url:()=> 'https://shop.lululemon.com/en-ca/',
    async $$eval(){return [];}, async title(){return 'Synthetic refusal';} };
  return {async newContext(){return {async newPage(){return page;}};},async close(){fs.appendFileSync(trace,JSON.stringify({kind:'closed'})+'\\n');}};
}};
`);
  fs.writeFileSync(path.join(repo, 'scraper/src/db/d1.js'), `
import fs from 'node:fs';
export async function pushToD1(deals) {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({kind:'fake-publish',count:deals.length,env:process.env})+'\\n');
  console.error('Synthetic reflected credentials: '+Object.entries(process.env).filter(([k])=>k.startsWith('CLOUDFLARE_')).map(([,v])=>v).join(' '));
  if (JSON.parse(fs.readFileSync(${JSON.stringify(control)})).mode === 'interleave') {
    const token=process.env.CLOUDFLARE_API_TOKEN;
    process.stdout.write(token.slice(0,20));
    await new Promise(resolve=>setImmediate(resolve));
    process.stderr.write('interleaved diagnostic\\n');
    await new Promise(resolve=>setImmediate(resolve));
    process.stdout.write(token.slice(20)+'\\n');
  }
}
`);
  const preload = path.join(base, 'deny-network.mjs');
  fs.writeFileSync(preload, `import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
const denied=()=>{throw new Error('Network denied in offline fixture');};
globalThis.fetch=denied; net.Socket.prototype.connect=denied; http.request=denied; https.request=denied;
globalThis.setTimeout=(fn)=>{queueMicrotask(fn);return 0;};`);
  const node = path.join(base, 'node with spaces');
  fs.writeFileSync(node, `#!/bin/sh\nexec '${process.execPath}' --import '${preload}' "$@"\n`, { mode: 0o700 });
  const chrome = path.join(base, 'Google Chrome');
  fs.writeFileSync(chrome, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const credentialFile = path.join(base, 'private.env');
  fs.writeFileSync(credentialFile, envText, { mode: 0o600 });
  fs.writeFileSync(path.join(repo, '.github/workflows/scrape-lululemon.yml'), 'on:\n  workflow_dispatch:\n');
  const calls = [], output = [];
  const state = { loaded: false, pid: '-', failBootstrap: false, invalid: false, gui: true, failBootout: false };
  /** Simulate launchctl and plist validation without contacting actual launchd. @returns {object} Exit and output. */
  function system(executable, args) {
    calls.push([executable, ...args]);
    if (executable.endsWith('plutil')) {
      if (state.invalid && args[0] === '-lint') return { status: 1, stdout: '', stderr: 'Synthetic invalid plist' };
      if (args[0] === '-convert') {
        const text = fs.readFileSync(args.at(-1), 'utf8');
        const label = text.match(/<key>Label<\/key>\s*<string>(.*?)<\/string>/)?.[1];
        return { status: 0, stdout: JSON.stringify({ Label: label }), stderr: '' };
      }
      return { status: 0, stdout: 'OK', stderr: '' };
    }
    if (args[0] === 'print') return { status: state.gui ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'list') return { status: 0, stdout: `PID\tStatus\tLabel\n${state.loaded ? `${state.pid}\t0\tcom.price-scraper.lululemon\n` : ''}`, stderr: '' };
    if (args[0] === 'bootout') { if (state.failBootout) return { status: 1, stdout: '', stderr: '' }; state.loaded = false; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'bootstrap') {
      if (state.failBootstrap) { state.failBootstrap = false; return { status: 5, stdout: '', stderr: '' }; }
      state.loaded = true; return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error('Unexpected system command');
  }
  return { base, repo, home, node, chrome, credentialFile, calls, output, state, trace, control,
    runtime: { repo, home, node, chrome, platform: 'darwin', uid: process.getuid(), zone: 'America/Los_Angeles', system, checkAcl: () => true, emit: s => output.push(s) } };
}

/** Read recorded synthetic events. @param {object} f Fixture. @returns {Array<object>} Events. */
function events(f) { return fs.existsSync(f.trace) ? fs.readFileSync(f.trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
/** Find the installed plist. @param {object} f Fixture. @returns {string} Plist path. */
function plist(f) { return path.join(f.home, 'Library/LaunchAgents/com.price-scraper.lululemon.plist'); }
/** Check private log and lock state after a completed operation. @param {object} f Fixture. @returns {void} */
function cleanState(f) {
  const state = path.join(f.home, 'Library/Application Support/price-scraper/lululemon');
  assert.equal(fs.existsSync(path.join(state, 'run.lock')), false);
  if (fs.existsSync(state)) {
    assert.equal(fs.statSync(state).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(state)) assert.equal(fs.statSync(path.join(state, name)).mode & 0o777, 0o600);
  }
}

test('argument and credential boundaries', () => {
  assert.equal(parseArgs([]).publish, false);
  assert.equal(parseArgs(['--dry-run']).publish, false);
  assert.equal(parseArgs(['--publish', '--credentials', '/private/test.env']).publish, true);
  for (const args of [['--dry-run', '--publish'], ['--credentials'], ['--bogus'], ['run', '--install'], ['--credentials', 'relative.env']]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseCredentials(envText), credentials);
  for (const text of ['', envText + 'UNEXPECTED=value\n', envText + 'CLOUDFLARE_API_TOKEN=duplicate\n', envText.replace(credentials.CLOUDFLARE_API_TOKEN, '"multiline\nvalue"'), envText.replace(credentials.CLOUDFLARE_API_TOKEN, '$(touch /tmp/should-not-exist)'), envText.replace(credentials.CLOUDFLARE_ACCOUNT_ID, 'wrong'), envText.replace(credentials.CLOUDFLARE_D1_DATABASE_ID, 'wrong'), envText + '\0', envText.replace('CLOUDFLARE_API_TOKEN=', 'export CLOUDFLARE_API_TOKEN='), envText.replace(credentials.CLOUDFLARE_API_TOKEN, 'short')]) assert.throws(() => parseCredentials(text));
});

test('command defaults and explicit dry run use visible ordinary Chrome without credentials', async () => {
  for (const args of [[], ['--dry-run']]) {
    const f = fixture();
    assert.equal(await main(args, f.runtime), 0);
    assert.equal(events(f).filter(e => e.kind === 'fake-publish').length, 0);
    assert.deepEqual(events(f)[0].options, { headless: false, channel: 'chrome' });
    assert.match(f.output.join('\n'), /Would have pushed \d+ deals/);
    assert.equal(Object.keys(events(f)[0].env).some(k => k.startsWith('CLOUDFLARE_')), false);
    assert.equal(f.calls.length, 0);
    cleanState(f);
  }
});

test('explicit fake publication isolates inherited settings and masks reflected secrets', async () => {
  const f = fixture();
  const conflicts = { CLOUDFLARE_API_TOKEN: 'INHERITED_CONFLICT', NODE_OPTIONS: '--import=/untrusted', DOTENV_CONFIG_PATH: '/untrusted.env', LULULEMON_VISIBLE_CHROME: '0', PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/untrusted' };
  const previous = Object.fromEntries(Object.keys(conflicts).map(key => [key, process.env[key]]));
  Object.assign(process.env, conflicts);
  fs.writeFileSync(path.join(f.repo, '.env'), 'CLOUDFLARE_API_TOKEN=REPO_CONFLICT');
  try { assert.equal(await main(['--publish', '--credentials', f.credentialFile], f.runtime), 0); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const publication = events(f).find(e => e.kind === 'fake-publish');
  assert.ok(publication.count > 0);
  Object.entries(credentials).forEach(([k, v]) => assert.equal(publication.env[k], v));
  for (const k of ['NODE_OPTIONS', 'DOTENV_CONFIG_PATH', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']) assert.equal(publication.env[k], undefined);
  const text = f.output.join('\n') + fs.readFileSync(path.join(f.home, 'Library/Application Support/price-scraper/lululemon/run.log'));
  Object.values(credentials).forEach(v => assert.equal(text.includes(v), false));
  assert.match(text, /\[redacted\]/);
  assert.equal(text.includes('INHERITED_CONFLICT'), false);
  cleanState(f);
});

test('interleaved output cannot expose any credential fragment', async () => {
  const f = fixture(); fs.writeFileSync(f.control, '{"mode":"interleave"}');
  assert.equal(await main(['--publish', '--credentials', f.credentialFile], f.runtime), 0);
  const text = f.output.join('\n');
  assert.equal(text.includes(credentials.CLOUDFLARE_API_TOKEN.slice(0, 20)), false);
  assert.equal(text.includes(credentials.CLOUDFLARE_API_TOKEN.slice(20)), false);
  cleanState(f);
});

test('refused, empty and explicit child exit codes propagate without fake publication', async () => {
  for (const [mode, exit, message] of [['refused', 1, /HTTP 403/], ['empty', 1, /empty/i], ['exit7', 7, /exit=7/]]) {
    const f = fixture(); fs.writeFileSync(f.control, JSON.stringify({ mode }));
    assert.equal(await main([], f.runtime), exit);
    assert.match(f.output.join('\n'), message);
    assert.equal(events(f).some(e => e.kind === 'fake-publish'), false);
    cleanState(f);
  }
});

test('unsafe credentials and log destinations refuse before browser start', async () => {
  for (const attack of ['missing', 'permissions', 'repo', 'symlink', 'directory', 'malformed', 'parent-symlink', 'hardlink', 'log-symlink', 'state-repo', 'wrong-owner', 'writable-parent', 'log-permissions']) {
    const f = fixture(); let file = f.credentialFile;
    if (attack === 'missing') file += '.missing';
    if (attack === 'permissions') fs.chmodSync(file, 0o644);
    if (attack === 'repo') { file = path.join(f.repo, 'private.env'); fs.writeFileSync(file, envText, { mode: 0o600 }); }
    if (attack === 'symlink') { file += '.link'; fs.symlinkSync(f.credentialFile, file); }
    if (attack === 'directory') file = f.base;
    if (attack === 'malformed') fs.writeFileSync(file, envText + 'evil=$HOME\n');
    if (attack === 'parent-symlink') { fs.symlinkSync(f.base, path.join(f.home, 'link')); file = path.join(f.home, 'link/private.env'); }
    if (attack === 'hardlink') { fs.linkSync(file, file + '.hardlink'); }
    if (attack === 'log-symlink') { const dir = path.join(f.home, 'Library/Application Support/price-scraper/lululemon'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.symlinkSync(file, path.join(dir, 'run.log')); }
    if (attack === 'state-repo') f.runtime.home = f.repo;
    if (attack === 'wrong-owner') f.runtime.uid++;
    if (attack === 'writable-parent') fs.chmodSync(f.base, 0o777);
    if (attack === 'log-permissions') { const dir = path.join(f.home, 'Library/Application Support/price-scraper/lululemon'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(dir, 'run.log'), 'Synthetic prior log', { mode: 0o600 }); fs.chmodSync(path.join(dir, 'run.log'), 0o644); }
    assert.notEqual(await main(['--publish', '--credentials', file], f.runtime), 0, attack);
    assert.equal(events(f).length, 0, attack);
    Object.values(credentials).forEach(v => assert.equal(f.output.join('\n').includes(v), false));
  }
});

test('extended ACL access is refused before credential read or browser start', async () => {
  const f = fixture();
  f.runtime.checkAcl = target => target !== f.credentialFile;
  assert.equal(await main(['--publish', '--credentials', f.credentialFile], f.runtime), 1);
  assert.equal(events(f).length, 0);
  assert.match(f.output.join('\n'), /ACL|access/i);
});

test('actual macOS allow ACL on a synthetic credential file is refused', async () => {
  if (process.platform !== 'darwin') return;
  const f = fixture(); delete f.runtime.checkAcl;
  const grant = spawnSync('/bin/chmod', ['+a', 'everyone allow read', f.credentialFile], { encoding: 'utf8' });
  assert.equal(grant.status, 0, grant.stderr);
  try {
    assert.equal(await main(['--publish', '--credentials', f.credentialFile], f.runtime), 1);
    assert.equal(events(f).length, 0);
    assert.match(f.output.join('\n'), /ACL/);
  } finally { assert.equal(spawnSync('/bin/chmod', ['-N', f.credentialFile]).status, 0); }
});

test('missing Node, Chrome and Playwright dependencies fail safely', async () => {
  for (const missing of ['node', 'chrome', 'playwright']) {
    const f = fixture();
    fs.rmSync(missing === 'playwright' ? path.join(f.repo, 'scraper/node_modules/playwright') : f[missing], { recursive: true });
    assert.notEqual(await main([], f.runtime), 0);
    assert.equal(events(f).length, 0);
  }
});

test('child spawn failure returns 1 and releases the private lock', async () => {
  const f = fixture();
  fs.writeFileSync(f.node, '#!/nonexistent/synthetic-interpreter\n');
  assert.equal(await main([], f.runtime), 1);
  assert.equal(events(f).length, 0);
  assert.match(f.output.join('\n'), /Cannot start Node child/);
  cleanState(f);
});

test('Pacific schedule is civil time and does not depend on process TZ', () => {
  const f = fixture(); const xml = makePlist({ ...f.runtime, publish: false });
  assert.equal((xml.match(/<key>Weekday<\/key>/g) || []).length, 2);
  assert.match(xml, /<key>Weekday<\/key>\s*<integer>1<\/integer>/);
  assert.match(xml, /<key>Weekday<\/key>\s*<integer>4<\/integer>/);
  assert.equal((xml.match(/<key>Hour<\/key>\s*<integer>8<\/integer>/g) || []).length, 2);
  assert.equal((xml.match(/<key>Minute<\/key>\s*<integer>0<\/integer>/g) || []).length, 2);
  assert.doesNotMatch(xml, /<key>TZ<\/key>|KeepAlive|RunAtLoad|kickstart|UserName|StartInterval/);
  assert.match(xml, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.equal(hostZone('/var/db/timezone/zoneinfo/America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(hostZone('/var/db/timezone/zoneinfo/Etc/UTC'), 'Etc/UTC');
  for (const [utc, hour] of [['2026-01-05T16:00:00Z', '08'], ['2026-07-06T15:00:00Z', '08']]) assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(new Date(utc)), hour);
});

test('preview has no launchctl writes or installed files; incompatible host and missing GUI refuse', async () => {
  const f = fixture(); assert.equal(await main(['setup'], f.runtime), 0);
  assert.equal(fs.existsSync(plist(f)), false); assert.equal(f.calls.length, 0); assert.equal(events(f).length, 0);
  for (const override of [{ zone: 'UTC' }, { zone: 'America/Vancouver' }, { platform: 'linux' }, { uid: 0 }]) assert.notEqual(await main(['setup', '--install'], { ...fixture().runtime, ...override }), 0);
  const noGui = fixture(); noGui.state.gui = false;
  assert.notEqual(await main(['setup', '--install'], noGui.runtime), 0); assert.equal(fs.existsSync(plist(noGui)), false);
});

test('first, repeat and partial install preserve old config and never start a consumer', async () => {
  const f = fixture(); assert.equal(await main(['setup', '--install'], f.runtime), 0);
  const prior = fs.readFileSync(plist(f)); const before = f.calls.length;
  assert.equal(await main(['setup', '--install'], f.runtime), 0);
  assert.equal(f.calls.slice(before).some(c => ['bootstrap', 'bootout'].includes(c[1])), false);
  assert.deepEqual(fs.readFileSync(plist(f)), prior);
  f.state.loaded = false;
  assert.equal(await main(['setup', '--install'], f.runtime), 0);
  assert.equal(f.state.loaded, true);
  f.runtime.node = process.execPath; f.state.failBootstrap = true;
  assert.notEqual(await main(['setup', '--install'], f.runtime), 0);
  assert.deepEqual(fs.readFileSync(plist(f)), prior); assert.equal(f.state.loaded, true);
  f.state.invalid = true;
  const calls = f.calls.length;
  assert.notEqual(await main(['setup', '--install'], f.runtime), 0);
  assert.equal(f.calls.slice(calls).some(c => c[1] === 'bootout'), false);
  assert.deepEqual(fs.readFileSync(plist(f)), prior);
  assert.equal(events(f).length, 0); assert.equal(f.calls.some(c => ['kickstart', 'kill', 'stop'].includes(c[1])), false);
  cleanState(f);
});

test('invalid destination, bootout failure, first-bootstrap failure and rename failure keep prior state', async () => {
  const first = fixture(); first.state.failBootstrap = true;
  assert.equal(await main(['setup', '--install'], first.runtime), 1);
  assert.equal(fs.existsSync(plist(first)), false); assert.equal(first.state.loaded, false); cleanState(first);
  const f = fixture(); assert.equal(await main(['setup', '--install'], f.runtime), 0);
  const prior = fs.readFileSync(plist(f));
  f.runtime.node = process.execPath; f.state.failBootout = true;
  assert.equal(await main(['setup', '--install'], f.runtime), 1);
  assert.equal(f.state.loaded, true); assert.deepEqual(fs.readFileSync(plist(f)), prior);
  f.state.failBootout = false;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === plist(f)) { const error = new Error('Synthetic full disk'); error.code = 'ENOSPC'; throw error; } return rename(from, to); };
  try { assert.equal(await main(['setup', '--install'], f.runtime), 1); } finally { fs.renameSync = rename; }
  assert.equal(f.state.loaded, true); assert.deepEqual(fs.readFileSync(plist(f)), prior); cleanState(f);
  const unrelated = fixture(); fs.mkdirSync(path.dirname(plist(unrelated)), { recursive: true });
  fs.writeFileSync(plist(unrelated), '<plist><dict><key>Label</key><string>com.unrelated.service</string></dict></plist>', { mode: 0o600 });
  assert.equal(await main(['setup', '--install'], unrelated.runtime), 1);
  assert.equal(unrelated.calls.some(c => c[1] === 'bootout'), false);
  const link = fixture(); fs.mkdirSync(path.dirname(plist(link)), { recursive: true }); fs.symlinkSync(link.credentialFile, plist(link));
  assert.equal(await main(['setup', '--install'], link.runtime), 1);
  assert.equal(fs.lstatSync(plist(link)).isSymbolicLink(), true);
  assert.equal(link.calls.some(c => c[1] === 'bootstrap'), false);
});

test('real plutil accepts generated XML with spaces and metacharacters', () => {
  if (process.platform !== 'darwin') return;
  const f = fixture(); const file = path.join(f.base, 'generated.plist');
  fs.writeFileSync(file, makePlist({ ...f.runtime, home: f.home + ' & <test>', publish: false }), { mode: 0o600 });
  const result = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const decoded = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  assert.equal(decoded.status, 0);
  const config = JSON.parse(decoded.stdout);
  assert.equal(config.ProgramArguments[0], f.node);
  assert.equal(config.EnvironmentVariables.HOME, f.home + ' & <test>');
  assert.deepEqual(config.StartCalendarInterval, [{ Weekday: 1, Hour: 8, Minute: 0 }, { Weekday: 4, Hour: 8, Minute: 0 }]);
});

test('busy local lock or active LaunchAgent cannot be replaced or killed', async () => {
  const f = fixture(); assert.equal(await main(['setup', '--install'], f.runtime), 0);
  const prior = fs.readFileSync(plist(f));
  f.state.pid = '12345';
  assert.notEqual(await main(['setup', '--install'], f.runtime), 0);
  assert.deepEqual(fs.readFileSync(plist(f)), prior);
  const locked = fixture(); const lock = path.join(locked.home, 'Library/Application Support/price-scraper/lululemon/run.lock');
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  assert.notEqual(await main([], locked.runtime), 0);
  assert.notEqual(await main(['setup', '--install'], locked.runtime), 0);
  assert.equal(fs.existsSync(lock), true); assert.equal(events(locked).length, 0);
  assert.match(locked.output.join('\n'), /busy|lock/i);
});

test('simultaneous manual and timed consumers refuse while a local run holds the lock', async () => {
  const f = fixture(); fs.writeFileSync(f.control, '{"mode":"hold"}');
  const active = main([], f.runtime);
  try {
    const started = Date.now();
    while (events(f).length === 0 && Date.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(events(f)[0]?.kind, 'browser');
    assert.equal(await main([], f.runtime), 1);
    assert.equal(await main(['setup', '--install'], f.runtime), 1);
    assert.equal(events(f).filter(e => e.kind === 'browser').length, 1);
  } finally { fs.writeFileSync(f.control, '{"mode":"happy"}'); await active; }
  cleanState(f);
});

test('actual copied CLI preserves child refusal and exit codes', () => {
  if (process.platform !== 'darwin') return;
  for (const [mode, expected] of [['happy', 0], ['refused', 1], ['empty', 1], ['exit7', 7]]) {
    const f = fixture(); fs.writeFileSync(f.control, JSON.stringify({ mode }));
    const result = spawnSync(process.execPath, [path.join(f.repo, 'scraper/local/lululemon-macos.mjs'), '--dry-run'], { encoding: 'utf8', env: { HOME: f.home, PATH: '/usr/bin:/bin' } });
    assert.equal(result.status, expected, result.stderr);
    assert.equal(events(f).some(e => e.kind === 'fake-publish'), false);
    cleanState(f);
  }
});

test('timed publication refuses without both removed GitHub calendar and explicit confirmation', async () => {
  const f = fixture(); const args = ['setup', '--install', '--publish', '--credentials', f.credentialFile];
  assert.notEqual(await main(args, f.runtime), 0);
  fs.writeFileSync(path.join(f.repo, '.github/workflows/scrape-lululemon.yml'), 'on:\n  schedule:\n    - cron: "0 16 * * 1,4"\n');
  assert.notEqual(await main([...args, '--github-schedule-off'], f.runtime), 0);
  assert.equal(fs.existsSync(plist(f)), false);
  fs.writeFileSync(path.join(f.repo, '.github/workflows/scrape-lululemon.yml'), 'on:\n  workflow_dispatch:\n');
  assert.equal(await main([...args, '--github-schedule-off'], f.runtime), 0);
  const text = fs.readFileSync(plist(f), 'utf8');
  Object.values(credentials).forEach(v => assert.equal(text.includes(v), false));
  assert.match(text, /--publish/); assert.match(text, /--credentials/); assert.equal(events(f).length, 0);
});

test('CLI rejects malformed flags with nonzero status and no runtime overrides', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./lululemon-macos.mjs', import.meta.url)), '--bad-flag'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /unknown|invalid/i);
});

test('ordered offline operator smoke: happy then negative then state', async t => {
  const happy = fixture(), negative = fixture();
  await t.test('phase 1 happy command and setup consumer', async () => {
    assert.equal(await main([], happy.runtime), 0);
    assert.equal(await main(['setup', '--install'], happy.runtime), 0);
    // Consume the exact plist arguments, with only the fake Node/preload in this isolated home.
    const xml = fs.readFileSync(plist(happy), 'utf8');
    const vector = [...xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"'));
    const result = spawnSync(vector[0], vector.slice(1), { encoding: 'utf8', env: { HOME: happy.home, PATH: '/usr/bin:/bin' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would have pushed \d+ deals/);
    const cleanedRows = Number(result.stdout.match(/Would have pushed (\d+) deals/)[1]);
    assert.ok(cleanedRows > 0);
    console.log(`LOCAL_SMOKE_HAPPY actual copied entrypoint + synthetic browser; generated plist consumer exit=0; syntheticCleanedRows=${cleanedRows}; fakePublishCalls=0; remoteWrites=0`);
  });
  await t.test('phase 2 negative and harder boundary', async () => {
    fs.writeFileSync(negative.control, '{"mode":"empty"}');
    assert.equal(await main([], negative.runtime), 1);
    fs.chmodSync(negative.credentialFile, 0o644);
    assert.equal(await main(['--publish', '--credentials', negative.credentialFile], negative.runtime), 1);
    happy.state.pid = '456'; const prior = fs.readFileSync(plist(happy));
    assert.equal(await main(['setup', '--install'], happy.runtime), 1);
    assert.deepEqual(fs.readFileSync(plist(happy)), prior);
    assert.equal(await main(['setup', '--install'], { ...negative.runtime, zone: 'UTC' }), 1);
    // Harder after clean rejection checks: fail validation, then fail replacement after bootout.
    happy.state.pid = '-'; happy.state.invalid = true;
    assert.equal(await main(['setup', '--install'], happy.runtime), 1);
    assert.deepEqual(fs.readFileSync(plist(happy)), prior);
    happy.state.invalid = false; happy.runtime.node = process.execPath; happy.state.failBootstrap = true;
    assert.equal(await main(['setup', '--install'], happy.runtime), 1);
    assert.equal(happy.state.loaded, true);
    assert.deepEqual(fs.readFileSync(plist(happy)), prior);
    console.log('LOCAL_SMOKE_NEGATIVE empty=1 unsafeCredentials=1 activePublisher=1 wrongZone=1 invalidReplacement=1 bootstrapFailure=1; priorPlistPreserved=true rollbackLoaded=true noKill=true');
  });
  await t.test('phase 3 state verification', () => {
    cleanState(happy); cleanState(negative);
    assert.equal(events(happy).filter(e => e.kind === 'fake-publish').length, 0);
    assert.equal(events(negative).filter(e => e.kind === 'fake-publish').length, 0);
    assert.equal(happy.calls.every(c => !['kill', 'kickstart', 'stop'].includes(c[1])), true);
    assert.equal(fs.existsSync(plist(negative)), false);
    console.log('LOCAL_SMOKE_STATE locksRemoved=true logsPrivate=true priorConfigPreserved=true actualLaunchdWrites=0 remoteWrites=0 syntheticOnly=true');
  });
});
