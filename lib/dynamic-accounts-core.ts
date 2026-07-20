// Dynamic watchlist — PURE core (no Redis import, so unit-testable without
// live credentials). The Redis I/O half is lib/dynamic-accounts.ts, which
// re-exports everything here. See project_hatchery_vendor_hatching.
//
// A dynamic (Farm) account references an EXISTING RestaurantConfig by id
// (the `innohatch` umbrella spoke), inheriting its currencies + memoFilters
// — merchant-hub stays dumb about tiers; it only learns "watch one more
// account".

import { RESTAURANTS } from './config';
import { RestaurantConfig } from '@/types';

export interface DynamicAccountRecord {
  account: string;
  restaurantId: string;
  env: 'prod' | 'dev';
}

export interface ResolvedAccount {
  account: string;
  restaurant: RestaurantConfig;
  env: 'prod' | 'dev';
}

/** Encode/decode the hash value "{restaurantId}:{env}". */
export function encodeAccountValue(restaurantId: string, env: 'prod' | 'dev'): string {
  return `${restaurantId}:${env}`;
}

export function decodeAccountValue(value: string): { restaurantId: string; env: 'prod' | 'dev' } | null {
  const idx = value.lastIndexOf(':');
  if (idx < 0) return null;
  const restaurantId = value.slice(0, idx);
  const env = value.slice(idx + 1);
  if (!restaurantId || (env !== 'prod' && env !== 'dev')) return null;
  return { restaurantId, env };
}

/**
 * Pure reconcile diff: given the CURRENT dynamic hash (field→value) and the
 * DESIRED account records (authoritative), return the HSET additions/updates
 * and HDEL removals to make current match desired. The endpoint applies it.
 */
export function computeReconcile(
  current: Record<string, string>,
  desired: DynamicAccountRecord[],
): { toSet: Record<string, string>; toDelete: string[] } {
  const desiredMap = new Map<string, string>();
  for (const d of desired) {
    desiredMap.set(d.account, encodeAccountValue(d.restaurantId, d.env));
  }
  const toSet: Record<string, string> = {};
  for (const [account, value] of desiredMap) {
    if (current[account] !== value) toSet[account] = value;
  }
  const toDelete: string[] = [];
  for (const account of Object.keys(current)) {
    if (!desiredMap.has(account)) toDelete.push(account);
  }
  return { toSet, toDelete };
}

/** Validate a registration request against known config; returns error or null. */
export function validateRegistration(
  account: unknown,
  restaurantId: unknown,
  env: unknown,
): { account: string; restaurantId: string; env: 'prod' | 'dev' } | { error: string } {
  if (typeof account !== 'string' || !/^[a-z0-9.-]{3,16}$/.test(account)) {
    return { error: 'account must be a valid Hive account name' };
  }
  if (typeof restaurantId !== 'string' || !RESTAURANTS.some((r) => r.id === restaurantId)) {
    return { error: `unknown restaurantId (must be one of: ${RESTAURANTS.map((r) => r.id).join(', ')})` };
  }
  if (env !== 'prod' && env !== 'dev') {
    return { error: "env must be 'prod' or 'dev'" };
  }
  return { account, restaurantId, env };
}
