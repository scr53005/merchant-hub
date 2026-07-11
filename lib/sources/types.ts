// Source adapter interface for transfer polling (HIVESQL-HA-PLAN.md §3).
//
// A PollingSource wraps ONE upstream chain-data provider (HAFSQL Postgres;
// HiveSQL MS SQL in Phase 2). Adapters only run queries and normalize rows.
// Everything else — cursor bookkeeping, memo filtering, Transfer mapping,
// publish ordering, Redis state writes — lives in the orchestrator
// (haf-polling.ts) and is source-independent.
//
// Cursor vs transferId: under HAFSQL both are the HAF operation id, but they
// are DIFFERENT concepts. `cursor` is the per-source monotonic position used
// for "give me rows after X" (HiveSQL: block_num for HBD, TxCustoms.ID for
// HE). `transferId` is what gets published as Transfer.id — it must be a
// unique DECIMAL NUMERIC string that fits int8, because every spoke does
// BigInt(transfer.id) into a bigint PK (Phase 0 finding; HiveSQL uses the
// offset bands of plan §5).

export interface HbdRow {
  /** Per-source monotonic position of this row. Decimal string. */
  cursor: string;
  /** Published as Transfer.id — unique, decimal numeric, int8-safe. */
  transferId: string;
  from_account: string;
  to_account: string;
  /** Canonical decimal string (HAF returns strings; HiveSQL `money` must be formatted). */
  amount: string;
  memo: string;
  received_at: string; // ISO
  block_num?: number;
}

export interface HiveEngineOpRow {
  cursor: string;
  transferId: string;
  /** Raw custom_json payload — string or already-parsed; orchestrator handles both. */
  json: unknown;
  /** required_auths as delivered by the source — string or array; orchestrator handles both. */
  required_auths: unknown;
  received_at: string; // ISO
  block_num?: number;
}

export interface SourceHealth {
  reachable: boolean;
  latencyMs: number;
  headBlock: string | null;
  /** Blocks the source's HBD transfer data lags behind its own head (frozen-indexer detector). */
  hbdLagBlocks: string | null;
  error?: string;
}

export interface PollingSource {
  readonly name: 'hafsql' | 'hivesql';
  /**
   * HBD transfers to the given accounts with cursor > minCursor,
   * newest first, source-limited (100 on HAFSQL).
   */
  fetchHbdRows(accounts: string[], minCursor: bigint): Promise<HbdRow[]>;
  /**
   * ssc-mainnet-hive custom_json ops with cursor > minCursor, newest first,
   * source-limited. The adapter applies its own catch-up lower bound
   * (HAFSQL: ~10k blocks behind head) — a '0' cursor must not trigger a
   * full-history scan.
   */
  fetchHiveEngineOps(minCursor: bigint): Promise<HiveEngineOpRow[]>;
  /** Never throws — failure is reported in the returned object. */
  healthCheck(): Promise<SourceHealth>;
}
