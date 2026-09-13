'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { RelaxationPromptDetail } from '@/lib/review/decisions/relaxation-evidence-detail';
import { recommitRelaxationDecision, adjustRelaxationDecision } from './actions';

/**
 * Module 06 (Review & Graduation) Slice 7, §4.7's `.rq-btn--equal` pair —
 * "the phrasing carries the ethics." Read §4.7 in full before touching this
 * file's copy or markup: "The product does not have an opinion about which
 * the trader should choose — it has an opinion that the current state is
 * incoherent." Both actions below use the EXACT SAME class
 * (`app/(app)/brand-tokens`'s already-shipped `.rq-btn--equal`, matching
 * this repo's real "same element, same weight, no default" primitive per
 * `public/brand/css/components.css`'s own header on it) — never `.rq-btn`/
 * `.rq-btn--ghost` (that pair IS a primary/secondary distinction, exactly
 * what this screen must not have).
 *
 * NO THIRD BUTTON. §5.1's own relaxation reference markup shows exactly
 * two choices, no "Not yet"/defer — `docs/adr/0041` judgment call #4:
 * "Keep {value}" already plays the low-commitment role a defer button
 * would elsewhere (a trader not ready to change anything simply keeps the
 * rule, which is a real, resolved decision, not a postponement). Do not
 * "helpfully" add a third ghost button here — that would silently break
 * §4.7's own symmetry framing by turning a two-way fork into a two-way
 * fork PLUS an escape hatch, which reads as "the safe choice is to do
 * neither," an opinion this screen must not carry.
 *
 * `canDecide: false` should not normally reach this component —
 * `fetchNextDecision` (`./actions.ts`) skips an undecidable relaxation
 * prompt server-side before ever returning it (§9 `PROMPT_SUBJECT_GONE`,
 * "skip silently"). The branch below is defensive-only, for the narrow
 * race where the rule changed between that read and this render.
 *
 * PROGRESSION TO THE NEXT DECISION — identical mechanism to `DecisionCard
 * .tsx`'s own (see that file's header for the full Next.js documentation
 * citation): `recommitRelaxationDecision`/`adjustRelaxationDecision` both
 * call `revalidatePath('/review/decisions')` on success, so a successful
 * submit has already replaced this component server-side by the time the
 * client's own `await` resolves. Only the FAILURE branch can ever paint
 * against a still-mounted instance.
 */

interface CardState {
  errorMessage: string | null;
}

export function RelaxationDecisionCard({
  initialIndex,
  initialTotal,
  initialDetail,
}: {
  initialIndex: number;
  initialTotal: number;
  initialDetail: RelaxationPromptDetail;
}) {
  const [state, setState] = useState<CardState>({ errorMessage: null });
  const [isPending, startTransition] = useTransition();
  const detail = initialDetail;

  function handleRecommit() {
    startTransition(async () => {
      const result = await recommitRelaxationDecision(detail.promptId);
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.' });
      }
    });
  }

  function handleAdjust() {
    startTransition(async () => {
      const result = await adjustRelaxationDecision(detail.promptId);
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.' });
      }
    });
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="rel-h">
      <p className="rq-sub">
        Decision <span className="rq-num">{initialIndex}</span> of <span className="rq-num">{initialTotal}</span>
      </p>
      <h1 id="rel-h" className="rq-h1">
        Which one is true?
      </h1>

      <div className="rq-card flex flex-col gap-2">
        <p className="rq-body">{detail.statement}</p>
        <p className="rq-sub">{detail.meta}</p>
      </div>

      <p className="rq-body">{detail.decisionFrame}</p>

      {state.errorMessage && (
        <p className="rq-sub" role="alert">
          {state.errorMessage}
        </p>
      )}

      {detail.canDecide && detail.currentLabel !== null && detail.newLabel !== null ? (
        <div className="rq-btn-row">
          <button type="button" className="rq-btn rq-btn--equal" disabled={isPending} onClick={handleRecommit} data-action="recommit">
            Keep {detail.currentLabel}
          </button>
          <button type="button" className="rq-btn rq-btn--equal" disabled={isPending} onClick={handleAdjust} data-action="adjust">
            Change to {detail.newLabel}
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
