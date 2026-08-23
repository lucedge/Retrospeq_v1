'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { splitTradeAction } from './actions';

/**
 * Module 02 §4.7/§5.2's "Split this trade" link, made concrete — one
 * control per eligible fill row, naming the exact fill it splits at. Only
 * ever rendered by `page.tsx`'s `TradeFillsSection` for a fill that is
 * neither the trade's own chronologically-first member nor its ADR-0001
 * synthetic flip-opening entry (matching `splitTrade`'s own
 * `SplitBoundaryIsFirstMemberError`/`SplitBoundaryIsSyntheticEntryError`
 * refusal rules exactly), so this control never offers a boundary the
 * backend would reject — the server-side check in `split-join.ts` remains
 * the real, authoritative boundary; this is just never offering an
 * obviously-doomed choice in the first place.
 *
 * Calls the Server Action directly (not via `<form action>`), same
 * posture as `NotADecisionToggle.tsx` — a plain async call inside
 * `startTransition`. Unlike that toggle, there is no local "just flip one
 * field" optimistic update to make here: a successful split creates a
 * brand-new trade id the current server-rendered props have no way to
 * know about, so this calls `router.refresh()` on success rather than
 * updating local state.
 */
export function SplitControl({ tradeId, fillId }: { tradeId: string; fillId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('tradeId', tradeId);
      formData.set('splitAtFillId', fillId);
      const result = await splitTradeAction(undefined, formData);
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
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="rq-btn rq-btn--ghost px-3 py-1.5 text-xs"
        onClick={handleClick}
        disabled={isPending}
      >
        {isPending ? 'Splitting…' : 'Split here'}
      </button>
      {error && (
        <span className="rq-sub" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
