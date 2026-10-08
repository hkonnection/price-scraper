/** URL compatibility must not weaken validation of the actual browsing controls. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { renderToStaticMarkup } = require('react-dom/server');
const { fixture } = require('./fixtures.cjs');
const { appLoader } = require('./load-app.cjs');

test('tracking and removed-control parameters are ignored while supported values remain validated', async () => {
  const { db, facade } = fixture();
  try {
    const page = appLoader({ db: facade })('page.tsx');
    const baseline = await page.getData('sportchek');
    for (const extra of [{utm_source:'Synthetic campaign'}, {fbclid:'Synthetic social'}, {gclid:'Synthetic ad'}, {import:'1'}, {utm_source:['one','two']}, {extra:'value'}]) {
      const result = await page.getData('sportchek', extra);
      assert.equal(result.total, baseline.total);
      assert.deepEqual(result.deals.map(row => row.id), baseline.deals.map(row => row.id));
      const markup = renderToStaticMarkup(await page.default({searchParams:Promise.resolve({retailer:'sportchek',...extra})}));
      assert.doesNotMatch(markup, /Unsupported query option|role="alert"/);
      assert.match(markup, /Synthetic selected old price/);
      await assert.rejects(page.getData('sportchek', {...extra,sort:'sale_price; DELETE FROM deals'}), /Unsupported/);
      await assert.rejects(page.getData('sportchek', {...extra,size:['500','1000']}), /Invalid/);
    }
  } finally { db.close(); }
});

test('empty retailer retains the normal Costco default without a write action', async () => {
  const { db, facade } = fixture();
  try {
    db.exec("INSERT INTO scrape_history(id,source_id,status,started_at,completed_at) VALUES(88,1,'completed','2026-01-01','2026-01-01'); INSERT INTO deals(retailer_id,scrape_id,product_name,regular_price,sale_price,savings_amount,savings_percent,scraped_at) VALUES(1,88,'Synthetic default Costco',100,50,50,50,'2026-01-01')");
    const page = appLoader({ db: facade })('page.tsx');
    for (const params of [{retailer:''},{retailer:'',import:'1'}]) {
      const markup = renderToStaticMarkup(await page.default({searchParams:Promise.resolve(params)}));
      assert.match(markup, /Synthetic default Costco/);
      assert.doesNotMatch(markup, /Invalid retailer value|Trigger Scrape|Import Deals|ImportComplete/);
    }
  } finally { db.close(); }
});
