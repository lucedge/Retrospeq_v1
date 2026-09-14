import { graduationEvidenceSchema } from './graduation-evidence-schema';
import { promotionEvidenceSchema } from './promotion-evidence-schema';
import { relaxationEvidenceSchema } from './relaxation-evidence-schema';
import { retirementConditionEvidenceSchema, retirementDecayEvidenceSchema } from './retirement-evidence-schema';
import type { DecisionPromptKind, DecisionPromptSubjectType } from './prompts-repository';

/**
 * Frame 4.11's `.backlog li span` — one short question per deferred
 * subject, so a trader looking at a list of several weeks' worth of
 * deferrals can tell them apart (the frame's own two worked examples,
 * "Make conviction a rule?" / 'Make "stop after 3 losses" hard?', are only
 * distinguishable because each names its own subject — a generic per-kind
 * headline repeated across several rows would make the list useless).
 *
 * Deliberately NOT the same function the live decision cards use for their
 * own `<h1>` (`DecisionCard.tsx`/`PromotionDecisionCard.tsx`/etc. build
 * theirs inline, hard-coded per component) — this is a READ-ONLY summary
 * over the RAW stored `payload`, with no live re-fetch of the underlying
 * finding/rule/condition (the backlog view has no decision to protect with
 * fresh data — see this repo's own "prompt bookkeeping is separate from
 * the domain write it authorises" posture, `prompts-repository.ts`). Where
 * a raw payload alone is enough to match a card's own wording exactly
 * (graduation's "Make {field} a rule?"), it does; where the card's own
 * headline is deliberately generic (`RetirementDecisionCard`'s "Has this
 * edge stopped working?", `RelaxationDecisionCard`'s "Which one is true?"),
 * this function still names the specific rule/condition text the payload
 * already carries, since a generic sentence collapses every backlog row of
 * that kind into the same unreadable line.
 *
 * `fieldNameFor` resolves a graduation prompt's `fieldId` to a display
 * name (fields and rule operands are different id spaces — `fieldId` alone
 * is not human-readable, see `graduation-evidence-detail.ts`'s own header)
 * — injected rather than fetched here, keeping this function pure and
 * independently unit-testable without a DB.
 *
 * A malformed/legacy payload (schema drift) degrades to a generic,
 * still-honest sentence rather than throwing — this is a read-only list,
 * not a write path, so "can't tell exactly what this was" is shown, never
 * a corrupt-payload error screen.
 */
export function backlogSubjectSentence(
  kind: DecisionPromptKind,
  subjectType: DecisionPromptSubjectType,
  payload: unknown,
  fieldNameFor: (fieldId: string) => string | null,
): string {
  switch (kind) {
    case 'graduation': {
      const parsed = graduationEvidenceSchema.safeParse(payload);
      if (!parsed.success) return 'Make this finding a rule?';
      const name = fieldNameFor(parsed.data.fieldId) ?? parsed.data.fieldId;
      return `Make ${name.toLowerCase()} a rule?`;
    }
    case 'promotion': {
      const parsed = promotionEvidenceSchema.safeParse(payload);
      if (!parsed.success) return 'Make this rule hard?';
      return `Make "${parsed.data.rendered}" hard?`;
    }
    case 'retirement': {
      if (subjectType === 'trigger_condition') {
        const parsed = retirementConditionEvidenceSchema.safeParse(payload);
        if (!parsed.success) return 'Has this checklist item stopped discriminating?';
        return `Has "${parsed.data.text}" stopped discriminating?`;
      }
      const parsed = retirementDecayEvidenceSchema.safeParse(payload);
      if (!parsed.success) return 'Has this edge stopped working?';
      return 'Has this edge stopped working?';
    }
    case 'relaxation': {
      const parsed = relaxationEvidenceSchema.safeParse(payload);
      if (!parsed.success) return 'Which one is true about this rule?';
      return `Recommit to or adjust "${parsed.data.rendered}"?`;
    }
    case 'detection':
    default:
      return 'Make a rule from this pattern?';
  }
}
