import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fetchMonthlyTrend } from "./actions";
import { formatAdherenceSequence, buildSparklinePoints, softRatios } from "@/lib/review/monthly-adherence";
import { formatR } from "@/lib/review/monthly-strategy-weight";

/**
 * Module 06 (Review & Graduation) §4.9/frame 4.13 — the monthly trend
 * view. "Trend only. Adherence direction over 3 months, edge stability,
 * which strategies pull weight. Zero prompts, ever. It is a read."
 *
 * No dev server used to build this screen — the render check for this
 * slice was a static `react-dom/server` HTML file linking the real
 * `public/brand/css/index.css`, screenshotted and read directly, matching
 * this slice's own dispatch instruction.
 *
 * Every number below comes from a compute-on-view read (three independent
 * repository reads run in parallel inside `./actions.ts`'s
 * `fetchMonthlyTrend`) — this route persists nothing to `reviews`
 * (`period_kind = 'monthly'` is a real, allowed value on that column, but
 * a materialised row is not required for an honest read — see this
 * slice's own dispatch, "a DB row isn't required: compute-on-view like
 * `/review` does is fine and honest").
 */
export default async function MonthlyReviewTrendPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback `/review`'s own
  // page uses.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const result = await fetchMonthlyTrend();

  if (!result.success) {
    return (
      <p className="rq-sub" role="alert">
        {result.error?.user_message ?? "The monthly trend is unavailable right now."}
      </p>
    );
  }

  const { periodLabel, adherence, edgeStability, strategyWeight } = result;
  const sparklinePoints = buildSparklinePoints(softRatios(adherence));
  const softLine = formatAdherenceSequence("Soft rules held", adherence, "soft");
  const hardLine = formatAdherenceSequence("Hard", adherence, "hard");

  return (
    <section className="review flex flex-col gap-6" aria-labelledby="month-h">
      <p className="review__period rq-sub">{periodLabel}</p>
      <h1 id="month-h" className="rq-h1">
        Three months in view
      </h1>

      <section className="panel" aria-labelledby="p-adherence-direction">
        <h2 id="p-adherence-direction" className="panel__title">
          Adherence direction
        </h2>
        {sparklinePoints ? (
          <>
            <svg className="rq-spark" viewBox="0 0 260 46" preserveAspectRatio="none" aria-label="Adherence trend">
              <polyline points={sparklinePoints} fill="none" stroke="var(--rq-mark)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="axis">
              {adherence.map((m) => (
                <span key={m.key}>{m.label}</span>
              ))}
            </div>
          </>
        ) : (
          <p className="finding__statement">Not enough data yet.</p>
        )}
        <p className="panel__meta">{softLine}</p>
        <p className="panel__meta">{hardLine}</p>
      </section>

      <section className="panel" aria-labelledby="p-edge-stability">
        <h2 id="p-edge-stability" className="panel__title">
          Edge stability
        </h2>
        {edgeStability.status === "ready" ? (
          <>
            <div className="rq-cmp">
              <div className="rq-cmp__row hot">
                <span className="rq-cmp__lbl">{edgeStability.cmp.afterLabel}</span>
                <div className="rq-cmp__track">
                  <i className="rq-cmp__fill" style={{ width: `${Math.min(100, Math.max(0, edgeStability.cmp.afterPct))}%` }} />
                </div>
                <span className="rq-cmp__val rq-num">{edgeStability.cmp.afterPct}%</span>
              </div>
              <div className="rq-cmp__row">
                <span className="rq-cmp__lbl">{edgeStability.cmp.beforeLabel}</span>
                <div className="rq-cmp__track">
                  <i className="rq-cmp__fill" style={{ width: `${Math.min(100, Math.max(0, edgeStability.cmp.beforePct))}%` }} />
                </div>
                <span className="rq-cmp__val rq-num">{edgeStability.cmp.beforePct}%</span>
              </div>
            </div>
            <p className="panel__meta">{edgeStability.observation}</p>
          </>
        ) : (
          <p className="finding__statement">Not enough data yet.</p>
        )}
      </section>

      <section className="panel" aria-labelledby="p-strategy-weight">
        <h2 id="p-strategy-weight" className="panel__title">
          Which strategies pull weight
        </h2>
        {strategyWeight.length > 0 ? (
          <>
            <div className="rq-cmp">
              {strategyWeight.map((s, i) => (
                <div key={s.strategyId} className={i === 0 ? "rq-cmp__row hot" : "rq-cmp__row"}>
                  <span className="rq-cmp__lbl">{s.name}</span>
                  <div className="rq-cmp__track">
                    <i className="rq-cmp__fill" style={{ width: `${s.widthPct}%` }} />
                  </div>
                  <span className="rq-cmp__val rq-num">{formatR(s.totalR)}</span>
                </div>
              ))}
            </div>
            <p className="panel__meta">In R over 3 months. Currency lives in Performance.</p>
          </>
        ) : (
          <p className="finding__statement">Not enough data yet.</p>
        )}
      </section>

      <p className="cap">A read with zero prompts, ever. Nothing to tap.</p>
      <p className="rq-sub">
        <Link href="/review">Back to your review</Link>
      </p>
    </section>
  );
}
