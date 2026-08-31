'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Decimal } from 'decimal.js';
import { getOperand, type OperandCatalogueEntry, type OperandGroup } from '@/lib/rules/operand-catalogue';
import { soleAuthorableOp } from '@/lib/rules/editable-operands';
import { renderSentence } from '@/lib/rules/render-sentence';
import { formatUsageFraction } from '@/lib/entitlements/messages';
import { createRule, previewRule, type PreviewRuleActionState } from '../actions';

/**
 * Module 04 §6.1's `.rule-editor` reference markup, general form — Slice
 * 10b. The Server Component (`page.tsx`) resolves which operand ids are
 * even offerable (type + tier filtering against this trader's real
 * accounts); this component owns every bit of interactive state: which
 * operand is currently selected, its stepper value (for number/duration
 * types), the debounced live preview, and the actual write (`createRule`
 * — the SAME Server Action Slice 10a's guided front door already calls,
 * no parallel write path invented for this screen either).
 *
 * DESIGN-SYSTEM / SPEC-FIDELITY CHOICES, documented (matching Slice 10a's
 * own precedent of writing these down rather than assuming they're
 * obvious):
 *
 * - NO operand-picker keyboard field. The operand chooser is a native
 *   `<select>` grouped by catalogue `group` via `<optgroup>` — this repo's
 *   own established precedent for "choose one of many named things" on a
 *   FORM screen (not a fast-capture pre-entry screen), e.g.
 *   `ManualEntryForm.tsx`'s account `<select>`. Story 1.1's "no operator
 *   dropdown anywhere" is about the COMPARISON OPERATOR (lte/gte/is_true/
 *   etc.), not which rule TYPE to author — and it is satisfied literally
 *   here: there is no operator control anywhere on this screen at all,
 *   because `lib/rules/editable-operands.ts` only ever offers operands
 *   with exactly one authorable operator, resolved automatically via
 *   `soleAuthorableOp`. A polished ranked-discovery replacement for this
 *   plain picker (leading with the trader's own behaviour, story 1.3) is
 *   Slice 10c's job, not this one's.
 * - Numeric/duration value: the SAME `.rq-step` stepper Slice 10a
 *   established (no native range slider — that primitive does not exist
 *   in the shipped design system, see `GuidedFrontDoor.tsx`'s own header
 *   for the confirmation this slice re-verified still holds). No text
 *   input, no keyboard, for the value itself.
 * - Bool operand: no stepper and no toggle at all. Every v1 bool operand
 *   has exactly one authorable operator (`is_true` or `is_false`) with NO
 *   `{value}` placeholder in its phrasing template (`operand-catalogue.ts`'s
 *   own `phrasing` map) — the sentence is already complete the moment the
 *   operand is chosen ("Always set a stop before entering.") — there is
 *   no "single tappable number" for this operand type because there is no
 *   number. `rule_versions.value` is still a required `not null` jsonb
 *   column, so a fixed `true` is submitted (the evaluator's own
 *   `compareBool`, `evaluate.ts`, never reads it for a bool comparison —
 *   documented at that file's own header — so this is not a meaningful
 *   choice, just satisfying the column's own NOT NULL constraint).
 * - Scope is not offered as a control anywhere on this screen — see
 *   `page.tsx`'s own header comment for the full reasoning (no Module 03
 *   strategies exist yet to scope a rule to). Every submission is
 *   `scope: 'global'`, and the rule-meta chip reads "Applies to all
 *   strategies" unconditionally, same copy Slice 10a's guided cards use.
 * - Tighten-only's two-button rejection alert (§6.1's `alert--blocking`
 *   markup) is NOT built — see `page.tsx`'s header for why it is
 *   structurally unreachable through a `scope: 'global'`-only screen.
 *   Every other server error code (including `RULE_UNSATISFIABLE`, which
 *   genuinely CAN run for two conflicting global rules) renders as a
 *   plain `role="alert"` message using the server's own already-tailored
 *   `user_message` — no bespoke UI per code beyond that, since nothing
 *   else in §10's error table has a reference markup of its own for a
 *   `scope: 'global'`-only screen.
 * - Entitlement display self-updates after every `createRule` response
 *   (bug fix, post-Slice-10b-QA): the "Rule slots: N of M used" header
 *   started life as `page.tsx`'s one-time `canForUser` snapshot, which
 *   goes stale the moment a trader stays on this screen across more than
 *   one submission (e.g. "Write another rule" resets the form without a
 *   page reload). It is now local component state, incremented on a
 *   successful create and pinned to `used = limit` on an `ENTITLEMENT_LIMIT`
 *   rejection — mirrors `GuidedFrontDoor.tsx`'s own care around this
 *   value, though that screen never re-renders its entitlement header
 *   after a successful create in the same session (it moves straight to a
 *   terminal done/skipped state instead), so it did not carry this exact
 *   bug. Purely a display correction — the actual cap enforcement remains
 *   entirely server-side in `insertRuleAndVersion`'s guarded INSERT.
 */

