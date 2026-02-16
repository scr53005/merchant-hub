// System health status API
// GET /api/status
// Returns polling state, Redis stream info, and restaurant config in one call.

import { NextResponse } from 'next/server';
import {
  getPollingState,
  getHeartbeatFromState,
  getPollerFromState,
  getModeFromState,
  getLastIdFromState,
  execRaw,
} from '@/lib/redis';
import { RESTAURANTS, POLLING_CONFIG, REDIS_KEYS } from '@/lib/config';

interface ConsumerGroupInfo {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
}

interface StreamInfo {
  length: number;
  consumerGroups: ConsumerGroupInfo[];
  error?: string;
}

async function getStreamInfo(streamKey: string): Promise<StreamInfo> {
  try {
    const length = await execRaw<number>(['XLEN', streamKey]);

    let consumerGroups: ConsumerGroupInfo[] = [];
    try {
      const groups = await execRaw<any[]>(['XINFO', 'GROUPS', streamKey]);
      if (Array.isArray(groups)) {
        consumerGroups = groups.map((g: any) => {
          // XINFO GROUPS returns alternating key-value pairs or objects depending on Redis version
          if (Array.isArray(g)) {
            const obj: Record<string, any> = {};
            for (let i = 0; i < g.length; i += 2) {
              obj[g[i]] = g[i + 1];
            }
            return {
              name: obj['name'] || '?',
              consumers: Number(obj['consumers'] || 0),
              pending: Number(obj['pending'] || 0),
              lastDeliveredId: String(obj['last-delivered-id'] || '0'),
            };
          }
          // Upstash may return objects directly
          return {
            name: g.name || '?',
            consumers: Number(g.consumers || 0),
            pending: Number(g.pending || 0),
            lastDeliveredId: String(g['last-delivered-id'] || g.lastDeliveredId || '0'),
          };
        });
      }
    } catch {
      // Stream exists but no consumer groups yet — that's fine
    }

    return { length, consumerGroups };
  } catch (err: any) {
    // Stream may not exist yet
    return { length: 0, consumerGroups: [], error: err.message };
  }
}

export async function GET() {
  try {
    const pollingState = await getPollingState();
    const heartbeat = getHeartbeatFromState(pollingState);
    const poller = getPollerFromState(pollingState);
    const mode = getModeFromState(pollingState);
    const now = Date.now();

    // Polling status
    const polling = {
      heartbeat,
      isActive: heartbeat !== null && (now - heartbeat) < POLLING_CONFIG.HEARTBEAT_TIMEOUT,
      poller,
      mode,
      timeSinceLastPoll: heartbeat ? now - heartbeat : null,
      heartbeatTimeout: POLLING_CONFIG.HEARTBEAT_TIMEOUT,
    };

    // Per-restaurant info
    const restaurants = await Promise.all(
      RESTAURANTS.map(async (r) => {
        const streamKey = REDIS_KEYS.TRANSFERS_STREAM(r.id);
        const stream = await getStreamInfo(streamKey);

        // Collect lastIds per account+currency from the polling state hash
        const lastIds: Record<string, Record<string, string>> = {
          prod: {},
          dev: {},
        };
        for (const currency of r.currencies) {
          lastIds.prod[currency] = getLastIdFromState(pollingState, r.accounts.prod, currency);
          lastIds.dev[currency] = getLastIdFromState(pollingState, r.accounts.dev, currency);
        }

        return {
          id: r.id,
          name: r.name,
          accounts: r.accounts,
          currencies: r.currencies,
          stream,
          lastIds,
        };
      })
    );

    // System broadcasts stream
    let systemBroadcasts: StreamInfo = { length: 0, consumerGroups: [] };
    try {
      systemBroadcasts = await getStreamInfo(REDIS_KEYS.SYSTEM_BROADCAST);
    } catch {
      // ignore
    }

    return NextResponse.json({
      timestamp: now,
      polling,
      restaurants,
      systemBroadcasts,
    });
  } catch (error: any) {
    console.error('[STATUS] Error:', error.message);
    return NextResponse.json(
      { error: 'Failed to fetch status', details: error.message },
      { status: 500 }
    );
  }
}
