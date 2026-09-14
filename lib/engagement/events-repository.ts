import 'server-only';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 07 (Engagement) §4/§5.1/§5.4/§5.5 — Slice 2: the append-only
 * `engagement_events` XP ledger and `milestones`. Slice 1
 * (`streak-repository.ts`, `week-completeness-repository.ts`) built the
 * streak mechanism only; this file adds the four real emission kinds
 * (`day_closed`, `review_completed`, `pre_entry_verified`,
 * `milestone_reached`) and materialises `engagement_state.total_xp`.
 *
 * ## The one governing constraint (§2)
 *
 * "Never reward anything the trader can fabricate." Every insert this
 * file performs carries a `verification_source` that is NEVER the
 * trader's own unverified input — `broker_feed`/`manual_entry` (day
 * closed, keyed to the account's own `platform` column), `system_observed`
 * (a review actually closing, server-derived), `timestamp_proof` (an
 * `arm_events.armed_at` that predates a real `fills.filled_at`), or
 * `derived` (a milestone, computed from this table's/`engagement_state`'s
 * own already-verified data). **Adherence, rule follows/breaks, and field
 * completeness emit nothing, ever** — no call site anywhere in this repo
 * passes a `kind` outside the four this table's own CHECK constraint
 * allows, and `__tests__/events-repository.test.ts`'s grep-style test
 * fails the build if one ever does (§8.2's own property-test list, "no
 * event exists whose verification_source is the trader's own unverified
 * input" / "no engagement event references a rule, evaluation, finding,
 * or P&L value").
 *
 * ## `subject_id` — always real, never null, for every kind this file
 * writes (see the migration's own header)
 *
 * `review_completed`/`pre_entry_verified` use the real `reviews.id`/
 * `trades.id` UUID directly. `day_closed` has no natural UUID —
 * `day_closeouts`' own primary key is the composite
 * `(user_id, account_id, server_day)` — so `dayClosedSubjectId` below
 * derives a STABLE, DETERMINISTIC uuid-shaped id from
 * `(account_id, server_day)` via a plain SHA-256 hash (RFC 4122 v5-style
 * construction, pure and reproducible — no pgcrypto/uuid-ossp `uuid_generate_v5`
 * needed, since this only ever needs to be computed in application code,
 * never in SQL). `milestone_reached` similarly derives a stable id from
 * the `milestone_id` string alone via `milestoneSubjectId` — combined
 * with the row's own `user_id`, the full `(user_id, kind, subject_type,
 * subject_id)` tuple is still unique per user, so the ledger's own
 * `engagement_events_idempotent` constraint (not just `milestones`' own
 * primary key) also refuses a duplicate `milestone_reached` row. This is
 * what makes "replaying a job awards nothing twice" (§5.1, §8.2) true by
 * construction rather than by the caller remembering to check first.
 *
 * ## `total_xp` — materialised on every successful (non-duplicate) insert
 *
 * §5.4: "XP accrues and is never spent, never lost, never deducted."
 * `engagement_state.total_xp` is recomputed as a full `sum(xp)` over this
 * user's own `engagement_events` rows, inside the SAME transaction as the
 * insert, immediately after a genuinely NEW row lands (an `ON CONFLICT DO
 * NOTHING` no-op skips the recompute too — nothing changed, so there is
 * nothing new to materialise). This is the write-side half of "materialised.
 * Never computed from the ledger at read time" (§4's own DDL comment) —
 * `fetchEngagementSummaryForUser` (`streak-repository.ts`) only ever reads
 * the already-materialised column, never sums the ledger itself.
 *
 * ## Milestones — evaluated after every real emission, §5.5
 *
 * `evaluateMilestones` re-derives all five conditions fresh from already-
 * verified state (ledger counts + `engagement_state.streak_weeks`) and
 * inserts any newly-reached one with `ON CONFLICT (user_id, milestone_id)
 * DO NOTHING RETURNING milestone_id` — only a row that ACTUALLY got
 * inserted (never a replay) goes on to emit its own `milestone_reached`
 * event. Called from every emission function below AND from
 * `streak-repository.ts`'s own `recomputeEngagementState` (the only place
 * `streak_weeks` is freshly known) — see that file's own updated header.
 *
 * ## XP for `milestone_reached` — a genuine judgment call, flagged for the
 * decision log
 *
 * §5.5's own table gives every milestone a `Condition` but no `Verification`/
 * `XP` column of its own (unlike §5.1's four real events, which each name
 * an XP amount) — "varies" is the only word §5.1's own summary row uses.
 * Nothing elsewhere in the module spec resolves what "varies" means
 * numerically. This file awards **0 XP for every milestone** rather than
 * inventing a number the spec never gave: `total_xp` stays an honest sum
 * of only the four amounts §5.1 actually specifies (10/25/5/0), and the
 * `milestone_reached` ROW/EVENT itself (visible on Home per §6.1, frame
 * 1.18) is the real reward — XP is explicitly "not the USP" (§1) and
 * "may be shown quietly on a profile screen; nothing depends on it" (§5.4),
 * so a wrong invented number here would carry real fabrication risk for
 * zero product benefit. A future slice with an actual product decision on
 * milestone XP amounts can raise this from 0 without any schema change.
 */

// ---------------------------------------------------------------------
// Kinds — the ONLY four this table's own CHECK constraint (and this
// file's own logic) ever writes. Exported so the grep-style test and any
// future caller both reference the single source of truth, not a second
// hardcoded list.
// ---------------------------------------------------------------------

export const ENGAGEMENT_EVENT_KINDS = [
  'day_closed',
  'review_completed',
  'pre_entry_verified',
  'milestone_reached',
] as const;
export type EngagementEventKind = (typeof ENGAGEMENT_EVENT_KINDS)[number];

export const MILESTONE_IDS = [
  'first_closeout',
  'first_review',
  '4wk_streak',
  '12wk_streak',
  '50_verified_captures',
] as const;
export type MilestoneId = (typeof MILESTONE_IDS)[number];

/** §5.5 — every milestone currently awards 0 XP. See this file's header. */
const MILESTONE_XP = 0;

// ---------------------------------------------------------------------
// Deterministic subject ids — pure, no I/O, directly unit-testable
// ---------------------------------------------------------------------

/** RFC-4122-shaped (version nibble set to 5, variant nibble set per spec)
 *  but derived from a plain SHA-256 digest of the input string — a real
 *  uuid-v5-style deterministic id without needing a Postgres-side
 *  `uuid_generate_v5`/pgcrypto call. Same bytes in, same uuid out, always. */
function deterministicUuidFrom(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  const bytes = hash.slice(0, 32).split('');
  bytes[12] = '5'; // version nibble
  const variantSource = parseInt(bytes[16], 16);
  bytes[16] = ((variantSource & 0x3) | 0x8).toString(16); // variant nibble
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** `day_closed`'s own subject id — see this file's header. Stable per
 *  (accountId, serverDay); NOT per user alone (a user can have several
 *  accounts, each closing the same calendar day independently). */
export function dayClosedSubjectId(accountId: string, serverDay: string): string {
  return deterministicUuidFrom(`retrospeq:day_closed:${accountId}:${serverDay}`);
}

/** `milestone_reached`'s own subject id — see this file's header. Stable
 *  per milestoneId alone; combined with the row's own user_id, the full
 *  ledger tuple is still unique per (user, milestone). */
export function milestoneSubjectId(milestoneId: MilestoneId): string {
  return deterministicUuidFrom(`retrospeq:milestone:${milestoneId}`);
}

// ---------------------------------------------------------------------
// Core insert — shared by every emission function below
// ---------------------------------------------------------------------

interface EmitParams {
  userId: string;
  kind: EngagementEventKind;
  verificationSource: 'broker_feed' | 'manual_entry' | 'system_observed' | 'timestamp_proof' | 'derived';
  subjectType: 'day' | 'review' | 'trade' | 'milestone';
  subjectId: string;
  serverDay?: string | null;
  xp: number;
  occurredAt: Date;
}

interface EmitResult {
  inserted: boolean;
}

/**
 * Inserts one `engagement_events` row, idempotent via the table's own
 * `engagement_events_idempotent` unique constraint. Never throws for a
 * duplicate — `ON CONFLICT DO NOTHING` — but DOES let a genuine DB error
 * (e.g. connection failure) propagate, since every caller of this
 * function is itself wrapped in a best-effort try/catch at the real call
 * site (`confirmDay`/`runSync`/`closeWeeklyReview`'s own post-commit
 * hooks), matching `recomputeEngagementForConfirmations`'s established
 * "never block the underlying action, but log loudly" posture.
 */
async function emitEngagementEvent(client: PoolClient, params: EmitParams): Promise<EmitResult> {
  const res = await client.query<{ id: string }>(
    `insert into retrospeq.engagement_events
       (user_id, kind, verification_source, subject_type, subject_id, server_day, xp, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (user_id, kind, subject_type, subject_id) do nothing
     returning id`,
    [
      params.userId,
      params.kind,
      params.verificationSource,
      params.subjectType,
      params.subjectId,
      params.serverDay ?? null,
      params.xp,
      params.occurredAt.toISOString(),
    ],
  );
  const inserted = res.rows.length > 0;
  if (inserted) {
    // §5.4/§4's own "materialised... never computed from the ledger at
    // read time" — this is the WRITE side of that split. A full re-sum
    // (not an increment) so this stays correct even if a future admin/
    // erasure operation ever touches the ledger directly.
    await client.query(
      `update retrospeq.engagement_state
          set total_xp = (select coalesce(sum(xp), 0) from retrospeq.engagement_events where user_id = $1)
        where user_id = $1`,
      [params.userId],
    );
  }
  return { inserted };
}

// ---------------------------------------------------------------------
// Milestones — §5.5
// ---------------------------------------------------------------------

interface MilestoneCounts {
  dayClosedCount: number;
  reviewCompletedCount: number;
  preEntryVerifiedCount: number;
  streakWeeks: number;
}

async function fetchMilestoneCounts(client: PoolClient, userId: string): Promise<MilestoneCounts> {
  const countsRes = await client.query<{ kind: string; n: string }>(
    `select kind, count(*)::text as n
       from retrospeq.engagement_events
      where user_id = $1 and kind in ('day_closed', 'review_completed', 'pre_entry_verified')
      group by kind`,
    [userId],
  );
  const byKind = new Map(countsRes.rows.map((r) => [r.kind, Number(r.n)]));

  const streakRes = await client.query<{ streak_weeks: number }>(
    `select streak_weeks from retrospeq.engagement_state where user_id = $1`,
    [userId],
  );

  return {
    dayClosedCount: byKind.get('day_closed') ?? 0,
    reviewCompletedCount: byKind.get('review_completed') ?? 0,
    preEntryVerifiedCount: byKind.get('pre_entry_verified') ?? 0,
    streakWeeks: streakRes.rows[0]?.streak_weeks ?? 0,
  };
}

/** Pure decision, directly unit-testable — which milestones ARE currently
 *  satisfied given the counts, regardless of whether they were already
 *  recorded (the caller's `ON CONFLICT DO NOTHING` handles "already
 *  reached"). */
export function milestonesSatisfiedBy(counts: MilestoneCounts): MilestoneId[] {
  const satisfied: MilestoneId[] = [];
  if (counts.dayClosedCount >= 1) satisfied.push('first_closeout');
  if (counts.reviewCompletedCount >= 1) satisfied.push('first_review');
  if (counts.streakWeeks >= 4) satisfied.push('4wk_streak');
  if (counts.streakWeeks >= 12) satisfied.push('12wk_streak');
  if (counts.preEntryVerifiedCount >= 50) satisfied.push('50_verified_captures');
  return satisfied;
}

/**
 * Evaluates all five §5.5 conditions fresh and records any newly-reached
 * milestone (insert-once via `milestones`' own primary key), emitting a
 * `milestone_reached` engagement_event for each one actually inserted
 * (never for one already reached). Called from every emission function
 * below and from `streak-repository.ts`'s `recomputeEngagementState`
 * (the only place `streak_weeks` changes) — see this file's header.
 * Never throws internally beyond what the caller's own connection would
 * already throw; every real call site wraps this in the same best-effort
 * posture as the rest of Module 07's post-commit recomputes.
 */
export async function evaluateMilestones(client: PoolClient, userId: string, now: Date): Promise<MilestoneId[]> {
  const counts = await fetchMilestoneCounts(client, userId);
  const satisfied = milestonesSatisfiedBy(counts);
  if (satisfied.length === 0) return [];

  const newlyReached: MilestoneId[] = [];
  for (const milestoneId of satisfied) {
    const insertRes = await client.query<{ milestone_id: string }>(
      `insert into retrospeq.milestones (user_id, milestone_id, reached_at)
       values ($1, $2, $3)
       on conflict (user_id, milestone_id) do nothing
       returning milestone_id`,
      [userId, milestoneId, now.toISOString()],
    );
    if (insertRes.rows.length > 0) {
      newlyReached.push(milestoneId);
      await emitEngagementEvent(client, {
        userId,
        kind: 'milestone_reached',
        verificationSource: 'derived',
        subjectType: 'milestone',
        subjectId: milestoneSubjectId(milestoneId),
        xp: MILESTONE_XP,
        occurredAt: now,
      });
    }
  }
  return newlyReached;
}

// ---------------------------------------------------------------------
// Public emission functions — one per §5.1 real emission kind, each
// opening its own service-role connection (matching
// `recomputeEngagementStateForUser`'s own standalone-wrapper shape) so
// every real call site can call these AFTER its own transaction has
// committed, best-effort, never blocking the underlying action.
// ---------------------------------------------------------------------

/** §5.1 — 10 XP, `confirmDay` only (never auto-confirm, §3.3 — enforced
 *  entirely by the CALLER never invoking this from `autoConfirmStaleTrades`,
 *  same "distinction preserved by construction, not a special-cased flag"
 *  posture `streak-repository.ts`'s own header already established for
 *  the identical §3.3 constraint). `platform` decides `broker_feed` vs
 *  `manual_entry` per §5.1's own literal table. */
export async function emitDayClosedEvent(params: {
  userId: string;
  accountId: string;
  serverDay: string;
  platform: string;
  now: Date;
}): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await emitEngagementEvent(client, {
      userId: params.userId,
      kind: 'day_closed',
      verificationSource: params.platform === 'manual' ? 'manual_entry' : 'broker_feed',
      subjectType: 'day',
      subjectId: dayClosedSubjectId(params.accountId, params.serverDay),
      serverDay: params.serverDay,
      xp: 10,
      occurredAt: params.now,
    });
    await evaluateMilestones(client, params.userId, params.now);
  });
}

/** §5.1 — 25 XP, only on a REAL close (never `already_closed`/replay —
 *  enforced by the caller only invoking this when `closeWeeklyReview`
 *  itself returns `status: 'closed'`, i.e. `alreadyCompleted === false`). */
export async function emitReviewCompletedEvent(params: { userId: string; reviewId: string; now: Date }): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await emitEngagementEvent(client, {
      userId: params.userId,
      kind: 'review_completed',
      verificationSource: 'system_observed',
      subjectType: 'review',
      subjectId: params.reviewId,
      xp: 25,
      occurredAt: params.now,
    });
    await evaluateMilestones(client, params.userId, params.now);
  });
}

/** §5.1 — 5 XP per trade, only when the matched arm event's own
 *  `armed_at < fill.filled_at` (strict — proof that judgment genuinely
 *  preceded the fill, §2.3). The caller (`sync.ts`'s `matchPendingArmEvents`)
 *  is the only place that both timestamps are known together at match
 *  time — see that file's own updated header for why this fires there,
 *  not at `confirmDay` time (the pre-entry lock itself already happens at
 *  match time, per Module 02 §4.5's own `lockPreEntryCaptures` call). */
export async function emitPreEntryVerifiedEvent(params: { userId: string; tradeId: string; now: Date }): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await emitEngagementEvent(client, {
      userId: params.userId,
      kind: 'pre_entry_verified',
      verificationSource: 'timestamp_proof',
      subjectType: 'trade',
      subjectId: params.tradeId,
      xp: 5,
      occurredAt: params.now,
    });
    await evaluateMilestones(client, params.userId, params.now);
  });
}

// ---------------------------------------------------------------------
// Read — frame 1.18's "most recent milestone reached in the last 7 days"
// ---------------------------------------------------------------------

export interface RecentMilestone {
  milestoneId: MilestoneId;
  reachedAt: string;
}

/**
 * The single most recently reached milestone, ONLY if it landed within
 * the last 7 days — frame 1.18's own Home Clear-state condition ("shows
 * the most recent milestone reached in the last 7 days"). `null`
 * otherwise (older, or never), a correct "nothing to show" read, not an
 * error. Runs under `withUserConnection` (genuinely RLS-enforced) — never
 * called with a service-role connection, since this is a plain read no
 * different from any other owner-scoped dashboard query.
 */
export async function fetchRecentMilestoneForUser(userId: string, now: Date): Promise<RecentMilestone | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ milestone_id: string; reached_at: string }>(
      `select milestone_id, reached_at::text as reached_at
         from retrospeq.milestones
        where user_id = $1 and reached_at >= $2
        order by reached_at desc
        limit 1`,
      [userId, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { milestoneId: row.milestone_id as MilestoneId, reachedAt: row.reached_at };
  });
}

/**
 * Erasure step 3b (Module 01 §4.6, docs/adr/0010). `engagement_events`
 * has a `BEFORE DELETE` forbid-mutation trigger, so the final
 * `auth.admin.deleteUser` cascade from `profiles` (a different connection,
 * no escape hatch) would abort erasure the moment a user has one row —
 * the same bug class the ADR's addendum found for `fields` and `rules`.
 * Deletes explicitly with `retrospeq.erasure_in_progress` set local to this
 * transaction. `milestones` has no trigger but goes in the same pass so the
 * ledger and what it earned are erased together.
 */
export async function deleteAllEngagementEventsForUser(userId: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
    await client.query('delete from retrospeq.milestones where user_id = $1', [userId]);
    await client.query('delete from retrospeq.engagement_events where user_id = $1', [userId]);
  });
}
