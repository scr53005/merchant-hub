// Wake-up API route - Called by co pages when they first open
// POST /api/wake-up with { shopId: string }
// Returns status and whether this shop should start polling

import { NextResponse } from 'next/server';
import { getHeartbeat, getPoller, attemptTakeoverAsPoller, setMode, publishSystemBroadcast } from '@/lib/redis';
import { POLLING_CONFIG } from '@/lib/config';

export async function POST(request: Request) {
  try {
    const { shopId } = await request.json();

    if (!shopId) {
      return NextResponse.json(
        { error: 'shopId is required' },
        { status: 400 }
      );
    }

    const heartbeat = await getHeartbeat();
    const currentPoller = await getPoller();
    const now = Date.now();

    // Check if polling is active (heartbeat is fresh)
    const isPollingActive = heartbeat && (now - heartbeat < POLLING_CONFIG.HEARTBEAT_TIMEOUT);

    if (isPollingActive && currentPoller) {
      // Polling is already active by another shop
      return NextResponse.json({
        status: 'already-active',
        message: `Polling is already active by ${currentPoller}`,
        poller: currentPoller,
        shouldStartPolling: false,
        heartbeat,
      });
    }

    // Polling is not active, attempt to become the poller
    // Add random delay for collision avoidance (Ethernet-like)
    const randomDelay = Math.floor(Math.random() * POLLING_CONFIG.TAKEOVER_DELAY_MAX);
    await new Promise(resolve => setTimeout(resolve, randomDelay));

    // Attempt takeover
    const won = await attemptTakeoverAsPoller(shopId);

    if (won) {
      // This shop is now the poller
      await setMode('active-6s');
      await publishSystemBroadcast({
        type: 'polling-started',
        poller: shopId,
        mode: 'active-6s',
        timestamp: now,
      });

      console.log(`[wake-up] ${shopId} became the poller`);

      return NextResponse.json({
        status: 'became-poller',
        message: `${shopId} is now the poller`,
        poller: shopId,
        shouldStartPolling: true,
        randomDelay,
      });
    } else {
      // Another shop won the race
      const newPoller = await getPoller();
      console.log(`[wake-up] ${shopId} lost takeover race to ${newPoller}`);

      return NextResponse.json({
        status: 'lost-race',
        message: `Another shop (${newPoller}) became the poller`,
        poller: newPoller,
        shouldStartPolling: false,
        randomDelay,
      });
    }
  } catch (error: any) {
    console.error('Wake-up error:', error);
    return NextResponse.json(
      { error: 'Failed to process wake-up', details: error.message },
      { status: 500 }
    );
  }
}
