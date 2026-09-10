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

  return (
    <section className="flex flex-col gap-6" aria-labelledby="strategy-h">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 id="strategy-h" className="rq-h1">
            {strategy.name}
          </h1>
          <p className="rq-sub">
            <span className="rq-num">{orderedTriggers.length}</span> {orderedTriggers.length === 1 ? 'trigger condition' : 'trigger conditions'} ·{' '}
            <span className="rq-num">{orderedFields.length}</span> {orderedFields.length === 1 ? 'field' : 'fields'}
            {strategy.state === 'archived' ? ' · Archived' : ''}
          </p>
        </div>
        <Link href="/strategies" className="rq-btn rq-btn--ghost">
          Back to strategies
        </Link>
      </div>

      {orderedTriggers.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="triggers-h">
          <h2 id="triggers-h" className="rq-h2">
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

      <section className="flex flex-col gap-3" aria-labelledby="state-h">
        <h2 id="state-h" className="rq-h2">
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
              : 'Every field this strategy captures is a free-text note — notes are never analyzed for patterns.'}
          </p>
        )}

        {!findingsUnavailable && segmentableFields.length > 0 && (
          <ul className="field-states flex flex-col gap-3">
            {fieldFindings.map((fs) => (
              <li key={fs.fieldId} className="rq-card flex flex-col gap-2">
                <p className="rq-body font-semibold">{fs.fieldName}</p>
                <FindingCard payload={fs.payload} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
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
  if (payload.confidence === 'insufficient') {
    const remaining = payload.remaining ?? 0;
    if (remaining <= 0) {
      return <p className="finding__meta">More trades needed.</p>;
    }
    return (
      <p className="finding__meta">
        <span className="rq-num">{remaining}</span> more {remaining === 1 ? 'trade' : 'trades'} on this setup.
      </p>
    );
  }

  if (payload.confidence === 'null_result') {
    return (
      <p className="finding__meta">
        <span className="rq-num">{payload.n}</span> {payload.n === 1 ? 'trade' : 'trades'}
      </p>
    );
  }

  return (
    <p className="finding__meta">
      <span className="rq-num">{payload.n}</span> {payload.n === 1 ? 'trade' : 'trades'} · {payload.confidence}
    </p>
  );
}
