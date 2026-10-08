/** Integration regressions for bounded pages and truthful publication metadata. */
const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { fixture } = require('./fixtures.cjs');
const { appLoader } = require('./load-app.cjs');

/** Add an atomic read batch to the inherited isolated fixture. */
function readFixture() {
  const state = fixture();
  state.facade.batch = async statements => {
    state.db.exec('BEGIN');
    try { return await Promise.all(statements.map(statement => statement.all())); }
    finally { state.db.exec('ROLLBACK'); }
  };
  return state;
}

/** Render the actual page with complete URL state and synthetic D1 only. */
async function html(db, params) {
  const load = appLoader({ db });
  return renderToStaticMarkup(await load('page.tsx').default({ searchParams: Promise.resolve(params) }));
}

test('failed results at every read-batch boundary suppress rows, totals and publication labels', async () => {
  const { db, facade } = readFixture();
  try {
    const before = JSON.stringify(db.prepare('SELECT * FROM deals ORDER BY id').all());
    const baseline = await facade.batch([facade.prepare('SELECT COUNT(*) AS total FROM deals')]);
    assert.equal(baseline[0].success, true);
    let batchSize = 0;
    const recording = { ...facade, async batch(statements) {
      batchSize = statements.length;
      return facade.batch(statements);
    } };
    await appLoader({ db: recording })('page.tsx').getData('all');
    assert.equal(batchSize, 5, 'Include rows, total, both options, and bulk publication guard');
    for (let index = 0; index < batchSize; index++) {
      const failing = { ...facade, async batch(statements) {
        const results = await facade.batch(statements);
        assert.ok(index < results.length, 'Exercise a real batch result boundary');
        results[index] = { ...results[index], success: false, error: 'Synthetic private failure' };
        return results;
      } };
      const result = await appLoader({ db: failing })('page.tsx').getData('all');
      assert.match(result.error, /Deals could not be loaded/);
      assert.equal(result.deals.length, 0);assert.equal(result.total, 0);
      assert.deepEqual(Object.keys(result.retailerDates), []);
      const markup = await html(failing, { retailer: 'all' });
      assert.match(markup, /role="alert"/);
      assert.doesNotMatch(markup, /Synthetic private failure|Last published:|Synthetic selected old price|Total Matches/);
    }
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM deals ORDER BY id').all()), before);
  } finally { db.close(); }
});

test('paged rows retain selected publication dates and scope-wide legacy metadata outside the loaded slice', async () => {
  const { db, facade } = readFixture();
  try {
    const insert = db.prepare("INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,category) VALUES(14,101,?,100,75,25,25,'2026-09-30','Other')");
    for (let i = 0; i < 2100; i++) insert.run('Synthetic bounded ' + i);
    const getData = appLoader({ db: facade })('page.tsx').getData;
    const first = await getData('sportchek');
    const next = await getData('sportchek', { offset: '500', publication: first.publication });
    assert.equal(next.total, 2102);assert.equal(next.deals.length, 500);
    assert.equal(next.hasLegacyRows, true);
    assert.ok(next.deals.every(row => row.scrape_id === 101 && row.published_at === '2026-10-01T12:00:00Z'));
    const markup = await html(facade, { retailer: 'sportchek', offset: '500', publication: first.publication });
    assert.match(markup, /Loaded 500 of 2102 matching deals/);
    assert.match(markup, /Legacy rows have no verified publication date/);
    assert.match(markup, /2026-10-01 12:00:00 UTC/);
    assert.doesNotMatch(markup, /Last updated:|Synthetic failed rows|Current deals/);
  } finally { db.close(); }
});

test('retained old publication and flyer labels remain pinned until replacement resets them together', async () => {
  const { db, facade } = readFixture();
  try {
    db.exec("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,flyer_dates) VALUES(201,1,'completed','2026-08-01','2026-08-01','Synthetic old flyer'); INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,category) VALUES(1,201,'Synthetic old flyer item',100,75,25,25,'2026-08-01','Other');");
    const getData = appLoader({ db: facade })('page.tsx').getData;
    const first = await getData('costco');
    db.exec("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,flyer_dates) VALUES(202,1,'completed','2026-09-01','2026-09-01','Synthetic new flyer'); INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,category) VALUES(1,202,'Synthetic new flyer item',100,75,25,25,'2026-09-01','Other');");
    const old = await getData('costco', { publication: first.publication });
    assert.equal(old.flyerDates, 'Synthetic old flyer');
    assert.equal(old.retailerDates.costco, '2026-08-01');
    assert.equal(old.deals[0].published_at, '2026-08-01');
    db.exec('DELETE FROM deals WHERE retailer_id=1 AND scrape_id<202');
    const reset = await getData('costco', { publication: first.publication, offset: '500' });
    assert.equal(reset.publicationReset, true);assert.equal(reset.offset, 0);
    assert.equal(reset.flyerDates, 'Synthetic new flyer');assert.equal(reset.retailerDates.costco, '2026-09-01');
    assert.equal(reset.deals[0].published_at, '2026-09-01');
  } finally { db.close(); }
});

test('all-store metadata keeps paused, missing and invalid dates without a false 2000-row warning', async () => {
  const { db, facade } = readFixture();
  try {
    db.exec("UPDATE scrape_sources SET is_active=0 WHERE id=14; UPDATE scrape_history SET completed_at='bad' WHERE id=101");
    const result = await appLoader({ db: facade })('page.tsx').getData('all');
    assert.equal(result.retailerPaused.sportchek, true);assert.equal(result.error, null);
    assert.equal(result.deals.find(row => row.product_code === 'legacy').published_at, null);
    const markup = await html(facade, { retailer: 'all' });
    assert.match(markup, /Last published: Unknown/);assert.match(markup, /Age unknown/);
    assert.match(markup, /Collection paused/);assert.doesNotMatch(markup, /Observed \(legacy\): 2026-06-01 12:00:00 UTC/);
    assert.match(markup, /Publication dates differ by store/);
    assert.doesNotMatch(markup, /Limited selection|2,000 loaded rows|Current deals|Last updated:/);
  } finally { db.close(); }
});

test('partial and extra-store pins reset the complete all-store scope', async () => {
  const { db, facade } = fixture();
  try {
    const getData = appLoader({ db: facade })('page.tsx').getData;
    const first = await getData('all');
    const pairs = JSON.parse(first.publication);
    for (const value of [pairs.slice(1), [...pairs,[99999,null]]]) {
      const result = await getData('all', { publication: JSON.stringify(value), offset:'500' });
      assert.equal(result.publicationReset, true);assert.equal(result.offset, 0);
      assert.equal(result.total, first.total);
      assert.deepEqual(result.deals.map(row => row.id), first.deals.map(row => row.id));
    }
  } finally { db.close(); }
});

test('cross-store deal and publication pairs never enter rows, totals or options', async () => {
  const { db, facade } = fixture();
  try {
    const getData = appLoader({ db: facade })('page.tsx').getData;
    const first = await getData('all');
    db.exec("INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,category,promo_type,scraped_at) VALUES(14,104,'Synthetic mislinked leak bait',100,1,99,99,'Hidden','Hidden','2026-01-01')");
    const result = await getData('all', {publication:first.publication});
    assert.equal(result.total, first.total);
    assert.ok(!result.deals.some(row => row.product_name.includes('mislinked')));
    assert.ok(!result.categories.includes('Hidden'));assert.ok(!result.promoTypes.includes('Hidden'));
  } finally { db.close(); }
});
