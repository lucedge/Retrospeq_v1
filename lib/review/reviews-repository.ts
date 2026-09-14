import 'server-only';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import type { WeeklyReadPayload } from './weekly-read-payload';

/**
 * Module 06 (Review & Graduation) Slice 2 — the materialisation half of
 * §4.10's "weekly job, per user, at period end": steps 3 ("assemble
 * read_payload", `weekly-read-payload.ts`) and 5 ("write reviews...")
 * ONLY. Steps 4 (prompt candidates, ranking, the 3-cap) and 6
 * (notification) are explicitly out of this slice's own scope — see
 * `weekly-read-payload.ts`'s own header and
 * `docs/adr/0036-weekly-review-read-payload-assembly.md`.
 *
 * `service_role`, matching every other materialised-table writer in this
 * repo (`recomputeAdherenceWeeklyForUser`, `recomputeEngagementStateForUser`)
 * — `reviews` carries an owner "for all" RLS policy (unlike those two
 * tables' owner-SELECT-only shape, since §6.2's state machine needs a
 * genuine TRADER-initiated write for `opened_at`/`completed_at` later),
 * but THIS write is the scheduled-job half, which has no real user
 * session to run `withUserConnection` against — see this slice's own
 * migration comment: "in practice §4.10 assembles/writes the bulk of a
 * `reviews` row from a scheduled job (service role, bypasses RLS
 * anyway)." Every query below still filters explicitly on `user_id`,
 * defense in depth, matching this repo's own established
 * `withServiceRoleConnection` discipline.
 *
 * **`opened_at`/`completed_at` are deliberately never touched by this
 * upsert** (omitted from the `on conflict ... do update set` list
 * entirely) — a genuine judgment call, documented in docs/adr/0036: a
 * review that a trader has already opened or completed must not have
 * that fact silently erased by a LATER re-materialisation (e.g. a
 * late-arriving confirmation that lands after the trader already opened
 * this week's review, which a future scheduler might legitimately
 * re-run to refresh the numbers). Only `period_end`/`covers_weeks`/
 * `read_payload`/`computed_at` are ever overwritten on conflict.
 */

export class InvalidReviewPeriodError extends Error {
  constructor(periodStart: string, periodEnd: string) {
    super(
      `reviews-repository: [${periodStart}, ${periodEnd}] is not a valid weekly review period — ` +
        `periodEnd must be periodStart plus a whole number of 7-day weeks, minus one day (never zero or negative weeks).`,
    );
    this.name = 'InvalidReviewPeriodError';
  }
}

/**
 * `covers_weeks` (§3, §4.8: ">1 when a review was missed") is fully
 * determined by the two dates a caller already chose — "was a review
 * missed" is the SCHEDULER's own future decision (out of scope here,
 * §4.10 step 1-2, not built), made BEFORE this function is ever called,
 * by picking a `periodEnd` that spans more than one week. This is purely
 * the mechanical arithmetic that follows from that choice, not a second
 * copy of the "was it missed" business logic.
 */
export function deriveCoversWeeks(periodStart: string, periodEnd: string): number {
  const startMs = Date.parse(`${periodStart}T00:00:00.000Z`);
  const endMs = Date.parse(`${periodEnd}T00:00:00.000Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new InvalidReviewPeriodError(periodStart, periodEnd);
  }
  const dayCount = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
  if (dayCount <= 0 || dayCount % 7 !== 0) {
    throw new InvalidReviewPeriodError(periodStart, periodEnd);
  }
  return dayCount / 7;
}

export interface WeeklyReviewRecord {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  coversWeeks: number;
  openedAt: string | null;
  completedAt: string | null;
  computedAt: string;
}

interface WeeklyReviewQueryRow {
  id: string;
  period_start: string;
  period_end: string;
  covers_weeks: number;
  opened_at: string | null;
  completed_at: string | null;
  computed_at: string;
}

/**
 * Upserts ONE `reviews` row for `(userId, 'weekly', periodStart)`, per
 * §3's own `unique (user_id, period_kind, period_start)` constraint. The
 * caller (a future scheduler, or a test calling this directly per this
 * slice's own dispatch — "callable directly with an explicit
 * periodStart/periodEnd") supplies an already-assembled
 * `WeeklyReadPayload` (`weekly-read-payload.ts`'s own
 * `assembleWeeklyReadPayload`) — this function performs no assembly of
 * its own, only the write.
 */
export async function upsertWeeklyReview(
  userId: string,
  periodStart: string,
  periodEnd: string,
  payload: WeeklyReadPayload,
): Promise<WeeklyReviewRecord> {
  const coversWeeks = deriveCoversWeeks(periodStart, periodEnd);

  return withServiceRoleConnection(async (client) => {
    const res = await client.query<WeeklyReviewQueryRow>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, covers_weeks, read_payload, computed_at)
       values ($1, 'weekly', $2, $3, $4, $5::jsonb, now())
       on conflict (user_id, period_kind, period_start) do update
         set period_end   = excluded.period_end,
             covers_weeks = excluded.covers_weeks,
             read_payload = excluded.read_payload,
             computed_at  = excluded.computed_at
         -- opened_at/completed_at deliberately OMITTED here -- see this
         -- file's own header. The unique constraint's own conflict target
         -- already includes user_id, so no separate WHERE guard is needed
         -- to prevent a cross-user overwrite here.
       returning id, period_start::text as period_start, period_end::text as period_end, covers_weeks,
                 opened_at::text as opened_at, completed_at::text as completed_at, computed_at::text as computed_at`,
      [userId, periodStart, periodEnd, coversWeeks, JSON.stringify(payload)],
    );
    const row = res.rows[0]!;
    return {
      id: row.id,
      userId,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      coversWeeks: row.covers_weeks,
      openedAt: row.opened_at,
      completedAt: row.completed_at,
      computedAt: row.computed_at,
    };
  });
}

