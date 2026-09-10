import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluateDecayCheck } from '../decay-engine';

/**
 * Module 05 §4.11 — decay checking, the pure half. Fresh fixtures for
 * this dispatch (per AGENTS.md, not reused from the coder's own tests).
 *
 * The spec's own pseudocode:
 *
 *   every 30 new trades in the segment:
 *       recompute the finding
 *       if current_delta < 0.5 * delta_at_graduation:
 *           consecutive_decay_checks += 1
 *       else:
 *           consecutive_decay_checks = 0
 *       if consecutive_decay_checks >= 2:
 *           emit decay signal
 *
 * "Two consecutive checks, because one is noise" is the load-bearing
 * invariant under adversarial test here: the counter must RESET to zero
 * on any single non-decaying check, never merely hold, decrement, or
 * accumulate past a recovery.
 */

describe('evaluateDecayCheck — basic control flow', () => {
  it('increments the streak by exactly 1 on a single below-half check', () => {
    const result = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: 0.05, consecutiveDecayChecksBefore: 0 });
    expect(result.consecutiveDecayChecksAfter).toBe(1);
    expect(result.decaySignalEmitted).toBe(false);
  });

  it('emits the decay signal exactly when the streak reaches 2, not before', () => {
    const first = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: 0.05, consecutiveDecayChecksBefore: 0 });
    expect(first.decaySignalEmitted).toBe(false);
    const second = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: 0.05, consecutiveDecayChecksBefore: first.consecutiveDecayChecksAfter });
    expect(second.consecutiveDecayChecksAfter).toBe(2);
    expect(second.decaySignalEmitted).toBe(true);
  });

  it('a single below-threshold check followed by a recovery resets the streak to zero, not to 1 or unchanged', () => {
    const decay = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: 0.01, consecutiveDecayChecksBefore: 0 });
    expect(decay.consecutiveDecayChecksAfter).toBe(1);
    const recovery = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: 0.2, consecutiveDecayChecksBefore: decay.consecutiveDecayChecksAfter });
    expect(recovery.consecutiveDecayChecksAfter).toBe(0);
    expect(recovery.decaySignalEmitted).toBe(false);
  });

  it('a long pre-existing streak is fully cleared by one recovery check, not decremented', () => {
    // Simulates a corrupted/pre-seeded counter of 9 (should never happen
    // via this function alone, but the reset behaviour must not depend on
    // how the counter got where it is — a single recovery clears it fully).
    const recovery = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: 0.2, consecutiveDecayChecksBefore: 9 });
    expect(recovery.consecutiveDecayChecksAfter).toBe(0);
  });

  it('the boundary itself (currentDelta exactly half of deltaAtGraduation) does NOT count as decaying — the test is strictly "<"', () => {
    const result = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: 0.1, consecutiveDecayChecksBefore: 0 });
    expect(result.consecutiveDecayChecksAfter).toBe(0);
  });

  it('a currentDelta fractionally below half does count as decaying', () => {
    const result = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: 0.0999, consecutiveDecayChecksBefore: 0 });
    expect(result.consecutiveDecayChecksAfter).toBe(1);
  });

  it('a negative currentDelta (edge fully inverted) always counts as decaying relative to a positive baseline', () => {
    const result = evaluateDecayCheck({ deltaAtGraduation: 0.2, currentDelta: -0.5, consecutiveDecayChecksBefore: 1 });
    expect(result.consecutiveDecayChecksAfter).toBe(2);
    expect(result.decaySignalEmitted).toBe(true);
  });
});

describe('evaluateDecayCheck — non-positive deltaAtGraduation guard (ADR 0032 §4)', () => {
  it('throws on a zero deltaAtGraduation, rather than silently no-oping', () => {
    expect(() => evaluateDecayCheck({ deltaAtGraduation: 0, currentDelta: -0.1, consecutiveDecayChecksBefore: 0 })).toThrow();
  });

  it('throws on a negative deltaAtGraduation, rather than silently no-oping', () => {
    expect(() => evaluateDecayCheck({ deltaAtGraduation: -0.15, currentDelta: -0.3, consecutiveDecayChecksBefore: 0 })).toThrow();
  });

  it('the thrown error names the offending value, for a legible ops log', () => {
    expect(() => evaluateDecayCheck({ deltaAtGraduation: -0.15, currentDelta: 0, consecutiveDecayChecksBefore: 0 })).toThrow(/-0.15/);
  });

  it('a genuinely tiny but positive deltaAtGraduation does NOT throw', () => {
    expect(() => evaluateDecayCheck({ deltaAtGraduation: 0.0001, currentDelta: 0, consecutiveDecayChecksBefore: 0 })).not.toThrow();
  });
});

describe('property: no alternating decay/recovery sequence ever emits a signal', () => {
  it('any sequence with no two CONSECUTIVE below-half checks never fires', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 0, maxLength: 200 }),
        (rawBits) => {
          // Force strict alternation so no two `true`s (decay) are ever
          // adjacent — the exact "one is noise" shape the spec describes.
          const bits = rawBits.map((_, i) => i % 2 === 0);
          let streak = 0;
          let anySignal = false;
          for (const isDecay of bits) {
            const result = evaluateDecayCheck({
              deltaAtGraduation: 0.2,
              currentDelta: isDecay ? 0.01 : 0.2,
              consecutiveDecayChecksBefore: streak,
            });
            streak = result.consecutiveDecayChecksAfter;
            if (result.decaySignalEmitted) anySignal = true;
          }
          expect(anySignal).toBe(false);
        },
      ),
    );
  });

  it('a signal fires if and only if the sequence contains two consecutive decaying checks, for any boolean sequence', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 0, maxLength: 100 }), (bits) => {
        let streak = 0;
        let anySignal = false;
        for (const isDecay of bits) {
          const result = evaluateDecayCheck({
            deltaAtGraduation: 0.2,
            currentDelta: isDecay ? 0.01 : 0.2,
            consecutiveDecayChecksBefore: streak,
          });
          streak = result.consecutiveDecayChecksAfter;
          if (result.decaySignalEmitted) anySignal = true;
        }
        const hasTwoConsecutiveTrue = bits.some((b, i) => i > 0 && b && bits[i - 1]);
        expect(anySignal).toBe(hasTwoConsecutiveTrue);
      }),
    );
  });

  it('the streak counter is always exactly the length of the current trailing run of decaying checks', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 0, maxLength: 100 }), (bits) => {
        let streak = 0;
        for (const isDecay of bits) {
          const result = evaluateDecayCheck({
            deltaAtGraduation: 0.2,
            currentDelta: isDecay ? 0.01 : 0.2,
            consecutiveDecayChecksBefore: streak,
          });
          streak = result.consecutiveDecayChecksAfter;
        }
        // Compute the trailing run length of `true` directly from the array.
        let expected = 0;
        for (let i = bits.length - 1; i >= 0; i--) {
          if (bits[i]) expected++;
          else break;
        }
        expect(streak).toBe(expected);
      }),
    );
  });

  it('decaySignalEmitted is true exactly when consecutiveDecayChecksAfter >= 2, for any valid input', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-6, max: 1, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.nat({ max: 50 }),
        (deltaAtGraduation, currentDelta, before) => {
          const result = evaluateDecayCheck({ deltaAtGraduation, currentDelta, consecutiveDecayChecksBefore: before });
          expect(result.decaySignalEmitted).toBe(result.consecutiveDecayChecksAfter >= 2);
        },
      ),
    );
  });
});
