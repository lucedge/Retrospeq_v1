/**
 * Module 05 (Analytics & Findings) §3.1, §4.9 — the shadow harness.
 *
 * Scope: this module builds the harness's own infrastructure — the
 * `shadow_runs` data model, a generic runner, the persistence boundary,
 * and the mechanically-checkable half of the promotion criteria. It does
 * NOT implement the edge engine, the detection engine, the statistical
 * gates (§4.3), or the `spec.weekday` canary (§4.10) — those require
 * confirmed trades (Module 02), which does not exist yet in this repo
 * (no grouping engine has been built; only its golden fixtures have).
 * See PROGRESS.md's decision log for the full scope-boundary reasoning.
 *
 * The harness is deliberately agnostic to *how* an analytic decides
 * `would_render` / `gate_failures` — that is the analytic's own gating
 * logic, whatever engine eventually supplies it. The harness only
 * orchestrates: run it, persist the result, never render it.
 */

export type Uuid = string;

/** Mirrors a `shadow_runs` row (Module 05 §3.1) as it will be inserted. */
export interface ShadowRunRecord {
  user_id: Uuid;
  analytic_id: string;
  would_render: boolean;
  payload: Record<string, unknown>;
  gate_failures: string[] | null;
}

/** Full row as read back from the database. `id`/`computed_at` are DB-assigned. */
export interface ShadowRunRow extends ShadowRunRecord {
  id: Uuid;
  computed_at: string; // timestamptz, ISO 8601 UTC (00-foundation §2.2)
}

/** What a shadow analytic's own gating logic must produce. */
export interface ShadowComputeResult {
  would_render: boolean;
  payload: Record<string, unknown>;
  gate_failures: string[] | null;
}

/**
 * Contract every shadow analytic implements to register with the harness.
 * `TFact` is left generic on purpose: today nothing can supply real
 * `EligibleTradeFact[]` data (Module 02 doesn't exist), so registering an
 * analytic against synthetic or fixture-derived facts for testing is a
 * first-class, expected use of this type — not a workaround.
 */
export interface ShadowAnalytic<TFact> {
  /** Matches the analytics registry (analytics-registry.md). Stable, never reused. */
  analytic_id: string;
  /**
   * True for analytics the promotion helper must never mark eligible,
   * regardless of gate outcome — Module 05 §4.10, the weekday canary:
   * "someone will eventually try to 'fix' it by promoting it."
   */
  permanently_shadow?: boolean;
  compute(facts: TFact[]): ShadowComputeResult;
}
