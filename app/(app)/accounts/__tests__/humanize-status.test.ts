import { describe, expect, it, vi } from 'vitest';

// page.tsx transitively imports lib/broker/accounts-repository.ts (and,
// through it, lib/supabase/direct.ts), both `import 'server-only'` —
// same reason every other test in this repo that reaches such a module
// mocks it (see lib/supabase/__tests__/service.test.ts). This is a unit
// test of one pure string-transformation helper, not a live-network or
// live-DB claim.
vi.mock('server-only', () => ({}));

const { humanizeStatus } = await import('../page');

/**
 * Regression test for a retrospeq-qa finding (2026-08-21): the account
 * list's `StatusChip` previously hardcoded the label `'Pending'` for
 * ANY status value it didn't specifically recognise — including the
 * real `'plan_limited'` value story 4.4's downgrade path
 * (`lib/entitlements/downgrade.ts`) now writes to `trading_accounts.status`.
 * `'Pending'` reads as "still connecting," which actively misleads a
 * trader whose account was downgraded, the opposite of "degrades
 * honestly." `humanizeStatus` is the fix: a readable fallback derived
 * from the actual status string, never a reassuring-sounding guess.
 */
describe('app/(app)/accounts/page.tsx humanizeStatus', () => {
  it('turns the real plan_limited status into a readable label — the exact case that was previously mislabeled "Pending"', () => {
    expect(humanizeStatus('plan_limited')).toBe('Plan limited');
  });

  it('capitalises only the first word of a multi-word status', () => {
    expect(humanizeStatus('some_future_status')).toBe('Some future status');
  });

  it('handles a single-word status with no underscore', () => {
    expect(humanizeStatus('pending')).toBe('Pending');
  });

  it('never crashes on an empty string', () => {
    expect(humanizeStatus('')).toBe('');
  });

  it('handles a status with a leading/trailing/doubled underscore without throwing or producing an empty word', () => {
    expect(humanizeStatus('_weird__status_')).toBe('Weird status');
  });
});
