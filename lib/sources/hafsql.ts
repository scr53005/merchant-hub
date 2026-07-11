// HAFSQL source adapter — @mahdiyari's public Postgres (HAF).
// Extracted verbatim from haf-polling.ts in the Phase 1 refactor
// (HIVESQL-HA-PLAN.md): the queries, connection handling, and row
// normalization are unchanged; only their location moved.

import { Pool } from 'pg';
import { computeCatchupLowerBound, computeSyncLagBlocks } from '../polling-state';
import { HbdRow, HiveEngineOpRow, PollingSource, SourceHealth } from './types';

const hafPool = new Pool({
  connectionString: process.env.HAF_CONNECTION_STRING,
  // 60s: rides out provider degradation like 2026-07 (~40-50s/statement
  // PgBouncer queuing). Must stay well under the routes' maxDuration.
  query_timeout: 60000,
});

export const hafsqlSource: PollingSource = {
  name: 'hafsql',

  async fetchHbdRows(accounts: string[], minCursor: bigint): Promise<HbdRow[]> {
    const accountsArrayLiteral = `ARRAY['${accounts.join("','")}']`;
    const sqlStatement = `SELECT id, to_account, from_account, amount, symbol, memo FROM hafsql.operation_transfer_table WHERE to_account = ANY(${accountsArrayLiteral}) AND symbol = 'HBD' AND id > ${minCursor.toString()} ORDER BY id DESC LIMIT 100`;
    console.warn(`[HBD BATCHED] EXACT SQL: ${sqlStatement}`);

    const result = await hafPool.query(
      `SELECT id, to_account, from_account, amount, symbol, memo
       FROM hafsql.operation_transfer_table
       WHERE to_account = ANY($1)
         AND symbol = 'HBD'
         AND id > $2
       ORDER BY id DESC
       LIMIT 100`,
      [accounts, minCursor.toString()]
    );

    return result.rows.map((row) => ({
      cursor: row.id.toString(),
      transferId: row.id.toString(),
      from_account: row.from_account,
      to_account: row.to_account,
      amount: row.amount.toString(),
      memo: row.memo,
      received_at: new Date().toISOString(),
      // id >> 32 = block_num (verified against hive.operations_view) — the
      // publish dedupe key needs it and it's free here
      block_num: Number(BigInt(row.id) >> BigInt(32)),
    }));
  },

  async fetchHiveEngineOps(minCursor: bigint): Promise<HiveEngineOpRow[]> {
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
      // Catch-up window: min cursor, capped at ~10k blocks back (≈8 hours)
      const lowerBound = computeCatchupLowerBound(headBlock, minCursor);

      // Query custom_json operations via the standard HAF hive.operations_view
      // — grants-proof and portable, unlike the revoked
      // hafsql.operation_custom_json_view. op_type_id 18 =
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

      return result.rows.map((row) => ({
        cursor: row.id.toString(),
        transferId: row.id.toString(),
        json: row.json,
        required_auths: row.required_auths,
        // timestamp can be null if the block joined from blocks_view is not
        // visible yet — fall back to "now" rather than new Date(null) = 1970
        received_at: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
        block_num: row.block_num,
      }));
    } finally {
      client.release();
    }
  },

  async healthCheck(): Promise<SourceHealth> {
    const start = Date.now();
    try {
      // Single statement for both values so they come from the same snapshot
      const result = await hafPool.query(
        `SELECT (SELECT num FROM hafd.blocks ORDER BY num DESC LIMIT 1) AS head_block,
                (SELECT id FROM hafsql.operation_transfer_table ORDER BY id DESC LIMIT 1) AS max_transfer_id`
      );
      const row = result.rows[0];
      const head = row?.head_block != null ? BigInt(row.head_block) : null;
      const maxTransferId = row?.max_transfer_id != null ? BigInt(row.max_transfer_id) : null;
      return {
        reachable: true,
        latencyMs: Date.now() - start,
        headBlock: head !== null ? head.toString() : null,
        hbdLagBlocks: head !== null && maxTransferId !== null
          ? computeSyncLagBlocks(head, maxTransferId).toString()
          : null,
      };
    } catch (error: any) {
      return {
        reachable: false,
        latencyMs: Date.now() - start,
        headBlock: null,
        hbdLagBlocks: null,
        error: error.message,
      };
    }
  },
};
