'use client';

import { useId, useRef } from 'react';
import type { OperandCatalogueEntry, RuleOperator } from '@/lib/rules/operand-catalogue';

/**
 * Module 04 §6.1 / inventory rows 3.7, 3.8, 3.11 — "a sentence with one
 * blank" plus the frame's own `.rq-range` control (`brand/docs/screens/
 * rulebook.html#3.7`, `#3.11`).
 *
 * The UI phase (2026-09-16, batch 3) is the first time this markup is
 * wired for real. Until now both authoring surfaces (`new/RuleEditor.tsx`
 * and `EditRuleControl.tsx`) rendered the rendered sentence as one static
 * string above a separate `.rq-step` stepper — an adaptation their own
 * headers documented as deliberate *at the time*, on the stated grounds
 * that the inline-blank markup wasn't available. It is: `.rule-sentence`/
 * `.rule-value`/`.rq-range` have all shipped in `components.css` since the
 * 2026-09-14 design program. This component is the ONE place that markup
 * lives, so the two surfaces can't drift.
 *
 * **The blank is derived from the catalogue's own phrasing template, never
 * from string-searching the rendered sentence.** `operand.phrasing[op]`
 * (e.g. `'Never risk more than {value}% per trade.'`) is split on its
 * single `{value}` placeholder, so the text either side of the blank is
 * exactly what `renderSentence` would have produced — no parsing of a
 * formatted number back out of prose, and no second phrasing map. A
 * template with no `{value}` at all (every `bool` operand) or a
 * two-placeholder one (`between`) returns `null` from `splitPhrasing`
 * below and the caller falls back to the plain rendered sentence; this
 * component is only ever mounted for bounded numeric operands anyway.
 *
 * A trailing `%` immediately after the blank is pulled INTO the blank
 * ("1.5%", not "1.5" + "%") — the frame's own reading, and the same unit
 * suffix the `.rq-step__val` this replaces already appended.
 *
 * The `.rule-value` button focuses the range input (the design system's
 * own "the value is a button that opens the stepper" note, made real for
 * a control that is already visible) — it is never a decorative button
 * with no behaviour.
 */

/**
 * §5.8's preview, in the frame's own `.preview` shape (rows 3.7/3.8/3.11)
 * — lede, hero count, banded guidance, disclaimer. `data-band` comes
 * straight off `PreviewResult.band` (`lib/rules/preview.ts`'s
 * `bandForRatio`), so the thresholds that decide "too tight" live in one
 * place; this component never re-derives a band from `ratio`. Weight
 * only: there is no colour band anywhere in this design system.
 *
 * Every non-flagged outcome ("not enough history", "this operand isn't
 * computable yet", a failed preview call) renders the server's own
 * sentence plainly — a calm, designed state, never a spinner left up or a
 * fabricated zero.
 */
export function PreviewPanel({
  preview,
  loading,
  error,
}: {
  preview: { state: string; flagged?: number; n?: number; guidance: string; band?: string; calibration?: string } | undefined;
  loading: boolean;
  error: string | null;
}) {
  return (
    <aside className="preview" role="status" aria-live="polite">
      {loading ? (
        <p className="preview__lede" aria-busy="true">
          Checking against your history…
        </p>
      ) : error ? (
        <p className="preview__lede" role="alert">
          {error}
        </p>
      ) : preview?.state === 'flagged' ? (
        <>
          <p className="preview__lede">
            Against your last <span className="rq-num">{preview.n}</span> trades, this would have flagged
          </p>
          <p className="preview__count rq-num">{preview.flagged}</p>
          <p className="preview__guidance" data-band={preview.band}>
            {preview.guidance}
          </p>
          {preview.calibration && <p className="preview__lede">{preview.calibration}</p>}
        </>
      ) : (
        <p className="preview__guidance">{preview?.guidance ?? 'Not enough data yet.'}</p>
      )}
      <p className="preview__disclaimer">Preview only. Past trades are never scored against this rule.</p>
    </aside>
  );
}

/** `[before, after]` around the single `{value}` blank, or `null` when the
 *  template has no blank or more than one. Pure. */
export function splitPhrasing(template: string): [string, string] | null {
  const parts = template.split('{value}');
  if (parts.length !== 2) return null;
  return [parts[0], parts[1]];
}

export function RuleValueControl({
  operand,
  op,
  value,
  displayValue,
  fallbackSentence,
  disabled,
  onStep,
  onSet,
  sentenceClassName,
}: {
  operand: OperandCatalogueEntry;
  op: RuleOperator;
  value: number;
  /** Already rounded to the operand's own step precision by the caller.
   *  BARE — no unit suffix: the phrasing template carries its own (`'…
   *  more than {value}% per trade.'`), and this component moves that `%`
   *  into the blank itself. Passing a pre-suffixed value renders "2.6%%",
   *  which is exactly what the first screenshot of this control showed. */
  displayValue: string;
  /** `renderSentence`'s output — used verbatim when this operand's phrasing
   *  has no single blank to open up. */
  fallbackSentence: string;
  disabled: boolean;
  /** One step in the operand's own `bounds.step`, clamped by the caller. */
  onStep: (direction: 1 | -1) => void;
  /** An absolute value straight off the range input, already a multiple of
   *  `bounds.step` within `[min, max]` (the input enforces both). */
  onSet: (value: number) => void;
  /** Extra classes on the sentence (the two surfaces size it differently:
   *  display size on `/rules/new`, body size inline in a rule card). */
  sentenceClassName?: string;
}) {
  const rangeRef = useRef<HTMLInputElement>(null);
  const rangeId = useId();
  const bounds = operand.bounds;
  const template = operand.phrasing[op];
  const split = template ? splitPhrasing(template) : null;

  let before = '';
  let after = '';
  let blank = displayValue;
  if (split) {
    [before, after] = split;
    if (after.startsWith('%')) {
      blank = `${displayValue}%`;
      after = after.slice(1);
    }
  }

  return (
    <>
      {split ? (
        <p className={sentenceClassName ? `rule-sentence ${sentenceClassName}` : 'rule-sentence'}>
          {before}
          <button
            type="button"
            className="rule-value rq-num"
            aria-label={`${operand.label} — adjust`}
            onClick={() => rangeRef.current?.focus()}
          >
            {blank}
          </button>
          {after}
        </p>
      ) : (
        <p className={sentenceClassName ? `rule-sentence ${sentenceClassName}` : 'rule-sentence'}>{fallbackSentence}</p>
      )}

      {bounds && (
        <div className="rq-range" role="group" aria-label={`${operand.label} threshold`}>
          <button type="button" className="rq-step__btn" aria-label="Decrease" disabled={disabled} onClick={() => onStep(-1)}>
            &minus;
          </button>
          <label htmlFor={rangeId} className="sr-only">
            {operand.label}
          </label>
          <input
            ref={rangeRef}
            id={rangeId}
            type="range"
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            value={value}
            disabled={disabled}
            onChange={(e) => onSet(Number(e.target.value))}
          />
          <button type="button" className="rq-step__btn" aria-label="Increase" disabled={disabled} onClick={() => onStep(1)}>
            +
          </button>
        </div>
      )}
    </>
  );
}
