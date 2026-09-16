import { describe, expect, it } from 'vitest';
import { usageDisplay, usageLabel } from '../usage';

describe('usageDisplay', () => {
  it('renders a real, counted fraction', () => {
    const d = usageDisplay({ allowed: true, reason: 'ok', limit: 3, used: 1 });
    expect(d).toEqual({ kind: 'fraction', used: 1, limit: 3, atLimit: false });
    expect(usageLabel(d)).toBe('1 of 3');
  });

  it('marks a fraction that has reached its cap', () => {
    expect(usageDisplay({ allowed: false, reason: 'quota', limit: 3, used: 3 })).toEqual({
      kind: 'fraction',
      used: 3,
      limit: 3,
      atLimit: true,
    });
  });

  it('never renders an unlimited cap as a fraction', () => {
    const d = usageDisplay({ allowed: true, reason: 'ok', limit: null });
    expect(d).toEqual({ kind: 'unlimited' });
    expect(usageLabel(d)).toBe('Unlimited');
  });

  it('never renders a plan exclusion as "0 of 0"', () => {
    const d = usageDisplay({ allowed: false, reason: 'plan', limit: 0 });
    expect(d).toEqual({ kind: 'plan-excluded' });
    expect(usageLabel(d)).toBe('Pro only');
  });

  it('says so when no counter ran, rather than showing zero', () => {
    const d = usageDisplay({ allowed: false, reason: 'not_yet_checkable', limit: 3 });
    expect(d).toEqual({ kind: 'unknown' });
    expect(usageLabel(d)).toBe('Not counted yet');
  });
});
