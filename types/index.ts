// TypeScript types for merchant-hub

export interface RestaurantConfig {
  id: string;
  name: string;
  accounts: {
    prod: string;
    dev: string;
  };
  currencies: Currency[];
  memoFilters: {
    [key in Currency]?: string;
  };
}

export type Currency = 'HBD' | 'EURO' | 'HIVE' | 'OCLT';

export interface Transfer {
  id: string;
  restaurant_id: string;
  account: string; // The Hive account that received the transfer (e.g., 'indies.cafe' or 'indies-test')
  from_account: string;
  amount: string;
  symbol: Currency;
  memo: string;
  parsed_memo?: string;
  received_at: string;
  block_num?: number;
}

export interface PollingState {
  heartbeat: number; // timestamp
  poller: string | null; // shop ID
  mode: 'active-6s' | 'sleeping-1min';
}

export interface SystemBroadcast {
  type: 'polling-started' | 'polling-stopped' | 'takeover-needed' | 'all-sleeping';
  poller?: string;
  mode?: 'active-6s' | 'sleeping-1min';
  timestamp: number;
}
