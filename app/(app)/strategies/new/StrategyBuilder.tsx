'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  TRIGGER_SOFT_WARNING_THRESHOLD,
  TRIGGER_TEXT_MAX_LENGTH,
  countCapturedFields,
  type CaptureMoment,
  type FieldDefinitionForValidation,
  type ProposedStrategyField,
} from '@/lib/fields/strategy-validation';
import { detectHedgeWords } from '@/lib/fields/hedge-words';
import type { FieldPickerEntry } from '@/lib/fields/fields-repository';
import { createStrategyFromBuilder, type CreateStrategyBuilderActionState } from '../actions';

/**
 * Module 03 (Field Registry & Strategy) §5.1/§5.2/§6.1's strategy builder —
 * "name → trigger conditions → fields," per this slice's own scope. The
 * Server Component (`page.tsx`) does the entitlement gate and the
 * read-only field-picker composition (`fetchFieldPickerOptions`); this
 * component owns every bit of interactive wizard state.
 *
 * SCOPE, deliberately narrowed, per this slice's own dispatch ("say so
 * explicitly if you narrow scope this way"):
 *
 *   - Field CREATION is not built here — the field-picker's "Shared across
 *     your strategies" step only offers fields that ALREADY exist
 *     (`kind = 'account'`). §5.2's own reference markup shows an
 *     "Add a field" ghost button under a "Only in this strategy" section;
 *     neither is rendered here. A brand-new strategy also cannot have any
 *     `strategy_var` fields yet by construction (`owner_strategy_id` must
 *     reference an already-existing strategy), so that section would be
 *     structurally empty for this flow regardless of whether field
 *     creation existed.
 *   - Strategy EDIT and promotion UI are separate future slices — this
 *     component only ever calls `createStrategyFromBuilder`.
 *
 * DESIGN-SYSTEM CHOICES, documented per this repo's own established
 * precedent (`RuleEditor.tsx`/`GuidedFrontDoor.tsx`'s own header comments):
 *
 * - This is an AUTHORING screen, not a fast-capture pre-entry screen (the
 *   README's "nothing on a fast-capture screen may require a keyboard"
 *   rule governs `manual-entry`/pre-entry capture, not this one) — text
 *   inputs for the strategy name and trigger-condition text are the honest
 *   control, same posture `ManualEntryForm.tsx`'s own instrument/price
 *   fields and `RuleEditor.tsx`'s operand `<select>` already establish for
 *   this class of screen.
 * - Field selection is a native checkbox list (matching §5.2's own
 *   reference markup literally, `<input type="checkbox" name="field">`) —
 *   not `.rq-pill` toggles — because a field picker is a genuine
 *   many-of-many selection over a potentially long list, not a small
 *   pick-one/pick-many rating control `.rq-pill` is built for elsewhere in
 *   this app (`ManualEntryForm.tsx`'s direction pills,
 *   `GuidedFrontDoor.tsx`'s per-card inclusion toggle).
 * - The capture-moment control per selected field is a plain `<select>`
 *   (matching `RuleEditor.tsx`'s operand picker and
 *   `ManualEntryForm.tsx`'s account picker precedent for "choose one of a
 *   few named things on a form screen") — §5.2's own field-picker
 *   reference markup does not show a moment control at all (only the
 *   FIELD EDITOR does, a separate future screen for field CREATION), but
 *   `strategy_versions.fields[].capture_moment` is a real, required,
 *   per-strategy-usage value `ProposedStrategyField` cannot omit — without
 *   this control the builder could not construct a valid submission at
 *   all. Documented here as a deliberate, necessary addition beyond the
 *   spec's own illustrative markup, not an invented decoration.
 * - "Next"/"Back" between wizard steps: `.rq-btn`/`.rq-btn--ghost`, the
 *   ordinary primary/secondary pair — this is plain navigation, not a
 *   symmetric ethical choice the way `GuidedFrontDoor.tsx`'s Add/Skip pair
 *   is, so `.rq-btn--equal` does not apply here.
 * - Hedge-word detection and the trigger-count/field-cap warnings are all
 *   computed CLIENT-SIDE, live, via the exact same pure functions the
 *   server repository layer uses (`detectHedgeWords`, `hedge-words.ts`;
 *   `countCapturedFields`, `strategy-validation.ts`) — one source of
 *   truth for both, no parallel client-side reimplementation, matching
 *   00-foundation §4.3's "one code path" posture for the (structurally
 *   analogous) rule expression engine.
 */