/**
 * Module 06 Slice 5 — the FIRST reads this file has ever had (every prior
 * function here is a write; grep-confirmed at this slice's own dispatch
 * time). Both use `withUserConnection`, deliberately NOT
 * `withServiceRoleConnection` like the write functions above: unlike
 * §4.10's scheduled-job write (no real session), these two reads run
 * inside an actual authenticated page view (`app/(app)/review/page.tsx`)
 * — a real session exists at the call site, so RLS enforcement is a real,
 * available defense-in-depth layer here, matching every other page-level
 * read in this repo (`fetchPeriodOutcome`, `fetchPeriodConsistency`, ...)
 * rather than the scheduled-job posture. See `lib/review/current-period.ts`
 * for what calls `fetchLatestCompletedWeeklyReviewPeriodEnd`, and
 * `app/(app)/review/page.tsx` for what calls `fetchWeeklyReviewByPeriodStart`.
 */

/**
 * The `period_end` of this user's most recently COMPLETED weekly review
 * (`completed_at is not null`), or `null` if none exists yet (every real
 * trader today, since no Part 3 "close" UI has shipped yet — see
 * `docs/adr/0039` for why `current-period.ts` treats that as "first ever
 * review, don't backdate" rather than an error). Deliberately reads
 * `completed_at`, not `computed_at`: a review that has merely been
 * COMPUTED (this slice's own compute-on-view path runs on every
 * not-yet-completed period) must not count as "reviewed" for the purpose
 * of deciding what the NEXT period to show is — only a trader's own
 * completion of Part 3 should ever advance this cursor. Ordered by
 * `period_end desc` (not `period_start`) so a `covers_weeks > 1` (§4.8)
 * catch-up review correctly advances the cursor past every week it
 * covered, not just its first.
 */
export async function fetchLatestCompletedWeeklyReviewPeriodEnd(userId: string): Promise<string | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ period_end: string }>(
      `select period_end::text as period_end
         from retrospeq.reviews
        where user_id = $1 and period_kind = 'weekly' and completed_at is not null
        order by period_end desc
        limit 1`,
      [userId],
    );
    return res.rows[0]?.period_end ?? null;
  });
}

/**
 * The most recently COMPLETED weekly review's id — for `/review`'s
 * `caught_up` render, which shows that week's frame-4.12 close summary
 * ("Week closed.", what changed) until the next period is ready, instead
 * of a generic "caught up" line. Same owner-scoped read as
 * `fetchLatestCompletedWeeklyReviewPeriodEnd` above.
 */
export async function fetchLatestCompletedWeeklyReviewId(userId: string): Promise<string | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string }>(
      `select id
         from retrospeq.reviews
        where user_id = $1 and period_kind = 'weekly' and completed_at is not null
        order by period_end desc
        limit 1`,
      [userId],
    );
    return res.rows[0]?.id ?? null;
  });
}

/**
 * Module 08 (Onboarding & Home) §7.1 — the first real write to
 * `opened_at` anywhere in this repo (grep-confirmed at this slice's own
 * dispatch time; this file's own header already documented that
 * `upsertWeeklyReview` deliberately never touches it). `withUserConnection`,
 * not `withServiceRoleConnection`: called from `/review`'s own rate-limited
 * Server Action (`app/(app)/review/actions.ts`), behind a genuine
 * authenticated session — same posture this file's own Slice-5 reads
 * already established, not the scheduled-job write posture above.
 *
 * `coalesce(opened_at, now())` makes this idempotent AND non-destructive:
 * a trader re-visiting `/review` the same week must not have their real
 * first-open timestamp overwritten by a later view. A no-op (0 rows
 * affected, no error) if this exact `(userId, periodStart)` row does not
 * exist yet — every real call site invokes this only AFTER the row has
 * already been assembled/upserted for the same request, so this should
 * never actually race the write, but this function does not assume it:
 * an update matching zero rows is a normal, silent success here, not an
 * error to surface.
 */
