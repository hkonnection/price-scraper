import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrid, combineSections, collectSection, SECTIONS } from './lululemon-grid.mjs';

const at = '2026-10-11T15:02:03.456Z';
/** Make one inert synthetic product tile. @param {string} code Product code. @param {string} name Name. @param {string} prices Price markup. @returns {string} HTML. */
function tile(code, name = 'Test Shirt', prices = '<span class="originalPrice">$100</span> $50') {
  return `<div data-testid="product-tile"><a href="/p/test/${code}?color=123">${name}</a>${prices}<img src="https://images.example/item.jpg?width=100"></div>`;
}
/** Make a synthetic product grid. @param {string} contents Tiles. @returns {string} HTML. */
function grid(contents) { return `<div data-testid="product-grid">${contents}</div>`; }
/** Parse a synthetic capture. @param {string} name Section. @param {string} html Tile contents. @returns {object} Capture. */
function capture(name, html) { return parseGrid(grid(html), name, at); }

test('parser reads only grid tile descendants and preserves reference price, code, URL and image semantics', () => {
  const result = parseGrid(grid(tile('prod1', 'Cool &amp; Calm Shirt', '<span class="originalPrice">$1,000</span> $499 $550')) + tile('outside'), 'Women', at);
  assert.deepEqual(result.stats, { cards: 1, usable: 1, duplicates: 0, unusable: 0, priorCategories: 0 });
  assert.equal(result.raw.totalProducts, 1);
  const row = result.raw.deals[0];
  assert.equal(row.product_code, 'prod1'); assert.equal(row.product_name, 'Cool & Calm Shirt');
  assert.equal(row.regular_price, 1000); assert.equal(row.sale_price, 499);
  assert.equal(row.savings_amount, 501); assert.equal(row.savings_percent, 50.1);
  assert.equal(row.product_url, 'https://shop.lululemon.com/en-ca/p/test/prod1?color=123');
  assert.equal(row.image_url, 'https://images.example/item.jpg'); assert.equal(row.scraped_at, at);
});

test('parser reports duplicate and unusable cards, reuses prior categories and never runs scripts', () => {
  const result = parseGrid(grid(tile('x', 'Unknown') + tile('x', 'A Shirt') + tile('bad', 'Invalid', '$50 $50') + '<div data-testid="product-tile">Broken</div><script>throw Error("not executed")</script>'), 'Women', at, new Map([['x', 'Bags']]));
  assert.deepEqual(result.stats, { cards: 4, usable: 2, duplicates: 1, unusable: 2, priorCategories: 2 });
  assert.equal(result.raw.deals.length, 1); assert.equal(result.raw.deals[0].category, 'Bags');
});

test('raw parser preserves the first duplicate tile exactly, leaving cross-section upgrades to the combiner', () => {
  const result = capture('Women', tile('same', 'Unknown') + tile('same', 'Bag', '<span class="originalPrice">$200</span> $60'));
  assert.equal(result.raw.deals[0].product_name, 'Unknown');
  assert.equal(result.raw.deals[0].category, 'Other');
  assert.equal(result.raw.deals[0].sale_price, 50);
  assert.equal(result.stats.duplicates, 1);
});

test('reference name-category precedence and accessory fallback', () => {
  const names = [['Parka Vest', 'Jackets & Outerwear'], ['Half-Zip Crew', 'Hoodies & Sweatshirts'], ['Jogger', 'Pants'], ['Tight', 'Leggings'], ['Short', 'Shorts'], ['Skort', 'Skirts & Dresses'], ['Bra', 'Sports Bras'], ['Tank', 'Tank Tops'], ['Polo', 'Shirts & Tops'], ['Cardigan', 'Sweaters'], ['Sock', 'Socks'], ['Boxer', 'Underwear'], ['Pouch', 'Bags'], ['Scrunchie', 'Hats & Headwear'], ['Sneaker', 'Shoes'], ['Bottle', 'Water Bottles'], ['Yoga Mat', 'Yoga Mats'], ['Unknown', 'Other']];
  for (const [name, category] of names) assert.equal(capture('Women', tile('x', name)).raw.deals[0].category, category, name);
  assert.equal(capture('Accessories', tile('x', 'Unknown')).raw.deals[0].category, 'Accessories');
});

test('cross-section duplicate regression: first record and owner win; only Other upgrades; within-section counts preserved', () => {
  const women = capture('Women', tile('shared', 'Unknown') + tile('women', 'Tank') + tile('women', 'Tank'));
  const men = capture('Men', tile('shared', 'Bag', '<span class="originalPrice">$200</span> $60') + tile('men', 'Shorts') + tile('men', 'Shorts'));
  const accessories = capture('Accessories', tile('shared', 'Hat') + tile('men', 'Bag') + tile('acc', 'Bag') + tile('acc', 'Bag'));
  const before = JSON.stringify([women, men, accessories]);
  const combined = combineSections([women, men, accessories], at);
  assert.deepEqual(combined.payload.deals.map(r => r.product_code), ['shared', 'women', 'men', 'acc']);
  assert.equal(combined.payload.deals[0].category, 'Bags'); assert.equal(combined.payload.deals[0].sale_price, 50);
  assert.equal(combined.payload.deals[2].category, 'Shorts');
  assert.deepEqual(combined.payload.sections, [{ name: 'Women', dealCount: 2 }, { name: 'Men', dealCount: 1 }, { name: 'Accessories', dealCount: 1 }]);
  assert.deepEqual(combined.stats.map(s => [s.cards, s.usable, s.duplicates, s.crossDuplicates, s.unique]), [[3, 3, 1, 0, 2], [3, 3, 1, 1, 1], [4, 4, 1, 2, 1]]);
  assert.equal(combined.payload.totalProducts, 4); assert.equal(JSON.stringify([women, men, accessories]), before);
});

