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
 * - Data type: a native `role="radiogroup"` segmented control, matching
 *   §5.2's own reference markup (`<div class="segmented" role="radiogroup">`)
 *   almost literally, translated to this repo's own `.rq-tag`-as-toggle
 *   convention (`StrategyBuilder.tsx`'s own step indicator) since
 *   `components.css` ships no `.segmented` primitive.
 * - Scope ("All strategies" vs "Just one strategy") is likewise a two-way
 *   toggle over the SAME device, directly implementing §6.1's own flow:
 *   "scope: this strategy only -> kind = strategy_var / scope: all
 *   strategies -> kind = account."
 * - Exactly one primary `.rq-btn` in this view ("Create field"); the
 *   per-option remove buttons and "Add option" are `.rq-btn--ghost`,
 *   matching `StrategyBuilder.tsx`'s own trigger-condition row precedent.
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
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      {result?.error && (
        <p className="rq-sub" role="alert">
          {result.error.user_message}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-name" className="rq-label">
          Field name
        </label>
        <input
          id="field-name"
          value={name}
          maxLength={FIELD_NAME_MAX_LENGTH}
          autoComplete="off"
          className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
          onChange={(e) => setName(e.target.value)}
        />
        {result?.fieldErrors?.name && (
          <p className="rq-sub" role="alert">
            {result.fieldErrors.name[0]}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="rq-label">Type</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Field type">
          {DATA_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={dataType === t.value}
              className={dataType === t.value ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}
              onClick={() => setDataType(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </fieldset>

      {(dataType === 'pick_one' || dataType === 'pick_many') && (
        <div className="flex flex-col gap-2">
          <p className="rq-label">Options</p>
          <ul className="flex flex-col gap-2">
            {options.map((opt, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  value={opt}
                  maxLength={60}
                  autoComplete="off"
                  aria-label={`Option ${i + 1}`}
                  className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                  onChange={(e) => updateOption(i, e.target.value)}
                />
                {options.length > 1 && (
                  <button
                    type="button"
                    className="rq-btn rq-btn--ghost"
                    aria-label={`Remove option ${i + 1}`}
                    onClick={() => removeOption(i)}
                  >
                    &times;
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="rq-btn rq-btn--ghost" onClick={addOption}>
            Add option
          </button>
          {result?.fieldErrors?.config && (
            <p className="rq-sub" role="alert">
              {result.fieldErrors.config[0]}
            </p>
          )}
        </div>
      )}

      {dataType === 'number' && (
        <div className="flex flex-col gap-3">
          <p className="rq-label">Range</p>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1">
              <span className="rq-label">Min</span>
              <input
                type="number"
                value={numberMin}
                className="w-28 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                onChange={(e) => setNumberMin(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="rq-label">Max</span>
              <input
                type="number"
                value={numberMax}
                className="w-28 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                onChange={(e) => setNumberMax(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="rq-label">Step</span>
              <input
                type="number"
                value={numberStep}
                className="w-28 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                onChange={(e) => setNumberStep(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="rq-label">Unit (optional)</span>
              <input
                value={numberUnit}
                maxLength={20}
                className="w-28 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                onChange={(e) => setNumberUnit(e.target.value)}
              />
            </label>
          </div>
          {result?.fieldErrors?.config && (
            <p className="rq-sub" role="alert">
              {result.fieldErrors.config[0]}
            </p>
          )}
        </div>
      )}

      {dataType === 'rating' && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={customRatingScale} onChange={(e) => setCustomRatingScale(e.target.checked)} />
            <span className="rq-body">Use a custom scale (default 1–5)</span>
          </label>
          {customRatingScale && (
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1">
                <span className="rq-label">Min</span>
                <input
                  type="number"
                  value={ratingMin}
                  className="w-24 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                  onChange={(e) => setRatingMin(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="rq-label">Max</span>
                <input
                  type="number"
                  value={ratingMax}
                  className="w-24 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                  onChange={(e) => setRatingMax(e.target.value)}
                />
              </label>
            </div>
          )}
          {result?.fieldErrors?.config && (
            <p className="rq-sub" role="alert">
              {result.fieldErrors.config[0]}
            </p>
          )}
        </div>
      )}

      {dataType === 'note' && (
        <p className="rq-sub">Notes aren&apos;t analysed and don&apos;t count toward your field total — a place to write what doesn&apos;t fit a field.</p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="rq-label">Where does this apply?</legend>
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="scope"
              checked={scope === 'account'}
              onChange={() => setScope('account')}
            />
            <span>
              <span className="rq-body block">All strategies</span>
              <span className="rq-sub block">Reusable everywhere, so your stats stay comparable across setups.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="scope"
              checked={scope === 'strategy_var'}
              disabled={!hasStrategies}
              onChange={() => setScope('strategy_var')}
            />
            <span>
              <span className="rq-body block">Just one strategy</span>
              <span className="rq-sub block">
                {hasStrategies
                  ? "Private to that setup — won't clutter your other strategies."
                  : 'Build a strategy first to scope a field to it.'}
              </span>
            </span>
          </label>
        </div>

        {scope === 'strategy_var' && hasStrategies && (
          <div className="flex flex-col gap-1.5 pl-6">
            <label htmlFor="owner-strategy" className="rq-label">
              Strategy
            </label>
            <select
              id="owner-strategy"
              value={ownerStrategyId}
              className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
              onChange={(e) => setOwnerStrategyId(e.target.value)}
            >
              <option value="">Choose a strategy…</option>
              {strategies.map((s) => (
                <option key={s.strategyId} value={s.strategyId}>
                  {s.name}
                </option>
              ))}
            </select>
            {result?.fieldErrors?.ownerStrategyId && (
              <p className="rq-sub" role="alert">
                {result.fieldErrors.ownerStrategyId[0]}
              </p>
            )}
          </div>
        )}
      </fieldset>

      <div className="flex gap-2">
        <Link href="/fields" className="rq-btn rq-btn--ghost flex-1">
          Cancel
        </Link>
        <button type="submit" className="rq-btn flex-1" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create field'}
        </button>
      </div>
    </form>
  );
}
