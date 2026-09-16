import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { fetchCurrentStrategyForEdit } from '@/lib/fields/strategy-repository';
import { fetchFieldsForManagement, type ManagedFieldEntry } from '@/lib/fields/fields-repository';
import { getStrategyFieldFindings, type FieldFindingDisplay } from '@/lib/analytics/findings-service';
import type { FindingPayload } from '@/lib/analytics/findings-payload';

/**
 * Module 03 (Field Registry & Strategy) §5.1's fifth, last-unbuilt UI
 * element: "the strategy screen with per-field finding state." Fed by
 * Module 05 (Analytics & Findings) §5's `FindingPayload`
 * ("This module renders nothing. It supplies typed payloads") via
 * `lib/analytics/findings-service.ts`'s `getStrategyFieldFindings` — see
 * that file's own header for the read/canRender/render-logging pipeline
 * this page composes, and `lib/analytics/findings-payload.ts`'s header
 * for the statement-synthesis judgment calls (docs/adr/0035).
 *
 * SCOPE, deliberately narrowed, matching this repo's own established
 * "say so explicitly, don't half-build" precedent:
 *
 *   - No EDIT UI here (§4.6's versioning flow) — this is a read-only
 *     detail view. Editing an existing strategy's fields/triggers is a
 *     separate future slice, same posture `strategies/page.tsx`'s own
 *     header already establishes for strategy creation vs. edit.
 *   - No detections/pattern UI (§4.4-4.7's `DetectionPayload` shape) —
 *     findings only. `getStrategyFieldFindings` never touches
 *     `retrospeq.detections`.
 *   - No Module 06 weekly-review UI (Phase 4, not started) — this is
 *     the "pull it yourself" strategy screen §6.1 of Module 05 names as
 *     one of findings' two consumers, not the other (weekly review).
 *
 * OWNERSHIP: a strategy id that is not this user's own (or does not
 * exist) is a genuine 404 (`notFound()`), not a same-URL "not found"
 * message with a 200 status — this is a DIFFERENT posture from
 * `accounts/[id]/settings/page.tsx`'s own inline "we couldn't find
 * that account" render (a 200 with a friendly retry path, appropriate
 * for an account id a signed-in trader plausibly typo'd or an account
 * they just disconnected). A strategy id is never user-typed or
 * bookmarked in the same way; reaching this route with someone else's
 * (or a stale/deleted) id is either a direct URL-guessing attempt or a
 * genuinely broken link, and `fetchCurrentStrategyForEdit`'s own RLS +
 * explicit `user_id` filter already makes it indistinguishable from
 * "does not exist" either way (no enumeration signal either path could
 * leak) — a real 404 is the honest, unambiguous response for both.
 */
