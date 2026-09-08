import { describe, expect, it } from 'vitest';
import { syncTierAtLeast } from '../sync-tier';

describe('syncTierAtLeast', () => {
  it('an account meets a requirement at its own tier', () => {
    expect(syncTierAtLeast('t0', 't0')).toBe(true);
    expect(syncTierAtLeast('t1', 't1')).toBe(true);
    expect(syncTierAtLeast('t2', 't2')).toBe(true);
  });

  it('a higher account tier meets a lower requirement', () => {
    expect(syncTierAtLeast('t1', 't0')).toBe(true);
    expect(syncTierAtLeast('t2', 't0')).toBe(true);
    expect(syncTierAtLeast('t2', 't1')).toBe(true);
  });

  it('a lower account tier does not meet a higher requirement', () => {
    expect(syncTierAtLeast('t0', 't1')).toBe(false);
    expect(syncTierAtLeast('t0', 't2')).toBe(false);
    expect(syncTierAtLeast('t1', 't2')).toBe(false);
  });

  it('an unrecognised account tier string fails closed to the least capable tier, never to unlimited', () => {
    expect(syncTierAtLeast('not-a-real-tier', 't0')).toBe(true); // t0 is trivially satisfied by the fallback rank
    expect(syncTierAtLeast('not-a-real-tier', 't1')).toBe(false);
  });
});