export async function markReviewOpened(userId: string, periodStart: string): Promise<void> {
  await withUserConnection(userId, async (client) => {
    await client.query(
      `update retrospeq.reviews
          set opened_at = coalesce(opened_at, now())
        where user_id = $1 and period_kind = 'weekly' and period_start = $2`,
      [userId, periodStart],
    );
  });
}

/**
 * Module 06 (Review & Graduation) Part 3 "close" (§4.2/§5.1) — the first
 * write to `completed_at` anywhere in this repo (grep-confirmed at this
 * slice's own dispatch time; this file's own header already documented
 * that `upsertWeeklyReview` deliberately never touches it, same reasoning
 * as `opened_at`). `withUserConnection`, same posture `markReviewOpened`
 * above already established: a real authenticated session exists at every
 * real call site (`/review`'s own rate-limited `closeWeeklyReview` Server
 * Action), so RLS enforcement (`reviews_owner`'s "for all") is a real,
 * available defense-in-depth layer, and every query below is additionally
 * scoped explicitly to `user_id = $1`.
 *
 * A review only closes when every `review_prompts` row for it has moved
 * OUT of `pending` — §4.2 Part 2's "decisions, one at a time" must be
 * genuinely done first. A `deferred` prompt counts as decided for this
 * purpose (§4.5: defer is itself a real outcome, "returns next review,
 * still under the cap. No penalty" — it is not left dangling, it is
 * re-surfaced by a future materialisation, per `markPromptDeferred`'s own
 * header), so this check is exactly `state = 'pending'`, nothing wider.
 *
 * `completed_at = coalesce(completed_at, now())` mirrors `markReviewOpened`'s
 * own idempotent-and-non-destructive shape: a second close attempt on an
 * already-closed review (a double submit, or a trader revisiting a stale
 * tab) is a normal, silent success, never an error and never a timestamp
 * overwrite. One transaction (`withUserConnection` already wraps its
 * callback in begin/commit — `lib/supabase/direct.ts`) covers the read,
 * the pending-prompt check, and the write together, so no other request on
 * this same connection can observe a review that passed the pending-prompt
 * check but has not yet actually closed.
 */
export type MarkReviewCompletedResult =
  | { status: 'completed'; reviewId: string; alreadyCompleted: boolean }
  | { status: 'pending_prompts' }
  | { status: 'not_found' };

export async function markReviewCompleted(userId: string, periodStart: string): Promise<MarkReviewCompletedResult> {
  return withUserConnection(userId, async (client) => {
    const reviewRes = await client.query<{ id: string; completed_at: string | null }>(
      `select id, completed_at::text as completed_at
         from retrospeq.reviews
        where user_id = $1 and period_kind = 'weekly' and period_start = $2`,
      [userId, periodStart],
    );
    const review = reviewRes.rows[0];
    if (!review) return { status: 'not_found' };
    if (review.completed_at !== null) {
      return { status: 'completed', reviewId: review.id, alreadyCompleted: true };
    }

    const pendingRes = await client.query<{ has_pending: boolean }>(
      `select exists(
         select 1 from retrospeq.review_prompts
          where user_id = $1 and review_id = $2 and state = 'pending'
       ) as has_pending`,
      [userId, review.id],
    );
    if (pendingRes.rows[0]?.has_pending) {
      return { status: 'pending_prompts' };
    }

    await client.query(
      `update retrospeq.reviews
          set completed_at = coalesce(completed_at, now())
        where user_id = $1 and id = $2`,
      [userId, review.id],
    );
    return { status: 'completed', reviewId: review.id, alreadyCompleted: false };
  });
}

export interface WeeklyReviewWithPayload extends WeeklyReviewRecord {
  readPayload: WeeklyReadPayload;
}

/**
 * The full `reviews` row (including its stored `read_payload`) for
 * `(userId, 'weekly', periodStart)`, or `null` if this period has never
 * been materialised. `app/(app)/review/page.tsx` uses this to decide
 * whether to reuse an already-COMPLETED review's frozen payload as-is, or
 * to fall through to a fresh `assembleWeeklyReadPayload` +
 * `upsertWeeklyReview` compute (see docs/adr/0039's "compute on view"
 * decision for the full reasoning on why "not completed" is the
 * recompute trigger, not a `computed_at`/`period_end` timestamp
 * comparison).
 */
export async function fetchWeeklyReviewByPeriodStart(
  userId: string,
  periodStart: string,
): Promise<WeeklyReviewWithPayload | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<WeeklyReviewQueryRow & { read_payload: WeeklyReadPayload }>(
      `select id, period_start::text as period_start, period_end::text as period_end, covers_weeks,
              opened_at::text as opened_at, completed_at::text as completed_at, computed_at::text as computed_at,
              read_payload
         from retrospeq.reviews
        where user_id = $1 and period_kind = 'weekly' and period_start = $2`,
      [userId, periodStart],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      coversWeeks: row.covers_weeks,
      openedAt: row.opened_at,
      completedAt: row.completed_at,
      computedAt: row.computed_at,
      readPayload: row.read_payload,
    };
  });
}