const ALL_MOMENTS: { value: CaptureMoment; label: string }[] = [
  { value: 'pre_entry', label: 'Before entry' },
  { value: 'in_trade', label: 'While in the trade' },
  { value: 'at_add', label: 'Each time you add' },
  { value: 'at_trim', label: 'Each time you take profit' },
  { value: 'post_close', label: 'After it closes' },
];

/** Mirrors `strategy-validation.ts`'s `validateCaptureMoments` exactly —
 *  §4.4: "A field assigned pre_entry must be pick_one, pick_many, bool, or
 *  rating. A number field is permitted only with a defined min, max and
 *  step. note cannot be pre_entry." Every OTHER moment has no restriction
 *  for any type. */
function validMomentsForField(field: FieldPickerEntry): CaptureMoment[] {
  const nonPreEntry = ALL_MOMENTS.filter((m) => m.value !== 'pre_entry').map((m) => m.value);
  if (field.dataType === 'note') return nonPreEntry;
  if (field.dataType === 'number') {
    const bounded = field.config.min !== undefined && field.config.max !== undefined && field.config.step !== undefined;
    if (!bounded) return nonPreEntry;
  }
  return ALL_MOMENTS.map((m) => m.value);
}

function defaultMomentForField(field: FieldPickerEntry): CaptureMoment {
  const valid = validMomentsForField(field);
  return valid.includes('pre_entry') ? 'pre_entry' : 'post_close';
}

function dataTypeLabel(dataType: FieldPickerEntry['dataType']): string {
  switch (dataType) {
    case 'pick_one':
      return 'Pick one';
    case 'pick_many':
      return 'Pick many';
    case 'number':
      return 'Number';
    case 'bool':
      return 'Yes / No';
    case 'rating':
      return 'Rating';
    case 'note':
      return 'Note';
  }
}

type Step = 'name' | 'triggers' | 'fields';

