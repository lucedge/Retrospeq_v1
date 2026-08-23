'use client';

import { useState, useTransition } from 'react';
import { resolveAmbiguousGroupingAction } from './actions';

/**
 * Module 02 §4.3/§5.2's ambient grouping question — "an ambient chip on
 * the open-position card the moment the second fill lands — dismissible,
 * no modal. Answered there, it never returns. Ignored, it batches into
 * close-out." Shown only when `grouping_confidence === 'ambiguous'`
 * (§4.3's confidence bands — the only band that asks at all).
 *
 * **Both `.rq-btn--equal` options are now genuinely live (2026-08-23) —
 * the earlier asymmetry (below) is closed, not a scoping decision left
 * standing:**
 *
 * - **"Later"** is a genuine, working no-op exactly per spec's own
 *   words ("ignored, it batches into close-out") — dismissing here is
 *   real behaviour (the trader chose not to decide now), not a stub. No
 *   server call: there is nothing to persist for "I'll decide later,"
 *   the trade's `grouping_confidence` stays `'ambiguous'` until Module
 *   06's close-out screen (or a future explicit split/join) resolves it.
 * - **"Same trade" now calls `resolveAmbiguousGroupingAction`, a real
 *   write.** Closed 2026-08-23 (retrospeq-qa design-ethics finding on
 *   Slice 7b): once "Separate" became a real, working action, leaving
 *   "Same trade" permanently `disabled` broke this `.rq-btn--equal`
 *   pair's required symmetry — one option visibly worked, the other
 *   looked permanently unavailable, exactly the "implies a
 *   recommendation" outcome the design-system rule exists to prevent.
 *   The fix was a small, real backend operation
 *   (`resolveAmbiguousGroupingAsSingle`, `lib/ingestion/split-join.ts`) —
 *   it resolves the trade's grouping VERDICT to `confident_single`
 *   without touching membership at all (the automatic grouping already
 *   put the right fills on the right trade; the trader is only
 *   confirming that), never a UI-only fake resolution.
 * - **"Separate" is a real, working deep link, closing Slice 7a's own
 *   original deferral.** §4.7 requires an explicit `splitAtFillId` —
 *   which fill actually splits the trade — that a single tap on this
 *   chip cannot supply on its own (a guessed boundary would violate §9's
 *   "silence over wrongness"). Rather than guess, "Separate" navigates
 *   to `#trade-<id>` — this same trade's own expandable fills section,
 *   rendered directly below this chip for exactly this reason when the
 *   trade is ambiguous (see `page.tsx`'s `OpenPositionCard`) — where a
 *   real "Split here" control (`SplitControl.tsx`) lets the trader
 *   choose the actual boundary. `AutoExpandFillsOnHash.tsx` handles
 *   opening/scrolling to it, since a same-page anchor click against a
 *   closed native `<details>` isn't guaranteed to auto-expand across
 *   browsers.
 *
 * Both options are real, both take one tap, and neither is styled or
 * labelled as the "recommended" choice — the `.rq-btn--equal` pair now
 * has no CSS or behavioural asymmetry between its two members.
 */
export function GroupingChip({ tradeId, instrument }: { tradeId: string; instrument: string }) {
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
      // Real write succeeded — grouping_confidence is no longer
      // 'ambiguous', so this chip's own precondition no longer holds.
      // Hide immediately (optimistic, matching "Later"'s own local-state
      // dismissal) rather than waiting on revalidatePath's server
      // round trip to re-render the parent without this chip.
      setResolved(true);
    });
  }

  return (
    <div
      className="rq-cost flex flex-col gap-2"
      role="group"
      aria-label={`Grouping question for ${instrument}`}
      data-band="ambiguous"
    >
      <p className="rq-body">Is this add part of the same trade?</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rq-btn rq-btn--equal"
          disabled={isPending}
          onClick={handleConfirmSingle}
        >
          Same trade
        </button>
        <a href={`#trade-${tradeId}`} className="rq-btn rq-btn--equal">
          Separate
        </a>
        <button type="button" className="rq-btn rq-btn--ghost" disabled={isPending} onClick={() => setDismissed(true)}>
          Later
        </button>
      </div>
      <p className="rq-sub">
        &ldquo;Same trade&rdquo; confirms this add belongs with the rest. &ldquo;Separate&rdquo; opens
        this trade&rsquo;s fills below, where you can choose exactly where to split it.
      </p>
      {error && (
        <p className="rq-sub" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