test('capture completion cannot precede an earlier section row if the clock moves backwards', () => {
  const captures = SECTIONS.map(({ name }) => capture(name, tile(name.toLowerCase())));
  assert.throws(() => combineSections(captures, '2026-10-11T15:02:02.456Z'), /capture.*preced|capture.*before/i);
});

test('valid later capture with no new products is accepted but missing/empty/malformed captures are rejected', () => {
  const captures = SECTIONS.map(({ name }) => capture(name, tile('same', 'Unknown')));
  const combined = combineSections(captures, at);
  assert.equal(combined.payload.totalProducts, 1);
  assert.deepEqual(combined.payload.sections.map(s => s.dealCount), [1, 0, 0]);
  assert.equal(combined.payload.deals[0].category, 'Accessories');
  for (const input of [captures.slice(0, 2), [captures[1], captures[0], captures[2]], [captures[0], { raw: { deals: [], totalProducts: 0, sections: [{ name: 'Men', dealCount: 0 }] } }, captures[2]], [captures[0], null, captures[2]]]) assert.throws(() => combineSections(input, at));
  assert.throws(() => parseGrid(grid(''), 'Women', at), /empty/i);
  assert.throws(() => parseGrid('<article>changed markup</article>', 'Women', at), /grid/i);
  assert.throws(() => parseGrid(grid(tile('bad', 'Bad', '$1')), 'Women', at), /usable|empty/i);
  assert.throws(() => parseGrid(grid(tile('x')), 'Unknown', at));
  assert.throws(() => parseGrid(grid(tile('x')), 'Women', 'invalid'));
});

/** Simulate UI states without any browser/network. @param {object[]} states Ordered DOM snapshots. @param {number} status HTTP status. @returns {object} Page double and trace. */
function fakePage(states, status = 200) {
  let index = 0, clicked = false;
  const trace = [], handlers = {};
  return { trace, on: (event, fn) => { handlers[event] = fn; }, off: () => {},
    goto: async url => { trace.push(url); return { status: () => status, ok: () => status === 200 }; },
    evaluate: async () => { const result = states[index]; if (clicked && index < states.length - 1) index++; return result; },
    getByRole: () => ({ click: async () => { clicked = true; trace.push('click'); } }),
    waitForTimeout: async () => {},
    locator: () => ({ evaluate: async () => grid(tile('x') + tile('y')) }),
  };
}
test('collector stops before another click when refusal arrives during ordinary pacing', async () => {
  const page = fakePage([initial]);
  page.waitForTimeout = async () => { page.evaluate = async () => ({ ...initial, refusal: true }); };
  await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 1, pollMs: 1, timeoutMs: 3 }), /refus/i);
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

const initial = { grids: 1, cards: 1, buttons: 1, visibleButtons: 1, enabled: true, busy: false, refusal: false };
const complete = { ...initial, cards: 2, buttons: 0, visibleButtons: 0 };

test('HTTP 429 resource refusal halts before clicking without reading any network body', async () => {
  const page = fakePage([initial]); let listener;
  page.on = (event, fn) => { listener = fn; };
  page.waitForTimeout = async () => { listener({ url: () => 'https://shop.lululemon.com/refused-resource', status: () => 429 }); };
  await assert.rejects(collectSection(page, SECTIONS[0], { paceMs: 1, pollMs: 1, timeoutMs: 3 }), /refus/i);
  assert.deepEqual(page.trace, [SECTIONS[0].url]);
});

test('collector visits section once and uses ordinary button through loading before saving outerHTML', async () => {
  const page = fakePage([initial, { ...initial, busy: true, visibleButtons: 0 }, complete, complete]);
  const html = await collectSection(page, SECTIONS[0], { paceMs: 0, pollMs: 1, timeoutMs: 50 });
  assert.match(html, /product-grid/);
  assert.deepEqual(page.trace, [SECTIONS[0].url, 'click']);
});

test('collector stops for refusal, HTTP rejection, empty grid, ambiguous markup and stalled/incomplete expansion', async () => {
  const settings = { paceMs: 0, pollMs: 1, timeoutMs: 2 };
  for (const [states, status, expected] of [
    [[{ ...initial, refusal: true }], 200, /refus/i], [[initial], 403, /HTTP|refus/i],
    [[{ ...complete, cards: 0 }], 200, /empty/i], [[{ ...complete, grids: 2 }], 200, /grid/i],
    [[initial], 200, /incomplete|stall/i], [[{ ...initial, visibleButtons: 0 }], 200, /incomplete/i],
    [[initial, { ...complete, cards: 1 }], 200, /incomplete|stall/i], [[initial, { ...complete, cards: 0 }], 200, /empty|incomplete/i],
  ]) await assert.rejects(collectSection(fakePage(states, status), SECTIONS[0], settings), expected);
});
