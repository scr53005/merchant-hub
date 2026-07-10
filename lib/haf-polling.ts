// HAF (Hive Application Framework) polling logic for merchant-hub
// Polls hafsql_public database for transfers to registered restaurants

import { Pool } from 'pg';
import { Transfer, RestaurantConfig, Currency } from '@/types';
import { getAllAccounts } from './config';
import { getPollingState, updatePollingState, getLastIdFromState, buildLastIdUpdate, publishTransfer } from './redis';
import { computeMinCursor, computeCatchupLowerBound } from './polling-state';

const hafPool = new Pool({
  connectionString: process.env.HAF_CONNECTION_STRING,
  // 60s: rides out provider degradation like 2026-07 (~40-50s/statement
  // PgBouncer queuing). Must stay well under the routes' maxDuration.
  query_timeout: 60000,
});

/**
 * Main polling function - polls HAF for all restaurants and all currencies
 * Uses batched queries (ONE query per currency for ALL restaurants)
 * Queries BOTH prod and dev accounts simultaneously (O(1) scaling makes this negligible)
 * Returns array of detected transfers
 *
 * NEW (Option 3): Uses single hash for all state (1 HGETALL + 1 HMSET)
 */
export async function pollAllTransfers(): Promise<Transfer[]> {
  const allTransfers: Transfer[] = [];
  const pollErrors: string[] = [];

  try {
    // Get ALL polling state in one operation (heartbeat, mode, all lastIds)
    // Redis cost: 1 HGETALL
    const pollingState = await getPollingState();
    console.log('[POLLING] Retrieved polling state from single hash');

    // Get ALL accounts (both prod and dev for all restaurants)
    const accountConfigs = getAllAccounts();
    console.log(`[POLLING] getAllAccounts() returned:`, JSON.stringify(accountConfigs.map(c => ({ account: c.account, restaurant: c.restaurant.id, env: c.env }))));

    const accountToContext = new Map<string, { restaurant: RestaurantConfig; env: 'prod' | 'dev' }>();
    const accountList: string[] = [];

    for (const config of accountConfigs) {
      accountToContext.set(config.account, {
        restaurant: config.restaurant,
        env: config.env
      });
      accountList.push(config.account);
    }

    console.log(`[POLLING] Batched polling for ${accountList.length} accounts (prod+dev): ${accountList.join(', ')}`);
    console.log(`[POLLING] Account map:`, Array.from(accountToContext.entries()).map(([acc, ctx]) => `${acc}→${ctx.restaurant.id}(${ctx.env})`).join(', '));

    // Collect all lastId updates to batch at the end
    const lastIdUpdates: Record<string, string> = {};

    // Each currency is polled in isolation: a failure on one path (e.g. the
    // 2026-07 HAFSQL permission regression on the Hive-Engine views) must not
    // abort the others — before this isolation, an EURO failure discarded
    // already-fetched HBD transfers before they were ever published.

    // Poll HBD - ONE query for all accounts
    try {
      const hbdTransfers = await pollHBDBatched(accountList, accountToContext, pollingState, lastIdUpdates);
      allTransfers.push(...hbdTransfers);
    } catch (error: any) {
      console.error('[POLLING] HBD polling failed:', error.message);
      pollErrors.push(`HBD: ${error.message}`);
    }

    // Poll Hive-Engine tokens (EURO, OCLT, LEI) - ONE query per token.
    // They share the same tables and query shape, so after one systemic
    // failure the remaining tokens are skipped instead of burning another
    // query timeout each.
    for (const symbol of ['EURO', 'OCLT', 'LEI'] as const) {
      try {
        const tokenTransfers = await pollHiveEngineTokenBatched(symbol, accountList, accountToContext, pollingState, lastIdUpdates);
        allTransfers.push(...tokenTransfers);
      } catch (error: any) {
        console.error(`[POLLING] ${symbol} polling failed:`, error.message);
        pollErrors.push(`${symbol}: ${error.message}`);
        break;
      }
    }

    // Publish transfers to environment-specific Redis Streams BEFORE advancing
    // cursors: a failure between the two then causes a re-fetch + re-publish
    // (duplicates, deduped by CO pages) instead of a silent permanent loss
    // (cursor advanced, transfer never published).
    for (const transfer of allTransfers) {
      // Look up the env for this transfer's to_account
      const context = accountToContext.get(transfer.to_account);
      const env = context?.env || 'prod';
      await publishTransfer(transfer.restaurant_id, env, transfer);
    }

    // Update all lastIds in one operation
    // Redis cost: 1 HMSET (updates all changed lastIds at once)
    if (Object.keys(lastIdUpdates).length > 0) {
      await updatePollingState(lastIdUpdates);
      console.log(`[POLLING] Updated ${Object.keys(lastIdUpdates).length} lastId values in single hash`);
    }

    console.log(`[POLLING] Total transfers found: ${allTransfers.length}`);

  } catch (error: any) {
    console.error('[POLLING] Error in batched polling:', error.message);
    pollErrors.push(error.message);
  }

  // Surface failures in /api/status — a HAFSQL outage is otherwise invisible
  // (polls "succeed" with zero transfers). Not cleared on success to avoid an
  // extra Redis write per poll; the timestamp tells the reader whether the
  // error is current.
  if (pollErrors.length > 0) {
    try {
      await updatePollingState({ lastPollError: `${new Date().toISOString()} ${pollErrors.join(' | ')}` });
    } catch {
      // Redis itself unreachable — nothing more we can do here
    }
  }

  return allTransfers;
}