export function StrategyBuilder({ fieldOptions }: { fieldOptions: FieldPickerEntry[] }) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [triggerTexts, setTriggerTexts] = useState<string[]>(['']);
  const [selectedMoments, setSelectedMoments] = useState<Map<string, CaptureMoment>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateStrategyBuilderActionState | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const derivedFields = useMemo(() => fieldOptions.filter((f) => f.kind === 'derived'), [fieldOptions]);
  const accountFields = useMemo(() => fieldOptions.filter((f) => f.kind === 'account'), [fieldOptions]);

  const fieldDefsById = useMemo(() => {
    const map = new Map<string, FieldDefinitionForValidation>();
    for (const f of fieldOptions) {
      map.set(f.fieldId, { fieldId: f.fieldId, kind: f.kind, dataType: f.dataType, config: f.config });
    }
    return map;
  }, [fieldOptions]);

  const selectedProposedFields: ProposedStrategyField[] = useMemo(
    () =>
      Array.from(selectedMoments.entries()).map(([fieldId, captureMoment], i) => ({
        fieldId,
        captureMoment,
        order: i,
      })),
    [selectedMoments],
  );

  const capturedFieldCount = useMemo(
    () => countCapturedFields(selectedProposedFields, fieldDefsById),
    [selectedProposedFields, fieldDefsById],
  );

  const capWarning =
    capturedFieldCount >= 7
      ? "That's a lot to fill in before every trade. Consider which of these you'd actually change your mind over."
      : capturedFieldCount >= 5
        ? `Each field needs about 20 trades before it tells you anything. You have ${capturedFieldCount}.`
        : null;

  const trimmedTriggers = triggerTexts.map((t) => t.trim()).filter((t) => t.length > 0);
  const triggerTooMany = trimmedTriggers.length > TRIGGER_SOFT_WARNING_THRESHOLD;

  function toggleField(field: FieldPickerEntry, checked: boolean) {
    setSelectedMoments((prev) => {
      const next = new Map(prev);
      if (checked) {
        next.set(field.fieldId, defaultMomentForField(field));
      } else {
        next.delete(field.fieldId);
      }
      return next;
    });
  }

  function setFieldMoment(fieldId: string, moment: CaptureMoment) {
    setSelectedMoments((prev) => {
      const next = new Map(prev);
      next.set(fieldId, moment);
      return next;
    });
  }

  function addTriggerRow() {
    setTriggerTexts((prev) => [...prev, '']);
  }

  function removeTriggerRow(index: number) {
    setTriggerTexts((prev) => prev.filter((_, i) => i !== index));
  }

  function updateTriggerText(index: number, text: string) {
    setTriggerTexts((prev) => prev.map((t, i) => (i === index ? text : t)));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setResult(null);
    const response = await createStrategyFromBuilder({
      name: name.trim(),
      triggers: trimmedTriggers.map((text) => ({ text })),
      fields: selectedProposedFields.map((f) => ({ fieldId: f.fieldId, captureMoment: f.captureMoment })),
    });
    setSubmitting(false);
    setResult(response);
    if (response.fieldErrors?.name) {
      setStep('name');
    } else if (response.fieldErrors?.triggers) {
      setStep('triggers');
    } else if (response.fieldErrors?.fields) {
      setStep('fields');
    }
  }

  if (result?.success) {
    return (
      <section className="flex flex-col gap-4" role="status">
        <h2 className="rq-h2">Strategy created</h2>
        <p className="rq-body">
          <span className="rq-num">{name}</span> is ready. Log a trade against it and its per-field findings will
          start appearing on its own screen once there&apos;s enough data.
        </p>
        {result.triggerCountWarning && (
          <p className="rq-sub">That&apos;s more conditions than we&apos;d expect — most strategies need 2 to 5.</p>
        )}
        <Link href="/strategies" className="rq-btn rq-btn--block">
          Back to your strategies
        </Link>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex gap-2" aria-label="Steps">
        {(['name', 'triggers', 'fields'] as const).map((s, i) => (
          <li key={s}>
            <span className={step === s ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}>
              {i + 1}. {s === 'name' ? 'Name' : s === 'triggers' ? 'Triggers' : 'Fields'}
            </span>
          </li>
        ))}
      </ol>

      {result?.error && (
        <p className="rq-sub" role="alert">
          {result.error.user_message}
        </p>
      )}

      {step === 'name' && (
        <section className="flex flex-col gap-4" aria-labelledby="name-h">
          <h2 id="name-h" className="rq-h2">
            What setup are you naming?
          </h2>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="strategy-name" className="rq-label">
              Strategy name
            </label>
            <input
              id="strategy-name"
              value={name}
              maxLength={100}
              autoComplete="off"
              className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
            />
            {(nameError || result?.fieldErrors?.name) && (
              <p className="rq-sub" role="alert">
                {nameError ?? result?.fieldErrors?.name?.[0]}
              </p>
            )}
          </div>
          <button
            type="button"
            className="rq-btn rq-btn--block"
            onClick={() => {
              if (name.trim().length === 0) {
                setNameError('Give this strategy a name.');
                return;
              }
              setStep('triggers');
            }}
          >
            Next
          </button>
        </section>
      )}

      {step === 'triggers' && (
        <section className="flex flex-col gap-4" aria-labelledby="trig-h">
          <h2 id="trig-h" className="rq-h2">
            When does this setup exist?
          </h2>
          <p className="rq-body">
            Write conditions another trader could check on the same chart and reach the same answer.
          </p>

          <details className="rq-well">
            <summary className="rq-label">Examples</summary>
            <div className="flex flex-col gap-3 pt-3 sm:flex-row sm:gap-6">
              <div className="flex-1">
                <h3 className="rq-label">Works</h3>
                <ul className="flex flex-col gap-1 pt-1">
                  <li className="rq-sub">Price above the 20 EMA on the 5-minute</li>
                  <li className="rq-sub">Three consecutive higher highs</li>
                  <li className="rq-sub">Stop under the swing low</li>
                </ul>
              </div>
              <div className="flex-1">
                <h3 className="rq-label">Too vague</h3>
                <ul className="flex flex-col gap-1 pt-1">
                  <li className="rq-sub">Price is in an uptrend</li>
                  <li className="rq-sub">Momentum looks strong</li>
                  <li className="rq-sub">Good risk-reward</li>
                </ul>
              </div>
            </div>
          </details>

          <ul className="flex flex-col gap-3">
            {triggerTexts.map((text, i) => {
              const hedgeWarnings = detectHedgeWords(text);
              return (
                <li key={i} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      value={text}
                      maxLength={TRIGGER_TEXT_MAX_LENGTH}
                      autoComplete="off"
                      aria-label={`Condition ${i + 1}`}
                      className="flex-1 rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
                      onChange={(e) => updateTriggerText(i, e.target.value)}
                    />
                    {triggerTexts.length > 1 && (
                      <button
                        type="button"
                        className="rq-btn rq-btn--ghost"
                        aria-label={`Remove condition ${i + 1}`}
                        onClick={() => removeTriggerRow(i)}
                      >
                        &times;
                      </button>
                    )}
                  </div>
                  {hedgeWarnings.length > 0 && (
                    <p className="rq-sub" role="note">
                      &ldquo;{hedgeWarnings[0]}&rdquo; may mean different things on different days. Could you say
                      what you&apos;re actually looking at?
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <button type="button" className="rq-btn rq-btn--ghost" onClick={addTriggerRow}>
            Add condition
          </button>
          {triggerTooMany && (
            <p className="rq-sub">
              That&apos;s more than we&apos;d expect — most strategies need 2 to 5 conditions.
            </p>
          )}
          <p className="rq-sub">These are never enforced. You can always take the trade.</p>

          {result?.fieldErrors?.triggers && (
            <p className="rq-sub" role="alert">
              {result.fieldErrors.triggers[0]}
            </p>
          )}

          <div className="flex gap-2">
            <button type="button" className="rq-btn rq-btn--ghost flex-1" onClick={() => setStep('name')}>
              Back
            </button>
            <button type="button" className="rq-btn flex-1" onClick={() => setStep('fields')}>
              Next
            </button>
          </div>
        </section>
      )}

      {step === 'fields' && (
        <section className="flex flex-col gap-5" aria-labelledby="fields-h">
          <h2 id="fields-h" className="rq-h2">
            What do you want to record?
          </h2>

          {derivedFields.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="rq-label">Recorded automatically</h3>
              <p className="rq-sub">You never fill these in. They still appear in your results.</p>
              <ul className="flex flex-wrap gap-2">
                {derivedFields.map((f) => (
                  <li key={f.fieldId} className="rq-tag rq-tag--muted">
                    {f.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="rq-label">Shared across your strategies</h3>
            {accountFields.length === 0 ? (
              <p className="rq-sub">
                You don&apos;t have any custom fields yet. You can add strategy fields in a future update — for now,
                this strategy will rely on what&apos;s recorded automatically.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {accountFields.map((f) => {
                  const checked = selectedMoments.has(f.fieldId);
                  const moment = selectedMoments.get(f.fieldId) ?? defaultMomentForField(f);
                  const validMoments = validMomentsForField(f);
                  return (
                    <li key={f.fieldId} className="rq-well flex flex-col gap-2">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={checked} onChange={(e) => toggleField(f, e.target.checked)} />
                        <span className="rq-body flex-1">{f.name}</span>
                        <span className="rq-tag rq-tag--muted">{dataTypeLabel(f.dataType)}</span>
                      </label>
                      {checked && (
                        <div className="flex flex-col gap-1 pl-6">
                          <label htmlFor={`moment-${f.fieldId}`} className="rq-label">
                            When do you record it?
                          </label>
                          <select
                            id={`moment-${f.fieldId}`}
                            value={moment}
                            className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                            onChange={(e) => setFieldMoment(f.fieldId, e.target.value as CaptureMoment)}
                          >
                            {ALL_MOMENTS.filter((m) => validMoments.includes(m.value)).map((m) => (
                              <option key={m.value} value={m.value}>
                                {m.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {capWarning && (
            <aside className="rq-well" role="note">
              <p className="rq-sub">{capWarning}</p>
            </aside>
          )}

          {result?.fieldErrors?.fields && (
            <ul className="flex flex-col gap-1">
              {result.fieldErrors.fields.map((msg, i) => (
                <li key={i} className="rq-sub" role="alert">
                  {msg}
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <button type="button" className="rq-btn rq-btn--ghost flex-1" onClick={() => setStep('triggers')} disabled={submitting}>
              Back
            </button>
            <button type="button" className="rq-btn flex-1" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create strategy'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
