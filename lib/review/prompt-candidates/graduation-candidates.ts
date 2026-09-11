import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { fetchActiveFindingsForUser, type FindingRowWithStrategy } from '@/lib/analytics/findings-repository';
import { findingSubjectId } from './stable-subject-id';
import type { PromptCandidate } from './types';

/**
 * Module 06 (Review & Graduation) §4.4 — Graduation eligibility: "Finding
 * with `confidence = 'confident'`, no existing rule on that field,
 * `rule_proposable = true`."
 *
 * ## Judgment call #1 — `rule_proposable` has NO literal counterpart on a
 * finding. Read as `confidence === 'confident'`, not a separate flag.
 *
 * Verified directly against the actual type definitions before assuming
 * symmetry with detections, per this slice's own dispatch instruction:
 * `lib/analytics/detection-engine/types.ts`'s `DetectionComputationResult
 * .ruleProposable` IS a real, independently-computed boolean column
 * (`detections.rule_proposable`, added by `20260909040000_detections_
 * direction_and_rule_proposable.md` — "the single flag that prevents an
 * incident or a bare count from becoming a rule prompt," Module 05 §5).
 * `lib/analytics/findings-payload.ts`'s `FindingPayload` — Module 05 §5's
 * own literal `type FindingPayload = {...}` contract, reproduced verbatim
 * in that file's own header — has NO `rule_proposable` field at all, and
 * `retrospeq.findings` (the table `FindingPayload` is built from) has no
 * such column either (`20260908010000_analytics_registry_schema.sql`'s own
 * DDL). This is not an oversight to route around; findings and detections
 * are structurally different classes of "is this real" gate:
 *
 *  - A DETECTION's `rule_proposable` distinguishes a `count_outcome`+
 *    `pattern` result (a real, distributed, outcome-measured pattern) from
 *    a bare `count`-tier or clustered `incident` result — a distinction
 *    ORTHOGONAL to how many occurrences were observed.
 *  - A FINDING's `confidence` tier (`insufficient` -> `null_result` ->
 *    `provisional` -> `confident`) already IS that same "is this real"
 *    gate for findings — `confident` means it cleared §4.3's sample gate,
 *    effect gate, AND Holm multiple-comparison correction (Module 05
 *    §4.3), the full pipeline a `rule_proposable` boolean would otherwise
 *    exist to summarise. Module 06 §4.6's own "Blocked below sample" line
 *    ties graduation eligibility directly to sample-gate clearance, not to
 *    a second, independent flag alongside it.
 *
 * Treating `confidence === 'confident'` as this slice's own stand-in for
 * "rule_proposable = true, for findings" is therefore the correct reading,
 * not a shortcut around a missing field — there is nothing else on a
 * finding row §4.4's condition could be asking about.
 *
 * ## Judgment call #2 — "no existing rule on that field": what a rule
 * "on a field" even means, given field ids and operand ids are DIFFERENT
 * namespaces
 *
 * `lib/rules/operand-catalogue.ts`'s `OPERAND_CATALOGUE` is a FIXED, static
 * list of built-in operand ids (`risk_pct`, `hold_seconds`, ...) — none of
 * them is, or is derived from, a Module 03 `fields.id` (which is a
 * per-user, user-authored `text` id, `20260902010000_field_registry_
 * schema.sql`). A naive `rules.operand_id === finding.field_id` check would
 * therefore NEVER match anything — not because it's a correct "no rule
 * yet" answer, but because the two columns live in disjoint id spaces and
 * the check is a category error.
 *
 * The REAL mechanism this schema already has for "a field is referenced by
 * a rule" is `field_usages` (`used_by = 'rule'`, `used_by_id -> rules.id`,
 * same migration) — §4.6's own future graduation-acceptance flow is
 * exactly the write path that would populate it ("Module 04 creates a rule
 * ... and Module 05 writes the `finding_rule_links` row"; a full graduation
 * write path would also need to write a `field_usages(used_by='rule')` row
 * the same way strategy-save already does for `used_by='strategy'`).
 * `fields-repository.ts`'s own header confirms directly: "no Module 04
 * rule-authoring pipeline writes `used_by = 'rule'` rows yet" — so this
 * check is a real, correctly-shaped, currently-always-empty query, not a
 * dead one: it reads the mechanism this repo's own schema designates for
 * the answer, and will start returning real rows the moment a future slice
 * builds graduation's write path, with ZERO change needed here.
 */

