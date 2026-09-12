import { createClient } from '@/lib/supabase/server';
import type { WeeklyReadPayload } from '@/lib/review/weekly-read-payload';
import type { FindingPayload } from '@/lib/analytics/findings-payload';
import { formatRMultiple } from '../trades/format';
import { formatReviewPeriodLine, fractionTrend } from './format';
import { fetchWeeklyReviewRead } from './actions';

/**
 * Module 06 (Review & Graduation) §4.2/§5.1 — the weekly review's PART 1
 * "the read" screen ONLY (`/review`). Not Part 2 (decisions — accept/
 * decline/defer), not Part 3 (close), not deferral/backlog, not the
 * monthly trend view (§4.9) — all separate future slices, per this
 * slice's own dispatch scope. Route naming, the compute-on-view
 * materialisation strategy, and the current-period selection algorithm
 * are all documented in full in `docs/adr/0039-weekly-review-compute-on-
 * view-and-current-period.md` — read that file before changing any of the
 * three.
 *
 * **Entitlement**: `lib/entitlements/capability-table.ts` has no
 * capability named for reviews or this screen specifically — `streak`
 * and `adherence` (the two Module 07/04 sources this panel reads) are
 * both already `{ free: true, pro: true }`, and Module 05's own findings
 * pipeline already degrades honestly per-analytic via `canRender`
 * (`weekly-findings.ts`, unchanged by this slice). This screen is
 * therefore available to every plan, matching `/strategies`' own
 * documented posture ("view is not plan-gated, individual pieces degrade
 * honestly instead") — no new capability was added because none of the
 * four panels this slice renders needs one. Part 2's `graduation` capability
 * (already `{ free: false, pro: true }` in the table) is the natural gate
 * for the DECISIONS this screen's own button defers to, once that slice
 * exists — not this read-only screen.
 *
 * This module "orchestrates and does not compute" (§10) — every number
 * below is read from an already-assembled `WeeklyReadPayload`
 * (`weekly-read-payload.ts`), itself composed entirely of already-
 * materialised sources. Deciding WHICH period to assemble
 * (`current-period.ts`) and materialising it on demand if nothing has yet
 * (the compute-on-view mitigation, ADR 0039) — this page performs no
 * statistics or rule evaluation of its own.
 *
 * **Rate limiting (2026-09-13 security-review fix):** the entire
 * compute-on-view pipeline above now runs behind `./actions.ts`'s
 * `fetchWeeklyReviewRead`, an `enforceRateLimit`-wrapped Server Action —
 * this page's own render calls that action directly, not
 * `determineCurrentWeeklyReviewPeriod`/`assembleWeeklyReadPayload`/
 * `upsertWeeklyReview`/`computeAndWriteReviewPrompts`/
 * `fetchWeeklyReviewByPeriodStart`/`fetchPendingPromptCount` (all now
 * imported only by `actions.ts`, not here). This closes a real, security-
 * reviewer-found blocking gap: this route had no `actions.ts` at all and
 * no rate limiting anywhere in a chain that is considerably more expensive
 * per request than the already-rate-limited `rules`/`strategies` page-load
 * reads this repo's own established convention was written for (see
 * `lib/rate-limit/config.ts`'s `weeklyReview` scope comment for the full
 * reasoning behind the chosen limit). Matches `rules/page.tsx`'s/
 * `strategies/page.tsx`'s own "call the rate-limited Server Action
 * directly from the page, not the underlying library function" posture.
 */
