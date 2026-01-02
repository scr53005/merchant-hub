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
