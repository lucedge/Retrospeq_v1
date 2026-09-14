import { describe, expect, it } from 'vitest';
import { getOperand } from '@/lib/rules/operand-catalogue';
import { resolveDetectionRuleProposal } from '../detection-operand-map';

/**
 * Module 06 (Review & Graduation), frame 4.10 — pure, DB-free coverage of
 * `resolveDetectionRuleProposal`'s honesty boundary against the REAL
 * catalogue, mirroring `graduation-operand-map.test.ts`'s own adversarial
 * pattern. See `detection-operand-map.ts`'s own header for why every one
 * of today's five real v1 detection analytics resolving to `null` is the
 * CORRECT, asserted-on-purpose outcome, not an unfinished implementation.
 *
 * The two branches with a real, non-guessed fixed constant to derive from
 * (`seq.reentry_after_loss`, `seq.consecutive_losses`) are proven
 * separately, with `computableToday` forced true, in `detection-operand-
 * map.derivation.test.ts` — kept in its own file so that file's module
 * mock cannot leak into these real-catalogue assertions.
 */
describe('resolveDetectionRuleProposal — the honesty boundary (real catalogue)', () => {
  it('every one of the five real v1 detection analytics resolves to null today, because their mapped operand is either not computableToday or has no persisted threshold to derive from', () => {
    // Asserted against the underlying catalogue facts directly, so a future
    // edit to operand-catalogue.ts that flips one of these can't silently
    // make this test meaningless.
    expect(getOperand('time_since_last_loss')?.computableToday).toBe(false);
    expect(getOperand('consecutive_losses')?.computableToday).toBe(false);

    for (const analyticId of ['seq.reentry_after_loss', 'seq.trades_per_day', 'seq.consecutive_losses', 'seq.daily_loss_breach', 'risk.spread']) {
      expect(resolveDetectionRuleProposal(analyticId)).toBeNull();
    }
  });

  it('ADVERSARIAL: an unknown/unmapped analytic id resolves to null, never a guess or a crash', () => {
    expect(resolveDetectionRuleProposal('seq.unknown_future_analytic')).toBeNull();
    expect(resolveDetectionRuleProposal('')).toBeNull();
  });
});
