/** Conservative executed-SQL and D1-call budgets on the actual page reader. */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { appLoader } = require('./load-app.cjs');

/** Build synthetic stores and count executed SQL separately from batch RPCs. */
function budgetFixture(storeCount = 11) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../../db/schema.sql'), 'utf8'));
  for (let i = 0; i < storeCount - 2; i++) {
    db.prepare('INSERT INTO retailers(id,name,slug,scrape_source) VALUES(?,?,?,?)').run(100+i, 'Synthetic budget '+i, 'budget-'+i, 'scraper');
    db.prepare('INSERT INTO scrape_sources(id,retailer_id,name,slug) VALUES(?,?,?,?)').run(100+i, 100+i, 'Synthetic budget source '+i, 'synthetic-budget-'+i);
  }
  const stores = db.prepare('SELECT id FROM retailers WHERE is_active=1 ORDER BY id').all();
  assert.equal(stores.length, storeCount);
  const counters = { calls: 0, statements: 0 };
  let inBatch = false;
  const facade = {
    /** Compile read-only SQL; count only executions, not preparation. */
    prepare(sql) {
      assert.match(sql.trim(), /^SELECT/i);
      let params = [];
      return {
        /** Keep all values bound. */
        bind(...values) { params = values; return this; },
        /** Execute one read; a batch RPC is counted separately. */
        async all() {
          counters.statements++;if (!inBatch) counters.calls++;
          return { success: true, results: db.prepare(sql).all(...params) };
        },
        /** Execute one individual D1 call. */
        async first() {
          counters.statements++;counters.calls++;
          return db.prepare(sql).get(...params) || null;
        },
      };
    },
    /** Preserve the reader's atomic page boundary without counting harness transactions. */
    async batch(statements) {
      counters.calls++;inBatch = true;db.exec('BEGIN');
      try { return await Promise.all(statements.map(statement => statement.all())); }
      finally { db.exec('ROLLBACK');inBatch = false; }
    },
  };
  /** Simulate completed publication and cleanup using private rows only. */
  function publish(generation, category) {
    stores.forEach((store, index) => {
      const source = db.prepare('SELECT id FROM scrape_sources WHERE retailer_id=?').get(store.id);
      const id = generation * 1000 + index;
      db.prepare("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,deals_count) VALUES(?,?,'completed',?,?,1)").run(id, source.id, '2026-0'+generation+'-01', '2026-0'+generation+'-01');
      db.prepare('INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,category,promo_type,scraped_at) VALUES(?,?,?,100,50,50,50,?,?,?)').run(store.id,id,'Synthetic budget publication '+generation,category,category,'2026-01-01');
      db.prepare('DELETE FROM deals WHERE retailer_id=? AND scrape_id<?').run(store.id,id);
    });
  }
  publish(1, 'Old');
  return { db, facade, counters, publish };
}

for (const storeCount of [11, 16]) for (const removed of [false, true]) {
  test(storeCount+'-store cleanup reset stays within Free 50 SQL statements, removed filters='+removed, async () => {
    const { db, facade, counters, publish } = budgetFixture(storeCount);
    try {
      const getData = appLoader({ db: facade })('page.tsx').getData;
      const first = await getData('all', { category: 'Old', promo: 'Old' });
      assert.equal(first.total, storeCount);
      publish(2, removed ? 'New' : 'Old');
      counters.calls = 0;counters.statements = 0;
      const result = await getData('all', { category: 'Old', promo: 'Old', offset: '500', publication: first.publication });
      assert.equal(result.error, null);assert.equal(result.total, storeCount);assert.equal(result.offset, 0);
      assert.equal(result.publicationReset, true);assert.equal(result.category, removed ? 'all' : 'Old');
      assert.equal(result.promo, removed ? 'all' : 'Old');
      assert.ok(result.deals.every(row => row.product_name === 'Synthetic budget publication 2'));
      console.log('QUERY_BUDGET stores='+storeCount+' removed='+removed+' calls='+counters.calls+' statements='+counters.statements);
      assert.ok(counters.statements <= 50, 'Executed SQL exceeds Free 50: '+JSON.stringify(counters));
      assert.ok(counters.calls <= 50, 'D1 calls exceed Free 50: '+JSON.stringify(counters));
    } finally { db.close(); }
  });
}

test('repeated eleven-store cleanup returns the explicit reload error within the SQL budget', async () => {
  const { db, facade, counters, publish } = budgetFixture();
  try {
    const first = await appLoader({ db: facade })('page.tsx').getData('all');
    let generation = 1;
    const churn = { ...facade, async batch(statements) {
      publish(++generation, 'Old');
      return facade.batch(statements);
    } };
    counters.calls = 0;counters.statements = 0;
    await assert.rejects(appLoader({ db: churn })('page.tsx').getData('all', { publication: first.publication }), /publication changed again/);
    console.log('QUERY_BUDGET churn stores=11 calls='+counters.calls+' statements='+counters.statements);
    assert.ok(counters.statements <= 50);assert.ok(counters.calls <= 50);
  } finally { db.close(); }
});

test('an over-budget filter reset produces a safe error, never partial rows or statement 51', async () => {
  const { db, facade, counters, publish } = budgetFixture(17);
  try {
    const getData = appLoader({ db: facade })('page.tsx').getData;
    const first = await getData('all');
    publish(2, 'New');
    counters.calls = 0;counters.statements = 0;
    const result = await getData('all', { category: 'Old', publication: first.publication });
    assert.match(result.error, /Deals could not be loaded/);
    assert.equal(result.total, 0);assert.equal(result.deals.length, 0);
    assert.deepEqual(Object.keys(result.retailerDates), []);
    console.log('QUERY_BUDGET cap stores=17 calls='+counters.calls+' statements='+counters.statements);
    assert.ok(counters.statements <= 50);assert.ok(counters.calls <= 50);
  } finally { db.close(); }
});
