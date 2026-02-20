// API endpoint to acknowledge (ACK) transfers after successful processing
// Called by restaurant co pages after they've successfully inserted transfer into their DB

import { NextRequest, NextResponse } from 'next/server';
import { execRaw } from '@/lib/redis';
import { handleCorsPreflight, corsResponse } from '@/lib/cors';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { restaurantId, messageIds, env: bodyEnv } = body;
    const env = bodyEnv || 'prod'; // Environment: 'prod' or 'dev'

    if (!restaurantId) {
      return corsResponse(
        { error: 'restaurantId is required' },
        request,
        { status: 400 }
      );
    }

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return corsResponse(
        { error: 'messageIds array is required' },
        request,
        { status: 400 }
      );
    }

    const streamKey = `transfers:${restaurantId}`;
    const groupName = `${restaurantId}-${env}-consumers`;

    console.warn(`[ACK] Acknowledging ${messageIds.length} messages for ${streamKey} (group: ${groupName}, env: ${env})`);

    // Acknowledge all messages at once using raw command
    const ackCount = await execRaw<number>(['XACK', streamKey, groupName, ...messageIds]);

    console.warn(`[ACK] Successfully acknowledged ${ackCount}/${messageIds.length} messages`);

    if (ackCount < messageIds.length) {
      console.warn(`[ACK] Warning: Only ${ackCount} out of ${messageIds.length} messages were acknowledged`);
    }

    return corsResponse(
      {
        success: true,
        acknowledged: ackCount,
        total: messageIds.length,
        messageIds,
      },
      request
    );

  } catch (error: any) {
    console.error('[API /transfers/ack] Error:', error);
    return corsResponse(
      { error: error.message || 'Failed to acknowledge transfers' },
      request,
      { status: 500 }
    );
  }
}
