// HAF (Hive Application Framework) polling logic for merchant-hub
// Polls hafsql_public database for transfers to registered restaurants

import { Pool } from 'pg';
import { Transfer, RestaurantConfig, Currency } from '@/types';
import { RESTAURANTS, getRestaurantAccount } from './config';
import { getLastId, setLastId, publishTransfer } from './redis';

const hafPool = new Pool({
  connectionString: process.env.HAF_CONNECTION_STRING,
  query_timeout: 30000,
});

/**
 * Main polling function - polls HAF for all restaurants and all currencies
 * Returns array of detected transfers
 */
export async function pollAllTransfers(): Promise<Transfer[]> {
  const allTransfers: Transfer[] = [];

  for (const restaurant of RESTAURANTS) {
    const account = getRestaurantAccount(restaurant);

    for (const currency of restaurant.currencies) {
      try {
        let transfers: Transfer[] = [];

        if (currency === 'HBD') {
          transfers = await pollHBD(restaurant, account);
        } else if (currency === 'EURO' || currency === 'OCLT') {
          // EURO and OCLT are both Hive-Engine tokens
          transfers = await pollHiveEngineToken(restaurant, account, currency);
        }

        // Publish each transfer to Redis Stream
        for (const transfer of transfers) {
          await publishTransfer(restaurant.id, transfer);
        }

        allTransfers.push(...transfers);
      } catch (error: any) {
        console.error(`Error polling ${currency} for ${restaurant.id}:`, error.message);
      }
    }
  }

  return allTransfers;
}

/**
 * Poll HBD transfers from hafsql.operation_transfer_table
 */
async function pollHBD(
  restaurant: RestaurantConfig,
  account: string
): Promise<Transfer[]> {
  const lastId = await getLastId(restaurant.id, 'HBD');
  const memoFilter = restaurant.memoFilters.HBD || '%TABLE %';

  console.log(`[HBD] Polling for restaurant '${restaurant.id}' account='${account}' lastId='${lastId}' memoFilter='${memoFilter}'`);

  const result = await hafPool.query(
    `SELECT id, from_account, amount, symbol, memo
     FROM hafsql.operation_transfer_table
     WHERE to_account = $1
       AND symbol = 'HBD'
       AND memo LIKE $2
       AND id > $3
     ORDER BY id DESC
     LIMIT 10`,
    [account, memoFilter, lastId]
  );

  console.log(`[HBD] Found ${result.rows.length} new transfers for restaurant='${restaurant.id}' account='${account}'`);

  if (result.rows.length === 0) {
    return [];
  }

  // Update last processed ID
  await setLastId(restaurant.id, 'HBD', result.rows[0].id.toString());
  console.log(`[HBD] Updated lastId to ${result.rows[0].id.toString()} for ${restaurant.id}`);

  // Transform rows to Transfer objects
  const transfers: Transfer[] = result.rows.map((row) => ({
    id: row.id.toString(),
    restaurant_id: restaurant.id,
    from_account: row.from_account,
    amount: row.amount.toString(),
    symbol: 'HBD',
    memo: row.memo,
    parsed_memo: row.memo,
    received_at: new Date().toISOString(), // Server time (limitation: not blockchain time)
  }));

  return transfers;
}

/**
 * Poll Hive-Engine tokens (EURO, OCLT) from hafsql.operation_custom_json_view
 */
async function pollHiveEngineToken(
  restaurant: RestaurantConfig,
  account: string,
  symbol: 'EURO' | 'OCLT'
): Promise<Transfer[]> {
  const lastId = await getLastId(restaurant.id, symbol);
  const memoFilter = restaurant.memoFilters[symbol] || '%TABLE %';

  console.log(`[${symbol}] Polling for restaurant '${restaurant.id}' account='${account}' lastId='${lastId}' memoFilter='${memoFilter}'`);

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

    // Query custom_json operations
    const result = await client.query(
      `SELECT id, timestamp AT TIME ZONE 'UTC' as timestamp, required_auths, json, block_num
       FROM hafsql.operation_custom_json_view
       WHERE block_num BETWEEN $1 AND $2
         AND custom_id = 'ssc-mainnet-hive'
         AND id > $3
       ORDER BY block_num DESC
       LIMIT 500`,
      [startBlock, currentBlock, lastId]
    );

    if (result.rows.length === 0) {
      return [];
    }

    const transfers: Transfer[] = [];

    for (const row of result.rows) {
      // Parse JSON
      let jsonData: any;
      try {
        jsonData = typeof row.json === 'string' ? JSON.parse(row.json) : row.json;
      } catch (e) {
        console.error('Error parsing JSON:', e);
        continue;
      }

      // Extract memo
      const memoRaw = jsonData.contractPayload?.memo;
      const memoString = typeof memoRaw === 'string' ? memoRaw : (memoRaw ? JSON.stringify(memoRaw) : '');

      // Filter: only token transfers to our account with matching symbol
      if (
        jsonData.contractName !== 'tokens' ||
        jsonData.contractAction !== 'transfer' ||
        jsonData.contractPayload?.symbol !== symbol ||
        jsonData.contractPayload?.to !== account ||
        !memoString.includes(memoFilter.replace('%', ''))
      ) {
        continue; // Skip this row
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
        console.error('Error parsing required_auths:', e);
      }

      const quantity = jsonData.contractPayload?.quantity || '0';

      transfers.push({
        id: row.id.toString(),
        restaurant_id: restaurant.id,
        from_account: fromAccount,
        amount: quantity,
        symbol: symbol,
        memo: memoString,
        parsed_memo: memoString,
        received_at: new Date(row.timestamp).toISOString(),
        block_num: row.block_num,
      });
    }

    // Update last processed ID
    if (result.rows.length > 0) {
      await setLastId(restaurant.id, symbol, result.rows[0].id.toString());
      console.log(`[${symbol}] Updated lastId to ${result.rows[0].id.toString()} for ${restaurant.id}`);
    }

    console.log(`[${symbol}] Found ${transfers.length} new transfers for restaurant='${restaurant.id}' account='${account}'`);
    return transfers;
  } finally {
    client.release();
  }
}
