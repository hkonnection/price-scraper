const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');

/** Build an isolated synthetic database and deny all remote I/O. */
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../../db/schema.sql'), 'utf8'));
  db.exec(`INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,deals_count) VALUES
    (10,1,'completed','2026-01-01','2026-01-01',2105),
    (11,1,'running','2026-02-01',NULL,1),
    (12,1,'failed','2026-03-01','2026-03-01',1);
    INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,deals_count)
    SELECT 20,id,'completed','2026-01-01','2026-01-01',2050 FROM scrape_sources WHERE retailer_id=(SELECT id FROM retailers WHERE slug='carters');`);
  const insert = db.prepare(`INSERT INTO deals(retailer_id,scrape_id,product_code,product_name,regular_price,sale_price,savings_amount,savings_percent,category,promo_type,scraped_at,in_stock)
    VALUES (?,?,?,?,100,?,?,? ,?,?,'2026-01-01',1)`);
  for (let i=0;i<2105;i++) insert.run(1,10,String(i),`Synthetic ${String(i).padStart(4,'0')}`,i%100,100-i%100,30,'Category '+i%3,'Type '+i%2);
  const carters = db.prepare("SELECT id FROM retailers WHERE slug='carters'").get().id;
  for(let i=0;i<2050;i++) insert.run(carters,20,'c'+i,'Synthetic other '+i,10,90,30,'Other','Clearance');
  insert.run(1,11,'running','Never visible running',1,99,99,'Hidden','Hidden');
  insert.run(1,12,'failed','Never visible failed',1,99,99,'Hidden','Hidden');
  insert.run(1,null,'legacy','Synthetic legacy',25,75,30,'Category 0','Type 0');
  const queries = [];
  let beforeBatch = null;
  let afterHistory = null;
  const facade = {
    /** Prepare a read-only SQLite statement with a D1-compatible API. */
    prepare(sql) {
      assert.match(sql.trim(), /^SELECT/i, 'No website writes');
      const entry = {sql, params: []}; queries.push(entry);
      return {
        /** Bind values without interpolating caller input. */
        bind(...params) {entry.params=params;return this;},
        /** Return rows from the local fixture only. */
        async all() {return {results: db.prepare(sql).all(...entry.params)};},
        /** Return one row from the local fixture only. */
        async first() {
          const result=db.prepare(sql).get(...entry.params)||null;
          if(afterHistory && /scrape_history sh/.test(sql) && /ORDER BY/.test(sql)) {const hook=afterHistory;afterHistory=null;hook();}
          return result;
        },
      };
    },
    /** Execute a batch within one local read transaction. */
    async batch(statements) {
      if(beforeBatch) {const hook=beforeBatch;beforeBatch=null;hook();}
      db.exec('BEGIN');
      try {return await Promise.all(statements.map(statement=>statement.all()));}
      finally {db.exec('ROLLBACK');}
    },
  };
  return {db,facade,queries,
    /** Schedule replacement before the atomic page read. */
    replaceBeforeBatch(hook) {beforeBatch=hook;},
    /** Schedule replacement after metadata lookup but before row-existence lookup. */
    replaceAfterHistory(hook) {afterHistory=hook;},
  };
}

