/** Seeded in-memory database with selected, failed, legacy and paused rows. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/** Create a synthetic D1 facade that permits reads only. */
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../../db/schema.sql'), 'utf8'));
  db.exec(`INSERT INTO retailers(id,name,slug,scrape_source) VALUES
    (14,'Sport Chek','sportchek','direct'),(15,'Nike','nike','direct'),(16,'Indigo','indigo','direct');
    INSERT INTO scrape_sources(id,retailer_id,name,slug,is_active) VALUES
    (14,14,'Synthetic','sportchek',1),(15,15,'Synthetic','nike',1),(16,16,'Synthetic','indigo',0);
    INSERT INTO scrape_history(id,source_id,status,started_at,completed_at) VALUES
    (101,14,'completed','2026-10-01','2026-10-01T12:00:00Z'),
    (102,14,'failed','2026-10-08','2026-10-08T11:00:00Z'),
    (103,15,'completed','2026-07-01','2026-07-01 12:00:00'),
    (104,16,'completed','2026-07-01','2026-07-01T12:00:00Z');
    INSERT INTO deals(retailer_id,scrape_id,product_code,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at,category) VALUES
    (14,101,'selected','Synthetic selected old price',100,75,25,25,'2026-09-30T12:00:00Z','Other'),
    (14,102,'failed','Synthetic failed rows',100,75,25,25,'2026-10-08T11:00:00Z','Other'),
    (14,NULL,'legacy','Synthetic legacy observation',100,75,25,25,'2026-06-01 12:00:00','Other'),
    (15,103,'mixed','Synthetic mixed age price',100,75,25,25,'2026-07-01T11:00:00Z','Other'),
    (16,104,'paused','Synthetic paused price',100,75,25,25,'2026-07-01T11:00:00Z','Other');`);
  const queries = [];
  const facade = {
    /** Execute the complete read page within one isolated transaction. */
    async batch(statements) {
      db.exec('BEGIN');
      try { return await Promise.all(statements.map(statement => statement.all())); }
      finally { db.exec('ROLLBACK'); }
    },
    prepare(sql) {
    assert.match(sql.trim(), /^SELECT/i, 'Reader must not write');
    queries.push(sql);
    let params = [];
    return { bind(...args) { params = args; return this; }, async all() { return { success: true, results: db.prepare(sql).all(...params) }; }, async first() { return db.prepare(sql).get(...params) || null; } };
  } };
  return { db, facade, queries };
}


module.exports = { fixture };
