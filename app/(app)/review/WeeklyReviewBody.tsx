'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { WeeklyReadPayload } from '@/lib/review/weekly-read-payload';
import type { FindingPayload } from '@/lib/analytics/findings-payload';
import type { RuleChangeAnnotation } from '@/lib/rules/rule-change-annotations';
import { formatRMultiple } from '../trades/format';
import { fractionTrend } from './format';
import { closeWeeklyReview, type CloseWeeklyReviewResult } from './actions';

/**
 * Module 06 (Review & Graduation) §4.2/§5.1 — Parts 1 + 3 of `/review`
 * (Part 1 "the read", Part 3 "close"), moved here from `page.tsx` (a
 * Server Component) as a Client Component ONLY because Part 3 needs
 * `useActionState` — see `./actions.ts`'s own `closeWeeklyReview` header,
 * "Why this returns `closeSummary` inline," for the full reasoning:
 * `determineCurrentWeeklyReviewPeriod`'s own cursor advances past a period
 * the instant it closes, so a plain page reload after closing can never
 * re-observe THIS review's own frozen state — frame 4.12 ("Week closed.")
 * is therefore rendered as an immediate, one-time confirmation of the
 * action's own return value, the same pattern `ConfirmDayForm.tsx`
 * already established in this repo (`useActionState`, result card driven
 * by `state`, no second server round trip).
 *
 * Every panel below (`ConsistencyPanel`/`AdherencePanel`/`FindingsPanel`)
 * is a pure, no-fetch presentational component — moved verbatim from
 * `page.tsx`, not reimplemented — the parent Server Component still does
 * every real data fetch (`fetchWeeklyReviewRead`) and passes the already-
 * resolved payload down as plain props.
 */

function closeAction(
  _prevState: CloseWeeklyReviewResult | undefined,
  _formData: FormData,
): Promise<CloseWeeklyReviewResult> {
  // No client input at all (`./actions.ts`'s own "nothing for a caller to
  // legitimately vary" note) — this wrapper exists only because
  // `useActionState` requires a `(prevState, formData) => Promise<State>`
  // shape; the real Server Action itself still takes zero arguments.
  return closeWeeklyReview();
}

export function WeeklyReviewBody({
  periodLine,
  outcome,
  consistency,
  adherence,
  ruleChangeAnnotations,
  findings,
  pendingCount,
}: {
  periodLine: string;
  outcome: WeeklyReadPayload['outcome'];
  consistency: WeeklyReadPayload['consistency'];
  adherence: WeeklyReadPayload['adherence'];
  ruleChangeAnnotations: RuleChangeAnnotation[];
  findings: WeeklyReadPayload['findings'];
  pendingCount: number;
}) {
  const [state, formAction, pending] = useActionState<CloseWeeklyReviewResult | undefined, FormData>(
    closeAction,
    undefined,
  );

  if (state?.success && (state.status === 'closed' || state.status === 'already_closed')) {
    // Part 3 "close" (frame 4.12): "Done" / "Week closed." / an honest
    // one-line summary / "Next review Sunday..." / one ghost link back to
    // /dashboard — nothing else on this screen, the read/decisions panels
    // above are gone.
    return (
      <section className="review review--close flex flex-col gap-3" aria-labelledby="review-close-h" role="status">
        <p className="review__step rq-sub">Done</p>
        <h1 id="review-close-h" className="rq-h1">
          Week closed.
        </h1>
        <p className="review__summary rq-body">{state.closeSummary}</p>
        <p className="review__next rq-sub">Next review Sunday. Nothing to do until then.</p>
        <Link href="/dashboard" className="rq-btn rq-btn--ghost">
          Back to home
        </Link>
      </section>
    );
  }

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

      <AdherencePanel adherence={adherence} ruleChangeAnnotations={ruleChangeAnnotations} />

      <FindingsPanel findings={findings} />

      <div className="flex flex-col gap-2">
        {pendingCount > 0 ? (
          <>
            {/* Module 06 Slice 6: wired for real — Slice 5 shipped this
                disabled ("Decisions and closing out this review aren't
                available yet"). Links to `/review/decisions`, which
                currently only renders GRADUATION-kind decisions (see that
                route's own `actions.ts` header) — a pending count that
                happens to be entirely relaxation/promotion/retirement/
                detection prompts (no UI yet for any of those) lands on
                that screen's own honest "Nothing to decide right now"
                state rather than a broken/empty one. */}
            <Link href="/review/decisions" className="rq-btn">
              {pendingCount} {pendingCount === 1 ? 'decision' : 'decisions'}
            </Link>
            <p className="rq-sub">Closing out this review isn&apos;t available yet.</p>
          </>
        ) : (
          // Module 06 Part 3 "close" — every prompt for this review has
          // been decided (pending count is zero), so closing is a real
          // action.
          <form action={formAction}>
            {state?.success === false && state.error && (
              <p className="rq-sub" role="alert">
                {state.error.user_message}
              </p>
            )}
            {state?.success && state.status === 'pending_prompts' && (
              <p className="rq-sub" role="alert">
                New decisions appeared since this loaded — review them before closing.
              </p>
            )}
            <button type="submit" className="rq-btn" disabled={pending}>
              {pending ? 'Closing…' : 'Week closed'}
            </button>
          </form>
        )}
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

/**
 * Module 06 §4.7's "annotates the adherence timeline" — a quiet
 * attribution-weight `<ul>` under the adherence numbers, one line per
 * rule threshold change that fell inside THIS review's own period, most
 * recent first, max 3 (`buildRuleChangeAnnotations`'s own cap). Renders
 * nothing when there are none — the common case (most weeks touch no
 * rule at all) is not an omission to apologise for. Never a button,
 * never a colour — same posture as `Adherence.tsx`'s own identical
 * component on `/rules` (deliberately duplicated rather than shared:
 * that file's version lives in a Server Component's own module tree and
 * this one in a Client Component's, and the JSX itself is four lines).
 */
function RuleChangeAnnotations({ annotations }: { annotations: RuleChangeAnnotation[] }) {
  if (annotations.length === 0) return null;
  return (
    <ul className="adherence__attribution list-none pl-0 flex flex-col gap-1">
      {annotations.map((a) => (
        <li key={a.ruleId + a.date}>
          You changed {a.subjectPhrase}
          {a.change ? (
            <>
              {' '}
              from <span className="rq-num">{a.change.from}</span> to <span className="rq-num">{a.change.to}</span>
            </>
          ) : null}{' '}
          on {a.date}.
        </li>
      ))}
    </ul>
  );
}

function AdherencePanel({
  adherence,
  ruleChangeAnnotations,
}: {
  adherence: WeeklyReadPayload['adherence'];
  ruleChangeAnnotations: RuleChangeAnnotation[];
}) {
  if (adherence.status === 'insufficient_history') {
    return (
      <section className="rq-card flex flex-col gap-2" aria-labelledby="p-adherence">
        <h2 id="p-adherence" className="rq-h2">
          Adherence
        </h2>
        <p className="rq-sub">Not enough data yet.</p>
        <RuleChangeAnnotations annotations={ruleChangeAnnotations} />
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
      <RuleChangeAnnotations annotations={ruleChangeAnnotations} />
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
