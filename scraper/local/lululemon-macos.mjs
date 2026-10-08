#!/usr/bin/env node
/** Local visible-Chrome command and logged-in-user calendar setup. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.price-scraper.lululemon';
const SCRIPT = fileURLToPath(import.meta.url);
const KEYS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_D1_DATABASE_ID'];

/** Parse a small non-shell command interface. @param {string[]} argv Arguments. @returns {object} Options. @throws {Error} On invalid arguments. */
export function parseArgs(argv) {
  const args = [...argv];
  const command = ['run', 'setup'].includes(args[0]) ? args.shift() : 'run';
  const options = { command, publish: false, install: false, githubScheduleOff: false };
  const seen = new Set();
  while (args.length) {
    const arg = args.shift();
    if (seen.has(arg)) throw new Error('Duplicate argument.');
    seen.add(arg);
    if (arg === '--publish') options.publish = true;
    else if (arg === '--dry-run') options.dry = true;
    else if (arg === '--install' && command === 'setup') options.install = true;
    else if (arg === '--github-schedule-off' && command === 'setup') options.githubScheduleOff = true;
    else if (arg === '--credentials') {
      options.credentials = args.shift();
      if (!options.credentials || !path.isAbsolute(options.credentials) || /[\x00-\x1f\x7f]/.test(options.credentials)) throw new Error('Credentials need an absolute private file path.');
    } else throw new Error('Unknown or invalid argument. Use run [--dry-run] or run --publish --credentials /private/file; setup [--install].');
  }
  if (options.publish && options.dry) throw new Error('Choose either --dry-run or --publish.');
  if (options.publish && !options.credentials) throw new Error('--publish requires --credentials /private/file.');
  if (!options.publish && options.credentials) throw new Error('No-write mode must not read credentials. Remove --credentials.');
  return options;
}

/** Parse exactly three single-line assignments, never shell code. @param {string} text Private file data. @returns {object} Validated credential values. @throws {Error} On malformed or incomplete input, without reflecting it. */
export function parseCredentials(text) {
  const values = {};
  if (Buffer.byteLength(text) > 4096 || /[^\x09\x0a\x0d\x20-\x7e]/.test(text)) throw new Error('Credential file is malformed.');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(/^(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|CLOUDFLARE_D1_DATABASE_ID)=([A-Za-z0-9_-]+)$/);
    if (!match || Object.hasOwn(values, match[1])) throw new Error('Credential file is malformed. Use three unquoted KEY=value lines.');
    values[match[1]] = match[2];
  }
  if (!/^[a-f0-9]{32}$/i.test(values.CLOUDFLARE_ACCOUNT_ID || '') ||
      !/^[A-Za-z0-9_-]{40,200}$/.test(values.CLOUDFLARE_API_TOKEN || '') ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(values.CLOUDFLARE_D1_DATABASE_ID || '') ||
      Object.keys(values).length !== KEYS.length) throw new Error('Credentials are incomplete or invalid. Check the three required values privately.');
  return values;
}

/** Read the host zone from the system link, not an inherited TZ setting. @param {string} link /etc/localtime link target. @returns {string} IANA zone. @throws {Error} On unknown system configuration. */
export function hostZone(link) {
  const match = link.match(/\/zoneinfo\/(.+)$/);
  if (!match) throw new Error('Cannot verify the host timezone. Check System Settings before setup.');
  return match[1];
}

/** Check macOS extended permissions without reading file contents. Deny entries are allowed, but allow entries are refused. @param {string} target Existing path. @returns {boolean} True only when ls succeeds and no extended allow access exists. */
function privateAcl(target) {
  const result = spawnSync('/bin/ls', ['-lde', target], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  return !result.error && result.status === 0 && !/^\s*\d+:.*\ballow\b/m.test(result.stdout);
}

/** Reject unsafe path components and paths inside this checkout. @param {string} target Absolute path. @param {object} r Runtime. @param {boolean} missing Allow absent final components. @returns {void} @throws {Error} On symlinks, untrusted ownership or writable ancestors. */
function trustedPath(target, r, missing = false) {
  if (!path.isAbsolute(target) || path.normalize(target) !== target || /[\x00-\x1f\x7f]/.test(target)) throw new Error('Unsafe path. Use a normalized absolute path.');
  const relative = path.relative(r.repo, target);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Private files and state must stay outside the repository.');
  const pieces = target.split(path.sep).filter(Boolean);
  let current = path.parse(target).root;
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (missing && error.code === 'ENOENT') return; throw new Error('Required private path is missing or inaccessible.'); }
    if (stat.isSymbolicLink() || ![0, r.uid].includes(stat.uid) || (stat.mode & 0o022)) throw new Error('Unsafe path ownership, permissions or symlink.');
    if (!r.checkAcl(current)) throw new Error('Extended ACL access is unsafe or cannot be verified. Select a private path and retry.');
    const repoStat = fs.statSync(r.repo);
    if (stat.isDirectory() && stat.dev === repoStat.dev && stat.ino === repoStat.ino) throw new Error('Private files and state must stay outside the repository.');
    if (i < pieces.length - 1 && !stat.isDirectory()) throw new Error('Unsafe parent path.');
  }
}

