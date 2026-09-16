'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { FieldDataType } from '@/lib/fields/strategy-validation';
import { createFieldAction, type CreateFieldActionState, type FieldStrategyOption } from '../actions';

/**
 * Module 03 (Field Registry & Strategy) §5.2's `.field-editor` reference
 * markup, adapted for standalone field CREATION (as opposed to the
 * strategy builder's own field PICKER, which only ever offers fields that
 * already exist — `StrategyBuilder.tsx`'s own header: "Field CREATION is
 * not built here"). This is that missing "Add a field" surface, as its own
 * route (`/fields/new`) rather than an inline modal — matching this repo's
 * established "`/rules/new` is its own page, not a modal on `/rules`"
 * precedent (`RuleEditor.tsx`).
 *
 * SCOPE, deliberately narrowed:
 *
 *   - No capture-moment control here — §5.2's own reference markup shows
 *     one, but `createField`'s own input (`lib/fields/fields-repository.ts`)
 *     has no `captureMoment` parameter at all: a capture moment is a
 *     property of a field's USAGE within a strategy
 *     (`strategy_versions.fields[].capture_moment`), not of the field's own
 *     registry row. Assigning a moment to a field happens where a field is
 *     attached to a strategy — the strategy builder's own field-picker step
 *     (`StrategyBuilder.tsx`), already built and already collecting exactly
 *     this per-usage moment. Building a moment control here that this
 *     screen's own write path has nowhere to send would be inventing UI for
 *     a write that does not exist.
 *   - Adding/removing an OPTION on an EXISTING `pick_one`/`pick_many` field
 *     is out of scope (a genuinely deferred backend gap —
 *     `fields-repository.ts`'s own header, "§4.5 — decisions this slice
 *     made explicit... Add/remove a pick_one/pick_many OPTION — explicitly
 *     DEFERRED"). This screen only sets a NEW field's initial `options[]`
 *     at creation time, which is fully supported.
 *
 * DESIGN-SYSTEM CHOICES:
 *
 * - This is an AUTHORING screen (matching `StrategyBuilder.tsx`'s own
 *   reasoning), not a fast-capture pre-entry screen — a plain text input
 *   for the field name and each option is the honest control.
 * - Data type: the real `.segmented` radiogroup from frame 3.19 (native
 *   `<input type=radio>` + `<label>` pairs). The previous version of this
 *   note said `components.css` "ships no `.segmented` primitive" —
 *   untrue since the 2026-09-14 design program; corrected 2026-09-16
 *   along with the same stale claim in three other files.
 * - Scope ("All strategies" vs "Just one strategy") is frame 3.19's
 *   `.radio-stack` — each choice with its consequence underneath —
 *   directly implementing §6.1's own flow: "scope: this strategy only ->
 *   kind = strategy_var / scope: all strategies -> kind = account."
 * - Exactly one primary `.rq-btn` in this view ("Create field", bottom-
 *   pinned per the frame); Cancel and "Add option" are `.link`s, and the
 *   per-option remove control is a plain `.icon`.
 */

const DATA_TYPES: { value: FieldDataType; label: string }[] = [
  { value: 'pick_one', label: 'Pick one' },
  { value: 'pick_many', label: 'Pick many' },
  { value: 'number', label: 'Number' },
  { value: 'bool', label: 'Yes / No' },
  { value: 'rating', label: 'Rating' },
  { value: 'note', label: 'Note' },
];

const FIELD_NAME_MAX_LENGTH = 40;

