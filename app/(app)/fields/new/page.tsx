import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { canForUser } from '@/lib/entitlements/service';
import { fetchStrategyOptionsForFieldCreate } from '../actions';
import { FieldCreateForm } from './FieldCreateForm';

/**
 * Module 03 (Field Registry & Strategy) §4.1/§4.3/§5.2's standalone field
 * CREATION route. §1: "the entire strategy module is Pro" — `fields.custom`
 * (free: 0, pro: null, docs/adr/0019) is a pure plan exclusion with no
 * partial quota, so this ENTIRE route is gated the same way
 * `strategies/new/page.tsx` gates its own identically-shaped
 * `strategy.create` capability: a free-plan visitor never sees the form at
 * all, only a plain upgrade prompt.
 */
export default async function NewFieldPage() {
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

  const entitlement = await canForUser(user.id, 'fields.custom');
  if (!entitlement.allowed) {
    return (
      <section className="flex flex-col gap-4" aria-labelledby="field-gate-h">
        <h1 id="field-gate-h" className="rq-h1">
          Custom fields are a Pro feature
        </h1>
        <p className="rq-body">
          Anything beyond what your broker already tells us — conviction, setup quality, anything else you want to
          learn from — is a Pro feature. Upgrade to add your own.
        </p>
        <Link href="/plan" className="rq-btn">
          Upgrade to Pro
        </Link>
      </section>
    );
  }

  const strategiesResult = await fetchStrategyOptionsForFieldCreate();

  return (
    <section className="flex flex-col gap-6" aria-labelledby="field-create-h">
      <div className="flex flex-col gap-2">
        <h1 id="field-create-h" className="rq-h1">
          Add a field
        </h1>
        <p className="rq-body">Only ask for what your broker can&apos;t already tell you.</p>
      </div>

      {strategiesResult.success ? (
        <FieldCreateForm strategies={strategiesResult.strategies ?? []} />
      ) : (
        <p className="rq-sub" role="alert">
          {strategiesResult.error?.user_message ?? 'Your strategies are unavailable right now. Please try again.'}
        </p>
      )}
    </section>
  );
}
