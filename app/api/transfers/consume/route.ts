// API endpoint to consume transfers from Redis Streams using Consumer Groups
// Called by restaurant co pages to get pending transfers
// Uses XREADGROUP for reliable message delivery with acknowledgment

import { NextRequest, NextResponse } from 'next/server';
import { execRaw } from '@/lib/redis';
import { handleCorsPreflight, corsResponse } from '@/lib/cors';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const restaurantId = searchParams.get('restaurantId');
    const consumerId = searchParams.get('consumerId') || 'default-consumer';
    const count = parseInt(searchParams.get('count') || '10');

    if (!restaurantId) {
      return corsResponse(
        { error: 'restaurantId is required' },
        request,
        { status: 400 }
      );
    }

    const streamKey = `transfers:${restaurantId}`;
    const groupName = `${restaurantId}-consumers`;

    console.log(`[CONSUME] Consumer '${consumerId}' reading from ${streamKey} (group: ${groupName})`);

    // Ensure consumer group exists
    // Try to create it; if it already exists, ignore the error
    try {
      await execRaw(['XGROUP', 'CREATE', streamKey, groupName, '0', 'MKSTREAM']);
      console.log(`[CONSUME] Created consumer group '${groupName}' for ${streamKey}`);
    } catch (error: any) {
      // Group already exists (error: BUSYGROUP) - this is fine
      if (!error.message?.includes('BUSYGROUP')) {
        throw error;
      }
    }

    // Read new messages using consumer group
    // '>' means "only new messages that haven't been delivered to any consumer"
    const result = await execRaw<any[]>([
      'XREADGROUP', 'GROUP', groupName, consumerId,
      'COUNT', count.toString(),
      'STREAMS', streamKey, '>'
    ]);

    if (!result || result.length === 0) {
      console.log(`[CONSUME] No new transfers for consumer '${consumerId}' in ${streamKey}`);

      // Check for pending messages count
      let pendingCount = 0;
      try {
        const pendingInfo = await execRaw<any>(['XPENDING', streamKey, groupName]);
        pendingCount = pendingInfo?.[0] || 0;
        if (pendingCount > 0) {
          console.log(`[CONSUME] Found ${pendingCount} pending (unacknowledged) messages`);
        }
      } catch {
        // Ignore errors checking pending
      }

      return corsResponse(
        { transfers: [], pending: pendingCount },
        request
      );
    }

    // Parse Redis Stream response
    // result format: [[streamKey, [[id, [field, value, ...]], ...]]]
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

    return corsResponse(
      {
        transfers,
        consumerId,
        streamKey,
        groupName,
        message: `${transfers.length} transfers delivered. Must ACK after successful processing.`
      },
      request
    );

  } catch (error: any) {
    console.error('[API /transfers/consume] Error:', error);
    return corsResponse(
      { error: error.message || 'Failed to consume transfers' },
      request,
      { status: 500 }
    );
  }
}
