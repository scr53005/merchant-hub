// Poll API route - Called by the active poller every 6 seconds
// GET /api/poll
// Polls HAF database for all restaurants and publishes transfers to Redis

import { NextResponse } from 'next/server';
import { setHeartbeat, refreshPollerLock, getPoller } from '@/lib/redis';
import { pollAllTransfers } from '@/lib/haf-polling';

export async function GET() {
  const startTime = Date.now();

  try {
    const currentPoller = await getPoller();

    // Poll HAF for all restaurants and all currencies
    const transfers = await pollAllTransfers();

    // Update heartbeat
    await setHeartbeat(Date.now());

    // Refresh poller lock TTL
    if (currentPoller) {
      await refreshPollerLock(currentPoller);
    }

    const duration = Date.now() - startTime;

    console.log(`[poll] Completed in ${duration}ms, found ${transfers.length} transfers`);

    return NextResponse.json({
      success: true,
      transfersFound: transfers.length,
      poller: currentPoller,
      duration,
      timestamp: Date.now(),
    });
  } catch (error: any) {
    console.error('Poll error:', error);
    return NextResponse.json(
      {
        error: 'Failed to poll HAF',
        details: error.message,
        duration: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
