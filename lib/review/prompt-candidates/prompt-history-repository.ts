import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import type { PromptCandidate } from './types';

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
