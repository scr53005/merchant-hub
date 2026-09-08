// Restaurant configuration for merchant-hub

import { RestaurantConfig } from '@/types';

// Parse comma-separated env var into array of account names
function parseAdditionalAccounts(envVar?: string): string[] {
  return (envVar || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Historical reporting only: these accounts do not activate Redis order polling.
// Move a future spoke into RESTAURANTS when its payment/CO integration is enabled.
export const REPORTING_ONLY_ACCOUNTS = parseAdditionalAccounts(
  process.env.REPORTING_ONLY_ACCOUNTS || 'al21-2025',
);

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
    currencies: ['HBD', 'EURO', 'OCLT', 'RUBIS'],
    memoFilters: {
      // Filter on distriate pattern - allows both dine-in (TABLE X) and takeaway orders
      HBD: '%-inno-%',
      EURO: '%-inno-%',
      OCLT: '%-inno-%',
      RUBIS: '%-inno-%',
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
    currencies: ['HBD', 'EURO', 'OCLT', 'RUBIS'],
    memoFilters: {
      // Filter on distriate pattern - allows both dine-in (TABLE X) and takeaway orders
      HBD: '%-inno-%',
      EURO: '%-inno-%',
      OCLT: '%-inno-%',
      RUBIS: '%-inno-%',
    },
  },
  {
    id: 'millewee',
    name: 'Café-Brasserie Millewee',
    accounts: {
      prod: (process.env.MILLEWEE_ACCOUNT || 'millewee').trim(),
      dev: (process.env.MILLEWEE_DEV_ACCOUNT || 'innodemo').trim(),
    },
    additionalAccounts: {
      prod: parseAdditionalAccounts(process.env.MILLEWEE_ADDITIONAL_PROD_ACCOUNTS),
      dev: parseAdditionalAccounts(process.env.MILLEWEE_ADDITIONAL_DEV_ACCOUNTS),
    },
    currencies: ['HBD', 'EURO', 'OCLT', 'RUBIS'],
    memoFilters: {
      HBD: '%-inno-%',
      EURO: '%-inno-%',
      OCLT: '%-inno-%',
      RUBIS: '%-inno-%',
    },
  },
  {
    // Multi-tenant "Farm" spoke (innohatch): ONE merchant-hub entry serves the
    // PoC on the shared dev account hatch-test; per-vendor accounts get their
    // own entries (or registry-driven config) before real vendors onboard —
    // see HATCHERY-PLAN.md §14 Phase 2. Prod account is a placeholder until
    // a prod vendor exists (polling a nonexistent account returns no rows).
    id: 'innohatch',
    name: 'Innopay Farm (innohatch)',
    accounts: {
      prod: (process.env.INNOHATCH_ACCOUNT || 'innohatch').trim(),
      dev: (process.env.INNOHATCH_DEV_ACCOUNT || 'hatch-test').trim(),
    },
    additionalAccounts: {
      prod: parseAdditionalAccounts(process.env.INNOHATCH_ADDITIONAL_PROD_ACCOUNTS),
      dev: parseAdditionalAccounts(process.env.INNOHATCH_ADDITIONAL_DEV_ACCOUNTS),
    },
    currencies: ['HBD', 'EURO', 'OCLT', 'RUBIS'],
    memoFilters: {
      HBD: '%-inno-%',
      EURO: '%-inno-%',
      OCLT: '%-inno-%',
      RUBIS: '%-inno-%',
    },
  },
  {
    // Romania spoke: prices in RON, IOU token is LEI (not EURO). Dedicated dev account
    // zenbar-test (NOT shared innodemo). See project_zenbar_spoke memory.
    id: 'zenbar',
    name: 'Zen Bar',
    accounts: {
      prod: (process.env.ZENBAR_ACCOUNT || 'zenbar').trim(),
      dev: (process.env.ZENBAR_DEV_ACCOUNT || 'zenbar-test').trim(),
    },
    additionalAccounts: {
      prod: parseAdditionalAccounts(process.env.ZENBAR_ADDITIONAL_PROD_ACCOUNTS),
      dev: parseAdditionalAccounts(process.env.ZENBAR_ADDITIONAL_DEV_ACCOUNTS),
    },
    currencies: ['HBD', 'LEI', 'OCLT', 'RUBIS'],
    memoFilters: {
      HBD: '%-inno-%',
      LEI: '%-inno-%',
      OCLT: '%-inno-%',
      RUBIS: '%-inno-%',
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
