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
      // Use raw Redis command via call()
      await (redis as any).call('XGROUP', 'CREATE', streamKey, groupName, '0', 'MKSTREAM');
      console.log(`[CONSUME] Created consumer group '${groupName}' for ${streamKey}`);
    } catch (error: any) {
      // Group already exists (error: BUSYGROUP) - this is fine
      if (!error.message?.includes('BUSYGROUP')) {
        throw error;
      }
    }

    // Read new messages using consumer group
    // '>' means "only new messages that haven't been delivered to any consumer"
    // Use raw Redis command for XREADGROUP
    const result = await (redis as any).call(
      'XREADGROUP',
      'GROUP',
      groupName,
      consumerId,
      'COUNT',
      count.toString(),
      'STREAMS',
      streamKey,
      '>'
    ) as any;

    if (!result || result.length === 0) {
      console.log(`[CONSUME] No new transfers for consumer '${consumerId}' in ${streamKey}`);

      // Also check for pending messages (messages read but not ACKed)
      const pendingResult = await (redis as any).call('XPENDING', streamKey, groupName, '-', '+', count.toString()) as any;

      if (pendingResult && pendingResult.length > 0) {
        console.log(`[CONSUME] Found ${pendingResult.length} pending (unacknowledged) messages`);
        // Note: In a real implementation, you might want to claim these with XAUTOCLAIM
        // For now, just log them
      }

      return NextResponse.json(
        { transfers: [], pending: pendingResult?.length || 0 },
        { headers: getCorsHeaders(request) }
      );
    }

    // Parse Redis Stream response
    // result format: [[streamKey, [[id, fields], [id, fields], ...]]]
    const streamData = result[0];
    const entries = streamData[1];

    const transfers = entries.map(([messageId, fields]: [string, string[]]) => {
      // fields is an array like ['field1', 'value1', 'field2', 'value2', ...]
      const obj: any = {
        messageId, // Redis Stream message ID (needed for ACK)
        streamId: messageId, // Alias for clarity
      };
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
      return obj;
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
