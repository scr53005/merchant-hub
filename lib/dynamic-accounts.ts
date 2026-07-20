// Dynamic watchlist — Redis I/O half. Pure logic (diff, validation,
// encode/decode, types) lives in ./dynamic-accounts-core and is re-exported
// here, so callers keep importing from '@/lib/dynamic-accounts' while unit
// tests import the redis-free core. See project_hatchery_vendor_hatching.
//
// Farm (Tier A) vendor accounts registered at RUNTIME, without a config.ts
// edit + redeploy (the long-standing "hardcoded config" TODO, retired
// 2026-07-20). Kept fresh by PUSH (POST /api/vendors, called by the hub at
// hatch) with a reconcile-pull safety net.

import { redis } from './redis';
import { RESTAURANTS } from './config';
import {
  decodeAccountValue,
  encodeAccountValue,
  computeReconcile,
  type DynamicAccountRecord,
  type ResolvedAccount,
} from './dynamic-accounts-core';

export * from './dynamic-accounts-core';

// Hash: field = Hive account, value = "{restaurantId}:{env}"
const DYNAMIC_ACCOUNTS_KEY = 'merchant-hub:dynamic-accounts';

/** Raw hash contents (field→value); {} if empty/unset. */
export async function getDynamicAccountsRaw(): Promise<Record<string, string>> {
  const reply = await redis.hgetall<Record<string, string>>(DYNAMIC_ACCOUNTS_KEY);
  return reply ?? {};
}

/**
 * Resolve dynamic accounts to poller contexts. Skips any whose restaurantId
 * is not in config (defensive: a stale record can't crash the poll). Never
 * throws — a Redis hiccup returns [] so the static Tier C watchlist still
 * polls.
 */
export async function getDynamicAccounts(): Promise<ResolvedAccount[]> {
  let raw: Record<string, string>;
  try {
    raw = await getDynamicAccountsRaw();
  } catch (err) {
    console.error('[DYNAMIC-ACCOUNTS] read failed, using static watchlist only:', err);
    return [];
  }
  const resolved: ResolvedAccount[] = [];
  for (const [account, value] of Object.entries(raw)) {
    const decoded = decodeAccountValue(value);
    if (!decoded) {
      console.warn(`[DYNAMIC-ACCOUNTS] skipping malformed record ${account}=${value}`);
      continue;
    }
    const restaurant = RESTAURANTS.find((r) => r.id === decoded.restaurantId);
    if (!restaurant) {
      console.warn(`[DYNAMIC-ACCOUNTS] skipping ${account}: unknown restaurant ${decoded.restaurantId}`);
      continue;
    }
    resolved.push({ account, restaurant, env: decoded.env });
  }
  return resolved;
}

/** PUSH path: register (or update) one vendor account. Idempotent. */
export async function registerDynamicAccount(rec: DynamicAccountRecord): Promise<void> {
  await redis.hset(DYNAMIC_ACCOUNTS_KEY, {
    [rec.account]: encodeAccountValue(rec.restaurantId, rec.env),
  });
}

/** Remove one vendor account from the watchlist. */
export async function unregisterDynamicAccount(account: string): Promise<void> {
  await redis.hdel(DYNAMIC_ACCOUNTS_KEY, account);
}

/** Reconcile-pull: make the hash exactly match the authoritative desired set. */
export async function reconcileDynamicAccounts(
  desired: DynamicAccountRecord[],
): Promise<{ added: number; removed: number }> {
  const current = await getDynamicAccountsRaw();
  const { toSet, toDelete } = computeReconcile(current, desired);
  if (Object.keys(toSet).length > 0) {
    await redis.hset(DYNAMIC_ACCOUNTS_KEY, toSet);
  }
  if (toDelete.length > 0) {
    await redis.hdel(DYNAMIC_ACCOUNTS_KEY, ...toDelete);
  }
  return { added: Object.keys(toSet).length, removed: toDelete.length };
}
