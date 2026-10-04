/**
 * Unit tests for Sport Chek deal normalization.
 * Uses the built-in Node test runner so no extra test framework is required.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { availabilityErrorIsRetryable, buildDeal, isPurchasable, normalizeBrand, productImageUrl, productPageUrl } from './sportchek.js';
import { clean } from '../cleaners/sportchek.js';

const listing = {
  code: '83497015F',
  title: "HOKA Men's Clifton 10 Running Shoes",
  brand: { label: 'HOKA' },
  url: '/en/pdp/hoka-men-s-clifton-10-running-shoes-83497015f.html',
  images: {
    url: 'https://media-www.sportchek.ca/product/hoka.jpg',
  },
  skus: [{ code: '334465254' }],
};

const priceGroup = {
  currentPrice: { value: 107.97 },
  originalPrice: { value: 180 },
  isOnSale: true,
};

test('normalizeBrand title-cases all-caps vendor names', () => {
  assert.equal(normalizeBrand('UNDER ARMOUR'), 'Under Armour');
  assert.equal(normalizeBrand(''), 'Sport Chek');
  assert.equal(normalizeBrand(null), 'Sport Chek');
});

test('productPageUrl resolves relative PDP paths and leaves absolute URLs', () => {
  assert.equal(
    productPageUrl('/en/pdp/example.html'),
    'https://www.sportchek.ca/en/pdp/example.html',
  );
  assert.equal(
    productPageUrl('https://www.sportchek.ca/en/pdp/example.html'),
    'https://www.sportchek.ca/en/pdp/example.html',
  );
  assert.equal(productPageUrl(''), '');
});

test('productImageUrl accepts an image object or an image array', () => {
  assert.equal(productImageUrl({ url: 'https://img.example/a.jpg' }), 'https://img.example/a.jpg');
  assert.equal(productImageUrl([{ url: 'https://img.example/b.jpg' }]), 'https://img.example/b.jpg');
  assert.equal(productImageUrl(null), '');
});

test('buildDeal calculates savings to two decimal places', () => {
  const deal = buildDeal(listing, priceGroup, 'Clearance');
  assert.equal(deal.product_code, '83497015F');
  assert.equal(deal.product_name, "HOKA Men's Clifton 10 Running Shoes");
  assert.equal(deal.brand, 'Hoka');
  assert.equal(deal.regular_price, 180);
  assert.equal(deal.sale_price, 107.97);
  assert.equal(deal.savings_amount, 72.03);
  assert.equal(deal.savings_percent, 40.02);
  assert.equal(deal.image_url, 'https://media-www.sportchek.ca/product/hoka.jpg');
  assert.equal(deal.product_url, 'https://www.sportchek.ca/en/pdp/hoka-men-s-clifton-10-running-shoes-83497015f.html');
  assert.equal(deal.promo_type, 'Clearance');
  assert.equal(deal.in_stock, 1);
  assert.equal(typeof deal.scraped_at, 'string');
});

test('clean keeps promo type and rounds savings percent', () => {
  const [deal] = clean([{ brand: '', promo_type: 'Clearance', savings_percent: 40.016 }]);
  assert.equal(deal.brand, 'Sport Chek');
  assert.equal(deal.promo_type, 'Clearance');
  assert.equal(deal.savings_percent, 40.02);
});

test('buildDeal rejects missing, equal, or inverted prices', () => {
  assert.equal(buildDeal(listing, { currentPrice: { value: 50 } }, 'Sale'), null);
  assert.equal(buildDeal(listing, { currentPrice: { value: 50 }, originalPrice: { value: null } }, 'Sale'), null);
  assert.equal(buildDeal(listing, { currentPrice: { value: 50 }, originalPrice: { value: 50 } }, 'Sale'), null);
  assert.equal(buildDeal(listing, { currentPrice: { value: 80 }, originalPrice: { value: 40 } }, 'Sale'), null);
  assert.equal(buildDeal({ title: '' }, priceGroup, 'Sale'), null);
  assert.equal(buildDeal(null, priceGroup, 'Sale'), null);
});

test('isPurchasable keeps a deal when any SKU has online or store stock', () => {
  const onlineOnly = [{
    code: '1',
    fulfillment: { availability: { Corporate: { Quantity: 1 }, quantity: 0 } },
  }];
  const storeOnly = [{
    code: '2',
    fulfillment: { availability: { Corporate: { Quantity: 0 }, quantity: 2 } },
  }];
  assert.equal(isPurchasable(onlineOnly, ['1']), true);
  assert.equal(isPurchasable(storeOnly, ['2']), true);
  assert.equal(isPurchasable([...onlineOnly, {
    code: '9',
    fulfillment: { availability: { Corporate: { Quantity: 0 }, quantity: 0 } },
  }], ['1', '9']), true);
});

test('isPurchasable treats numeric strings as quantities', () => {
  const rows = [{
    code: '1',
    fulfillment: { availability: { Corporate: { Quantity: '0' }, quantity: '3' } },
  }];
  assert.equal(isPurchasable(rows, ['1']), true);
  assert.equal(isPurchasable([{
    code: '1',
    fulfillment: { availability: { Corporate: { Quantity: '0' }, quantity: '0' } },
  }], ['1']), false);
});

test('isPurchasable drops a deal when every SKU has no online and no store stock', () => {
  const rows = ['334252508', '334252512'].map(code => ({
    code,
    sellable: true,
    orderable: true,
    fulfillment: {
      availability: { Corporate: { Quantity: 0 }, quantity: 0 },
      shipToHome: { enabled: true },
      storePickUp: { enabled: true },
    },
  }));
  assert.equal(isPurchasable(rows, ['334252508', '334252512']), false);
});

test('isPurchasable keeps a deal when one quantity is unknown', () => {
  assert.equal(isPurchasable([{
    code: '1',
    fulfillment: { availability: { Corporate: { Quantity: 0 }, quantity: null } },
  }], ['1']), true);
  assert.equal(isPurchasable([{
    code: '1',
    fulfillment: { availability: { Corporate: { Quantity: '  ' }, quantity: '0' } },
  }], ['1']), true);
});

test('isPurchasable keeps a deal when availability data is missing and does not throw', () => {
  assert.equal(isPurchasable(undefined, ['1']), true);
  assert.equal(isPurchasable(null, ['1']), true);
  assert.equal(isPurchasable([], ['1']), true);
  assert.equal(isPurchasable([{ code: '1' }], ['1']), true);
  assert.equal(isPurchasable([{ code: '1', fulfillment: { availability: { Corporate: { Quantity: 0 }, quantity: 0 } } }], ['1', '2']), true);
  assert.equal(isPurchasable([{ fulfillment: null }, 'nope', null], ['1']), true);
  assert.equal(isPurchasable([{ code: '1', fulfillment: { availability: { Corporate: { Quantity: 'none' }, quantity: null } } }], ['1']), true);
});

test('availabilityErrorIsRetryable retries server errors and not client errors', () => {
  assert.equal(availabilityErrorIsRetryable(new Error('Sport Chek API error: 500  for https://example')), true);
  assert.equal(availabilityErrorIsRetryable(new Error('Sport Chek API error: 429  for https://example')), true);
  assert.equal(availabilityErrorIsRetryable(new Error('Sport Chek API error: 400  for https://example')), false);
  assert.equal(availabilityErrorIsRetryable(new Error('Sport Chek API error: 404  for https://example')), false);
  assert.equal(availabilityErrorIsRetryable(null), false);
});
