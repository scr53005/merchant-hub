// Upstash Redis client for merchant-hub

import { Redis } from '@upstash/redis';

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  throw new Error('Missing Upstash Redis environment variables: KV_REST_API_URL and KV_REST_API_TOKEN');
}

export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Helper functions for common Redis operations

export async function getHeartbeat(): Promise<number | null> {
  const heartbeat = await redis.get<number>('polling:heartbeat');
  return heartbeat;
}

export async function setHeartbeat(timestamp: number = Date.now()): Promise<void> {
  await redis.set('polling:heartbeat', timestamp);
}

export async function getPoller(): Promise<string | null> {
  const poller = await redis.get<string>('polling:poller');
  return poller;
}

export async function attemptTakeoverAsPoller(shopId: string): Promise<boolean> {
  // Try to set as poller with NX (only if not exists) and expiry
  const result = await redis.set('polling:poller', shopId, {
    nx: true, // Only set if key doesn't exist
    ex: 30,   // Expires in 30 seconds (safety mechanism)
  });
  return result === 'OK';
}

export async function refreshPollerLock(shopId: string): Promise<void> {
  // Refresh the TTL on the poller lock
  await redis.expire('polling:poller', 30);
}

export async function getMode(): Promise<'active-6s' | 'sleeping-1min' | null> {
  const mode = await redis.get<'active-6s' | 'sleeping-1min'>('polling:mode');
  return mode;
}

export async function setMode(mode: 'active-6s' | 'sleeping-1min'): Promise<void> {
  await redis.set('polling:mode', mode);
}

export async function getLastId(restaurantId: string, currency: string): Promise<string> {
  const lastId = await redis.get<string>(`lastId:${restaurantId}:${currency}`);
  return lastId || '0'; // Default to '0' if no lastId found
}

export async function setLastId(restaurantId: string, currency: string, id: string): Promise<void> {
  await redis.set(`lastId:${restaurantId}:${currency}`, id);
}

export async function publishTransfer(restaurantId: string, transfer: any): Promise<void> {
  // Publish transfer to restaurant-specific Redis Stream
  await redis.xadd(`transfers:${restaurantId}`, '*', transfer);
}

export async function publishSystemBroadcast(broadcast: {
  type: string;
  poller?: string;
  mode?: string;
  timestamp: number;
}): Promise<void> {
  // Publish to system broadcasts stream
  await redis.xadd('system:broadcasts', '*', broadcast);
}

// Execute raw Redis commands via REST API (for commands not supported by SDK)
export async function execRaw<T = any>(command: string[]): Promise<T> {
  const url = process.env.KV_REST_API_URL!;
  const token = process.env.KV_REST_API_TOKEN!;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redis command failed: ${text}`);
  }

  const data = await response.json();

  // Upstash REST API returns { result: <value> } or { error: <message> }
  if (data.error) {
    throw new Error(data.error);
  }

  return data.result as T;
}

// ========================================================================
// NEW: Single Hash State Management (Option 3)
// All polling state consolidated into one Redis hash for efficiency
// ========================================================================

const POLLING_STATE_KEY = 'polling:state';

export interface PollingState {
  heartbeat?: string;  // Stored as string in Redis
  poller?: string;
  mode?: 'active-6s' | 'sleeping-1min';
  // Dynamic lastId fields: "{account}:{currency}" -> id
  // e.g., "indies.cafe:HBD" -> "12345"
  [key: string]: string | undefined;
}

/**
 * Get all polling state from single Redis hash
 * @returns PollingState object with all fields
 * Redis cost: 1 HGETALL
 */
export async function getPollingState(): Promise<PollingState> {
  const state = await redis.hgetall<Record<string, string>>(POLLING_STATE_KEY);
  return state || {};
}

/**
 * Update multiple fields in polling state hash
 * @param updates - Object with fields to update
 * Redis cost: 1 HMSET (regardless of number of fields)
 */
export async function updatePollingState(updates: Record<string, string | number>): Promise<void> {
  if (Object.keys(updates).length === 0) return;

  // Convert all values to strings for Redis
  const stringUpdates: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    stringUpdates[key] = String(value);
  }

  await redis.hmset(POLLING_STATE_KEY, stringUpdates);
}

/**
 * Get heartbeat timestamp from state
 * @param state - Polling state object (pass result from getPollingState)
 * @returns Timestamp or null
 */
export function getHeartbeatFromState(state: PollingState): number | null {
  if (!state.heartbeat) return null;
  return parseInt(state.heartbeat, 10);
}

/**
 * Get poller ID from state
 * @param state - Polling state object
 * @returns Poller ID or null
 */
export function getPollerFromState(state: PollingState): string | null {
  return state.poller || null;
}

/**
 * Get mode from state
 * @param state - Polling state object
 * @returns Mode or null
 */
export function getModeFromState(state: PollingState): 'active-6s' | 'sleeping-1min' | null {
  return (state.mode as 'active-6s' | 'sleeping-1min') || null;
}

/**
 * Get lastId from state for specific account and currency
 * @param state - Polling state object
 * @param account - Hive account name (e.g., 'indies.cafe')
 * @param currency - Currency symbol (e.g., 'HBD')
 * @returns LastId or '0' if not found
 */
export function getLastIdFromState(state: PollingState, account: string, currency: string): string {
  const key = `${account}:${currency}`;
  return state[key] || '0';
}

/**
 * Helper to build lastId update objects
 * Call this for each account+currency, then pass all updates to updatePollingState
 * @param account - Hive account name
 * @param currency - Currency symbol
 * @param id - LastId value
 * @returns Object with key-value pair to merge into updates
 */
export function buildLastIdUpdate(account: string, currency: string, id: string): Record<string, string> {
  const key = `${account}:${currency}`;
  return { [key]: id };
}

/**
 * Attempt to become the poller using SETNX pattern
 * NOTE: This still uses a separate key with TTL because HSETNX + HEXPIRE is complex
 * The poller field in the hash is updated separately for consistency
 * @param shopId - Shop identifier
 * @returns true if successfully became poller
 */
export async function attemptTakeoverAsPollerV2(shopId: string): Promise<boolean> {
  // Try to set as poller with NX (only if not exists) and expiry
  const result = await redis.set('polling:poller', shopId, {
    nx: true, // Only set if key doesn't exist
    ex: 30,   // Expires in 30 seconds (safety mechanism)
  });

  // Also update the hash for consistency
  if (result === 'OK') {
    await updatePollingState({ poller: shopId });
  }

  return result === 'OK';
}

/**
 * Refresh poller lock TTL
 * @param shopId - Shop identifier
 */
export async function refreshPollerLockV2(shopId: string): Promise<void> {
  // Refresh the TTL on the separate poller lock key
  await redis.expire('polling:poller', 30);
  // Note: Hash field doesn't need TTL, it's just for reading
}
