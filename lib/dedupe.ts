// Layer-1 publish dedupe — chain-content key (HIVESQL-HA-PLAN.md §6).
//
// The same on-chain transfer must produce a byte-identical key no matter
// which source (HAFSQL, HiveSQL) delivered it, so the key is built ONLY from
// chain-truth fields — never from source row ids. block_num makes the key
// airtight: the same op always collides, two different ops never do
// (identical content in different blocks → different keys; identical content
// in the same block is impossible for orders — the distriate memo suffix is
// unique per order by construction).
//
// Pure module (node:crypto only) so tests import it without env vars.

import { createHash } from 'crypto';

/**
 * Canonical amount: both sources must render the same digits. HAFSQL delivers
 * amounts as strings ("4.014"); HiveSQL's `money` column arrives as a JS
 * number (4.014). 8 decimals covers Hive-Engine token precision; HBD's 3
 * decimals round-trip exactly through a double at these magnitudes.
 */
export function canonicalAmount(amount: string | number): string {
  return Number(amount).toFixed(8);
}

/**
 * Content key for a transfer. Verified live 2026-07-11: 12/12 HBD transfers
 * over 7 days produced identical keys from HAFSQL and HiveSQL
 * (scripts/hivesql-health.mjs parity mode).
 */
export function computeDedupeKey(
  blockNum: number | string | bigint | undefined,
  fromAccount: string,
  toAccount: string,
  amount: string | number,
  symbol: string,
  memo: string
): string {
  const material = `${blockNum ?? ''}|${fromAccount}|${toAccount}|${canonicalAmount(amount)}|${symbol}|${memo}`;
  // 16 bytes of sha256 — collision-safe at any realistic transfer volume
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}