const GROUP_LABELS: Record<OperandGroup, string> = {
  risk_and_size: 'Risk and size',
  stopping: 'Stopping',
  timing: 'Timing',
  entry_discipline: 'Entry discipline',
  position_management: 'Position management',
  exit: 'Exit',
  instrument: 'Instrument',
  process: 'Process',
};

const PREVIEW_DEBOUNCE_MS = 350;

interface EntitlementSummary {
  allowed: boolean;
  limit: number | null;
  used: number;
  usageFraction: string;
}

function countDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/** Bounds-midpoint default, rounded to the operand's own step — the same
 *  honest "middle of what this rule type even allows" fallback
 *  `guided-front-door.ts` uses when there is no history to seed from
 *  (that file's own function is `server-only` and cannot be imported into
 *  this client component, so this is a small, deliberate duplicate — same
 *  precedent as `GuidedFrontDoor.tsx`'s own inline `step()` function not
 *  importing from `guided-front-door.ts` either). This general editor does
 *  not attempt per-operand history-based seeding beyond this — the guided
 *  front door already covers the three operands where that investment
 *  pays off (§5.10); building a second, general history-seeding pipeline
 *  for all ~20 offerable operands is out of this sub-slice's scope, and
 *  the live preview immediately tells the trader whether this starting
 *  number is even meaningful for their own history. */
