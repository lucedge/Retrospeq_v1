'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Decimal } from 'decimal.js';
import type { GuidedRuleSeed } from '@/lib/rules/guided-front-door';
import { createRule, previewRule, type PreviewRuleActionState } from '../actions';
import { completeGuidedRuleCalibration } from '../../onboarding/actions';

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
 * - Sentence + inline value + range (updated 2026-09-14, mockup fidelity
 *   slice, supersedes this file's own earlier note): the design program's
 *   batch 1 (`docs/screens/home-onboarding.html` #1.10/#1.11, `rulebook.html`
 *   #3.6) shipped real `.rule-value`/`.rq-range` CSS
 *   (`retrospeq-design-system/brand/css/components.css`) that did not exist
 *   when this file first chose stepper-only — that "no `.rq-slider`
 *   primitive exists" reasoning no longer holds for THIS screen and has
 *   been replaced by the mockup-matching markup below (sentence rendered
 *   with the current value as an inline `.rule-value.rq-step__val` button,
 *   a `.rq-range` row pairing the same `−`/`+` stepper buttons with a real
 *   `<input type="range">` bound to the same value/bounds/step). Nothing
 *   about this changes the "no keyboard required" guarantee — every
 *   control here is still pointer/tap-driven (buttons and a range thumb),
 *   never a text field. NOTE: `../new/RuleEditor.tsx` (the general rule
 *   editor) still carries the OLD "no range primitive" claim in its own
 *   header comment — out of this slice's scope (dispatch named only this
 *   file + `page.tsx`), flagged in this slice's ledger entry for whoever
 *   next touches that screen.
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

  // Module 08 (Onboarding & Home) §5.1/§5.3 -- Slice 08b's ONLY change to
  // this file: a minimal, additive completion signal, sequencing only.
  // Neither the seeding, preview, entitlement, nor create-rule mechanics
  // above are touched. "Accepted some/all" (phase 'done') and "declined
  // entirely" (phase 'skipped') are BOTH a legitimate, complete finish of
  // this step (§5.10/story 1.4) -- the fire-and-forget call below never
  // blocks or alters what the trader sees on either screen; a failure is
  // swallowed by `completeGuidedRuleCalibration` itself (best-effort, see
  // that file's own header). The ref guards against firing twice (React
  // Strict Mode's double-invoke, or any other re-render once `phase` is
  // already settled) -- deliberately a simple "fire once ever" boolean
  // latch, not a value-comparison ref, so it doesn't repeat the invocation-
  // count-ref bug Slice 10d part 1 already found and documented elsewhere
  // in this codebase.
  const onboardingNotifiedRef = useRef(false);
  useEffect(() => {
    if ((phase === 'done' || phase === 'skipped') && !onboardingNotifiedRef.current) {
      onboardingNotifiedRef.current = true;
      completeGuidedRuleCalibration().catch(() => {
        // Best-effort — see this component's own comment above.
      });
    }
  }, [phase]);

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

      <ol className="calibrate__list">
        {cards.map((card) => (
          <GuidedRuleCard
            key={card.seed.operandId}
            card={card}
            disabled={phase === 'submitting'}
            onValueChange={(v) => updateValue(card.seed.operandId, v)}
            onToggleSelected={() => toggleSelected(card.seed.operandId)}
          />
        ))}
      </ol>
      <p className="rq-sub">All start soft and apply to every strategy.</p>

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

/** Splits an operand's `{value}` phrasing template into the text before and
 *  after the blank, so the current value can be rendered as a real inline
 *  element (`.rule-value`) rather than substituted into a single opaque
 *  string — matching `home-onboarding.html` #1.10/#1.11 and `rulebook.html`
 *  #3.6's markup shape. Percent operands carry their own `%` INSIDE the
 *  value chip (mockup: `<button class="rule-value">1.5%</button>`) rather
 *  than as trailing sentence text, so a literal `%` immediately after the
 *  placeholder in the template is stripped from the suffix here — it is
 *  re-added to the button's own text below instead, never shown twice. */
function splitSentenceAroundValue(template: string, unit: string): { prefix: string; suffix: string } {
  const PLACEHOLDER = '{value}';
  const idx = template.indexOf(PLACEHOLDER);
  if (idx === -1) {
    // Structurally unreachable for the three guided operands — each has an
    // `lte` phrasing entry with a bare `{value}` placeholder
    // (`operand-catalogue.ts`). Loud guard rather than a silently
    // malformed sentence.
    throw new Error(`splitSentenceAroundValue: phrasing template "${template}" has no {value} placeholder.`);
  }
  const prefix = template.slice(0, idx);
  let suffix = template.slice(idx + PLACEHOLDER.length);
  if (unit === 'percent' && suffix.startsWith('%')) {
    suffix = suffix.slice(1);
  }
  return { prefix, suffix };
}

/** Categorises an already-computed flagged ratio (`PreviewResult.ratio`,
 *  present only when `state === 'flagged'`) into the design system's own
 *  `preview__guidance[data-band]` CSS hook — boundary-for-boundary the same
 *  table `lib/rules/preview.ts`'s own `guidanceForRatio` already encodes in
 *  its guidance TEXT (§5.8: `0`, `> 0.35`, `< 0.06`, else). Purely a display
 *  categorisation of a number the server already returned — not a second
 *  copy of any rule/evaluation logic. If that table's boundaries ever move,
 *  this is the one place on this screen that needs to move with it. */
function bandForRatio(ratio: number): 'never' | 'tight' | 'healthy' | 'loose' {
  if (ratio === 0) return 'never';
  if (ratio > 0.35) return 'loose';
  if (ratio < 0.06) return 'tight';
  return 'healthy';
}

/**
 * One guided rule card — Module 08 §5.3 / Module 04 §6.1's `.rule-editor`
 * reference markup, matching `home-onboarding.html` #1.10/#1.11 and
 * `rulebook.html` #3.6: the sentence with its current value inline as a
 * `.rule-value` chip, a `.rq-range` row (the same stepper buttons paired
 * with a real range slider, both bound to the identical value/bounds/step
 * — no text input, no keyboard), a live read-only preview (`role="status"
 * aria-live="polite"`), and an inclusion switch.
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
  const rangeInputRef = useRef<HTMLInputElement>(null);

  const decimals = countDecimals(boundsStep);
  const displayValue = card.value.toFixed(decimals);
  const displayValueWithUnit = `${displayValue}${seed.operand.unit === 'percent' ? '%' : ''}`;

  // `OP` is `'lte'` for every guided operand (this file's own constant) —
  // each of the three has an `lte` phrasing entry with exactly one
  // `{value}` blank (`operand-catalogue.ts`), so this lookup and split are
  // safe for the whole guided set, not just risk_pct.
  const phrasingTemplate = seed.operand.phrasing[OP];
  if (!phrasingTemplate) {
    // Structurally unreachable — same class of guard as the `bounds` check
    // above: a real drift bug between this screen's hardcoded operand list
    // and the catalogue, not a data-volume case.
    throw new Error(`GuidedRuleCard: operand "${seed.operandId}" has no "${OP}" phrasing template.`);
  }
  const { prefix, suffix } = splitSentenceAroundValue(phrasingTemplate, seed.operand.unit);

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
    <li className="calibrate__rule rule-editor" aria-labelledby={`guided-${seed.operandId}-h`}>
      <h2 id={`guided-${seed.operandId}-h`} className="sr-only">
        {seed.operand.label}
      </h2>

      {seed.alreadyGoverned ? (
        <>
          <p className="rule-sentence rq-body">{seed.existingRuleRendered}</p>
          <p className="rq-sub">Already in your rulebook — not offered again here.</p>
        </>
      ) : card.added ? (
        <>
          <p className="rule-sentence rq-body">{card.addedRendered}</p>
          <span className="rq-tag rq-tag--on">Added</span>
        </>
      ) : (
        <>
          <p className="rule-sentence">
            {prefix}
            <button
              type="button"
              className="rule-value rq-step__val rq-num"
              aria-live="polite"
              // A real, useful action (not a fake affordance): the
              // components.css source comment for `.rule-value` documents
              // its job as "a button that opens the stepper" — here, the
              // fine control (the range slider right below) is already
              // always visible, so "opens" becomes "focuses."
              onClick={() => rangeInputRef.current?.focus()}
            >
              {displayValueWithUnit}
            </button>
            {suffix}
          </p>

          <div className="rq-range" role="group" aria-label={`${seed.operand.label} threshold`}>
            <button
              type="button"
              className="rq-step__btn"
              aria-label="Decrease"
              disabled={disabled}
              onClick={() => step(-1)}
            >
              −
            </button>
            <input
              ref={rangeInputRef}
              type="range"
              min={boundsMin}
              max={boundsMax}
              step={boundsStep}
              value={card.value}
              disabled={disabled}
              aria-label={`${prefix}value${suffix}`}
              onChange={(e) => onValueChange(Number(e.target.value))}
            />
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

          <div className="preview" role="status" aria-live="polite">
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
                <p className="preview__lede rq-sub">
                  Against your last <span className="rq-num">{preview.n}</span> trades, this would have flagged
                </p>
                <p className="preview__count rq-num">{preview.flagged}</p>
                <p
                  className="preview__guidance rq-sub"
                  data-band={preview.ratio !== undefined ? bandForRatio(preview.ratio) : undefined}
                >
                  {preview.guidance}
                </p>
                {preview.calibration && <p className="preview__calibration rq-sub">{preview.calibration}</p>}
              </>
            ) : preview?.state === 'insufficient_history' ? (
              <>
                <p className="preview__lede rq-sub">No history yet</p>
                <p className="preview__guidance rq-sub">We&rsquo;ll refine this once you&rsquo;ve logged 20 trades.</p>
              </>
            ) : (
              // `operand_not_computable` (structurally unreachable for
              // these three guided operands, all distribution-backed — see
              // `guided-front-door.ts`'s own header) or the pre-first-load
              // instant: the server's own guidance text, honestly, never a
              // fabricated "No history yet" claim for a state that isn't
              // actually that.
              <p className="preview__guidance rq-sub">{preview?.guidance ?? 'Preview unavailable right now.'}</p>
            )}
            <p className="preview__disclaimer rq-sub">
              Preview only. Past trades are never scored against this rule.
            </p>
          </div>

          <button
            type="button"
            // `self-start`: `.calibrate__rule`'s `display:flex;
            // flex-direction:column` (like `.rule-editor`'s own layout
            // before it) stretches direct block-level flex children to
            // its own width by default -- without this, the pill fills
            // the whole card and reads exactly like the `.rq-btn--block`
            // it must NOT look like (this dispatch's own explicit
            // concern). `.rq-pill` elsewhere (e.g. the top `.rq-pills`
            // nav) never sits directly in a vertical flex column, so this
            // is scoped to this instance, not a `.rq-pill` source change.
            className={card.selected ? 'rq-pill on self-start' : 'rq-pill self-start'}
            role="switch"
            aria-checked={card.selected}
            disabled={disabled}
            onClick={onToggleSelected}
          >
            {card.selected ? 'Included' : 'Skip this one'}
          </button>

          {card.error && (
            <p className="rq-sub" role="alert">
              {card.error}
            </p>
          )}
        </>
      )}
    </li>
  );
}
