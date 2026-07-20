// POST /api/vendors/reconcile — the safety-net / "retrieve now" path
// (project_hatchery_vendor_hatching). Makes the dynamic watchlist EXACTLY
// match an authoritative desired set, catching any push (register) that was
// lost while merchant-hub was mid-deploy or blipped.
//
// The authoritative source of truth is the innopay hub's spoke_account
// registry. For now the desired list is supplied in the request body (the
// hub, or the reconcile script, sends it); wiring merchant-hub to fetch it
// directly from an authenticated hub watchlist API is a follow-up. Authed
// (Bearer ADMIN_TOKEN), same as /api/source and /api/vendors.

import { NextResponse } from 'next/server';
import {
  reconcileDynamicAccounts,
  validateRegistration,
  type DynamicAccountRecord,
} from '@/lib/dynamic-accounts';

export async function POST(request: Request) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json({ error: 'ADMIN_TOKEN not configured' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${adminToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { accounts?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Array.isArray(body.accounts)) {
    return NextResponse.json({ error: 'accounts must be an array' }, { status: 400 });
  }

  // Validate every record before touching Redis — reconcile is destructive
  // (it removes accounts not in the list), so a malformed payload must not
  // partially apply.
  const desired: DynamicAccountRecord[] = [];
  for (const raw of body.accounts) {
    const r = raw as { account?: unknown; restaurantId?: unknown; env?: unknown };
    const v = validateRegistration(r.account, r.restaurantId, r.env);
    if ('error' in v) {
      return NextResponse.json(
        { error: `invalid account record: ${v.error}`, record: raw },
        { status: 400 },
      );
    }
    desired.push(v);
  }

  try {
    const result = await reconcileDynamicAccounts(desired);
    console.warn(
      `[VENDORS] Reconciled dynamic watchlist: +${result.added} / -${result.removed} (${desired.length} desired)`,
    );
    return NextResponse.json({ success: true, ...result, desired: desired.length });
  } catch (error: any) {
    console.error('[VENDORS] reconcile failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
