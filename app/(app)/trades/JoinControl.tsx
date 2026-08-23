'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { joinTradesAction } from './actions';

/**
 * Module 02 §4.7's "Manual join | Before freeze only, same block" —
 * one control per adjacent pair inside a `listJoinableTradeGroups` group
 * (`trades-repository.ts`), which already mirrors `joinTrades`'s own
 * eligibility precondition (`confirmed_at is null`, same block). Same
 * direct-Server-Action-call + `router.refresh()` posture as
 * `SplitControl.tsx`, for the identical reason: a join absorbs one trade
 * id into another, so there is no local field to optimistically update.
 */
export function JoinControl({
  tradeIdA,
  tradeIdB,
  label,
}: {
  tradeIdA: string;
  tradeIdB: string;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleClick() {
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
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="rq-btn rq-btn--ghost" onClick={handleClick} disabled={isPending}>
        {isPending ? 'Joining…' : `Join with ${label}`}
      </button>
      {error && (
        <span className="rq-sub" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
