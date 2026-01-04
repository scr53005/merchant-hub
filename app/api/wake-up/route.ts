// Wake-up API route - Called by co pages when they first open
// POST /api/wake-up with { shopId: string }
// Returns status and whether this shop should start polling

import { NextResponse } from 'next/server';
import { getHeartbeat, getPoller, attemptTakeoverAsPoller, setMode, publishSystemBroadcast } from '@/lib/redis';
import { POLLING_CONFIG } from '@/lib/config';
import { handleCorsPreflight, corsResponse } from '@/lib/cors';

// Handle CORS preflight
export async function OPTIONS(request: Request) {
  return handleCorsPreflight(request);
}

export async function POST(request: Request) {
  try {
    const { shopId } = await request.json();

    if (!shopId) {
      return corsResponse(
        { error: 'shopId is required' },
        request,
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
      return corsResponse({
        status: 'already-active',
        message: `Polling is already active by ${currentPoller}`,
        poller: currentPoller,
        shouldStartPolling: false,
        heartbeat,
      }, request);
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

      return corsResponse({
        status: 'became-poller',
        message: `${shopId} is now the poller`,
        poller: shopId,
        shouldStartPolling: true,
        randomDelay,
      }, request);
    } else {
      // Another shop won the race
      const newPoller = await getPoller();
      console.log(`[wake-up] ${shopId} lost takeover race to ${newPoller}`);

      return corsResponse({
        status: 'lost-race',
        message: `Another shop (${newPoller}) became the poller`,
        poller: newPoller,
        shouldStartPolling: false,
        randomDelay,
      }, request);
    }
  } catch (error: any) {
    console.error('Wake-up error:', error);
    return corsResponse(
      { error: 'Failed to process wake-up', details: error.message },
      request,
      { status: 500 }
    );
  }
}
