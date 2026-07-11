// Transfer-polling orchestrator for merchant-hub.
//
// Phase 1 of HIVESQL-HA-PLAN.md: all source-specific work (SQL, connections,
// row normalization, catch-up policy) lives behind the PollingSource adapter
// (lib/sources/); this module owns only the source-INDEPENDENT pipeline:
// cursor bookkeeping, memo filtering, Transfer mapping, publish ordering,
// and Redis state writes. Phase 3 replaces the hardcoded source below with
// the failover source manager.

import { Transfer, RestaurantConfig } from '@/types';
import { getAllAccounts } from './config';
import { getPollingState, updatePollingState, getLastIdFromState, buildLastIdUpdate, publishTransfer } from './redis';
import { computeMinCursor } from './polling-state';
import { PollingSource } from './sources/types';
import { hafsqlSource } from './sources/hafsql';

// Phase 3 replaces this with the source manager's choice
const activeSource: PollingSource = hafsqlSource;

// Sync-lag check throttle: one extra statement per minute, not per 6s poll —
// bounds both the SQL cost during provider degradation (a statement can take
// 45s+) and the Redis writes on quiet polls.
const SYNC_LAG_CHECK_INTERVAL_MS = 60_000;

/**
 * Main polling function - polls the active source for all restaurants and
 * all currencies. Uses batched queries (ONE query per currency for ALL
 * restaurants), both prod and dev accounts simultaneously.
 * Returns array of detected transfers.
 *
 * Redis budget: 1 HGETALL + 1 HMSET (all cursor updates batched).
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
      const hbdTransfers = await pollHBDBatched(activeSource, accountList, accountToContext, pollingState, lastIdUpdates);
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
        const tokenTransfers = await pollHiveEngineTokenBatched(activeSource, symbol, accountList, accountToContext, pollingState, lastIdUpdates);
        allTransfers.push(...tokenTransfers);
      } catch (error: any) {
        console.error(`[POLLING] ${symbol} polling failed:`, error.message);
        pollErrors.push(`${symbol}: ${error.message}`);
        break;
      }
    }

    // Sync-lag check (throttled): the HBD source can be a derived table filled
    // by a separate indexer — it can freeze while queries keep succeeding
    // with zero new rows (2026-07-10 backup server: ~19h behind, zero errors).
    // Surface the lag in /api/status + dashboard. Skipped when this poll
    // already failed: no point burning another query timeout on a down provider.
    if (pollErrors.length === 0) {
      try {
        const lastChecked = pollingState.hbdSourceLagCheckedAt
          ? Date.parse(String(pollingState.hbdSourceLagCheckedAt))
          : NaN;
        if (isNaN(lastChecked) || Date.now() - lastChecked > SYNC_LAG_CHECK_INTERVAL_MS) {
          const health = await activeSource.healthCheck();
          if (health.reachable && health.hbdLagBlocks != null) {
            // Piggybacks on the lastIds HMSET below (same Redis write)
            lastIdUpdates['hbdSourceLagBlocks'] = health.hbdLagBlocks;
            lastIdUpdates['hbdSourceLagCheckedAt'] = new Date().toISOString();
            if (BigInt(health.hbdLagBlocks) > BigInt(100)) {
              console.warn(`[POLLING] HBD source lag: ${health.hbdLagBlocks} blocks behind head — ${activeSource.name} transfer indexer may be frozen`);
            }
          } else if (!health.reachable) {
            console.error('[POLLING] Sync-lag check failed:', health.error);
          }
        }
      } catch (error: any) {
        // Diagnostics only — never let the lag check break a working poll
        console.error('[POLLING] Sync-lag check failed:', error.message);
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

  // Surface failures in /api/status — a source outage is otherwise invisible
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
 * Poll HBD transfers for ALL restaurants in a single batched source query.
 * Cursor bookkeeping and memo filtering are source-independent; the adapter
 * returns normalized rows newest-first.
 */
