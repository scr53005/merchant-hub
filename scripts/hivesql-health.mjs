#!/usr/bin/env node

// HiveSQL (MS SQL, @arcange, vip.hivesql.io) probe — Phase 0 of HIVESQL-HA-PLAN.md.
// The MS_CONNECTION_STRING credentials have never been exercised from code;
// this script proves them and verifies the schema assumptions the T-SQL
// sketches in the plan were written from (memory, not documentation).
//
// Usage:
//   node scripts/hivesql-health.mjs           # latency + schema discovery + samples
//   node scripts/hivesql-health.mjs probe     # freshness/head-block probes (after schema is known)
//   node scripts/hivesql-health.mjs parity    # HAFSQL vs HiveSQL: same window, same dedupe keys?
//
// Environment:
//   HIVESQL_CONNECTION_STRING from .env.local, or falls back to
//   ../indiesmenu/.env MS_CONNECTION_STRING (same service, local convenience).

import { readFileSync } from 'fs';
import { resolve } from 'path';
import sql from 'mssql';

// ── Minimal .env loader (same pattern as redis-cleanup.mjs) ────────────────

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
    // absent file is fine
  }
}

loadEnvFile(resolve(process.cwd(), '.env.local'));

let connectionString = process.env.HIVESQL_CONNECTION_STRING;
if (!connectionString) {
  // Fallback: the credentials currently live only in indiesmenu's env
  const indiesEnv = resolve(process.cwd(), '../indiesmenu/.env');
  const saved = { ...process.env };
  loadEnvFile(indiesEnv);
  connectionString = process.env.MS_CONNECTION_STRING;
  if (connectionString) {
    console.log(`(using MS_CONNECTION_STRING from ${indiesEnv})`);
  }
  process.env = saved;
}
if (!connectionString) {
  console.error('No HIVESQL_CONNECTION_STRING (.env.local) or MS_CONNECTION_STRING (../indiesmenu/.env) found');
  process.exit(1);
}

// Tables the HA plan's T-SQL sketches assume (names TO BE VERIFIED — that is
// the point of this script)
const TABLES_OF_INTEREST = ['Blocks', 'Transactions', 'TxTransfers', 'TxCustoms'];

/**
 * The `mssql` package does NOT parse `mssql://` URIs (only ADO.NET-style
 * strings / config objects) — Phase 0 finding, the Phase 2 adapter needs this
 * same translation. URL-decodes each part so special chars in the password
 * survive.
 */
