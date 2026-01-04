// Poll API route - Called by the active poller every 6 seconds
// GET /api/poll
// Polls HAF database for all restaurants and publishes transfers to Redis

import { NextResponse } from 'next/server';
import { setHeartbeat, refreshPollerLock, getPoller } from '@/lib/redis';
import { pollAllTransfers } from '@/lib/haf-polling';
import { handleCorsPreflight, corsResponse } from '@/lib/cors';

// Handle CORS preflight
export async function OPTIONS(request: Request) {
  return handleCorsPreflight(request);
}

export async function GET(request: Request) {
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

    return corsResponse({
      success: true,
      transfersFound: transfers.length,
      poller: currentPoller,
      duration,
      timestamp: Date.now(),
    }, request);
  } catch (error: any) {
    console.error('Poll error:', error);
    return corsResponse(
      {
        error: 'Failed to poll HAF',
        details: error.message,
        duration: Date.now() - startTime,
      },
      request,
      { status: 500 }
    );
  }
}