/** Validate a private regular file without following a link. @param {string} target File path. @param {object} r Runtime. @returns {void} @throws {Error} On unsafe file metadata. */
function privateFile(target, r) {
  trustedPath(target, r);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.uid !== r.uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error('Private files must be owned by this user, have one link and mode 600.');
}

/** Read only a selected safe credential file. @param {string} target File path. @param {object} r Runtime. @returns {object} Credentials. @throws {Error} On unsafe or malformed input. */
function readCredentials(target, r) {
  privateFile(target, r);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.uid !== r.uid || stat.nlink !== 1 || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error('Credential file is unsafe or too large.');
    return parseCredentials(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

/** Create or validate a private external directory. @param {string} dir Directory. @param {object} r Runtime. @returns {void} */
function privateDirectory(dir, r) {
  trustedPath(dir, r, true);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  trustedPath(dir, r);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== r.uid || (stat.mode & 0o777) !== 0o700) throw new Error('Local state directory must be owned by this user with mode 700.');
}

/** Open a safe append-only log after validating any existing file. @param {string} file Log path. @param {object} r Runtime. @returns {number} Open descriptor. */
function openLog(file, r) {
  trustedPath(file, r, true);
  if (fs.existsSync(file)) privateFile(file, r);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.uid !== r.uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) { fs.closeSync(fd); throw new Error('Unsafe log file.'); }
  return fd;
}

/** Hold one local run/setup lock. Never steal it or kill its owner. @param {object} r Runtime. @param {Function} action Protected operation. @returns {Promise<number>} Exit status. */
async function withLock(r, action) {
  privateDirectory(r.stateDir, r);
  const lock = path.join(r.stateDir, 'run.lock');
  trustedPath(lock, r, true);
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Local publisher or setup is busy. Wait and retry. For a stale run.lock, confirm Node and Chrome have exited before removing only that empty lock directory.');
    throw new Error('Cannot acquire the private local lock.');
  }
  try { return await action(); } finally { fs.rmdirSync(lock); }
}

/** Validate the fixed runtime dependencies before running or installing. @param {object} r Runtime. @returns {void} @throws {Error} On missing prerequisites. */
function prerequisites(r) {
  if (r.platform !== 'darwin' || r.uid === 0) throw new Error('Use a normal logged-in macOS user, not root or a system daemon.');
  for (const [name, file] of [['Node', r.node], ['ordinary Google Chrome', r.chrome]]) {
    try { if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error(); fs.accessSync(file, fs.constants.X_OK); } catch { throw new Error(`${name} is missing or not executable. Fix its installation before retrying.`); }
  }
  try { createRequire(path.join(r.repo, 'scraper/src/lululemon-index.js')).resolve('playwright'); fs.accessSync(path.join(r.repo, 'scraper/src/lululemon-index.js')); } catch { throw new Error('Scraper entrypoint or Playwright is missing. Run npm ci in the durable checkout before retrying.'); }
}

/** Escape one XML string without invoking a shell. @param {string} value Text. @returns {string} XML-safe text. */
function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }

/** Generate a user LaunchAgent with two host-local civil-time calendar entries. @param {object} r Runtime and selected mode. @returns {string} Plist XML without credential values. */
export function makePlist(r) {
  const stateDir = r.stateDir || path.join(r.home, 'Library/Application Support/price-scraper/lululemon');
  const args = [r.node, path.join(r.repo, 'scraper/local/lululemon-macos.mjs'), 'run', r.publish ? '--publish' : '--dry-run'];
  if (r.publish) args.push('--credentials', r.credentials);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(r.repo)}</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(r.home)}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string><key>NODE_OPTIONS</key><string></string><key>NODE_PATH</key><string></string></dict>
