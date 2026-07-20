import { describe, it, expect } from 'vitest';
// Import the redis-free PURE core: the I/O module (dynamic-accounts.ts)
// pulls in ./redis, which throws at load without Upstash creds — a pure
// unit test must not depend on live credentials.
import {
  encodeAccountValue,
  decodeAccountValue,
  computeReconcile,
  validateRegistration,
  type DynamicAccountRecord,
} from '@/lib/dynamic-accounts-core';

describe('encode/decode account value', () => {
  it('round-trips restaurantId + env', () => {
    expect(decodeAccountValue(encodeAccountValue('innohatch', 'prod'))).toEqual({
      restaurantId: 'innohatch',
      env: 'prod',
    });
  });

  it('handles restaurant ids containing hyphens (croque-bedaine)', () => {
    // lastIndexOf(':') means only the final :env is split off
    expect(decodeAccountValue('croque-bedaine:dev')).toEqual({
      restaurantId: 'croque-bedaine',
      env: 'dev',
    });
  });

  it('rejects malformed values', () => {
    expect(decodeAccountValue('noenv')).toBeNull();
    expect(decodeAccountValue('innohatch:staging')).toBeNull();
    expect(decodeAccountValue(':prod')).toBeNull();
  });
});

describe('computeReconcile', () => {
  const desired: DynamicAccountRecord[] = [
    { account: 'mcc.cart', restaurantId: 'innohatch', env: 'prod' },
    { account: 'kcc.cart', restaurantId: 'innohatch', env: 'prod' },
  ];

  it('adds missing accounts', () => {
    const { toSet, toDelete } = computeReconcile({}, desired);
    expect(toSet).toEqual({
      'mcc.cart': 'innohatch:prod',
      'kcc.cart': 'innohatch:prod',
    });
    expect(toDelete).toEqual([]);
  });

  it('removes accounts no longer desired (a de-registered vendor)', () => {
    const current = {
      'mcc.cart': 'innohatch:prod',
      'old.vendor': 'innohatch:prod',
    };
    const { toSet, toDelete } = computeReconcile(current, desired);
    expect(toSet).toEqual({ 'kcc.cart': 'innohatch:prod' });
    expect(toDelete).toEqual(['old.vendor']);
  });

  it('updates a changed env/restaurant', () => {
    const current = { 'mcc.cart': 'innohatch:dev', 'kcc.cart': 'innohatch:prod' };
    const { toSet, toDelete } = computeReconcile(current, desired);
    expect(toSet).toEqual({ 'mcc.cart': 'innohatch:prod' });
    expect(toDelete).toEqual([]);
  });

  it('is a no-op when already in sync', () => {
    const current = { 'mcc.cart': 'innohatch:prod', 'kcc.cart': 'innohatch:prod' };
    const { toSet, toDelete } = computeReconcile(current, desired);
    expect(toSet).toEqual({});
    expect(toDelete).toEqual([]);
  });
});

describe('validateRegistration', () => {
  it('accepts a valid Farm vendor registration', () => {
    expect(validateRegistration('mcc.cart', 'innohatch', 'prod')).toEqual({
      account: 'mcc.cart',
      restaurantId: 'innohatch',
      env: 'prod',
    });
  });

  it('rejects a bad account name', () => {
    expect(validateRegistration('X', 'innohatch', 'prod')).toHaveProperty('error');
    expect(validateRegistration('has spaces', 'innohatch', 'prod')).toHaveProperty('error');
  });

  it('rejects an unknown restaurantId (must exist in config)', () => {
    expect(validateRegistration('mcc.cart', 'no-such-spoke', 'prod')).toHaveProperty('error');
  });

  it('rejects a bad env', () => {
    expect(validateRegistration('mcc.cart', 'innohatch', 'staging')).toHaveProperty('error');
  });
});