export default async function StrategyDetailPage(props: PageProps<'/strategies/[id]'>) {
  const { id } = await props.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to
  // /login before this page renders — same defensive fallback every
  // other page in this app tree uses.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const strategy = await fetchCurrentStrategyForEdit(user.id, id);
  if (!strategy) {
    notFound();
  }

  const orderedFields = [...strategy.fields].sort((a, b) => a.order - b.order);
  const orderedTriggers = [...strategy.triggers].sort((a, b) => a.order - b.order);

  const allFields = await fetchFieldsForManagement(user.id);
  const fieldById = new Map<string, ManagedFieldEntry>(allFields.map((f) => [f.fieldId, f]));

  // A field id the strategy's current version references but that no
  // longer resolves (hard-deleted by its owner — `fields_owner_delete`,
  // per `findings` migration's own comment; archived fields DO still
  // resolve here since `fetchFieldsForManagement` reads every state) is
  // silently excluded — nothing left to label it with, and the strategy
  // screen has no dependents-style blocking dialog to show for a field
  // that is already gone.
  const resolvedFields = orderedFields
    .map((f) => fieldById.get(f.fieldId))
    .filter((f): f is ManagedFieldEntry => f !== undefined);

  // §4.2: "note | Never segmented" — a note-typed field has no finding
  // state at all, ever; excluded from the roster this screen shows
  // (matching `getStrategyFieldFindings`'s own identical filter).
  const segmentableFields = resolvedFields.filter((f) => f.dataType !== 'note');

  let fieldFindings: FieldFindingDisplay[] = [];
  let findingsUnavailable = false;
  if (segmentableFields.length > 0) {
    try {
      fieldFindings = await getStrategyFieldFindings(
        user.id,
        strategy.strategyId,
        segmentableFields.map((f) => ({ fieldId: f.fieldId, name: f.name, dataType: f.dataType, config: { unit: f.config.unit } })),
      );
    } catch (err) {
      console.error('[strategies/[id]/page] getStrategyFieldFindings failed:', err);
      findingsUnavailable = true;
    }
  }

  // Frame 3.16 shows a `.finding` card under the per-field list. Its
  // example strategy has exactly one cleared result, so the frame shows
  // one; the rule is "every result that cleared its gates gets its
  // statement read in full", not "pick a winner" — an insufficient or
  // null-result row is stated in the list above and never promoted into a
  // headline it hasn't earned.
  const clearedFindings = fieldFindings.filter(
    (f) => f.payload.confidence === 'confident' || f.payload.confidence === 'provisional',
  );

  return (
    /* UI phase batch 3 (2026-09-16), inventory row 3.16 — frame
       `brand/docs/screens/rulebook.html#3.16`. No Rulebook pills here:
       every detail frame in that file drops them (a strategy is not a
       fourth destination). */
    <section className="strategy flex flex-col gap-5" aria-labelledby="strategy-h">
      <div className="flex items-baseline justify-between gap-3">
        <h1 id="strategy-h" className="rq-h1">
          {strategy.name}
        </h1>
        {strategy.state === 'archived' ? (
          <span className="rq-tag rq-tag--muted">Archived</span>
        ) : (
          <span className="rq-tag rq-tag--on rq-num">v{strategy.currentVersion}</span>
        )}
      </div>
      <p className="rq-sub">
        <span className="rq-num">{orderedTriggers.length}</span>{' '}
        {orderedTriggers.length === 1 ? 'condition' : 'conditions'} ·{' '}
        <span className="rq-num">{orderedFields.length}</span> {orderedFields.length === 1 ? 'field' : 'fields'}
      </p>

      {orderedTriggers.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="triggers-h">
          <h2 id="triggers-h" className="rq-h2" style={{ fontSize: '16px' }}>
            When this setup exists
          </h2>
          <ul className="flex flex-col gap-1">
            {orderedTriggers.map((t) => (
              <li key={t.conditionId} className="rq-sub">
                {t.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="strategy-state flex flex-col gap-2" aria-labelledby="state-h">
        <h2 id="state-h" className="rq-h2" style={{ fontSize: '16px' }}>
          What this strategy is teaching you
        </h2>

        {findingsUnavailable && (
          <p className="rq-sub" role="alert">
            Findings are unavailable right now. Please try again later.
          </p>
        )}

        {!findingsUnavailable && segmentableFields.length === 0 && (
          <p className="rq-sub">
            {resolvedFields.length === 0
              ? "This strategy doesn't capture any fields yet."
              : 'Every field this strategy captures is a free-text note — notes are never analysed for patterns.'}
          </p>
        )}

        {/* Frame 3.16: one `.field-state` row per field — name, the
            finding at a glance, its meta. Insufficient and null-result
            are first-class rows, not silence. The full `.finding`
            statement for the STRONGEST result follows below the list,
            exactly as the frame does it: the list is the scan, the
            finding card is the read. */}
        {!findingsUnavailable && segmentableFields.length > 0 && (
          <ul className="field-states">
            {fieldFindings.map((fs) => (
              <li key={fs.fieldId} className="field-state" data-state={confidenceAttr(fs.payload.confidence)}>
                <h3 className="field-state__name">{fs.fieldName}</h3>
                <p className="field-state__finding">
                  <FieldStateValue payload={fs.payload} />
                </p>
                <p className="field-state__meta">
                  <FindingMetaText payload={fs.payload} />
                </p>
              </li>
            ))}
          </ul>
        )}

        {!findingsUnavailable &&
          clearedFindings.map((f) => <FindingCard key={f.fieldId} payload={f.payload} />)}
      </section>

      {/* Frame 3.16's bottom-pinned, deliberately non-primary CTA: this
          screen is for reading, and editing a strategy creates a new
          version — not the action to make loudest. */}
      <div className="push pt-2">
        <Link href="/strategies" className="rq-btn rq-btn--ghost rq-btn--block">
          Back to strategies
        </Link>
      </div>
    </section>
  );
}

/**
 * The compact value in a `.field-state__finding` cell.
 *
 * Frame 3.16 shows a RATE PAIR here ("71% vs 42%"). `FindingPayload`
 * carries no rates — only `n`, `remaining`, and `evidence`, which is a
 * pair of SAMPLE descriptions ("4–5 (14 trades)" / "30 other trades"),
 * not percentages. Rendering `evidence` in this cell (the first attempt,
 * caught by looking at the screenshot) put a two-line sample description
 * where a number belongs and still showed no rate. So this cell states
 * the OUTCOME in the same vocabulary the null-result row uses, and the
 * real percentages stay where the analytics layer actually authored them
 * — the `.finding__statement` card below. Inventory row 3.16 names the
 * missing rate pair as the gap; nothing here computes a number the
 * analytics layer didn't.
 */
function FieldStateValue({ payload }: { payload: FindingPayload }) {
  if (payload.confidence === 'insufficient') return <>Not enough data</>;
  if (payload.confidence === 'null_result') return <>No difference detected</>;
  return <>Difference detected</>;
}

/** Module 05 §5.1's own `.finding[data-confidence]` reference markup,
 *  mapped 1:1 onto a real `FindingPayload` — `data-confidence`'s own
 *  three named spec values use a hyphen (`null-result`) where the
 *  payload's `confidence` union uses an underscore (`null_result`,
 *  matching the DB `confidence` check constraint); `provisional` has no
 *  hyphen either way, so it passes through unchanged. See
 *  `findings-payload.ts`'s own header for why `provisional` reuses
 *  `confident`'s CSS bucket. */
function confidenceAttr(confidence: FindingPayload['confidence']): string {
  return confidence === 'null_result' ? 'null-result' : confidence;
}

function FindingCard({ payload }: { payload: FindingPayload }) {
  return (
    <div className="finding" data-confidence={confidenceAttr(payload.confidence)} data-analytic={payload.analytic_id}>
      <p className="finding__statement">{payload.statement}</p>
      <FindingMeta payload={payload} />
    </div>
  );
}

/**
 * `.finding__meta` — a short structured fact line (not prose), so the
 * one real number in it gets `.rq-num` the same way this repo's other
 * structured stat lines do (e.g. `dashboard/page.tsx`'s own
 * `<span className="rq-num">{count}</span> position{...} open.`).
 * `.finding__statement` above does NOT get the same per-number wrapping
 * — a deliberate, narrower reading of AGENTS.md's "`.rq-num` on every
 * number, no exceptions" rule, documented in docs/adr/0035: `statement`
 * is a single server-authored natural-language sentence (matching §5's
 * own type, `statement: string`, and its own reference markup, which
 * shows plain numeric text with no `<span>` wrapping at all), not a
 * discrete numeric UI value the way every other `.rq-num` use in this
 * codebase is — the same distinction this file's own design system
 * already draws elsewhere (`.hook__statement`/`.dash__sub` prose lines
 * carry no `.rq-num` wrapping either, only `.dash__headline`'s isolated
 * interpolated count does).
 */
function FindingMeta({ payload }: { payload: FindingPayload }) {
  return (
    <p className="finding__meta">
      <FindingMetaText payload={payload} />
    </p>
  );
}

/** The same fact line without its wrapper, so `.field-state__meta` and
 *  `.finding__meta` can't drift apart. */
function FindingMetaText({ payload }: { payload: FindingPayload }) {
  if (payload.confidence === 'insufficient') {
    const remaining = payload.remaining ?? 0;
    if (remaining <= 0) {
      return <>More trades needed</>;
    }
    return (
      <>
        <span className="rq-num">{remaining}</span> more {remaining === 1 ? 'trade' : 'trades'}
      </>
    );
  }

  if (payload.confidence === 'null_result') {
    return (
      <>
        <span className="rq-num">{payload.n}</span> {payload.n === 1 ? 'trade' : 'trades'}
      </>
    );
  }

  return (
    <>
      <span className="rq-num">{payload.n}</span> {payload.n === 1 ? 'trade' : 'trades'} · {payload.confidence}
    </>
  );
}
