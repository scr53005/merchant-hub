// Reporting API route - Query HAFSQL for historical HBD transfers to a restaurant account
// GET /api/reporting?account=indies.cafe&from=2025-01-01&to=2025-12-31
//
// Used by spoke admin pages to generate accountant reports.
// Only returns HBD transfers (the real payment currency on Hive blockchain).
//
// HAFSQL schema notes:
//   operation_transfer_table: id, from_account, to_account, amount, symbol, memo (NO block_num, NO timestamp)
//   The operation id must be joined to an operations view to get block_num, then to haf_blocks for timestamp.
//   We try multiple join strategies since the exact intermediate table name varies across HAF deployments.

import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { handleCorsPreflight, corsResponse } from '@/lib/cors';
import { RESTAURANTS } from '@/lib/config';

const hafPool = new Pool({
  connectionString: process.env.HAF_CONNECTION_STRING,
  query_timeout: 8000, // 8s to stay under Vercel 10s limit
});

// Build set of all known accounts (prod + dev) for validation
function getKnownAccounts(): Set<string> {
  const accounts = new Set<string>();
  for (const r of RESTAURANTS) {
    accounts.add(r.accounts.prod);
    accounts.add(r.accounts.dev);
  }
  return accounts;
}

// Join strategies to resolve operation id → timestamp
// haf_operations has both id and timestamp, so a single join suffices (no need for haf_blocks).
// We try multiple schema/table names since HAF deployments may differ.
const JOIN_STRATEGIES = [
  {
    name: 'hafsql.haf_operations (single join, timestamp direct)',
    sql: `SELECT t.id, t.from_account, t.amount, t.memo,
                 o.block_num, o.timestamp
          FROM hafsql.operation_transfer_table t
          JOIN hafsql.haf_operations o ON t.id = o.id
          WHERE t.to_account = $1
            AND t.symbol = 'HBD'
            AND o.timestamp >= $2::timestamp
            AND o.timestamp < $3::timestamp
          ORDER BY o.timestamp ASC
          LIMIT $4`,
  },
  {
    name: 'hive.operations (single join, timestamp direct)',
    sql: `SELECT t.id, t.from_account, t.amount, t.memo,
                 o.block_num, o.timestamp
          FROM hafsql.operation_transfer_table t
          JOIN hive.operations o ON t.id = o.id
          WHERE t.to_account = $1
            AND t.symbol = 'HBD'
            AND o.timestamp >= $2::timestamp
            AND o.timestamp < $3::timestamp
          ORDER BY o.timestamp ASC
          LIMIT $4`,
  },
  {
    name: 'hafsql.haf_operations → haf_blocks (double join fallback)',
    sql: `SELECT t.id, t.from_account, t.amount, t.memo,
                 o.block_num, b.created_at as timestamp
          FROM hafsql.operation_transfer_table t
          JOIN hafsql.haf_operations o ON t.id = o.id
          JOIN hafsql.haf_blocks b ON o.block_num = b.block_num
          WHERE t.to_account = $1
            AND t.symbol = 'HBD'
            AND b.created_at >= $2::timestamp
            AND b.created_at < $3::timestamp
          ORDER BY b.created_at ASC
          LIMIT $4`,
  },
];

// Cache which strategy works so we don't retry failed ones on subsequent requests
let workingStrategyIndex: number | null = null;