export default async function WeeklyReviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback every other page
  // in this app tree uses.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  // The entire compute-on-view pipeline (period selection, freeze check,
  // and the recompute-if-needed chain) now lives behind this rate-limited
  // Server Action — see this file's own header, "Rate limiting" note, and
  // `./actions.ts`'s own doc comment for the full mapping from the prior
  // inline version.
  const result = await fetchWeeklyReviewRead();

  if (!result.success) {
    // `REVIEW_SESSION_MISSING` (should not happen here — the `!user` guard
    // above already covers a signed-out visitor, but the action re-derives
    // its own session independently, per this repo's established
    // double-check convention) or `REVIEW_RATE_LIMITED` — an honest,
    // retryable alert, same shape as `rules/page.tsx`'s own
    // `adherenceResult.error?.user_message` fallback.
    return (
      <p className="rq-sub" role="alert">
        {result.error?.user_message ?? 'Your review is unavailable right now.'}
      </p>
    );
  }

  if (result.status === 'caught_up') {
    // §4.2 Part 3's own steady state ("Next review Sunday. Nothing to do
    // until then.") — reached here whenever the trader has already
    // completed a review covering every week up to the most recently
    // ended one. Unreachable today (nothing sets `completed_at` yet, ADR
    // 0039 decision 3) but written correctly for when Part 3 ships.
    return (
      <section className="flex flex-col gap-3" aria-labelledby="review-h">
        <h1 id="review-h" className="rq-h1">
          You&apos;re caught up.
        </h1>
        <p className="rq-sub">Nothing to review yet — check back after this week closes.</p>
      </section>
    );
  }

  if (result.status === 'unavailable') {
    // §9 REVIEW_NOT_READY — "Engines haven't finished... Your review is
    // being prepared. Never a partial review." The very next page view
    // retries the whole compute from scratch (ADR 0039 decision 2's own
    // consequence) — no persisted "failed" state to get stuck in.
    return (
      <section className="flex flex-col gap-3" aria-labelledby="review-h">
        <h1 id="review-h" className="rq-h1">
          Your review is being prepared.
        </h1>
        <p className="rq-sub">Please try again in a moment.</p>
      </section>
    );
  }

  // Only the `status: 'ready'` variant of the union is left at this point —
  // TypeScript's own discriminated-union narrowing (on `result.status`)
  // guarantees `periodStart`/`periodEnd`/`coversWeeks`/`pendingCount`/
  // `readPayload` are all genuinely present here, not just optionally so.
  const { periodStart, periodEnd, coversWeeks, pendingCount, readPayload } = result;
  const periodLine = formatReviewPeriodLine(periodStart, periodEnd, coversWeeks);
  const { outcome, consistency, adherence, findings } = readPayload;

  return (
    <section className="flex flex-col gap-6" aria-labelledby="review-h">
      <div className="flex flex-col gap-1">
        <p className="rq-sub">{periodLine}</p>
        <h1 id="review-h" className="rq-h1">
          <span className="rq-num">{outcome.tradeCount}</span> {outcome.tradeCount === 1 ? 'trade' : 'trades'} ·{' '}
          <span className="rq-num">{outcome.daysTradedCount}</span> {outcome.daysTradedCount === 1 ? 'day' : 'days'} ·{' '}
          <span className="rq-num">{formatRMultiple(outcome.totalR)}</span>
        </h1>
      </div>

      <ConsistencyPanel daysTraded={consistency.daysTraded} daysClosed={consistency.daysClosed} streakWeeks={consistency.streakWeeks} />

      <AdherencePanel adherence={adherence} />

      <FindingsPanel findings={findings} />

      <div className="flex flex-col gap-2">
        <button type="button" className="rq-btn" disabled aria-disabled="true" title="Decisions and closing out this review aren't available yet.">
          {pendingCount > 0 ? `${pendingCount} ${pendingCount === 1 ? 'decision' : 'decisions'}` : 'Week closed'}
        </button>
        <p className="rq-sub">Decisions and closing out this review aren&apos;t available yet.</p>
      </div>
    </section>
  );
}

function ConsistencyPanel({ daysTraded, daysClosed, streakWeeks }: { daysTraded: number; daysClosed: number; streakWeeks: number }) {
  return (
    <section className="rq-card flex flex-col gap-2" aria-labelledby="p-consistency">
      <h2 id="p-consistency" className="rq-h2">
        Consistency
      </h2>
      <p className="rq-body">
        {daysTraded > 0 ? (
          <>
            <span className="rq-num">{daysClosed}</span> of <span className="rq-num">{daysTraded}</span> days closed out.
          </>
        ) : daysClosed > 0 ? (
          <>
            <span className="rq-num">{daysClosed}</span> {daysClosed === 1 ? 'day' : 'days'} closed out — no trading this period.
          </>
        ) : (
          'No trading days this week.'
        )}
      </p>
      <p className="rq-sub">
        {streakWeeks > 0 ? (
          <>
            <span className="rq-num">{streakWeeks}</span>-week streak intact.
          </>
        ) : (
          'Streak not started yet.'
        )}
      </p>
    </section>
  );
}