<key>StartCalendarInterval</key><array>${[1, 4].map(day => `<dict><key>Weekday</key><integer>${day}</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>`).join('')}</array>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(stateDir, 'launcher.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(stateDir, 'launcher.log'))}</string>
</dict></plist>
`;
}

/** Run a system tool with checked exit status and bounded generic errors. @param {object} r Runtime. @param {string} tool Absolute tool. @param {string[]} args Arguments. @returns {string} Standard output. @throws {Error} On tool failure. */
function checked(r, tool, args) {
  const result = r.system(tool, args);
  if (result.error || result.status !== 0) throw new Error(`${path.basename(tool)} ${args[0]} failed. Prior configuration is preserved. Check local prerequisites and retry.`);
  return String(result.stdout || '');
}

/** Read the stable legacy list table for only this label. @param {object} r Runtime. @returns {object|null} Loaded service PID. @throws {Error} On unreadable or unexpected status. */
function service(r) {
  const rows = checked(r, '/bin/launchctl', ['list']).trim().split('\n');
  if (!/^PID\s+Status\s+Label$/.test(rows.shift() || '')) throw new Error('Cannot verify LaunchAgent status. No agent was changed.');
  const matches = rows.map(row => row.trim().split(/\s+/)).filter(row => row[2] === LABEL);
  if (matches.length > 1 || (matches[0] && !/^(?:-|\d+)$/.test(matches[0][0]))) throw new Error('Cannot verify this LaunchAgent status.');
  return matches[0] ? { active: matches[0][0] !== '-', pid: matches[0][0] } : null;
}

/** Reload an inactive job from a validated candidate, keeping the prior file until bootstrap succeeds. A loaded job needs a recoverable prior disk plist. @param {object} r Runtime. @returns {Promise<number>} Exit status. @throws {Error} On busy state, missing prior configuration or failed replacement. */
async function install(r) {
  return withLock(r, async () => {
    checked(r, '/bin/launchctl', ['print', `gui/${r.uid}`]);
    const dir = path.join(r.home, 'Library/LaunchAgents');
    trustedPath(dir, r, true);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${LABEL}.plist`);
    trustedPath(target, r, true);
    const priorExists = fs.existsSync(target);
    if (priorExists) {
      privateFile(target, r);
      const prior = JSON.parse(checked(r, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', target]));
      if (prior.Label !== LABEL) throw new Error('Existing plist has another label. No agent was changed.');
    }
    const loaded = service(r);
    if (loaded?.active) throw new Error('LaunchAgent is active. Wait for it to finish, then retry. No process was killed.');
    if (loaded && !priorExists) throw new Error('LaunchAgent is loaded but its prior plist is missing. No agent was changed. Restore its validated prior plist, then retry setup. Do not publish to recover.');
    const text = makePlist(r);
    const candidate = path.join(r.stateDir, `candidate-${process.pid}.plist`);
    fs.writeFileSync(candidate, text, { flag: 'wx', mode: 0o600 });
    try {
      checked(r, '/usr/bin/plutil', ['-lint', candidate]);
      // Disk equality cannot prove loaded arguments. Reload only while the shared lock is held.
      if (loaded) checked(r, '/bin/launchctl', ['bootout', `gui/${r.uid}/${LABEL}`]);
      try {
        checked(r, '/bin/launchctl', ['bootstrap', `gui/${r.uid}`, candidate]);
        fs.renameSync(candidate, target);
      } catch {
        // Only this label can be rolled back. Refuse any unexpected active process.
        const partial = service(r);
        if (partial?.active) throw new Error('Replacement has an active process. Disk configuration was not replaced. Wait for completion and rerun setup. No process was killed.');
        if (partial) checked(r, '/bin/launchctl', ['bootout', `gui/${r.uid}/${LABEL}`]);
        if (loaded) {
          checked(r, '/bin/launchctl', ['bootstrap', `gui/${r.uid}`, target]);
          if (!service(r)) throw new Error('Rollback did not load the prior disk plist. It remains on disk. Verify this label and retry setup; do not publish to recover.');
          throw new Error('Replacement failed. The prior disk plist was reloaded; its previous in-memory arguments were not verified. Check its mode and retry setup.');
        }
        throw new Error('Replacement failed. No prior loaded job was restored. Existing disk configuration was not replaced. Fix prerequisites and retry setup.');
      }
      r.emit('LaunchAgent installed. Monday and Thursday 08:00 host Pacific civil time. Setup did not start a collection.');
      return 0;
    } finally { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); }
  });
}

