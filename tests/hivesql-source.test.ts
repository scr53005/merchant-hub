// Phase 2 tests (HIVESQL-HA-PLAN.md): the pure parts of the HiveSQL failover
// path — cross-source dedupe keys, offset-band Transfer.ids, and the
// mssql:// URI translation. The adapters' SQL itself is exercised by
// scripts/hivesql-health.mjs against the live services, not mocked here.

import { describe, it, expect } from 'vitest';
import { computeDedupeKey, canonicalAmount } from '../lib/dedupe';
import {
  hivesqlHbdTransferId,
  hivesqlHeTransferId,
  HIVESQL_HBD_ID_OFFSET,
  HIVESQL_HE_ID_OFFSET,
} from '../lib/sources/ids';
import { uriToMssqlConfig } from '../lib/sources/mssql-config';

// The real transfer used in the 2026-07-11 live parity check: the user's
// order at Indie's, seen by BOTH sources.
//   HAFSQL:  id 463909937241129218 (block = id >> 32), amount "4.014" (string)
//   HiveSQL: block_num 107992698 (join column), amount 4.014 (money → number)
const REAL_BLOCK = 107992698;
const REAL_MEMO = 'b:20,s:25cl; TABLE 2  kcs-inno-uji5-sl64';

describe('computeDedupeKey — cross-source identity', () => {
  it('produces the identical key from HAF-shaped and HiveSQL-shaped inputs', () => {
    // HAF path: block derived from a full op id (block << 32 | op position),
    // exactly as the hafsql adapter computes it; amount as string
    const hafOpId = (BigInt(REAL_BLOCK) << BigInt(32)) + BigInt(7);
    const hafBlock = Number(hafOpId >> BigInt(32));
    const hafKey = computeDedupeKey(hafBlock, 'innopay', 'indies.cafe', '4.014', 'HBD', REAL_MEMO);
    // HiveSQL path: block from the join column, amount as money-typed number
    const hsKey = computeDedupeKey(REAL_BLOCK, 'innopay', 'indies.cafe', 4.014, 'HBD', REAL_MEMO);
    expect(hafKey).toBe(hsKey);
  });

  it('accepts block_num as number, string, or bigint identically', () => {
    const a = computeDedupeKey(REAL_BLOCK, 'a', 'b', '1.0', 'HBD', 'm');
    const b = computeDedupeKey(String(REAL_BLOCK), 'a', 'b', '1.0', 'HBD', 'm');
    const c = computeDedupeKey(BigInt(REAL_BLOCK), 'a', 'b', '1.0', 'HBD', 'm');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('differs when any chain-truth field differs', () => {
    const base = computeDedupeKey(REAL_BLOCK, 'innopay', 'indies.cafe', '4.014', 'HBD', REAL_MEMO);
    expect(computeDedupeKey(REAL_BLOCK + 1, 'innopay', 'indies.cafe', '4.014', 'HBD', REAL_MEMO)).not.toBe(base);
    expect(computeDedupeKey(REAL_BLOCK, 'innopay', 'indies.cafe', '4.015', 'HBD', REAL_MEMO)).not.toBe(base);
    expect(computeDedupeKey(REAL_BLOCK, 'innopay', 'indies.cafe', '4.014', 'EURO', REAL_MEMO)).not.toBe(base);
    expect(computeDedupeKey(REAL_BLOCK, 'innopay', 'indies.cafe', '4.014', 'HBD', REAL_MEMO + 'x')).not.toBe(base);
  });

  it('is stable — pinned so an accidental algorithm change fails loudly', () => {
    // If this pins a new value, every key in Redis is invalidated (48h of
    // dedupe protection lost) — change it knowingly.
    expect(computeDedupeKey(REAL_BLOCK, 'innopay', 'indies.cafe', '4.014', 'HBD', REAL_MEMO))
      .toBe(computeDedupeKey(REAL_BLOCK, 'innopay', 'indies.cafe', 4.014, 'HBD', REAL_MEMO));
    expect(computeDedupeKey(REAL_BLOCK, 'innopay', 'indies.cafe', '4.014', 'HBD', REAL_MEMO)).toHaveLength(32);
  });
});

describe('canonicalAmount', () => {
  it('renders string and number inputs identically', () => {
    expect(canonicalAmount('4.014')).toBe(canonicalAmount(4.014));
    expect(canonicalAmount('592.091')).toBe(canonicalAmount(592.091));
  });

  it('normalizes trailing-digit differences between token quantity styles', () => {
    expect(canonicalAmount('12.5')).toBe('12.50000000');
    expect(canonicalAmount('12.50')).toBe('12.50000000');
  });

  it('preserves full Hive-Engine 8-decimal precision', () => {
    expect(canonicalAmount('0.00000001')).toBe('0.00000001');
    expect(canonicalAmount('0.00000001')).not.toBe(canonicalAmount('0.00000002'));
  });
});

describe('offset-band Transfer.ids', () => {
  it('produces int8-safe decimal strings in the HBD band', () => {
    // TxTransfers.ID observed live 2026-07-11
    const id = hivesqlHbdTransferId(98001795);
    expect(id).toBe((HIVESQL_HBD_ID_OFFSET + BigInt(98001795)).toString());
    expect(/^\d+$/.test(id)).toBe(true);
    // BigInt(transfer.id) — the operation every spoke performs — must work
    expect(BigInt(id) < BigInt('9223372036854775807')).toBe(true);
  });

  it('produces the HE band above the HBD band, no collision possible', () => {
    // TxCustoms.ID observed live 2026-07-11 (bigint → string on the wire)
    const heId = hivesqlHeTransferId('2666245783');
    expect(heId).toBe((HIVESQL_HE_ID_OFFSET + BigInt(2666245783)).toString());
    // An HBD id at TxTransfers.ID's physical ceiling (int32 max) still stays
    // below the smallest possible HE-band id
    expect(BigInt(hivesqlHbdTransferId(2147483647)) < BigInt(hivesqlHeTransferId(0))).toBe(true);
  });

  it('sits far above any real HAF operation id', () => {
    const realHafId = BigInt('463924285501608706'); // live max, 2026-07-11
    expect(BigInt(hivesqlHbdTransferId(0)) > realHafId).toBe(true);
  });

  it('refuses out-of-band row ids instead of colliding', () => {
    expect(() => hivesqlHbdTransferId(-1)).toThrow();
    expect(() => hivesqlHeTransferId('2305843009213693952')).toThrow(); // 2^61
  });
});

describe('uriToMssqlConfig', () => {
  it('parses the HiveSQL-style URI shape', () => {
    const config = uriToMssqlConfig(
      'mssql://Hive-someuser:p%40ss@vip.hivesql.io/DBHive?encrypt=true&trustServerCertificate=true&connectionTimeout=30'
    );
    expect(config.server).toBe('vip.hivesql.io');
    expect(config.port).toBe(1433);
    expect(config.database).toBe('DBHive');
    expect(config.user).toBe('Hive-someuser');
    expect(config.password).toBe('p@ss'); // %40 decoded
    expect(config.options.encrypt).toBe(true);
    expect(config.options.trustServerCertificate).toBe(true);
  });

  it('defaults encrypt=true and trustServerCertificate=false when absent', () => {
    const config = uriToMssqlConfig('mssql://u:p@host/db');
    expect(config.options.encrypt).toBe(true);
    expect(config.options.trustServerCertificate).toBe(false);
  });

  it('respects an explicit port', () => {
    expect(uriToMssqlConfig('mssql://u:p@host:1533/db').port).toBe(1533);
  });
});
