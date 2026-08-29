'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Decimal } from 'decimal.js';
import type { GuidedRuleSeed } from '@/lib/rules/guided-front-door';
import { renderSentence } from '@/lib/rules/render-sentence';
import { createRule, previewRule, type PreviewRuleActionState } from '../actions';

/**
 * Module 04 §5.10 / §6.1's guided front door, client half. The Server
 * Component (`page.tsx`) does the read-only seeding
 * (`seedGuidedRuleThresholds`) and entitlement check; this component owns
 * ALL of the interactive state: each card's current stepper value, its
 * debounced live preview, per-card selection, and the actual write
 * (`createRule`, the SAME Server Action the future general rule editor
 * will call — no parallel write path invented for this screen).
 *
 * DESIGN-SYSTEM CHOICES, documented (per this slice's own dispatch):
 *
 * - Stepper only, no native `<input type="range">` — §6.1's own reference
 *   markup pairs a stepper with a range slider, but that markup is
 *   EXPLICITLY illustrative (this file's own dispatch: "reuse its
 *   structure/classes ... even though this screen shows three at once"),
 *   and `retrospeq-design-system/brand/css/components.css` only ever
 *   styles `.rq-step`/`.rq-step__btn`/`.rq-step__val` — there is no
 *   `.rq-slider` primitive anywhere in the real, shipped design system.
 *   Adding an unstyled native range input would both look out of place
 *   and duplicate the stepper's own job. The stepper alone already
 *   satisfies the real constraint the README states this markup exists
 *   to satisfy ("Nothing on a fast-capture screen may require a
 *   keyboard").
 * - "Add" vs "Skip" is a genuine `.rq-btn--equal` pair, not a primary +
 *   secondary pair. Per this slice's own dispatch and the design system's
 *   own ethics rule ("the relaxation prompt must not imply a
 *   recommendation"): whether a brand-new trader adopts these three
 *   guided rules is exactly the kind of choice this product has no
 *   business nudging one way on — soft rules helping a trader see their
 *   own behaviour is genuinely optional, and "declining entirely" (story
 *   1.4's own acceptance: "A trader can accept all three, some, or
 *   decline entirely") must read as equally legitimate, not a dismissed
 *   secondary action under a highlighted primary "Add" button. There is
 *   deliberately NO plain `.rq-btn` (the single-primary-per-view accent
 *   button) anywhere on the CHOOSING screen for exactly this reason — it
 *   only appears once on the DONE/SKIPPED confirmation state, where there
 *   is no longer a decision being weighed, only a single onward step.
 * - Per-card inclusion is a `.rq-pill` toggle (on/off), not a checkbox —
 *   matches this repo's own established pick-one/pick-many primitive
 *   (`ManualEntryForm.tsx`'s direction pills) rather than a native
 *   checkbox input, and keeps every control on this screen tap-driven.
 */

const OP = 'lte' as const;

interface EntitlementSummary {
  allowed: boolean;
  limit: number | null;
  used: number;
  usageFraction: string;
}

interface CardState {
  seed: GuidedRuleSeed;
  selected: boolean;
  value: number;
  added: boolean;
  addedRendered: string | null;
  error: string | null;
}

function initialCardState(seed: GuidedRuleSeed): CardState {
  return {
    seed,
    selected: !seed.alreadyGoverned,
    value: seed.seedValue,
    added: false,
    addedRendered: null,
    error: null,
  };
}

function countDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/** Debounce window for the live preview call — 350ms sits comfortably
 *  above 00-foundation §8's own p95 API latency budget (400ms) so a
 *  single settled stepper tap reliably produces exactly one round trip,
 *  not a race of several, while still reading as "live" per story 1.2. */
const PREVIEW_DEBOUNCE_MS = 350;

