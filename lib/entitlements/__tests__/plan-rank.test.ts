import { describe, expect, it } from 'vitest';
import { planAtLeast } from '../plan-rank';

describe('planAtLeast', () => {
  it('a plan meets its own requirement', () => {
    expect(planAtLeast('free', 'free')).toBe(true);
    expect(planAtLeast('pro', 'pro')).toBe(true);
  });

  it('pro meets a free requirement', () => {
    expect(planAtLeast('pro', 'free')).toBe(true);
  });

  it('free does not meet a pro requirement', () => {
    expect(planAtLeast('free', 'pro')).toBe(false);
  });
});
