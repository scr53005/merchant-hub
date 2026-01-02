// HAF (Hive Application Framework) polling logic for merchant-hub
// Polls hafsql_public database for transfers to registered restaurants

import { Pool } from 'pg';
import { Transfer, RestaurantConfig, Currency } from '@/types';
import { getAllAccounts } from './config';
import { getLastId, setLastId, publishTransfer } from './redis';

const hafPool = new Pool({
  connectionString: process.env.HAF_CONNECTION_STRING,
  query_timeout: 30000,
});

/**
 * Main polling function - polls HAF for all restaurants and all currencies
 * Uses batched queries (ONE query per currency for ALL restaurants)
 * Queries BOTH prod and dev accounts simultaneously (O(1) scaling makes this negligible)
 * Returns array of detected transfers
 */
export async function pollAllTransfers(): Promise<Transfer[]> {
  const allTransfers: Transfer[] = [];

  try {
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

    // Poll HBD - ONE query for all accounts
    const hbdTransfers = await pollHBDBatched(accountList, accountToContext);
    allTransfers.push(...hbdTransfers);

    // Poll EURO - ONE query for all accounts
    const euroTransfers = await pollHiveEngineTokenBatched('EURO', accountList, accountToContext);
    allTransfers.push(...euroTransfers);

    // Poll OCLT - ONE query for all accounts
    const ocltTransfers = await pollHiveEngineTokenBatched('OCLT', accountList, accountToContext);
    allTransfers.push(...ocltTransfers);

    // Publish transfers to Redis Streams (grouped by restaurant)
    // Co pages will filter by account name if they need environment-specific filtering
    for (const transfer of allTransfers) {
      await publishTransfer(transfer.restaurant_id, transfer);
    }

    console.log(`[POLLING] Total transfers found: ${allTransfers.length}`);

  } catch (error: any) {
    console.error('[POLLING] Error in batched polling:', error.message);
  }

  return allTransfers;
}

/**
 * Poll HBD transfers for ALL restaurants in a single batched query
 * Uses SQL IN operator to query all accounts at once
 */
async function pollHBDBatched(
  allAccounts: string[],
  accountToContext: Map<string, { restaurant: RestaurantConfig; env: 'prod' | 'dev' }>
): Promise<Transfer[]> {
  if (allAccounts.length === 0) return [];

  // Get lastId for each ACCOUNT (not restaurant) to properly handle prod/dev separately
  const accountLastIds = new Map<string, bigint>();
  let minLastId = BigInt(Number.MAX_SAFE_INTEGER);

  for (const account of allAccounts) {
    const lastIdStr = await getLastId(account, 'HBD');
    const lastIdBigInt = BigInt(lastIdStr);
    accountLastIds.set(account, lastIdBigInt);
    if (lastIdBigInt < minLastId) {
      minLastId = lastIdBigInt;
    }
  }

  console.log(`[HBD BATCHED] Polling ${allAccounts.length} accounts, minLastId=${minLastId.toString()}`);
  console.log(`[HBD BATCHED] Account lastIds:`, Array.from(accountLastIds.entries()).map(([acc, lastId]) => `${acc}=${lastId.toString()}`).join(', '));

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
      account: account, // Include account for environment filtering in co pages
      from_account: row.from_account,
      amount: row.amount.toString(),
      symbol: 'HBD',
      memo: row.memo,
      parsed_memo: row.memo,
      received_at: new Date().toISOString(),
    });
  }

  // Update lastId for each account that received transfers
  for (const [account, maxId] of accountMaxIds) {
    await setLastId(account, 'HBD', maxId.toString());
    console.log(`[HBD BATCHED] Updated lastId to ${maxId.toString()} for ${account}`);
  }

  console.log(`[HBD BATCHED] Found ${allTransfers.length} transfers across ${accountMaxIds.size} accounts`);
  return allTransfers;
}

/**
 * Poll Hive-Engine tokens (EURO, OCLT) for ALL restaurants in a single batched query
 * Uses block range and filters in application code for each restaurant
 */
async function pollHiveEngineTokenBatched(
  symbol: 'EURO' | 'OCLT',
  allAccounts: string[],
  accountToContext: Map<string, { restaurant: RestaurantConfig; env: 'prod' | 'dev' }>
): Promise<Transfer[]> {
  if (allAccounts.length === 0) return [];

  // Get lastId for each ACCOUNT (not restaurant) to properly handle prod/dev separately
  const accountLastIds = new Map<string, bigint>();
  let minLastId = BigInt(Number.MAX_SAFE_INTEGER);

  for (const account of allAccounts) {
    const lastIdStr = await getLastId(account, symbol);
    const lastIdBigInt = BigInt(lastIdStr);
    accountLastIds.set(account, lastIdBigInt);
    if (lastIdBigInt < minLastId) {
      minLastId = lastIdBigInt;
    }
  }

  console.log(`[${symbol} BATCHED] Polling ${allAccounts.length} accounts, minLastId=${minLastId.toString()}`);

  const client = await hafPool.connect();

  try {
    await client.query('SET statement_timeout = 30000');
    await client.query("SET timezone = 'UTC'");

    // Get current block number
    const blockQuery = await client.query(`
      SELECT block_num
      FROM hafsql.haf_blocks
      ORDER BY block_num DESC
      LIMIT 1
    `);
    const currentBlock = blockQuery.rows[0]?.block_num || 101140000;
    const startBlock = currentBlock - 10000; // Search last ~10k blocks (≈8 hours)

    // Query custom_json operations for ALL restaurants at once
    const result = await client.query(
      `SELECT id, timestamp AT TIME ZONE 'UTC' as timestamp, required_auths, json, block_num
       FROM hafsql.operation_custom_json_view
       WHERE block_num BETWEEN $1 AND $2
         AND custom_id = 'ssc-mainnet-hive'
         AND id > $3
       ORDER BY block_num DESC
       LIMIT 1000`,
      [startBlock, currentBlock, minLastId.toString()]
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
        account: toAccount, // Include account for environment filtering in co pages
        from_account: fromAccount,
        amount: quantity,
        symbol: symbol,
        memo: memoString,
        parsed_memo: memoString,
        received_at: new Date(row.timestamp).toISOString(),
        block_num: row.block_num,
      });
    }

    // Update lastId for each account that received transfers
    for (const [account, maxId] of accountMaxIds) {
      await setLastId(account, symbol, maxId.toString());
      console.log(`[${symbol} BATCHED] Updated lastId to ${maxId.toString()} for ${account}`);
    }

    console.log(`[${symbol} BATCHED] Found ${allTransfers.length} transfers across ${accountMaxIds.size} accounts`);
    return allTransfers;
  } finally {
    client.release();
  }
}
