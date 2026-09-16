'use client';

import { useState, useTransition } from 'react';
import { resolveAmbiguousGroupingAction } from '../actions';

/**
 * Frame 2.13 — "Ambiguous grouping questions batch here and must be
 * answered before confirm — 'Later' is not offered at close-out." One
 * per trade still `grouping_confidence === 'ambiguous'` on this day
 * (`page.tsx`'s own proactive check, the SAME Story 1.4 pattern this
 * screen already established for coverage gaps — computed from data
 * already fetched, no new query).
 *
 * Reuses the identical, already-security-reviewed
 * `resolveAmbiguousGroupingAction` `GroupingChip.tsx` (`/trades`'s own
 * ambient nudge) and `DashboardGroupingChip.tsx` (frame 1.17) already
 * call for "Same trade" — no new write path, restyled markup only
 * (`.grouping-chip`/`__q`/`__actions`, the same real classes those two
 * already use).
 *
 * **Same reconciliation `DashboardGroupingChip.tsx` already made,
 * reused rather than re-derived**: the frame's own illustrative copy
 * names a specific fill time ("is the add at 11:40 part of the same
 * trade?") — this screen has no fill-level read either (`page.tsx`'s
 * `trades` list carries trade rows, not fills), so inventing a time
 * would be fabrication. Uses that same component's own real, honest
 * copy instead.
 *
 * **No "Later"** — deliberately, unlike `GroupingChip`/
 * `DashboardGroupingChip`'s own third option — matching the frame's own
 * caption exactly ("must be answered before confirm"). "Separate" is
 * the same real deep link to this trade's own fills (`/trades#trade-
 * <id>`); close-out has no inline fills view to pick an exact split
 * boundary from (§4.7 needs one, a guessed boundary would violate §9's
 * "silence over wrongness").
 */
export function AmbiguousGroupingResolver({ tradeId, instrument }: { tradeId: string; instrument: string }) {
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (resolved) return null;

  function handleConfirmSingle() {
    setError(null);
    startTransition(async () => {
      const result = await resolveAmbiguousGroupingAction(tradeId, undefined, new FormData());
      if (result.error) {
        setError(result.error.user_message);
        return;
      }
      setResolved(true);
    });
  }

  return (
    <div className="grouping-chip" role="group" aria-label={`Grouping for ${instrument}`}>
      <p className="grouping-chip__q">
        {instrument}: is this add part of the same trade?
      </p>
      <div className="grouping-chip__actions">
        <button type="button" onClick={handleConfirmSingle} disabled={isPending}>
          Same trade
        </button>
        <a href={`/trades#trade-${tradeId}`}>Separate</a>
      </div>
      {error && (
        <p className="rq-sub" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
