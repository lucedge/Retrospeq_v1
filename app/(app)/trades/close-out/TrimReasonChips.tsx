'use client';

import { useState, useTransition } from 'react';
import { writeTradeCaptureAction } from '../actions';
import { TRIM_REASONS, type TrimReason } from '@/lib/ingestion/trim-reason';

/**
 * Module 02 §3.3/§5.1/§5.2's trim-reason chip row: "Chip row on fill
 * notification: Target · Trail · Discretionary · Fear · Time. Optional."
 * Rendered here at close-out (Slice 7b) since no real-time
 * fill-notification surface exists yet — see `trade-captures.ts`'s own
 * header for that scoping decision.
 *
 * **UI batch 2 restyle (2026-09-16)**: the prior header here claimed
 * "there is no dedicated `.chip` class in this repo's actual CSS" — stale
 * (same class of stale comment batch 1b already found and fixed in
 * `accounts/connect/page.tsx`/`ManualEntryForm.tsx`): `.trim-reason`/
 * `.chips`/`.chip[aria-pressed]`/`.ghost` are real, already-shipped
 * selectors (`components.css`, "Design program batch 6"), matching frame
 * 2.11 exactly. Restyled from `.rq-pills` to those real classes; no
 * behaviour change.
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
    <div className="trim-reason" role="group" aria-labelledby={`trim-reason-h-${tradeId}`}>
      <p id={`trim-reason-h-${tradeId}`}>Why did you trim?</p>
      <div className="chips" role="radiogroup" aria-label="Trim reason">
        {TRIM_REASONS.map((reason) => (
          <button
            key={reason}
            type="button"
            role="radio"
            className={selected === reason ? 'chip on' : 'chip'}
            aria-checked={selected === reason}
            onClick={() => handlePick(reason)}
            disabled={isPending}
          >
            {REASON_LABELS[reason]}
          </button>
        ))}
      </div>
      {selected === null && (
        <button type="button" className="ghost" onClick={() => setSkipped(true)} disabled={isPending}>
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
