// Pure failover/failback decision logic (HIVESQL-HA-PLAN.md §7).
// No imports, no Redis, no SQL — everything here operates on the
// polling:state hash contents so tests cover the state machine without env
// vars. Side effects (seeding, state writes) live in source-manager.ts.

export type SourceName = 'hafsql' | 'hivesql';

// Deliberately slow triggers: a failover costs a seam; a 5-minute blip
// shouldn't buy one.
export const FAILOVER_ERROR_STREAK_MS = 10 * 60_000;
export const FAILOVER_LAG_BLOCKS = BigInt(1200);      // ~1h behind = frozen indexer
// Failback hysteresis: 3 consecutive healthy probes, 5 min apart.
export const FAILBACK_PROBE_INTERVAL_MS = 5 * 60_000;
export const FAILBACK_HEALTHY_PROBES = 3;
export const HEALTHY_LAG_BLOCKS = BigInt(100);
// Seam overlap re-fetched on every transition — dedupe absorbs it.
export const SEAM_OVERLAP_BLOCKS = BigInt(20);
// Never seed further back than this (~8h): re-fetches inside the window are
// covered by the 48h dedupe TTL; deeper re-fetches (a quiet account's ancient
// cursor) would republish orders whose dedupe keys have expired.
export const FAILOVER_CATCHUP_BLOCKS = BigInt(10000);

// Loose structural view of the polling:state hash — PollingState (and any
// spread/merge of it) is assignable to this, unlike the reverse.
export type StateLike = Record<string, string | undefined>;

export function isForced(state: StateLike): boolean {
  return state.forcedSource === 'hafsql' || state.forcedSource === 'hivesql';
}

/** Which source this poll should use: forced wins, else last transition, else hafsql. */
export function resolveSourceName(state: StateLike): SourceName {
  if (state.forcedSource === 'hafsql' || state.forcedSource === 'hivesql') {
    return state.forcedSource;
  }
  return state.activeSource === 'hivesql' ? 'hivesql' : 'hafsql';
}

/**
 * Error-streak bookkeeping for the active HAFSQL source. Returns the state
 * updates to write ({} when nothing changed, so callers can skip the write).
 * The streak records the FIRST error's time; any clean poll clears it.
 */
export function updateErrorStreak(state: StateLike, hadErrors: boolean, nowIso: string): Record<string, string> {
  const streakSet = !!state.hafsqlErrorStreakSince && !isNaN(Date.parse(state.hafsqlErrorStreakSince));
  if (hadErrors) {
    return streakSet ? {} : { hafsqlErrorStreakSince: nowIso };
  }
  return streakSet ? { hafsqlErrorStreakSince: '' } : {};
}

/**
 * Failover decision (auto mode, HAFSQL active). Returns a human-readable
 * reason, or null to stay.
 */
export function shouldFailover(state: StateLike, nowMs: number): string | null {
  if (isForced(state)) return null;
  if (resolveSourceName(state) !== 'hafsql') return null;

  const since = state.hafsqlErrorStreakSince ? Date.parse(state.hafsqlErrorStreakSince) : NaN;
  if (!isNaN(since) && nowMs - since > FAILOVER_ERROR_STREAK_MS) {
    return `HAFSQL error streak since ${state.hafsqlErrorStreakSince}`;
  }

  // Frozen-indexer mode: queries green, data dead — invisible to the streak
  const lagStr = state.hbdSourceLagBlocks;
  if (lagStr && /^\d+$/.test(lagStr) && BigInt(lagStr) > FAILOVER_LAG_BLOCKS) {
    return `HBD source lag ${lagStr} blocks (indexer frozen)`;
  }

  return null;
}

/** Whether a failback probe of HAFSQL is due (auto mode, HiveSQL active). */
export function shouldProbeFailback(state: StateLike, nowMs: number): boolean {
  if (isForced(state)) return false;
  if (resolveSourceName(state) !== 'hivesql') return false;
  const last = state.hafsqlLastProbeAt ? Date.parse(state.hafsqlLastProbeAt) : NaN;
  return isNaN(last) || nowMs - last > FAILBACK_PROBE_INTERVAL_MS;
}

/** A probe counts as healthy only when reachable AND the indexer is current. */
export function isProbeHealthy(health: { reachable: boolean; hbdLagBlocks: string | null }): boolean {
  return health.reachable
    && health.hbdLagBlocks !== null
    && /^\d+$/.test(health.hbdLagBlocks)
    && BigInt(health.hbdLagBlocks) <= HEALTHY_LAG_BLOCKS;
}

/**
 * Block to seed the failover target's cursors from: the oldest account
 * cursor's block minus the seam overlap, but never further back than the
 * catch-up window below head.
 */
export function computeSeedBlock(headBlock: bigint, minCursorBlock: bigint | null): bigint {
  const floor = headBlock - FAILOVER_CATCHUP_BLOCKS;
  if (minCursorBlock === null) return floor;
  const candidate = minCursorBlock - SEAM_OVERLAP_BLOCKS;
  return candidate > floor ? candidate : floor;
}
