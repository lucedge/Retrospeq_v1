'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Decimal } from 'decimal.js';
import { getOperand, type OperandCatalogueEntry, type OperandGroup } from '@/lib/rules/operand-catalogue';
import { soleAuthorableOp } from '@/lib/rules/editable-operands';
import { renderSentence } from '@/lib/rules/render-sentence';
import { formatUsageFraction } from '@/lib/entitlements/messages';
import type { DiscoveryItem, DiscoveryResult } from '@/lib/review/discovery';
import { createRule, previewRule, type PreviewRuleActionState } from '../actions';
import { PreviewPanel, RuleValueControl } from '../RuleValueControl';

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
 * - NO operand-picker keyboard field on the CATALOGUE'S select itself. The
 *   operand chooser is a native `<select>` grouped by catalogue `group`
 *   via `<optgroup>` — this repo's own established precedent for "choose
 *   one of many named things" on a FORM screen (not a fast-capture
 *   pre-entry screen), e.g. `ManualEntryForm.tsx`'s account `<select>`.
 *   Story 1.1's "no operator dropdown anywhere" is about the COMPARISON
 *   OPERATOR (lte/gte/is_true/etc.), not which rule TYPE to author — and
 *   it is satisfied literally here: there is no operator control anywhere
 *   on this screen at all, because `lib/rules/editable-operands.ts` only
 *   ever offers operands with exactly one authorable operator, resolved
 *   automatically via `soleAuthorableOp`.
 * - DISCOVERY (Slice 10c, story 1.3, §6.1's `.discovery` reference markup,
 *   inventory row 3.10): a ranked list of this trader's OWN active
 *   detections (`lib/review/discovery.ts`, computed server-side) sits
 *   ABOVE the catalogue picker, each item a plain `.discovery__btn` list
 *   button (never `.rq-btn` — only one primary button per view, "Add
 *   rule"). Clicking one calls the SAME `handleSelectOperand` the
 *   catalogue's own `<select>` uses, pre-filling the stepper at the
 *   analytic's own resolved threshold (`DiscoveryItem.seedValue`) instead
 *   of the generic bounds midpoint — the identical "seed a real number
 *   from the trader's own history" posture `guided-front-door.ts`
 *   established, applied here to a detection-derived value instead of a
 *   distribution percentile. The full catalogue (grouped `<select>` +
 *   `<input type="search">`, §6.1's own markup) now sits behind a
 *   `<details class="catalogue"><summary>Browse all rule types</summary>`
 *   disclosure, collapsed by default — "the catalogue sits behind search
 *   for those who want it" (design-decisions.md, "Discovery, not
 *   browsing"). Search is a plain client-side label substring filter over
 *   the SAME `operandsByGroup` map, not a second data source — this is a
 *   FORM screen, so a keyboard here is allowed (unlike a fast-capture
 *   entry screen).
 * - Numeric/duration value: frames 3.7/3.8's own `.rq-range` — the value
 *   is the one blank IN the sentence (`.rule-value`), with a −/slider/+
 *   control underneath (`../RuleValueControl.tsx`, shared with the
 *   inline threshold edit on `/rules`). This replaces the standalone
 *   `.rq-step` stepper this file used to render above a static sentence;
 *   the old header claimed "no native range slider — that primitive does
 *   not exist in the shipped design system", which stopped being true
 *   when `.rq-range` shipped in the 2026-09-14 design program. No text
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
  // `field:<field_id>` operands (ADR 0046) are resolved per user, never
  // listed in the static catalogue this picker renders — the label exists
  // so the union stays exhaustive, and reads as the trader's own words
  // if a future screen does group them.
  field: 'Your own fields',
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

/** Rounds an arbitrary raw number to the operand's own `step`, clamped into
 *  `[min, max]` — shared by `boundsMidpointDefault` below and, since Slice
 *  10c, by a discovery item's own seeded value (already close to a valid
 *  step but not guaranteed to land on one exactly, e.g. a rounded-up
 *  minute count from `resolveDetectionRuleProposal`). */
function roundToBoundsStep(raw: number, bounds: { min: number; max: number; step: number }): number {
  const min = new Decimal(bounds.min);
  const step = new Decimal(bounds.step);
  const stepsFromMin = new Decimal(raw).minus(min).dividedBy(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const stepped = min.plus(stepsFromMin.times(step));
  return Decimal.max(bounds.min, Decimal.min(bounds.max, stepped)).toNumber();
}

/** Bounds-midpoint default — the same honest "middle of what this rule type
 *  even allows" fallback `guided-front-door.ts` uses when there is no
 *  history to seed from (that file's own function is `server-only` and
 *  cannot be imported into this client component, so this is a small,
 *  deliberate duplicate — same precedent as `GuidedFrontDoor.tsx`'s own
 *  inline `step()` function not importing from `guided-front-door.ts`
 *  either). This general editor does not attempt per-operand history-based
 *  seeding beyond this and a discovery item's own resolved threshold — the
 *  guided front door already covers the three operands where distribution-
 *  percentile seeding pays off (§5.10); building a second, general
 *  history-seeding pipeline for all ~20 offerable operands is out of this
 *  sub-slice's scope, and the live preview immediately tells the trader
 *  whether this starting number is even meaningful for their own history. */
function boundsMidpointDefault(bounds: { min: number; max: number; step: number }): number {
  const min = new Decimal(bounds.min);
  const max = new Decimal(bounds.max);
  return roundToBoundsStep(min.plus(max).dividedBy(2).toNumber(), bounds);
}

type Phase = 'editing' | 'submitting' | 'done';

export function RuleEditor({
  operandIds,
  discovery,
  entitlement: initialEntitlement,
}: {
  operandIds: string[];
  discovery: DiscoveryResult;
  entitlement: EntitlementSummary;
}) {
  const [phase, setPhase] = useState<Phase>('editing');
  const [selectedOperandId, setSelectedOperandId] = useState<string>('');
  const [value, setValue] = useState<number>(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [doneRendered, setDoneRendered] = useState<string | null>(null);
  // Slice 10c: plain client-side label filter over the catalogue's own
  // grouped list -- this is a FORM screen, not a fast-capture one, so a
  // keyboard here is allowed (see this file's own header). No second data
  // source; `operandsByGroup` below is filtered by substring match.
  const [catalogueSearch, setCatalogueSearch] = useState('');
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

  const filteredOperandsByGroup = useMemo(() => {
    const query = catalogueSearch.trim().toLowerCase();
    if (!query) return operandsByGroup;
    const filtered = new Map<OperandGroup, OperandCatalogueEntry[]>();
    for (const [group, operands] of operandsByGroup) {
      const matches = operands.filter((o) => o.label.toLowerCase().includes(query));
      if (matches.length > 0) filtered.set(group, matches);
    }
    return filtered;
  }, [operandsByGroup, catalogueSearch]);

  const selectedOperand = selectedOperandId ? getOperand(selectedOperandId) : undefined;

  /** Shared by the catalogue's own `<select>` (no `seedValue` -- falls back
   *  to the bounds midpoint, unchanged from before Slice 10c) and a
   *  discovery item's list button (`seedValue` set to the SAME threshold
   *  `resolveDetectionRuleProposal` would propose, see this file's own
   *  header). */
  function handleSelectOperand(operandId: string, seedValue?: number) {
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
    if (!operand.bounds) return;
    setValue(roundToBoundsStep(seedValue ?? boundsMidpointDefault(operand.bounds), operand.bounds));
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
    <div className="flex flex-1 flex-col gap-5">
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

      <DiscoverySection discovery={discovery} disabled={phase === 'submitting'} onSelect={handleSelectOperand} />

      <details className="catalogue">
        <summary>Browse all rule types</summary>
        <input
          type="search"
          placeholder="Search rules…"
          aria-label="Search rule types"
          value={catalogueSearch}
          onChange={(e) => setCatalogueSearch(e.target.value)}
        />
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
            {[...filteredOperandsByGroup.entries()].map(([group, operands]) => (
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
      </details>

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
 * §6.1's `.discovery` reference markup, inventory row 3.10 — Slice 10c,
 * story 1.3: "Discovery leads with ranked detections; the catalogue sits
 * behind search." `discovery.items` arrives already ranked/filtered
 * server-side (`lib/review/discovery.ts` -- see that file's own header
 * for the ranking + filtering rules); this component only renders it.
 *
 * Each item is a plain `.discovery__btn` list button, deliberately NOT
 * `.rq-btn` (one `.rq-btn` per view -- "Add rule" -- is the only primary
 * action on this screen; a discovery item only PRE-SELECTS an operand, it
 * does not itself save anything). `.discovery__evidence` already carries
 * the design system's own mono/tabular-numeral styling; `rq-num` is added
 * alongside it anyway, matching this repo's own convention of marking
 * every numeric value explicitly rather than relying on a component class
 * alone (e.g. `.rq-step__val rq-num` elsewhere in this same file).
 *
 * EMPTY STATE ("Not enough data yet" is a correct state, not a bug,
 * AGENTS.md non-negotiable): zero items means either genuinely too little
 * trade history for any detection to have cleared its own volume/rate/
 * persistence gates, or every pattern that DID clear them already has a
 * rule, or maps to no operand this trader's own accounts can support
 * today -- this component cannot and does not distinguish those cases
 * (nor invent a reason), it just states the honest fact plainly. The
 * catalogue stays fully reachable below regardless (never gated on
 * discovery having anything to show).
 */
function DiscoverySection({
  discovery,
  disabled,
  onSelect,
}: {
  discovery: DiscoveryResult;
  disabled: boolean;
  onSelect: (operandId: string, seedValue?: number) => void;
}) {
  return (
    <section className="discovery" aria-labelledby="disc-h">
      <h2 id="disc-h" className="rq-h2" style={{ fontSize: '16px' }}>
        Based on your last {discovery.windowDays} days
      </h2>
      {discovery.items.length === 0 ? (
        <p className="rq-sub hint">
          Not enough data yet — keep logging trades and patterns from your own history will show
          up here.
        </p>
      ) : (
        <>
          <p className="hint rq-sub">You might want rules about:</p>
          <ul className="discovery__list">
            {discovery.items.map((item: DiscoveryItem) => (
              <li key={item.analyticId}>
                <button
                  type="button"
                  className="discovery__btn"
                  disabled={disabled}
                  onClick={() => onSelect(item.operandId, item.seedValue ?? undefined)}
                >
                  <span className="discovery__name">{item.label}</span>
                  <span className="discovery__evidence rq-num">{item.evidence}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
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
    /* Not a `.rq-card` any more: frame 3.7 lays the editor out flat on the
       screen — the sentence IS the page — and the card border was fencing
       it off from the discovery list above it. `flex-1` so the `.push`
       CTA at the bottom has free space to consume. */
    <section className="rule-editor flex flex-1 flex-col gap-4" aria-labelledby="re-h">
      <h2 id="re-h" className="sr-only">
        {operand.label}
      </h2>

      {/* Frames 3.7/3.8: a sentence with one blank, then the range.
          Shared with the inline threshold edit on `/rules` — see
          `../RuleValueControl.tsx`. A `bool` operand has no blank and no
          bounds; that component falls back to the plain sentence. */}
      {isNumeric && bounds ? (
        <RuleValueControl
          operand={operand}
          op={op}
          value={value}
          displayValue={displayValue}
          fallbackSentence={sentence}
          disabled={disabled}
          onStep={step}
          onSet={onValueChange}
          sentenceClassName="rule-sentence--lg"
        />
      ) : (
        <p className="rule-sentence rule-sentence--lg">{sentence}</p>
      )}

      <PreviewPanel preview={preview} loading={previewLoading} error={previewError} />

      {/* Frame 3.7's `.rule-meta`: the severity a new rule starts at is a
          tag; its coverage is quiet supporting text, not a second tag
          competing with it. */}
      <div className="rule-meta">
        <span className="rq-tag rq-tag--muted">Starts soft</span>
        <span className="rule-coverage">Applies to all strategies</span>
      </div>

      <div className="push">
        <button type="button" className="rq-btn rq-btn--block" disabled={disabled || !canSubmit} onClick={onSubmit}>
          {disabled ? 'Adding…' : 'Add rule'}
        </button>
      </div>
    </section>
  );
}
