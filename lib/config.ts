// Restaurant configuration for merchant-hub

import { RestaurantConfig } from '@/types';

export const RESTAURANTS: RestaurantConfig[] = [
  {
    id: 'indies',
    name: 'Indies Restaurant',
    accounts: {
      prod: process.env.INDIES_ACCOUNT || 'indies.cafe',
      dev: process.env.INDIES_DEV_ACCOUNT || 'indies-test',
    },
    currencies: ['HBD', 'EURO', 'OCLT'],
    memoFilters: {
      HBD: '%TABLE %',
      EURO: '%TABLE %',
      OCLT: '%TABLE %',
    },
  },
  {
    id: 'croque-bedaine',
    name: 'Le Croque Bedaine',
    accounts: {
      prod: process.env.CROQUE_ACCOUNT || 'croque.bedaine',
      dev: process.env.CROQUE_DEV_ACCOUNT || 'croque-test',
    },
    currencies: ['HBD', 'EURO', 'OCLT'],
    memoFilters: {
      HBD: '%TABLE %',
      EURO: '%TABLE %',
      OCLT: '%TABLE %',
    },
  },
];

// Get the appropriate account based on environment
export function getRestaurantAccount(restaurant: RestaurantConfig): string {
  return process.env.NODE_ENV === 'production'
    ? restaurant.accounts.prod
    : restaurant.accounts.dev;
}

// Get ALL accounts (both prod and dev) for batched polling
// Since we're using O(1) batched queries, querying all accounts has negligible cost
export function getAllAccounts(): { account: string; restaurant: RestaurantConfig; env: 'prod' | 'dev' }[] {
  const allAccounts: { account: string; restaurant: RestaurantConfig; env: 'prod' | 'dev' }[] = [];

  for (const restaurant of RESTAURANTS) {
    allAccounts.push({
      account: restaurant.accounts.prod,
      restaurant,
      env: 'prod'
    });
    allAccounts.push({
      account: restaurant.accounts.dev,
      restaurant,
      env: 'dev'
    });
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
  TRANSFERS_STREAM: (restaurantId: string) => `transfers:${restaurantId}`,
  SYSTEM_BROADCAST: 'system:broadcasts',
};
