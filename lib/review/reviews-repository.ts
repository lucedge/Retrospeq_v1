import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
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
