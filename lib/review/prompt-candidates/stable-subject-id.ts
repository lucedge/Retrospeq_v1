import { createHash } from 'node:crypto';

/**
 * Module 06 (Review & Graduation) §4.5 — a genuine, flagged judgment call
 * this slice's own dispatch specifically asked to be surfaced, not one this
 * repo has resolved anywhere before. See `docs/adr/0037-prompt-candidate-
 * eligibility-judgment-calls.md` decision #1 for the formal record.
 *
 * ## The problem
 *
 * `review_prompts.subject_id` / `prompt_history.subject_id` are both typed
 * `uuid not null`, and §4.5's own property test is unconditional: **"A
 * muted subject never reappears, under any sequence of new data."** For
 * `subjectType: 'rule'` and `'trigger_condition'` that's trivially safe —
 * `rules.id`/`trigger_conditions.id` are stable for the life of the row
 * (a rule is edited via a new `rule_versions` row under the SAME
 * `rules.id`, Module 04 §2.5; a trigger condition is mutated/retired in
 * place, `20260902010000_field_registry_schema.sql`).
 *
 * `'finding'` and `'detection'` are NOT safe the same way. Both tables use
 * a supersede-then-insert write pattern that gives the CURRENT row a fresh
 * `id` on every recompute:
 *   - `findings`: `docs/adr/0024-findings-supersession-write-semantics.md`
 *     — a fresh edge-engine run for the same `(strategy_id, field_id,
 *     segment)` tuple supersedes the old row and inserts a brand new one,
 *     new id, every time the underlying trade data changes.
 *   - `detections`: `docs/adr/0029-detections-supersession-key.md` — same
 *     shape, keyed on `(user_id, analytic_id)` instead of a segment tuple.
 *
 * If a future write-path slice stored `subject_id = findings.id` (or
 * `detections.id`) at decline time, a trader who declines the SAME
 * underlying pattern twice — earning a permanent mute per §4.5 — would see
 * it reappear the moment a routine nightly recompute superseded that exact
 * row and produced a new one with a new id. That is exactly the failure
 * §4.5's property test exists to rule out, and it is a real, live risk
 * TODAY given how `findings`/`detections` are written, not a hypothetical.
 *
 * ## The fix — derive a STABLE id from the underlying identity, not the
 * churning row id
 *
 * A finding's real, cross-recompute-stable identity is the tuple
 * `(strategyId, fieldId)` it is computed over — the same tuple
 * `decay-engine/repository.ts`'s own header already treats as immutable
 * across supersession ("these three columns are immutable across
 * supersession") minus `segment`, deliberately: §4.4's own eligibility
 * condition is phrased as "no existing rule ON THAT FIELD," i.e. the
 * graduation opportunity this slice reasons about is per-FIELD, not
 * per-segment-boundary (a threshold shifting from "rating >= 4" to "rating
 * >= 3" across recomputes is still, in every product sense that matters
 * to §4.5's mute guarantee, the SAME graduation offer for the SAME field).
 *
 * A detection's real, cross-recompute-stable identity is `analyticId`
 * alone — ADR 0029's own `(user_id, analytic_id)` supersession key,
 * `userId` supplied separately by RLS/the `user_id` column rather than
 * folded into the hash input (two different users' hashes must never
 * collide with each other regardless of hash function — the DB row itself
 * already scopes by `user_id`, this hash only needs to distinguish
 * PATTERNS within one user).
 *
 * Neither table's real identity is a `uuid` — `analyticId` is a short text
 * code (`seq.re_entry_after_loss`), `fieldId` is `fields.id`'s own `text`
 * type (`20260902010000_field_registry_schema.sql`, deliberately NOT
 * `uuid`). Since the DB column is a genuine `uuid`, this file deterministically
 * MAPS a stable string identity into UUID space (RFC 4122 §4.3 "name-based"
 * construction: SHA-1 of a fixed namespace + the name, with the version/
 * variant bits set) rather than picking an arbitrary live row id. Same
 * input -> same output, forever, regardless of how many times the
 * underlying `findings`/`detections` row is superseded.
 *
 * **Coordination note for whoever builds the write path (accept/decline,
 * `prompt_history` upserts) next**: this exact derivation — same namespace
 * constant, same name format — MUST be reused there. If a future slice
 * independently re-derives a different `subject_id` for the same
 * finding/detection, §4.5's mute guarantee silently breaks again, just
 * with a different collision point. This file, not a private literal
 * inline elsewhere, is the one place that mapping is defined.
 */

/**
 * Fixed, arbitrary namespace UUID for Retrospeq's own name-based subject
 * ids (RFC 4122 §4.3's "generate your own namespace" allowance — any fixed
 * 16-byte value works; this exact value carries no meaning beyond being
 * fixed and never reused for anything else in this codebase).
 */
const RETROSPEQ_SUBJECT_ID_NAMESPACE = '2f6a9e3c-6b41-4c7e-9d6d-1f6c9a2b7e40';

function namespaceBytes(): Buffer {
  return Buffer.from(RETROSPEQ_SUBJECT_ID_NAMESPACE.replace(/-/g, ''), 'hex');
}

/**
 * RFC 4122 §4.3 name-based (version 5, SHA-1) UUID derivation. Pure,
 * deterministic, no I/O — same `name` always yields the same uuid string,
 * independent of process/platform (SHA-1 and the bit-twiddling below are
 * both fully specified, no locale/timezone/random component anywhere).
 */
export function deriveStableSubjectId(name: string): string {
  const hash = createHash('sha1').update(namespaceBytes()).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Stable subject id for a `'finding'`-subject-type candidate (graduation)
 *  — keyed on `(strategyId, fieldId)`, NOT `segment` and NOT the live
 *  `findings.id`. See this file's own header for why. */
export function findingSubjectId(strategyId: string, fieldId: string): string {
  return deriveStableSubjectId(`finding:${strategyId}:${fieldId}`);
}

/** Stable subject id for a `'detection'`-subject-type candidate — keyed on
 *  `analyticId` alone, matching ADR 0029's own `(user_id, analytic_id)`
 *  supersession key (`userId` is not folded in here — see this file's own
 *  header). NOT the live `detections.id`. */
export function detectionSubjectId(analyticId: string): string {
  return deriveStableSubjectId(`detection:${analyticId}`);
}
