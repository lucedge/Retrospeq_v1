'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { WeeklyReadPayload } from '@/lib/review/weekly-read-payload';
import type { FindingPayload } from '@/lib/analytics/findings-payload';
import type { RuleChangeAnnotation } from '@/lib/rules/rule-change-annotations';
import { formatRMultiple } from '../trades/format';
import { fractionTrend, ringDashOffset, ringText } from './format';
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
  coversWeeks,
  ruleChangeAnnotations,
  findings,
  pendingCount,
}: {
  periodLine: string;
  outcome: WeeklyReadPayload['outcome'];
  consistency: WeeklyReadPayload['consistency'];
  adherence: WeeklyReadPayload['adherence'];
  coversWeeks: number;
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
      <section className="review review--close" aria-labelledby="review-close-h" role="status">
        <p className="review__step">Done</p>
        <h1 id="review-close-h" className="rq-h1">
          Week closed.
        </h1>
        <p className="review__summary">{state.closeSummary}</p>
        <p className="review__next">Next review Sunday. Nothing to do until then.</p>
        <Link href="/dashboard" className="rq-btn rq-btn--ghost">
          Back to home
        </Link>
      </section>
    );
  }

  return (
    <section className="review review--read" aria-labelledby="review-h">
      <p className="review__period">{periodLine}</p>
      <h1 id="review-h" className="review__outcome">
        <span className="rq-num">{outcome.tradeCount}</span> {outcome.tradeCount === 1 ? 'trade' : 'trades'} ·{' '}
        <span className="rq-num">{outcome.daysTradedCount}</span> {outcome.daysTradedCount === 1 ? 'day' : 'days'}
        {outcome.tradeCount > 0 ? (
          <>
            {' '}
            · <span className="rq-num">{formatRMultiple(outcome.totalR)}</span>
          </>
        ) : null}
      </h1>

      <ConsistencyPanel daysTraded={consistency.daysTraded} daysClosed={consistency.daysClosed} streakWeeks={consistency.streakWeeks} />

      <AdherencePanel adherence={adherence} coversWeeks={coversWeeks} ruleChangeAnnotations={ruleChangeAnnotations} />

      <FindingsPanel findings={findings} />

      {pendingCount > 0 ? (
        <div className="flex flex-col gap-2">
          {/* Module 06 Slice 6: wired for real — Slice 5 shipped this
              disabled ("Decisions and closing out this review aren't
              available yet"). Links to `/review/decisions`, which
              currently only renders GRADUATION-kind decisions (see that
              route's own `actions.ts` header) — a pending count that
              happens to be entirely relaxation/promotion/retirement/
              detection prompts (no UI yet for any of those) lands on
              that screen's own honest "Nothing to decide right now"
              state rather than a broken/empty one. */}
          <Link href="/review/decisions" className="rq-btn rq-btn--block">
            {pendingCount} {pendingCount === 1 ? 'decision' : 'decisions'}
          </Link>
          <p className="rq-sub">Closing out this review isn&apos;t available yet.</p>
        </div>
      ) : (
        // Module 06 Part 3 "close" — every prompt for this review has
        // been decided (pending count is zero), so closing is a real
        // action.
        <form action={formAction} className="flex flex-col gap-2">
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
          <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
            {pending ? 'Closing…' : 'Week closed'}
          </button>
        </form>
      )}

      {/* §4.9/frame 4.13 — a quiet text link, not an `.rq-btn` (this
          screen's only button is the CTA above; the monthly trend is a
          separate read with zero prompts of its own, see `/review/month`'s
          own header). Read-state only — frame 4.12's own close
          confirmation above has no such link, only "Back to home". */}
      <p className="rq-sub">
        <Link href="/review/month">See the 3-month trend</Link>
      </p>
    </section>
  );
}

/**
 * Frame 4.1/4.3/4.4/4.5's Consistency panel: a `.rq-ring` completeness
 * ring (real geometry, `format.ts`'s `ringDashOffset`/`ringText` — never
 * a re-derived percentage) beside the lead/meta copy, laid out as the
 * frame's own row (its literal `style="flex-direction:row;align-items:
 * center;gap:14px"` — transcribed as-is rather than a Tailwind
 * equivalent, since it deliberately overrides `.panel`'s default column
 * layout for this one instance only).
 */
function ConsistencyPanel({ daysTraded, daysClosed, streakWeeks }: { daysTraded: number; daysClosed: number; streakWeeks: number }) {
  const offset = ringDashOffset(daysClosed, daysTraded);
  const ringLabel = ringText(daysClosed, daysTraded);
  const missedDays = daysTraded - daysClosed;

  return (
    <section className="panel" style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }} aria-labelledby="p-consistency">
      <div className="rq-ring">
        <svg width="52" height="52" aria-hidden="true">
          <circle cx="26" cy="26" r="22" fill="none" stroke="var(--rq-mark-dim)" strokeWidth="4" />
          <circle
            cx="26"
            cy="26"
            r="22"
            fill="none"
            stroke="var(--rq-mark)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray="138"
            strokeDashoffset={offset}
          />
        </svg>
        <span className="rq-ring__text rq-num">{ringLabel}</span>
      </div>
      <div>
        <h2 id="p-consistency" className="panel__title">
          Consistency
        </h2>
        <p className="panel__lead">
          {daysTraded > 0 ? (
            <>
              <span className="rq-num">{daysClosed}</span> of <span className="rq-num">{daysTraded}</span> days closed out.
            </>
          ) : (
            "You didn't trade this week."
          )}
        </p>
        <p className="panel__meta">
          {daysTraded === 0
            ? 'Streak intact — nothing was owed.'
            : missedDays > 0 && streakWeeks > 0
              ? (
                  <>
                    Streak intact — <span className="rq-num">{missedDays}</span> missed {missedDays === 1 ? 'day' : 'days'} used your
                    grace.
                  </>
                )
              : streakWeeks > 0
                ? (
                    <>
                      <span className="rq-num">{streakWeeks}</span>-week streak intact.
                    </>
                  )
                : (
                    'Streak not started yet.'
                  )}
        </p>
      </div>
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

