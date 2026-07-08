// Regression tests for the CORS origin allowlist.
//
// Background: the allowlist used to be a hand-maintained array of spoke domains.
// millewee.innopay.lu was never added, so its CO page could not call /api/wake-up
// (browser blocked it on preflight) and could never join the poller election —
// orders silently stopped arriving (2026-07 incident). The allowlist is now a
// *.innopay.lu pattern; these tests pin that every current and future spoke
// subdomain is accepted.

import { describe, it, expect, afterEach } from 'vitest';
import { isOriginAllowed } from '@/lib/cors';

const ORIGINAL_ALLOWED = process.env.ALLOWED_ORIGINS;

afterEach(() => {
  if (ORIGINAL_ALLOWED === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = ORIGINAL_ALLOWED;
  }
});

describe('isOriginAllowed', () => {
  it('allows every spoke CO page on innopay.lu (incl. millewee — the 2026-07 incident)', () => {
    expect(isOriginAllowed('https://indies.innopay.lu')).toBe(true);
    expect(isOriginAllowed('https://croque-bedaine.innopay.lu')).toBe(true);
    expect(isOriginAllowed('https://millewee.innopay.lu')).toBe(true);
    expect(isOriginAllowed('https://zenbar.innopay.lu')).toBe(true);
    // A spoke that doesn't exist yet — the whole point of the wildcard
    expect(isOriginAllowed('https://future-spoke.innopay.lu')).toBe(true);
  });

  it('allows non-spoke first-party subdomains (they are ours, CORS is not the auth layer)', () => {
    expect(isOriginAllowed('https://liman.innopay.lu')).toBe(true);
    expect(isOriginAllowed('https://wallet.innopay.lu')).toBe(true);
  });

  it('rejects lookalike and third-party origins', () => {
    expect(isOriginAllowed('https://innopay.lu.evil.com')).toBe(false);
    expect(isOriginAllowed('https://evilinnopay.lu')).toBe(false);
    expect(isOriginAllowed('https://millewee.innopay.lu.attacker.io')).toBe(false);
    expect(isOriginAllowed('https://example.com')).toBe(false);
  });

  it('rejects http (non-TLS) and ported innopay.lu origins', () => {
    expect(isOriginAllowed('http://millewee.innopay.lu')).toBe(false);
    expect(isOriginAllowed('https://millewee.innopay.lu:8443')).toBe(false);
  });

  it('rejects null/missing origin', () => {
    expect(isOriginAllowed(null)).toBe(false);
    expect(isOriginAllowed('')).toBe(false);
  });

  it('allows dev servers on localhost and LAN', () => {
    expect(isOriginAllowed('http://localhost:3002')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3001')).toBe(true);
    expect(isOriginAllowed('http://192.168.178.55:3001')).toBe(true);
    expect(isOriginAllowed('http://10.0.0.5:8080')).toBe(true);
  });

  it('honors the ALLOWED_ORIGINS env escape hatch for non-innopay.lu domains', () => {
    process.env.ALLOWED_ORIGINS = 'https://zenbar.ro, https://other.example';
    expect(isOriginAllowed('https://zenbar.ro')).toBe(true);
    expect(isOriginAllowed('https://other.example')).toBe(true);
    expect(isOriginAllowed('https://not-listed.example')).toBe(false);
  });
});