async function pollHBDBatched(
  source: PollingSource,
  allAccounts: string[],
  accountToContext: Map<string, { restaurant: RestaurantConfig; env: 'prod' | 'dev' }>,
  pollingState: any,
  lastIdUpdates: Record<string, string>
): Promise<Transfer[]> {
  if (allAccounts.length === 0) return [];

  // Get cursor for each ACCOUNT from polling state (no Redis calls)
  const accountLastIds = new Map<string, bigint>();
  for (const account of allAccounts) {
    const lastIdStr = getLastIdFromState(pollingState, account, 'HBD');
    accountLastIds.set(account, BigInt(lastIdStr));
  }
  // True min across cursors — never seed with a numeric "+infinity": real HAF
  // ids exceed Number.MAX_SAFE_INTEGER, so any fixed seed wins the min-scan
  // and leaks into the SQL as a bogus lower bound.
  const minLastId = computeMinCursor(Array.from(accountLastIds.values()));

  console.log(`[HBD BATCHED] Polling ${allAccounts.length} accounts via ${source.name}, lastIds:`, Array.from(accountLastIds.entries()).map(([acc, lastId]) => `${acc}=${lastId.toString()}`).join(', '));

  const rows = await source.fetchHbdRows(allAccounts, minLastId);

  console.log(`[HBD BATCHED] Query returned ${rows.length} raw rows`);
  if (rows.length > 0) {
    console.log(`[HBD BATCHED] Raw rows:`, rows.map(r => `id=${r.transferId} to=${r.to_account} from=${r.from_account} memo="${r.memo.substring(0, 50)}..."`).join(' | '));
  }

  const allTransfers: Transfer[] = [];
  const accountMaxIds = new Map<string, bigint>();

  for (const row of rows) {
    const account = row.to_account;
    const context = accountToContext.get(account);

    if (!context) {
      console.warn(`[HBD BATCHED] REJECTED - Unknown account: ${account} (transfer ID: ${row.transferId})`);
      continue;
    }

    const { restaurant } = context;
    const rowCursor = BigInt(row.cursor);
    const accountLastId = accountLastIds.get(account) || BigInt(0);

    // Filter: only include if cursor > account's cursor
    if (rowCursor <= accountLastId) {
      console.warn(`[HBD BATCHED] REJECTED - Already processed: ${account} transfer ID ${row.transferId} (lastId=${accountLastId.toString()})`);
      continue;
    }

    // Check memo filter for this restaurant
    const memoFilter = restaurant.memoFilters.HBD || '%TABLE %';
    const memoPattern = memoFilter.replace(/%/g, '');
    if (!row.memo.includes(memoPattern)) {
      console.warn(`[HBD BATCHED] REJECTED - Memo mismatch for ${account}: pattern="${memoPattern}" memo="${row.memo}" (transfer ID: ${row.transferId})`);
      continue;
    }

    // Track max cursor for this account
    const currentMax = accountMaxIds.get(account) || BigInt(0);
    if (rowCursor > currentMax) {
      accountMaxIds.set(account, rowCursor);
    }

    allTransfers.push({
      id: row.transferId,
      restaurant_id: restaurant.id,
      to_account: account, // The recipient's Hive account (matches HAFSQL column name)
      from_account: row.from_account,
      amount: row.amount,
      symbol: 'HBD',
      memo: row.memo,
      parsed_memo: row.memo,
      received_at: row.received_at,
    });
  }

  // Build cursor updates for each account that received transfers
  // These will be batched together in pollAllTransfers
  for (const [account, maxId] of accountMaxIds) {
    Object.assign(lastIdUpdates, buildLastIdUpdate(account, 'HBD', maxId.toString()));
    console.log(`[HBD BATCHED] Queued lastId update to ${maxId.toString()} for ${account}`);
  }

  console.log(`[HBD BATCHED] Found ${allTransfers.length} transfers across ${accountMaxIds.size} accounts`);
  return allTransfers;
}

/**
 * Poll Hive-Engine tokens (EURO, OCLT, LEI) for ALL restaurants in a single
 * batched source query. The adapter returns raw custom_json ops; symbol,
 * recipient and memo filtering happen here in application code.
 */
async function pollHiveEngineTokenBatched(
  source: PollingSource,
  symbol: 'EURO' | 'OCLT' | 'LEI',
  allAccounts: string[],
  accountToContext: Map<string, { restaurant: RestaurantConfig; env: 'prod' | 'dev' }>,
  pollingState: any,
  lastIdUpdates: Record<string, string>
): Promise<Transfer[]> {
  if (allAccounts.length === 0) return [];

  // Get cursor for each ACCOUNT from polling state (no Redis calls)
  const accountLastIds = new Map<string, bigint>();
  for (const account of allAccounts) {
    const lastIdStr = getLastIdFromState(pollingState, account, symbol);
    accountLastIds.set(account, BigInt(lastIdStr));
  }
  // True min across cursors — see pollHBDBatched for why no numeric seed.
  const minLastId = computeMinCursor(Array.from(accountLastIds.values()));

  console.log(`[${symbol} BATCHED] Polling ${allAccounts.length} accounts via ${source.name}, minLastId=${minLastId.toString()}`);

  const rows = await source.fetchHiveEngineOps(minLastId);

  console.log(`[${symbol} BATCHED] Query returned ${rows.length} raw custom_json rows`);

  if (rows.length === 0) {
    return [];
  }

  const allTransfers: Transfer[] = [];
  const accountMaxIds = new Map<string, bigint>();

  for (const row of rows) {
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
    const rowCursor = BigInt(row.cursor);
    const accountLastId = accountLastIds.get(toAccount) || BigInt(0);

    // Filter: only include if cursor > account's cursor
    if (rowCursor <= accountLastId) {
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
      if (Array.isArray(authsArray) && authsArray.length > 0) {
        fromAccount = authsArray[0];
      }
    } catch (e) {
      console.error(`[${symbol} BATCHED] Error parsing required_auths:`, e);
    }

    const quantity = jsonData.contractPayload?.quantity || '0';

    // Track max cursor for this account
    const currentMax = accountMaxIds.get(toAccount) || BigInt(0);
    if (rowCursor > currentMax) {
      accountMaxIds.set(toAccount, rowCursor);
    }

    allTransfers.push({
      id: row.transferId,
      restaurant_id: restaurant.id,
      to_account: toAccount, // The recipient's Hive account (matches HAFSQL column name)
      from_account: fromAccount,
      amount: quantity,
      symbol: symbol,
      memo: memoString,
      parsed_memo: memoString,
      received_at: row.received_at,
      block_num: row.block_num,
    });
  }

  // Build cursor updates for each account that received transfers
  // These will be batched together in pollAllTransfers
  for (const [account, maxId] of accountMaxIds) {
    Object.assign(lastIdUpdates, buildLastIdUpdate(account, symbol, maxId.toString()));
    console.log(`[${symbol} BATCHED] Queued lastId update to ${maxId.toString()} for ${account}`);
  }

  console.log(`[${symbol} BATCHED] Found ${allTransfers.length} transfers across ${accountMaxIds.size} accounts`);
  return allTransfers;
}
