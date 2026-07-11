// HiveSQL source adapter — @arcange's MS SQL service (vip.hivesql.io),
// Phase 2 of HIVESQL-HA-PLAN.md. Failover target when HAFSQL is down.
//
// Schema + performance facts verified live 2026-07-11 (plan §10, probed via
// scripts/hivesql-health.mjs):
// - block_num lives ONLY on Transactions — Tx tables need the join.
// - `tt.type = 'transfer'` is mandatory: TxTransfers folds savings/escrow ops
//   into the same table; without it Liman's savings sweeps become phantom orders.
// - Cursors are TABLE IDs (TxTransfers.ID / TxCustoms.ID), never block ranges:
//   a block-filtered join on TxCustoms times out (>60s), and block cursors can
//   tie (two same-block transfers split across a poll boundary would lose one).
//   Table IDs are unique + monotonic (identity, insertion-ordered).
// - amount is `money` → JS number; required_auths is a JSON string;
//   timestamps are datetime returned as UTC Dates (tedious useUTC default).

import type { ConnectionPool } from 'mssql';
import { uriToMssqlConfig } from './mssql-config';
import { hivesqlHbdTransferId, hivesqlHeTransferId } from './ids';
import { HbdRow, HiveEngineOpRow, PollingSource, SourceHealth } from './types';

// Lazy singleton: no env read or TCP connect at import time — this module is
// loaded (via the Phase 3 source manager) even when HAFSQL is the active
// source, and must cost nothing until first use.
let poolPromise: Promise<ConnectionPool> | null = null;

async function getPool(): Promise<ConnectionPool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const uri = process.env.HIVESQL_CONNECTION_STRING;
      if (!uri) {
        throw new Error('HIVESQL_CONNECTION_STRING not set');
      }
      const sql = (await import('mssql')).default;
      const pool = new sql.ConnectionPool(uriToMssqlConfig(uri));
      // On connection failure, allow a retry on the next poll instead of
      // caching the rejection forever
      pool.on('error', () => { poolPromise = null; });
      try {
        return await pool.connect();
      } catch (err) {
        poolPromise = null;
        throw err;
      }
    })();
  }
  return poolPromise;
}

/** ISO string from a tedious UTC Date, with the same null-guard as the HAF path. */
function toReceivedAt(timestamp: unknown): string {
  return timestamp instanceof Date && !isNaN(timestamp.getTime())
    ? timestamp.toISOString()
    : new Date().toISOString();
}

