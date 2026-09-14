import 'server-only';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import type { RankedPromptCandidate } from './prompt-candidates/ranking';

/**
 * Module 06 (Review & Graduation) Slice 4, §3/§4.3/§4.10 — the WRITE half:
 * persisting the already-ranked, already-capped candidate set into
 * `review_prompts`. Schema landed at Slice 1
 * (`supabase/migrations/20260911020000_review_graduation_schema.sql`); no
 * writer has existed until now (grep-confirmed at this slice's own dispatch
 * time — the only prior touches were Slice 3's read-only
 * `fetchMutedSubjectKeys` against the sibling `prompt_history` table).
 *
 * `service_role`, same reasoning `reviews-repository.ts`'s own
 * `upsertWeeklyReview` already documents and was already security-reviewed
 * for at Slice 2's gate: `review_prompts` carries a real owner "for all"
 * RLS policy (a trader can later accept/decline/defer their own prompts),
 * but THIS write is the scheduled-job half of §4.10 ("weekly job, per user,
 * at period end... write reviews + review_prompts") — no real authenticated
 * session exists at the call site for `withUserConnection` to run against.
 * Every query below still filters explicitly on `user_id`/`review_id`,
 * defense in depth, matching this repo's own established
 * `withServiceRoleConnection` discipline.
 *
 * **Idempotent re-materialisation** (docs/adr/0038, judgment call): a
 * rerun of the same week's job (retry, or a future scheduler re-running to
 * refresh numbers, mirroring `upsertWeeklyReview`'s own already-accepted
 * re-materialisation posture) must not accumulate duplicate rows.
 * `review_prompts` has no natural uniqueness constraint beyond its own
 * surrogate `id`, so this function DELETEs this review's own existing
 * `state = 'pending'` rows before inserting the fresh set, all inside one
 * transaction (`withServiceRoleConnection` already wraps `fn` in
 * begin/commit — `lib/supabase/direct.ts`'s own header). Deliberately
 * scoped to `state = 'pending'` only, never `accepted`/`declined`/
 * `deferred`/`expired` — those states can only be reached once a real
 * trader-facing accept/decline/defer UI exists (explicitly out of this
 * slice's own scope), so in every real case today this deletes either zero
 * rows (first materialisation) or exactly last run's own untouched pending
 * set — but is written to never silently erase a real decision a future
 * slice's UI produces.
 */

export interface WrittenReviewPrompt {
  id: string;
  reviewId: string;
  rank: number;
  kind: string;
  subjectType: string;
  subjectId: string;
}

interface ReviewPromptInsertRow {
  id: string;
  rank: number;
  kind: string;
  subject_type: string;
  subject_id: string;
}

/**
 * Replaces this review's own pending prompt set with `ranked` (already
 * ranked/capped by `rankAndCapPromptCandidates`, already `canRender`-gated
 * and dormancy-filtered by the caller — this function performs no
 * eligibility logic of its own, only the write). `payload` stores the
 * candidate's raw structured `evidence` object — see docs/adr/0038's
 * "payload contents" decision for why full statement/cost/options PROSE
 * synthesis (§4.6/§4.7's worked examples) is deliberately deferred to
 * whichever future slice builds the actual prompt-rendering UI, the same
 * "no live consumer to design against yet" reasoning the Slice 3 security
 * review already applied to the `canRender`-surface judgment call.
 */
export async function writeReviewPrompts(
  userId: string,
  reviewId: string,
  ranked: readonly RankedPromptCandidate[],
): Promise<WrittenReviewPrompt[]> {
  return withServiceRoleConnection(async (client) => {
    await client.query(
      `delete from retrospeq.review_prompts
        where user_id = $1 and review_id = $2 and state = 'pending'`,
      [userId, reviewId],
    );

    const written: ReviewPromptInsertRow[] = [];
    for (const candidate of ranked) {
      const res = await client.query<ReviewPromptInsertRow>(
        `insert into retrospeq.review_prompts
           (user_id, review_id, kind, rank, subject_type, subject_id, payload)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)
         returning id, rank, kind, subject_type, subject_id`,
        [
          userId,
          reviewId,
          candidate.kind,
          candidate.rank,
          candidate.subjectType,
          candidate.subjectId,
          JSON.stringify(candidate.evidence),
        ],
      );
      written.push(res.rows[0]!);
    }

    return written.map((row) => ({
      id: row.id,
      reviewId,
      rank: row.rank,
      kind: row.kind,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
    }));
  });
}

/**
 * Module 06 Slice 5 — the weekly review's own "N decisions" / "Week
 * closed" button (§5.1) needs a pending-prompt COUNT, not the rows
 * themselves (Part 2's decision-by-decision UI, which reads and renders
 * `payload`, is a separate future slice — see that slice's own scope
 * note). `withUserConnection`, not `withServiceRoleConnection`: this is a
 * real page-view-time read behind a real authenticated session (same
 * reasoning `reviews-repository.ts`'s two new Slice-5 reads document),
 * unlike `writeReviewPrompts` above, which is the scheduled-job write
 * half with no session to run a user-scoped connection against.
 */
export async function fetchPendingPromptCount(userId: string, reviewId: string): Promise<number> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ count: string }>(
      `select count(*)::text as count
         from retrospeq.review_prompts
        where user_id = $1 and review_id = $2 and state = 'pending'`,
      [userId, reviewId],
    );
    return Number(res.rows[0]?.count ?? '0');
  });
}

/**
 * Module 06 Part 3 "close" (§5.1's own "Part 3: close" reference markup —
 * "One line summarising what changed") — every ACCEPTED prompt for this
 * review, kind + payload only. Deliberately `state = 'accepted'` only, not
 * `declined`/`deferred`/`expired`: those states record that a decision was
 * MADE, not what CHANGED (declined/deferred/expired are all "nothing
 * changed" from the trader's own rules' point of view — no rule was added,
 * kept, or edited by any of them), and no `declined` state is even
 * reachable yet (no decline-writing function exists in this repo today,
 * grep-confirmed). `app/(app)/review/format.ts`'s `renderWeekCloseSummary`
 * turns these raw rows into the actual one-line sentence — this function
 * has no opinion on wording, matching `fetchPendingDecisionPrompts`'s own
 * "no opinion about either evidence shape" separation of concerns.
 * `withUserConnection`: a real page-view-time read behind a real session
 * (`/review`'s own `fetchWeeklyReviewRead`), same posture as every other
 * read in this file.
 */
export interface DecidedPromptOutcomeRow {
  kind: string;
  payload: unknown;
}

export async function fetchDecidedPromptOutcomes(userId: string, reviewId: string): Promise<DecidedPromptOutcomeRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ kind: string; payload: unknown }>(
      `select kind, payload
         from retrospeq.review_prompts
        where user_id = $1 and review_id = $2 and state = 'accepted'`,
      [userId, reviewId],
    );
    return res.rows;
  });
}
