#!/usr/bin/env node

// Redis stream cleanup utility for merchant-hub.
// Performs safe, reversible operations on Upstash Redis streams.
//
// Usage:
//   node scripts/redis-cleanup.mjs [command] [args...]
//
// Commands:
//   list-groups                          List all consumer groups for all restaurant streams
//   destroy-group <stream> <group>       Destroy a specific consumer group
//   destroy-legacy-groups                Destroy groups on old shared streams (pre env-split)
//   poller-status                         Show current poller info (who, heartbeat age)
//   clear-poller                          Kill zombie poller lock so next CO page can take over
//   state-dump                            Dump polling:state hash with per-cursor diagnosis
//   set-cursor <account:CUR> <id>         Set a lastId cursor (e.g. set-cursor indies.cafe:HBD 463839730480448002)
//   set-source <hafsql|hivesql|auto>      Force the polling data source (raw write; prefer the dashboard toggle)
//
// Environment:
//   Reads KV_REST_API_URL and KV_REST_API_TOKEN from .env.local (or environment)

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Minimal .env.local loader ──────────────────────────────────────────────

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
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env.local doesn't exist — rely on environment variables
  }
}

loadEnvFile(resolve(process.cwd(), '.env.local'));
loadEnvFile(resolve(process.cwd(), '.env.example'));

// ── Redis helper ───────────────────────────────────────────────────────────

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

if (!KV_URL || !KV_TOKEN) {
  console.error('Missing KV_REST_API_URL or KV_REST_API_TOKEN. Set them in .env.local or environment.');
  process.exit(1);
}

async function execRedis(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error: ${text}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ── Hash reply parsing ─────────────────────────────────────────────────────
// The Upstash REST API returns HGETALL as a flat [field, value, ...] array
// (some surfaces return an object). Values are kept as verbatim strings —
// cursors are 64-bit HAF ids that a JS number cannot represent exactly.

function parseHgetall(reply) {
  const obj = {};
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) obj[String(reply[i])] = String(reply[i + 1]);
  } else if (reply && typeof reply === 'object') {
    for (const [k, v] of Object.entries(reply)) {
      if (v !== null && v !== undefined) obj[k] = String(v);
    }
  }
  return obj;
}

// ── Stream discovery ───────────────────────────────────────────────────────
// We discover streams dynamically via SCAN instead of hardcoding, so the script
// stays correct as new spokes are added and catches orphaned streams that no
// longer correspond to any restaurant in config.ts.

// Current stream pattern: `transfers:{restaurantId}:{prod|dev}` (post env-split).
// Legacy stream pattern:  `transfers:{restaurantId}` (pre env-split, pre-April 2026).
async function discoverTransferStreams() {
  const active = []; // { stream, restaurantId, env }
  const legacy = []; // { stream, restaurantId }
  let cursor = '0';

  do {
    // Upstash SCAN: [cursor, [keys...]]
    const result = await execRedis(['SCAN', cursor, 'MATCH', 'transfers:*', 'COUNT', '100']);
    cursor = result[0];
    const keys = result[1] || [];

    for (const key of keys) {
      // Verify TYPE — SCAN MATCH doesn't filter by type, so guard against accidental
      // non-stream keys sharing the prefix.
      const type = await execRedis(['TYPE', key]);
      if (type !== 'stream') continue;

      const parts = key.split(':');
      // transfers:{id}:{env} → parts.length === 3
      // transfers:{id}       → parts.length === 2
      if (parts.length === 3 && (parts[2] === 'prod' || parts[2] === 'dev')) {
        active.push({ stream: key, restaurantId: parts[1], env: parts[2] });
      } else if (parts.length === 2) {
        legacy.push({ stream: key, restaurantId: parts[1] });
      }
      // Anything else is an unrecognised shape — skip silently.
    }
  } while (cursor !== '0');

  // Stable ordering for readable output
  active.sort((a, b) => (a.stream < b.stream ? -1 : 1));
  legacy.sort((a, b) => (a.stream < b.stream ? -1 : 1));
  return { active, legacy };
}

// ── Commands ───────────────────────────────────────────────────────────────

async function countUndelivered(stream, lastDeliveredId, streamLength) {
  if (!lastDeliveredId || lastDeliveredId === '0' || lastDeliveredId === '0-0') {
    return streamLength;
  }
  try {
    const parts = lastDeliveredId.split('-');
    const exclusiveStart = `${parts[0]}-${parseInt(parts[1] || '0') + 1}`;
    const entries = await execRedis(['XRANGE', stream, exclusiveStart, '+']);
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return 0;
  }
}