function AdherencePanel({ adherence }: { adherence: WeeklyReadPayload['adherence'] }) {
  if (adherence.status === 'insufficient_history') {
    return (
      <section className="rq-card flex flex-col gap-2" aria-labelledby="p-adherence">
        <h2 id="p-adherence" className="rq-h2">
          Adherence
        </h2>
        <p className="rq-sub">Not enough data yet.</p>
      </section>
    );
  }

  const { hard, soft, priorSoft, attribution } = adherence;
  const trend = priorSoft ? fractionTrend(soft, priorSoft) : null;

  return (
    <section className="rq-card flex flex-col gap-2" aria-labelledby="p-adherence">
      <h2 id="p-adherence" className="rq-h2">
        Adherence
      </h2>
      <p className="rq-body">
        Hard rules: <span className="rq-num">{hard.followed}</span> of <span className="rq-num">{hard.total}</span>.
      </p>
      <p className="rq-body">
        Soft: <span className="rq-num">{soft.followed}</span> of <span className="rq-num">{soft.total}</span>
        {priorSoft && trend !== null ? (
          <>
            , {trend} from <span className="rq-num">{priorSoft.followed}</span> of <span className="rq-num">{priorSoft.total}</span>
          </>
        ) : null}
        .
      </p>
      {attribution && (
        <p className="rq-sub">
          {attribution.rendered ?? 'One rule'} accounts for <span className="rq-num">{attribution.count}</span> of the{' '}
          <span className="rq-num">{attribution.ofBreaks}</span> {attribution.severity} breaks.
        </p>
      )}
    </section>
  );
}

function FindingsPanel({ findings }: { findings: WeeklyReadPayload['findings'] }) {
  return (
    <section className="rq-card flex flex-col gap-3" aria-labelledby="p-findings">
      <h2 id="p-findings" className="rq-h2">
        What your trades say
      </h2>
      {findings.length === 0 ? (
        // §5.1's own zero-prompt-week reference markup, reused verbatim
        // (ADR 0039 decision 5) — a trader with no active strategies yet
        // (every real trader today) legitimately has nothing here.
        <div className="finding" data-confidence="insufficient">
          <p className="finding__statement">Not enough data yet.</p>
        </div>
      ) : (
        <ul className="findings flex flex-col gap-3">
          {findings.map((f) => (
            <li key={`${f.strategyId}:${f.fieldId}`}>
              <FindingCard fieldName={f.fieldName} payload={f.payload} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Duplicated, deliberately, from `strategies/[id]/page.tsx`'s own
 * `FindingCard`/`confidenceAttr` — same `.finding`/`.finding__statement`/
 * `.finding__meta` markup and CSS, not reinvented. See ADR 0039 decision 6
 * for why this is a small local copy rather than a shared component (this
 * repo has no shared `components/` directory yet, and extracting one
 * would mean touching an already-reviewed Module 03 file for a slice
 * scoped to Module 06).
 */
function confidenceAttr(confidence: FindingPayload['confidence']): string {
  return confidence === 'null_result' ? 'null-result' : confidence;
}

function FindingCard({ fieldName, payload }: { fieldName: string; payload: FindingPayload }) {
  return (
    <div className="finding" data-confidence={confidenceAttr(payload.confidence)} data-analytic={payload.analytic_id}>
      <p className="rq-body font-semibold">{fieldName}</p>
      <p className="finding__statement">{payload.statement}</p>
      <FindingMeta payload={payload} />
    </div>
  );
}

function FindingMeta({ payload }: { payload: FindingPayload }) {
  if (payload.confidence === 'insufficient') {
    const remaining = payload.remaining ?? 0;
    if (remaining <= 0) {
      return <p className="finding__meta">More trades needed.</p>;
    }
    return (
      <p className="finding__meta">
        <span className="rq-num">{remaining}</span> more {remaining === 1 ? 'trade' : 'trades'} on this setup.
      </p>
    );
  }

  return (
    <p className="finding__meta">
      <span className="rq-num">{payload.n}</span> {payload.n === 1 ? 'trade' : 'trades'}
      {payload.confidence !== 'null_result' ? ` · ${payload.confidence}` : ''}
    </p>
  );
}
