'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';

interface ConsumerGroup {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
}

interface StreamInfo {
  length: number;
  consumerGroups: ConsumerGroup[];
  error?: string;
}

interface RestaurantStatus {
  id: string;
  name: string;
  accounts: { prod: string; dev: string };
  currencies: string[];
  stream: StreamInfo;
  lastIds: {
    prod: Record<string, string>;
    dev: Record<string, string>;
  };
}

interface StatusData {
  timestamp: number;
  polling: {
    heartbeat: number | null;
    isActive: boolean;
    poller: string | null;
    mode: string | null;
    timeSinceLastPoll: number | null;
    heartbeatTimeout: number;
  };
  restaurants: RestaurantStatus[];
  systemBroadcasts: StreamInfo;
}

function StatusDot({ status }: { status: 'green' | 'yellow' | 'red' }) {
  const colors = {
    green: 'bg-emerald-500 shadow-emerald-500/50',
    yellow: 'bg-yellow-500 shadow-yellow-500/50',
    red: 'bg-red-500 shadow-red-500/50',
  };
  return (
    <span className={`inline-block w-3 h-3 rounded-full shadow-lg ${colors[status]}`} />
  );
}

function formatMs(ms: number | null): string {
  if (ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

function formatLastId(id: string): string {
  if (id === '0') return '0';
  // Shorten large IDs for display
  if (id.length > 12) return id.slice(0, 6) + '...' + id.slice(-4);
  return id;
}

export default function Dashboard() {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string>('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: StatusData = await res.json();
      setData(json);
      setError('');
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to fetch status');
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchStatus]);

  const pollingStatus = data?.polling.isActive ? 'green'
    : data?.polling.heartbeat ? 'yellow'
    : 'red';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-[family-name:var(--font-geist-sans)]">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image
              src="/favicon-96x96.png"
              alt="Innopay"
              width={40}
              height={40}
              className="rounded-lg"
            />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Merchant Hub</h1>
              <p className="text-xs text-zinc-500">System Health Dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                className="accent-emerald-500"
              />
              Auto-refresh (10s)
            </label>
            <button
              onClick={fetchStatus}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors text-zinc-300"
            >
              Refresh
            </button>
            {lastRefresh && (
              <span className="text-zinc-500 text-xs">
                {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Error */}
        {error && (
          <div className="bg-red-950 border border-red-800 rounded-lg p-4 text-red-300">
            {error}
          </div>
        )}

        {/* Loading */}
        {!data && !error && (
          <div className="text-center py-20 text-zinc-500">Loading...</div>
        )}

        {data && (
          <>
            {/* Polling Status */}
            <section className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
              <div className="flex items-center gap-3 mb-4">
                <StatusDot status={pollingStatus} />
                <h2 className="text-lg font-semibold">Polling Engine</h2>
                <span className={`text-xs px-2 py-0.5 rounded-full font-mono ${
                  data.polling.isActive
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                    : 'bg-red-950 text-red-400 border border-red-800'
                }`}>
                  {data.polling.isActive ? 'ACTIVE' : 'INACTIVE'}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider">Mode</p>
                  <p className="font-mono text-sm mt-1">
                    {data.polling.mode || '--'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider">Poller</p>
                  <p className="font-mono text-sm mt-1 truncate" title={data.polling.poller || ''}>
                    {data.polling.poller || '--'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider">Last Poll</p>
                  <p className={`font-mono text-sm mt-1 ${
                    data.polling.timeSinceLastPoll && data.polling.timeSinceLastPoll > data.polling.heartbeatTimeout
                      ? 'text-yellow-400' : ''
                  }`}>
                    {formatMs(data.polling.timeSinceLastPoll)} ago
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider">Heartbeat Timeout</p>
                  <p className="font-mono text-sm mt-1">
                    {formatMs(data.polling.heartbeatTimeout)}
                  </p>
                </div>
              </div>
            </section>

            {/* Restaurants */}
            <section>
              <h2 className="text-lg font-semibold mb-4">
                Registered Spokes
                <span className="text-zinc-500 font-normal text-sm ml-2">({data.restaurants.length})</span>
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {data.restaurants.map(r => {
                  const totalPending = r.stream.consumerGroups.reduce((sum, g) => sum + g.pending, 0);
                  const streamStatus: 'green' | 'yellow' | 'red' = r.stream.error ? 'red'
                    : totalPending > 10 ? 'yellow'
                    : 'green';

                  return (
                    <div key={r.id} className="bg-zinc-900 rounded-xl border border-zinc-800 p-5">
                      {/* Restaurant header */}
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h3 className="font-semibold text-base">{r.name}</h3>
                          <p className="text-xs text-zinc-500 font-mono">
                            {r.accounts.prod} / {r.accounts.dev}
                          </p>
                        </div>
                        <StatusDot status={streamStatus} />
                      </div>

                      {/* Stream info */}
                      <div className="mb-4">
                        <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
                          Stream: transfers:{r.id}
                        </p>
                        <div className="flex gap-6">
                          <div>
                            <span className="text-xs text-zinc-500">Length</span>
                            <p className="font-mono text-lg font-bold">{r.stream.length}</p>
                          </div>
                          <div>
                            <span className="text-xs text-zinc-500">Pending</span>
                            <p className={`font-mono text-lg font-bold ${
                              totalPending > 0 ? 'text-yellow-400' : 'text-emerald-400'
                            }`}>
                              {totalPending}
                            </p>
                          </div>
                          <div>
                            <span className="text-xs text-zinc-500">Groups</span>
                            <p className="font-mono text-lg font-bold">
                              {r.stream.consumerGroups.length}
                            </p>
                          </div>
                        </div>
                        {r.stream.error && (
                          <p className="text-xs text-red-400 mt-1">Stream error: {r.stream.error}</p>
                        )}
                      </div>

                      {/* Consumer groups */}
                      {r.stream.consumerGroups.length > 0 && (
                        <div className="mb-4">
                          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Consumer Groups</p>
                          <div className="space-y-1">
                            {r.stream.consumerGroups.map(g => (
                              <div key={g.name} className="flex items-center justify-between text-xs bg-zinc-800/50 rounded px-2 py-1">
                                <span className="font-mono">{g.name}</span>
                                <span className="text-zinc-400">
                                  {g.consumers} consumer{g.consumers !== 1 ? 's' : ''}, {' '}
                                  <span className={g.pending > 0 ? 'text-yellow-400' : 'text-emerald-400'}>
                                    {g.pending} pending
                                  </span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* LastIds */}
                      <div>
                        <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Last Processed IDs</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                          {['prod', 'dev'].map(env => (
                            <div key={env}>
                              <span className={`uppercase font-bold ${env === 'prod' ? 'text-emerald-500' : 'text-blue-500'}`}>
                                {env}
                              </span>
                              {r.currencies.map(c => (
                                <div key={c} className="flex justify-between font-mono text-zinc-400 ml-2">
                                  <span>{c}</span>
                                  <span title={r.lastIds[env as 'prod' | 'dev'][c]}>
                                    {formatLastId(r.lastIds[env as 'prod' | 'dev'][c])}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* System Broadcasts */}
            <section className="bg-zinc-900 rounded-xl border border-zinc-800 p-5">
              <div className="flex items-center gap-3">
                <h2 className="text-base font-semibold">System Broadcasts</h2>
                <span className="font-mono text-sm text-zinc-400">
                  {data.systemBroadcasts.length} messages
                </span>
              </div>
              {data.systemBroadcasts.consumerGroups.length > 0 && (
                <div className="mt-2 space-y-1">
                  {data.systemBroadcasts.consumerGroups.map(g => (
                    <div key={g.name} className="flex items-center justify-between text-xs bg-zinc-800/50 rounded px-2 py-1">
                      <span className="font-mono">{g.name}</span>
                      <span className="text-zinc-400">
                        {g.pending} pending
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