async function printStreamInfo(stream) {
  console.log(`\n--- ${stream} ---`);
  try {
    const len = await execRedis(['XLEN', stream]);
    console.log(`  Length: ${len}`);
    const groups = await execRedis(['XINFO', 'GROUPS', stream]);
    if (!groups || groups.length === 0) {
      console.log('  No consumer groups');
      return;
    }
    for (const g of groups) {
      // Upstash returns objects directly
      const name = g.name || g[1];
      const consumers = g.consumers ?? g[3];
      const lastId = g['last-delivered-id'] || g[7] || '0';
      const undelivered = await countUndelivered(stream, lastId, len);
      console.log(`  Group: ${name}  |  consumers: ${consumers}  |  undelivered: ${undelivered}  |  lastDeliveredId: ${lastId}`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

async function listGroups() {
  const { active, legacy } = await discoverTransferStreams();

  if (active.length === 0 && legacy.length === 0) {
    console.log('\nNo transfer streams found in Redis.');
    return;
  }

  if (active.length > 0) {
    console.log('\n═══ Active streams (env-split) ═══');
    for (const { stream } of active) await printStreamInfo(stream);
  }

  if (legacy.length > 0) {
    console.log('\n═══ Legacy streams (pre env-split — candidates for cleanup) ═══');
    for (const { stream } of legacy) await printStreamInfo(stream);
  }
}

async function destroyGroup(stream, group) {
  console.log(`Destroying consumer group "${group}" on stream "${stream}"...`);
  try {
    const result = await execRedis(['XGROUP', 'DESTROY', stream, group]);
    if (result === 1) {
      console.log(`  OK — group "${group}" destroyed.`);
    } else {
      console.log(`  Group "${group}" did not exist (already destroyed?).`);
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
}

async function destroyLegacyGroups() {
  console.log('Discovering legacy streams (pre env-split)...\n');
  const { legacy } = await discoverTransferStreams();

  if (legacy.length === 0) {
    console.log('No legacy streams found — nothing to clean up.');
    return;
  }

  for (const { stream } of legacy) {
    console.log(`\nLegacy stream: ${stream}`);
    try {
      const groups = await execRedis(['XINFO', 'GROUPS', stream]);
      if (!groups || groups.length === 0) {
        console.log('  No consumer groups — nothing to destroy.');
        continue;
      }
      for (const g of groups) {
        const name = g.name || g[1];
        await destroyGroup(stream, name);
      }
    } catch (err) {
      console.error(`  Failed to list groups: ${err.message}`);
    }
  }

  console.log('\nDone. Run "list-groups" to verify.');
}

async function pollerStatus() {
  try {
    const state = parseHgetall(await execRedis(['HGETALL', 'polling:state']));
    const heartbeat = state?.heartbeat ? parseInt(state.heartbeat) : null;
    const poller = state?.poller || null;
    const mode = state?.mode || null;
    const age = heartbeat ? `${((Date.now() - heartbeat) / 1000).toFixed(1)}s ago` : 'never';

    console.log(`\n  Poller:    ${poller || '(none)'}`);
    console.log(`  Mode:      ${mode || '(none)'}`);
    console.log(`  Heartbeat: ${age}`);

    // Also check the separate poller lock key (has TTL)
    const lockTTL = await execRedis(['TTL', 'polling:poller']);
    console.log(`  Lock TTL:  ${lockTTL > 0 ? `${lockTTL}s remaining` : 'expired'}`);
  } catch (err) {
    console.error(`  Error: ${err.message}`);
  }
}

async function clearPoller() {
  console.log('Clearing poller lock and heartbeat...\n');
  try {
    // Delete the separate poller lock key
    const delResult = await execRedis(['DEL', 'polling:poller']);
    console.log(`  polling:poller key: ${delResult ? 'deleted' : 'already gone'}`);

    // Clear poller and heartbeat from the state hash
    await execRedis(['HDEL', 'polling:state', 'poller', 'heartbeat']);
    console.log('  polling:state poller+heartbeat: cleared');

    console.log('\nDone. Next CO page to open will claim the poller role.');
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
}

// ── Polling state inspection / repair ──────────────────────────────────────

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 9007199254740991
const CURSOR_CEILING = BigInt('10000000000000000000'); // 10^19
// Non-cursor fields in the polling:state hash (everything else is {account}:{currency})
const META_FIELDS = new Set([
  'heartbeat', 'cronLastPoll', 'poller', 'mode', 'lastPollError',
  'hbdSourceLagBlocks', 'hbdSourceLagCheckedAt',
  // HA failover state machine (HIVESQL-HA-PLAN.md §7)
  'activeSource', 'forcedSource', 'hafsqlErrorStreakSince',
  'hafsqlRecoveryProbes', 'hafsqlLastProbeAt', 'lastFailoverAt', 'lastFailbackAt',
]);

function diagnoseCursor(field, value) {
  if (!/^\d+$/.test(value)) return 'INVALID — not an integer, poller will fall back to 0';
  const v = BigInt(value);
  if (v === BigInt(0)) return 'zero — no lower bound, per-account filter takes over';
  if (v === MAX_SAFE) return 'POISONED — equals Number.MAX_SAFE_INTEGER sentinel';
  if (v > CURSOR_CEILING) return 'ABERRANT — above 10^19 plausibility ceiling';
  // hivesql:{account}:{currency} cursors are TABLE IDs (TxTransfers ~1e8,
  // TxCustoms ~2.7e9) — small values are NORMAL there, not corruption
  if (field.startsWith('hivesql:')) return 'ok (hivesql table-id cursor)';
  if (v <= MAX_SAFE) return 'SUSPICIOUS — below current HAF id range (~4.6e17), stale or corrupted';
  return 'ok';
}

async function stateDump() {
  const state = parseHgetall(await execRedis(['HGETALL', 'polling:state']));
  const fields = Object.keys(state);
  if (fields.length === 0) {
    console.log('\npolling:state hash is empty or missing.');
    return;
  }

  console.log('\n═══ Meta fields ═══');
  for (const field of fields.filter((f) => META_FIELDS.has(f)).sort()) {
    let extra = '';
    if (field === 'heartbeat' || field === 'cronLastPoll') {
      const ts = parseInt(state[field], 10);
      if (!isNaN(ts)) extra = `  (${((Date.now() - ts) / 1000).toFixed(1)}s ago)`;
    }
    console.log(`  ${field} = ${state[field]}${extra}`);
  }

  console.log('\n═══ Cursors ({account}:{currency}) ═══');
  const cursorFields = fields.filter((f) => !META_FIELDS.has(f)).sort();
  let flagged = 0;
  for (const field of cursorFields) {
    const diagnosis = diagnoseCursor(field, state[field]);
    if (!diagnosis.startsWith('ok')) flagged++;
    console.log(`  ${field.padEnd(28)} = ${state[field].padStart(20)}  [${diagnosis}]`);
  }
  console.log(`\n${cursorFields.length} cursors, ${flagged} flagged.`);
  if (flagged > 0) {
    console.log(`Repair with: node scripts/redis-cleanup.mjs set-cursor <account:CUR> <id>`);
    console.log(`Get a sane recent id with: SELECT max(id) FROM hafsql.operation_transfer_table;`);
    console.log(`(A slightly-too-old cursor is fine — CO pages dedupe. A too-recent one loses orders.)`);
  }
}

async function setCursor(field, value) {
  if (!field || !field.includes(':')) {
    console.error('Usage: set-cursor <account:CURRENCY> <id>   e.g. set-cursor indies.cafe:HBD 463839730480448002');
    process.exit(1);
  }
  if (!/^\d+$/.test(value || '')) {
    console.error(`Refusing to set non-integer cursor value: ${JSON.stringify(value)}`);
    process.exit(1);
  }
  const diagnosis = diagnoseCursor(field, value);
  if (!diagnosis.startsWith('ok') && value !== '0') {
    console.warn(`Warning: new value looks off — [${diagnosis}]. Setting it anyway.`);
  }
  const state = parseHgetall(await execRedis(['HGETALL', 'polling:state']));
  const oldValue = state[field];
  console.log(`\n  ${field}: ${oldValue === undefined ? '(not set)' : oldValue} → ${value}`);
  await execRedis(['HSET', 'polling:state', field, value]);
  console.log('  Done. Run "state-dump" to verify.');
}

async function setSource(source) {
  if (source !== 'hafsql' && source !== 'hivesql' && source !== 'auto') {
    console.error('Usage: set-source <hafsql|hivesql|auto>');
    process.exit(1);
  }
  // CLI fallback for when the dashboard/route is unreachable. Unlike
  // POST /api/source this does NOT seed cursors — forcing hivesql here
  // starts its cursors at 0 (adapter falls back to a newest-window fetch and
  // the publish dedupe absorbs the overlap). Prefer the dashboard button.
  console.warn('NOTE: prefer the dashboard toggle / POST /api/source — this raw write skips cursor seeding.');
  const value = source === 'auto' ? '' : source;
  await execRedis(['HSET', 'polling:state', 'forcedSource', value]);
  console.log(`  forcedSource = ${value === '' ? '(cleared — auto)' : value}. Takes effect on the next poll.`);
}

// ── CLI dispatch ───────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'list-groups':
    await listGroups();
    break;
  case 'destroy-group':
    if (args.length < 2) {
      console.error('Usage: destroy-group <stream> <group>');
      process.exit(1);
    }
    await destroyGroup(args[0], args[1]);
    break;
  case 'destroy-legacy-groups':
    await destroyLegacyGroups();
    break;
  case 'poller-status':
    await pollerStatus();
    break;
  case 'clear-poller':
    await clearPoller();
    break;
  case 'state-dump':
    await stateDump();
    break;
  case 'set-cursor':
    await setCursor(args[0], args[1]);
    break;
  case 'set-source':
    await setSource(args[0]);
    break;
  default:
    console.log(`Redis stream cleanup utility

Usage:
  node scripts/redis-cleanup.mjs <command> [args...]

Commands:
  list-groups                        List all consumer groups for all streams
  destroy-group <stream> <group>     Destroy a specific consumer group
  destroy-legacy-groups              Destroy groups on old shared streams
  poller-status                      Show current poller info
  clear-poller                       Kill zombie poller lock
  state-dump                         Dump polling:state with per-cursor diagnosis
  set-cursor <account:CUR> <id>      Set a lastId cursor to a known-good value
  set-source <hafsql|hivesql|auto>   Force the polling data source (prefer the dashboard toggle)
`);
}
