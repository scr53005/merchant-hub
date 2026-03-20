// Restaurant configuration for merchant-hub

import { RestaurantConfig } from '@/types';

// Parse comma-separated env var into array of account names
function parseAdditionalAccounts(envVar?: string): string[] {
  return (envVar || '').split(',').map(s => s.trim()).filter(Boolean);
}

export const RESTAURANTS: RestaurantConfig[] = [
  {
    id: 'indies',
    name: 'Indies Restaurant',
    accounts: {
      prod: (process.env.INDIES_ACCOUNT || 'indies.cafe').trim(),
      dev: (process.env.INDIES_DEV_ACCOUNT || 'indies-test').trim(),
    },
    additionalAccounts: {
      prod: parseAdditionalAccounts(process.env.INDIES_ADDITIONAL_PROD_ACCOUNTS),
      dev: parseAdditionalAccounts(process.env.INDIES_ADDITIONAL_DEV_ACCOUNTS),
    },
    currencies: ['HBD', 'EURO', 'OCLT'],
    memoFilters: {
      // Filter on distriate pattern - allows both dine-in (TABLE X) and takeaway orders
      HBD: '%-inno-%',
      EURO: '%-inno-%',
      OCLT: '%-inno-%',
    },
  },
  {
    id: 'croque-bedaine',
    name: 'Le Croque Bedaine',
    accounts: {
      prod: (process.env.CROQUE_ACCOUNT || 'croque.bedaine').trim(),
      dev: (process.env.CROQUE_DEV_ACCOUNT || 'croque-test').trim(),
    },
    additionalAccounts: {
      prod: parseAdditionalAccounts(process.env.CROQUE_ADDITIONAL_PROD_ACCOUNTS),
      dev: parseAdditionalAccounts(process.env.CROQUE_ADDITIONAL_DEV_ACCOUNTS),
    },
    currencies: ['HBD', 'EURO', 'OCLT'],
    memoFilters: {
      // Filter on distriate pattern - allows both dine-in (TABLE X) and takeaway orders
      HBD: '%-inno-%',
      EURO: '%-inno-%',
      OCLT: '%-inno-%',
    },
  },
];

// Get the appropriate account based on environment
export function getRestaurantAccount(restaurant: RestaurantConfig): string {
  return process.env.NODE_ENV === 'production'
    ? restaurant.accounts.prod
    : restaurant.accounts.dev;
}

// Get ALL accounts (primary + additional, both prod and dev) for batched polling
// Since we're using O(1) batched queries, querying all accounts has negligible cost
export function getAllAccounts(): { account: string; restaurant: RestaurantConfig; env: 'prod' | 'dev' }[] {
  const allAccounts: { account: string; restaurant: RestaurantConfig; env: 'prod' | 'dev' }[] = [];

  for (const restaurant of RESTAURANTS) {
    // Primary accounts (always present)
    allAccounts.push({ account: restaurant.accounts.prod, restaurant, env: 'prod' });
    allAccounts.push({ account: restaurant.accounts.dev, restaurant, env: 'dev' });

    // Additional accounts (same restaurant, same stream)
    for (const account of restaurant.additionalAccounts?.prod || []) {
      allAccounts.push({ account, restaurant, env: 'prod' });
    }
    for (const account of restaurant.additionalAccounts?.dev || []) {
      allAccounts.push({ account, restaurant, env: 'dev' });
    }
  }

  return allAccounts;
}

// Polling configuration
export const POLLING_CONFIG = {
  INTERVAL_ACTIVE: 6000, // 6 seconds when shops are open
  INTERVAL_SLEEPING: 60000, // 1 minute when all shops are closed
  HEARTBEAT_TIMEOUT: 15000, // 15 seconds - consider poller dead if no heartbeat
  TAKEOVER_DELAY_MAX: 1000, // Max random delay for takeover collision avoidance
  POLLER_LOCK_TTL: 30, // 30 seconds - poller lock expires if not refreshed
};

// Redis key prefixes
export const REDIS_KEYS = {
  HEARTBEAT: 'polling:heartbeat',
  POLLER: 'polling:poller',
  MODE: 'polling:mode',
  LAST_ID: (restaurantId: string, currency: string) => `lastId:${restaurantId}:${currency}`,
  TRANSFERS_STREAM: (restaurantId: string, env: 'prod' | 'dev') => `transfers:${restaurantId}:${env}`,
  SYSTEM_BROADCAST: 'system:broadcasts',
};
