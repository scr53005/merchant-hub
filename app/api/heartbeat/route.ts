// Heartbeat API route - Check if polling is active and who the current poller is
// GET /api/heartbeat

import { NextResponse } from 'next/server';
import { getHeartbeat, getPoller, getMode } from '@/lib/redis';
import { POLLING_CONFIG } from '@/lib/config';

export async function GET() {
  try {
    const heartbeat = await getHeartbeat();
    const poller = await getPoller();
    const mode = await getMode();

    const now = Date.now();
    const isActive = heartbeat && (now - heartbeat < POLLING_CONFIG.HEARTBEAT_TIMEOUT);

    return NextResponse.json({
      isActive,
      heartbeat,
      poller,
      mode,
      timeSinceLastPoll: heartbeat ? now - heartbeat : null,
      heartbeatTimeout: POLLING_CONFIG.HEARTBEAT_TIMEOUT,
    });
  } catch (error: any) {
    console.error('Heartbeat check error:', error);
    return NextResponse.json(
      { error: 'Failed to check heartbeat', details: error.message },
      { status: 500 }
    );
  }
}
