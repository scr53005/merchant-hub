#!/usr/bin/env node

// HAFSQL health probe for merchant-hub.
// Checks the two failure modes of the 2026-07-10 provider degradation:
//   1. Grants: hafsql.* convenience views lost public SELECT after a server
//      migration (haf_blocks, dynamic_global_properties, operation_custom_json_view).
//   2. Latency: 40-50s PER STATEMENT, even SELECT 1 (PgBouncer queuing).
// Also probes every relation the pollers actually use, so a green run here
// means merchant-hub polling should be healthy.
//
// Usage:
//   node scripts/hafsql-health.mjs
//
// Environment:
//   Reads HAF_CONNECTION_STRING from .env.local (or environment)

import { readFileSync } from 'fs';
import { resolve } from 'path';
import pg from 'pg';

// ── Minimal .env.local loader (same pattern as redis-cleanup.mjs) ──────────

function loadEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // File absent is fine — env vars may come from the environment
  }
}

loadEnvFile(resolve(process.cwd(), '.env.local'));

const connectionString = process.env.HAF_CONNECTION_STRING;
if (!connectionString) {
  console.error('HAF_CONNECTION_STRING not set (checked .env.local and environment)');
  process.exit(1);
}

// ── Probes ──────────────────────────────────────────────────────────────────

// Each probe is one statement; we time it individually because the July 2026
// degradation queued statements one-by-one (~45s each) regardless of cost.
const PROBES = [
  // Baseline latency — no table access, isolates connection/queue delay
  { name: 'SELECT 1 (latency baseline)', sql: 'SELECT 1' },

  // Views that LOST grants on 2026-07-10 (permission denied)
  // SELECT * so the probe doubles as a schema check — the 2026-07 backup
  // server exposes this view with different columns than the primary did
  { name: 'hafsql.haf_blocks (grants regression)', sql: 'SELECT * FROM hafsql.haf_blocks LIMIT 1' },
  { name: 'hafsql.dynamic_global_properties (grants regression)', sql: 'SELECT block_num FROM hafsql.dynamic_global_properties ORDER BY timestamp DESC LIMIT 1' },
  { name: 'hafsql.operation_custom_json_view (grants regression)', sql: 'SELECT id FROM hafsql.operation_custom_json_view LIMIT 1' },

  // Relations the pollers use TODAY (grants-proof rewrite)
  { name: 'hafsql.operation_transfer_table (HBD poller)', sql: 'SELECT id FROM hafsql.operation_transfer_table ORDER BY id DESC LIMIT 1' },
  { name: 'hafd.blocks (HE head block)', sql: 'SELECT num FROM hafd.blocks ORDER BY num DESC LIMIT 1' },
  // hive.operations_view probed with the same id-range pattern as the poller;
  // lower bound is computed from the head block fetched by the hafd.blocks probe
  { name: 'hive.operations_view id-range (HE poller)', sql: null /* built at runtime */ },
];

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function main() {
  // No ssl option — matches lib/haf-polling.ts's Pool exactly (the HAFSQL
  // server rejects SSL handshakes; pg only uses SSL if asked)
  const client = new pg.Client({
    connectionString,
    query_timeout: 90000,
    connectionTimeoutMillis: 90000,
  });

  const t0 = Date.now();
  process.stdout.write('Connecting... ');
  await client.connect();
  console.log(`ok (${fmtMs(Date.now() - t0)})`);

  let headBlock = null;
  let maxTransferId = null;
  let failures = 0;

  for (const probe of PROBES) {
    let sql = probe.sql;
    if (sql === null) {
      if (headBlock === null) {
        console.log(`SKIP  ${probe.name} — no head block from hafd.blocks probe`);
        continue;
      }
      // Same shape as the HE poller: id-range bound hits the PK index
      const lowerBound = (BigInt(headBlock) - BigInt(100)) << BigInt(32);
      sql = `SELECT o.id FROM hive.operations_view o WHERE o.op_type_id = 18 AND o.id > ${lowerBound.toString()} ORDER BY o.id DESC LIMIT 1`;
    }

    const start = Date.now();
    try {
      const res = await client.query(sql);
      const ms = Date.now() - start;
      const slow = ms > 5000 ? '  ⚠ SLOW' : '';
      const val = res.rows[0] ? JSON.stringify(res.rows[0]) : '(no rows)';
      console.log(`OK    ${probe.name} — ${fmtMs(ms)}${slow}  ${val}`);
      if (probe.name.startsWith('hafd.blocks')) headBlock = res.rows[0]?.num;
      if (probe.name.startsWith('hafsql.operation_transfer_table')) maxTransferId = res.rows[0]?.id;
    } catch (err) {
      failures++;
      console.log(`FAIL  ${probe.name} — ${fmtMs(Date.now() - start)}  ${err.message}`);
    }
  }

  await client.end();

  // Sync-lag check: operation_transfer_table's newest row should be at most a
  // few blocks behind head (Hive has transfers in nearly every block). A big
  // lag means the table's indexer is frozen — the HBD poller would silently
  // see "no new transfers" even though grants and latency look fine.
  if (headBlock !== null && maxTransferId !== null) {
    const lastTransferBlock = BigInt(maxTransferId) >> BigInt(32);
    const lagBlocks = BigInt(headBlock) - lastTransferBlock;
    const lagHours = (Number(lagBlocks) * 3 / 3600).toFixed(1);
    const verdict = lagBlocks > BigInt(100) ? '⚠ TABLE APPEARS FROZEN' : 'ok';
    console.log(`\nSync lag: operation_transfer_table newest row = block ${lastTransferBlock}, head = ${headBlock} → ${lagBlocks} blocks (~${lagHours}h) behind — ${verdict}`);
    if (lagBlocks > BigInt(100)) failures++;
  }

  console.log(failures === 0
    ? '\nAll probes passed.'
    : `\n${failures} probe(s) failed.`);
  process.exit(failures === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
