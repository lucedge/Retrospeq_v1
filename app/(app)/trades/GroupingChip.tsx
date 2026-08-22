'use client';

import { useState } from 'react';

/**
 * Module 02 §4.3/§5.2's ambient grouping question — "an ambient chip on
 * the open-position card the moment the second fill lands — dismissible,
 * no modal. Answered there, it never returns. Ignored, it batches into
 * close-out." Shown only when `grouping_confidence === 'ambiguous'`
 * (§4.3's confidence bands — the only band that asks at all).
 *
 * **Honest-scoping decision for this slice (Slice 7a), documented here
 * per this slice's own dispatch rather than left implicit:**
 *
 * - **"Later"** is a genuine, working no-op exactly per spec's own
 *   words ("ignored, it batches into close-out") — dismissing here is
 *   real behaviour (the trader chose not to decide now), not a stub. No
 *   server call: there is nothing to persist for "I'll decide later,"
 *   the trade's `grouping_confidence` stays `'ambiguous'` until Module
 *   06's close-out screen (or a future explicit split/join) resolves it.
 * - **"Same trade" / "Separate" are shown but DISABLED, with an honest
 *   inline note**, rather than wired to a fake action. Neither has a
 *   real one-tap backend operation to call yet: "Same trade" has no
 *   corresponding write at all (nothing marks an ambiguous trade
 *   confidently single without also touching `grouping_signals`/
 *   `ambiguity_resolved_at`, which only `splitTrade`/`joinTrades`
 *   currently do, and neither operates on "no boundary chosen"); and
 *   "Separate" would need a specific `splitAtFillId` — which fill
 *   actually splits the trade — that a single tap on this chip cannot
 *   supply. Module 02's own spec §4.7 backs this: split/join take an
 *   explicit fill id, never inferred. Wiring either button to
 *   `splitTradeAction`/`joinTradesAction` today would either need a
 *   guessed boundary (a "silence over wrongness" violation, §9) or
 *   silently do nothing while looking like it worked (explicitly
 *   forbidden by this slice's own dispatch). Deferred to Slice 7c, which
 *   can deep-link "Separate" to a real manual-split control once one
 *   exists.
 */
export function GroupingChip({ instrument }: { instrument: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

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
          className="rq-btn rq-btn--equal opacity-50"
          disabled
          title="Not available yet — resolving this needs a chosen split point, coming in a later update."
        >
          Same trade
        </button>
        <button
          type="button"
          className="rq-btn rq-btn--equal opacity-50"
          disabled
          title="Not available yet — resolving this needs a chosen split point, coming in a later update."
        >
          Separate
        </button>
        <button type="button" className="rq-btn rq-btn--ghost" onClick={() => setDismissed(true)}>
          Later
        </button>
      </div>
      <p className="rq-sub">
        Resolving this here isn&apos;t available yet — it&apos;ll be asked again at close-out.
      </p>
    </div>
  );
}
