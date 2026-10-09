/** Bounded offline tests of actual page queries and React presentation. */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./fixtures.cjs');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { appLoader } = require('./load-app.cjs');
const now = '2026-10-08T12:00:00.000Z';

/** Render the real server page using synthetic request context. */
async function pageHTML(db, retailer = 'all') {
  const load = appLoader({ db, retailer });
  return renderToStaticMarkup(await load('page.tsx').default({ searchParams: Promise.resolve({ retailer }) }));
}

test('the production reader has no demo fallback left in source', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/app/page.tsx'), 'utf8');
  assert.doesNotMatch(source, /MOCK_DEALS|MOCK_RETAILERS|using mock data/);
});

for (const mode of ['missing binding', 'query exception', 'unsuccessful result']) {
  test(`database failure shows a real error without demo rows: ${mode}`, async () => {
    const db = mode === 'missing binding' ? undefined : { prepare() {
      if (mode === 'query exception') throw new Error('Synthetic secret must not reach UI');
      return { async all() { return { success: false, error: 'Synthetic secret must not reach UI' }; } };
    } };
    const result = await appLoader({ db })('page.tsx').getData('all');
    assert.equal(result.error, 'Deals could not be loaded. Please try again later.');
    assert.equal(result.deals.length, 0);
    const html = await pageHTML(db);
    assert.match(html, /role="alert"/);
    assert.match(html, /Deals could not be loaded/);
    assert.doesNotMatch(html, /DURACELL|MONDETTA|Synthetic secret|Total Deals|Last published:/);
  });
}

test('selected publication, failed attempts, legacy rows and mixed store ages remain read-only', async () => {
  const { db, facade } = fixture();
  try {
    const before = db.prepare('SELECT * FROM deals ORDER BY id').all();
    const result = await appLoader({ db: facade })('page.tsx').getData('all');
    assert.equal(result.error, null);
    assert.deepEqual(Array.from(result.deals, d => d.product_code).sort(), ['legacy','mixed','paused','selected']);
    assert.equal(result.deals.find(d => d.product_code === 'selected').published_at, '2026-10-01T12:00:00Z');
    assert.equal(result.deals.find(d => d.product_code === 'legacy').published_at, null);
    assert.equal(result.retailerPaused.indigo, true);
    const html = await pageHTML(facade);
    assert.doesNotMatch(html, /Last published:|Last updated:/);
    assert.match(html, /Paged results across retailers/);
    assert.doesNotMatch(html, /Limited selection|2,000 loaded rows/);
    assert.doesNotMatch(html, /Collection paused|Observed \(legacy\):|Actions run history/);
    assert.doesNotMatch(html, /Current deals|Last updated:/);
    assert.deepEqual(db.prepare('SELECT * FROM deals ORDER BY id').all(), before);
  } finally { db.close(); }
});

test('empty results and unknown retailer are not database errors', async () => {
  const { db, facade } = fixture();
  try {
    const result = await appLoader({ db: facade })('page.tsx').getData("' OR 1=1 --");
    assert.equal(result.error, null);
    assert.equal(result.deals.length, 0);
    const html = await pageHTML(facade, 'costco');
    assert.match(html, /No deals found/);
    assert.match(html, /Last updated: Unknown/);
    assert.doesNotMatch(html, /Deals could not be loaded/);
  } finally { db.close(); }
});

test('late database failures cannot leave partial fresh-looking results', async () => {
  for (const boundary of ['scrape_sources', 'scrape_history', 'FROM deals']) {
    const { db, facade } = fixture();
    try {
      const failing = { prepare(sql) {
        if (sql.includes(boundary)) throw new Error('Synthetic late read failure');
        return facade.prepare(sql);
      } };
      const result = await appLoader({ db: failing })('page.tsx').getData('all');
      assert.match(result.error, /Deals could not be loaded/);
      assert.equal(result.deals.length, 0);
      assert.equal(Object.keys(result.retailerDates).length, 0);
    } finally { db.close(); }
  }
});

