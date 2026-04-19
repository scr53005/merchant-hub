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
    const state = await execRedis(['HGETALL', 'polling:state']);
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
`);
}
