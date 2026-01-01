# Merchant Hub

Centralized HAF polling hub for multi-restaurant payment coordination in the innopay ecosystem.

## Overview

merchant-hub is a **centralized polling service** that monitors the Hive blockchain for incoming transfers to multiple restaurants. It implements a distributed leader election system where restaurant "co pages" (kitchen backends) coordinate to ensure continuous polling while minimizing database load.

### Architecture

```
┌─────────────────────────────────────────┐
│  merchant-hub (Vercel)                  │
│  • Distributed polling coordination     │
│  • HAF database polling (6s intervals)  │
│  • Redis Streams for pub/sub            │
└─────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│  Upstash Redis                          │
│  • Heartbeat tracking                   │
│  • Leader election                      │
│  • Transfer queues                      │
└─────────────────────────────────────────┘
     │                    │
     ▼                    ▼
┌──────────────┐  ┌──────────────┐
│  indiesmenu  │  │ croque-bedaine│
│  co page     │  │  co page      │
└──────────────┘  └──────────────┘
```

## Features

- **Distributed Leader Election**: First co page to open becomes the poller
- **Automatic Failover**: If poller crashes, another co page takes over
- **Collision Avoidance**: Random delays prevent simultaneous takeover attempts
- **Fallback Polling**: Vercel Cron (1 minute) when all shops are closed
- **Multi-Currency Support**: HBD, EURO, OCLT (Hive-Engine tokens)
- **Redis Streams**: Real-time pub/sub for transfers to each restaurant

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
- **Upstash Redis** - Serverless Redis (Vercel KV)
- **PostgreSQL** - HAF database connection
- **Vercel** - Deployment and Cron

## License

MIT

## Related Projects

- [innopay](https://github.com/YOUR_USERNAME/innopay) - Payment hub
- [indiesmenu](https://github.com/YOUR_USERNAME/indiesmenu) - Indies restaurant system
- [croque-bedaine](https://github.com/YOUR_USERNAME/croque-bedaine) - Croque Bedaine restaurant system

## Support

For issues and questions, see the [GitHub Issues](https://github.com/YOUR_USERNAME/merchant-hub/issues).
