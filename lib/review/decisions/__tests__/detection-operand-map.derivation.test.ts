import { describe, expect, it, vi } from 'vitest';

/**
 * Module 06 (Review & Graduation), frame 4.10 — proves the derivation logic
 * for the two detection analytics with a real, non-guessed fixed constant
 * (`REENTRY_THRESHOLD_SECONDS`/`CONSECUTIVE_LOSS_STREAK_THRESHOLD`,
 * `lib/analytics/detection-engine/occurrence-detectors.ts`) is CORRECT,
 * not untested dead code — those branches are unreachable in production
 * today only because of the `computableToday` gate (see `detection-
 * operand-map.test.ts`, kept in its own file so this module mock cannot
 * leak into that file's real-catalogue assertions).
 */
vi.mock('@/lib/rules/operand-catalogue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rules/operand-catalogue')>();
  return {
    ...actual,
    getOperand: (id: string) => {
      const entry = actual.getOperand(id);
      if (!entry) return entry;
      if (id === 'time_since_last_loss' || id === 'consecutive_losses') return { ...entry, computableToday: true };
      return entry;
    },
  };
});

describe('resolveDetectionRuleProposal — derivation logic, once computableToday is forced true', () => {
  it('seq.reentry_after_loss derives gte with the 90s constant rounded up to whole minutes', async () => {
    const { resolveDetectionRuleProposal } = await import('../detection-operand-map');
    const proposal = resolveDetectionRuleProposal('seq.reentry_after_loss');
    expect(proposal).not.toBeNull();
    expect(proposal!.operand.id).toBe('time_since_last_loss');
    expect(proposal!.op).toBe('gte');
    expect(proposal!.value).toBe(2); // ceil(90s / 60) = 2 minutes
  });

  it('seq.consecutive_losses derives lte with the streak-threshold constant (2)', async () => {
    const { resolveDetectionRuleProposal } = await import('../detection-operand-map');
    const proposal = resolveDetectionRuleProposal('seq.consecutive_losses');
    expect(proposal).not.toBeNull();
    expect(proposal!.operand.id).toBe('consecutive_losses');
    expect(proposal!.op).toBe('lte');
    expect(proposal!.value).toBe(2);
  });

  it('the three per-user-statistic analytics still resolve to null even with computableToday forced (no fixed constant exists for them)', async () => {
    const { resolveDetectionRuleProposal } = await import('../detection-operand-map');
    expect(resolveDetectionRuleProposal('seq.trades_per_day')).toBeNull();
    expect(resolveDetectionRuleProposal('seq.daily_loss_breach')).toBeNull();
    expect(resolveDetectionRuleProposal('risk.spread')).toBeNull();
  });
});