function uriToMssqlConfig(uri) {
  const u = new URL(uri);
  return {
    server: u.hostname,
    port: u.port ? Number(u.port) : 1433,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    options: {
      encrypt: u.searchParams.get('encrypt') !== 'false',
      trustServerCertificate: u.searchParams.get('trustServerCertificate') === 'true',
    },
    connectionTimeout: 30000,
    requestTimeout: 60000,
    pool: { max: 2, min: 0 },
  };
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function timed(pool, name, query) {
  const start = Date.now();
  try {
    const res = await pool.request().query(query);
    const ms = Date.now() - start;
    return { ok: true, ms, rows: res.recordset ?? [] };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

async function main() {
  const mode = process.argv[2] || 'schema';

  const t0 = Date.now();
  process.stdout.write('Connecting... ');
  const pool = await sql.connect(uriToMssqlConfig(connectionString));
  console.log(`ok (${fmtMs(Date.now() - t0)})`);

  // Latency baseline — isolates connection/queue delay from query cost
  const ping = await timed(pool, 'ping', 'SELECT 1 AS one');
  console.log(ping.ok
    ? `OK    SELECT 1 — ${fmtMs(ping.ms)}`
    : `FAIL  SELECT 1 — ${ping.error}`);

  console.log(`Server database: ${(await timed(pool, 'db', 'SELECT DB_NAME() AS db')).rows?.[0]?.db}`);

  if (mode === 'schema') {
    // 1. What tables exist at all?
    const tables = await timed(pool, 'tables',
      `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`);
    if (!tables.ok) {
      console.log(`FAIL  INFORMATION_SCHEMA.TABLES — ${tables.error}`);
    } else {
      console.log(`\n═══ Tables/views visible (${tables.rows.length}) — ${fmtMs(tables.ms)} ═══`);
      for (const r of tables.rows) console.log(`  ${r.TABLE_SCHEMA}.${r.TABLE_NAME}`);
    }

    // 2. Columns of the tables the plan assumes
    const cols = await timed(pool, 'columns',
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME IN ('${TABLES_OF_INTEREST.join("','")}')
       ORDER BY TABLE_NAME, ORDINAL_POSITION`);
    if (cols.ok && cols.rows.length > 0) {
      console.log(`\n═══ Columns of tables the plan assumes — ${fmtMs(cols.ms)} ═══`);
      let current = '';
      for (const r of cols.rows) {
        if (r.TABLE_NAME !== current) {
          current = r.TABLE_NAME;
          console.log(`\n  ${current}:`);
        }
        const len = r.CHARACTER_MAXIMUM_LENGTH ? `(${r.CHARACTER_MAXIMUM_LENGTH})` : '';
        console.log(`    ${r.COLUMN_NAME}  ${r.DATA_TYPE}${len}`);
      }
    } else {
      console.log(`\nNo columns found for ${TABLES_OF_INTEREST.join(', ')} — table names differ; see the table list above`);
    }
  }

  if (mode === 'probe') {
    // Freshness probes — adjust after the schema run has confirmed names.
    const probes = [
      ['head block', `SELECT TOP 1 block_num, timestamp FROM Blocks ORDER BY block_num DESC`],
      ['newest HBD transfer', `SELECT TOP 1 ID, tx_id, [from], [to], amount, amount_symbol, memo, timestamp
                               FROM TxTransfers WHERE amount_symbol = 'HBD' ORDER BY ID DESC`],
      ['newest ssc-mainnet-hive custom_json', `SELECT TOP 1 ID, tx_id, tid, timestamp
                               FROM TxCustoms WHERE tid = 'ssc-mainnet-hive' ORDER BY ID DESC`],
      // Join integrity: TxTransfers.tx_id is bigint with values above int32 max
      // while INFORMATION_SCHEMA claims Transactions.tx_id is int — verify the
      // join actually resolves a block_num for a current row
      ['block_num via join (newest HBD)', `SELECT TOP 1 tt.ID, tt.tx_id, t.block_num, tt.timestamp
                               FROM TxTransfers tt JOIN Transactions t ON t.tx_id = tt.tx_id
                               WHERE tt.amount_symbol = 'HBD' ORDER BY tt.ID DESC`],
      // The actual candidate poller query: account-filtered, cursor by block_num
      ['candidate poller query (indies.cafe, last ~7 days)', `SELECT TOP 100 tt.ID, t.block_num, tt.[from], tt.[to], tt.amount, tt.amount_symbol, tt.memo, tt.timestamp
                               FROM TxTransfers tt JOIN Transactions t ON t.tx_id = tt.tx_id
                               WHERE tt.[to] IN ('indies.cafe', 'millewee', 'croque.bedaine', 'zenbar')
                                 AND tt.amount_symbol = 'HBD'
                                 AND t.block_num > (SELECT MAX(block_num) - 201600 FROM Blocks)
                               ORDER BY t.block_num DESC`],
    ];
    for (const [name, query] of probes) {
      const r = await timed(pool, name, query);
      printProbe(name, r);
    }
  }

  if (mode === 'parity') {
    await runParity(pool);
  }

  if (mode === 'parity-he') {
    await runParityHiveEngine(pool);
  }

  await pool.close();
}

// ── Hive-Engine parity: custom_json payload round-trip ─────────────────────
// The HE poller parses required_auths (sender) + json (the token transfer).
// Verify HiveSQL's TxCustoms delivers byte-identical payloads to HAF's
// hive.operations_view over the same small block window.

async function runParityHiveEngine(mssqlPool) {
  const { default: pg } = await import('pg');
  const haf = new pg.Client({ connectionString: process.env.HAF_CONNECTION_STRING, query_timeout: 90000 });
  await haf.connect();

  // HiveSQL first: a block-range filter on the TxCustoms join TIMES OUT (>60s,
  // no usable index — verified 2026-07-11), while tid + ORDER BY ID DESC is
  // ~30ms. Adapter consequence: on HiveSQL the HE cursor must be TxCustoms.ID,
  // never a block range. So fetch newest N here, derive the block window from
  // what came back, and query HAF for that window.
  const hsAll = (await mssqlPool.request().query(
    `SELECT TOP 400 tc.ID, t.block_num, tc.required_auths, tc.json
     FROM TxCustoms tc JOIN Transactions t ON t.tx_id = tc.tx_id
     WHERE tc.tid = 'ssc-mainnet-hive'
     ORDER BY tc.ID DESC`
  )).recordset;
  if (hsAll.length === 0) {
    console.log('HiveSQL returned no ssc-mainnet-hive rows — cannot compare');
    await haf.end();
    return;
  }
  const blocks = hsAll.map((r) => BigInt(r.block_num));
  const hsMin = blocks.reduce((a, b) => (b < a ? b : a));
  const hsMax = blocks.reduce((a, b) => (b > a ? b : a));
  // Interior window only: the newest and oldest blocks in the TOP-N slice may
  // be partially covered, which would show as false mismatches
  const startBlock = hsMin + BigInt(1);
  const endBlock = hsMax - BigInt(1);
  const hsRows = hsAll.filter((r) => BigInt(r.block_num) >= startBlock && BigInt(r.block_num) <= endBlock);
  console.log(`\nHE window (derived from HiveSQL TOP 400): blocks ${startBlock} .. ${endBlock}`);

  const hafRows = (await haf.query(
    `SELECT o.id, o.block_num,
            o.body->'value'->'required_auths' AS required_auths,
            o.body->'value'->>'json' AS json
     FROM hive.operations_view o
     WHERE o.op_type_id = 18
       AND o.body->'value'->>'id' = 'ssc-mainnet-hive'
       AND o.id >= $1 AND o.id < $2
     ORDER BY o.id DESC LIMIT 2000`,
    [(startBlock << BigInt(32)).toString(), ((endBlock + BigInt(1)) << BigInt(32)).toString()]
  )).rows;
  await haf.end();

  console.log(`HAF rows: ${hafRows.length}   HiveSQL rows: ${hsRows.length}`);
  if (hafRows[0]) {
    console.log(`HAF sample:     auths=${JSON.stringify(hafRows[0].required_auths)} json=${String(hafRows[0].json).slice(0, 120)}`);
  }
  if (hsRows[0]) {
    console.log(`HiveSQL sample: auths=${JSON.stringify(hsRows[0].required_auths)} json=${String(hsRows[0].json).slice(0, 120)}`);
  }

  // Key on block|json — auths format may differ (jsonb array vs varchar), shown above
  const norm = (s) => String(s).replace(/\s+/g, '');
  const hafSet = new Set(hafRows.map((r) => `${r.block_num}|${norm(r.json)}`));
  const hsSet = new Set(hsRows.map((r) => `${r.block_num}|${norm(r.json)}`));
  const onlyHaf = [...hafSet].filter((k) => !hsSet.has(k));
  const onlyHs = [...hsSet].filter((k) => !hafSet.has(k));
  console.log(onlyHaf.length === 0 && onlyHs.length === 0
    ? 'HE PARITY OK — identical block|json payload sets from both sources.'
    : `HE PARITY MISMATCH — onlyHAF=${onlyHaf.length} onlyHiveSQL=${onlyHs.length}\n  HAF: ${onlyHaf.slice(0, 3).join('\n  ')}\n  HS: ${onlyHs.slice(0, 3).join('\n  ')}`);
}

// ── Parity: HAFSQL vs HiveSQL over the same block window ───────────────────
// The Layer-1 dedupe key (HIVESQL-HA-PLAN.md §6) only works if both sources
// produce byte-identical keys for the same on-chain transfer. Canonicalization
// rules under test: amount → Number(x).toFixed(3) (HAF returns strings,
// HiveSQL `money` returns JS numbers), memo → verbatim, block_num → HAF id>>32
// vs HiveSQL join column.

const PARITY_ACCOUNTS = ['indies.cafe', 'millewee', 'croque.bedaine', 'zenbar', 'croque.demo'];
const PARITY_WINDOW_BLOCKS = 201600; // ~7 days

function dedupeKey(blockNum, from, to, amount, symbol, memo) {
  return `${blockNum}|${from}|${to}|${Number(amount).toFixed(3)}|${symbol}|${memo}`;
}

async function runParity(mssqlPool) {
  const { default: pg } = await import('pg');
  const hafConn = process.env.HAF_CONNECTION_STRING;
  if (!hafConn) {
    console.error('HAF_CONNECTION_STRING not set — cannot run parity');
    return;
  }
  const haf = new pg.Client({ connectionString: hafConn, query_timeout: 90000 });
  await haf.connect();

  // Window anchored on HAF's head so both sides use identical bounds
  const headRes = await haf.query('SELECT num FROM hafd.blocks ORDER BY num DESC LIMIT 1');
  const head = BigInt(headRes.rows[0].num);
  const startBlock = head - BigInt(PARITY_WINDOW_BLOCKS);
  console.log(`\nWindow: blocks ${startBlock} .. ${head} (~7 days), accounts: ${PARITY_ACCOUNTS.join(', ')}`);

  // HAF side — block via id >> 32, no join needed
  const hafRows = (await haf.query(
    `SELECT id, from_account, to_account, amount, symbol, memo
     FROM hafsql.operation_transfer_table
     WHERE to_account = ANY($1) AND symbol = 'HBD' AND id > $2
     ORDER BY id DESC LIMIT 1000`,
    [PARITY_ACCOUNTS, (startBlock << BigInt(32)).toString()]
  )).rows;
  await haf.end();

  // HiveSQL side — block via Transactions join
  const inList = PARITY_ACCOUNTS.map((a) => `'${a}'`).join(',');
  const hsRows = (await mssqlPool.request().query(
    `SELECT TOP 1000 tt.ID, t.block_num, tt.type, tt.[from], tt.[to], tt.amount, tt.amount_symbol, tt.memo
     FROM TxTransfers tt JOIN Transactions t ON t.tx_id = tt.tx_id
     WHERE tt.[to] IN (${inList}) AND tt.amount_symbol = 'HBD' AND t.block_num > ${startBlock}
       AND tt.type = 'transfer'
     ORDER BY t.block_num DESC`
    // type filter: TxTransfers folds savings/escrow ops into the same table
    // (type, request_id columns); HAF's operation_transfer_table holds ONLY
    // plain transfer_operation. Without it, savings sweeps appear as phantom
    // orders. Verified 2026-07-11: the only parity diff was transfer_to_savings.
  )).recordset;

  const hafKeys = new Map(hafRows.map((r) => [
    dedupeKey(BigInt(r.id) >> BigInt(32), r.from_account, r.to_account, r.amount, r.symbol, r.memo), r,
  ]));
  const hsKeys = new Map(hsRows.map((r) => [
    dedupeKey(BigInt(r.block_num), r.from, r.to, r.amount, r.amount_symbol, r.memo), r,
  ]));

  console.log(`HAFSQL rows: ${hafKeys.size}   HiveSQL rows: ${hsKeys.size}`);
  const onlyHaf = [...hafKeys.keys()].filter((k) => !hsKeys.has(k));
  const onlyHs = [...hsKeys.keys()].filter((k) => !hafKeys.has(k));
  if (onlyHaf.length === 0 && onlyHs.length === 0) {
    console.log('PARITY OK — every transfer produces the identical dedupe key from both sources.');
    const sample = [...hafKeys.keys()][0];
    if (sample) console.log(`Sample key: ${sample}`);
  } else {
    console.log(`\nPARITY MISMATCH — keys only in HAFSQL (${onlyHaf.length}):`);
    for (const k of onlyHaf.slice(0, 10)) console.log(`  ${k}`);
    console.log(`Keys only in HiveSQL (${onlyHs.length}):`);
    for (const k of onlyHs.slice(0, 10)) console.log(`  ${k}  [type=${hsKeys.get(k)?.type}]`);
  }
}

function printProbe(name, r) {
  console.log(r.ok
    ? `OK    ${name} — ${fmtMs(r.ms)}  ${JSON.stringify(r.rows[0] ?? null)}`
    : `FAIL  ${name} — ${fmtMs(r.ms)}  ${r.error}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
