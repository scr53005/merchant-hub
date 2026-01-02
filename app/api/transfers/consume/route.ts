// API endpoint to consume transfers from Redis Streams using Consumer Groups
// Called by restaurant co pages to get pending transfers
// Uses XREADGROUP for reliable message delivery with acknowledgment

import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// Dynamic CORS handler
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

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const restaurantId = searchParams.get('restaurantId');
    const consumerId = searchParams.get('consumerId') || 'default-consumer';
    const count = parseInt(searchParams.get('count') || '10');

    if (!restaurantId) {
      return NextResponse.json(
        { error: 'restaurantId is required' },
        { status: 400, headers: getCorsHeaders(request) }
      );
    }

    const streamKey = `transfers:${restaurantId}`;
    const groupName = `${restaurantId}-consumers`;

    console.log(`[CONSUME] Consumer '${consumerId}' reading from ${streamKey} (group: ${groupName})`);

    // Ensure consumer group exists
    // Try to create it; if it already exists, ignore the error
    try {
      // Upstash SDK: xgroup(subcommand, key, groupName, id, options)
      await redis.xgroup('CREATE', streamKey, groupName, '0', { MKSTREAM: true });
      console.log(`[CONSUME] Created consumer group '${groupName}' for ${streamKey}`);
    } catch (error: any) {
      // Group already exists (error: BUSYGROUP) - this is fine
      if (!error.message?.includes('BUSYGROUP')) {
        throw error;
      }
    }

    // Read new messages using consumer group
    // '>' means "only new messages that haven't been delivered to any consumer"
    // Upstash SDK: xreadgroup(group, consumer, streams, options)
    const result = await redis.xreadgroup(
      groupName,
      consumerId,
      { [streamKey]: '>' },
      { count }
    );

    if (!result || result.length === 0) {
      console.log(`[CONSUME] No new transfers for consumer '${consumerId}' in ${streamKey}`);

      // Check for pending messages count
      let pendingCount = 0;
      try {
        const pendingInfo = await redis.xpending(streamKey, groupName);
        pendingCount = pendingInfo?.pending || 0;
        if (pendingCount > 0) {
          console.log(`[CONSUME] Found ${pendingCount} pending (unacknowledged) messages`);
        }
      } catch {
        // Ignore errors checking pending
      }

      return NextResponse.json(
        { transfers: [], pending: pendingCount },
        { headers: getCorsHeaders(request) }
      );
    }

    // Parse Upstash xreadgroup response
    // result format: [{ name: streamKey, messages: [{ id, field1, field2, ... }] }]
    const streamData = result[0];
    const messages = streamData.messages || [];

    const transfers = messages.map((msg: any) => {
      const { id, ...fields } = msg;
      return {
        messageId: id, // Redis Stream message ID (needed for ACK)
        streamId: id,  // Alias for clarity
        ...fields,
      };
    });

    console.log(`[CONSUME] Delivered ${transfers.length} transfers to consumer '${consumerId}'`);
    console.log(`[CONSUME] Message IDs:`, transfers.map((t: any) => t.messageId).join(', '));

    return NextResponse.json(
      {
        transfers,
        consumerId,
        streamKey,
        groupName,
        message: `${transfers.length} transfers delivered. Must ACK after successful processing.`
      },
      { headers: getCorsHeaders(request) }
    );

  } catch (error: any) {
    console.error('[API /transfers/consume] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to consume transfers' },
      { status: 500, headers: getCorsHeaders(request) }
    );
  }
}