export function FieldCreateForm({ strategies }: { strategies: FieldStrategyOption[] }) {
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState<FieldDataType>('pick_one');
  const [scope, setScope] = useState<'account' | 'strategy_var'>('account');
  const [ownerStrategyId, setOwnerStrategyId] = useState<string>('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [numberMin, setNumberMin] = useState('0');
  const [numberMax, setNumberMax] = useState('100');
  const [numberStep, setNumberStep] = useState('1');
  const [numberUnit, setNumberUnit] = useState('');
  const [customRatingScale, setCustomRatingScale] = useState(false);
  const [ratingMin, setRatingMin] = useState('1');
  const [ratingMax, setRatingMax] = useState('5');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateFieldActionState | null>(null);

  const hasStrategies = strategies.length > 0;

  function updateOption(index: number, value: string) {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  }

  function addOption() {
    setOptions((prev) => [...prev, '']);
  }

  function removeOption(index: number) {
    setOptions((prev) => prev.filter((_, i) => i !== index));
  }

  const trimmedOptions = useMemo(() => options.map((o) => o.trim()).filter((o) => o.length > 0), [options]);

  async function handleSubmit() {
    if (name.trim().length === 0) {
      setResult({ fieldErrors: { name: ['Give this field a name.'] } });
      return;
    }
    if (scope === 'strategy_var' && !ownerStrategyId) {
      setResult({ fieldErrors: { ownerStrategyId: ['Choose which strategy this field belongs to.'] } });
      return;
    }

    let config: { options?: string[]; min?: number; max?: number; step?: number; unit?: string } = {};
    if (dataType === 'pick_one' || dataType === 'pick_many') {
      config = { options: trimmedOptions };
    } else if (dataType === 'number') {
      config = {
        min: Number(numberMin),
        max: Number(numberMax),
        step: Number(numberStep),
        ...(numberUnit.trim().length > 0 ? { unit: numberUnit.trim() } : {}),
      };
    } else if (dataType === 'rating' && customRatingScale) {
      config = { min: Number(ratingMin), max: Number(ratingMax) };
    }

    setSubmitting(true);
    setResult(null);
    const response = await createFieldAction({
      name: name.trim(),
      dataType,
      kind: scope,
      ...(scope === 'strategy_var' ? { ownerStrategyId } : {}),
      config,
    });
    setSubmitting(false);
    setResult(response);
  }

  if (result?.success && result.field) {
    return (
      <section className="flex flex-col gap-4" role="status">
        <h2 className="rq-h2">Field created</h2>
        <p className="rq-body">
          <span className="rq-num">{result.field.name}</span> is ready. You can add it to a strategy the next time
          you build or edit one.
        </p>
        <Link href="/fields" className="rq-btn rq-btn--block">
          Back to your fields
        </Link>
      </section>
    );
  }

  return (
    <form
      className="flex flex-1 flex-col gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      {/* Frame 3.20's blocking alert — an error belongs above the fields
          it is about, not after them (the same qa finding fixed on
          `/accounts/connect` earlier today). */}
      {result?.error && (
        <div className="alert alert--blocking" role="alert">
          <p>{result.error.user_message}</p>
        </div>
      )}

      <div className="field">
        <label htmlFor="field-name">Field name</label>
        <input
          id="field-name"
          value={name}
          maxLength={FIELD_NAME_MAX_LENGTH}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
        {result?.fieldErrors?.name && (
          <p className="hint" role="alert">
            {result.fieldErrors.name[0]}
          </p>
        )}
      </div>

      {/* Frame 3.19's real `.segmented` radiogroup — native radios, one
          label each. The class exists in `components.css` (design program
          batch 6); this file's header used to say it didn't, which was
          true when the header was written and has not been since. */}
      <fieldset>
        <legend>Type</legend>
        <div className="segmented" role="radiogroup" aria-label="Field type">
          {/* Each pair wrapped in a `<span>`, exactly as
              `ManualEntryForm.tsx` already does: `.segmented input` is
              `position:absolute` with no offsets, so without a per-pair
              containing block every hidden input collapses onto the SAME
              static position and the last one in the DOM swallows every
              click. Found for real here — Playwright's click on "Rating"
              was intercepted by "Note"'s input, which is exactly what a
              trader tapping the pill would have hit too. */}
          {DATA_TYPES.map((t) => (
            <span key={t.value}>
              <input
                type="radio"
                id={`field-type-${t.value}`}
                name="field-type"
                checked={dataType === t.value}
                onChange={() => setDataType(t.value)}
              />
              <label htmlFor={`field-type-${t.value}`}>{t.label}</label>
            </span>
          ))}
        </div>
      </fieldset>

      {(dataType === 'pick_one' || dataType === 'pick_many') && (
        <fieldset>
          <legend>Options</legend>
          <ul className="conditions">
            {options.map((opt, i) => (
              <li key={i} className="condition">
                <input
                  value={opt}
                  maxLength={60}
                  autoComplete="off"
                  aria-label={`Option ${i + 1}`}
                  onChange={(e) => updateOption(i, e.target.value)}
                />
                {options.length > 1 && (
                  <button type="button" className="icon" aria-label={`Remove option ${i + 1}`} onClick={() => removeOption(i)}>
                    &times;
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="link self-start" onClick={addOption}>
            Add option
          </button>
          {result?.fieldErrors?.config && (
            <p className="hint" role="alert">
              {result.fieldErrors.config[0]}
            </p>
          )}
        </fieldset>
      )}

      {dataType === 'number' && (
        <fieldset>
          <legend>Range</legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="field">
              <label htmlFor="num-min">Min</label>
              <input id="num-min" type="number" value={numberMin} onChange={(e) => setNumberMin(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="num-max">Max</label>
              <input id="num-max" type="number" value={numberMax} onChange={(e) => setNumberMax(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="num-step">Step</label>
              <input id="num-step" type="number" value={numberStep} onChange={(e) => setNumberStep(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="num-unit">Unit (optional)</label>
              <input id="num-unit" value={numberUnit} maxLength={20} onChange={(e) => setNumberUnit(e.target.value)} />
            </div>
          </div>
          {result?.fieldErrors?.config && (
            <p className="hint" role="alert">
              {result.fieldErrors.config[0]}
            </p>
          )}
        </fieldset>
      )}

      {dataType === 'rating' && (
        <fieldset>
          <legend>Scale</legend>
          <label className="flex items-center gap-2.5 text-base">
            <input
              type="checkbox"
              className="h-5 w-5 accent-accent"
              checked={customRatingScale}
              onChange={(e) => setCustomRatingScale(e.target.checked)}
            />
            Use a custom scale (default 1&ndash;5)
          </label>
          {customRatingScale && (
            <div className="grid grid-cols-2 gap-3">
              <div className="field">
                <label htmlFor="rating-min">Min</label>
                <input id="rating-min" type="number" value={ratingMin} onChange={(e) => setRatingMin(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="rating-max">Max</label>
                <input id="rating-max" type="number" value={ratingMax} onChange={(e) => setRatingMax(e.target.value)} />
              </div>
            </div>
          )}
          {result?.fieldErrors?.config && (
            <p className="hint" role="alert">
              {result.fieldErrors.config[0]}
            </p>
          )}
        </fieldset>
      )}

      {/* §4.2's "note | Never segmented", said plainly the moment a trader
          picks it — frame 3.20's own note/before-entry incompatibility is
          the strategy builder's to raise (that is where a capture moment
          is chosen); this is the part this screen can honestly say. */}
      {dataType === 'note' && (
        <p className="hint">
          Notes aren&apos;t analysed and don&apos;t count toward your field total — a place to write what doesn&apos;t fit
          a field.
        </p>
      )}

      {/* Frame 3.19's `.radio-stack` — a stack of real radios, each with
          its own consequence spelled out underneath. The frame asks "When
          do you record it?"; this screen asks "Where does this apply?"
          because the capture moment has no write path from here at all
          (see this file's own SCOPE header: a moment is a property of a
          field's USAGE inside a strategy, collected by the strategy
          builder). Rendering a moment picker that goes nowhere would be
          inventing UI for a write that does not exist — inventory row
          3.19 records that gap rather than papering over it. */}
      <fieldset>
        <legend>Where does this apply?</legend>
        <div className="radio-stack">
          <label>
            <input type="radio" name="scope" checked={scope === 'account'} onChange={() => setScope('account')} />
            <span>All strategies</span>
            <small>Reusable everywhere, so your stats stay comparable across setups.</small>
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              checked={scope === 'strategy_var'}
              disabled={!hasStrategies}
              onChange={() => setScope('strategy_var')}
            />
            <span>Just one strategy</span>
            <small>
              {hasStrategies
                ? "Private to that setup — won't clutter your other strategies."
                : 'Build a strategy first to scope a field to it.'}
            </small>
          </label>
        </div>

        {scope === 'strategy_var' && hasStrategies && (
          <div className="field pl-[30px]">
            <label htmlFor="owner-strategy">Strategy</label>
            <select id="owner-strategy" value={ownerStrategyId} onChange={(e) => setOwnerStrategyId(e.target.value)}>
              <option value="">Choose a strategy…</option>
              {strategies.map((s) => (
                <option key={s.strategyId} value={s.strategyId}>
                  {s.name}
                </option>
              ))}
            </select>
            {result?.fieldErrors?.ownerStrategyId && (
              <p className="hint" role="alert">
                {result.fieldErrors.ownerStrategyId[0]}
              </p>
            )}
          </div>
        )}
      </fieldset>

      {/* Frame 3.19 pins one full-width action. Cancel is a `.link`, not a
          second button competing with it — going back is not a decision
          the screen should weigh equally against saving. */}
      <div className="push flex flex-col items-center gap-3 pt-2">
        <button type="submit" className="rq-btn rq-btn--block" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create field'}
        </button>
        <Link href="/fields" className="link">
          Cancel
        </Link>
      </div>
    </form>
  );
}
