import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { determineCurrentWeeklyReviewPeriod } from '@/lib/review/current-period';
import { fetchWeeklyReviewByPeriodStart } from '@/lib/review/reviews-repository';

/**
 * Module 06 (Review & Graduation) Slice 6 — the decision screen's own
 * `review_prompts` reads/writes. Deliberately separate from
 * `lib/review/review-prompts-repository.ts` (Slice 4/5's file): that file
 * is the SCHEDULED-JOB write half (`writeReviewPrompts`, `service_role`,
 * no real session at the call site — see its own header) plus one
 * page-load count read (`fetchPendingPromptCount`, Slice 5). Every
 * function here instead runs behind a REAL authenticated session
 * (`withUserConnection`, real `review_prompts_owner` RLS) — a trader
 * viewing and deciding on their OWN already-materialised prompts, the
 * exact "for all" owner-write case that migration's own RLS policy exists
 * for (§3's schema migration header: "`opened_at`/`completed_at` are
 * written by the trader's own client interaction ... a client UPDATE path
 * is a real, expected write").
 */

// ---------------------------------------------------------------------
// Resolving "the current review" for the decisions screen
// ---------------------------------------------------------------------

export interface CurrentReviewForDecisions {
  reviewId: string;
}

/**
 * The decisions screen (`/review/decisions`) never materialises a review
 * itself — that is `/review`'s own job (`app/(app)/review/actions.ts`'s
 * `fetchWeeklyReviewRead`, Slice 5), and `review_prompts` rows only ever
 * exist for a review that has already been materialised. This function
 * answers "which review's prompts should this screen show," reusing the
 * SAME period-selection logic `/review` itself uses
 * (`determineCurrentWeeklyReviewPeriod`) rather than re-deriving it, then
 * reading the (already-written, by construction — see this function's own
 * `null` case) `reviews` row for that period.
 *
 * Returns `null` in two legitimate, non-error cases the caller must
 * distinguish from each other with its own copy (this function itself
 * stays a plain `null`, not a discriminated union, since BOTH render the
 * identical "nothing to decide right now, go read your review" screen):
 *   - `period.status === 'caught_up'` (§4.2 Part 3's steady state).
 *   - No `reviews` row exists yet for the current period (the trader has
 *     never opened `/review` this period, so `computeAndWriteReviewPrompts`
 *     has never run for it either — there is nothing here to decide on
 *     until they do).
 */
export async function fetchCurrentReviewIdForDecisions(userId: string): Promise<CurrentReviewForDecisions | null> {
  const period = await determineCurrentWeeklyReviewPeriod(userId, new Date());
  if (period.status === 'caught_up') return null;

  const review = await fetchWeeklyReviewByPeriodStart(userId, period.periodStart);
  if (!review) return null;

  return { reviewId: review.id };
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export interface PendingGraduationPromptRow {
  id: string;
  rank: number;
  /** Raw jsonb — parsed against `graduationEvidenceSchema` by the caller
   *  (`accept-graduation.ts`/the decisions page), not here. This file has
   *  no opinion about `GraduationEvidence`'s own shape, matching
   *  `review-prompts-repository.ts`'s own "this function performs no
   *  eligibility logic of its own" separation of concerns. */
  payload: unknown;
}

/**
 * Every PENDING `kind = 'graduation'` prompt for this review, oldest-
 * ranked first — §2.1's "Part 2 decisions, one at a time," scoped to
 * graduation only per this slice's own explicit scope boundary (not every
 * kind Module 06 will eventually support — see this repo's own
 * `app/(app)/review/decisions/page.tsx` header for how "Decision N of M"
 * is defined against ONLY this filtered set, not every pending prompt of
 * every kind).
 */
export async function fetchPendingGraduationPrompts(userId: string, reviewId: string): Promise<PendingGraduationPromptRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string; rank: number; payload: unknown }>(
      `select id, rank, payload
         from retrospeq.review_prompts
        where user_id = $1 and review_id = $2 and kind = 'graduation' and state = 'pending'
        order by rank asc, created_at asc`,
      [userId, reviewId],
    );
    return res.rows;
  });
}

export interface GraduationDecisionCounts {
  /** Every `kind = 'graduation'` prompt ever written for this review,
   *  regardless of state — the denominator for §5.1's "Decision N of M"
   *  label. Stable for the life of a review (Slice 4's `writeReviewPrompts`
   *  only ever deletes/reinserts `state = 'pending'` rows for THIS review,
   *  and only when the whole review is recomputed — see that function's
   *  own header — so an already-accepted/deferred graduation row from
   *  earlier in the same session is never silently dropped out of this
   *  count once counted). */
  total: number;
  pending: number;
}

