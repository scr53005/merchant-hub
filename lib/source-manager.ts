// Source manager — the side-effecting half of the failover state machine
// (HIVESQL-HA-PLAN.md §7). Decisions are pure functions in
// source-decision.ts; this module performs the transitions (cursor seeding,
// state writes) and the per-poll bookkeeping.

import { getAllAccounts } from './config';
import { updatePollingState, getLastIdFromState } from './redis';
import { blockToOperationId } from './polling-state';
import { PollingSource } from './sources/types';
import { hafsqlSource } from './sources/hafsql';
import { hivesqlSource, seedCursorFromBlock } from './sources/hivesql';
import {
  SourceName,
  StateLike,
  resolveSourceName,
  updateErrorStreak,
  shouldFailover,
  shouldProbeFailback,
  isProbeHealthy,
  computeSeedBlock,
  SEAM_OVERLAP_BLOCKS,
  FAILBACK_HEALTHY_PROBES,
} from './source-decision';

const HE_TOKENS = ['EURO', 'OCLT', 'LEI', 'RUBIS'] as const;

export function getSourceByName(name: SourceName): PollingSource {
  return name === 'hivesql' ? hivesqlSource : hafsqlSource;
}

/** Cursor-state key scope: HiveSQL cursors live under hivesql:{account}:{currency}. */
export function cursorAccount(sourceName: SourceName, account: string): string {
  return sourceName === 'hivesql' ? `hivesql:${account}` : account;
}

function minCursorBlock(state: StateLike, accounts: string[], currencies: readonly string[]): bigint | null {
  let min: bigint | null = null;
  for (const account of accounts) {
    for (const currency of currencies) {
      const cursor = BigInt(getLastIdFromState(state, account, currency));
      if (cursor <= BigInt(0)) continue; // no cursor yet — doesn't anchor the window
      const block = cursor >> BigInt(32);
      if (min === null || block < min) min = block;
    }
  }
  return min;
}

/**
 * Switch to HiveSQL: seed its cursors (one binary search per table, shared by
 * all accounts — each account's cursor then advances independently), then
 * flip activeSource. Throws if HiveSQL is unreachable — the caller stays on
 * HAFSQL and retries next poll.
 */
export async function performFailover(state: StateLike, reason: string): Promise<void> {
  console.warn(`[SOURCE] FAILOVER to HiveSQL: ${reason}`);

  const health = await hivesqlSource.healthCheck();
  if (!health.reachable || health.headBlock === null) {
    throw new Error(`HiveSQL unreachable, staying on HAFSQL: ${health.error ?? 'no head block'}`);
  }
  const head = BigInt(health.headBlock);

  const accounts = getAllAccounts().map((c) => c.account);

  // HAF cursors encode blocks in the high 32 bits — that's the position to
  // resume from on the HiveSQL side
  const hbdSeedBlock = computeSeedBlock(head, minCursorBlock(state, accounts, ['HBD']));
  const heSeedBlock = computeSeedBlock(head, minCursorBlock(state, accounts, HE_TOKENS));

  const txSeed = (await seedCursorFromBlock('TxTransfers', hbdSeedBlock)).toString();
  const tcSeed = (await seedCursorFromBlock('TxCustoms', heSeedBlock)).toString();

  const updates: Record<string, string> = {
    activeSource: 'hivesql',
    lastFailoverAt: new Date().toISOString(),
    hafsqlErrorStreakSince: '',
    hafsqlRecoveryProbes: '0',
    hafsqlLastProbeAt: new Date().toISOString(),
  };
  for (const account of accounts) {
    updates[`hivesql:${account}:HBD`] = txSeed;
    for (const token of HE_TOKENS) {
      updates[`hivesql:${account}:${token}`] = tcSeed;
    }
  }
  await updatePollingState(updates);
  console.warn(`[SOURCE] Failover complete — HiveSQL cursors seeded (TxTransfers>${txSeed} from block ${hbdSeedBlock}, TxCustoms>${tcSeed} from block ${heSeedBlock})`);
}

/**
 * Switch back to HAFSQL: jump every HAF cursor to just behind the current
 * head (everything older was already delivered via HiveSQL; the seam overlap
 * is re-fetched and absorbed by the publish dedupe), then flip activeSource.
 */
export async function performFailback(hafsqlHeadBlock: bigint): Promise<void> {
  const newCursor = blockToOperationId(hafsqlHeadBlock - SEAM_OVERLAP_BLOCKS).toString();
  const accounts = getAllAccounts().map((c) => c.account);

  const updates: Record<string, string> = {
    activeSource: 'hafsql',
    lastFailbackAt: new Date().toISOString(),
    hafsqlRecoveryProbes: '0',
    hafsqlErrorStreakSince: '',
  };
  for (const account of accounts) {
    for (const currency of ['HBD', ...HE_TOKENS]) {
      updates[`${account}:${currency}`] = newCursor;
    }
  }
  await updatePollingState(updates);
  console.warn(`[SOURCE] FAILBACK to HAFSQL — cursors jumped to ${newCursor} (head ${hafsqlHeadBlock} - ${SEAM_OVERLAP_BLOCKS} overlap)`);
}

/**
 * Per-poll bookkeeping + auto transitions. Called at the end of
 * pollAllTransfers with the effective state (start-of-poll state merged with
 * this poll's pending updates). Returns state updates for the caller to
 * batch into its final HMSET; transitions write their own state internally
 * (rare events, one extra HMSET each).
 *
 * Never throws — the state machine must not break a working poll.
 */
export async function runSourceStateMachine(
  effectiveState: StateLike,
  hadErrors: boolean
): Promise<Record<string, string>> {
  try {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const active = resolveSourceName(effectiveState);

    if (active === 'hafsql') {
      const updates = updateErrorStreak(effectiveState, hadErrors, nowIso);
      const merged = { ...effectiveState, ...updates };
      const reason = shouldFailover(merged, now);
      if (reason) {
        await performFailover(merged, reason); // writes its own state (incl. streak clear)
        return {};
      }
      return updates;
    }

    // Active source is HiveSQL — probe HAFSQL for recovery
    if (shouldProbeFailback(effectiveState, now)) {
      const health = await hafsqlSource.healthCheck();
      const healthy = isProbeHealthy(health);
      const probes = healthy ? Number(effectiveState.hafsqlRecoveryProbes || '0') + 1 : 0;
      console.warn(`[SOURCE] HAFSQL recovery probe: ${healthy ? 'healthy' : `unhealthy (${health.error ?? `lag ${health.hbdLagBlocks}`})`} — ${probes}/${FAILBACK_HEALTHY_PROBES}`);
      if (healthy && probes >= FAILBACK_HEALTHY_PROBES && health.headBlock !== null) {
        await performFailback(BigInt(health.headBlock)); // writes its own state
        return {};
      }
      return { hafsqlLastProbeAt: nowIso, hafsqlRecoveryProbes: String(probes) };
    }
    return {};
  } catch (error: any) {
    console.error('[SOURCE] State machine error (poll unaffected):', error.message);
    return {};
  }
}
