# HIVESQL-HA-PLAN.md — High-Availability Failover: HAFSQL → HiveSQL

**Status: DRAFT — awaiting validation. Nothing below is implemented.**
**Plan of record for the merchant-hub HA initiative (decided 2026-07-11, during the HAFSQL backup-server incident).**

---

## 1. Why

Merchant-hub's entire order-detection pipeline reads one upstream: **HAFSQL**
(`@mahdiyari`'s public Postgres). The 2026-07-10/11 incident showed every
failure mode in one week: total outage (ECONNREFUSED), degraded latency
(40–50s per statement), lost grants (`permission denied`), and — nastiest —
a **frozen indexer** (queries succeed, zero new rows, `operation_transfer_table`
19h behind head with no error anywhere).

The risk/benefit calculation is asymmetric:

- **Cost of failover (fixed, small, mitigable):** a handful of duplicate
  orders in a minutes-wide seam window, once per switchover — and only if
  dedupe fails (§6 makes it fail twice over before a kitchen sees anything).
- **Benefit (unbounded, scales with outage length):** HAFSQL is a
  bus-factor-of-one volunteer service. A 20-minute outage is an annoyance; a
  2-week outage (operator unreachable) means **Innopay is completely dead for
  2 weeks**. The fallback's value is exactly the length of the outage.

**HiveSQL** (`@arcange`'s MS SQL service, DHF-funded, `vip.hivesql.io`) reads
the same blockchain with a different operator, different funding, different
stack — genuine redundancy, not a second copy of the same risk. Credentials
already exist in `indiesmenu/.env` (`MS_CONNECTION_STRING`, `mssql://` URL
format) but have **never been exercised from code** — Phase 0 proves them.

Guiding principle, same as the rest of the pipeline: **duplicates over
losses**. Every design choice below prefers re-fetching and deduping to any
risk of a silently dropped order.

---

## 2. Current architecture (what changes, what doesn't)

```
CO pages ──6s──▶ /api/poll ──▶ pollAllTransfers()
                                  ├─ pollHBDBatched()          ──▶ hafsql.operation_transfer_table
                                  ├─ pollHiveEngineTokenBatched(EURO|OCLT|LEI)
                                  │                             ──▶ hafd.blocks + hive.operations_view (op_type_id=18)
                                  ├─ sync-lag check (1/min)    ──▶ same two relations
                                  ├─ publishTransfer() ──▶ Redis streams transfers:{id}:{prod|dev}
                                  └─ updatePollingState() ──▶ polling:state hash (cursors etc.)
```

Unchanged: Redis streams, CO-page consumption, poller election, cron
fallback, `polling:state` single-hash budget discipline, per-currency fault
isolation, publish-before-cursor-advance ordering.

Changed: the two poll functions go behind a **source adapter interface**; a
**source manager** picks the active source from health signals we already
collect (`lastPollError`, `hbdSourceLagBlocks`); a **hub-side dedupe** guards
`publishTransfer`.

---

## 3. Source adapter interface

```ts
// lib/sources/types.ts
interface PollingSource {
  readonly name: 'hafsql' | 'hivesql';
  pollHbdTransfers(accounts: string[], minCursor: SourceCursor): Promise<RawTransferRow[]>;
  pollHiveEngineOps(minCursor: SourceCursor): Promise<RawCustomJsonRow[]>;
  healthCheck(): Promise<SourceHealth>; // { reachable, headBlock, hbdLagBlocks, latencyMs }
}
```

- `lib/sources/hafsql.ts` — the existing queries, moved verbatim (Phase 1 is
  a pure refactor, no behavior change, existing tests must stay green).
- `lib/sources/hivesql.ts` — new, `mssql` package (tedious driver), module-
  scope pool like the current `pg` Pool, `HIVESQL_CONNECTION_STRING` env var
  (added to merchant-hub Vercel env; value = indiesmenu's
  `MS_CONNECTION_STRING`).
- Row mapping to `Transfer` happens **outside** the adapters so both sources
  produce identical stream payloads (§5 covers `Transfer.id`).

### HiveSQL query sketches (T-SQL — schema assumptions VERIFIED in Phase 0, not before)

HBD (mirror of the HAFSQL batched query):

```sql
SELECT tt.ID, t.block_num, tt.timestamp, tt.[from], tt.[to],
       tt.amount, tt.amount_symbol, tt.memo
FROM TxTransfers tt
JOIN Transactions t ON t.tx_id = tt.tx_id
WHERE tt.[to] IN (@accounts...)
  AND tt.amount_symbol = 'HBD'
  AND t.block_num > @cursorBlock
ORDER BY t.block_num DESC
```

Hive-Engine (mirror of the custom_json query):

```sql
SELECT tc.ID, t.block_num, tc.timestamp, tc.required_auths, tc.json_metadata
FROM TxCustoms tc
JOIN Transactions t ON t.tx_id = tc.tx_id
WHERE tc.tid = 'ssc-mainnet-hive'
  AND t.block_num > @cursorBlock
ORDER BY t.block_num DESC
```

Phase 0 verifies: exact table/column names, whether `block_num` lives on the
Tx tables directly (avoiding the join), timestamp timezone behavior, the
head-block query, latency from Vercel's region, and result parity against
HAFSQL for a known historical block range.

---

## 4. Cursor model and translation

Two cursor namespaces in `polling:state`, never mixed:

- **HAF (existing, unchanged):** `{account}:{currency}` → 64-bit HAF op id.
- **HiveSQL (new):** `hivesql:{account}:{currency}` → **table ID**
  (`TxTransfers.ID` for HBD, `TxCustoms.ID` for HE). *(Amended in Phase 2 —
  originally block numbers.)* Two reasons: (a) a block-range filter on the
  TxCustoms join times out (Phase 0 finding 4); (b) block cursors can TIE —
  two same-block transfers split across a poll boundary would lose one,
  violating duplicates-over-losses. Table IDs are unique and monotonic
  (identity, insertion-ordered).

Translation at the seams — coarse **by design**, the overlap is what the
dedupe layer is for:

- Failover (HAF → HiveSQL): `startBlock = (hafCursor >> 32) - OVERLAP_BLOCKS`
  (proposal: `OVERLAP_BLOCKS = 20`, ~1 min), then
  `seedCursorFromBlock(table, startBlock)` (lib/sources/hivesql.ts): a binary
  search over the table-ID space with point-lookup probes (~30ms each, ~30
  probes, once per failover) finds the largest ID at or before that block.
- Failback (HiveSQL → HAF): read the block of the last HiveSQL row processed
  (adapters carry `block_num` on every row), then
  `hafCursor = blockToOperationId(block - OVERLAP_BLOCKS)` (existing helper).
  Re-fetches the overlap; dedupe absorbs it.

---

## 5. `Transfer.id` under HiveSQL

~~`id = 'hs-' + TxTransfers.ID`~~ **REJECTED by Phase 0**: every spoke does
`BigInt(transfer.id)` and stores it in a bigint PK column (indiesmenu/
millewee/zenbar sync + fulfill routes; croque upserts into a Supabase bigint
`id`). A prefixed string throws at the first `BigInt()`. Nobody derives
meaning from the id (no `>> 32` anywhere in spokes) — the contract is:
**unique + decimal numeric string + fits int8**.

Replacement: **offset bands**, still decimal strings, still int8-safe:

- HBD path: `id = 2^62 + TxTransfers.ID`  (≈ 4.61e18 + <2^31)
- HE path:  `id = 2^62 + 2^61 + TxCustoms.ID`  (≈ 6.92e18 + <~2^33)

Both bands sit far above real HAF ids (~4.6e17; HAF ids reach 2^62 only at
block ~1.07e9, ≈ 90 years away) and below int8 max (9.22e18), and the two
bands cannot collide with each other. `BigInt(transfer.id)` keeps working in
every spoke unchanged.

---

## 6. Dedupe — two independent layers

### Layer 1 (hub-side, always-on, the real fix)

Before `publishTransfer`, compute a **chain-content key** — identical no
matter which source produced the row:

```
dedupeKey = sha256(block_num | from | to | amount | symbol | memo)  // hex, truncated 16 bytes
```

- `block_num` comes free from both sources (HAF: `id >> 32`, no join;
  HiveSQL: query column) and makes the key airtight: the *same on-chain op*
  always collides, two *different* ops never do (identical content in
  different blocks → different keys; identical content in the *same* block is
  impossible for orders — the distriate suffix makes every order memo unique
  by construction).
- Guard: `GET dedupe:{key}` before publish (hit ⇒ skip), `SET dedupe:{key} 1
  EX 172800` (48h TTL) after successful publish. **2 Redis commands per
  published transfer** — order volume is tens/day, negligible against the
  per-poll budget. On any guard error, publish anyway (delivery beats dedupe).
- Always-on (not seam-only) deliberately: it also absorbs the existing
  `sanitizeCursor` → `'0'` fallback re-fetches and any future cursor-reset
  recovery, which today rely solely on CO-page id-dedupe.
- Ordering: the guard SET happens right before each publish, so the
  publish-before-cursor-advance crash-safety is preserved (crash between SET
  and publish ⇒ that transfer is suppressed on retry ⇒ violates
  duplicates-over-losses). **Therefore: SET after successful publish**, i.e.
  publish → SET. A crash between the two re-publishes once — the safe
  direction. (Check-then-publish-then-mark, not mark-then-publish.)

### Layer 2 (CO-page, defense in depth, cheap)

The order payload is self-identifying: the **distriate suffix** in the memo
(`...-inno-56fg`) is unique per order and source-independent. CO pages can
dedupe incoming orders by suffix regardless of transfer id. Proposal: ship it
armed **permanently** (a Map of seen suffixes per session costs nothing), not
gated on a "provider changed" signal — simpler, and it also covers hub
regressions. This layer is a per-spoke change; schedule it as the last phase
and document the pattern in SPOKE-DOCUMENTATION.md.

---

## 7. Source manager — failover/failback state machine

State lives in `polling:state` (rides the existing HGETALL/HMSET, no new
Redis cost):

| Field | Meaning |
|---|---|
| `activeSource` | `hafsql` (default) \| `hivesql` |
| `forcedSource` | operator override: `hafsql` \| `hivesql` \| absent (auto) |
| `hafsqlErrorStreakSince` | ISO of the first error in the current unbroken streak; cleared on any healthy HAFSQL poll/probe |
| `lastFailoverAt` / `lastFailbackAt` | ISO, audit + dashboard |

**One switch for both currencies** (HBD + Hive-Engine follow the same
`activeSource`). Rationale: a per-path split doubles the state machine for a
marginal win; a frozen HBD indexer with healthy HE simply moves both to
HiveSQL — harmless. Revisit only if HiveSQL's custom_json coverage
disappoints in Phase 0.

**Failover triggers** (evaluated after each poll, auto mode only):

1. `hafsqlErrorStreakSince` older than **10 minutes** (persistent hard
   failures: ECONNREFUSED, timeouts, grants), OR
2. `hbdSourceLagBlocks` > **1200** (~1 hour behind: the frozen-indexer mode —
   queries green, data dead; exactly what §1 says is invisible otherwise).

Thresholds are proposals — validate. Deliberately slow: a failover costs a
seam; a 5-minute blip shouldn't trigger one.

**Failback probe:** while on HiveSQL, probe HAFSQL every **5 minutes** (the
existing combined health statement: head block + max transfer id — one
statement). Require **3 consecutive healthy probes** (reachable, lag < 100
blocks) before switching back. Hysteresis prevents flapping on a
half-recovered provider.

**Manual override — one-click in the dashboard (user requirement 2026-07-11):**

- `POST /api/source` with `{ source: 'hafsql' | 'hivesql' | 'auto' }` sets or
  clears `forcedSource`. State-changing on an otherwise-open service, so it is
  the **first authenticated endpoint in merchant-hub**: requires
  `Authorization: Bearer ${ADMIN_TOKEN}` (new env var; CORS alone only
  restrains browsers, not curl). Wrong/missing token ⇒ 401, no state touched.
- Dashboard (Polling Engine section): a source control showing the active
  source with a toggle button (`Switch to HiveSQL` / `Switch to HAFSQL` /
  `Back to auto` when forced). First click prompts for the admin token and
  keeps it in `localStorage`; subsequent clicks are one click. Confirmation
  dialog states the seam consequence ("overlap window will be re-fetched;
  dedupe absorbs it").
- `scripts/redis-cleanup.mjs set-source <hafsql|hivesql|auto>` as the CLI
  fallback (same endpoint semantics, direct Redis write) — for when the
  dashboard itself is unreachable.

**Dashboard:** the Polling Engine section shows
`Source: hafsql` (dimmed, normal) / `Source: hivesql — failed over 2.1h ago (HAFSQL streak since …)`
(red, with the toggle above) plus the existing lag/error lines. `/api/status`
exposes all fields (but never the token).

**HiveSQL-unhealthy-too:** no third source; polls fail, `lastPollError` says
so, dashboard is red, cursors don't advance, everything backfills on
recovery — exactly today's behavior.

---

## 8. Vercel / serverless considerations

- `mssql` pool at module scope (same pattern as the `pg` Pool). Verify
  cold-start connect latency to `vip.hivesql.io` from Vercel's region in
  Phase 0 — if TLS+login costs seconds per cold start, consider
  `connectionTimeout`/pool tuning; the existing 60s query budget and
  `maxDuration = 300` already give headroom.
- New env vars in merchant-hub: `HIVESQL_CONNECTION_STRING` (all
  environments) and `ADMIN_TOKEN` (for `POST /api/source`; generate a long
  random value, mark sensitive).
  HiveSQL accounts have connection limits — `maxPoolSize` stays small (the
  string already says 10; serverless instances multiply pools, so consider
  lowering to 2–3).
- Redis budget delta: +1 SET per published transfer (tens/day), state fields
  ride existing HMSETs, failback probes are SQL-side only. Negligible.

---

## 9. Phases

Each phase lands independently and is validated before the next starts.
Nothing deploys without explicit user validation (standing rule).

**Phase 0 — Prove the ground (no production code). ✅ DONE 2026-07-11 — GO.**
`scripts/hivesql-health.mjs`: credentials proven, schema verified, parity OK
on both paths, spoke id-handling checked. Findings + adapter requirements in
§10; §5 amended (offset-band ids replace the rejected `hs-` prefix).

**Phase 1 — Adapter refactor, HAFSQL only.**
Extract `lib/sources/hafsql.ts` behind the interface; `pollAllTransfers`
consumes the adapter. Zero behavior change; `npm test` green; deploy and
soak.

**Phase 2 — HiveSQL adapter + hub dedupe. ✅ BUILT 2026-07-12 (deploy gate pending).**
`lib/sources/hivesql.ts` (lazy pool, both fetchers, healthCheck with HiveSQL's
own lag, `seedCursorFromBlock` binary search), pure helpers `lib/dedupe.ts` +
`lib/sources/ids.ts` + `lib/sources/mssql-config.ts`, dedupe guard wired into
the publish loop (check → publish → mark, always-on, active already under
HAFSQL), HAF HBD rows now carry `block_num` (= id >> 32) for the key.
Tests: `tests/hivesql-source.test.ts` pinned to the live parity sample.
Deploying this phase turns on Layer-1 dedupe in prod; the HiveSQL adapter
stays unreachable until Phase 3.

**Phase 3 — Source manager. ✅ BUILT 2026-07-12 (deploy gate pending).**
Decisions in pure `lib/source-decision.ts` (tested:
`tests/source-decision.test.ts`); transitions + bookkeeping in
`lib/source-manager.ts` (failover seeds both HiveSQL cursors via one binary
search per table shared by all accounts; failback jumps every HAF cursor to
head − overlap — everything older was delivered via HiveSQL). Orchestrator
resolves the source per poll and scopes cursor keys
(`hivesql:{account}:{currency}`). `POST /api/source` (Bearer `ADMIN_TOKEN`,
performs the full transition so the next poll is correct) + dashboard
one-click toggle (token kept in localStorage) + `set-source` CLI fallback
(raw write, no seeding — the adapter's zero-cursor 8h floor keeps it safe).
`/api/status` + dashboard expose activeSource / forced / streak / probes /
last transition times. **New env vars needed before deploy: `ADMIN_TOKEN`
(+ optionally `HIVESQL_CONNECTION_STRING`, required for any actual failover).**

**Phase 4 — E2E in DEV, then arm.**
`set-source hivesql` forced, place a test order on a dev account, verify CO
page delivery end-to-end. Then the seam test: order on HAFSQL → force switch
→ verify the overlap re-fetch is absorbed by dedupe (kitchen sees exactly
one). Then `set-source auto` in prod.

**Phase 5 (optional, per-spoke) — Layer-2 memo-suffix dedupe** in CO pages +
SPOKE-DOCUMENTATION.md pattern write-up.

---

## 10. Phase 0 findings (2026-07-11) — COMPLETE, go for Phase 1

Probe tool: `scripts/hivesql-health.mjs` (modes: schema / probe / parity /
parity-he). Credentials work; latency 30–170ms/statement; indexer **current**
(head-block timestamp = wall clock).

**Schema (verified live, not from memory):**
- `Blocks(block_num int, timestamp datetime, witness)` — head = `TOP 1 ORDER BY block_num DESC`, ~30ms.
- `Transactions(tx_id, block_num, transaction_num, expiration, type)` — the
  only source of `block_num` for Tx tables (they don't carry it); join on
  `tx_id` works fine (int/bigint metadata quirk is cosmetic).
- `TxTransfers(ID int ≈98M, tx_id bigint, type, [from], [to], amount money,
  amount_symbol, memo nvarchar, request_id, timestamp)`.
- `TxCustoms(ID bigint ≈2.7e9, tid, json nvarchar, timestamp,
  required_auth(s), required_posting_auth(s), tx_id bigint)`.
- **No tx-hash column anywhere visible** → the content-key dedupe (§6) is not
  just preferable, it's the *only* option. Validated.

**Parity: OK on both paths.**
- HBD: 12/12 identical dedupe keys over a 7-day window (including a real
  order: `107992698|innopay|indies.cafe|4.014|HBD|b:20,s:25cl; TABLE 2  kcs-inno-uji5-sl64`).
- HE: 397/397 identical `block|json` payloads over a ~100-block window.

**Adapter requirements discovered (each cost a probe failure):**
1. `mssql` does **not** parse `mssql://` URIs — use `uriToMssqlConfig()`
   (already written in the probe script; move to the adapter in Phase 2).
2. **`AND tt.type = 'transfer'` is mandatory**: TxTransfers folds savings/
   escrow ops into the same table. Without it, Liman's savings sweeps appear
   as phantom kitchen orders (the only HBD parity diff was two
   `transfer_to_savings` self-transfers).
3. `amount` is SQL `money` → JS **number**; canonicalize with
   `Number(x).toFixed(3)` in the dedupe key AND format the published
   `Transfer.amount` string identically to the HAF path.
4. **HE cursor on HiveSQL must be `TxCustoms.ID`, not a block range** — the
   block-filtered join times out (>60s, no usable index); `tid + ORDER BY ID
   DESC` is ~30ms. Failover seeding (block → ID) via a short binary search on
   ID probing block_num through the join (point lookups are fast; runs once
   per failover). HBD can keep the block_num cursor (account filter is
   selective; 95ms over 7 days).
5. `required_auths` arrives as a JSON **string** (`"[\"innopay\"]"`) vs HAF's
   jsonb array — `JSON.parse` at the boundary.
6. Timestamps are `datetime` (no tz); tedious returns them as UTC Dates by
   default (`useUTC`) — matches `received_at` expectations, keep an eye on it
   in Phase 2 tests.

**Still open (moved to later phases):**
- Call-waiter memo distriate suffix (Layer-2 assumption only; Phase 5).
- HiveSQL freshness inside `healthCheck()` (Phase 2, same lag pattern as
  `computeSyncLagBlocks`).

## Out of scope

- A third source / RPC-node direct polling.
- Changing the canonical `Transfer.id` to tx hash (rejected: the content-key
  dedupe achieves the goal without touching spokes).
- Per-currency independent source switching (revisit only on Phase 0
  evidence).
