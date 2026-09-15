import { getOperand, type OperandCatalogueEntry, type RuleOperator } from '@/lib/rules/operand-catalogue';
import { REENTRY_THRESHOLD_SECONDS, CONSECUTIVE_LOSS_STREAK_THRESHOLD } from '@/lib/analytics/detection-engine/occurrence-detectors';

/**
 * Module 06 (Review & Graduation) — frame 4.10's detection decision, the
 * detection-side counterpart to `graduation-operand-map.ts`. Maps a
 * `rule_proposable` v1 detection `analyticId` (`lib/review/prompt-
 * candidates/detection-candidates.ts`'s own `selectDetectionCandidates`
 * gate: `tier='count_outcome' && classification='pattern' && ruleProposable`)
 * to a Module 04 operand + threshold, following `graduation-operand-map
 * .ts`'s own established honesty posture: **only map what the operand
 * catalogue marks `computableToday`; anything else is `null`, never a
 * guess** (that file's own header, restated here for the same reason).
 *
 * RECONCILIATION, ORIGINAL (2026-09-15, logged in full in PROGRESS.md's
 * decision log): this slice's own dispatch names the shape with an
 * illustrative example — "re-entry-after-loss -> time_since_last_loss
 * minimum minutes" — as the obvious, name-correct cross-reference. At the
 * time this file was first written, every one of the FIVE v1 detection
 * analytics' own obvious operand counterpart was `computableToday: false`
 * ("cross-trade aggregation, not built this slice") — so every one of
 * today's five real analytics resolved to `null` here, making "This
 * pattern can't become a rule yet" the ONLY reachable outcome in
 * production.
 *
 * UPDATE (same day, follow-up slice — "make the cross-trade operands
 * truthfully computableToday"): `lib/rules/cross-trade-operand-values.ts`
 * (Slice 4) and `lib/rules/freeze-evaluations.ts` (Slice 5) were
 * re-verified against the real, running freeze path (not re-derived from
 * scratch) and found to genuinely, honestly compute `time_since_last_loss`
 * and `consecutive_losses` end-to-end in production — `operand-
 * catalogue.ts` now marks both `computableToday: true` for real. The two
 * branches below (`seq.reentry_after_loss`, `seq.consecutive_losses`) are
 * consequently now REACHABLE in production, not merely correctly-written
 * dead code — they resolve a real `DetectionRuleProposal` using
 * `occurrence-detectors.ts`'s own exported `REENTRY_THRESHOLD_SECONDS`/
 * `CONSECUTIVE_LOSS_STREAK_THRESHOLD` constants (the SAME numbers that
 * file's own header already established as the real detection threshold,
 * not placeholder copy — see that file's header for the "repeated
 * identically across five independent documents" evidence).
 *
 * The other three (`seq.trades_per_day`, `seq.daily_loss_breach`,
 * `risk.spread`) STILL resolve to `null` — this is now their ONLY reason,
 * and it did not change: each one's own "threshold" is itself a per-user
 * statistic (a baseline median or IQR fence) computed once at
 * detection-run time and never persisted anywhere on `retrospeq.detections`
 * (`detections-repository.ts`'s own row shape — `occurrences`, `base_rate`,
 * `outcome_avg_r`/`outcome_baseline_avg_r`, `distinct_days` — has no
 * fence/threshold column). `trades_today` and `daily_loss_pct` (the two
 * operands `seq.trades_per_day`/`seq.daily_loss_breach` would obviously map
 * to) are now ALSO `computableToday: true` — re-checked deliberately, in
 * case that changed this reasoning — but `computableToday` only answers
 * "can a value be assembled for a given TRADE," not "is there a persisted
 * per-user BASELINE this card can turn into a rule threshold," which is a
 * genuinely different, still-missing piece of data. Deriving one here would
 * mean re-running that detector's own baseline computation inside a
 * review-time card, which this file does not do. Closing this needs
 * `detections` persisting the actual measured threshold/fence value at
 * computation time — noted in `docs/infra-gaps.md`, not attempted here.
 */

export interface DetectionRuleProposal {
  operand: OperandCatalogueEntry;
  op: RuleOperator;
  value: unknown;
}

export function resolveDetectionRuleProposal(analyticId: string): DetectionRuleProposal | null {
  switch (analyticId) {
    case 'seq.reentry_after_loss': {
      const operand = getOperand('time_since_last_loss');
      if (!operand || !operand.computableToday || !operand.phrasing.gte) return null;
      // REENTRY_THRESHOLD_SECONDS is seconds; the operand's own unit is
      // whole minutes (`bounds.step = 1`) — round UP so the proposed rule
      // is at least as strict as the detected pattern, never weaker than
      // the behaviour it was built from.
      const minutes = Math.min(operand.bounds?.max ?? Infinity, Math.max(operand.bounds?.min ?? 1, Math.ceil(REENTRY_THRESHOLD_SECONDS / 60)));
      return { operand, op: 'gte', value: minutes };
    }
    case 'seq.consecutive_losses': {
      const operand = getOperand('consecutive_losses');
      if (!operand || !operand.computableToday || !operand.phrasing.lte) return null;
      return { operand, op: 'lte', value: CONSECUTIVE_LOSS_STREAK_THRESHOLD };
    }
    case 'seq.trades_per_day':
    case 'seq.daily_loss_breach':
    case 'risk.spread':
      // See this file's own header — each is a per-user, run-time-only
      // statistic with no persisted value to honestly derive from here.
      return null;
    default:
      return null;
  }
}