/** Run the existing scraper in a clean environment and redact before emitting output. @param {object} r Runtime. @param {object} secrets Selected credentials or empty data. @returns {Promise<number>} Exact child exit code, or nonzero spawn/signal failure. */
async function collect(r, secrets) {
  return withLock(r, async () => {
    const fd = openLog(path.join(r.stateDir, 'run.log'), r);
    /** Emit only sanitized text to the private log and terminal. @param {string} text Output. @returns {void} */
    function emit(text) {
      for (const value of Object.values(secrets)) text = text.split(value).join('[redacted]');
      fs.writeSync(fd, text + '\n'); r.emit(text);
    }
    try {
      emit(`${new Date().toISOString()} mode=${r.publish ? 'publish' : 'no-write'} visibleChrome=true`);
      const args = ['--experimental-vm-modules', path.join(r.repo, 'scraper/src/lululemon-index.js')];
      if (!r.publish) args.push('--dry-run');
      // No dotenv, inherited credentials, NODE_OPTIONS or browser customizations.
      const env = { HOME: r.home, PATH: `${path.dirname(r.node)}:/usr/bin:/bin:/usr/sbin:/sbin`, LULULEMON_VISIBLE_CHROME: '1', ...secrets };
      const child = spawn(r.node, args, { cwd: r.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise(resolve => {
        child.once('error', () => { stderr += '\nCannot start Node child. Check its executable path.\n'; });
        child.once('close', (exit, signal) => resolve(signal || exit === null || exit < 0 ? 1 : exit));
      });
      // Keep streams separate: interleaved stderr must not split a stdout secret before redaction.
      if (stdout) emit(stdout.trimEnd());
      if (stderr) emit(stderr.trimEnd());
      emit(`Scraper exit=${code}`);
      return code;
    } finally { fs.closeSync(fd); }
  });
}

/** Execute the operator interface. Runtime injection is for isolated offline tests only, not CLI flags or environment overrides. @param {string[]} argv Arguments. @param {object} overrides Synthetic test boundaries. @returns {Promise<number>} Process status. */
export async function main(argv, overrides = {}) {
  const r = { repo: path.resolve(path.dirname(SCRIPT), '../..'), home: os.homedir(), node: fs.realpathSync(process.execPath),
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', platform: process.platform, uid: process.getuid?.(),
    system: (tool, args) => spawnSync(tool, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() } }),
    checkAcl: privateAcl, emit: text => console.log(text), ...overrides };
  try {
    Object.assign(r, parseArgs(argv));
    r.repo = fs.realpathSync(r.repo);
    r.stateDir = path.join(r.home, 'Library/Application Support/price-scraper/lululemon');
    prerequisites(r);
    const secrets = r.publish ? readCredentials(r.credentials, r) : {};
    if (r.command === 'run') return await collect(r, secrets);
    const zone = r.zone ?? hostZone(fs.readlinkSync('/etc/localtime'));
    if (zone !== 'America/Los_Angeles') throw new Error('Host timezone must be America/Los_Angeles for Pacific civil time across DST. Setup will not change it. Process TZ is not sufficient.');
    if (r.publish) {
      const workflow = fs.readFileSync(path.join(r.repo, '.github/workflows/scrape-lululemon.yml'), 'utf8');
      if (!r.githubScheduleOff || /^\s*schedule\s*:/m.test(workflow)) throw new Error('Timed publication is not authorized until the GitHub Lululemon calendar is removed and --github-schedule-off confirms the deployed state. Manual GitHub dispatch must not overlap.');
    }
    if (!r.install) { r.emit(makePlist(r)); r.emit('Preview only. No files installed, no launchd changes and no collection.'); return 0; }
    privateDirectory(r.stateDir, r);
    const log = openLog(path.join(r.stateDir, 'launcher.log'), r); fs.closeSync(log);
    return await install(r);
  } catch (error) {
    // Filesystem and tool errors may carry input data. Only our known generic diagnostics are exposed.
    const message = error.code || error instanceof SyntaxError ? 'Local operation failed. Check private path and configuration prerequisites; no credential data is printed.' : error.message;
    r.emit(`Error: ${message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2), { emit: text => {
    if (text.startsWith('Error:')) console.error(text); else console.log(text);
  } });
}
