// CORS utility for merchant-hub API routes
// Allows cross-origin requests from both development and production environments

import { NextResponse } from 'next/server';

/**
 * Check if an origin is allowed
 * Allows:
 * - Production co pages (indies.innopay.lu, croque-bedaine.innopay.lu)
 * - Development servers (localhost, 127.0.0.1, 192.168.x.x)
 * - Custom origins from ALLOWED_ORIGINS env var
 */
function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;

  // Check custom allowed origins from env
  const customOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
  if (customOrigins.includes(origin)) {
    return true;
  }

  // Allow production co pages
  const productionOrigins = [
    'https://indies.innopay.lu',
    'https://croque-bedaine.innopay.lu',
  ];
  if (productionOrigins.includes(origin)) {
    return true;
  }

  // Allow development servers (localhost, 127.0.0.1, 192.168.x.x)
  const devPatterns = [
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
    /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
    /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  ];

  return devPatterns.some(pattern => pattern.test(origin));
}

/**
 * Get CORS headers for a request
 */
export function getCorsHeaders(origin?: string | null) {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400', // 24 hours
  };

  // Check if origin is allowed
  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

/**
 * Handle OPTIONS preflight request
 */
export function handleCorsPreflight(request: Request) {
  const origin = request.headers.get('origin');
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

/**
 * Add CORS headers to a response
 */
export function addCorsHeaders(response: NextResponse, request: Request): NextResponse {
  const origin = request.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
}

/**
 * Create a JSON response with CORS headers
 */
export function corsResponse(data: any, request: Request, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  return addCorsHeaders(response, request);
}
