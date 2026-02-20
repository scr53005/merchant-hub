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
    const env = searchParams.get('env') || 'prod'; // Environment: 'prod' or 'dev'

    if (!restaurantId) {
      return corsResponse(
        { error: 'restaurantId is required' },
        request,
        { status: 400 }
      );
    }

    const streamKey = `transfers:${restaurantId}`;
    const groupName = `${restaurantId}-${env}-consumers`;

    console.warn(`[CONSUME] Consumer '${consumerId}' reading from ${streamKey} (group: ${groupName}, env: ${env})`);

    // Debug: Check stream length
    try {
      const streamLen = await execRaw<number>(['XLEN', streamKey]);
      console.warn(`[CONSUME] Stream ${streamKey} has ${streamLen} total messages`);
    } catch (err) {
      console.warn(`[CONSUME] Could not get stream length: ${err}`);
    }

    // Ensure consumer group exists
    // Try to create it; if it already exists, ignore the error
    try {
      await execRaw(['XGROUP', 'CREATE', streamKey, groupName, '0', 'MKSTREAM']);
      console.warn(`[CONSUME] Created consumer group '${groupName}' for ${streamKey}`);
    } catch (error: any) {
      // Group already exists (error: BUSYGROUP) - this is fine
      if (!error.message?.includes('BUSYGROUP')) {
        throw error;
      }
    }

    // Read new messages using consumer group
    // '>' means "only new messages that haven't been delivered to any consumer"
    let result = await execRaw<any[]>([
      'XREADGROUP', 'GROUP', groupName, consumerId,
      'COUNT', count.toString(),
      'STREAMS', streamKey, '>'
    ]);

    // If no new messages, try to claim pending messages from other consumers
    // that have been idle for more than 10 seconds (10000ms)
    if (!result || result.length === 0) {
      console.warn(`[CONSUME] No new transfers for consumer '${consumerId}' in ${streamKey}`);

      // Try to auto-claim pending messages from other (possibly dead) consumers
      // XAUTOCLAIM: automatically claim messages idle for min-idle-time
      try {
        const MIN_IDLE_TIME = 10000; // 10 seconds
        const autoclaimResult = await execRaw<any>([
          'XAUTOCLAIM', streamKey, groupName, consumerId,
          MIN_IDLE_TIME.toString(), '0-0', 'COUNT', count.toString()
        ]);

        // XAUTOCLAIM returns: [next-cursor, [[id, [field, value, ...]], ...], [deleted-ids]]
        if (autoclaimResult && autoclaimResult[1] && autoclaimResult[1].length > 0) {
          console.warn(`[CONSUME] Auto-claimed ${autoclaimResult[1].length} pending messages`);
          // Convert to same format as XREADGROUP result
          result = [[streamKey, autoclaimResult[1]]];
        }
      } catch (err: any) {
        console.warn(`[CONSUME] XAUTOCLAIM not available or failed:`, err.message);
      }

      // If still no messages, return empty with pending count
      if (!result || result.length === 0) {
        let pendingCount = 0;
        try {
          const pendingInfo = await execRaw<any>(['XPENDING', streamKey, groupName]);
          pendingCount = pendingInfo?.[0] || 0;
          console.warn(`[CONSUME] XPENDING result:`, JSON.stringify(pendingInfo));
          if (pendingCount > 0) {
            console.warn(`[CONSUME] Found ${pendingCount} pending (unacknowledged) messages`);
          }
        } catch (pendingErr) {
          console.warn(`[CONSUME] XPENDING error:`, pendingErr);
        }

        // Debug: Show all messages in stream (first 5)
        try {
          const allMessages = await execRaw<any>(['XRANGE', streamKey, '-', '+', 'COUNT', '5']);
          console.warn(`[CONSUME] XRANGE (first 5 messages in stream):`, JSON.stringify(allMessages));
        } catch (rangeErr) {
          console.warn(`[CONSUME] XRANGE error:`, rangeErr);
        }

        return corsResponse(
          { transfers: [], pending: pendingCount },
          request
        );
      }
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

    console.warn(`[CONSUME] Delivered ${transfers.length} transfers to consumer '${consumerId}'`);
    console.warn(`[CONSUME] Message IDs:`, transfers.map((t: any) => t.messageId).join(', '));

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
