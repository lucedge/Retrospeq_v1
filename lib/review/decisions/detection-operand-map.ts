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
 * RECONCILIATION (logged in full in PROGRESS.md's decision log): this
 * slice's own dispatch names the shape with an illustrative example —
 * "re-entry-after-loss -> time_since_last_loss minimum minutes" — as the
 * obvious, name-correct cross-reference. Checking `operand-catalogue.ts`
 * for real (not assumed) finds every one of the FIVE v1 detection
 * analytics' own obvious operand counterpart is `computableToday: false`
 * today, for the SAME reason each one is a detection in the first place:
 * `time_since_last_loss`, `trades_today`, `consecutive_losses`, `daily_
 * loss_pct` all say, verbatim, "cross-trade aggregation, not built this
 * slice" (Module 04's own catalogue entries, unrelated to Module 05's
 * separate, independent reimplementation of the same facts for detection
 * purposes — `occurrence-detectors.ts`'s own header names this exact
 * boundary). `risk_pct` (mapped from `risk.spread`) IS `computableToday:
 * true`, but `risk.spread`'s own occurrence definition is a per-user IQR
 * outlier fence computed fresh at detection-run time and never persisted
 * on `detections` (`detections-repository.ts`'s own row shape has no
 * fence/threshold column) — there is no honest value to derive a `lte`
 * cap from without re-running that detector's own baseline computation,
 * which this review-time card does not do. **The practical result: every
 * one of today's five real analytics resolves to `null` here** — the
 * "This pattern can't become a rule yet" honest state (still declinable
 * via "Not yet") is therefore the ONLY reachable outcome in production
 * right now, not a hypothetical edge case. This is a genuine, structural
 * product gap (not a bug in this file) — noted in `docs/infra-gaps.md`:
 * closing it needs either Module 04 building the missing cross-trade
 * operands, or `detections` persisting the actual measured threshold/
 * fence value it computed, whichever a future slice's own dispatch picks.
 *
 * Two of the five (`seq.reentry_after_loss`, `seq.consecutive_losses`) DO
 * have a real, non-guessed, non-per-user CONSTANT this file can honestly
 * turn into a threshold the moment their operand's own `computableToday`
 * flips true — `occurrence-detectors.ts`'s own exported `REENTRY_
 * THRESHOLD_SECONDS`/`CONSECUTIVE_LOSS_STREAK_THRESHOLD`, the SAME
 * constants that file's own header already established are the real
 * detection threshold, not placeholder copy (see that file's header for
 * the "repeated identically across five independent documents" evidence).
 * Those two branches are written for real below, not stubbed, following
 * `graduation-operand-map.ts`'s own precedent of implementing a
 * currently-unreachable branch correctly rather than leaving it as dead
 * code waiting for a second bug report (that file's own `bool`-segment
 * branch header makes the identical argument). The other three
 * (`seq.trades_per_day`, `seq.daily_loss_breach`, `risk.spread`) have NO
 * such fixed constant — each one's own "threshold" is itself a per-user
 * statistic (a baseline median or IQR fence) computed once at detection-
 * run time and gone by the time this card renders — so they stay `null`
 * unconditionally; there is nothing this file could honestly compute for
 * them without re-deriving that statistic from raw trades, which is out
 * of this slice's own scope.
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