test('invalid and missing completion dates keep selected old rows with unknown update time', async () => {
  for (const value of [null, 'bad', '2026-02-30T12:00:00Z']) {
    const { db, facade } = fixture();
    try {
      db.prepare('UPDATE scrape_history SET completed_at=? WHERE id=101').run(value);
      const html = await pageHTML(facade, 'sportchek');
      assert.match(html, /Synthetic selected old price/);
      assert.match(html, /Last updated: Unknown/);
      assert.doesNotMatch(html, /Synthetic failed rows|Age unknown|Invalid Date|UTC/);
    } finally { db.close(); }
  }
});

test('database-paused active sources retain rows and their completed update time', async () => {
  const { db, facade } = fixture();
  try {
    db.exec('UPDATE scrape_sources SET is_active=0 WHERE id=14');
    const html = await pageHTML(facade, 'sportchek');
    assert.match(html, /Last updated: Oct 1, 2026, 5:00:00 AM PCT/);
    assert.doesNotMatch(html, /Collection paused/);
    assert.match(html, /Synthetic selected old price/);
    assert.doesNotMatch(html, /Observed \(legacy\):/);
  } finally { db.close(); }
});

test('missing, invalid, impossible and ambiguous dates never become now', () => {
  const { normalizePublicationDate, formatPublicationDate } = appLoader()('publication.ts');
  for (const value of [null, undefined, '', 'bad', '2026-02-30T12:00:00Z', '2026-13-01', '2026-10-08T25:00:00Z', 0, {}, '10/08/2026']) {
    assert.equal(normalizePublicationDate(value), null, String(value));
    assert.equal(formatPublicationDate(value), 'Unknown', String(value));
  }
  assert.equal(formatPublicationDate('2026-10-08 12:00:00'), 'Oct 8, 2026, 5:00:00 AM PCT');
  assert.equal(formatPublicationDate('2026-10-08T05:00:00-07:00'), 'Oct 8, 2026, 5:00:00 AM PCT');
});

test('Vancouver formatter preserves historical rules and permanent Pacific Time without November fallback', () => {
  const { formatPublicationDate } = appLoader()('publication.ts');
  const cases = [
    ['2026-07-01T12:00:00Z', 'Jul 1, 2026, 5:00:00 AM PCT'],
    ['2026-10-08 21:51:12', 'Oct 8, 2026, 2:51:12 PM PCT'],
    ['2026-01-01T12:00:00Z', 'Jan 1, 2026, 4:00:00 AM PST'],
    ['2026-11-01T08:30:00Z', 'Nov 1, 2026, 1:30:00 AM PCT'],
    ['2026-11-01T09:30:00Z', 'Nov 1, 2026, 2:30:00 AM PCT'],
    ['2026-11-01T08:59:59Z', 'Nov 1, 2026, 1:59:59 AM PCT'],
    ['2026-11-01T09:00:00Z', 'Nov 1, 2026, 2:00:00 AM PCT'],
    ['2027-01-01T12:00:00Z', 'Jan 1, 2027, 5:00:00 AM PCT'],
    ['2026-03-08T09:59:59Z', 'Mar 8, 2026, 1:59:59 AM PST'],
    ['2026-03-08T10:00:00Z', 'Mar 8, 2026, 3:00:00 AM PDT'],
    ['2026-03-09T06:59:59Z', 'Mar 8, 2026, 11:59:59 PM PDT'],
    ['2026-03-09T07:00:00Z', 'Mar 9, 2026, 12:00:00 AM PCT'],
  ];
  for (const [input, expected] of cases) assert.equal(formatPublicationDate(input), expected);
});

test('selection without stored completion never borrows another retailer or the observation time', async () => {
  const { db, facade } = fixture();
  try {
    db.exec("UPDATE scrape_history SET completed_at=NULL WHERE id=101");
    const html = await pageHTML(facade, 'sportchek');
    assert.match(html, /Last updated: Unknown/);
    assert.doesNotMatch(html, /Last updated: Jul|Last updated: Jun|Invalid Date|UTC/);
    const unknown = await pageHTML(facade, 'not-a-retailer');
    assert.doesNotMatch(unknown, /Last updated:/);
  } finally { db.close(); }
});

