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

export interface PendingDecisionPromptRow {
  id: string;
  rank: number;
  kind: 'graduation' | 'relaxation';
  /** Raw jsonb — parsed against `graduationEvidenceSchema`/
   *  `relaxationEvidenceSchema` by the caller, keyed on `kind`, not here.
   *  This file has no opinion about either evidence shape, matching
   *  `review-prompts-repository.ts`'s own "this function performs no
   *  eligibility logic of its own" separation of concerns. */
  payload: unknown;
}

/**
 * Every PENDING `kind in ('graduation', 'relaxation')` prompt for this
 * review, oldest-ranked first — §2.1's "Part 2 decisions, one at a time."
 *
 * Module 06 Slice 7 widened this from graduation-only (Slice 6) to also
 * include relaxation — the two kinds this repo's `/review/decisions`
 * screen can render a real decision for today. `rank` already encodes the
 * cross-kind priority §4.3 specifies (relaxation ranked ahead of
 * graduation across the WHOLE review at write time — `ranking.ts`'s own
 * `rankAndCapPromptCandidates`), so `order by rank asc` alone is sufficient
 * to produce the correct "next decision across kinds" ordering — no
 * per-kind interleaving logic needed here. Promotion/retirement/detection
 * are deliberately NOT in this `kind in (...)` list yet — no decision
 * screen exists for them (a future slice's own scope, not a bug: those
 * rows simply sit `pending` until that slice ships, exactly like
 * relaxation itself sat unrendered between Slice 4 and this one).
 */
export async function fetchPendingDecisionPrompts(userId: string, reviewId: string): Promise<PendingDecisionPromptRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string; rank: number; kind: 'graduation' | 'relaxation'; payload: unknown }>(
      `select id, rank, kind, payload
         from retrospeq.review_prompts
        where user_id = $1 and review_id = $2 and kind in ('graduation', 'relaxation') and state = 'pending'
        order by rank asc, created_at asc`,
      [userId, reviewId],
    );
    return res.rows;
  });
}

export interface DecisionCounts {
  /** Every `kind in ('graduation', 'relaxation')` prompt ever written for
   *  this review, regardless of state — the denominator for §5.1's
   *  "Decision N of M" label. Stable for the life of a review (Slice 4's
   *  `writeReviewPrompts` only ever deletes/reinserts `state = 'pending'`
   *  rows for THIS review, and only when the whole review is recomputed —
   *  see that function's own header — so an already-decided row from
   *  earlier in the same session is never silently dropped out of this
   *  count once counted). */
  total: number;
  pending: number;
}

/**
 * `index` for §5.1's "Decision N of M" is `total - pending + 1` — how many
 * decisions (of the kinds this screen renders) in this review have already
 * been resolved, plus one for whichever one is about to be shown. A plain
 * `COUNT(*) FILTER` query rather than two round trips.
 */
export async function fetchDecisionCounts(userId: string, reviewId: string): Promise<DecisionCounts> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ total: string; pending: string }>(
      `select count(*)::text as total,
              count(*) filter (where state = 'pending')::text as pending
         from retrospeq.review_prompts
        where user_id = $1 and review_id = $2 and kind in ('graduation', 'relaxation')`,
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
 * §4.5/§4.7's "Recommit" — the trader chose to keep the rule exactly as it
 * is. Module 06 Slice 7's own reasoning (see `docs/adr/0041`, judgment call
 * #1): this is a REAL, engaged decision that resolves the prompt — the
 * trader looked at "you break this most weeks" and affirmatively said "I'm
 * keeping it anyway" — so it sets `state = 'accepted'` and `decided_at`,
 * NOT `'deferred'`. It is deliberately NOT the same as decline: §4.5's
 * `decline_count`/`prompt_history` dormancy tracking exists for a trader
 * who was OFFERED something and said no to the offer itself (e.g. "don't
 * turn this into a rule," "don't retire this"); recommit is the trader
 * affirming the CURRENT rule is correct, which is not a rejection of
 * anything Module 06 proposed. `payload` merges `resolution: 'recommit'`
 * only — no `ruleId`/`newValue`, since no rule write happens (mirrors
 * `markPromptAccepted`'s own `payload || jsonb_build_object(...)` merge
 * shape for the identical §9 `PROMPT_ALREADY_DECIDED` idempotent-replay
 * reason).
 */
export async function markPromptRecommitted(userId: string, promptId: string): Promise<{ id: string } | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string }>(
      `update retrospeq.review_prompts
          set state = 'accepted',
              decided_at = now(),
              payload = payload || jsonb_build_object('resolution', 'recommit'::text)
        where id = $1 and user_id = $2 and kind = 'relaxation' and state = 'pending'
        returning id`,
      [promptId, userId],
    );
    return res.rows[0] ?? null;
  });
}

/**
 * §4.7's "Adjust" — the trader chose to move the rule to where they
 * actually trade. The new rule VERSION itself is written by
 * `editRule`/`applyRuleEdit` (Module 04, called from `adjustRelaxation
 * Decision` BEFORE this function runs) — this function only records the
 * OUTCOME on the prompt row, the same "prompt bookkeeping is separate from
 * the domain write it authorises" split `markPromptAccepted` already
 * establishes for graduation (`createRuleInternal` writes the rule;
 * `markPromptAccepted` only marks the prompt). `newValue`/`newRendered`
 * are the POST-edit values (jsonb-encoded via `to_jsonb($4::text)` for
 * `newRendered`, and `$5::jsonb` for `newValue` since a rule's `value` can
 * be a number, string, or array depending on operand type — never assumed
 * numeric here, matching `rule_versions.value jsonb` itself).
 */
export async function markPromptAdjusted(
  userId: string,
  promptId: string,
  newValue: unknown,
  newRendered: string,
): Promise<{ id: string } | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string }>(
      `update retrospeq.review_prompts
          set state = 'accepted',
              decided_at = now(),
              payload = payload || jsonb_build_object('resolution', 'adjust'::text, 'newValue', $3::jsonb, 'newRendered', $4::text)
        where id = $1 and user_id = $2 and kind = 'relaxation' and state = 'pending'
        returning id`,
      [promptId, userId, JSON.stringify(newValue), newRendered],
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
 *
 * Deliberately still `kind = 'graduation'`-only (Module 06 Slice 7, `docs/
 * adr/0041`): §5.1's own relaxation reference markup shows exactly two
 * buttons ("Keep 1%" / "Change to 2%"), no third "Not yet" — Slice 7 keeps
 * this function scoped to graduation rather than widening it to a kind it
 * has no UI caller for yet, per this repo's own "build against a real
 * consumer, not a speculative one" posture (`review-prompts-repository.ts`'s
 * own `canRender`-gate header cites the identical reasoning for a different
 * decision). See `docs/adr/0041` for the full reasoning on why "Keep" — not
 * a third defer option — already plays the low-commitment role a defer
 * button would for relaxation.
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