/**
 * Poll HBD transfers for ALL restaurants in a single batched query
 * Uses SQL IN operator to query all accounts at once
 * NEW: Uses polling state object instead of individual Redis calls
 */
async function pollHBDBatched(
  allAccounts: string[],
  accountToContext: Map<string, { restaurant: RestaurantConfig; env: 'prod' | 'dev' }>,
  pollingState: any,
  lastIdUpdates: Record<string, string>
): Promise<Transfer[]> {
  if (allAccounts.length === 0) return [];

  // Get lastId for each ACCOUNT from polling state (no Redis calls)
  const accountLastIds = new Map<string, bigint>();
  for (const account of allAccounts) {
    const lastIdStr = getLastIdFromState(pollingState, account, 'HBD');
    accountLastIds.set(account, BigInt(lastIdStr));
  }
  // True min across cursors — never seed with a numeric "+infinity": real HAF
  // ids exceed Number.MAX_SAFE_INTEGER, so any fixed seed wins the min-scan
  // and leaks into the SQL as a bogus lower bound.
  const minLastId = computeMinCursor(Array.from(accountLastIds.values()));

  console.log(`[HBD BATCHED] Polling ${allAccounts.length} accounts, lastIds:`, Array.from(accountLastIds.entries()).map(([acc, lastId]) => `${acc}=${lastId.toString()}`).join(', '));

  // Query all accounts at once using ANY operator
  const accountsArrayLiteral = `ARRAY['${allAccounts.join("','")}']`;
  const sqlStatement = `SELECT id, to_account, from_account, amount, symbol, memo FROM hafsql.operation_transfer_table WHERE to_account = ANY(${accountsArrayLiteral}) AND symbol = 'HBD' AND id > ${minLastId.toString()} ORDER BY id DESC LIMIT 100`;
  console.warn(`[HBD BATCHED] EXACT SQL: ${sqlStatement}`);

  const result = await hafPool.query(
    `SELECT id, to_account, from_account, amount, symbol, memo
     FROM hafsql.operation_transfer_table
     WHERE to_account = ANY($1)
       AND symbol = 'HBD'
       AND id > $2
     ORDER BY id DESC
     LIMIT 100`,
    [allAccounts, minLastId.toString()]
  );

  console.log(`[HBD BATCHED] Query returned ${result.rows.length} raw rows`);
  if (result.rows.length > 0) {
    console.log(`[HBD BATCHED] Raw rows:`, result.rows.map(r => `id=${r.id} to=${r.to_account} from=${r.from_account} memo="${r.memo.substring(0, 50)}..."`).join(' | '));
  }

  const allTransfers: Transfer[] = [];
  const accountMaxIds = new Map<string, bigint>();

  for (const row of result.rows) {
    const account = row.to_account;
    const context = accountToContext.get(account);

    if (!context) {
      console.warn(`[HBD BATCHED] REJECTED - Unknown account: ${account} (transfer ID: ${row.id})`);
      continue;
    }

    const { restaurant } = context;
    const rowId = BigInt(row.id);
    const accountLastId = accountLastIds.get(account) || BigInt(0);

    // Filter: only include if id > account's lastId
    if (rowId <= accountLastId) {
      console.warn(`[HBD BATCHED] REJECTED - Already processed: ${account} transfer ID ${row.id} (lastId=${accountLastId.toString()})`);
      continue;
    }

    // Check memo filter for this restaurant
    const memoFilter = restaurant.memoFilters.HBD || '%TABLE %';
    const memoPattern = memoFilter.replace(/%/g, '');
    if (!row.memo.includes(memoPattern)) {
      console.warn(`[HBD BATCHED] REJECTED - Memo mismatch for ${account}: pattern="${memoPattern}" memo="${row.memo}" (transfer ID: ${row.id})`);
      continue;
    }

    // Track max ID for this account
    const currentMax = accountMaxIds.get(account) || BigInt(0);
    if (rowId > currentMax) {
      accountMaxIds.set(account, rowId);
    }

    allTransfers.push({
      id: row.id.toString(),
      restaurant_id: restaurant.id,
      to_account: account, // The recipient's Hive account (matches HAFSQL column name)
      from_account: row.from_account,
      amount: row.amount.toString(),
      symbol: 'HBD',
      memo: row.memo,
      parsed_memo: row.memo,
      received_at: new Date().toISOString(),
    });
  }

  // Build lastId updates for each account that received transfers
  // These will be batched together in pollAllTransfers
  for (const [account, maxId] of accountMaxIds) {
    Object.assign(lastIdUpdates, buildLastIdUpdate(account, 'HBD', maxId.toString()));
    console.log(`[HBD BATCHED] Queued lastId update to ${maxId.toString()} for ${account}`);
  }

  console.log(`[HBD BATCHED] Found ${allTransfers.length} transfers across ${accountMaxIds.size} accounts`);
  return allTransfers;
}

