// Regression tests for the 2026-07 BigInt cursor bugs (DEBUG-MERCHANT-HUB-CURSEUR.md):
// - Bug 1: BigInt(Number.MAX_SAFE_INTEGER) used as "+infinity" seed for the
//   min-cursor scan leaked into the SQL as `id > 9007199254740991` because
//   every real HAF id (~4.6e17) is larger than the seed.
// - Bug 2: Upstash SDK auto-deserialization JSON.parses hash values, turning
//   big numeric-string cursors into precision-lossy JS numbers.

import { describe, it, expect } from 'vitest';
import {
  parseHgetallReply,
  sanitizeCursor,
  computeMinCursor,
  blockToOperationId,
  computeCatchupLowerBound,
} from '../lib/polling-state';

// A realistic HAF id observed on 2026-07-10 (max(id) on operation_transfer_table).
// Deliberately larger than Number.MAX_SAFE_INTEGER and NOT representable as a double.
const REAL_ID = '463839730480448002';

describe('computeMinCursor', () => {
  it('returns the true min when all cursors exceed MAX_SAFE_INTEGER (bug 1 regression)', () => {
    const cursors = [
      BigInt('463839730480448100'),
      BigInt(REAL_ID),
      BigInt('463839999999999999'),
    ];
    const min = computeMinCursor(cursors);
    expect(min).toBe(BigInt(REAL_ID));
    // The old sentinel must never leak through as the "min"
    expect(min).not.toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('returns 0 for an empty cursor list (no lower bound)', () => {
    expect(computeMinCursor([])).toBe(BigInt(0));
  });

  it('returns 0 when any account has no cursor yet', () => {
    expect(computeMinCursor([BigInt(REAL_ID), BigInt(0)])).toBe(BigInt(0));
  });

  it('handles a single cursor', () => {
    expect(computeMinCursor([BigInt(REAL_ID)])).toBe(BigInt(REAL_ID));
  });
});

describe('sanitizeCursor', () => {
  it('passes a real HAF id through exactly, digit for digit', () => {
    expect(sanitizeCursor(REAL_ID)).toBe(REAL_ID);
  });

  it('coerces a number-typed cursor to string (deserialization defense)', () => {
    // If a cursor still arrives as a JS number, precision is already lost
    // upstream — but sanitizeCursor must at least not throw and must return
    // the decimal string form, never scientific notation.
    expect(sanitizeCursor(463839730480448000)).toBe('463839730480448000');
  });

  it('canonicalizes leading zeros', () => {
    expect(sanitizeCursor('007')).toBe('7');
  });

  it("falls back to '0' for missing values", () => {
    expect(sanitizeCursor(undefined)).toBe('0');
    expect(sanitizeCursor(null)).toBe('0');
  });

  it("falls back to '0' for garbage", () => {
    expect(sanitizeCursor('')).toBe('0');
    expect(sanitizeCursor('abc')).toBe('0');
    expect(sanitizeCursor('4.638e17')).toBe('0');
    expect(sanitizeCursor('-5')).toBe('0');
    expect(sanitizeCursor('12 34')).toBe('0');
  });

  it("falls back to '0' above the plausibility ceiling (10^19)", () => {
    expect(sanitizeCursor('100000000000000000000')).toBe('0'); // 10^20
    // ...but a value just below the ceiling passes
    expect(sanitizeCursor('9999999999999999999')).toBe('9999999999999999999');
  });
});

describe('parseHgetallReply', () => {
  it('parses the Upstash REST flat-array reply with verbatim string values', () => {
    const reply = ['indies.cafe:HBD', REAL_ID, 'heartbeat', '1752130000000', 'mode', 'active-6s'];
    expect(parseHgetallReply(reply)).toEqual({
      'indies.cafe:HBD': REAL_ID,
      heartbeat: '1752130000000',
      mode: 'active-6s',
    });
  });

  it('parses an object-shaped reply, stringifying values', () => {
    // Some Upstash surfaces return objects; numeric values must become strings
    const reply = { 'indies.cafe:HBD': REAL_ID, heartbeat: 1752130000000 };
    expect(parseHgetallReply(reply)).toEqual({
      'indies.cafe:HBD': REAL_ID,
      heartbeat: '1752130000000',
    });
  });

  it('returns {} for null/undefined/empty replies', () => {
    expect(parseHgetallReply(null)).toEqual({});
    expect(parseHgetallReply(undefined)).toEqual({});
    expect(parseHgetallReply([])).toEqual({});
    expect(parseHgetallReply({})).toEqual({});
  });

  it('ignores a trailing unpaired field in a malformed flat array', () => {
    expect(parseHgetallReply(['a', '1', 'dangling'])).toEqual({ a: '1' });
  });
});

describe('blockToOperationId', () => {
  it('matches the id/block relationship observed on hive.operations_view', () => {
    // Verified live 2026-07-10: op id 463926046438195218 sits in block 108016200
    expect(BigInt('463926046438195218') >> BigInt(32)).toBe(BigInt(108016200));
    // blockToOperationId gives the block's smallest possible op id
    expect(blockToOperationId(108016200)).toBe(BigInt(108016200) << BigInt(32));
    expect(blockToOperationId(108016200) <= BigInt('463926046438195218')).toBe(true);
    expect(blockToOperationId(108016201) > BigInt('463926046438195218')).toBe(true);
  });

  it('accepts both number and bigint block numbers', () => {
    expect(blockToOperationId(BigInt(108016200))).toBe(blockToOperationId(108016200));
  });
});

describe('computeCatchupLowerBound', () => {
  const HEAD = BigInt(108016230);

  it('uses the min cursor when it is inside the window', () => {
    const recentCursor = blockToOperationId(108016000) + BigInt(500);
    expect(computeCatchupLowerBound(HEAD, recentCursor)).toBe(recentCursor);
  });

  it('caps at the window start when the cursor is older (or zero)', () => {
    const windowStart = blockToOperationId(HEAD - BigInt(10000));
    expect(computeCatchupLowerBound(HEAD, BigInt(0))).toBe(windowStart);
    const ancientCursor = blockToOperationId(100000000);
    expect(computeCatchupLowerBound(HEAD, ancientCursor)).toBe(windowStart);
  });

  it('respects a custom window size', () => {
    const windowStart = blockToOperationId(HEAD - BigInt(100));
    expect(computeCatchupLowerBound(HEAD, BigInt(0), 100)).toBe(windowStart);
  });
});
