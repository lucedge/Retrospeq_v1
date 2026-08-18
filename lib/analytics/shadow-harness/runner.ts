import type { ShadowAnalytic, ShadowComputeResult, ShadowRunRecord, Uuid } from './types';

/**
 * Module 05 §9 defines `ANALYTIC_COMPUTE_FAILED` ("Unexpected failure" →
 * "Log, alert if rate > 1% for that id, render nothing"). Shadow mode has
 * no render path to protect, but the same discipline applies to
 * persistence: a thrown error must never become a silently-fabricated
 * `shadow_runs` row. `runShadowAnalytic` re-throws this so the caller
 * (the nightly job, once one exists) can log/alert per 00-foundation
 * §7.3 — it is never swallowed into a guessed result.
 */
export class ShadowComputeError extends Error {
  readonly analytic_id: string;
  readonly user_id: Uuid;

  constructor(analyticId: string, userId: Uuid, cause: unknown) {
    super(`Shadow analytic "${analyticId}" failed to compute for user ${userId}`);
    this.name = 'ShadowComputeError';
    this.analytic_id = analyticId;
    this.user_id = userId;
    this.cause = cause;
  }
}

/**
 * Runs one shadow analytic against one user's facts and returns the row
 * to persist. Pure — no I/O. The caller is responsible for actually
 * writing the result (see repository.ts) and for supplying `facts`
 * (there is no live source of `EligibleTradeFact[]` yet — Module 02 does
 * not exist in this repo).
 *
 * Persistence is unconditional on `would_render`: writing a row when
 * `would_render` is false is exactly what "accumulate evidence without
 * being shown to users" (Module 05 §4.9) means — a shadow analytic that
 * silently clears its gates 0% of the time is itself the evidence.
 */
export function runShadowAnalytic<TFact>(
  analytic: ShadowAnalytic<TFact>,
  userId: Uuid,
  facts: TFact[],
): ShadowRunRecord {
  let result: ShadowComputeResult;
  try {
    result = analytic.compute(facts);
  } catch (cause) {
    throw new ShadowComputeError(analytic.analytic_id, userId, cause);
  }

  return {
    user_id: userId,
    analytic_id: analytic.analytic_id,
    would_render: result.would_render,
    payload: result.payload,
    gate_failures: result.gate_failures,
  };
}

/**
 * Convenience for the eventual nightly job (00-foundation §1.2's
 * "Deferred" job class — "Analytics recomputation, shadow analytic
 * runs... may lag, never blocks a user action"): run one analytic across
 * many users' facts, collecting successes and failures separately rather
 * than letting one user's exception abort the whole batch. Still pure —
 * the caller persists `succeeded` and alerts on `failed`.
 */
export interface ShadowBatchResult {
  succeeded: ShadowRunRecord[];
  failed: ShadowComputeError[];
}

export function runShadowAnalyticBatch<TFact>(
  analytic: ShadowAnalytic<TFact>,
  factsByUser: Map<Uuid, TFact[]>,
): ShadowBatchResult {
  const succeeded: ShadowRunRecord[] = [];
  const failed: ShadowComputeError[] = [];

  for (const [userId, facts] of factsByUser) {
    try {
      succeeded.push(runShadowAnalytic(analytic, userId, facts));
    } catch (err) {
      if (err instanceof ShadowComputeError) {
        failed.push(err);
      } else {
        throw err; // programmer error inside the harness itself — do not mask it
      }
    }
  }

  return { succeeded, failed };
}
