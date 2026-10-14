/** Offline Costco regressions: synthetic HTML, fixed UTC clock, inert publication. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { load } from 'cheerio';
import { clean } from '../cleaners/costco.js';

const url = 'https://cocowest.ca/2026/10/costco-sale-october-13-18-2026/';

/** Build five synthetic captions to pass the existing content gate.
 * @param {string} dates Post date range. @param {string} price Price text.
 * @returns {string} Synthetic public post HTML.
 */
function post(dates = 'October 13-18, 2026', price = '$15.00') {
  return `<title>${dates}</title><article class="entry-content">${Array.from({ length: 5 }, (_, i) =>
    `<p>${1000000 + i} SYNTHETIC SOAP ${i} ($5.00 INSTANT SAVINGS EXPIRES ON 2026-10-18) ${price}</p>`).join('\n')}</article>`;
}

/** Replay the production collector without network access or credentials.
 * @param {Array<string>} responses Local HTML responses, consumed once.
 * @param {string} today Fixed UTC date. @returns {Promise<object>} API, requests and logs.
 */
async function collector(responses, today = '2026-10-14') {
  const calls = [], logs = [];
  /** Fixed UTC clock for validity boundaries. */
  class Clock extends Date {
    /** Use an explicit date if supplied, otherwise the fixed replay date.
     * @param {...*} args Date constructor arguments.
     */
    constructor(...args) { super(args.length > 1 ? Date.UTC(...args) : args.length ? args[0] : `${today}T12:00:00Z`); }
  }
  const context = vm.createContext({ Date: Clock, console: { log: line => logs.push(line), error: line => logs.push(line) },
    fetch: async (input, options = {}) => {
      assert.equal(options.method || 'GET', 'GET');
      assert.ok(['https://cocowest.ca/', url].includes(input));
      assert.ok(responses.length, 'Unexpected transport/retry');
      calls.push(input); return { text: async () => responses.shift() };
    } });
  const module = new vm.SourceTextModule(await fs.readFile(new URL('./cocowest.js', import.meta.url), 'utf8'), { context });
  await module.link(() => new vm.SyntheticModule(['load'], function () { this.setExport('load', load); }, { context }));
  await module.evaluate();
  return { scrape: module.namespace.scrapeCocowest, calls, logs };
}

/** Execute the actual entrypoint with the real cleaner and an in-memory publisher.
 * @param {Function} scrape Offline collector. @param {boolean} dry Dry-run flag.
 * @returns {Promise<object>} Exit/error evidence, writes, and local snapshot state.
 */
async function entrypoint(scrape, dry = false) {
  const exits = [], errors = [], writes = [];
  const prior = [{ product_code: 'prior', product_name: 'Synthetic prior snapshot' }];
  let state = structuredClone(prior);
  const context = vm.createContext({ console: { log() {}, error: (_label, error) => errors.push(error.message) },
    process: { argv: dry ? ['node', 'offline', '--dry-run'] : ['node', 'offline'], exit: code => exits.push(code) } });
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source.replace(/main\(\);\s*$/, 'await main();'), { context });
  await module.link(spec => {
    const name = spec.includes('/scrapers/') ? 'scrapeCocowest' : spec.includes('/db/') ? 'pushToD1' : 'getCleaner';
    return new vm.SyntheticModule([name], function () {
      this.setExport(name, name === 'scrapeCocowest' ? scrape : name === 'getCleaner' ? async slug => {
        assert.equal(slug, 'costco'); return { clean };
      } : async (rows, slug) => {
        assert.equal(slug, 'costco'); writes.push(structuredClone(rows)); state = structuredClone(rows);
      });
    }, { context });
  });
  await module.evaluate();
  return { exits, errors, writes, state, prior };
}

/** Assert unusable source input fails before touching the prior snapshot.
 * @param {Array<string>} responses Local HTML responses. @returns {Promise<void>} Assertions.
 */
async function rejectsPublication(responses) {
  const replay = await collector(responses);
  const result = await entrypoint(replay.scrape);
  assert.deepEqual(result.exits, [1]);
  assert.match(result.errors.join(' '), /No (?:currently valid Costco posts|Costco deals).*existing publication was not changed/i);
  assert.equal(result.writes.length, 0);
  assert.deepEqual(result.state, result.prior);
}

test('expired-only source fails instead of publishing a green expired fallback', async () => {
  await rejectsPublication([`<a href="${url}">Sale</a>`, post('October 9-11, 2026')]);
});

test('future-only source cannot become the fallback publication', async () => {
  await rejectsPublication([`<a href="${url}">Sale</a>`, post('October 19-25, 2026')]);
});

test('empty, challenged, or malformed HTML cannot report successful collection', async t => {
  for (const html of ['', '<title>Access denied</title>', '<article>not a Costco post</article>']) {
    await t.test(JSON.stringify(html), () => rejectsPublication([html]));
  }
});

test('current title with unparseable prices fails before publication', async () => {
  await rejectsPublication([`<a href="${url}">Sale</a>`, post(undefined, '$INVALID')]);
});

test('current positive source reaches the cleaner and inert publisher', async () => {
  const replay = await collector([`<a href="${url}">Sale</a>`, post()]);
  const result = await entrypoint(replay.scrape);
  assert.deepEqual(result.exits, []); assert.equal(result.writes.length, 1);
  assert.equal(result.state.length, 5);
  assert.equal(result.state[0].sale_price, 15); assert.equal(result.state[0].regular_price, 20);
  assert.equal(result.state[0].savings_percent, 25); assert.equal(result.state[0].brand, 'Costco');
  assert.equal(result.state[0].valid_from, '2026-10-13'); assert.equal(result.state[0].valid_to, '2026-10-18');
  assert.equal(replay.calls.length, 2);
});

test('first and last validity dates remain inclusive', async t => {
  for (const today of ['2026-10-13', '2026-10-18']) {
    await t.test(today, async () => {
      const replay = await collector([`<a href="${url}">Sale</a>`, post()], today);
      assert.equal((await replay.scrape()).deals.length, 5);
    });
  }
});

test('duplicate links and product codes still deduplicate; dry run preserves state', async () => {
  const replay = await collector([`<a href="${url}">Sale</a><a href="${url}">Sale</a>`, post().replace('</article>', post().match(/<article[^>]*>([\s\S]*)<\/article>/)[1] + '</article>')]);
  const result = await entrypoint(replay.scrape, true);
  assert.deepEqual(result.exits, []); assert.equal(result.writes.length, 0);
  assert.deepEqual(result.state, result.prior); assert.equal(replay.calls.length, 2);
  assert.ok(replay.logs.some(line => line.includes('Total unique deals: 5')));
});
