import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import type { PromptCandidate } from './types';

/**
 * Module 06 Slice 4 addendum (§4.5's OTHER half — see this file's own
 * original header below for why it was deliberately deferred at Slice 3):
 * "Declined once -> dormant... re-raise only if occurrences roughly
 * double." `fetchPromptHistoryStateForUser`/`filterDormant` below are
 * ADDITIVE to this file — `fetchMutedSubjectKeys`/`excludeMuted` are
 * UNCHANGED (still the mechanism `index.ts`'s `computeAllPromptCandidates`
 * uses for the unconditional mute gate) rather than refactored to share one
 * query, so the already-security-reviewed Slice 3 composition keeps its
 * exact reviewed shape. See docs/adr/0038-review-prompt-ranking-and-
 * canrender-gate.md decision on dormancy for the full reasoning, including
 * the per-kind "occurrences" measure and the null-snapshot judgment call.
 */

/**
 * Module 06 (Review & Graduation) §4.5 — the FIRST reader `prompt_history`
 * has ever had (the table has existed since Slice 1's schema migration,
 * `supabase/migrations/20260911020000_review_graduation_schema.sql`, but
 * nothing in this repo has read OR written it until this slice — grep-
 * confirmed at dispatch time). `prompt_history_owner` (owner "for all") is
 * a real, already-working RLS policy, so this reads under `withUserConnection`
 * like every other Module 06 read (`weekly-findings.ts`, `period-
 * adherence.ts`), not `withServiceRoleConnection`.
 *
 * Only the `muted` filter is implemented here — see `types.ts`'s own
 * header and each candidate finder's header for why the OTHER half of
 * §4.5 ("declined once -> dormant until occurrences roughly double") is
 * deliberately NOT implemented in this slice: it needs an "occurrences"
 * definition per kind that this slice's own dispatch scopes out as
 * ranking-adjacent, and — since nothing has ever written a `prompt_history`
 * row in this codebase's live history — is currently a no-op in every real
 * case regardless. `muted = true` is a hard, unconditional, already fully
 * spec'd gate ("A muted subject never reappears, under any sequence of new
 * data") with no such missing input, so it is implemented now rather than
 * left for the same future slice.
 */

interface MutedRow {
  subject_type: string;
  subject_id: string;
  kind: string;
}

function mutedKey(subjectType: string, subjectId: string, kind: string): string {
  return `${subjectType}:${subjectId}:${kind}`;
}

/** Every `(subject_type, subject_id, kind)` this user has permanently
 *  muted, as a `Set` of composite keys — one query, reused across every
 *  candidate kind's own filtering pass rather than one query per kind. */
export async function fetchMutedSubjectKeys(userId: string): Promise<Set<string>> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<MutedRow>(
      `select subject_type, subject_id, kind
         from retrospeq.prompt_history
        where user_id = $1 and muted = true`,
      [userId],
    );
    return new Set(res.rows.map((row) => mutedKey(row.subject_type, row.subject_id, row.kind)));
  });
}

/** Drops every candidate whose own `(subjectType, subjectId, kind)` is in
 *  `muted` — pure, no I/O, independently unit-testable against a plain
 *  `Set`. */
export function excludeMuted<C extends PromptCandidate<unknown>>(candidates: readonly C[], muted: ReadonlySet<string>): C[] {
  return candidates.filter((c) => !muted.has(mutedKey(c.subjectType, c.subjectId, c.kind)));
}

interface PromptHistoryRow {
  subject_type: string;
  subject_id: string;
  kind: string;
  decline_count: number;
  occurrences_at_last_decline: number | null;
}

/** One (subject, kind)'s full dormancy-relevant state. `muted` rows are NOT
 *  included in this map's callers' concern here (they are already dropped
 *  by `excludeMuted` upstream in `index.ts`'s `computeAllPromptCandidates`,
 *  which every caller of `filterDormant` below runs first) — this function
 *  itself does not re-check `muted`, it answers a narrower "is this
 *  specific, already-not-muted candidate currently dormant" question. */
export interface PromptHistoryState {
  declineCount: number;
  occurrencesAtLastDecline: number | null;
}

/** Every `(subject_type, subject_id, kind)` this user has EVER been shown a
 *  prompt for, keyed the same way `fetchMutedSubjectKeys` keys its own
 *  `Set` — one query, reused across every kind's own dormancy check rather
 *  than one query per kind (matching this file's own established
 *  no-N+1 posture). */
export async function fetchPromptHistoryStateForUser(userId: string): Promise<Map<string, PromptHistoryState>> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<PromptHistoryRow>(
      `select subject_type, subject_id, kind, decline_count, occurrences_at_last_decline
         from retrospeq.prompt_history
        where user_id = $1`,
      [userId],
    );
    const map = new Map<string, PromptHistoryState>();
    for (const row of res.rows) {
      map.set(mutedKey(row.subject_type, row.subject_id, row.kind), {
        declineCount: row.decline_count,
        occurrencesAtLastDecline: row.occurrences_at_last_decline,
      });
    }
    return map;
  });
}

/**
 * §4.5: "Declined once -> dormant... re-raise only if occurrences roughly
 * double." A candidate with no history row, or a history row with
 * `declineCount === 0` (shown/deferred, never declined), is never dormant.
 * A candidate declined at least once (muted subjects are already excluded
 * upstream, so `declineCount` reaching here is always exactly 1 in every
 * real case today) is dormant UNLESS the current occurrence count has
 * reached at least double the count snapshotted at the moment of that
 * decline.
 *
 * **Judgment call — a `null` `occurrencesAtLastDecline` on a declined row
 * stays dormant, it does not re-raise.** This should not arise from a
 * correct future write path (a decline write should always snapshot a real
 * count), but if it ever does, "we cannot prove the occurrence count has
 * doubled" is read the same conservative way this repo reads every other
 * "cannot verify -> do not show" case (canRender's own fail-closed
 * contract, `registry-runtime-service.ts`) — respecting a decline by
 * default costs nothing (§13: "a missed week costs nothing"); silently
 * re-raising a declined prompt on unverifiable data would be the one
 * failure mode this module's whole ethics stance exists to prevent.
 *
 * Pure, no I/O — independently unit-testable against a plain `Map`.
 */
export function filterDormant<E>(
  candidates: readonly PromptCandidate<E>[],
  historyState: ReadonlyMap<string, PromptHistoryState>,
  occurrenceCount: (evidence: E) => number,
): PromptCandidate<E>[] {
  return candidates.filter((c) => {
    const entry = historyState.get(mutedKey(c.subjectType, c.subjectId, c.kind));
    if (!entry || entry.declineCount === 0) return true;
    if (entry.occurrencesAtLastDecline === null) return false;
    return occurrenceCount(c.evidence) >= entry.occurrencesAtLastDecline * 2;
  });
}
