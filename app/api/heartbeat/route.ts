// Heartbeat API route - Check if polling is active and who the current poller is
// GET /api/heartbeat

import { NextResponse } from 'next/server';
import { getPollingState, getHeartbeatFromState, getPollerFromState, getModeFromState } from '@/lib/redis';
import { POLLING_CONFIG } from '@/lib/config';
import { handleCorsPreflight, corsResponse } from '@/lib/cors';

// Handle CORS preflight
export async function OPTIONS(request: Request) {
  return handleCorsPreflight(request);
}

export async function GET(request: Request) {
  try {
    // Get all polling state in one operation
    // Redis cost: 1 HGETALL
    const pollingState = await getPollingState();
    const heartbeat = getHeartbeatFromState(pollingState);
    const poller = getPollerFromState(pollingState);
    const mode = getModeFromState(pollingState);

    const now = Date.now();
    const isActive = heartbeat && (now - heartbeat < POLLING_CONFIG.HEARTBEAT_TIMEOUT);

    return corsResponse({
      isActive,
      heartbeat,
      poller,
      mode,
      timeSinceLastPoll: heartbeat ? now - heartbeat : null,
      heartbeatTimeout: POLLING_CONFIG.HEARTBEAT_TIMEOUT,
    }, request);
  } catch (error: any) {
    console.error('Heartbeat check error:', error);
    return corsResponse(
      { error: 'Failed to check heartbeat', details: error.message },
      request,
      { status: 500 }
    );
  }
}
