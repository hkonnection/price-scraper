#!/usr/bin/env node
/** Publish explicit saved Lululemon JSON inputs as one retailer snapshot; never collect.
 * Usage: node scraper/local/publish-lululemon.mjs [--dry-run | --publish] [--captured-at UTC_ISO] -- file.json [...]
 * Defaults to dry-run. Files may be raw {deals,totalProducts,sections} envelopes or arrays.
 * Submit all intended sections together; publication replaces the whole retailer snapshot.
 * Serialize with every other Lululemon writer. Counts are submitted, not section receipts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clean } from '../src/cleaners/lululemon.js';

/** Parse explicit filenames, optional capture time and safe default dry-run. @param {string[]} argv Arguments. @returns {object} Files, capture time and mode. @throws {Error} On invalid flags, missing values/files or duplicate paths. */
function parseArgs(argv) {
  let publish = false, mode = null, positional = false, capturedAt;
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!positional && arg === '--captured-at') {
      if (capturedAt !== undefined) throw new Error('Duplicate captured_at argument.');
      capturedAt = argv[++index];
      if (capturedAt === undefined || capturedAt.startsWith('--')) throw new Error('Missing captured_at value.');
      continue;
    }
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && ['--dry-run', '--publish'].includes(arg)) {
      if (mode) throw new Error('Choose one mode: --dry-run or --publish.');
      mode = arg; publish = arg === '--publish';
    } else if (!positional && arg.startsWith('-')) {
      throw new Error('Unknown argument. Use [--dry-run | --publish] -- file.json [...].');
    } else files.push(arg);
  }
  if (!files.length) throw new Error('At least one explicit saved JSON file is required.');
  if (new Set(files.map(file => path.resolve(file))).size !== files.length) throw new Error('Duplicate input file path. Select each capture only once.');
  return { files, publish, capturedAt };
}

/** Test a strict ISO date or timestamp, excluding SQL text and impossible calendar dates. @param {*} value Input. @returns {boolean} Valid date. */
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Validate every field interpolated by the existing publisher without dropping or coercing rows. @param {object[]} rows Deals. @param {string} file Exact filename. @returns {void} @throws {Error} On unusable records. */
function validateRows(rows, file) {
  for (const [index, row] of rows.entries()) {
    /** Fail with a field name only, never a captured value. @param {string} field Invalid field. @returns {never} @throws {Error} Always. */
    function invalid(field) { throw new Error(`Invalid ${field} in ${JSON.stringify(file)} row ${index + 1}.`); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('deal object');
    for (const field of ['product_name', 'category']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) invalid(field);
    }
    for (const field of ['product_code', 'brand', 'promo_type', 'image_url', 'product_url']) {
      if (row[field] != null && typeof row[field] !== 'string') invalid(field);
    }
    for (const field of ['regular_price', 'sale_price', 'savings_amount', 'savings_percent']) {
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) invalid(field);
    }
    if (row.sale_price <= 0 || row.sale_price >= row.regular_price) invalid('sale_price');
    if (row.savings_percent > 100) invalid('savings_percent');
    if (row.in_stock !== undefined && ![0, 1].includes(row.in_stock)) invalid('in_stock');
    if (!isDate(row.scraped_at)) invalid('scraped_at');
    for (const field of ['valid_from', 'valid_to']) {
      if (row[field] != null && !isDate(row[field])) invalid(field);
    }
  }
}

/** Load and normalize one supported saved file. Cleaner markers define already-cleaned input, not filename guesses. @param {string} file Explicit JSON path. @returns {object[]} Valid deals. @throws {Error} On read, shape or record failure. */
export function loadDeals(file) {
  let text, data;
  try {
    if (!fs.statSync(file).isFile()) throw new Error();
    text = fs.readFileSync(file, 'utf8');
  } catch { throw new Error(`Cannot read saved JSON file ${JSON.stringify(file)}.`); }
  try { data = JSON.parse(text); }
  catch { throw new Error(`Invalid JSON in ${JSON.stringify(file)}.`); }
  let rows = data;
  if (!Array.isArray(data)) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.deals) ||
        !Number.isInteger(data.totalProducts) || data.totalProducts < 0 || !Array.isArray(data.sections) ||
        !data.sections.every(section => section && typeof section.name === 'string' && section.name.trim() &&
          Number.isInteger(section.dealCount) && section.dealCount >= 0)) {
      throw new Error(`Expected a deal array or raw {deals,totalProducts,sections} envelope in ${JSON.stringify(file)}.`);
    }
    rows = data.deals;
  }
  if (!rows.length) throw new Error(`Empty deals in ${JSON.stringify(file)}.`);
  validateRows(rows, file);
  const alreadyCleaned = rows.every(row => row.brand === 'Lululemon' && row.promo_type === 'We Made Too Much');
  return alreadyCleaned ? rows : clean(rows);
}

/** Parse a strict UTC ISO timestamp without calendar rollover or offset coercion. @param {*} value Timestamp. @param {string} field Error label. @returns {string} Canonical UTC timestamp. @throws {Error} On malformed or impossible dates. */
function utcTimestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error(`Invalid ${field}: expected a UTC ISO timestamp.`);
  const date = new Date(value);
  const canonical = value.length === 20 ? value.replace('Z', '.000Z') : value;
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) throw new Error(`Invalid ${field}: impossible UTC date.`);
  return canonical;
}

/** Validate all files and optional capture bounds first, then make at most one publication. No publisher import in dry-run. @param {string[]} argv Arguments. @returns {Promise<number>} Successfully submitted combined row count. @throws {Error} For validation or publication failure, without remote error bodies. */
export async function main(argv) {
  const { files, publish, capturedAt } = parseArgs(argv);
  const seen = new Set();
  const inputs = files.map(file => {
    const deals = loadDeals(file);
    const resolved = fs.realpathSync(file);
    if (seen.has(resolved)) throw new Error('Duplicate input file path. Select each capture only once.');
    seen.add(resolved);
    return { file, deals };
  });
  const deals = inputs.flatMap(input => input.deals);
  let captureTime;
  if (capturedAt !== undefined && capturedAt !== '') {
    captureTime = utcTimestamp(capturedAt, 'captured_at');
    if (Date.parse(captureTime) > Date.now()) throw new Error('Invalid captured_at: capture time is in the future.');
    for (const input of inputs) for (const [index, deal] of input.deals.entries()) {
      const rowTime = utcTimestamp(deal.scraped_at, `scraped_at in ${JSON.stringify(input.file)} row ${index + 1}`);
      if (Date.parse(rowTime) > Date.parse(captureTime)) throw new Error('Invalid captured_at: capture time precedes a source row scraped_at.');
    }
  }
  for (const input of inputs) console.log(`Submitted ${JSON.stringify(input.file)}: ${input.deals.length}`);
  console.log(`Submitted total: ${deals.length}`);
  console.log('These are submitted counts, not independently verified persisted section counts.');
  if (!publish) { console.log('Dry run complete: no D1 call.'); return deals.length; }
  try {
    const { pushToD1 } = await import('../src/db/d1.js');
    if (captureTime) await pushToD1(deals, 'lululemon', null, captureTime);
    else await pushToD1(deals, 'lululemon');
    return deals.length;
  } catch {
    throw new Error('Publication failed; the snapshot may already have been completed. Verify remote state before retrying.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const total = await main(process.argv.slice(2));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `submitted_total=${total}\n`);
  }
  catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
}
