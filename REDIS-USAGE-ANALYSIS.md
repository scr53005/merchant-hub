# Upstash Redis Usage Analysis - Merchant-Hub

**Date**: 2026-01-24
**Issue**: Hit Upstash free tier limit of 500,000 requests
**Root Cause**: Cron running every minute + active co page polling

---

## 📊 Current Architecture (Corrected)

### Polling Systems

1. **Vercel Cron** (`/api/cron-poll` every 1 minute):
   - Runs 24/7 as fallback
   - Skips if active 6-second poller detected
   - **Frequency**: 60/hr × 24 hr × 30 days = **43,200 invocations/month**

2. **Active 6-Second Polling** (co pages):
   - **Indies**: `indiesmenu/app/admin/current_orders/page.tsx`
   - **Croque**: `croque-bedaine/src/pages/admin/CurrentOrders.tsx`
   - Both implemented and working ✅
   - **Frequency**: 10/min × 60 min × hours_open × 30 days

### How Co Pages Work

**On mount:**
1. Call `/api/wake-up` to attempt becoming the poller
2. If elected: Start `/api/poll` every 6 seconds (triggers HAF polling)
3. Always: Start sync cycle every 6 seconds (consume from Redis stream)

**Sync cycle (every 6 seconds, ALL co pages):**
- Call `/api/transfers/consume` to read from Redis stream
- Process transfers (insert to local DB)
- Call `/api/transfers/ack` to acknowledge messages

---

## 🔍 Redis Requests Per Operation

### `/api/cron-poll` (Cron Fallback)

**When it polls** (no active 6s poller exists):

**Read operations:**
```
getHeartbeat()                        → 1 GET
getLastId('indies.cafe', 'HBD')      → 1 GET
getLastId('indies-test', 'HBD')      → 1 GET
getLastId('croque.bedaine', 'HBD')   → 1 GET
getLastId('croque-test', 'HBD')      → 1 GET
getLastId('indies.cafe', 'EURO')     → 1 GET
getLastId('indies-test', 'EURO')     → 1 GET
getLastId('croque.bedaine', 'EURO')  → 1 GET
getLastId('croque-test', 'EURO')     → 1 GET
getLastId('indies.cafe', 'OCLT')     → 1 GET
getLastId('indies-test', 'OCLT')     → 1 GET
getLastId('croque.bedaine', 'OCLT')  → 1 GET
getLastId('croque-test', 'OCLT')     → 1 GET
```
**Subtotal: 13 GETs**

**Write operations:**
```
setMode('sleeping-1min')              → 1 SET
publishSystemBroadcast()              → 1 XADD
setHeartbeat()                        → 1 SET
setLastId() per account with transfers → N SETs (variable)
publishTransfer() per transfer        → N XADDs (variable)
```
**Subtotal: 3 writes (baseline, assuming no transfers)**

**Total per cron-poll: 16 requests minimum**

**When it skips** (active poller detected):
```
getHeartbeat()                        → 1 GET
```
**Total: 1 request**

---

### `/api/poll` (Active HAF Polling)

Called every 6 seconds by the elected poller co page.

**Read operations:**
```
getPoller()                           → 1 GET
getLastId() × 12 (same as cron)      → 12 GETs
```
**Subtotal: 13 GETs**

**Write operations:**
```
setHeartbeat()                        → 1 SET
refreshPollerLock()                   → 1 EXPIRE
publishTransfer() per transfer        → N XADDs (variable)
setLastId() per account               → N SETs (variable)
```
**Subtotal: 2 writes (baseline, assuming no transfers)**

**Total per poll: 15 requests minimum**

---

### `/api/transfers/consume` (Co Page Sync)

Called every 6 seconds by ALL co pages (poller or not).

**When messages exist:**
```
XLEN (debug check)                    → 1 request
XGROUP CREATE (first time only)       → 1 request (then fails)
XREADGROUP                            → 1 request
```
**Total: 3 requests** (after first run: 2 requests)

**When no messages exist:**
```
XLEN                                  → 1 request
XGROUP CREATE (skip)                  → 0 requests
XREADGROUP                            → 1 request
XAUTOCLAIM                            → 1 request
XPENDING                              → 1 request
XRANGE (debug)                        → 1 request
```
**Total: 6 requests**

**Average: 4 requests per consume**

---

### `/api/transfers/ack` (Message Acknowledgment)

Called after successful consume (only if messages were received).

```
XACK with messageIds                  → 1 request
```

**Total: 1 request** (only when transfers consumed)

---

## 📈 Monthly Usage Calculations

