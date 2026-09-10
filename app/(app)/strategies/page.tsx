import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { canForUser } from '@/lib/entitlements/service';
import { fieldCapWarningMessage } from '@/lib/fields/strategy-validation';
import { fetchStrategyList } from './actions';

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

  return (
    <section className="flex flex-col gap-6" aria-labelledby="strategies-h">
      <div className="flex items-center justify-between gap-3">
        <h1 id="strategies-h" className="rq-h1">
          Your strategies
        </h1>
        {/* Exactly one .rq-btn per view — this only renders when the
            bottom-of-page upgrade prompt below does NOT (both are gated on
            the same `entitlement.allowed` flip). */}
        {entitlement.allowed && (
          <Link href="/strategies/new" className="rq-btn">
            New strategy
          </Link>
        )}
      </div>

      {!listResult.success && (
        <p className="rq-sub" role="alert">
          {listResult.error?.user_message ?? 'Your strategies are unavailable right now.'}
        </p>
      )}

      {listResult.success && strategies.length === 0 && (
        <div className="rq-well flex flex-col gap-3">
          <p className="rq-body">
            {entitlement.allowed
              ? "You haven't built a strategy yet. A strategy is the setup you're trading — name it, list what has to be true before you take it, and choose what you want to record."
              : 'Strategies are a Pro feature. Define your setups, write trigger conditions, and see per-field findings once you upgrade.'}
          </p>
          {!entitlement.allowed && (
            <Link href="/plan" className="rq-btn">
              Upgrade to Pro
            </Link>
          )}
        </div>
      )}

      {listResult.success && strategies.length > 0 && (
        <ul className="flex flex-col gap-3">
          {strategies.map((s) => {
            // §4.8 — never blocking, so this is purely informational and
            // renders alongside the trigger/field counts above it, never
            // in place of them.
            const capWarning = fieldCapWarningMessage(s.capturedFieldCount);
            return (
              <li key={s.strategyId} className="rq-card flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="rq-h2">
                    <Link href={`/strategies/${s.strategyId}`}>{s.name}</Link>
                  </h2>
                  <span className={s.state === 'active' ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}>
                    {s.state === 'active' ? 'Active' : 'Archived'}
                  </span>
                </div>
                <p className="rq-sub">
                  <span className="rq-num">{s.triggerCount}</span> {s.triggerCount === 1 ? 'trigger condition' : 'trigger conditions'} ·{' '}
                  <span className="rq-num">{s.fieldCount}</span> {s.fieldCount === 1 ? 'field' : 'fields'}
                </p>
                {s.isDefault && <p className="rq-sub">Your default strategy.</p>}
                {capWarning && (
                  <aside className="rq-well" role="note">
                    <p className="rq-sub">{capWarning}</p>
                  </aside>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {listResult.success && strategies.length > 0 && !entitlement.allowed && (
        <aside className="rq-cost flex flex-col gap-3">
          <p className="rq-body">Upgrade to Pro to build another strategy or edit these.</p>
          <Link href="/plan" className="rq-btn">
            Upgrade to Pro
          </Link>
        </aside>
      )}
    </section>
  );
}