/**
 * `index` for §5.1's "Decision N of M" is `total - pending + 1` — how many
 * graduation decisions in this review have already been resolved
 * (accepted or deferred), plus one for whichever one is about to be shown.
 * A plain `COUNT(*) FILTER` query rather than two round trips.
 */
export async function fetchGraduationDecisionCounts(userId: string, reviewId: string): Promise<GraduationDecisionCounts> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ total: string; pending: string }>(
      `select count(*)::text as total,
              count(*) filter (where state = 'pending')::text as pending
         from retrospeq.review_prompts
        where user_id = $1 and review_id = $2 and kind = 'graduation'`,
      [userId, reviewId],
    );
    const row = res.rows[0];
    return { total: Number(row?.total ?? '0'), pending: Number(row?.pending ?? '0') };
  });
}

export interface PromptRow {
  id: string;
  reviewId: string | null;
  kind: string;
  state: string;
  payload: unknown;
}

/** One prompt, owned by `userId`, kind-checked by the caller (this
 *  function has no opinion on `kind` — both `acceptGraduationDecision` and
 *  `deferDecision` re-check it themselves against the exact kind they
 *  handle, rather than this shared read silently filtering). `null` when
 *  no such row exists for this user — a stale/foreign `promptId` reads
 *  identically to a genuinely nonexistent one, matching this repo's own
 *  established "not found, not a distinguishable cross-user signal"
 *  posture (`rules/actions.ts`'s `RULE_NOT_FOUND` precedent). */
export async function fetchPromptById(userId: string, promptId: string): Promise<PromptRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string; review_id: string | null; kind: string; state: string; payload: unknown }>(
      `select id, review_id, kind, state, payload
         from retrospeq.review_prompts
        where id = $1 and user_id = $2`,
      [promptId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, reviewId: row.review_id, kind: row.kind, state: row.state, payload: row.payload };
  });
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/**
 * §6.2's `pending --accept--> accepted` transition, guarded exactly the
 * way this repo guards every state transition that must not double-fire
 * (`promoteRuleSeverity`, `retireRuleState`): the `where state = 'pending'`
 * clause is the REAL enforcement, not a pre-check — a concurrent second
 * accept attempt for the same prompt (a double-submit) affects zero rows
 * here and is the caller's own signal to treat this as the §9
 * `PROMPT_ALREADY_DECIDED` idempotent-replay case rather than creating a
 * second rule. `ruleId`/`ruleRendered` are merged into the EXISTING
 * `payload` jsonb (`payload || jsonb_build_object(...)`) rather than
 * overwriting it, so the original evidence stays intact for the replay
 * path's own re-parse.
 */
export async function markPromptAccepted(
  userId: string,
  promptId: string,
  ruleId: string,
  ruleRendered: string,
): Promise<{ id: string } | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string }>(
      `update retrospeq.review_prompts
          set state = 'accepted',
              decided_at = now(),
              payload = payload || jsonb_build_object('ruleId', $3::uuid, 'ruleRendered', $4::text)
        where id = $1 and user_id = $2 and kind = 'graduation' and state = 'pending'
        returning id`,
      [promptId, userId, ruleId, ruleRendered],
    );
    return res.rows[0] ?? null;
  });
}

/**
 * §4.5's defer — "returns next review, still under the cap. No penalty."
 * Sets ONLY `state = 'deferred'`; deliberately does NOT touch
 * `decided_at` (a defer is explicitly "not deciding yet" — `decided_at`
 * is reserved for a real accept/decline outcome) and does NOT write
 * `prompt_history` (§4.5, verbatim: decline — not defer — is what creates
 * `prompt_history` tracking; conflating the two would wrongly start a
 * decline-count/dormancy clock on a subject the trader never actually
 * declined). See docs/adr/0040 for why re-surfacing next review needs no
 * code here at all: Slice 4's own eligibility/ranking pipeline
 * (`computeAndWriteReviewPrompts`) recomputes candidates from LIVE
 * eligibility + `prompt_history` on every future materialisation, never
 * from old `review_prompts` rows — a deferred row with no `prompt_history`
 * entry is, by construction, still eligible next time.
 */
export async function markPromptDeferred(userId: string, promptId: string): Promise<{ id: string } | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string }>(
      `update retrospeq.review_prompts
          set state = 'deferred'
        where id = $1 and user_id = $2 and kind = 'graduation' and state = 'pending'
        returning id`,
      [promptId, userId],
    );
    return res.rows[0] ?? null;
  });
}
