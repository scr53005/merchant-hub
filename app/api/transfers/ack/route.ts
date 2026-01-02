// API endpoint to acknowledge (ACK) transfers after successful processing
// Called by restaurant co pages after they've successfully inserted transfer into their DB

import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// Dynamic CORS handler (same as consume endpoint)
function getCorsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin') || '';

  const isAllowed =
    /^https:\/\/[a-z0-9-]+\.innopay\.lu$/i.test(origin) ||
    /^http:\/\/localhost(:\d+)?$/i.test(origin) ||
    /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/i.test(origin);

  if (isAllowed) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
    };
  }

  if (process.env.NODE_ENV !== 'production') {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }

  return {};
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: getCorsHeaders(request) });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { restaurantId, messageIds } = body;

    if (!restaurantId) {
      return NextResponse.json(
        { error: 'restaurantId is required' },
        { status: 400, headers: getCorsHeaders(request) }
      );
    }

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return NextResponse.json(
        { error: 'messageIds array is required' },
        { status: 400, headers: getCorsHeaders(request) }
      );
    }

    const streamKey = `transfers:${restaurantId}`;
    const groupName = `${restaurantId}-consumers`;

    console.log(`[ACK] Acknowledging ${messageIds.length} messages for ${streamKey}`);

    // Acknowledge messages one at a time to avoid TypeScript spread issues
    // Each xack returns 0 or 1
    let ackCount = 0;
    for (const msgId of messageIds) {
      const result = await redis.xack(streamKey, groupName, msgId);
      ackCount += result;
    }

    console.log(`[ACK] Successfully acknowledged ${ackCount}/${messageIds.length} messages`);

    if (ackCount < messageIds.length) {
      console.warn(`[ACK] Warning: Only ${ackCount} out of ${messageIds.length} messages were acknowledged`);
    }

    return NextResponse.json(
      {
        success: true,
        acknowledged: ackCount,
        total: messageIds.length,
        messageIds,
      },
      { headers: getCorsHeaders(request) }
    );

  } catch (error: any) {
    console.error('[API /transfers/ack] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to acknowledge transfers' },
      { status: 500, headers: getCorsHeaders(request) }
    );
  }
}
