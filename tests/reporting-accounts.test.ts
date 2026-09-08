import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('pg', () => ({ Pool: class { query = query; } }));

async function report(accounts: string, multiple = false) {
  const { GET } = await import('@/app/api/reporting/route');
  const params = new URLSearchParams({
    [multiple ? 'accounts' : 'account']: accounts,
    from: '2026-09-01', to: '2026-09-02',
  });
  return GET(new NextRequest(`https://merchant.example/api/reporting?${params}`));
}

describe('reporting-only account integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('REPORTING_ONLY_ACCOUNTS', '');
    vi.stubEnv('INDIES_ACCOUNT', 'indies.cafe');
    vi.stubEnv('INDIES_DEV_ACCOUNT', 'indies-test');
    query.mockReset().mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('queries AL21 history immediately, without any polling or Redis dependency', async () => {
    query.mockResolvedValue({ rows: [{
      id: '123456789012345678', timestamp: '2026-09-01T12:00:00Z',
      from_account: 'payer', to_account: 'al21-2025', amount: '12.500', memo: '', block_num: 123,
    }] });
    const response = await report('al21-2025');
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("t.symbol = 'HBD'"),
      [['al21-2025'], '2026-09-01', '2026-09-03', 5000]);
    expect(await response.json()).toMatchObject({
      accounts: ['al21-2025'], count: 1, truncated: false,
      transactions: [{ id: '123456789012345678', to_account: 'al21-2025', amount: '12.500' }],
    });
  });

  it('keeps AL21 out of the live polling account list', async () => {
    const { REPORTING_ONLY_ACCOUNTS, getAllAccounts } = await import('@/lib/config');
    expect(REPORTING_ONLY_ACCOUNTS).toContain('al21-2025');
    expect(getAllAccounts().map(entry => entry.account)).not.toContain('al21-2025');
  });

  it.each(['indies.cafe', 'indies-test'])('preserves reporting for existing account %s', async account => {
    expect((await report(account)).status).toBe(200);
    expect(query).toHaveBeenCalledOnce();
  });

  it('rejects unknown accounts before querying HAFSQL', async () => {
    expect((await report('unregistered-account')).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a mixed multi-account request containing an unknown account', async () => {
    expect((await report('al21-2025,unregistered-account', true)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('honors the comma-separated environment override without activating polling', async () => {
    vi.stubEnv('REPORTING_ONLY_ACCOUNTS', ' extra-report-account, second-report-account ');
    expect((await report('extra-report-account,second-report-account', true)).status).toBe(200);
    expect((await report('al21-2025')).status).toBe(403);
    const { getAllAccounts } = await import('@/lib/config');
    expect(getAllAccounts().map(entry => entry.account)).not.toContain('extra-report-account');
  });
});
