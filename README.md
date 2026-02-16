# Merchant Hub

Centralized HAF polling hub, system health dashboard, and reporting API for multi-restaurant payment coordination in the innopay ecosystem.

## Overview

merchant-hub is a **centralized polling service** that monitors the Hive blockchain for incoming transfers to multiple restaurants. It implements a distributed leader election system where restaurant "co pages" (kitchen backends) coordinate to ensure continuous polling while minimizing database load. It also provides a **system health dashboard** (the homepage) and a **reporting API** for accountant exports.

### Architecture

```
┌───────────────────────────────────────────────┐
│  merchant-hub (Vercel)                        │
│  • System Health Dashboard (homepage)         │
│  • Distributed polling coordination           │
│  • HAF database polling (6s intervals)        │
│  • Redis Streams for pub/sub                  │
│  • Reporting API (HAFSQL transaction queries) │
└───────────────────────────────────────────────┘
           │                │
           ▼                ▼
┌─────────────────┐  ┌──────────────────────────┐
│  Upstash Redis  │  │  HAFSQL (PostgreSQL)     │
│  • Heartbeat    │  │  • operation_transfer_table│
│  • Leader elect │  │  • haf_operations         │
│  • Transfer Qs  │  │  • haf_blocks             │
└─────────────────┘  └──────────────────────────┘
     │                    │
     ▼                    ▼
┌──────────────┐  ┌──────────────┐
│  indiesmenu  │  │ croque-bedaine│
│  co page     │  │  co page      │
└──────────────┘  └──────────────┘
```

## Features

- **System Health Dashboard**: Live homepage showing polling engine status, per-restaurant Redis stream health, consumer groups, pending messages, and last processed IDs. Auto-refreshes every 10 seconds with green/yellow/red status indicators.
- **Distributed Leader Election**: First co page to open becomes the poller
- **Automatic Failover**: If poller crashes, another co page takes over
- **Collision Avoidance**: Random delays prevent simultaneous takeover attempts
- **Fallback Polling**: Vercel Cron (1 minute) when all shops are closed
- **Multi-Currency Support**: HBD, EURO, OCLT (Hive-Engine tokens)
- **Redis Streams**: Real-time pub/sub for transfers to each restaurant
- **Reporting API**: Query HAFSQL for historical HBD transfers per restaurant account, used by spoke admin pages for accountant CSV/PDF exports

## Polling Behavior

### Active Mode (6-second polling)
- First co page opens at 8 AM → becomes poller
- Polls HAF every 6 seconds
- Other co pages subscribe to Redis Streams
- Continues even if co page closes (until no co pages remain)

### Sleeping Mode (1-minute polling)
- All co pages closed overnight
- Vercel Cron fallback polls every 1 minute
- Minimal resource usage
- Next co page to open triggers active mode

### Failover
- If poller crashes or closes
- merchant-hub publishes "takeover-needed" message
- Co pages wait random delay (0-1000ms)
- First to respond becomes new poller

## Pages

### `/` — System Health Dashboard
Live dashboard showing the full system state at a glance:
- **Polling Engine**: active/inactive status, current poller, mode, time since last poll
- **Registered Spokes**: per-restaurant cards with Redis stream length, pending messages, consumer groups, and last processed IDs (prod/dev per currency)
- **System Broadcasts**: broadcast stream info and consumer group status

Auto-refreshes every 10 seconds (configurable). Dark theme (zinc-950), Geist font, green/yellow/red status dots.

## API Routes

### `GET /api/heartbeat`
Check polling status and current poller.

**Response:**
```json
{
  "isActive": true,
  "heartbeat": 1704067200000,
  "poller": "indies",
  "mode": "active-6s",
  "timeSinceLastPoll": 3500
}
```

### `GET /api/status`
Comprehensive system health endpoint consumed by the dashboard homepage. Returns polling state, per-restaurant Redis stream info, consumer groups, last processed IDs, and system broadcasts in one call.

**Response:**
```json
{
  "timestamp": 1704067200000,
  "polling": {
    "heartbeat": 1704067200000,
    "isActive": true,
    "poller": "indies",
    "mode": "active-6s",
    "timeSinceLastPoll": 3500,
    "heartbeatTimeout": 15000
  },
  "restaurants": [
    {
      "id": "indies",
      "name": "Indies Cafe",
      "accounts": { "prod": "indies.cafe", "dev": "indies-test" },
      "currencies": ["HBD", "EURO", "OCLT"],
      "stream": { "length": 42, "consumerGroups": [...] },
      "lastIds": { "prod": { "HBD": "...", "EURO": "..." }, "dev": { ... } }
    }
  ],
  "systemBroadcasts": { "length": 5, "consumerGroups": [...] }
}
```

### `GET /api/reporting`
Query HAFSQL for historical HBD transfers to a restaurant account. Used by spoke admin reporting pages for accountant CSV/PDF exports.

**Parameters:**
- `account` — Hive account (must match a known restaurant from `lib/config.ts`)
- `from` — Start date (YYYY-MM-DD, inclusive)
- `to` — End date (YYYY-MM-DD, inclusive)

**Example:** `GET /api/reporting?account=indies.cafe&from=2025-01-01&to=2025-12-31`

**Response:**
```json
{
  "account": "indies.cafe",
  "from": "2025-01-01",
  "to": "2025-12-31",
  "transactions": [
    {
      "id": "123456",
      "timestamp": "2025-03-15T12:30:00.000Z",
      "from_account": "customer1",
      "amount": "5.000",
      "memo": "TABLE 4",
      "block_num": 80000000
    }
  ],
  "count": 1,
  "truncated": false,
  "_strategy": "hafsql.haf_operations (single join, timestamp direct)",
  "_elapsed_ms": 450
}
```

