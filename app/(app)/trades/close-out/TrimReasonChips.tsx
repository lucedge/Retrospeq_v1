'use client';

import { useState, useTransition } from 'react';
import { writeTradeCaptureAction } from '../actions';
import { TRIM_REASONS, type TrimReason } from '@/lib/ingestion/trim-reason';

/**
 * Module 02 §3.3/§5.1/§5.2's trim-reason chip row: "Chip row on fill
 * notification: Target · Trail · Discretionary · Fear · Time. Optional."
 * Rendered here at close-out (Slice 7b) since no real-time
 * fill-notification surface exists yet — see `trade-captures.ts`'s own
 * header for that scoping decision. Built on the design system's real
 * pick-one pills (`.rq-pills`/`.rq-pill.on`), the same component
 * `accounts/connect/page.tsx` uses for platform selection — there is no
 * dedicated `.chip` class in this repo's actual CSS (the reference markup's
 * `.chip` is illustrative, not a real selector here).
 *
 * "Skip" is a local, transient dismissal only (no server call, matching
 * `GroupingChip.tsx`'s own "Later" precedent) — §3.3 says "always
 * skippable," never "skip is remembered forever." If the trader reloads
 * close-out, an un-answered trim reason is offered again; an
 * already-chosen one (persisted via `writeTradeCaptureAction`,
 * pre-filled from `listTradeCaptures`) shows as selected, never re-asked
 * as if nothing had been chosen.
 */
export function TrimReasonChips({
  tradeId,
  initialReason,
}: {
  tradeId: string;
  initialReason: TrimReason | null;
}) {
  const [selected, setSelected] = useState<TrimReason | null>(initialReason);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (skipped) return null;

  function handlePick(reason: TrimReason) {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('reason', reason);
      const result = await writeTradeCaptureAction(tradeId, undefined, formData);
      if (result.error) {
        setError(result.error.user_message);
        return;
      }
      if (result.value) setSelected(result.value);
    });
  }

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={`trim-reason-h-${tradeId}`}>
      <p id={`trim-reason-h-${tradeId}`} className="rq-sub">
        Why did you trim?
      </p>
      <div className="rq-pills" role="radiogroup" aria-label="Trim reason">
        {TRIM_REASONS.map((reason) => (
          <button
            key={reason}
            type="button"
            role="radio"
            aria-checked={selected === reason}
            className={selected === reason ? 'rq-pill on' : 'rq-pill'}
            onClick={() => handlePick(reason)}
            disabled={isPending}
          >
            {REASON_LABELS[reason]}
          </button>
        ))}
      </div>
      {selected === null && (
        <button
          type="button"
          className="rq-btn rq-btn--ghost"
          onClick={() => setSkipped(true)}
          disabled={isPending}
        >
          Skip
        </button>
      )}
      {error && (
        <p className="rq-sub" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const REASON_LABELS: Record<TrimReason, string> = {
  target: 'Target',
  trail: 'Trail',
  discretionary: 'Discretionary',
  fear: 'Fear',
  time: 'Time',
};