test('the application runtime pin selects the verified refreshed native timezone rules', () => {
  assert.equal(fs.readFileSync(path.resolve(__dirname, '../../../.node-version'), 'utf8').trim(), '26.11.1');
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: '2-digit', hourCycle: 'h23' });
  assert.equal(formatter.format(new Date('2026-11-01T09:30:00Z')), '02');
  assert.equal(formatter.format(new Date('2027-01-01T12:00:00Z')), '05');
});

test('cadence age limits reject stale and future dates at exact boundaries', () => {
  const { publicationAge } = appLoader()('publication.ts');
  assert.equal(publicationAge('2026-10-01T12:00:00Z', now, 7).stale, false);
  assert.equal(publicationAge('2026-10-01T11:59:59.999Z', now, 7).stale, true);
  assert.equal(publicationAge('2026-10-04T12:00:00Z', now, 4).stale, false);
  assert.equal(publicationAge('2026-10-04T11:59:59.999Z', now, 4).stale, true);
  assert.equal(publicationAge(null, now, 4).label, 'Age unknown');
  assert.equal(publicationAge('2026-10-09T12:00:00Z', now, 4).label, 'Future date; age unknown');
});

test('server zones produce identical dates and age labels', () => {
  const script = `const {appLoader}=require(${JSON.stringify(path.resolve(__dirname,'load-app.cjs'))}); const p=appLoader()('publication.ts'); console.log(p.formatPublicationDate('2026-10-08 00:15:00'), JSON.stringify(p.publicationAge('2026-10-01T12:00:00Z', '${now}', 7)));`;
  const results = ['UTC','America/Los_Angeles','Asia/Tokyo'].map(TZ => spawnSync(process.execPath, ['-e',script], { env: { ...process.env, TZ }, encoding: 'utf8' }));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(new Set(results.map(r => r.stdout)).size, 1);
  assert.match(results[0].stdout, /^Oct 7, 2026, 5:15:00 PM PCT/);
});

test('single short update line is right-aligned immediately above the table without the removed blurb', async () => {
  const { db, facade } = fixture();
  try {
    const html = await pageHTML(facade, 'sportchek');
    assert.equal((html.match(/Last updated:/g) || []).length, 1);
    assert.match(html, /<p class="last-updated">Last updated: Oct 1, 2026, 5:00:00 AM PCT<\/p><p class="scroll-hint">Swipe to see more<\/p><div class="deals-table-wrapper">/);
    assert.ok(html.indexOf('pagination-controls') < html.indexOf('Last updated:'));
    assert.match(fs.readFileSync(path.resolve(__dirname, '../src/app/globals.css'), 'utf8'), /\.last-updated\s*\{\s*text-align: right;/);
    assert.doesNotMatch(html, /Last published|Stale means|Age limit|Saved prices and availability|Actions run history|hosted attempts only|local attempts|Legacy rows have no verified publication date/);
  } finally { db.close(); }
});

test('workflow links and cadence match existing repository files', () => {
  const { collectionPolicy } = appLoader()('publication.ts');
  for (const slug of ['costco','nike','sportchek','lululemon','barrys','gourmetwarehouse','indigo','toycompany','westcoastkids','wholefoods']) {
    const policy = collectionPolicy(slug);
    const name = slug === 'costco' ? 'scrape.yml' : `scrape-${slug}.yml`;
    const yaml = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows', name), 'utf8');
    assert.match(yaml, /^name: Scrape/m);
    assert.equal(policy.historyUrl, `https://github.com/hkonnection/price-scraper/actions/workflows/${name}`);
    assert.equal(policy.maxAgeDays, (yaml.match(/cron:/g) || []).length === 2 ? 4 : 7);
  }
  assert.equal(collectionPolicy('indigo').paused, true);
  assert.equal(collectionPolicy('carters').historyUrl, null);
  assert.equal(collectionPolicy('unknown').historyUrl, null);
  assert.equal(collectionPolicy('__proto__').historyUrl, null);
  assert.equal(collectionPolicy('constructor').historyUrl, null);
});
