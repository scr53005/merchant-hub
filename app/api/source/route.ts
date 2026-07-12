// Source override API — POST /api/source  { source: 'hafsql' | 'hivesql' | 'auto' }
//
// The one-click failover control (HIVESQL-HA-PLAN.md §7). State-changing on
// an otherwise-open service, so this is merchant-hub's first authenticated
// endpoint: requires `Authorization: Bearer ${ADMIN_TOKEN}`. CORS alone only
// restrains browsers, not curl. No CORS handler on purpose — the dashboard
// is same-origin.
//
// Forcing a source performs the full transition immediately (cursor seeding /
// cursor jump), so the next poll — 6s away when a CO page is active — already
// reads from the new source. 'auto' clears the override and lets the state
// machine decide from the next poll onward.

import { NextResponse } from 'next/server';
import { getPollingState, updatePollingState } from '@/lib/redis';
import { resolveSourceName } from '@/lib/source-decision';
import { performFailover, performFailback } from '@/lib/source-manager';
import { hafsqlSource } from '@/lib/sources/hafsql';

// Transitions run a cursor-seeding binary search (~30 point queries)
export const maxDuration = 60;

export async function POST(request: Request) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json({ error: 'ADMIN_TOKEN not configured' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${adminToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let source: unknown;
  try {
    ({ source } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (source !== 'hafsql' && source !== 'hivesql' && source !== 'auto') {
    return NextResponse.json({ error: "source must be 'hafsql', 'hivesql' or 'auto'" }, { status: 400 });
  }

  try {
    const state = await getPollingState();
    const current = resolveSourceName(state);

    if (source === 'auto') {
      await updatePollingState({ forcedSource: '' });
      console.warn(`[SOURCE] Override cleared via /api/source — auto mode (currently on ${current})`);
      return NextResponse.json({ success: true, activeSource: current, forcedSource: null });
    }

    if (source !== current) {
      // Perform the actual transition so cursors are correct before the next poll
      if (source === 'hivesql') {
        await performFailover(state, 'manual override via /api/source');
      } else {
        const health = await hafsqlSource.healthCheck();
        if (!health.reachable || health.headBlock === null) {
          return NextResponse.json(
            { error: `HAFSQL is unreachable (${health.error ?? 'no head block'}) — cannot switch to it` },
            { status: 502 }
          );
        }
        await performFailback(BigInt(health.headBlock));
      }
    }

    await updatePollingState({ forcedSource: source });
    console.warn(`[SOURCE] Forced source = ${source} via /api/source`);
    return NextResponse.json({ success: true, activeSource: source, forcedSource: source });
  } catch (error: any) {
    console.error('[SOURCE] /api/source failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
