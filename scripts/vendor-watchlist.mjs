#!/usr/bin/env node

// Dynamic vendor-watchlist utility for merchant-hub
// (project_hatchery_vendor_hatching). Reads/writes the Redis hash that the
// poller unions with the static config.ts accounts, so a Farm vendor can be
// watched WITHOUT a config edit + redeploy.
//
// Usage:
//   node scripts/vendor-watchlist.mjs [command] [args...]
//
// Commands:
//   list                                   Show the current dynamic watchlist
//   add <account> [restaurantId] [env]     Register a vendor account
//                                          (defaults: innohatch prod)
//   remove <account>                       Unregister a vendor account
//
// This talks to Redis directly (like redis-cleanup.mjs). The equivalent
// authed HTTP path is POST /api/vendors — this script is for ops/testing.
//
// Environment: KV_REST_API_URL and KV_REST_API_TOKEN from .env.local.

import { readFileSync } from 'fs';
import { resolve } from 'path';

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
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* rely on environment */
  }
}

loadEnvFile(resolve(process.cwd(), '.env.local'));
loadEnvFile(resolve(process.cwd(), '.env.example'));

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
if (!KV_URL || !KV_TOKEN) {
  console.error('Missing KV_REST_API_URL or KV_REST_API_TOKEN. Set them in .env.local.');
  process.exit(1);
}

const HASH = 'merchant-hub:dynamic-accounts';

async function execRedis(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis error: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function parseHgetall(reply) {
  const obj = {};
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) obj[String(reply[i])] = String(reply[i + 1]);
  } else if (reply && typeof reply === 'object') {
    for (const [k, v] of Object.entries(reply)) obj[String(k)] = String(v);
  }
  return obj;
}

async function list() {
  const entries = parseHgetall(await execRedis(['HGETALL', HASH]));
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    console.log('Dynamic watchlist is empty (only config.ts Tier C accounts are polled).');
    return;
  }
  console.log(`Dynamic watchlist (${keys.length}):`);
  for (const account of keys.sort()) console.log(`  ${account} → ${entries[account]}`);
}

async function add(account, restaurantId = 'innohatch', env = 'prod') {
  if (!account) throw new Error('usage: add <account> [restaurantId] [env]');
  if (env !== 'prod' && env !== 'dev') throw new Error("env must be 'prod' or 'dev'");
  await execRedis(['HSET', HASH, account, `${restaurantId}:${env}`]);
  console.log(`Registered ${account} → ${restaurantId}:${env}. Watched from the next poll.`);
}

async function remove(account) {
  if (!account) throw new Error('usage: remove <account>');
  const n = await execRedis(['HDEL', HASH, account]);
  console.log(n > 0 ? `Removed ${account}.` : `${account} was not in the watchlist.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'list': return list();
    case 'add': return add(...args);
    case 'remove': return remove(...args);
    default:
      console.log('Commands: list | add <account> [restaurantId] [env] | remove <account>');
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
