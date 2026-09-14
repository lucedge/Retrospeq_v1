/**
 * Module 06 (Review & Graduation) §4.8 — "pending prompts older than 4
 * weeks expire silently rather than accumulating." §6.2's state machine:
 * `pending`/`deferred` -- 4 weeks unopened --> `expired` (silent, no
 * `prompt_history` write — see `review-prompts-repository.ts`'s
 * `expireStalePromptsForUser` for why this is neither a decline nor a
 * notification).
 *
 * **Timestamp decision (dispatch asked this be made explicit and
 * documented): the cutoff is measured against the prompt's OWN REVIEW'S
 * `period_end`, not `created_at`/`decided_at`.** A `review_prompts` row has
 * no `created_at` that means "the week this was offered" independently of
 * its review (Slice 4's `writeReviewPrompts` does stamp `created_at`, but
 * only at INSERT time — a prompt that sat `deferred` across several
 * `writeReviewPrompts` re-materialisations of the SAME still-open review
 * would have a `created_at` that drifts forward every time, which is not
 * "how old is this prompt" in the sense §4.8 means). `reviews.period_end`
 * is the one stable, spec-defined anchor for "which week's decision is
 * this" (ADR 0039's own period model) — a prompt from the week of 21 July
 * is 4-weeks-old once `now` passes 21 July + 4 weeks, regardless of when it
 * happened to be (re)written to `pending`/`deferred`.
 *
 * Pure, no I/O — independently unit-testable, matching every other
 * pure computation in `lib/review/` (`ranking.ts`, `prompt-history-
 * repository.ts`'s `filterDormant`).
 */

export const PROMPT_EXPIRY_WINDOW_DAYS = 28;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The instant before which a prompt's own review's `period_end` makes it
 *  eligible for silent expiry. */
export function promptExpiryCutoff(asOfDate: Date): Date {
  return new Date(asOfDate.getTime() - PROMPT_EXPIRY_WINDOW_DAYS * MS_PER_DAY);
}

/** `true` when a prompt materialised for a review ending at `reviewPeriodEnd`
 *  is strictly older than the 4-week window, as of `asOfDate`. */
export function isPastExpiryCutoff(reviewPeriodEnd: Date, asOfDate: Date): boolean {
  return reviewPeriodEnd.getTime() < promptExpiryCutoff(asOfDate).getTime();
}

/**
 * Frame 4.11's mono `<time>` — "2 wk ago". Whole weeks elapsed since the
 * prompt's own review ended, floored, minimum 1 (the backlog view only
 * ever shows a prompt from a review OTHER than the current one — see
 * `fetchDeferredBacklogForUser`'s own `excludeReviewId` — so a prompt
 * reaching this function has, by construction, already had at least one
 * full week pass since its own review's period ended).
 */
export function formatBacklogAge(reviewPeriodEnd: Date, asOfDate: Date): string {
  const diffMs = asOfDate.getTime() - reviewPeriodEnd.getTime();
  const weeks = Math.max(1, Math.floor(diffMs / (7 * MS_PER_DAY)));
  return `${weeks} wk ago`;
}