/**
 * Non-negotiable (design-decisions §6): hard and soft adherence are NEVER
 * blended into one figure — always two separate `.panel__lead` lines, and
 * the `.rq-cmp` comparison bar below is soft-only (frame 4.1/4.4's own
 * reference markup never plots hard rules on it — hard is a bare "N of
 * N", it doesn't need a trend bar since a followed hard rule is simply
 * the entitlement floor, not something to track drifting over time).
 */
function AdherencePanel({
  adherence,
  coversWeeks,
  ruleChangeAnnotations,
}: {
  adherence: WeeklyReadPayload['adherence'];
  coversWeeks: number;
  ruleChangeAnnotations: RuleChangeAnnotation[];
}) {
  if (adherence.status === 'insufficient_history') {
    return (
      <section className="panel" aria-labelledby="p-adherence">
        <h2 id="p-adherence" className="panel__title">
          Adherence
        </h2>
        <p className="panel__meta">Nothing to evaluate.</p>
        <RuleChangeAnnotations annotations={ruleChangeAnnotations} />
      </section>
    );
  }

  const { hard, soft, priorSoft, attribution } = adherence;
  const trend = priorSoft ? fractionTrend(soft, priorSoft) : null;
  // Frame 4.1 says "This week"/"Last week"; frame 4.4's own multi-week
  // catch-up review says "These weeks"/"Before" — never "This week" for a
  // period that covers more than one.
  const currentLabel = coversWeeks > 1 ? 'These weeks' : 'This week';
  const priorLabel = coversWeeks > 1 ? 'Before' : 'Last week';
  const currentPct = soft.total > 0 ? Math.round((soft.followed / soft.total) * 100) : 0;
  const priorPct = priorSoft && priorSoft.total > 0 ? Math.round((priorSoft.followed / priorSoft.total) * 100) : 0;

  return (
    <section className="panel" aria-labelledby="p-adherence">
      <h2 id="p-adherence" className="panel__title">
        Adherence
      </h2>
      <p className="panel__lead">
        Hard rules: <span className="rq-num">{hard.followed}</span> of <span className="rq-num">{hard.total}</span>.
      </p>
      {soft.total > 0 ? (
        <p className="panel__lead">
          Soft: <span className="rq-num">{soft.followed}</span> of <span className="rq-num">{soft.total}</span>
          {priorSoft && trend !== null ? (
            <>
              , {trend} from <span className="rq-num">{priorSoft.followed}</span> of <span className="rq-num">{priorSoft.total}</span>
            </>
          ) : null}
          .
        </p>
      ) : (
        // Frame 4.3's own week-two copy — a trader with no soft rules
        // authored yet has nothing to trend, and "0 of 0" would read as a
        // fabricated fraction rather than an honest absence.
        <p className="panel__meta">Soft rules appear once you have one.</p>
      )}
      {priorSoft && soft.total > 0 ? (
        <div className="rq-cmp">
          <div className="rq-cmp__row hot">
            <span className="rq-cmp__lbl">{currentLabel}</span>
            <div className="rq-cmp__track">
              <i className="rq-cmp__fill" style={{ width: `${currentPct}%` }} />
            </div>
            <span className="rq-cmp__val rq-num">{soft.followed}</span>
          </div>
          <div className="rq-cmp__row">
            <span className="rq-cmp__lbl">{priorLabel}</span>
            <div className="rq-cmp__track">
              <i className="rq-cmp__fill" style={{ width: `${priorPct}%` }} />
            </div>
            <span className="rq-cmp__val rq-num">{priorSoft.followed}</span>
          </div>
        </div>
      ) : null}
      {attribution && (
        <p className="panel__meta">
          {/* The rendered rule sentence is a complete sentence and ends in
              a full stop, so gluing the clause on produced "Never risk
              more than 1% per trade. accounts for 6 of the 14 soft
              breaks." The frame uses a short noun phrase ("Your risk
              cap"); we keep the trader's own rule wording — the honest
              identifier — and just drop its terminal punctuation. */}
          {(attribution.rendered ?? 'One rule').replace(/[.!?]+$/, '')} accounts for{' '}
          <span className="rq-num">{attribution.count}</span> of the{' '}
          <span className="rq-num">{attribution.ofBreaks}</span> {attribution.severity} breaks.
        </p>
      )}
      <RuleChangeAnnotations annotations={ruleChangeAnnotations} />
    </section>
  );
}

function FindingsPanel({ findings }: { findings: WeeklyReadPayload['findings'] }) {
  return (
    <section className="panel" aria-labelledby="p-findings">
      <h2 id="p-findings" className="panel__title">
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
        <ul className="findings">
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
