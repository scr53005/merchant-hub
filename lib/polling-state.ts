// Pure helpers for polling-state cursor handling.
// No Redis client in this module so tests can import it without env vars.
//
// HAF operation ids are 64-bit integers (currently ~4.6e17), far beyond
// Number.MAX_SAFE_INTEGER (2^53 - 1 ≈ 9.0e15). They must circulate as strings
// end-to-end and only ever be compared as BigInt: a single pass through a JS
// number rounds the id to the nearest representable double (spacing ~64 at
// current magnitudes) and silently corrupts the cursor.

// Plausibility ceiling for cursors: ~20x above current HAF ids but still below
// 2^63 - 1, so corrupted values get caught while legitimate growth never trips it.
const CURSOR_CEILING = BigInt('10000000000000000000'); // 10^19

/**
 * Normalize an HGETALL reply into a Record<string, string> with verbatim
 * string values. The Upstash REST API returns a flat [field, value, ...]
 * array; some Upstash surfaces return an object instead — handle both.
 */
export function parseHgetallReply(reply: unknown): Record<string, string> {
  const state: Record<string, string> = {};
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) {
      state[String(reply[i])] = String(reply[i + 1]);
    }
  } else if (reply && typeof reply === 'object') {
    for (const [key, value] of Object.entries(reply)) {
      if (value !== null && value !== undefined) {
        state[key] = String(value);
      }
    }
  }
  return state;
}

/**
 * Coerce and validate a cursor value read from Redis.
 * Returns a canonical decimal-string cursor, or '0' when the value is missing
 * or garbage. '0' is the safe fallback direction: it can only cause re-fetches
 * of already-processed transfers, which CO pages dedupe by transfer id.
 */
export function sanitizeCursor(value: unknown): string {
  if (value === null || value === undefined) return '0';
  const str = String(value);
  if (!/^\d+$/.test(str)) {
    console.warn(`[CURSOR] Invalid cursor value ${JSON.stringify(str)} — falling back to '0'`);
    return '0';
  }
  const asBigInt = BigInt(str);
  if (asBigInt > CURSOR_CEILING) {
    console.warn(`[CURSOR] Implausibly large cursor ${str} (> 10^19) — falling back to '0'`);
    return '0';
  }
  // Canonical form (strips leading zeros)
  return asBigInt.toString();
}

/**
 * True minimum of a set of cursors.
 * Never seed the scan with a numeric "+infinity": real HAF ids exceed
 * Number.MAX_SAFE_INTEGER, so any fixed numeric seed eventually loses every
 * comparison and leaks into the SQL as a bogus lower bound (the 2026-07
 * `id > 9007199254740991` bug). Empty input returns 0, meaning "no lower
 * bound" — the query fetches newest rows and per-account filters take over.
 */
export function computeMinCursor(cursors: bigint[]): bigint {
  let min: bigint | null = null;
  for (const cursor of cursors) {
    if (min === null || cursor < min) {
      min = cursor;
    }
  }
  return min === null ? BigInt(0) : min;
}

/**
 * HAF operation ids encode the block number in the high 32 bits
 * (verified against hive.operations_view: id >> 32 === block_num).
 * This converts a block number to the smallest possible operation id
 * of that block, usable as an id-range bound that hits the primary key
 * index — filtering on the view's block_num column does not.
 */
export function blockToOperationId(blockNum: bigint | number): bigint {
  return BigInt(blockNum) << BigInt(32);
}

/**
 * How far the HBD source table's newest row lags behind the raw HAF head
 * block. hafsql.operation_transfer_table is filled by a separate indexer
 * process that can freeze while queries keep succeeding with zero new rows
 * (2026-07-10 backup server: ~19h behind, zero errors reported). The lag is
 * the only observable symptom. Hive has transfers in nearly every block, so
 * a healthy lag is 0-2 blocks.
 */
export function computeSyncLagBlocks(headBlock: bigint, maxOperationId: bigint): bigint {
  return headBlock - (maxOperationId >> BigInt(32));
}

/**
 * Lower bound for the Hive-Engine catch-up query: the min cursor, but never
 * further back than `windowBlocks` behind the head block. Bounds the scan
 * when cursors are missing ('0') without ever excluding ids a real cursor
 * has already passed.
 */
export function computeCatchupLowerBound(
  headBlock: bigint,
  minCursor: bigint,
  windowBlocks: number = 10000
): bigint {
  const windowStart = blockToOperationId(headBlock - BigInt(windowBlocks));
  return minCursor > windowStart ? minCursor : windowStart;
}
