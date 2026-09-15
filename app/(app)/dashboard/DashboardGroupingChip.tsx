'use client';

import { useState, useTransition } from 'react';
import { resolveAmbiguousGroupingAction } from '../trades/actions';

/**
 * Frame 1.17, "Home · Grouping question" (`brand/docs/screens/
 * home-onboarding.html#1.17`) — the SAME real bookkeeping question
 * `/trades`' own `GroupingChip.tsx` already renders (Module 02 §4.3/§5.2),
 * shown here instead on the open-position card that triggered it, using
 * the SAME Server Action and the SAME "ambiguous" precondition
 * (`DashboardOpenPositionSummary.groupingConfidence`, a plain pass-through
 * of the real `trades.grouping_confidence` column, no second detection
 * pipeline). Restyled to the new `.grouping-chip`/`__q`/`__actions`
 * markup this frame names (not `.rq-cost`/`.rq-btn--equal` — those are
 * `/trades`' own presentation of the identical question, kept as-is,
 * out of this slice's scope).
 *
 * **Reconciliation**: the frame's own illustrative copy names a specific
 * fill time ("Is the add at 11:40 part of the same trade?") — this screen
 * has no fill-level read (`DashboardOpenPositionSummary` carries no fill
 * data), so inventing a time here would be exactly the fabrication
 * AGENTS.md forbids. Reuses `GroupingChip.tsx`'s own already-real,
 * already-shipped copy ("Is this add part of the same trade?") instead.
 *
 * **"Separate"** cannot deep-link to an inline fills section the way
 * `/trades`' own chip does (this screen never renders one) — it navigates
 * to `/trades#trade-<id>`, the same real destination (that page's own
 * `AutoExpandFillsOnHash.tsx` already opens/scrolls to it on arrival via a
 * fresh page load, not just a same-page hash change).
 *
 * **"Same trade"** and **"Later"** match `GroupingChip.tsx`'s own real
 * behaviour exactly: a genuine write vs a genuine, honest no-op — see
 * that file's own header for the full reasoning, not re-derived here.
 */
export function DashboardGroupingChip({ tradeId }: { tradeId: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (dismissed || resolved) return null;

  function handleConfirmSingle() {
    setError(null);
    startTransition(async () => {
      const result = await resolveAmbiguousGroupingAction(tradeId, undefined, new FormData());
      if (result.error) {
        setError(result.error.user_message);
        return;
      }
      // Optimistic hide, matching GroupingChip.tsx's own established
      // posture -- the real write already succeeded server-side.
      setResolved(true);
    });
  }

  return (
    <div className="grouping-chip" role="group" aria-label="Grouping">
      <p className="grouping-chip__q">Is this add part of the same trade?</p>
      <div className="grouping-chip__actions">
        <button type="button" disabled={isPending} onClick={handleConfirmSingle}>
          Same trade
        </button>
        <a href={`/trades#trade-${tradeId}`}>Separate</a>
        <button type="button" className="ghost" disabled={isPending} onClick={() => setDismissed(true)}>
          Later
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