export async function OPTIONS(request: Request) {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest) {
  const t0 = Date.now();
  try {
    const { searchParams } = request.nextUrl;
    const account = searchParams.get('account');
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    console.log(`[REPORTING] === New request: account=${account} from=${from} to=${to} ===`);

    // Validate required params
    if (!account || !from || !to) {
      console.log('[REPORTING] Missing required parameters');
      return corsResponse(
        { error: 'Missing required parameters: account, from, to' },
        request,
        { status: 400 }
      );
    }

    // Validate account against known restaurant accounts
    const knownAccounts = getKnownAccounts();
    console.log(`[REPORTING] Known accounts: ${[...knownAccounts].join(', ')}`);
    if (!knownAccounts.has(account)) {
      console.log(`[REPORTING] REJECTED: unknown account "${account}"`);
      return corsResponse(
        { error: 'Unknown account' },
        request,
        { status: 403 }
      );
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from) || !dateRegex.test(to)) {
      return corsResponse(
        { error: 'Invalid date format. Use YYYY-MM-DD.' },
        request,
        { status: 400 }
      );
    }

    // Add one day to 'to' date so it's inclusive (< to+1 day)
    const toExclusive = new Date(to);
    toExclusive.setDate(toExclusive.getDate() + 1);
    const toExclusiveStr = toExclusive.toISOString().split('T')[0];
    console.log(`[REPORTING] Date range: ${from} to ${toExclusiveStr} (exclusive)`);

    const LIMIT = 5000;

    // Try join strategies to get timestamps for operations
    let rows: any[] | null = null;
    let usedStrategy = '';
    const errors: string[] = [];

    // If we already know which strategy works, try it first
    if (workingStrategyIndex !== null) {
      console.log(`[REPORTING] Cached working strategy: #${workingStrategyIndex} "${JOIN_STRATEGIES[workingStrategyIndex].name}"`);
    } else {
      console.log(`[REPORTING] No cached strategy yet, will try all ${JOIN_STRATEGIES.length} strategies`);
    }
    const strategiesToTry = workingStrategyIndex !== null
      ? [JOIN_STRATEGIES[workingStrategyIndex], ...JOIN_STRATEGIES.filter((_, i) => i !== workingStrategyIndex)]
      : JOIN_STRATEGIES;

    for (let i = 0; i < strategiesToTry.length; i++) {
      const strategy = strategiesToTry[i];
      const tQuery = Date.now();
      try {
        console.log(`[REPORTING] Trying strategy ${i + 1}/${strategiesToTry.length}: "${strategy.name}"`);
        console.log(`[REPORTING]   SQL params: [$1=${account}, $2=${from}, $3=${toExclusiveStr}, $4=${LIMIT}]`);
        const result = await hafPool.query(strategy.sql, [account, from, toExclusiveStr, LIMIT]);
        rows = result.rows;
        usedStrategy = strategy.name;
        workingStrategyIndex = JOIN_STRATEGIES.indexOf(strategy);
        console.log(`[REPORTING]   SUCCESS in ${Date.now() - tQuery}ms — ${rows.length} rows returned`);
        if (rows.length > 0) {
          const first = rows[0];
          console.log(`[REPORTING]   First row: id=${first.id} from=${first.from_account} amount=${first.amount} block=${first.block_num} ts=${first.timestamp}`);
          const last = rows[rows.length - 1];
          console.log(`[REPORTING]   Last row:  id=${last.id} from=${last.from_account} amount=${last.amount} block=${last.block_num} ts=${last.timestamp}`);
        }
        break;
      } catch (err: any) {
        console.warn(`[REPORTING]   FAILED in ${Date.now() - tQuery}ms: ${err.message}`);
        errors.push(`${strategy.name}: ${err.message}`);
      }
    }

    if (rows === null) {
      // All strategies failed - log schema discovery info for debugging
      console.error('[REPORTING] ALL JOIN STRATEGIES FAILED. Errors:');
      errors.forEach((e, i) => console.error(`[REPORTING]   ${i + 1}. ${e}`));

      // Discover available tables/views for debugging
      try {
        console.log('[REPORTING] Running schema discovery...');
        const schemaResult = await hafPool.query(
          `SELECT table_schema, table_name, table_type
           FROM information_schema.tables
           WHERE table_schema IN ('hafsql', 'hive')
             AND (table_name LIKE '%operation%' OR table_name LIKE '%block%')
           ORDER BY table_schema, table_name`
        );
        console.log('[REPORTING] Available HAF tables/views:');
        schemaResult.rows.forEach((r: any) =>
          console.log(`[REPORTING]   ${r.table_schema}.${r.table_name} (${r.table_type})`)
        );

        // Also try to discover columns on haf_operations if it exists
        const colResult = await hafPool.query(
          `SELECT column_name, data_type
           FROM information_schema.columns
           WHERE table_schema = 'hafsql' AND table_name = 'haf_operations'
           ORDER BY ordinal_position`
        );
        if (colResult.rows.length > 0) {
          console.log('[REPORTING] Columns in hafsql.haf_operations:');
          colResult.rows.forEach((r: any) =>
            console.log(`[REPORTING]   ${r.column_name} (${r.data_type})`)
          );
        }
      } catch (schemaErr: any) {
        console.error(`[REPORTING] Schema discovery also failed: ${schemaErr.message}`);
      }

      return corsResponse(
        {
          error: 'Could not resolve timestamps for transfers. All join strategies failed.',
          strategies_tried: errors,
        },
        request,
        { status: 500 }
      );
    }

    const transactions = rows.map((row: any) => ({
      id: row.id.toString(),
      timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : null,
      from_account: row.from_account,
      amount: row.amount,
      memo: row.memo || '',
      block_num: row.block_num ? Number(row.block_num) : undefined,
    }));

    const elapsed = Date.now() - t0;
    console.log(`[REPORTING] === Done: ${transactions.length} transactions, truncated=${transactions.length >= LIMIT}, ${elapsed}ms total ===`);

    return corsResponse({
      account,
      from,
      to,
      transactions,
      count: transactions.length,
      truncated: transactions.length >= LIMIT,
      _strategy: usedStrategy,
      _elapsed_ms: elapsed,
    }, request);

  } catch (error: any) {
    console.error(`[REPORTING] UNHANDLED ERROR (${Date.now() - t0}ms): ${error.message}`);
    console.error(`[REPORTING] Stack: ${error.stack}`);
    return corsResponse(
      { error: 'Failed to fetch reporting data', details: error.message },
      request,
      { status: 500 }
    );
  }
}