**Notes:**
- Validates account against registered restaurants in `lib/config.ts`
- Tries 3 join strategies to resolve operation timestamps (single join preferred, double join fallback)
- Caches the working strategy for subsequent requests
- On total failure, runs schema discovery and logs available tables/columns
- LIMIT 5000 rows, 8s query timeout, CORS enabled
- Extensive `[REPORTING]` console logging for debugging

### `POST /api/wake-up`
Called by co pages when they first open.

**Request:**
```json
{
  "shopId": "indies"
}
```

**Response:**
```json
{
  "status": "became-poller",
  "poller": "indies",
  "shouldStartPolling": true
}
```

### `GET /api/poll`
Called by active poller every 6 seconds.

**Response:**
```json
{
  "success": true,
  "transfersFound": 3,
  "poller": "indies",
  "duration": 450
}
```

### `GET /api/cron-poll`
Vercel Cron fallback (internal, called every 1 minute).

## Setup

### 1. Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/merchant-hub.git
cd merchant-hub
npm install
```

### 2. Environment Variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
# HAF Database
HAF_CONNECTION_STRING="postgres://hafsql_public:hafsql_public@hafsql-sql.mahdiyari.info:5432/haf_block_log"

# Upstash Redis (get from Vercel KV)
KV_REST_API_URL="https://..."
KV_REST_API_TOKEN="..."

# Environment
NODE_ENV=development

# Restaurant Accounts
INDIES_ACCOUNT=indies.cafe
INDIES_DEV_ACCOUNT=indies-test
CROQUE_ACCOUNT=croque.bedaine
CROQUE_DEV_ACCOUNT=croque-test
```

### 3. Create Vercel KV Store

1. Go to your Vercel project dashboard
2. Navigate to **Storage** → **Create Database**
3. Select **KV** (Upstash Redis)
4. Copy the environment variables to `.env.local`

### 4. Run Locally

```bash
npm run dev
```

Visit `http://localhost:3000/api/heartbeat` to verify setup.

### 5. Deploy to Vercel

```bash
git add .
git commit -m "Initial merchant-hub setup"
git push origin main
```

Then:
1. Import project in Vercel dashboard
2. Add environment variables
3. Deploy
4. Cron job will be automatically configured

## Configuration

### Adding a New Restaurant

Edit `lib/config.ts`:

```typescript
export const RESTAURANTS: RestaurantConfig[] = [
  // ... existing restaurants
  {
    id: 'new-restaurant',
    name: 'New Restaurant Name',
    accounts: {
      prod: 'restaurant.hive',
      dev: 'restaurant-test',
    },
    currencies: ['HBD', 'EURO', 'OCLT'],
    memoFilters: {
      HBD: '%TABLE %',
      EURO: '%TABLE %',
      OCLT: '%TABLE %',
    },
  },
];
```

Add environment variables:

```env
NEW_RESTAURANT_ACCOUNT=restaurant.hive
NEW_RESTAURANT_DEV_ACCOUNT=restaurant-test
```

### Polling Configuration

Edit `lib/config.ts`:

```typescript
export const POLLING_CONFIG = {
  INTERVAL_ACTIVE: 6000,      // 6 seconds
  INTERVAL_SLEEPING: 60000,   // 1 minute
  HEARTBEAT_TIMEOUT: 15000,   // 15 seconds
  TAKEOVER_DELAY_MAX: 1000,   // 1 second
  POLLER_LOCK_TTL: 30,        // 30 seconds
};
```

## Integrating with Restaurant Co Pages

### 1. Wake Up on Page Load

```typescript
// indiesmenu/app/co/page.tsx

useEffect(() => {
  async function wakeUp() {
    const response = await fetch('https://merchant-hub.vercel.app/api/wake-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: 'indies' }),
    });

    const data = await response.json();

    if (data.shouldStartPolling) {
      // Start polling /api/poll every 6 seconds
      startPolling();
    } else {
      // Just subscribe to Redis Stream
      subscribeToTransfers();
    }
  }

  wakeUp();
}, []);
```

### 2. Poll Every 6 Seconds (if you're the poller)

```typescript
function startPolling() {
  const interval = setInterval(async () => {
    await fetch('https://merchant-hub.vercel.app/api/poll');
  }, 6000);

  return () => clearInterval(interval);
}
```

### 3. Subscribe to Transfers

```typescript
// Use Redis Streams or poll merchant-hub for your restaurant's transfers
async function subscribeToTransfers() {
  // Implementation depends on your frontend architecture
  // You can poll merchant-hub or use Redis Streams directly
}
```

## Technology Stack

- **Next.js 15** - Framework
- **TypeScript** - Type safety
- **Upstash Redis** - Serverless Redis (Vercel KV) for polling coordination and streams
- **PostgreSQL (pg)** - HAF database connection for blockchain queries and reporting
- **Vercel** - Deployment and Cron
- **Tailwind CSS** - Dashboard styling

## License

MIT

## Related Projects

- [innopay](https://github.com/YOUR_USERNAME/innopay) - Payment hub
- [indiesmenu](https://github.com/YOUR_USERNAME/indiesmenu) - Indies restaurant system
- [croque-bedaine](https://github.com/YOUR_USERNAME/croque-bedaine) - Croque Bedaine restaurant system

## Support

For issues and questions, see the [GitHub Issues](https://github.com/YOUR_USERNAME/merchant-hub/issues).
