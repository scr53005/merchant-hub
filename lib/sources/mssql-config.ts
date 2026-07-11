// Pure mssql:// URI → mssql config translation.
//
// The `mssql` package does NOT parse `mssql://` URIs (only ADO.NET-style
// strings or config objects) — Phase 0 finding. HiveSQL's credentials are
// distributed as a URI, so translate here. No mssql import: this module
// stays pure so tests can cover it without a driver or env vars.

export interface MssqlConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  options: {
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
  connectionTimeout: number;
  requestTimeout: number;
  pool: { max: number; min: number };
}

export function uriToMssqlConfig(uri: string): MssqlConfig {
  const u = new URL(uri);
  return {
    server: u.hostname,
    port: u.port ? Number(u.port) : 1433,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    // URL-decode so special chars in the password survive
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    options: {
      encrypt: u.searchParams.get('encrypt') !== 'false',
      trustServerCertificate: u.searchParams.get('trustServerCertificate') === 'true',
    },
    connectionTimeout: 30000,
    // 60s: same budget as the HAFSQL pool's query_timeout
    requestTimeout: 60000,
    // Small on purpose: serverless instances multiply pools, and HiveSQL
    // accounts have connection limits
    pool: { max: 3, min: 0 },
  };
}
