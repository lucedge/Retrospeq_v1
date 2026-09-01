'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Decimal } from 'decimal.js';
import { getOperand, type OperandCatalogueEntry, type RuleOperator } from '@/lib/rules/operand-catalogue';
import { renderSentence } from '@/lib/rules/render-sentence';
import type { RuleListItem } from '@/lib/rules/rules-repository';
import {
  fetchRuleForEdit,
  editRule,
  previewRule,
  type FetchRuleForEditActionResult,
  type PreviewRuleActionState,
} from './actions';
import { withTimeout, ActionTimeoutError } from './with-timeout';

/**
 * Module 04 (Rulebook & Evaluation) §2.5 / §6.1's own `.rule-editor`
 * reference markup, adapted for EDITING an existing rule's threshold —
 * Slice 10f. Closes the gap PROGRESS.md's own "Module 04 scope gap" entry
 * named: `editRule` (`app/(app)/rules/actions.ts`) has been fully built,
 * tested, and security-reviewed since Slice 2 (2026-08-19), but no UI
 * anywhere has ever called it.
 *
 * Opened INLINE from a row in `RuleList.tsx` (the same "expand a section
 * within the row" shell that row's own swap chooser / retire-confirm
 * already use, not a new modal or a new route) — a fresh instance of this
 * component is mounted each time a row's `editing` flag flips true
 * (`RuleList.tsx`'s conditional render, no `key` trickery needed: the
 * component simply does not exist in the tree until then), so its own
 * `useEffect` below always runs exactly once per "open Edit" click.
 *
 * DESIGN-SYSTEM / SPEC-FIDELITY CHOICES, documented per this file tree's
 * own established precedent (`RuleEditor.tsx`, `RuleList.tsx`) of writing
 * these down rather than assuming they're obvious:
 *
 * - Deliberately a NEW, small, self-contained component rather than
 *   importing `RuleEditor.tsx`'s own `RuleSentenceEditor` — that component
 *   is not exported (module-private to `new/RuleEditor.tsx`) and is
 *   tightly coupled to the CREATE flow's own copy/state ("Add rule", the
 *   entitlement-driven `canSubmit`/"Starts soft" chip, calling `createRule`
 *   with a fixed `scope: 'global'`). Editing needs different copy ("Save"/
 *   "Cancel", no entitlement chip — editing an existing rule never
 *   consumes a rule slot, per `editRule`'s own header) and a different
 *   write call (`editRule(ruleId, expectedVersion, newValue)`, no
 *   `operandId`/`op`/`scope` ever sent — §2.5: "only `value` ever
 *   changes"). The stepper/preview
 *   MARKUP shape below intentionally mirrors `RuleSentenceEditor`'s
 *   (`.rq-step`, the same `preview`/`role="status"` well) so the two feel
 *   like the same interaction pattern, matching this slice's own dispatch
 *   instruction ("an EDIT interaction should feel like the same pattern,
 *   just pre-filled") — but the actual component code is a deliberate,
 *   small, documented duplicate, the same precedent `RuleEditor.tsx`'s own
 *   header already sets for `boundsMidpointDefault` (a server-only
 *   function it could not import into a client component either).
 * - Only `number`/`duration`/`rating` operand types (the ones with a real
 *   `bounds` stepper) are ever editable through this control — `RuleRow`
 *   (`RuleList.tsx`) decides whether to show the "Edit" action at all,
 *   filtering on exactly this, so in practice this component only ever
 *   mounts for a genuinely steppable operand. `bool` operands are
 *   deliberately excluded: every v1 bool operand's phrasing has NO
 *   `{value}` placeholder at all (`operand-catalogue.ts`'s own comment on
 *   `RuleEditor.tsx`'s identical bool handling) — there is no threshold to
 *   change, so "editing" one is not a meaningful action, and no UI is built
 *   for it here. The fallback branch below (operand missing from the
 *   catalogue, or not a bounded numeric type) is defensive-only — should be
 *   unreachable given `RuleRow`'s own gate, kept honest rather than assumed
 *   impossible, matching this codebase's own "should be structurally
 *   impossible" throw-and-explain convention elsewhere.
 * - LIVE PREVIEW included, same debounced `previewRule` call
 *   `RuleSentenceEditor` already established for the CREATE flow. Per this
 *   slice's own dispatch reasoning: story 1.2 ("Preview against history
 *   updates live as the slider moves") is about AUTHORING broadly, and the
 *   spec draws no distinction between creating a rule and changing its
 *   threshold for this particular story — a trader adjusting an existing
 *   rule's number deserves the exact same live feedback a trader picking
 *   the number for the first time gets, not a degraded experience just
 *   because the rule already exists.
 * - Every awaited Server Action call (`fetchRuleForEdit`, `editRule`) is
 *   wrapped in `withTimeout` (`./with-timeout.ts`, 15s) — the SAME
 *   proactive posture `RuleList.tsx` already applies everywhere else in
 *   this file tree after the independent tester found a real "hung
 *   Server Action call leaves every control disabled forever" bug there
 *   (Slice 10e). Applying it here from the start, rather than waiting for
 *   the same bug class to be rediscovered in a fourth place.
 * - Version-conflict handling, FIXED (Slice 10f, independent-tester
 *   finding, 2026-09-01): this component now stores the `currentVersion`
 *   `fetchRuleForEdit`'s own initial snapshot returned (in `version`
 *   state, below) and sends it back to `editRule(rule.ruleId, version,
 *   value)` on submit. The ORIGINAL version of this component never sent
 *   `currentVersion` back at all — `editRule` re-derived "expected
 *   version" from its own fresh internal re-fetch, so the only race it
 *   could ever actually catch was one entirely INTERNAL to a single
 *   `editRule` call (sub-second), never the real "I had this edit control
 *   open for a while and someone else changed the rule in the meantime"
 *   scenario `RULE_EDIT_CONFLICT` exists for. Reproduced live: open Edit
 *   at v1, a concurrent edit lands at v2, the original trader's stale save
 *   returned `success: true` and silently overwrote v2 — see `editRule`'s
 *   own header comment in `actions.ts` for the full writeup. Now that
 *   `version` is a real snapshot threaded through end to end,
 *   `RULE_EDIT_CONFLICT` renders the server's own honest `user_message`
 *   ("This rule was just changed elsewhere...") via the same generic
 *   `role="alert"` path every other rejection code uses, but ALSO offers
 *   a genuine path forward — not just an alert with nowhere to go, which
 *   "please refresh and try again" would otherwise imply without actually
 *   providing: a "Refresh" button (`conflict` state below) that re-runs
 *   `loadRuleData` in place, re-fetching the rule's now-current value and
 *   version and re-rendering the SAME open edit control pre-filled with
 *   fresh data, ready to edit again — rather than making the trader close
 *   and manually reopen Edit themselves.
 */

