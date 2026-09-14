'use client';

import { useState, useTransition } from 'react';
import type { PromotionPromptDetail } from '@/lib/review/decisions/promotion-evidence-detail';
import { acceptPromotionDecision, declinePromotionDecision, swapAndPromoteDecision } from './actions';

/**
 * Module 06 (Review & Graduation) Slice 8, frame 4.8's `review--decision`
 * reference markup — PROMOTION ONLY. Mirrors `DecisionCard.tsx`'s own
 * asymmetric primary/ghost shape (`.rq-btn` "Make it hard" / `.rq-btn--ghost`
 * "Keep it soft") — this is NOT an equal pair like relaxation/retirement,
 * matching frame 4.8's own markup exactly.
 *
 * PROGRESSION TO THE NEXT DECISION — identical mechanism to `DecisionCard
 * .tsx`'s own (see that file's header for the full Next.js documentation
 * citation): every action here calls `revalidatePath('/review/decisions')`
 * on success, so a successful accept/decline/swap has already replaced this
 * component server-side by the time the client's own `await` resolves.
 *
 * HARD-CAP SWAP CHOOSER — `acceptPromotionDecision` returns `hardCapChooser`
 * (verbatim from `promoteRule`, Module 04) rather than failing outright
 * when the trader is Pro but already at the 6-hard-rule cap, per this
 * slice's own dispatch ("surface the existing swap choice rather than
 * failing"). This component renders that list inline as a second step —
 * one button per currently-active hard rule, "Move back to soft and make
 * this one hard" — calling `swapAndPromoteDecision` rather than a bare
 * error message with no way forward.
 */

interface CardState {
  errorMessage: string | null;
  hardCapChooser: { ruleId: string; rendered: string }[] | null;
}

export function PromotionDecisionCard({
  initialIndex,
  initialTotal,
  initialDetail,
}: {
  initialIndex: number;
  initialTotal: number;
  initialDetail: PromotionPromptDetail;
}) {
  const [state, setState] = useState<CardState>({ errorMessage: null, hardCapChooser: null });
  const [isPending, startTransition] = useTransition();
  const detail = initialDetail;

  function handleAccept() {
    startTransition(async () => {
      const result = await acceptPromotionDecision(detail.promptId);
      if (!result.success) {
        if (result.hardCapChooser) {
          setState({ errorMessage: result.error?.user_message ?? null, hardCapChooser: result.hardCapChooser });
          return;
        }
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.', hardCapChooser: null });
      }
    });
  }

  function handleDecline() {
    startTransition(async () => {
      const result = await declinePromotionDecision(detail.promptId);
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.', hardCapChooser: null });
      }
    });
  }

  function handleSwap(demoteRuleId: string) {
    startTransition(async () => {
      const result = await swapAndPromoteDecision(detail.promptId, demoteRuleId);
      if (!result.success) {
        if (result.hardCapChooser) {
          setState({ errorMessage: result.error?.user_message ?? null, hardCapChooser: result.hardCapChooser });
          return;
        }
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.', hardCapChooser: null });
      }
    });
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="promo-h">
      <p className="rq-sub">
        Decision <span className="rq-num">{initialIndex}</span> of <span className="rq-num">{initialTotal}</span>
      </p>
      <h1 id="promo-h" className="rq-h1">
        Make this rule hard?
      </h1>

      <div className="rq-card flex flex-col gap-2">
        <p className="rq-body">{detail.statement}</p>
        {detail.meta ? <p className="rq-sub">{detail.meta}</p> : null}
      </div>

      <div className="rq-dots" style={{ ['--rq-dot-size' as string]: '8px' }}>
        {Array.from({ length: detail.dots.total }, (_, i) => (
          <i key={i} className={i < detail.dots.filled ? undefined : 'off'} />
        ))}
      </div>

      <div className="rq-cost" role="note">
        <p className="rq-body">{detail.costLine}</p>
      </div>

      {state.errorMessage && (
        <p className="rq-sub" role="alert">
          {state.errorMessage}
        </p>
      )}

      {state.hardCapChooser ? (
        <div className="flex flex-col gap-2">
          <p className="rq-sub">Choose one to move back to soft first.</p>
          {state.hardCapChooser.map((r) => (
            <button
              key={r.ruleId}
              type="button"
              className="rq-btn rq-btn--ghost"
              disabled={isPending}
              onClick={() => handleSwap(r.ruleId)}
            >
              Move &quot;{r.rendered}&quot; back to soft
            </button>
          ))}
        </div>
      ) : detail.canAccept ? (
        <div className="flex flex-col gap-2">
          <button type="button" className="rq-btn" disabled={isPending} onClick={handleAccept}>
            Make it hard
          </button>
          <button type="button" className="rq-btn rq-btn--ghost" disabled={isPending} onClick={handleDecline}>
            Keep it soft
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="rq-sub">{detail.blockedReason}</p>
          <button type="button" className="rq-btn rq-btn--ghost" disabled={isPending} onClick={handleDecline}>
            Keep it soft
          </button>
        </div>
      )}
    </section>
  );
}