interface FieldWithActiveRuleRow {
  field_id: string;
}

/** Every field id this user has an ACTIVE rule attached to, via
 *  `field_usages(used_by = 'rule')` joined to `rules.state = 'active'` —
 *  see this file's own header, judgment call #2. */
async function fetchFieldIdsWithActiveRule(userId: string): Promise<Set<string>> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<FieldWithActiveRuleRow>(
      `select distinct fu.field_id
         from retrospeq.field_usages fu
         join retrospeq.rules r on r.id = fu.used_by_id and r.user_id = fu.user_id
        where fu.user_id = $1 and fu.used_by = 'rule' and r.state = 'active'`,
      [userId],
    );
    return new Set(res.rows.map((row) => row.field_id));
  });
}

export interface GraduationEvidence {
  strategyId: string;
  fieldId: string;
  analyticId: string;
  n: number;
  winRate: number | null;
  avgR: number | null;
  baselineN: number;
  baselineWinRate: number | null;
  baselineAvgR: number | null;
  deltaWinRate: number | null;
  deltaAvgR: number | null;
}

/**
 * Pure selection over already-fetched rows — independently unit-testable
 * without a DB. Picks at most ONE candidate per `(strategyId, fieldId)`:
 * a `pick_one`/`pick_many` field can legitimately have more than one
 * active `confident` segment row at once (e.g. two different option
 * values each individually confident) — §4.6's graduation prompt proposes
 * ONE threshold/segment boundary for the field, matching
 * `pickRepresentativeFinding`'s (`findings-payload.ts`, ADR 0035)
 * established "one row per field" reasoning, reapplied here rather than
 * re-invented — the tie-break (largest `n`) is the same one that function
 * already uses within a confidence tier.
 */
export function selectGraduationCandidates(
  findings: readonly FindingRowWithStrategy[],
  fieldsWithActiveRule: ReadonlySet<string>,
): FindingRowWithStrategy[] {
  const byFieldKey = new Map<string, FindingRowWithStrategy>();
  for (const row of findings) {
    if (row.confidence !== 'confident') continue;
    if (fieldsWithActiveRule.has(row.fieldId)) continue;
    const key = `${row.strategyId}:${row.fieldId}`;
    const existing = byFieldKey.get(key);
    if (!existing || row.n > existing.n) byFieldKey.set(key, row);
  }
  return [...byFieldKey.values()];
}

/** Every graduation-eligible finding for this user, `finding_id`-churn-safe
 *  (see `stable-subject-id.ts`), muted subjects NOT yet excluded here —
 *  callers that want the muted filter applied use `computeAllPromptCandidates`
 *  (`index.ts`), which applies it uniformly across every kind in one pass. */
export async function findGraduationCandidates(userId: string): Promise<PromptCandidate<GraduationEvidence>[]> {
  const [findings, fieldsWithActiveRule] = await Promise.all([
    fetchActiveFindingsForUser(userId),
    fetchFieldIdsWithActiveRule(userId),
  ]);

  return selectGraduationCandidates(findings, fieldsWithActiveRule).map((row) => ({
    subjectType: 'finding' as const,
    subjectId: findingSubjectId(row.strategyId, row.fieldId),
    kind: 'graduation' as const,
    evidence: {
      strategyId: row.strategyId,
      fieldId: row.fieldId,
      analyticId: row.analyticId,
      n: row.n,
      winRate: row.winRate,
      avgR: row.avgR,
      baselineN: row.baselineN,
      baselineWinRate: row.baselineWinRate,
      baselineAvgR: row.baselineAvgR,
      deltaWinRate: row.deltaWinRate,
      deltaAvgR: row.deltaAvgR,
    },
  }));
}