export function GuidedFrontDoor({
  seeds,
  entitlement,
}: {
  seeds: GuidedRuleSeed[];
  entitlement: EntitlementSummary;
}) {
  const [cards, setCards] = useState<CardState[]>(() => seeds.map(initialCardState));
  const [phase, setPhase] = useState<'choosing' | 'submitting' | 'done' | 'skipped'>('choosing');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectedCount = cards.filter((c) => c.selected && !c.added).length;
  const addedCount = cards.filter((c) => c.added).length;
  const offerableCount = cards.filter((c) => !c.seed.alreadyGoverned).length;
  const anyGovernedAlready = cards.some((c) => c.seed.alreadyGoverned);

  function updateValue(operandId: string, value: number) {
    setCards((prev) => prev.map((c) => (c.seed.operandId === operandId ? { ...c, value } : c)));
  }

  function toggleSelected(operandId: string) {
    setCards((prev) =>
      prev.map((c) => (c.seed.operandId === operandId && !c.seed.alreadyGoverned ? { ...c, selected: !c.selected } : c)),
    );
  }

  async function handleAddSelected() {
    setSubmitError(null);
    setPhase('submitting');

    // Sequential, not Promise.all — each createRule call re-checks the
    // real rules.create entitlement server-side (defense in depth this
    // screen must not race against itself: adding three at once could
    // otherwise let all three read "1 of 3 used" simultaneously and all
    // three succeed past a 3-rule cap that should have stopped the
    // third). One rule at a time also means a rejection on one operand
    // (e.g. ENTITLEMENT_LIMIT) never prevents the others from still being
    // tried — "accept some" must work even when the failure happens
    // mid-submission, not just when chosen up front.
    let anySucceeded = false;
    let anyFailed = false;
    for (const card of cards) {
      if (!card.selected || card.added || card.seed.alreadyGoverned) continue;
      const result = await createRule({ operandId: card.seed.operandId, op: OP, value: card.value, scope: 'global' });
      if (result.success && result.rule) {
        anySucceeded = true;
        setCards((prev) =>
          prev.map((c) =>
            c.seed.operandId === card.seed.operandId
              ? { ...c, added: true, addedRendered: result.rule!.rendered, error: null }
              : c,
          ),
        );
      } else {
        anyFailed = true;
        const message = result.error?.user_message ?? 'Something went wrong saving this rule. Please try again.';
        setCards((prev) => prev.map((c) => (c.seed.operandId === card.seed.operandId ? { ...c, error: message } : c)));
      }
    }

    if (anyFailed && !anySucceeded) {
      setSubmitError("None of your selected rules could be saved — see each card above for what went wrong.");
      setPhase('choosing');
      return;
    }
    setPhase('done');
  }

  function handleSkip() {
    // §5.9's own "Later" precedent (GroupingChip.tsx): a real, honest
    // no-op. There is nothing to persist for declining a rule nobody
    // authored — no `rules` row, no dismissal record anywhere.
    setPhase('skipped');
  }

  if (phase === 'done' || phase === 'skipped') {
    return (
      <section className="flex flex-col gap-4" role="status">
        <h2 className="rq-h2">{phase === 'done' ? 'Your rulebook is started' : 'No rules added'}</h2>
        {phase === 'done' ? (
          <ul className="flex flex-col gap-2">
            {cards
              .filter((c) => c.added)
              .map((c) => (
                <li key={c.seed.operandId} className="rq-row">
                  <span className="rq-body">{c.addedRendered}</span>
                  <span className="rq-tag rq-tag--muted">Starts soft</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="rq-body">
            That&apos;s fine — you can come back and add rules whenever you&apos;re ready.
          </p>
        )}
        <Link href="/trades" className="rq-btn rq-btn--block">
          Go to your trades
        </Link>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {anyGovernedAlready && (
        <p className="rq-sub">
          One or more of these already has a rule in your rulebook — shown below, not offered
          again.
        </p>
      )}
      {entitlement.limit !== null && (
        <p className="rq-sub">
          Rule slots: <span className="rq-num">{entitlement.usageFraction}</span> used.
        </p>
      )}
      {!entitlement.allowed && (
        <p className="rq-sub" role="alert">
          You&apos;re already at your rule limit, so none of these can be added right now. You can
          still skip, or free up a slot first.
        </p>
      )}
      {submitError && (
        <p className="rq-sub" role="alert">
          {submitError}
        </p>
      )}

      <ul className="flex flex-col gap-4">
        {cards.map((card) => (
          <GuidedRuleCard
            key={card.seed.operandId}
            card={card}
            disabled={phase === 'submitting'}
            onValueChange={(v) => updateValue(card.seed.operandId, v)}
            onToggleSelected={() => toggleSelected(card.seed.operandId)}
          />
        ))}
      </ul>

      <div className="rq-btn-row">
        <button
          type="button"
          className="rq-btn rq-btn--equal"
          disabled={phase === 'submitting' || !entitlement.allowed || selectedCount === 0}
          onClick={handleAddSelected}
        >
          {phase === 'submitting'
            ? 'Adding…'
            : offerableCount === 0
              ? 'Nothing to add'
              : selectedCount === offerableCount && offerableCount === 3
                ? 'Add all three'
                : `Add ${selectedCount} selected`}
        </button>
        <button type="button" className="rq-btn rq-btn--equal" disabled={phase === 'submitting'} onClick={handleSkip}>
          Skip for now
        </button>
      </div>
      {addedCount > 0 && (
        <p className="rq-sub" role="status">
          <span className="rq-num">{addedCount}</span> already saved.
        </p>
      )}
    </div>
  );
}

/**
 * One guided rule card — §6.1's `.rule-editor` reference markup, adapted:
 * sentence with the current value inline, a real `.rq-step` stepper (no
 * text input, no keyboard), a live read-only preview (`role="status"
 * aria-live="polite"`, matching the reference markup's own accessibility
 * contract exactly), the "Starts soft"/"Applies to all strategies" meta
 * chips, and an inclusion toggle.
 */
function GuidedRuleCard({
  card,
  disabled,
  onValueChange,
  onToggleSelected,
}: {
  card: CardState;
  disabled: boolean;
  onValueChange: (value: number) => void;
  onToggleSelected: () => void;
}) {
  const { seed } = card;
  const bounds = seed.operand.bounds;
  if (!bounds) {
    // Structurally unreachable — seedGuidedRuleThresholds already throws
    // before this component ever renders if a guided operand has no
    // bounds. Kept as a loud, typed guard rather than a silent crash on
    // `bounds.step` below, matching this repo's "never fake it" posture
    // even for a case that should be impossible by construction.
    throw new Error(`GuidedRuleCard: operand "${seed.operandId}" has no bounds — cannot render a stepper.`);
  }
  // Destructured into plain `number`s (never `OperandBounds | undefined`)
  // immediately after the guard above — TS's narrowing of an object-typed
  // `const` does not reliably survive into a `function`-declared closure
  // defined later in the same body (`step()` below), but three plain
  // `number` bindings have no such ambiguity.
  const { min: boundsMin, max: boundsMax, step: boundsStep } = bounds;

  const [preview, setPreview] = useState<PreviewRuleActionState['preview'] | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const sentence = useMemo(() => renderSentence(seed.operandId, OP, card.value), [seed.operandId, card.value]);
  const decimals = countDecimals(boundsStep);
  const displayValue = card.value.toFixed(decimals);

  const showInteractive = !seed.alreadyGoverned && !card.added;

  useEffect(() => {
    if (!showInteractive) return;
    const thisRequestId = ++requestIdRef.current;
    // Both `setState` calls below are deferred into the `setTimeout`
    // callback (not called synchronously in the effect body) —
    // `react-hooks/set-state-in-effect` flags synchronous setState calls
    // during an effect's own execution as a cascading-render risk; this
    // debounce timer is the intentional escape hatch that pattern exists
    // for; the initial `previewLoading` state (`useState(true)`, above)
    // already covers the very first render before this timer ever fires.
    const timer = setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      previewRule({ operandId: seed.operandId, op: OP, value: card.value })
        .then((result) => {
          if (requestIdRef.current !== thisRequestId) return; // a newer value superseded this request
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
  }, [seed.operandId, card.value, showInteractive]);

  function step(direction: 1 | -1) {
    const next = Decimal.max(
      boundsMin,
      Decimal.min(boundsMax, new Decimal(card.value).plus(new Decimal(boundsStep).times(direction))),
    ).toNumber();
    onValueChange(next);
  }

  return (
    <li>
      <section className="rule-editor rq-card flex flex-col gap-3" aria-labelledby={`guided-${seed.operandId}-h`}>
        <h2 id={`guided-${seed.operandId}-h`} className="sr-only">
          {seed.operand.label}
        </h2>

        {seed.alreadyGoverned ? (
          <>
            <p className="rq-body">{seed.existingRuleRendered}</p>
            <p className="rq-sub">Already in your rulebook — not offered again here.</p>
          </>
        ) : card.added ? (
          <>
            <p className="rq-body">{card.addedRendered}</p>
            <span className="rq-tag rq-tag--on">Added</span>
          </>
        ) : (
          <>
            <p className="rule-sentence rq-body">{sentence}</p>

            <div className="rq-step" role="group" aria-label={`${seed.operand.label} threshold`}>
              <button
                type="button"
                className="rq-step__btn"
                aria-label="Decrease"
                disabled={disabled}
                onClick={() => step(-1)}
              >
                −
              </button>
              <span className="rq-step__val rq-num" aria-live="polite">
                {displayValue}
                {seed.operand.unit === 'percent' ? '%' : ''}
              </span>
              <button
                type="button"
                className="rq-step__btn"
                aria-label="Increase"
                disabled={disabled}
                onClick={() => step(1)}
              >
                +
              </button>
            </div>

            <aside className="preview rq-well flex flex-col gap-1" role="status" aria-live="polite">
              {previewLoading ? (
                // A LOADING skeleton, deliberately distinct from
                // `insufficient_history`'s own real "not enough data
                // yet" copy below — a spinner is not the same claim as
                // "we checked and there isn't enough history."
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
              <p className="preview__disclaimer rq-sub">
                Preview only. Past trades are never scored against this rule.
              </p>
            </aside>

            <div className="rule-meta flex flex-wrap items-center gap-2">
              <span className="rq-tag rq-tag--muted">Starts soft</span>
              <span className="rq-tag rq-tag--muted">Applies to all strategies</span>
            </div>

            <button
              type="button"
              className={card.selected ? 'rq-pill on' : 'rq-pill'}
              role="switch"
              aria-checked={card.selected}
              disabled={disabled}
              onClick={onToggleSelected}
            >
              {card.selected ? 'Included' : 'Not included'}
            </button>

            {card.error && (
              <p className="rq-sub" role="alert">
                {card.error}
              </p>
            )}
          </>
        )}
      </section>
    </li>
  );
}
