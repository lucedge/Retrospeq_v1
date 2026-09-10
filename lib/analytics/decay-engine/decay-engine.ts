/**
 * Module 05 (Analytics & Findings) §4.11 — decay checking, the pure half.
 * No I/O, no database — implements the spec's own pseudocode literally:
 *
 *   every 30 new trades in the segment:
 *       recompute the finding
 *       if current_delta < 0.5 * delta_at_graduation:
 *           consecutive_decay_checks += 1
 *       else:
 *           consecutive_decay_checks = 0
 *       if consecutive_decay_checks >= 2:
 *           emit decay signal → Module 06 offers retirement
 *
 * "Two consecutive checks, because one is noise." — the reset-to-zero on
 * ANY non-decaying check (never a decrement, never left unchanged) is the
 * load-bearing part of that sentence: a single below-threshold check is
 * noise ONLY if it doesn't compound with a second one that follows
 * immediately after — a recovery in between must fully clear whatever
 * streak came before it, however long that streak was, or "two
 * consecutive" silently degrades into "two out of N."
 *
 * The "every 30 new trades" throttle and the mechanics of what "recompute
 * the finding" means against this repo's findings-supersession model both
 * live in `repository.ts`, not here — this file only knows about the
 * three numbers the spec's own pseudocode names.
 *
 * `delta` here means WIN-RATE delta (`findings.delta_win_rate`), not
 * `delta_avg_r` — see `repository.ts`'s own header for the full reasoning
 * (the design-decisions doc's own worked example, "This rule was true at
 * 71% and is now running at 55%," and `finding_rule_links.delta_at_
 * graduation`/`last_delta`'s matching `numeric(6,4)` precision).
 */

export interface EvaluateDecayCheckInput {
  /** The finding's win-rate delta AT GRADUATION time — must be a genuine
   *  positive edge (see this function's own guard below). */
  deltaAtGraduation: number;
  /** The CURRENT active finding's own win-rate delta for the same
   *  segment tuple, as of this check. */
  currentDelta: number;
  /** `finding_rule_links.consecutive_decay_checks` before this check ran. */
  consecutiveDecayChecksBefore: number;
}

export interface EvaluateDecayCheckResult {
  consecutiveDecayChecksAfter: number;
  /** True exactly when THIS check is the one that pushed the streak to
   *  >= 2 — i.e. the "emit decay signal" line firing on this check. */
  decaySignalEmitted: boolean;
}

/**
 * `deltaAtGraduation` must be a genuine POSITIVE edge for the `0.5x`
 * comparison to mean what §4.11 intends ("edges decay" — an edge
 * shrinking toward and past zero). A graduated rule is only ever created
 * (Module 06 §4.6/§4.4) from a finding with `confidence = 'confident'`,
 * which by construction cleared §4.3's effect gate with a real,
 * non-trivial delta — so a non-positive `deltaAtGraduation` reaching this
 * function is not a value this pure formula can be asked to interpret
 * ("below half of a negative or zero number" inverts what decay means: a
 * MORE negative `currentDelta` would satisfy `<`, which is the opposite
 * of decaying toward irrelevance). It is a real data-integrity bug in
 * whatever wrote `finding_rule_links.delta_at_graduation` — surfaced
 * loudly with a thrown, descriptive error, never silently computed into
 * a meaningless (or backwards) result.
 */
export function evaluateDecayCheck(input: EvaluateDecayCheckInput): EvaluateDecayCheckResult {
  const { deltaAtGraduation, currentDelta, consecutiveDecayChecksBefore } = input;

  if (!(deltaAtGraduation > 0)) {
    throw new Error(
      `evaluateDecayCheck: deltaAtGraduation must be a positive win-rate delta (got ${deltaAtGraduation}). ` +
        'A graduated rule is only ever created from a finding with confidence = "confident" (Module 06 §4.4/§4.6), ' +
        'which by construction cleared §4.3\'s effect gate with a real positive delta -- a non-positive value here ' +
        'means the graduation evidence itself is corrupt, or was computed from the wrong metric. This is a ' +
        'data-integrity bug worth surfacing loudly, not a case to silently no-op or compute backwards.',
    );
  }

  const belowHalf = currentDelta < 0.5 * deltaAtGraduation;
  const consecutiveDecayChecksAfter = belowHalf ? consecutiveDecayChecksBefore + 1 : 0;
  return { consecutiveDecayChecksAfter, decaySignalEmitted: consecutiveDecayChecksAfter >= 2 };
}
