/**
 * Module 06 (Review & Graduation) §4.4 — shared types for the eligibility
 * layer. **Scope of this whole `prompt-candidates/` directory**: pure/
 * read-only "who currently qualifies for each kind of prompt" computation
 * only. NOT ranking (§4.3's kind-priority + magnitude ordering), NOT the
 * three-per-week cap, NOT the "at most one detection per review" cap, NOT
 * writing to `review_prompts`, NOT any UI — all of that is later-slice
 * work this directory deliberately does not attempt (see each finder
 * file's own header for the exact boundary). Analogous to how Module 04
 * Slice 1 built the pure rule evaluator before any freeze-wiring existed.
 *
 * `{ subjectType, subjectId, kind, evidence }` — the shape this slice's
 * own dispatch specifies, matching `review_prompts`/`prompt_history`'s own
 * column vocabulary (`supabase/migrations/20260911020000_review_
 * graduation_schema.sql`) exactly, so a later ranking/persistence slice
 * can write a `PromptCandidate` (once ranked and capped) almost directly
 * into a `review_prompts` row — `kind`/`subjectType`/`subjectId` map 1:1
 * onto that table's own `kind`/`subject_type`/`subject_id` columns and
 * CHECK constraints, reproduced verbatim below rather than loosened.
 */

/** `review_prompts.kind` / `prompt_history.kind`'s CHECK constraint,
 *  verbatim. Retirement (decay) and retirement (condition) — two of this
 *  slice's own six candidate finders — both produce `kind: 'retirement'`
 *  candidates (they differ by `subjectType`, not by `kind`); the DB schema
 *  itself only has ONE `'retirement'` value, not two, so this type does
 *  not invent a `'retirement_decay'`/`'retirement_condition'` distinction
 *  the schema doesn't have. */
export type PromptKind = 'relaxation' | 'graduation' | 'detection' | 'promotion' | 'retirement';

/** `review_prompts.subject_type` / `prompt_history.subject_type`'s CHECK
 *  constraint, verbatim. */
export type PromptSubjectType = 'rule' | 'finding' | 'detection' | 'trigger_condition';

/**
 * One eligibility candidate. `subjectId` is always a real `uuid` STRING
 * (matching `review_prompts.subject_id uuid not null` / `prompt_history
 * .subject_id uuid not null` — both genuinely typed `uuid`, no FK, per
 * that migration's own header on why a single FK can't express "references
 * one of four possible tables"):
 *
 *  - `'rule'`             -> the real `rules.id` (stable — a rule row is
 *                            never superseded/re-created, only edited via
 *                            a NEW `rule_versions` row under the SAME
 *                            `rules.id`, per Module 04 §2.5).
 *  - `'trigger_condition'` -> the real `trigger_conditions.id` (stable —
 *                            `trigger_conditions` rows are mutated/retired
 *                            in place, never superseded with a new id).
 *  - `'finding'`/`'detection'` -> NOT the live `findings.id`/`detections
 *                            .id` — see `stable-subject-id.ts`'s own header
 *                            for why those two tables' own row ids are
 *                            UNSAFE to use here (both use a
 *                            supersede-then-insert write pattern that gives
 *                            a fresh row id on every recompute, which would
 *                            silently break §4.5's "a muted subject never
 *                            reappears, under any sequence of new data"
 *                            invariant) and what this slice derives instead.
 */
export interface PromptCandidate<Evidence = Record<string, unknown>> {
  subjectType: PromptSubjectType;
  subjectId: string;
  kind: PromptKind;
  evidence: Evidence;
}