/**
 * Poll Hive-Engine tokens (EURO, OCLT) for ALL restaurants in a single batched query
 * Uses block range and filters in application code for each restaurant
 * NEW: Uses polling state object instead of individual Redis calls
 */
async function pollHiveEngineTokenBatched(
  symbol: 'EURO' | 'OCLT' | 'LEI',
  allAccounts: string[],
  accountToContext: Map<string, { restaurant: RestaurantConfig; env: 'prod' | 'dev' }>,
  pollingState: any,
  lastIdUpdates: Record<string, string>
): Promise<Transfer[]> {
  if (allAccounts.length === 0) return [];

  // Get lastId for each ACCOUNT from polling state (no Redis calls)
  const accountLastIds = new Map<string, bigint>();
  for (const account of allAccounts) {
    const lastIdStr = getLastIdFromState(pollingState, account, symbol);
    accountLastIds.set(account, BigInt(lastIdStr));
  }
  // True min across cursors — see pollHBDBatched for why no numeric seed.
  const minLastId = computeMinCursor(Array.from(accountLastIds.values()));

  console.log(`[${symbol} BATCHED] Polling ${allAccounts.length} accounts, minLastId=${minLastId.toString()}`);

  const client = await hafPool.connect();

  try {
    // Single round trip for both SETs: under provider queuing EVERY statement
    // costs the full queue latency, so each merged statement saves ~40s
    await client.query("SET statement_timeout = 60000; SET timezone = 'UTC'");

    // Head block from hafd.blocks — a fast PK scan, and still granted to
    // hafsql_public (the old hafsql.haf_blocks view lost its grant in the
    // provider's 2026-07 server migration). Irreversible-only, which is fine:
    // it only bounds the catch-up window; the ops query below has no upper
    // bound, so the newest (reversible) operations are still included.
    const blockQuery = await client.query(
      `SELECT num FROM hafd.blocks ORDER BY num DESC LIMIT 1`
    );
    const headBlock = BigInt(blockQuery.rows[0]?.num ?? 108000000);
    // Catch-up window: min cursor, capped at ~10k blocks back (≈8 hours) —
    // same policy as before the rewrite
    const lowerBound = computeCatchupLowerBound(headBlock, minLastId);

    // Query custom_json operations for ALL restaurants at once via the
    // standard HAF hive.operations_view — grants-proof and portable, unlike
    // the revoked hafsql.operation_custom_json_view. op_type_id 18 =
    // custom_json_operation. The id-range bound hits the primary key index;
    // filtering on this view's block_num column does NOT.
    const result = await client.query(
      `SELECT o.id,
              b.created_at AT TIME ZONE 'UTC' AS timestamp,
              o.body->'value'->'required_auths' AS required_auths,
              o.body->'value'->>'json' AS json,
              o.block_num
       FROM hive.operations_view o
       LEFT JOIN hive.blocks_view b ON b.num = o.block_num
       WHERE o.op_type_id = 18
         AND o.body->'value'->>'id' = 'ssc-mainnet-hive'
         AND o.id > $1
       ORDER BY o.id DESC
       LIMIT 1000`,
      [lowerBound.toString()]
    );

    console.log(`[${symbol} BATCHED] Query returned ${result.rows.length} raw custom_json rows`);

    if (result.rows.length === 0) {
      return [];
    }

    const allTransfers: Transfer[] = [];
    const accountMaxIds = new Map<string, bigint>();

    for (const row of result.rows) {
      // Parse JSON
      let jsonData: any;
      try {
        jsonData = typeof row.json === 'string' ? JSON.parse(row.json) : row.json;
      } catch (e) {
        console.error(`[${symbol} BATCHED] Error parsing JSON:`, e);
        continue;
      }

      // Filter: only token transfers with matching symbol
      if (
        jsonData.contractName !== 'tokens' ||
        jsonData.contractAction !== 'transfer' ||
        jsonData.contractPayload?.symbol !== symbol
      ) {
        continue;
      }

      const toAccount = jsonData.contractPayload?.to;
      if (!toAccount || !accountToContext.has(toAccount)) {
        continue; // Not for any of our restaurants
      }

      const context = accountToContext.get(toAccount)!;
      const { restaurant } = context;
      const rowId = BigInt(row.id);
      const accountLastId = accountLastIds.get(toAccount) || BigInt(0);

      // Filter: only include if id > account's lastId
      if (rowId <= accountLastId) {
        continue;
      }

      // Extract and check memo
      const memoRaw = jsonData.contractPayload?.memo;
      const memoString = typeof memoRaw === 'string' ? memoRaw : (memoRaw ? JSON.stringify(memoRaw) : '');
      const memoFilter = restaurant.memoFilters[symbol] || '%TABLE %';
      const memoPattern = memoFilter.replace(/%/g, '');

      if (!memoString.includes(memoPattern)) {
        continue; // Memo doesn't match restaurant's filter
      }

      // Parse from_account from required_auths
      let fromAccount = 'unknown';
      try {
        const authsArray = typeof row.required_auths === 'string'
          ? JSON.parse(row.required_auths)
          : row.required_auths;
        if (authsArray && authsArray.length > 0) {
          fromAccount = authsArray[0];
        }
      } catch (e) {
        console.error(`[${symbol} BATCHED] Error parsing required_auths:`, e);
      }

      const quantity = jsonData.contractPayload?.quantity || '0';

      // Track max ID for this account
      const currentMax = accountMaxIds.get(toAccount) || BigInt(0);
      if (rowId > currentMax) {
        accountMaxIds.set(toAccount, rowId);
      }

      allTransfers.push({
        id: row.id.toString(),
        restaurant_id: restaurant.id,
        to_account: toAccount, // The recipient's Hive account (matches HAFSQL column name)
        from_account: fromAccount,
        amount: quantity,
        symbol: symbol,
        memo: memoString,
        parsed_memo: memoString,
        // timestamp can be null if the block joined from blocks_view is not
        // visible yet — fall back to "now" rather than new Date(null) = 1970
        received_at: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
        block_num: row.block_num,
      });
    }

    // Build lastId updates for each account that received transfers
    // These will be batched together in pollAllTransfers
    for (const [account, maxId] of accountMaxIds) {
      Object.assign(lastIdUpdates, buildLastIdUpdate(account, symbol, maxId.toString()));
      console.log(`[${symbol} BATCHED] Queued lastId update to ${maxId.toString()} for ${account}`);
    }

    console.log(`[${symbol} BATCHED] Found ${allTransfers.length} transfers across ${accountMaxIds.size} accounts`);
    return allTransfers;
  } finally {
    client.release();
  }
}
