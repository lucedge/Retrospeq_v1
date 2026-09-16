'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { joinTradesAction } from './actions';

/**
 * Module 02 §4.7's "Manual join | Before freeze only, same block" —
 * frame 2.3's `.alert.alert--blocking` card, one per adjacent pair inside
 * a `listJoinableTradeGroups` group (`trades-repository.ts`), which
 * already mirrors `joinTrades`'s own eligibility precondition
 * (`confirmed_at is null`, same block).
 *
 * **UI batch 2 restyle**: was a bare ghost button inside a plain
 * `.rq-card`; now the frame's own `.rq-btn--equal` pair — "Keep
 * separate" (a real, local, permanent-enough dismissal: doing nothing
 * already IS "keep separate", there is no write for that state, same
 * "Later" precedent `GroupingChip.tsx` already established for an
 * equivalent no-op choice) and "Join" (the same real
 * `joinTradesAction` write as before). Neither is styled or labelled as
 * the recommended choice — a join absorbs one trade id into another, so
 * `router.refresh()` on success rather than a local optimistic update
 * (identical posture to `SplitControl.tsx`, for the identical reason).
 */
export function JoinControl({
  tradeIdA,
  tradeIdB,
  description,
  ariaLabel,
}: {
  tradeIdA: string;
  tradeIdB: string;
  description: string;
  ariaLabel: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  if (dismissed || joined) return null;

  function handleJoin() {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('tradeIdA', tradeIdA);
      formData.set('tradeIdB', tradeIdB);
      const result = await joinTradesAction(undefined, formData);
      if (result.error) {
        setError(result.error.user_message);
        return;
      }
      if (result.fieldErrors) {
        setError('Something went wrong. Please try again.');
        return;
      }
      setJoined(true);
      router.refresh();
    });
  }

  return (
    <div className="alert alert--blocking" role="group" aria-label={ariaLabel}>
      <h2>Join these into one trade?</h2>
      <p>{description}</p>
      <div className="rq-btn-row">
        <button type="button" className="rq-btn rq-btn--equal" onClick={() => setDismissed(true)} disabled={isPending}>
          Keep separate
        </button>
        <button type="button" className="rq-btn rq-btn--equal" onClick={handleJoin} disabled={isPending}>
          {isPending ? 'Joining…' : 'Join'}
        </button>
      </div>
      {error && (
        <p className="rq-sub" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