### Scenario 1: Only Cron Running (No Co Pages Open)

This is likely your current situation most of the time.

**Cron runs every minute, always polling:**
```
43,200 invocations/month × 16 requests/invocation = 691,200 requests/month
```

**Monthly total: 691,200 requests** ❌ **38% over free tier**

**Daily average:**
```
691,200 / 30 days = 23,040 requests/day
23,040 / 1,440 minutes = 16 requests/minute
```

**To hit 500k in 22 days:**
```
22 days × 23,040 requests/day = 506,880 requests ≈ 500,000 ✅
```

**This explains your usage perfectly!**

---

### Scenario 2: One Co Page Open During Business Hours

**Assumptions:**
- Co page open 8 hours/day (e.g., 10am-6pm)
- This page becomes the poller
- Cron skips during these 8 hours (1 request when it checks)

**Active polling (8 hours):**
```
Poll: 15 requests × 10 times/min × 60 min/hr × 8 hr/day × 30 days = 3,600,000
Sync: 4 requests × 10 times/min × 60 min/hr × 8 hr/day × 30 days = 960,000
```

**Cron fallback (16 hours):**
```
Cron polls: 16 requests × 60 min/hr × 16 hr/day × 30 days = 460,800
Cron skips (during active): 1 request × 60 min/hr × 8 hr/day × 30 days = 14,400
```

**Monthly total: 5,035,200 requests** ❌ **10x over free tier**

---

### Scenario 3: Both Co Pages Open (Worst Case)

**Assumptions:**
- Both co pages open 12 hours/day
- One becomes poller, one just syncs
- Cron skips during these 12 hours

**Poller page:**
```
Poll: 15 × 10 × 60 × 12 × 30 = 3,240,000
Sync: 4 × 10 × 60 × 12 × 30 = 864,000
```

**Non-poller page:**
```
Sync: 4 × 10 × 60 × 12 × 30 = 864,000
```

**Cron fallback (12 hours):**
```
Cron polls: 16 × 60 × 12 × 30 = 345,600
Cron skips: 1 × 60 × 12 × 30 = 21,600
```

**Monthly total: 5,335,200 requests** ❌ **11x over free tier**

---

## 🎯 Root Cause Analysis

### Primary Issue: Cron Frequency × LastId Queries

**The Math:**
```
1-minute cron × 12 getLastId() calls = 12 GETs per minute
12 GETs/min × 60 min/hr × 24 hr/day × 30 days = 518,400 GETs/month
```

**This single pattern (lastId tracking) accounts for 518k of your 500k usage!**

### Why It's Worse Than Expected

You correctly optimized HAF database queries to O(1) batching ✅

But Redis operations are still **per-account per-currency**:
- 2 restaurants × 2 environments (prod + dev) = **4 accounts**
- 4 accounts × 3 currencies (HBD, EURO, OCLT) = **12 lastId keys**

Every poll reads all 12 keys, even though you only query HAF 3 times (once per currency).

### Secondary Issue: Active Polling Multiplier

When co pages are open, polling frequency jumps from:
- **1 per minute** (cron) → **10 per minute** (6-second intervals)

This 10x multiplier applies to ALL Redis operations, causing explosive growth.

---

## 💡 Optimization Strategies (Ranked by Impact)

### 🏆 Option 1: Reduce Cron Frequency (IMMEDIATE FIX)

**Change**: `vercel.json` schedule from `* * * * *` to `*/5 * * * *`

```json
{
  "crons": [
    {
      "path": "/api/cron-poll",
      "schedule": "*/5 * * * *"  // Every 5 minutes
    }
  ]
}
```

**Impact:**
```
Before: 43,200 × 16 = 691,200 requests/month
After:   8,640 × 16 = 138,240 requests/month
Savings: 552,960 requests (80% reduction)
```

**Result: Well under 500k limit** ✅

**Tradeoff:** Transfers detected with 5-minute delay instead of 1-minute when shops are closed

---

### 🥈 Option 2: Consolidate LastId Storage (ARCHITECTURE CHANGE)

Instead of 12 separate keys, use **2 Redis hashes** (one per restaurant):

**Current structure:**
```
lastId:indies.cafe:HBD        → "12345"
lastId:indies-test:HBD        → "12340"
lastId:indies.cafe:EURO       → "67890"
... (12 keys total)
```

**Optimized structure:**
```
lastIds:indies → {
  "prod_HBD": "12345",
  "dev_HBD": "12340",
  "prod_EURO": "67890",
  ...
}
lastIds:croque-bedaine → { ... }
```

