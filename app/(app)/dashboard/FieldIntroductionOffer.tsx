'use client';

import { useState, useTransition } from 'react';
import { acceptFieldIntroductionOffer, declineFieldIntroductionOffer } from './actions';

/**
 * Module 08 (Onboarding & Home) §5.5, frame 1.19 — "Home · Field offer."
 * Markup matches `brand/docs/screens/home-onboarding.html#1.19` verbatim
 * (`.offer`/`.offer__finding`/`.offer__ask`/`.offer__actions`, all
 * shipped design-system classes — no new CSS). The mockup's own caption:
 * "declinable twice then silent. The offer carries the view's one
 * primary" — the Clear state otherwise has NO `.rq-btn` at all
 * (`app/(app)/dashboard/page.tsx`'s Clear branch), so this offer's
 * "Set up fields" is the view's only primary button when it renders; "Not
 * now" is the ghost sibling, never a second primary.
 *
 * Same "direct Server Action call inside `useTransition`, no `<form>`"
 * shape `RetirementDecisionCard.tsx` already established for a two-button
 * decision card with no domain payload to submit.
 */
export function FieldIntroductionOffer({ statement }: { statement: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (dismissed) return null;

  function handleAccept() {
    startTransition(async () => {
      const result = await acceptFieldIntroductionOffer();
      // A successful accept redirects server-side and never returns here —
      // only a real failure (session/rate-limit) reaches this branch.
      if (result.error) {
        setErrorMessage(result.error.user_message);
      }
    });
  }

  function handleDecline() {
    startTransition(async () => {
      const result = await declineFieldIntroductionOffer();
      if (result.error) {
        setErrorMessage(result.error.user_message);
        return;
      }
      setDismissed(true);
    });
  }

  return (
    <aside className="offer" role="note">
      <p className="offer__finding">{statement}</p>
      <p className="offer__ask">Want to record why you took each one, so we can find out what&rsquo;s actually driving it?</p>
      {errorMessage && (
        <p className="rq-sub" role="alert">
          {errorMessage}
        </p>
      )}
      <div className="offer__actions">
        <button type="button" className="rq-btn" disabled={isPending} onClick={handleAccept}>
          Set up fields
        </button>
        <button type="button" className="rq-btn rq-btn--ghost" disabled={isPending} onClick={handleDecline}>
          Not now
        </button>
      </div>
    </aside>
  );
}