function boundsMidpointDefault(bounds: { min: number; max: number; step: number }): number {
  const min = new Decimal(bounds.min);
  const max = new Decimal(bounds.max);
  const step = new Decimal(bounds.step);
  const mid = min.plus(max).dividedBy(2);
  const stepsFromMin = mid.minus(min).dividedBy(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const stepped = min.plus(stepsFromMin.times(step));
  return Decimal.max(bounds.min, Decimal.min(bounds.max, stepped)).toNumber();
}

type Phase = 'editing' | 'submitting' | 'done';

export function RuleEditor({
  operandIds,
  entitlement: initialEntitlement,
}: {
  operandIds: string[];
  entitlement: EntitlementSummary;
}) {
  const [phase, setPhase] = useState<Phase>('editing');
  const [selectedOperandId, setSelectedOperandId] = useState<string>('');
  const [value, setValue] = useState<number>(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [doneRendered, setDoneRendered] = useState<string | null>(null);
  // `page.tsx`'s `canForUser` snapshot is only ever correct at the moment
  // the Server Component rendered -- this component can stay mounted
  // across many sequential `createRule` calls in one session (the "Write
  // another rule" reset below does NOT remount the page, so the initial
  // prop would otherwise go stale). Self-updated below after every real
  // `createRule` response (success or `ENTITLEMENT_LIMIT` rejection) so
  // the "Rule slots: N of M used" header and the at-cap message always
  // reflect the ACTUAL server-confirmed state, never the page-load
  // snapshot alone. The server-side cap enforcement itself
  // (`insertRuleAndVersion`'s guarded INSERT, Slice 10b's own
  // `pg_advisory_xact_lock` fix) is untouched by this -- this is purely a
  // client-side display correction downstream of that already-authoritative
  // response.
  const [entitlement, setEntitlement] = useState<EntitlementSummary>(initialEntitlement);

  const operandsByGroup = useMemo(() => {
    const groups = new Map<OperandGroup, OperandCatalogueEntry[]>();
    for (const id of operandIds) {
      const operand = getOperand(id);
      if (!operand) continue; // defensive: an id the server sent that isn't in this build's catalogue
      const list = groups.get(operand.group) ?? [];
      list.push(operand);
      groups.set(operand.group, list);
    }
    return groups;
  }, [operandIds]);

  const selectedOperand = selectedOperandId ? getOperand(selectedOperandId) : undefined;

  function handleSelectOperand(operandId: string) {
    setSelectedOperandId(operandId);
    setSubmitError(null);
    if (!operandId) return;
    const operand = getOperand(operandId);
    if (!operand) return;
    if (operand.type === 'bool') {
      // No number to seed -- the sentence is already complete, and
      // `RuleSentenceEditor`/the submit handler both hardcode the
      // submitted value to `true` for a bool operand regardless of this
      // component's own numeric `value` state (see this file's own
      // header). Nothing to set here.
      return;
    }
    if (operand.bounds) {
      setValue(boundsMidpointDefault(operand.bounds));
    }
  }

  if (phase === 'done') {
    return (
      <section className="flex flex-col gap-4" role="status">
        <h2 className="rq-h2">Rule added</h2>
        <p className="rq-body">{doneRendered}</p>
        <span className="rq-tag rq-tag--muted">Starts soft</span>
        <div className="flex flex-col gap-2">
          <Link href="/trades" className="rq-btn rq-btn--block">
            Go to your trades
          </Link>
          <button
            type="button"
            className="rq-btn rq-btn--ghost rq-btn--block"
            onClick={() => {
              setSelectedOperandId('');
              setDoneRendered(null);
              setPhase('editing');
            }}
          >
            Write another rule
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {entitlement.limit !== null && (
        <p className="rq-sub">
          Rule slots: <span className="rq-num">{entitlement.usageFraction}</span> used.
        </p>
      )}
      {!entitlement.allowed && (
        <p className="rq-sub" role="alert">
          You&apos;re already at your rule limit, so this can&apos;t be added right now.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="operand-picker" className="rq-label">
          What do you want a rule about?
        </label>
        <select
          id="operand-picker"
          className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
          value={selectedOperandId}
          disabled={phase === 'submitting'}
          onChange={(e) => handleSelectOperand(e.target.value)}
        >
          <option value="">Choose a rule type…</option>
          {[...operandsByGroup.entries()].map(([group, operands]) => (
            <optgroup key={group} label={GROUP_LABELS[group]}>
              {operands.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {submitError && (
        <p className="rq-sub" role="alert">
          {submitError}
        </p>
      )}

      {selectedOperand && (
        <RuleSentenceEditor
          key={selectedOperand.id}
          operand={selectedOperand}
          value={value}
          onValueChange={setValue}
          disabled={phase === 'submitting'}
          canSubmit={entitlement.allowed}
          onSubmit={async () => {
            setSubmitError(null);
            setPhase('submitting');
            const op = soleAuthorableOp(selectedOperand);
            const submittedValue = selectedOperand.type === 'bool' ? true : value;
            const result = await createRule({ operandId: selectedOperand.id, op, value: submittedValue, scope: 'global' });
            if (result.success && result.rule) {
              // Self-derived from the fact this call just succeeded --
              // `RuleActionState`'s success branch carries no entitlement
              // snapshot of its own (see this file's own header), so
              // "one more rule now exists" is the one fact this response
              // actually proves. Capped at `limit` defensively (never
              // displayed above the real ceiling even if some other path
              // already put this trader over it).
              setEntitlement((prev) => {
                if (prev.limit === null) return prev; // unlimited plan -- nothing to track
                const used = Math.min(prev.used + 1, prev.limit);
                return { ...prev, used, allowed: used < prev.limit, usageFraction: formatUsageFraction(used, prev.limit) };
              });
              setDoneRendered(result.rule.rendered);
              setPhase('done');
            } else {
              if (result.error?.code === 'ENTITLEMENT_LIMIT') {
                // The server just confirmed this trader is AT the cap right
                // now (either the fast pre-check or the atomic race-loser
                // path -- both map to this same code) -- reflect that
                // exactly (`used = limit`) rather than leaving whatever
                // stale number was on screen before this attempt.
                setEntitlement((prev) =>
                  prev.limit === null
                    ? prev
                    : { ...prev, used: prev.limit, allowed: false, usageFraction: formatUsageFraction(prev.limit, prev.limit) },
                );
              }
              setSubmitError(result.error?.user_message ?? 'Something went wrong saving this rule. Please try again.');
              setPhase('editing');
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * One operand's sentence + (for number/duration types) stepper + live
 * preview + rule-meta chips + submit button — §6.1's `.rule-editor`
 * section, adapted the same way Slice 10a's `GuidedRuleCard` adapted it:
 * the full rendered sentence as static text above a real `.rq-step`
 * control, rather than an inline clickable blank inside the sentence
 * itself (this repo's own established convention for this markup, not a
 * fresh interpretation).
 */
function RuleSentenceEditor({
  operand,
  value,
  onValueChange,
  disabled,
  canSubmit,
  onSubmit,
}: {
  operand: OperandCatalogueEntry;
  value: number;
  onValueChange: (value: number) => void;
  disabled: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  const op = soleAuthorableOp(operand);
  const isNumeric = operand.type === 'number' || operand.type === 'duration' || operand.type === 'rating';
  const bounds = operand.bounds;

  const previewValue = operand.type === 'bool' ? true : value;
  const sentence = useMemo(() => renderSentence(operand.id, op, previewValue), [operand.id, op, previewValue]);

  const [preview, setPreview] = useState<PreviewRuleActionState['preview'] | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const thisRequestId = ++requestIdRef.current;
    // Deferred into the debounce timer, not called synchronously in the
    // effect body -- same `react-hooks/set-state-in-effect` posture
    // `GuidedFrontDoor.tsx` already documents; the initial
    // `useState(true)` above already covers the first render.
    const timer = setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      previewRule({ operandId: operand.id, op, value: previewValue })
        .then((result) => {
          if (requestIdRef.current !== thisRequestId) return;
          if (result.success && result.preview) {
            setPreview(result.preview);
          } else {
            setPreviewError(result.error?.user_message ?? 'Preview unavailable right now.');
          }
        })
        .catch(() => {
          if (requestIdRef.current !== thisRequestId) return;
          setPreviewError('Preview unavailable right now.');
        })
        .finally(() => {
          if (requestIdRef.current === thisRequestId) setPreviewLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [operand.id, op, previewValue]);

  function step(direction: 1 | -1) {
    if (!bounds) return;
    const next = Decimal.max(
      bounds.min,
      Decimal.min(bounds.max, new Decimal(value).plus(new Decimal(bounds.step).times(direction))),
    ).toNumber();
    onValueChange(next);
  }

  const decimals = bounds ? countDecimals(bounds.step) : 0;
  const displayValue = value.toFixed(decimals);

  return (
    <section className="rule-editor rq-card flex flex-col gap-3" aria-labelledby="re-h">
      <h2 id="re-h" className="sr-only">
        {operand.label}
      </h2>

      <p className="rule-sentence rq-body">{sentence}</p>

      {isNumeric && bounds && (
        <div className="rq-step" role="group" aria-label={`${operand.label} threshold`}>
          <button type="button" className="rq-step__btn" aria-label="Decrease" disabled={disabled} onClick={() => step(-1)}>
            &minus;
          </button>
          <span className="rq-step__val rq-num" aria-live="polite">
            {displayValue}
            {operand.unit === 'percent' ? '%' : ''}
          </span>
          <button type="button" className="rq-step__btn" aria-label="Increase" disabled={disabled} onClick={() => step(1)}>
            +
          </button>
        </div>
      )}

      <aside className="preview rq-well flex flex-col gap-1" role="status" aria-live="polite">
        {previewLoading ? (
          <p className="rq-sub" aria-busy="true">
            Checking against your history…
          </p>
        ) : previewError ? (
          <p className="rq-sub" role="alert">
            {previewError}
          </p>
        ) : preview?.state === 'flagged' ? (
          <>
            <p className="preview__lede rq-sub">Against your recent trades, this would have flagged</p>
            <p className="preview__count rq-num">{preview.flagged}</p>
            <p className="preview__guidance rq-sub">{preview.guidance}</p>
            {preview.calibration && <p className="preview__calibration rq-sub">{preview.calibration}</p>}
          </>
        ) : (
          <p className="rq-sub">{preview?.guidance ?? 'Not enough data yet.'}</p>
        )}
        <p className="preview__disclaimer rq-sub">Preview only. Past trades are never scored against this rule.</p>
      </aside>

      <div className="rule-meta flex flex-wrap items-center gap-2">
        <span className="rq-tag rq-tag--muted">Starts soft</span>
        <span className="rq-tag rq-tag--muted">Applies to all strategies</span>
      </div>

      <button type="button" className="rq-btn rq-btn--block" disabled={disabled || !canSubmit} onClick={onSubmit}>
        {disabled ? 'Adding…' : 'Add rule'}
      </button>
    </section>
  );
}