/** Load the actual server page without a Cloudflare service or network. */
function loadPage(facade) {
  const source=fs.readFileSync(path.resolve(__dirname,'../src/app/page.tsx'),'utf8');
  const exports={};
  vm.runInNewContext(ts.transpileModule(source+'\nexport { getData };',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText, {
    exports, URLSearchParams, console: {log() {}}, fetch() {throw Error('Remote I/O denied');},
    require(name) {
      if(name==='@cloudflare/next-on-pages') return {getRequestContext:()=>({env:{DB:facade}})};
      if(name==='react/jsx-runtime') return {jsx:(type,props)=>({type,props})};
      return {};
    },
  });
  return exports;
}

/** Replace a completed snapshot as the real writer cleanup does. */
function replace(db) {
  db.exec(`INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,deals_count) VALUES (30,1,'completed','2026-04-01','2026-04-01',1);
    INSERT INTO deals(retailer_id,scrape_id,product_code,product_name,regular_price,sale_price,savings_amount,savings_percent,category,promo_type,scraped_at)
    VALUES (1,30,'new','Synthetic replacement',100,50,50,50,'New','New','2026-04-01');
    DELETE FROM deals WHERE retailer_id=1 AND (scrape_id IS NULL OR scrape_id<30);`);
}

test('selected and all-store reads are bounded and count beyond the old 2000 limit', async()=>{
  const {db,facade,queries}=fixture();
  try {
    for(const [slug,total] of [['costco',2106],['all',4156]]) {
      const result=await loadPage(facade).getData(slug,{size:'500'});
      assert.equal(result.deals.length,500);
      assert.equal(result.total,total);
      assert.ok(!result.deals.some(row=>row.product_code==='running'||row.product_code==='failed'));
    }
    for(const {sql} of queries.filter(q=>/SELECT d.id,/.test(q.sql))) assert.match(sql,/LIMIT \? OFFSET \?/);
  } finally {db.close();}
});

test('all filters and every sort operate on the full matching set with a unique tie-break', async()=>{
  const {db,facade}=fixture();
  try {
    const getData=loadPage(facade).getData;
    for(const category of ['all','Category 0','Category 1','Category 2']) for(const promo of ['all','Type 0','Type 1']) {
      for(const sort of ['product_name','category','regular_price','sale_price','savings_amount','savings_percent','retailer_name']) for(const direction of ['asc','desc']) {
        const result=await getData('costco',{category,promo,sort,direction,size:'500',offset:'500'});
        let where="d.retailer_id=1 AND (d.scrape_id=10 OR d.scrape_id IS NULL)"; const params=[];
        if(category!=='all') {where+=' AND d.category=?';params.push(category);}
        if(promo!=='all') {where+=' AND d.promo_type=?';params.push(promo);}
        const column=sort==='retailer_name'?'r.name':'d.'+sort;
        const expected=db.prepare(`SELECT d.id FROM deals d JOIN retailers r ON d.retailer_id=r.id WHERE ${where} ORDER BY ${column} ${direction},d.id ASC LIMIT 500 OFFSET 500`).all(...params);
        assert.deepEqual(Array.from(result.deals,row=>row.id),expected.map(row=>row.id));
        assert.equal(result.total,db.prepare(`SELECT COUNT(*) AS total FROM deals d WHERE ${where}`).get(...params).total);
      }
    }
  } finally {db.close();}
});

test('first, last, empty, missing retailer, global filter options and 1000-row pages', async()=>{
  const {db,facade}=fixture();
  try {
    const getData=loadPage(facade).getData;
    const first=await getData('costco',{size:'1000'});
    assert.equal(first.deals.length,1000);
    assert.deepEqual(Array.from(first.categories),['Category 0','Category 1','Category 2']);
    assert.deepEqual(Array.from(first.promoTypes),['Type 0','Type 1']);
    const last=await getData('costco',{offset:'2000',publication:first.publication,size:'1000'});
    assert.equal(last.deals.length,106);
    assert.equal(last.offset,2000);
    assert.equal((await getData('costco',{offset:'3000'})).deals.length,0);
    assert.equal((await getData('missing')).total,0);
    assert.equal((await getData('disabled')).deals.length,0);
  } finally {db.close();}
});

test('invalid or unsupported query values are rejected before any database read', async()=>{
  const {db,facade,queries}=fixture();
  try {
    const getData=loadPage(facade).getData;
    for(const params of [
      ...['0','-1','1.5','1001','1000000000','All','NaN','Infinity',''].map(size=>({size})),
      ...['-1','1.5','1e9','9007199254740992','1000000001',''].map(offset=>({offset})),
      {size:['500','1000']},{size:500},{offset:null},{sort:'sale_price; DROP TABLE deals'},{sort:'__proto__'},{direction:'sideways'},
      {publication:'[[1,1.5]]'},{publication:'[[1,10],[1,10]]'},{publication:'[[1,-1]]'},{publication:'[[1,9007199254740992]]'},
      {publication:'x'.repeat(4097)},
      {category:'x'.repeat(101)},{promo:['Type 0','Type 1']},{publication:'broken'},{extra:'value'},
    ]) {
      const count=queries.length;
      await assert.rejects(getData('costco',params),/Invalid|Unsupported/);
      assert.equal(queries.length,count);
    }
    for(const params of [{category:'Hidden'},{promo:"' OR 1=1 --"}]) await assert.rejects(getData('costco',params),/Unsupported/);
  } finally {db.close();}
});

test('retained old completed publication stays pinned until writer cleanup removes it', async()=>{
  const {db,facade}=fixture();
  try {
    const getData=loadPage(facade).getData;
    const first=await getData('costco');
    db.exec("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,deals_count) VALUES (30,1,'completed','2026-04-01','2026-04-01',1)");
    db.exec("INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at) VALUES(1,30,'New retained',100,50,50,50,'2026-04-01')");
    const old=await getData('costco',{publication:first.publication,offset:'500'});
    assert.equal(old.total,2106);
    assert.equal(old.offset,500);
    assert.equal(old.retailerDates.costco,'2026-01-01');
    db.exec('DELETE FROM deals WHERE retailer_id=1 AND (scrape_id IS NULL OR scrape_id<30)');
    const reset=await getData('costco',{publication:first.publication,offset:'500'});
    assert.equal(reset.offset,0);
    assert.equal(reset.publicationReset,true);
    assert.equal(reset.total,1);
    assert.equal(reset.deals[0].product_name,'New retained');
  } finally {db.close();}
});

test('unavailable, failed, running or cross-retailer publication resets without leaking rows', async()=>{
  const {db,facade}=fixture();
  try {
    const getData=loadPage(facade).getData;
    for(const id of [11,12,20,999999]) {
      const result=await getData('costco',{publication:JSON.stringify([[1,id]]),offset:'500'});
      assert.equal(result.publicationReset,true);
      assert.equal(result.offset,0);
      assert.equal(result.total,2106);
      assert.ok(!result.deals.some(row=>row.product_name.startsWith('Never')));
    }
  } finally {db.close();}
});

test('cleanup between scope lookup and atomic batch resets count and page together', async()=>{
  const fixtureState=fixture();const {db,facade}=fixtureState;
  try {
    const getData=loadPage(facade).getData;
    const first=await getData('all');
    fixtureState.replaceBeforeBatch(()=>replace(db));
    const result=await getData('all',{publication:first.publication,offset:'500'});
    assert.equal(result.publicationReset,true);
    assert.equal(result.offset,0);
    assert.equal(result.total,2051);
    assert.equal(result.deals.length,500);
    assert.ok(!result.deals.some(row=>row.retailer_slug==='costco'&&row.product_code!=='new'));
  } finally {db.close();}
});

test('client uses server page and totals, sends filter/sort/page controls, and has no All size',()=>{
  const client=fs.readFileSync(path.resolve(__dirname,'../src/app/components/DealsPageClient.tsx'),'utf8');
  const table=fs.readFileSync(path.resolve(__dirname,'../src/app/components/DealsTable.tsx'),'utf8');
  assert.doesNotMatch(client,/filteredDeals\.slice|value=\{0\}|useEffect/);
  assert.match(client,/total/);
  assert.match(client,/publication/);
  assert.match(client,/router\.replace/);
  assert.doesNotMatch(table,/\[\.\.\.deals\]\.sort|sortedDeals\.map/);
  assert.match(table,/onSort/);
});

test('empty completed snapshots, legacy-only stores and replacement with removed filters stay explicit',async()=>{
  const {db,facade}=fixture();
  try {
    const getData=loadPage(facade).getData;
    const first=await getData('costco',{category:'Category 0',promo:'Type 0'});
    replace(db);
    const reset=await getData('costco',{category:'Category 0',promo:'Type 0',publication:first.publication,offset:'500'});
    assert.equal(reset.publicationReset,true);assert.equal(reset.category,'all');assert.equal(reset.promo,'all');assert.equal(reset.total,1);
    db.exec("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at,deals_count) VALUES(40,1,'completed','2026-05-01','2026-05-01',0); DELETE FROM deals WHERE retailer_id=1;");
    const empty=await getData('costco');
    assert.equal(empty.total,0);assert.equal(empty.deals.length,0);assert.equal(empty.publicationReset,false);
    db.exec("DELETE FROM scrape_history WHERE source_id=1; INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at) VALUES(1,NULL,'Legacy only',100,20,80,80,'2026-01-01');");
    const legacy=await getData('costco');assert.equal(legacy.total,1);assert.equal(legacy.deals[0].product_name,'Legacy only');
    assert.equal(legacy.publication,'[[1,null]]');
  } finally {db.close();}
});

test('all-store snapshots share exact counts and row IDs across stable tied pages',async()=>{
  const {db,facade}=fixture();
  try {
    const getData=loadPage(facade).getData;
    const seen=[];
    let publication;
    for(let offset=0;offset<4156;offset+=1000) {
      const result=await getData('all',{size:'1000',offset:String(offset),...(publication?{publication}:{})});
      publication=result.publication;assert.equal(result.total,4156);assert.ok(result.deals.length<=1000);
      seen.push(...result.deals.map(row=>row.id));
    }
    const expected=db.prepare("SELECT d.id FROM deals d JOIN retailers r ON r.id=d.retailer_id WHERE r.is_active=1 AND (d.scrape_id IN (10,20) OR d.scrape_id IS NULL) ORDER BY d.id").all().map(row=>row.id);
    assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,4156);
  } finally {db.close();}
});

test('nullable sort values stay last in both directions',async()=>{
  const {db,facade}=fixture();
  try {
    db.exec("INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,category,scraped_at) VALUES (1,10,'Synthetic null category',100,25,75,30,NULL,'2026-01-01')");
    for(const direction of ['asc','desc']) {
      const result=await loadPage(facade).getData('costco',{sort:'category',direction,offset:'2000'});
      assert.equal(result.deals[result.deals.length-1].product_name,'Synthetic null category');
    }
  } finally {db.close();}
});

test('replacement immediately after history lookup resets instead of returning a false empty publication',async()=>{
  const state=fixture();const {db,facade}=state;
  try {
    state.replaceAfterHistory(()=>replace(db));
    const result=await loadPage(facade).getData('costco',{offset:'500'});
    assert.equal(result.publicationReset,true);
    assert.equal(result.total,1);
    assert.equal(result.offset,0);
    assert.equal(result.deals[0].product_code,'new');
  } finally {db.close();}
});

module.exports={fixture,loadPage,replace};
