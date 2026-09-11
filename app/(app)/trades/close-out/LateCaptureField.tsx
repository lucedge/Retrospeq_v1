'use client';

import { useState, useTransition } from 'react';
import { writeLateCaptureAction } from '../actions';

/**
 * Module 06 (Review & Graduation) Slice 1, story 1.3's late-fill control —
 * one instance per MISSING pre-entry field on one trade at close-out
 * (`page.tsx` computes which fields are missing; see that file's own
 * comment). Restricted to the four data types `strategy-validation.ts`'s
 * `PRE_ENTRY_SAFE_TYPES` allows a strategy to assign `capture_moment:
 * 'pre_entry'` to in the first place (`pick_one`, `pick_many`, `bool`,
 * `rating`) — `number`/`note` can never reach this component, since
 * Module 03's own authoring pipeline already refuses either at
 * `capture_moment: 'pre_entry'` (AGENTS.md's fast-capture rule: nothing
 * that needs a keyboard belongs on this kind of screen).
 *
 * **Immediate-submit vs. accumulate-then-save, per data type:** `pick_one`/
 * `bool`/`rating` are each a SINGLE atomic value — the first tap already
 * IS the final answer, so it submits immediately, mirroring
 * `TrimReasonChips.tsx`'s own established "one tap, one write" pattern.
 * `pick_many` genuinely needs several taps to build up a selection before
 * it means anything, and `writeTradeCapture`'s own "never after lock"
 * invariant (`trade-captures.ts`) means the FIRST successful write to a
 * `pre_entry`-moment field permanently locks it — a second write attempt
 * to refine the selection would be silently rejected (`applied: false`),
 * which is exactly wrong for a multi-select still being built. `pick_many`
 * therefore accumulates purely LOCAL state across taps and only calls the
 * server action once, on an explicit "Save" tap.
 *
 * "Skip" is a local, transient dismissal only (no server call) — same
 * convention `TrimReasonChips.tsx` already established: reloading
 * close-out offers an un-filled field again, it is never remembered as
 * permanently skipped (§4.6/design-decisions doc §on late fills: "Trader
 * doesn't lose the note" — skipping is always reversible until actually
 * filled).
 */

export type LateCaptureDataType = 'pick_one' | 'pick_many' | 'bool' | 'rating';

export interface LateCaptureFieldProps {
  tradeId: string;
  fieldId: string;
  fieldName: string;
  dataType: LateCaptureDataType;
  /** `pick_one`/`pick_many` only. */
  options?: string[];
  /** `rating` only — defaults to 1-5 per §4.3, matching
   *  `captured-value-validation.ts`'s own default. */
  ratingMin?: number;
  ratingMax?: number;
}

export function LateCaptureField({
  tradeId,
  fieldId,
  fieldName,
  dataType,
  options,
  ratingMin,
  ratingMax,
}: LateCaptureFieldProps) {
  const [saved, setSaved] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // pick_many's own local, un-submitted accumulator.
  const [pickManySelection, setPickManySelection] = useState<Set<string>>(new Set());

  if (skipped || saved) {
    return saved ? (
      <div className="flex items-center gap-2" role="status">
        <span className="rq-tag rq-tag--on">Saved</span>
        <span className="rq-sub">{fieldName}</span>
      </div>
    ) : null;
  }

  function submit(value: unknown) {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('valueJson', JSON.stringify(value));
      const result = await writeLateCaptureAction(tradeId, fieldId, undefined, formData);
      if (result.error) {
        setError(result.error.user_message);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={`late-capture-h-${tradeId}-${fieldId}`}>
      <p id={`late-capture-h-${tradeId}-${fieldId}`} className="rq-sub">
        {fieldName}
      </p>

      {dataType === 'pick_one' && (
        <div className="rq-pills" role="radiogroup" aria-label={fieldName}>
          {(options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={false}
              className="rq-pill"
              onClick={() => submit(option)}
              disabled={isPending}
            >
              {option}
            </button>
          ))}
        </div>
      )}

      {dataType === 'bool' && (
        <div className="rq-pills" role="radiogroup" aria-label={fieldName}>
          <button type="button" role="radio" aria-checked={false} className="rq-pill" onClick={() => submit(true)} disabled={isPending}>
            Yes
          </button>
          <button type="button" role="radio" aria-checked={false} className="rq-pill" onClick={() => submit(false)} disabled={isPending}>
            No
          </button>
        </div>
      )}

      {dataType === 'rating' && (
        <div className="rq-rating" role="radiogroup" aria-label={fieldName}>
          {Array.from({ length: (ratingMax ?? 5) - (ratingMin ?? 1) + 1 }, (_, i) => (ratingMin ?? 1) + i).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={false}
              aria-label={`${n}`}
              onClick={() => submit(n)}
              disabled={isPending}
            >
              <i aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      {dataType === 'pick_many' && (
        <>
          <div className="rq-pills" role="group" aria-label={fieldName}>
            {(options ?? []).map((option) => {
              const isOn = pickManySelection.has(option);
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={isOn}
                  className={isOn ? 'rq-pill on' : 'rq-pill'}
                  onClick={() =>
                    setPickManySelection((prev) => {
                      const next = new Set(prev);
                      if (next.has(option)) next.delete(option);
                      else next.add(option);
                      return next;
                    })
                  }
                  disabled={isPending}
                >
                  {option}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="rq-btn rq-btn--ghost"
            onClick={() => submit(Array.from(pickManySelection))}
            disabled={isPending || pickManySelection.size === 0}
          >
            Save
          </button>
        </>
      )}

      <button type="button" className="rq-btn rq-btn--ghost" onClick={() => setSkipped(true)} disabled={isPending}>
        Skip
      </button>

      {error && (
        <p className="rq-sub" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