**Redis operations:**
```
Before: 12 × GET + N × SET
After:  2 × HGETALL + 2 × HMSET
```

**Implementation:**
```typescript
// lib/redis.ts

export async function getAllLastIds(restaurantId: string): Promise<Record<string, string>> {
  const hashKey = `lastIds:${restaurantId}`;
  const data = await redis.hgetall(hashKey);
  return data || {};
}

export async function setAllLastIds(restaurantId: string, updates: Record<string, string>): Promise<void> {
  const hashKey = `lastIds:${restaurantId}`;
  if (Object.keys(updates).length > 0) {
    await redis.hmset(hashKey, updates);
  }
}
```

**Impact on per-poll cost:**
```
Before: 13 GETs + 3 writes = 16 requests
After:  3 GETs (heartbeat + 2 hash reads) + 3 writes = 6 requests
Savings: 62% reduction per poll
```

**Monthly with Option 2 alone (1-min cron):**
```
43,200 × 6 = 259,200 requests/month
```

**Result: 48% under limit** ✅

**Monthly with Options 1 + 2 combined:**
```
8,640 × 6 = 51,840 requests/month
```

**Result: 90% under limit** ✅✅

---

### 🥉 Option 3: Single Polling State Hash (BEST LONG-TERM)

Store ALL polling state in one Redis hash:

```typescript
// Single hash: "polling:state"
{
  "heartbeat": "1737673200000",
  "poller": "indies-co-abc123",
  "mode": "active-6s",
  "indies:prod:HBD": "12345",
  "indies:dev:HBD": "12340",
  "indies:prod:EURO": "67890",
  "indies:dev:EURO": "67880",
  "indies:prod:OCLT": "45000",
  "indies:dev:OCLT": "44990",
  "croque:prod:HBD": "12350",
  "croque:dev:HBD": "12345",
  "croque:prod:EURO": "67900",
  "croque:dev:EURO": "67890",
  "croque:prod:OCLT": "45010",
  "croque:dev:OCLT": "45000"
}
```

**Operations:**
```
Read all state:  HGETALL polling:state  → 1 request
Update state:    HMSET polling:state field1 val1 field2 val2 ... → 1 request
Publish transfer: XADD transfers:restaurant ... → 1 request
```

**Per-poll cost:**
```
1 HGETALL + 1 HMSET + N XADDs = 2 + N requests
```

**Minimum (no transfers): 2 requests per poll**

**Monthly impact:**
```
1-min cron: 43,200 × 2 = 86,400 requests/month (83% under limit)
5-min cron: 8,640 × 2 = 17,280 requests/month (97% under limit!)
```

**With this optimization, you could keep 1-minute polling and still be well under limit.**

---

### Option 4: Adaptive Polling with Exponential Backoff

Track consecutive empty polls and increase interval dynamically:

```typescript
let consecutiveEmptyPolls = 0;

if (transfers.length === 0) {
  consecutiveEmptyPolls++;

  // Backoff: 1min → 2min → 5min → 10min → 15min (max)
  const backoffMultiplier = Math.min(
    Math.pow(1.5, Math.floor(consecutiveEmptyPolls / 5)),
    15
  );

  nextPollDelay = 60000 * backoffMultiplier;
} else {
  consecutiveEmptyPolls = 0;
  nextPollDelay = 60000; // Reset to 1 minute
}
```

**Impact:** Reduces polling during idle periods (nights, weekends)

**Estimated savings:** 30-50% reduction during low-traffic hours

---

### Option 5: Only Poll Production in Cron

Dev accounts likely have minimal traffic. Only poll them when dev co pages are actively open.

**Modify `lib/config.ts`:**
```typescript
export function getAccountsForCron(): string[] {
  // Only poll production accounts in cron fallback
  return RESTAURANTS.flatMap(r => [r.accounts.prod]);
}

export function getAllAccountsForActivePoll(): string[] {
  // Poll all accounts (prod + dev) when co pages are open
  return getAllAccounts().map(a => a.account);
}
```

**Impact:**
```
Before: 12 getLastId() calls (4 accounts × 3 currencies)
After:  6 getLastId() calls (2 accounts × 3 currencies)
Per-poll cost: 16 → 10 requests (37% reduction)
```

**Monthly (1-min cron, prod only):**
```
43,200 × 10 = 432,000 requests/month (14% under limit)
```

---

## 🏆 Recommended Implementation Plan

### Phase 1: Immediate Fix (Today)

**Action:** Reduce cron frequency to 5 minutes

```bash
# Edit vercel.json
"schedule": "*/5 * * * *"

# Deploy to Vercel
vercel --prod
```