export const hivesqlSource: PollingSource = {
  name: 'hivesql',

  async fetchHbdRows(accounts: string[], minCursor: bigint): Promise<HbdRow[]> {
    if (accounts.length === 0) return [];
    const pool = await getPool();

    const request = pool.request();
    // Parameterize the account list as @a0..@aN (mssql has no array params)
    const placeholders = accounts.map((account, i) => {
      request.input(`a${i}`, account);
      return `@a${i}`;
    });
    request.input('minId', minCursor.toString());

    // minCursor = TxTransfers.ID. A '0' cursor simply returns the newest 100
    // rows — same policy as the HAFSQL adapter.
    const result = await request.query(
      `SELECT TOP 100 tt.ID, t.block_num, tt.[from], tt.[to], tt.amount, tt.memo, tt.timestamp
       FROM TxTransfers tt
       JOIN Transactions t ON t.tx_id = tt.tx_id
       WHERE tt.[to] IN (${placeholders.join(',')})
         AND tt.amount_symbol = 'HBD'
         AND tt.type = 'transfer'
         AND tt.ID > @minId
       ORDER BY tt.ID DESC`
    );

    return result.recordset.map((row: any) => ({
      cursor: String(row.ID),
      transferId: hivesqlHbdTransferId(row.ID),
      from_account: row.from,
      to_account: row.to,
      // money → number; render with HBD's native 3 decimals to match the
      // string the HAFSQL path publishes ("4.014")
      amount: Number(row.amount).toFixed(3),
      memo: row.memo ?? '',
      received_at: toReceivedAt(row.timestamp),
      block_num: Number(row.block_num),
    }));
  },

  async fetchHiveEngineOps(minCursor: bigint): Promise<HiveEngineOpRow[]> {
    const pool = await getPool();
    const request = pool.request();
    request.input('minId', minCursor.toString());

    // minCursor = TxCustoms.ID. tid + ORDER BY ID DESC is ~30ms; a '0'
    // cursor returns the newest 1000 ops (own catch-up bound, like HAFSQL's
    // 10k-block window).
    const result = await request.query(
      `SELECT TOP 1000 tc.ID, t.block_num, tc.required_auths, tc.json, tc.timestamp
       FROM TxCustoms tc
       JOIN Transactions t ON t.tx_id = tc.tx_id
       WHERE tc.tid = 'ssc-mainnet-hive'
         AND tc.ID > @minId
       ORDER BY tc.ID DESC`
    );

    return result.recordset.map((row: any) => ({
      cursor: String(row.ID),
      transferId: hivesqlHeTransferId(String(row.ID)),
      json: row.json,                     // string — orchestrator JSON.parses
      required_auths: row.required_auths, // JSON string — orchestrator JSON.parses
      received_at: toReceivedAt(row.timestamp),
      block_num: Number(row.block_num),
    }));
  },

  async healthCheck(): Promise<SourceHealth> {
    const start = Date.now();
    try {
      const pool = await getPool();
      // Single statement: head block + the block of the newest indexed
      // transfer (point lookup via ID index + join, ~30ms verified)
      const result = await pool.request().query(
        `SELECT (SELECT MAX(block_num) FROM Blocks) AS head_block,
                (SELECT TOP 1 t.block_num
                 FROM TxTransfers tt JOIN Transactions t ON t.tx_id = tt.tx_id
                 ORDER BY tt.ID DESC) AS max_transfer_block`
      );
      const row = result.recordset[0];
      const head = row?.head_block != null ? BigInt(row.head_block) : null;
      const maxBlock = row?.max_transfer_block != null ? BigInt(row.max_transfer_block) : null;
      return {
        reachable: true,
        latencyMs: Date.now() - start,
        headBlock: head !== null ? head.toString() : null,
        hbdLagBlocks: head !== null && maxBlock !== null ? (head - maxBlock).toString() : null,
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

/**
 * Failover cursor seeding: find the largest table ID whose block_num is
 * <= the given block, by binary search over the ID space with point-lookup
 * probes (each ~30ms). Runs once per failover (Phase 3), never per poll.
 *
 * Exported for the source manager and the E2E script.
 */
export async function seedCursorFromBlock(
  table: 'TxTransfers' | 'TxCustoms',
  targetBlock: bigint
): Promise<bigint> {
  const pool = await getPool();

  // Upper bound: current max ID
  const maxRes = await pool.request().query(`SELECT MAX(ID) AS max_id FROM ${table}`);
  const maxId = maxRes.recordset[0]?.max_id;
  if (maxId == null) return BigInt(0);

  let lo = BigInt(0);
  let hi = BigInt(String(maxId));

  // Invariant: block(lo) <= targetBlock < block(hi+1); probe the first row at
  // or after mid (IDs can have gaps)
  while (lo < hi) {
    const mid = (lo + hi + BigInt(1)) / BigInt(2);
    const req = pool.request();
    req.input('mid', mid.toString());
    const probe = await req.query(
      `SELECT TOP 1 x.ID, t.block_num
       FROM ${table} x JOIN Transactions t ON t.tx_id = x.tx_id
       WHERE x.ID >= @mid
       ORDER BY x.ID ASC`
    );
    const row = probe.recordset[0];
    if (!row) {
      // No rows at or above mid — everything above is a gap
      hi = mid - BigInt(1);
      continue;
    }
    if (BigInt(row.block_num) <= targetBlock) {
      // Progress guaranteed: row.ID >= mid > previous lo
      lo = BigInt(String(row.ID));
    } else {
      hi = mid - BigInt(1);
    }
  }
  return lo;
}
