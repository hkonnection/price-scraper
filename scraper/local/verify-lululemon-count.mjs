#!/usr/bin/env node
/** Verify raw persisted Lululemon row count using GitHub-hosted credentials; never publish.
 * Workflow environment: SUBMITTED_TOTAL, DRY_RUN and the existing three CLOUDFLARE_* secrets.
 * Dry-run differences are expected; real publication requires exact equality. No retries.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COUNT_SQL = "SELECT COUNT(*) AS persisted_count FROM deals d JOIN retailers r ON d.retailer_id = r.id WHERE r.slug = 'lululemon'";

/**
 * Issue one fixed read-only D1 query and verify the successful submitted total.
 * Counts include all retailer rows, regardless of history, eligibility or section.
 * @param {object} options - Explicit environment and injectable offline I/O.
 * @param {object} options.env - Workflow values; defaults to process.env on the runner.
 * @param {Function} options.fetchImpl - Fetch transport; defaults to native fetch.
 * @param {Function} options.log - Count-only log sink.
 * @returns {Promise<number>} Independently observed persisted row count.
 * @throws {Error} Sanitized validation/query errors or a real-publication mismatch.
 */
export async function verifyCount({ env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') throw new Error('Invalid dry_run value for count verification.');
  if (typeof env.SUBMITTED_TOTAL !== 'string' || !/^[1-9]\d*$/.test(env.SUBMITTED_TOTAL) ||
      !Number.isSafeInteger(Number(env.SUBMITTED_TOTAL))) throw new Error('Invalid submitted total for count verification.');
  const submittedTotal = Number(env.SUBMITTED_TOTAL);
  const keys = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_D1_DATABASE_ID'];
  if (keys.some(key => typeof env[key] !== 'string' || !env[key].trim())) {
    throw new Error('Missing required hosted Cloudflare secrets for count verification.');
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.CLOUDFLARE_D1_DATABASE_ID)}/query`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: COUNT_SQL }),
    });
  } catch { throw new Error('D1 count request failed (transport, redirect or timeout); no retry performed.'); }
  if (!response?.ok) throw new Error('D1 count request returned an unsuccessful HTTP response.');
  let body;
  try { body = await response.json(); }
  catch { throw new Error('D1 count response was not valid JSON.'); }
  if (body?.success !== true || (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) ||
      !Array.isArray(body.result) || body.result.length !== 1 || body.result[0]?.success !== true) {
    throw new Error('D1 count query failed or returned a malformed result envelope.');
  }
  const rows = body.result[0].results;
  const count = Array.isArray(rows) && rows.length === 1 ? rows[0]?.persisted_count : undefined;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('D1 count response must contain one nonnegative safe integer persisted_count.');
  log(`Persisted lululemon rows: ${count}`);
  log(`Verification mode: dry_run=${env.DRY_RUN}; submitted_total=${submittedTotal}`);
  if (env.DRY_RUN === 'false' && count !== submittedTotal) {
    throw new Error(`Persisted row count mismatch: expected ${submittedTotal}, observed ${count}. Publication may already have occurred; no retry or rollback performed.`);
  }
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyCount(); }
  catch (error) {
    console.error(`Error: ${error.message} If this was a real publish, writes may already have occurred; stop and inspect the run.`);
    process.exitCode = 1;
  }
}