**Result:** 138k requests/month (72% under limit) ✅

**Time to implement:** 5 minutes

---

### Phase 2: Short-term Optimization (This Week)

**Action:** Implement Option 2 (Consolidated LastId Storage)

**Files to modify:**
1. `lib/redis.ts` - Add `getAllLastIds()` and `setAllLastIds()`
2. `lib/haf-polling.ts` - Refactor to use hash-based storage
3. Test with dev environment

**Result:** 52k requests/month with 5-min cron (90% under limit) ✅✅

**Time to implement:** 2-3 hours

---

### Phase 3: Long-term Architecture (Next Sprint)

**Action:** Implement Option 3 (Single Polling State Hash)

**Benefits:**
- Maximum efficiency (2 requests per poll)
- Can return to 1-minute polling if needed
- Cleaner architecture
- Room for growth (can add more restaurants without hitting limits)

**Result:** 17k-86k requests/month (83-97% under limit) ✅✅✅

**Time to implement:** 4-6 hours

---

### Phase 4: Smart Optimizations (Future)

**Actions:**
- Option 4: Adaptive backoff during idle periods
- Option 5: Prod-only polling in cron
- Monitoring dashboard for Redis usage trends

**Result:** Further 30-50% savings during low-traffic periods

---

## 📊 Projected Usage After Fixes

| Configuration | Requests/Month | vs Free Tier | Status |
|---------------|----------------|--------------|--------|
| **Current (1-min cron)** | 691,200 | +38% | ❌ Over |
| **Phase 1 (5-min cron)** | 138,240 | -72% | ✅ Under |
| **Phase 2 (5-min + hash)** | 51,840 | -90% | ✅✅ Well under |
| **Phase 3 (5-min + single hash)** | 17,280 | -97% | ✅✅✅ Excellent |
| **Phase 3 (1-min + single hash)** | 86,400 | -83% | ✅✅ Good |

---

## 🚨 Active Polling Impact (When Co Pages Open)

**WARNING:** With co pages open 8+ hours/day, usage will spike dramatically.

### Without Optimization

**Current architecture + 8hr/day co page:**
```
5,035,200 requests/month (10x over limit)
Cost: $9/month on Upstash pay-as-you-go
```

### With Phase 3 Optimization

**Single hash + 8hr/day co page:**
```
Poll (8hr): 2 requests × 10/min × 60 × 8 × 30 = 288,000
Sync (8hr): 4 requests × 10/min × 60 × 8 × 30 = 576,000
Cron (16hr): 2 requests × 60 × 16 × 30 = 57,600
Total: 921,600 requests/month (84% over limit)
Cost: ~$0.84/month
```

**Still over, but manageable with Upstash paid plan.**

---

## 🎓 Key Insights

1. **You optimized the wrong bottleneck:** HAF queries are O(1) ✅, but Redis operations are still O(N)

2. **12 keys per poll is the killer:** 4 accounts × 3 currencies = 12 separate GET operations

3. **Cron frequency matters more than you think:** 1-min vs 5-min is 5x difference in requests

4. **Free tier math:**
   ```
   500k ÷ 43,200 cron invocations = 11.5 requests/poll allowed
   Current: 16 requests/poll = 38% over budget
   ```

5. **Active polling is a future concern:** Only affects usage when co pages are actually open

6. **Hash storage is the key:** Reduces per-poll from 16 → 6 → 2 requests depending on implementation

---

## 📝 Action Items

- [x] **Analyze usage** - DONE (this document)
- [ ] **TODAY:** Deploy Phase 1 (5-min cron) → saves 80%
- [ ] **THIS WEEK:** Implement Phase 2 (hash storage) → saves 90% total
- [ ] **NEXT SPRINT:** Implement Phase 3 (single hash) → saves 97% total
- [ ] **MONITORING:** Set up Upstash usage alerts at 400k/month threshold
- [ ] **BUDGET:** Consider Upstash paid plan (~$1-2/month) for peace of mind when co pages are actively used

---

## 🔍 How You Hit 500k

**Timeline reconstruction:**
```
Deployment date: ~22 days ago
Cron frequency: Every 1 minute
Requests per poll: 16
Daily usage: 1,440 min/day × 16 req = 23,040 req/day
22 days usage: 22 × 23,040 = 506,880 requests ≈ 500,000 ✓
```

**You hit the limit almost entirely from cron-poll running 24/7 with 12 getLastId() calls per minute.**

The numbers DO add up once you account for per-account per-currency tracking! 🎯
