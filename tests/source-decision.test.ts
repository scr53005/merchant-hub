// Phase 3 tests (HIVESQL-HA-PLAN.md §7): the failover/failback state machine
// decisions. Pure functions over the polling:state hash — the side effects
// (cursor seeding, Redis writes) live in source-manager.ts and are exercised
// in the Phase 4 DEV E2E, not mocked here.

import { describe, it, expect } from 'vitest';
import {
  resolveSourceName,
  isForced,
  updateErrorStreak,
  shouldFailover,
  shouldProbeFailback,
  isProbeHealthy,
  computeSeedBlock,
  FAILOVER_ERROR_STREAK_MS,
  FAILBACK_PROBE_INTERVAL_MS,
  SEAM_OVERLAP_BLOCKS,
  FAILOVER_CATCHUP_BLOCKS,
} from '../lib/source-decision';

const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('resolveSourceName', () => {
  it('defaults to hafsql on empty state', () => {
    expect(resolveSourceName({})).toBe('hafsql');
  });

  it('follows activeSource', () => {
    expect(resolveSourceName({ activeSource: 'hivesql' })).toBe('hivesql');
    expect(resolveSourceName({ activeSource: 'hafsql' })).toBe('hafsql');
  });

  it('forced overrides activeSource', () => {
    expect(resolveSourceName({ activeSource: 'hivesql', forcedSource: 'hafsql' })).toBe('hafsql');
    expect(resolveSourceName({ activeSource: 'hafsql', forcedSource: 'hivesql' })).toBe('hivesql');
  });

  it("a cleared override ('' — how HMSET deletes) means auto", () => {
    expect(resolveSourceName({ activeSource: 'hivesql', forcedSource: '' })).toBe('hivesql');
    expect(isForced({ forcedSource: '' })).toBe(false);
  });
});

describe('updateErrorStreak', () => {
  it('opens a streak on the first error only', () => {
    expect(updateErrorStreak({}, true, iso(0))).toEqual({ hafsqlErrorStreakSince: iso(0) });
    // Already open — the ORIGINAL start time must be preserved (no update)
    expect(updateErrorStreak({ hafsqlErrorStreakSince: iso(60_000) }, true, iso(0))).toEqual({});
  });

  it('clears the streak on a clean poll, and only writes when there is one to clear', () => {
    expect(updateErrorStreak({ hafsqlErrorStreakSince: iso(60_000) }, false, iso(0)))
      .toEqual({ hafsqlErrorStreakSince: '' });
    expect(updateErrorStreak({}, false, iso(0))).toEqual({});
    expect(updateErrorStreak({ hafsqlErrorStreakSince: '' }, false, iso(0))).toEqual({});
  });
});

describe('shouldFailover', () => {
  it('fires after a >10min unbroken error streak', () => {
    expect(shouldFailover({ hafsqlErrorStreakSince: iso(FAILOVER_ERROR_STREAK_MS + 1000) }, NOW)).toBeTruthy();
    expect(shouldFailover({ hafsqlErrorStreakSince: iso(FAILOVER_ERROR_STREAK_MS - 1000) }, NOW)).toBeNull();
  });

  it('fires on a frozen indexer (lag > 1200 blocks) even with zero errors', () => {
    // The 2026-07-11 incident value: 22875 blocks, every query succeeding
    expect(shouldFailover({ hbdSourceLagBlocks: '22875' }, NOW)).toBeTruthy();
    expect(shouldFailover({ hbdSourceLagBlocks: '1200' }, NOW)).toBeNull();
    expect(shouldFailover({ hbdSourceLagBlocks: '47' }, NOW)).toBeNull();
  });

  it('never fires when forced or already on hivesql', () => {
    const badState = { hafsqlErrorStreakSince: iso(FAILOVER_ERROR_STREAK_MS * 2), hbdSourceLagBlocks: '99999' };
    expect(shouldFailover({ ...badState, forcedSource: 'hafsql' }, NOW)).toBeNull();
    expect(shouldFailover({ ...badState, activeSource: 'hivesql' }, NOW)).toBeNull();
  });

  it('ignores garbage lag values', () => {
    expect(shouldFailover({ hbdSourceLagBlocks: 'NaN' }, NOW)).toBeNull();
    expect(shouldFailover({ hbdSourceLagBlocks: '' }, NOW)).toBeNull();
  });
});

describe('shouldProbeFailback', () => {
  const onHivesql = { activeSource: 'hivesql' };

  it('probes when due, respecting the 5-min interval', () => {
    expect(shouldProbeFailback({ ...onHivesql }, NOW)).toBe(true); // never probed
    expect(shouldProbeFailback({ ...onHivesql, hafsqlLastProbeAt: iso(FAILBACK_PROBE_INTERVAL_MS + 1000) }, NOW)).toBe(true);
    expect(shouldProbeFailback({ ...onHivesql, hafsqlLastProbeAt: iso(60_000) }, NOW)).toBe(false);
  });

  it('never probes on hafsql or when forced', () => {
    expect(shouldProbeFailback({}, NOW)).toBe(false);
    expect(shouldProbeFailback({ ...onHivesql, forcedSource: 'hivesql' }, NOW)).toBe(false);
  });
});

describe('isProbeHealthy', () => {
  it('requires reachable AND a current indexer', () => {
    expect(isProbeHealthy({ reachable: true, hbdLagBlocks: '2' })).toBe(true);
    expect(isProbeHealthy({ reachable: true, hbdLagBlocks: '100' })).toBe(true);
    // The 2026-07-11 trap: reachable, fast, and 19h stale
    expect(isProbeHealthy({ reachable: true, hbdLagBlocks: '22875' })).toBe(false);
    expect(isProbeHealthy({ reachable: false, hbdLagBlocks: null })).toBe(false);
    expect(isProbeHealthy({ reachable: true, hbdLagBlocks: null })).toBe(false);
  });
});

describe('computeSeedBlock', () => {
  const HEAD = BigInt(108042909); // live head, 2026-07-11

  it('uses the cursor block minus the seam overlap when recent', () => {
    const cursorBlock = HEAD - BigInt(100);
    expect(computeSeedBlock(HEAD, cursorBlock)).toBe(cursorBlock - SEAM_OVERLAP_BLOCKS);
  });

  it('floors at the catch-up window for ancient or missing cursors', () => {
    const floor = HEAD - FAILOVER_CATCHUP_BLOCKS;
    expect(computeSeedBlock(HEAD, null)).toBe(floor);
    // A quiet account's weeks-old cursor must NOT drag the window back —
    // republishing past the 48h dedupe TTL creates phantom orders
    expect(computeSeedBlock(HEAD, HEAD - BigInt(600000))).toBe(floor);
  });
});
