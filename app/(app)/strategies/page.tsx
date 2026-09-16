import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { canForUser } from '@/lib/entitlements/service';
import { fieldCapWarningMessage } from '@/lib/fields/strategy-validation';
import { fetchStrategyList } from './actions';
import { RulebookSubnav } from '../AppShellNav';

/**
 * Module 03 (Field Registry & Strategy) §5.1's strategy list — the FIRST
 * real UI this module has ever shipped (every prior slice, 03a through
 * 03f, was backend-only; see `lib/fields/strategy-repository.ts`'s own
 * header). Scope, per this slice's own dispatch: strategy LIST + strategy
 * CREATION only. Strategy edit UI, promotion UI, and field-creation UI are
 * all separate future sub-slices.
 *
 * Each row's name now links to `/strategies/[id]` (2026-09-11) — §5.1's
 * fifth element, "the strategy screen with per-field finding state,"
 * added the same slice this link was wired in. See that route's own
 * header for the read/`canRender` pipeline it composes.
 *
 * §1: "the entire strategy module is Pro. Free users have one silent,
 * auto-created strategy with zero captured fields (Module 08)." Module 08
 * (onboarding) is not built in this repo yet, so a real free-plan user has
 * ZERO strategies today — that silent default doesn't exist to see. This
 * page still renders correctly for that case (an honest, Pro-upsell empty
 * state, §9's own `ENTITLEMENT_LIMIT` framing: "Specific upgrade path"),
 * and separately handles the (currently test-data-only) case of a
 * free-plan user who already owns strategies (e.g. seeded directly, or a
 * downgrade after Pro — §7.3's own integration-test line: "Downgrade to
 * free makes strategies read-only without data loss") by showing the list
 * read-only with an upgrade prompt rather than hiding it.
 *
 * `canForUser` called directly (not through a rate-limited Server Action)
 * — same posture `rules/new/page.tsx`/`rules/page.tsx` already establish
 * for a plain entitlement-resolution read with no table of its own to
 * throttle against.
 *
 * §4.8's field-cap warning, ONGOING surface (this was the one genuinely
 * outstanding UI gap for this module after fields management shipped —
 * see `strategy-repository.ts`'s own `StrategyListItem.capturedFieldCount`
 * doc comment for the full "why this is the right place" reasoning): each
 * already-SAVED strategy's row renders the same §4.8 warning copy
 * `StrategyBuilder.tsx`'s own in-progress builder shows while a trader is
 * still picking fields, via the identical shared `fieldCapWarningMessage`
 * (`strategy-validation.ts`) — one source of truth, two moments (WHILE
 * building vs. AFTER a strategy already exists and a trader is reviewing
 * their own rulebook of strategies). Never blocking, matching §4.8's own
 * "Never blocking" line — a plain `.rq-well role="note"` aside, the same
 * device `StrategyBuilder.tsx`'s own `<aside className="rq-well"
 * role="note">` and `FieldsList.tsx`'s dependents well already use for a
 * non-alarming informational note in this module.
 */
export default async function StrategiesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback every other page in
  // this app tree uses.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const [entitlement, listResult] = await Promise.all([canForUser(user.id, 'strategy.create'), fetchStrategyList()]);

  const strategies = listResult.success ? (listResult.strategies ?? []) : [];

  // UI phase batch 3 (2026-09-16), inventory row 3.12 — frames
  // `brand/docs/screens/rulebook.html#3.12` (list) and `#3.13` (free
  // gate). The gate is a `.gate` block ABOVE the list, never instead of
  // it: "a quantity cap, not a capability cap" (frame 3.13's own caption)
  // — a free trader still sees their default strategy and what it records.
  return (
    <section className="strategies flex flex-col gap-5" aria-labelledby="strategies-h">
      <h1 id="strategies-h" className="rq-h1">
        Strategies
      </h1>
      <RulebookSubnav />

      {!listResult.success && (
        <p className="rq-sub" role="alert">
          {listResult.error?.user_message ?? 'Your strategies are unavailable right now.'}
        </p>
      )}

      {listResult.success && !entitlement.allowed && (
        <div className="gate">
          <p>Strategies are a Pro feature.</p>
          <p className="hint">
            A strategy is the setup you&apos;re trading — its trigger conditions and the fields you record against it.
            Findings come from those fields.
          </p>
          <Link href="/plan" className="rq-btn">
            See Pro
          </Link>
        </div>
      )}

      {listResult.success && strategies.length === 0 && entitlement.allowed && (
        <p className="rq-sub">
          You haven&apos;t built a strategy yet. A strategy is the setup you&apos;re trading — name it, list what has to
          be true before you take it, and choose what you want to record.
        </p>
      )}

      {listResult.success && strategies.length > 0 && (
        <ul className="flex flex-col gap-3">
          {strategies.map((s) => {
            // §4.8 — never blocking, so this is purely informational and
            // renders alongside the trigger/field counts above it, never
            // in place of them.
            const capWarning = fieldCapWarningMessage(s.capturedFieldCount);
            return (
              <li key={s.strategyId}>
                <article className="rq-card flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <Link href={`/strategies/${s.strategyId}`} className="rq-body font-bold tracking-tight">
                      {s.name}
                    </Link>
                    {/* Frame 3.12 puts the CURRENT VERSION here for a
                        built strategy and "default" for the silent one —
                        the version is the fact that tells a trader
                        whether they've revised this setup. `Archived` is
                        still surfaced (it outranks both) because a list
                        that hides it would be lying about the state. */}
                    {s.state === 'archived' ? (
                      <span className="rq-tag rq-tag--muted">Archived</span>
                    ) : s.isDefault ? (
                      <span className="rq-tag rq-tag--muted">default</span>
                    ) : (
                      <span className="rq-tag rq-tag--on rq-num">v{s.currentVersion}</span>
                    )}
                  </div>
                  <p className="rq-sub">
                    <span className="rq-num">{s.triggerCount}</span>{' '}
                    {s.triggerCount === 1 ? 'condition' : 'conditions'} ·{' '}
                    {s.fieldCount === 0 ? (
                      'no fields · derived only'
                    ) : (
                      <>
                        <span className="rq-num">{s.fieldCount}</span> {s.fieldCount === 1 ? 'field' : 'fields'}
                      </>
                    )}
                  </p>
                  {capWarning && <p className="hint">{capWarning}</p>}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {/* Frame 3.12's bottom-pinned CTA. Only for a trader who can
          actually create one — the `.gate` above already carries the
          single `.rq-btn` for everyone else. */}
      {entitlement.allowed && (
        <div className="push pt-2">
          <Link href="/strategies/new" className="rq-btn rq-btn--block">
            New strategy
          </Link>
        </div>
      )}
    </section>
  );
}
