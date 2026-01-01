// Cron Poll API route - Vercel Cron fallback (1 minute interval)
// GET /api/cron-poll
// Only polls if no active 6-second poller exists (all shops are closed)

import { NextResponse } from 'next/server';
import { getHeartbeat, setHeartbeat, setMode, publishSystemBroadcast } from '@/lib/redis';
import { pollAllTransfers } from '@/lib/haf-polling';
import { POLLING_CONFIG } from '@/lib/config';

export async function GET() {
  const startTime = Date.now();

  try {
    const heartbeat = await getHeartbeat();
    const now = Date.now();

    // Check if there's an active 6-second poller
    const isActivePollerRunning = heartbeat && (now - heartbeat < POLLING_CONFIG.HEARTBEAT_TIMEOUT);

    if (isActivePollerRunning) {
      // Active poller exists, don't poll
      return NextResponse.json({
        success: true,
        action: 'skipped',
        reason: 'Active 6-second poller detected',
        heartbeat,
        timeSinceLastPoll: now - heartbeat,
      });
    }

    // No active poller, this cron is the fallback
    console.log('[cron-poll] No active poller detected, polling as fallback');

    // Set mode to sleeping (1-minute polling)
    await setMode('sleeping-1min');

    // Broadcast that we're in sleeping mode
    await publishSystemBroadcast({
      type: 'all-sleeping',
      mode: 'sleeping-1min',
      timestamp: now,
    });

    // Poll HAF
    const transfers = await pollAllTransfers();

    // Update heartbeat
    await setHeartbeat(now);

    const duration = Date.now() - startTime;

    console.log(`[cron-poll] Completed in ${duration}ms, found ${transfers.length} transfers`);

    return NextResponse.json({
      success: true,
      action: 'polled',
      transfersFound: transfers.length,
      mode: 'sleeping-1min',
      duration,
      timestamp: now,
    });
  } catch (error: any) {
    console.error('Cron poll error:', error);
    return NextResponse.json(
      {
        error: 'Failed to execute cron poll',
        details: error.message,
        duration: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
