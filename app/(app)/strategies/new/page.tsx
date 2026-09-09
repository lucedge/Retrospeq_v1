import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { canForUser } from '@/lib/entitlements/service';
import { fetchFieldPickerOptions } from '../actions';
import { StrategyBuilder } from './StrategyBuilder';

/**
 * Module 03 (Field Registry & Strategy) §5.1/§5.2/§6.1's strategy-creation
 * builder route. §1: "the entire strategy module is Pro" — this ENTIRE
 * route is gated, not just the save button: a free-plan visitor never sees
 * the builder at all, only a plain upgrade prompt, since `strategy.create`'s
 * own cap (free: 0, pro: null, `docs/adr/0018`) makes "build a strategy" a
 * pure plan exclusion, not a quota a free user could ever partially use.
 * This mirrors `rules/new/page.tsx`'s own structure (entitlement +
 * supporting data fetched server-side, the interactive builder handed to a
 * client component) but goes one step further by gating the WHOLE route,
 * since `rules.create`'s own free cap is a real, nonzero quota (3) that
 * still needs `RuleEditor.tsx`'s inline "at your limit" handling — there is
 * no equivalent "partially usable" state for a capability whose free cap is
 * unconditionally 0.
 */
export default async function NewStrategyPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const entitlement = await canForUser(user.id, 'strategy.create');
  if (!entitlement.allowed) {
    return (
      <section className="flex flex-col gap-4" aria-labelledby="strategy-gate-h">
        <h1 id="strategy-gate-h" className="rq-h1">
          Strategies are a Pro feature
        </h1>
        <p className="rq-body">
          A strategy is the setup you&apos;re trading — its trigger conditions and the fields you record against it.
          Upgrade to build one.
        </p>
        <Link href="/plan" className="rq-btn">
          Upgrade to Pro
        </Link>
      </section>
    );
  }

  const fieldsResult = await fetchFieldPickerOptions();

  return (
    <section className="flex flex-col gap-6" aria-labelledby="strategy-builder-h">
      <div className="flex flex-col gap-2">
        <h1 id="strategy-builder-h" className="rq-h1">
          Build a strategy
        </h1>
        <p className="rq-body">Name it, write what has to be true before you take it, and choose what to record.</p>
      </div>

      {fieldsResult.success ? (
        <StrategyBuilder fieldOptions={fieldsResult.fields ?? []} />
      ) : (
        <p className="rq-sub" role="alert">
          {fieldsResult.error?.user_message ?? 'Your fields are unavailable right now. Please try again.'}
        </p>
      )}
    </section>
  );
}