const PREVIEW_DEBOUNCE_MS = 350;

function countDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

const ACTION_TIMEOUT_MS = 15_000;
const UNEXPECTED_ERROR_MESSAGE = 'Something unexpected went wrong. Please try again.';
const TIMEOUT_ERROR_MESSAGE =
  'This is taking longer than expected. It may have already gone through — close this and reopen Edit to check, or try again below.';

function messageForCaughtError(err: unknown): string {
  return err instanceof ActionTimeoutError ? TIMEOUT_ERROR_MESSAGE : UNEXPECTED_ERROR_MESSAGE;
}

interface EditRuleControlProps {
  rule: RuleListItem;
  onCancel: () => void;
  onSaved: (patch: { rendered: string; version: number }) => void;
}

type LoadPhase = 'loading' | 'ready' | 'submitting';

export function EditRuleControl({ rule, onCancel, onSaved }: EditRuleControlProps) {
  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operand, setOperand] = useState<OperandCatalogueEntry | undefined>(undefined);
  const [op, setOp] = useState<RuleOperator | null>(null);
  const [value, setValue] = useState<number>(0);
  // The version `fetchRuleForEdit`'s own snapshot returned — this is what
  // gets sent BACK to `editRule` on submit as `expectedVersion`, never a
  // value re-derived at submit time. See this file's own header comment
  // ("Version-conflict handling, FIXED") for why re-deriving it at submit
  // time would reintroduce the exact bug this fixes, by construction.
  const [version, setVersion] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // True only when the LAST save attempt was rejected with
  // RULE_EDIT_CONFLICT — gates the "Refresh" affordance below (a plain
  // alert with no path forward would leave the trader stuck).
  const [conflict, setConflict] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Applies a `fetchRuleForEdit` result to state — shared by the initial
  // mount effect below AND `handleRefresh` (the trader-facing "Refresh"
  // action on a RULE_EDIT_CONFLICT rejection), both of which need the
  // identical "interpret the fetch result" logic. Deliberately a plain
  // function that does NOT itself call `fetchRuleForEdit` or reset any
  // state — the mount effect below fetches via an inline
  // `.then/.catch/.finally` promise chain (the SAME shape this file used
  // before this fix) rather than calling a named async helper directly,
  // because react-hooks' `set-state-in-effect` lint rule correctly flags a
  // `useCallback`d async function that calls a state setter anywhere in
  // its body being invoked directly from inside a `useEffect` — even after
  // an `await`.
  function applyFetchResult(result: FetchRuleForEditActionResult) {
    if (!result.success || !result.rule) {
      setLoadError(result.error?.user_message ?? "We couldn't load this rule.");
      return;
    }
    const catalogueEntry = getOperand(result.rule.operandId);
    const numericValue = typeof result.rule.value === 'number' ? result.rule.value : Number(result.rule.value);
    if (!catalogueEntry || Number.isNaN(numericValue)) {
      // Defensive-only — see this file's own header. `RuleRow` should
      // never mount this component for an operand/value shape that lands
      // here.
      setLoadError("This rule can't be edited here.");
      return;
    }
    setOperand(catalogueEntry);
    setOp(result.rule.op);
    setValue(numericValue);
    setVersion(result.rule.currentVersion);
  }

  useEffect(() => {
    let cancelled = false;
    withTimeout(fetchRuleForEdit(rule.ruleId), ACTION_TIMEOUT_MS)
      .then((result) => {
        if (cancelled) return;
        applyFetchResult(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(messageForCaughtError(err));
      })
      .finally(() => {
        if (!cancelled) setPhase((p) => (p === 'loading' ? 'ready' : p));
      });
    return () => {
      cancelled = true;
    };
  }, [rule.ruleId]);

  // The trader-facing "Refresh" action (see `EditableSentence`'s own
  // `onRefresh` prop below) — invoked ONLY from a JSX `onClick`, an event
  // handler, not an effect, so `react-hooks/set-state-in-effect` does not
  // apply here: safe to reset state synchronously and to await directly.
  async function handleRefresh() {
    setPhase('loading');
    setLoadError(null);
    setSubmitError(null);
    setConflict(false);
    try {
      const result = await withTimeout(fetchRuleForEdit(rule.ruleId), ACTION_TIMEOUT_MS);
      if (!mountedRef.current) return;
      applyFetchResult(result);
    } catch (err) {
      if (!mountedRef.current) return;
      setLoadError(messageForCaughtError(err));
    } finally {
      if (mountedRef.current) setPhase((p) => (p === 'loading' ? 'ready' : p));
    }
  }

  if (phase === 'loading') {
    return (
      <div className="rq-well" role="status" aria-busy="true">
        <p className="rq-sub">Loading…</p>
      </div>
    );
  }

  if (loadError || !operand || !op || version === null) {
    return (
      <div className="rq-well flex flex-col gap-2">
        <p className="rq-sub" role="alert">
          {loadError ?? "We couldn't load this rule."}
        </p>
        <button type="button" className="rq-btn rq-btn--ghost" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  const isNumeric = operand.type === 'number' || operand.type === 'duration' || operand.type === 'rating';
  if (!isNumeric || !operand.bounds) {
    // Defensive-only — see this file's own header.
    return (
      <div className="rq-well flex flex-col gap-2">
        <p className="rq-sub">This rule type can&apos;t be edited here yet.</p>
        <button type="button" className="rq-btn rq-btn--ghost" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  return (
    <EditableSentence
      operand={operand}
      op={op}
      value={value}
      onValueChange={setValue}
      submitting={phase === 'submitting'}
      submitError={submitError}
      conflict={conflict}
      onRefresh={handleRefresh}
      onCancel={onCancel}
      onSubmit={async () => {
        setSubmitError(null);
        setConflict(false);
        setPhase('submitting');
        try {
          // `version` is the snapshot THIS edit control opened against
          // (or was last refreshed to) — sent as `expectedVersion`, never
          // re-derived here at submit time. See this file's own header
          // comment for why that distinction is the entire fix.
          const result = await withTimeout(editRule(rule.ruleId, version, value), ACTION_TIMEOUT_MS);
          if (result.success && result.rule) {
            onSaved({ rendered: result.rule.rendered, version: result.rule.version });
            return;
          }
          if (result.error?.code === 'RULE_EDIT_CONFLICT') {
            setConflict(true);
          }
          setSubmitError(result.error?.user_message ?? 'Something went wrong saving this change. Please try again.');
          setPhase('ready');
        } catch (err) {
          setSubmitError(messageForCaughtError(err));
          setPhase('ready');
        }
      }}
    />
  );
}

/**
 * One rule's sentence + (always, this component only ever mounts for a
 * bounded numeric type) stepper + live preview + save/cancel — §6.1's
 * `.rule-editor` section, same adaptation `RuleSentenceEditor`
 * (`new/RuleEditor.tsx`) already established: the full rendered sentence
 * as static text above a real `.rq-step` control.
 */
function EditableSentence({
  operand,
  op,
  value,
  onValueChange,
  submitting,
  submitError,
  conflict,
  onRefresh,
  onCancel,
  onSubmit,
}: {
  operand: OperandCatalogueEntry;
  op: RuleOperator;
  value: number;
  onValueChange: (value: number) => void;
  submitting: boolean;
  submitError: string | null;
  conflict: boolean;
  onRefresh: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const bounds = operand.bounds;
  const sentence = useMemo(() => renderSentence(operand.id, op, value), [operand.id, op, value]);

  const [preview, setPreview] = useState<PreviewRuleActionState['preview'] | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const thisRequestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      withTimeout(previewRule({ operandId: operand.id, op, value }), ACTION_TIMEOUT_MS)
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
  }, [operand.id, op, value]);

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
    <section className="rule-editor rq-well flex flex-col gap-3" aria-labelledby={`edit-h-${operand.id}`}>
      <h3 id={`edit-h-${operand.id}`} className="sr-only">
        Edit {operand.label}
      </h3>

      <p className="rule-sentence rq-body">{sentence}</p>

      {bounds && (
        <div className="rq-step" role="group" aria-label={`${operand.label} threshold`}>
          <button type="button" className="rq-step__btn" aria-label="Decrease" disabled={submitting} onClick={() => step(-1)}>
            &minus;
          </button>
          <span className="rq-step__val rq-num" aria-live="polite">
            {displayValue}
            {operand.unit === 'percent' ? '%' : ''}
          </span>
          <button type="button" className="rq-step__btn" aria-label="Increase" disabled={submitting} onClick={() => step(1)}>
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

      {submitError && (
        <div className="flex flex-col gap-2">
          <p className="rq-sub" role="alert">
            {submitError}
          </p>
          {conflict && (
            // RULE_EDIT_CONFLICT-specific: "please refresh and try again"
            // needs an actual path forward, not just an alert with nowhere
            // to go. Re-runs `loadRuleData` in place, pre-filling this SAME
            // open control with the rule's now-current value and version.
            <button type="button" className="rq-btn rq-btn--ghost" disabled={submitting} onClick={onRefresh}>
              Refresh with the latest value
            </button>
          )}
        </div>
      )}

      <div className="rq-btn-row">
        <button type="button" className="rq-btn" disabled={submitting} onClick={onSubmit}>
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="rq-btn rq-btn--ghost" disabled={submitting} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
