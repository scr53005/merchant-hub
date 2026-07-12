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
import { resolveSourceName } from '@/lib/source-decision';

interface ConsumerGroupInfo {
  name: string;
  consumers: number;
  pending: number;       // Redis native: delivered but not ACK'd (rarely useful)
  undelivered: number;   // Messages in stream not yet delivered to this group
  lastDeliveredId: string;
}

interface StreamInfo {
  length: number;
  consumerGroups: ConsumerGroupInfo[];
  error?: string;
}

// Count messages in stream that haven't been delivered to a consumer group yet.
// Uses XRANGE from (lastDeliveredId+1) to end — fine for streams of hundreds of entries.
async function countUndelivered(streamKey: string, lastDeliveredId: string, streamLength: number): Promise<number> {
  if (!lastDeliveredId || lastDeliveredId === '0' || lastDeliveredId === '0-0') {
    // Group just created, nothing delivered yet → everything is undelivered
    return streamLength;
  }
  try {
    // Make the range exclusive by incrementing the sequence number
    const parts = lastDeliveredId.split('-');
    const exclusiveStart = `${parts[0]}-${parseInt(parts[1] || '0') + 1}`;
    const entries = await execRaw<any[]>(['XRANGE', streamKey, exclusiveStart, '+']);
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return 0;
  }
}

async function getStreamInfo(streamKey: string): Promise<StreamInfo> {
  try {
    const length = await execRaw<number>(['XLEN', streamKey]);

    let consumerGroups: ConsumerGroupInfo[] = [];
    try {
      const groups = await execRaw<any[]>(['XINFO', 'GROUPS', streamKey]);
      if (Array.isArray(groups)) {
        const parsed = groups.map((g: any) => {
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
        // Compute undelivered count for each group
        consumerGroups = await Promise.all(
          parsed.map(async (g) => ({
            ...g,
            undelivered: await countUndelivered(streamKey, g.lastDeliveredId, length),
          }))
        );
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
    const cronLastPoll = pollingState.cronLastPoll ? parseInt(pollingState.cronLastPoll, 10) : null;
    const polling = {
      heartbeat,
      isActive: heartbeat !== null && (now - heartbeat) < POLLING_CONFIG.HEARTBEAT_TIMEOUT,
      poller,
      mode,
      timeSinceLastPoll: heartbeat ? now - heartbeat : null,
      heartbeatTimeout: POLLING_CONFIG.HEARTBEAT_TIMEOUT,
      cronLastPoll,
      timeSinceCronPoll: cronLastPoll ? now - cronLastPoll : null,
      // Last failed poll ("<ISO timestamp> <message>") — check the timestamp:
      // it is NOT cleared by successful polls
      lastPollError: pollingState.lastPollError || null,
      // HBD source staleness: hafsql.operation_transfer_table's newest row vs
      // the raw HAF head block. Healthy = 0-2; large = the HAFSQL indexer is
      // frozen and HBD polls succeed while seeing nothing (2026-07 incident).
      // A block count fits comfortably in a Number (< 2^31).
      hbdSourceLagBlocks: pollingState.hbdSourceLagBlocks != null ? Number(pollingState.hbdSourceLagBlocks) : null,
      hbdSourceLagCheckedAt: pollingState.hbdSourceLagCheckedAt || null,
      // HA failover state machine (HIVESQL-HA-PLAN.md §7)
      activeSource: resolveSourceName(pollingState),
      forcedSource: pollingState.forcedSource === 'hafsql' || pollingState.forcedSource === 'hivesql'
        ? pollingState.forcedSource : null,
      hafsqlErrorStreakSince: pollingState.hafsqlErrorStreakSince || null,
      hafsqlRecoveryProbes: pollingState.hafsqlRecoveryProbes ? Number(pollingState.hafsqlRecoveryProbes) : 0,
      lastFailoverAt: pollingState.lastFailoverAt || null,
      lastFailbackAt: pollingState.lastFailbackAt || null,
    };

    // Per-restaurant info
    const restaurants = await Promise.all(
      RESTAURANTS.map(async (r) => {
        const prodStreamKey = REDIS_KEYS.TRANSFERS_STREAM(r.id, 'prod');
        const devStreamKey = REDIS_KEYS.TRANSFERS_STREAM(r.id, 'dev');
        const [prodStream, devStream] = await Promise.all([
          getStreamInfo(prodStreamKey),
          getStreamInfo(devStreamKey),
        ]);

        // Collect lastIds per account+currency from the polling state hash
        // Primary accounts: keyed by currency for backward compat with dashboard
        const lastIds: Record<string, Record<string, string>> = {
          prod: {},
          dev: {},
        };
        for (const currency of r.currencies) {
          lastIds.prod[currency] = getLastIdFromState(pollingState, r.accounts.prod, currency);
          lastIds.dev[currency] = getLastIdFromState(pollingState, r.accounts.dev, currency);
        }

        // Additional accounts: keyed by "account:currency"
        const additionalLastIds: Record<string, Record<string, string>> = { prod: {}, dev: {} };
        for (const account of r.additionalAccounts?.prod || []) {
          for (const currency of r.currencies) {
            additionalLastIds.prod[`${account}:${currency}`] = getLastIdFromState(pollingState, account, currency);
          }
        }
        for (const account of r.additionalAccounts?.dev || []) {
          for (const currency of r.currencies) {
            additionalLastIds.dev[`${account}:${currency}`] = getLastIdFromState(pollingState, account, currency);
          }
        }

        return {
          id: r.id,
          name: r.name,
          accounts: r.accounts,
          additionalAccounts: r.additionalAccounts,
          currencies: r.currencies,
          streams: { prod: prodStream, dev: devStream },
          lastIds,
          additionalLastIds,
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
