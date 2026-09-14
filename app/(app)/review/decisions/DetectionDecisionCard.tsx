'use client';

import { useState, useTransition } from 'react';
import type { DetectionPromptDetail } from '@/lib/review/decisions/detection-evidence-detail';
import { acceptDetectionDecision, deferDetectionDecision } from './actions';

/**
 * Module 06 (Review & Graduation), frame 4.10's `review--decision` +
 * `.detection` reference markup — DETECTION ONLY. Unlike every other
 * `*DecisionCard.tsx` in this route (which translate §5.1's illustrative
 * BEM markup into this repo's real `.rq-*` primitives, per `docs/adr/0040`),
 * `.detection`/`.detection__statement`/`.detection__outcome`/`.detection__
 * concept` are used HERE VERBATIM — the design system already shipped real
 * CSS for these exact class names (`public/brand/css/components.css`,
 * "Batches 4-5 review + performance," PROGRESS.md 2026-09-14), so there is
 * no translation step needed for this one block, unlike `.evidence`/
 * `.decision-actions` (still Tailwind, matching every sibling card).
 *
 * Same asymmetric primary/ghost shape as `DecisionCard.tsx`'s own
 * graduation card (`.rq-btn` "Add the rule" / `.rq-btn--ghost` "Not yet") —
 * frame 4.10's own markup has exactly these two buttons, no equal pair.
 *
 * "Not yet" is a DEFER (`deferDetectionDecision`), never a decline — see
 * that action's own header for why (`docs/infra-gaps.md` tracks the
 * missing decline/mute path as a real, flagged future gap).
 *
 * PROGRESSION TO THE NEXT DECISION: identical mechanism to every sibling
 * card in this route (`DecisionCard.tsx`'s own header has the full Next.js
 * citation) — a successful accept/defer already revalidates `/review/
 * decisions` server-side before this `await` resolves, so only the FAILURE
 * branch can observably run against a still-mounted instance.
 */

interface CardState {
  errorMessage: string | null;
}

export function DetectionDecisionCard({
  initialIndex,
  initialTotal,
  initialDetail,
}: {
  initialIndex: number;
  initialTotal: number;
  initialDetail: DetectionPromptDetail;
}) {
  const [state, setState] = useState<CardState>({ errorMessage: null });
  const [isPending, startTransition] = useTransition();
  const detail = initialDetail;

  function handleAccept() {
    startTransition(async () => {
      const result = await acceptDetectionDecision(detail.promptId);
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.' });
      }
    });
  }

  function handleDefer() {
    startTransition(async () => {
      const result = await deferDetectionDecision(detail.promptId);
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.' });
      }
    });
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="det-h">
      <p className="rq-sub">
        Decision <span className="rq-num">{initialIndex}</span> of <span className="rq-num">{initialTotal}</span>
      </p>
      <h1 id="det-h" className="rq-h1">
        Make a rule from this pattern?
      </h1>

      <div className="flex flex-col gap-1">
        <p className="rq-body">{detail.statement}</p>
        {detail.outcomeLine ? <p className="rq-sub">{detail.outcomeLine}</p> : null}
      </div>

      <div className="detection" data-classification="pattern">
        {detail.proposedRuleSentence ? <p className="detection__statement">{detail.proposedRuleSentence}</p> : null}
        {detail.previewCount !== null && detail.previewTotal !== null ? (
          <p className="detection__outcome">
            Would have applied to <span className="rq-num">{detail.previewCount}</span> of your last{' '}
            <span className="rq-num">{detail.previewTotal}</span> trades.
          </p>
        ) : null}
        <details className="detection__concept">
          <summary>What is this pattern?</summary>
          <p>{detail.conceptSummary}</p>
        </details>
      </div>

      {state.errorMessage && (
        <p className="rq-sub" role="alert">
          {state.errorMessage}
        </p>
      )}

      {detail.canAccept ? (
        <div className="flex flex-col gap-2">
          <button type="button" className="rq-btn" disabled={isPending} onClick={handleAccept}>
            Add the rule
          </button>
          <button type="button" className="rq-btn rq-btn--ghost" disabled={isPending} onClick={handleDefer}>
            Not yet
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="rq-sub">{detail.blockedReason}</p>
          <button type="button" className="rq-btn rq-btn--ghost" disabled={isPending} onClick={handleDefer}>
            Not yet
          </button>
        </div>
      )}
    </section>
  );
}
