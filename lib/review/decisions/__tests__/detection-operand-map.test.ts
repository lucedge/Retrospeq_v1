import { describe, expect, it } from 'vitest';
import { getOperand } from '@/lib/rules/operand-catalogue';
import { resolveDetectionRuleProposal } from '../detection-operand-map';

/**
 * Module 06 (Review & Graduation), frame 4.10 — pure, DB-free coverage of
 * `resolveDetectionRuleProposal`'s honesty boundary against the REAL
 * catalogue, mirroring `graduation-operand-map.test.ts`'s own adversarial
 * pattern. See `detection-operand-map.ts`'s own header for the full
 * "ORIGINAL / UPDATE" history — as of the follow-up slice that made
 * `time_since_last_loss`/`consecutive_losses` genuinely `computableToday:
 * true` (real freeze-wiring, not a flag flip taken on faith), TWO of the
 * five real v1 detection analytics now resolve to a real proposal for
 * real, against the real, unmocked catalogue — no module mock needed
 * anymore (the previous `detection-operand-map.derivation.test.ts`, which
 * force-mocked `computableToday` to prove this derivation logic ahead of
 * the flag flip, is folded into this file now that the mock is no longer
 * necessary to reach these branches).
 */
describe('resolveDetectionRuleProposal — the honesty boundary (real catalogue)', () => {
  it('time_since_last_loss and consecutive_losses are genuinely computableToday: true today (freeze-wiring is real)', () => {
    expect(getOperand('time_since_last_loss')?.computableToday).toBe(true);
    expect(getOperand('consecutive_losses')?.computableToday).toBe(true);
  });

  it('seq.reentry_after_loss derives gte with the 90s constant rounded up to whole minutes', () => {
    const proposal = resolveDetectionRuleProposal('seq.reentry_after_loss');
    expect(proposal).not.toBeNull();
    expect(proposal!.operand.id).toBe('time_since_last_loss');
    expect(proposal!.op).toBe('gte');
    expect(proposal!.value).toBe(2); // ceil(90s / 60) = 2 minutes
  });

  it('seq.consecutive_losses derives lte with the streak-threshold constant (2)', () => {
    const proposal = resolveDetectionRuleProposal('seq.consecutive_losses');
    expect(proposal).not.toBeNull();
    expect(proposal!.operand.id).toBe('consecutive_losses');
    expect(proposal!.op).toBe('lte');
    expect(proposal!.value).toBe(2);
  });

  it('the three per-user-statistic analytics still resolve to null — no persisted threshold/fence exists on retrospeq.detections for any of them, unrelated to computableToday', () => {
    for (const analyticId of ['seq.trades_per_day', 'seq.daily_loss_breach', 'risk.spread']) {
      expect(resolveDetectionRuleProposal(analyticId)).toBeNull();
    }
  });

  it('trades_today and daily_loss_pct are ALSO computableToday: true now, but that alone does not make seq.trades_per_day/seq.daily_loss_breach resolve — confirms the remaining null is genuinely about the missing persisted baseline, not a stale operand flag', () => {
    expect(getOperand('trades_today')?.computableToday).toBe(true);
    expect(getOperand('daily_loss_pct')?.computableToday).toBe(true);
    expect(resolveDetectionRuleProposal('seq.trades_per_day')).toBeNull();
    expect(resolveDetectionRuleProposal('seq.daily_loss_breach')).toBeNull();
  });

  it('ADVERSARIAL: an unknown/unmapped analytic id resolves to null, never a guess or a crash', () => {
    expect(resolveDetectionRuleProposal('seq.unknown_future_analytic')).toBeNull();
    expect(resolveDetectionRuleProposal('')).toBeNull();
  });
});
