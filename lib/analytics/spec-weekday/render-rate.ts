/**
 * Module 05 (Analytics & Findings) §4.10 / §8 — the weekday canary's own
 * tracked metric: "the proportion of users for whom `spec.weekday` WOULD
 * render." Quality benchmark (§8's table, verbatim): "`spec.weekday`
 * canary render rate — **< 5%** of users. Above this, gates are too
 * loose."
 *
 * Pure — answered directly from `shadow_runs` rows the caller already has
 * (e.g. `ShadowRunRepository.listByAnalytic(WEEKDAY_CANARY_ANALYTIC_ID, since)`,
 * `shadow-harness/repository.ts`), matching this slice's own dispatch
 * instruction: "this may already be answerable from existing shadow_runs
 * data with the right query, in which case add that query function rather
 * than new schema." No new table, no new column — `shadow_runs` already
 * carries everything this needs (`user_id`, `would_render`, `computed_at`).
 *
 * LATEST-RUN-PER-USER DEDUPE — a deliberate, flagged choice: `shadow_runs`
 * is append-only (§3.1's own migration comment: "no upsert key... every
 * row... accumulated evidence, not current state"), so a user who has been
 * recomputed on several different runs contributes MULTIPLE rows for the
 * same analytic. "The proportion of users for whom it WOULD render, THIS
 * RUN" (§4.10's own wording) is a per-run, per-user snapshot, not "was it
 * ever true at any point in this user's history" — the latter would
 * mechanically inflate the rate for any user recomputed often enough, and
 * would make the metric un-comparable across time windows of different
 * lengths. This function therefore keeps only the MOST RECENT row per
 * `user_id` (by `computed_at`) among whatever rows the caller passed in,
 * and computes the rate over that deduped set — correct regardless of
 * whether the caller queried "all history," "last 24h," or any other
 * window, since a narrower `since` naturally narrows which rows exist to
 * dedupe from in the first place.
 */

import type { ShadowRunRow } from '../shadow-harness/types';
import { WEEKDAY_CANARY_ANALYTIC_ID } from './weekday-canary';

/** §8's own literal quality-benchmark threshold, as a 0..1 fraction. */
export const WEEKDAY_CANARY_RENDER_RATE_TARGET = 0.05;

export interface WeekdayCanaryRenderRate {
  analyticId: string;
  /** Distinct users contributing at least one `shadow_runs` row among the
   *  rows passed in. */
  usersEvaluated: number;
  /** Of `usersEvaluated`, how many had `would_render = true` on their most
   *  recent contributing row. */
  usersWhoWouldRender: number;
  /** `null` when `usersEvaluated === 0` — "not enough data yet" is a
   *  correct, intended state here too (AGENTS.md non-negotiable), never a
   *  fabricated `0`. */
  renderRate: number | null;
  /** `renderRate !== null && renderRate >= WEEKDAY_CANARY_RENDER_RATE_TARGET`
   *  — §8's own alert condition, computed once here so a caller (the
   *  runbook's "Shadow analytic diverging from expectation" check) never
   *  has to re-derive the comparison itself. `false` when `renderRate` is
   *  `null` — an unmeasured rate is not, by itself, evidence the gates are
   *  too loose. */
  exceedsTarget: boolean;
}

type CanaryRunRow = Pick<ShadowRunRow, 'user_id' | 'would_render' | 'computed_at'>;

export function computeWeekdayCanaryRenderRate(runs: readonly CanaryRunRow[]): WeekdayCanaryRenderRate {
  const latestByUser = new Map<string, CanaryRunRow>();
  for (const run of runs) {
    const existing = latestByUser.get(run.user_id);
    if (!existing || run.computed_at > existing.computed_at) {
      latestByUser.set(run.user_id, run);
    }
  }

  const usersEvaluated = latestByUser.size;
  const usersWhoWouldRender = [...latestByUser.values()].filter((r) => r.would_render).length;
  const renderRate = usersEvaluated === 0 ? null : usersWhoWouldRender / usersEvaluated;

  return {
    analyticId: WEEKDAY_CANARY_ANALYTIC_ID,
    usersEvaluated,
    usersWhoWouldRender,
    renderRate,
    exceedsTarget: renderRate !== null && renderRate >= WEEKDAY_CANARY_RENDER_RATE_TARGET,
  };
}
