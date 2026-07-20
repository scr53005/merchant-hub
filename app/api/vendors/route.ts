// Vendor watchlist API (project_hatchery_vendor_hatching).
//   POST /api/vendors   — register a Farm vendor account (PUSH path, called
//                         by the innopay hub at hatch). Authed (Bearer
//                         ADMIN_TOKEN), same as /api/source.
//   GET  /api/vendors   — list the current dynamic watchlist (ops/debug).
// merchant-hub stays dumb about tiers: it only learns "watch one more
// account under {restaurantId}, publish its transfers to that env stream".
// New vendors are polled on the very next 6s cycle — no config.ts, no deploy.

import { NextResponse } from 'next/server';
import {
  registerDynamicAccount,
  getDynamicAccountsRaw,
  validateRegistration,
} from '@/lib/dynamic-accounts';

function unauthorized(request: Request): NextResponse | null {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json({ error: 'ADMIN_TOKEN not configured' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${adminToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  let body: { account?: unknown; restaurantId?: unknown; env?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validated = validateRegistration(body.account, body.restaurantId, body.env);
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  try {
    await registerDynamicAccount(validated);
    console.warn(
      `[VENDORS] Registered ${validated.account} → ${validated.restaurantId}:${validated.env} (watched from next poll)`,
    );
    return NextResponse.json({ success: true, ...validated });
  } catch (error: any) {
    console.error('[VENDORS] register failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const raw = await getDynamicAccountsRaw();
    const accounts = Object.entries(raw).map(([account, value]) => ({ account, target: value }));
    return NextResponse.json({ count: accounts.length, accounts });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
