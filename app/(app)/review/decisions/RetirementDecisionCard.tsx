'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { RetirementPromptDetail } from '@/lib/review/decisions/retirement-evidence-detail';
import { acceptRetirementDecision, keepRetirementDecision } from './actions';

/**
 * Module 06 (Review & Graduation) Slice 8, frame 4.9's `.rq-btn--equal`
 * pair, both decay and condition sub-kinds — "the product has an opinion
 * that the numbers changed, none about what the trader should do." Same
 * symmetric shape `RelaxationDecisionCard.tsx` already established for
 * §4.7 (see that file's own header): both actions use `.rq-btn--equal`,
 * never `.rq-btn`/`.rq-btn--ghost`, and there is no third defer button —
 * "Keep the rule" already plays that low-commitment role, a real resolved
 * decision, not a postponement.
 *
 * `canDecide: false` should not normally reach this component —
 * `fetchNextDecision` skips an undecidable retirement prompt server-side
 * before ever returning it (the edge recovered, the condition since
 * failed, or the subject was already retired). The branch below is
 * defensive-only, for the narrow race where that changed between that read
 * and this render.
 */

interface CardState {
  errorMessage: string | null;
}

export function RetirementDecisionCard({
  initialIndex,
  initialTotal,
  initialDetail,
}: {
  initialIndex: number;
  initialTotal: number;
  initialDetail: RetirementPromptDetail;
}) {
  const [state, setState] = useState<CardState>({ errorMessage: null });
  const [isPending, startTransition] = useTransition();
  const detail = initialDetail;

  function handleKeep() {
    startTransition(async () => {
      const result = await keepRetirementDecision(detail.promptId);
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.' });
      }
    });
  }

  function handleRetire() {
    startTransition(async () => {
      const result = await acceptRetirementDecision(detail.promptId);
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.' });
      }
    });
  }

  const headline = detail.subjectType === 'trigger_condition' ? 'Has this checklist item stopped discriminating?' : 'Has this edge stopped working?';

  return (
    <section className="flex flex-col gap-6" aria-labelledby="retire-h">
      <p className="rq-sub">
        Decision <span className="rq-num">{initialIndex}</span> of <span className="rq-num">{initialTotal}</span>
      </p>
      <h1 id="retire-h" className="rq-h1">
        {headline}
      </h1>

      <div className="rq-card flex flex-col gap-2">
        <p className="rq-body">{detail.statement}</p>
        {detail.meta ? <p className="rq-sub">{detail.meta}</p> : null}
      </div>

      {detail.cmp ? (
        <div className="rq-cmp">
          <div className="rq-cmp__row hot">
            <span className="rq-cmp__lbl">{detail.cmp.afterLabel}</span>
            <div className="rq-cmp__track">
              <i className="rq-cmp__fill" style={{ width: `${detail.cmp.afterPct}%` }} />
            </div>
            <span className="rq-cmp__val rq-num">{detail.cmp.afterPct}%</span>
          </div>
          <div className="rq-cmp__row">
            <span className="rq-cmp__lbl">{detail.cmp.beforeLabel}</span>
            <div className="rq-cmp__track">
              <i className="rq-cmp__fill" style={{ width: `${detail.cmp.beforePct}%` }} />
            </div>
            <span className="rq-cmp__val rq-num">{detail.cmp.beforePct}%</span>
          </div>
        </div>
      ) : null}

      <p className="rq-body">{detail.frameSentence}</p>

      {state.errorMessage && (
        <p className="rq-sub" role="alert">
          {state.errorMessage}
        </p>
      )}

      {detail.canDecide ? (
        <div className="rq-btn-row">
          <button type="button" className="rq-btn rq-btn--equal" disabled={isPending} onClick={handleKeep} data-action="keep">
            Keep the rule
          </button>
          <button type="button" className="rq-btn rq-btn--equal" disabled={isPending} onClick={handleRetire} data-action="retire">
            Retire it
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="rq-sub">{detail.blockedReason}</p>
          <Link href="/review" className="rq-btn rq-btn--ghost">
            Back to your review
          </Link>
        </div>
      )}
    </section>
  );
}
