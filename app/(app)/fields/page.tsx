import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { canForUser } from '@/lib/entitlements/service';
import { fetchFieldsList } from './actions';
import { FieldsList } from './FieldsList';

/**
 * Module 03 (Field Registry & Strategy) §4.5/§6.1 — the fields management
 * screen. Lets a trader see every field they can capture or rule on
 * (derived + custom), create new custom fields, and rename/archive/promote
 * existing ones. This is the field-lifecycle UI gap the strategy-builder
 * slice's own field PICKER (`app/(app)/strategies/actions.ts`'s
 * `fetchFieldPickerOptions`) deliberately left open — a picker only ever
 * LISTS active fields to attach to a strategy, it never manages one.
 *
 * §1: "the entire strategy module is Pro." Every real user still has 9
 * seeded derived fields regardless of plan (§3.2, seeded at signup) — this
 * page always shows those, matching `StrategiesPage`'s own posture of
 * rendering something honest for every plan rather than hiding the whole
 * screen. Custom-field creation/management is gated on `fields.custom`
 * (docs/adr/0019): a free-plan trader structurally has zero custom fields
 * (`createField`'s own entitlement gate is the only place one could ever
 * come into existence), so "Add a field" is replaced with an upgrade
 * prompt rather than a dead link for that case.
 *
 * `canForUser` called directly (not through a rate-limited Server Action)
 * — same posture `StrategiesPage`/`RulesPage` already establish for a
 * plain entitlement-resolution read with no table of its own to throttle
 * against.
 */
export default async function FieldsPage() {
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

  const [entitlement, listResult] = await Promise.all([canForUser(user.id, 'fields.custom'), fetchFieldsList()]);

  return (
    <section className="flex flex-col gap-6" aria-labelledby="fields-h">
      <h1 id="fields-h" className="rq-h1">
        Your fields
      </h1>

      {!listResult.success && (
        <p className="rq-sub" role="alert">
          {listResult.error?.user_message ?? 'Your fields are unavailable right now.'}
        </p>
      )}

      {listResult.success && !entitlement.allowed && (
        <div className="rq-well flex flex-col gap-3">
          <p className="rq-body">
            Custom fields — anything beyond what your broker already tells us — are a Pro feature. Upgrade to record
            your own conviction, setup quality, or anything else you want to learn from.
          </p>
          <Link href="/plan" className="rq-btn">
            Upgrade to Pro
          </Link>
        </div>
      )}

      {listResult.success && listResult.fields && (
        <FieldsList initialFields={listResult.fields} strategies={listResult.strategies ?? []} entitled={entitlement.allowed} />
      )}
    </section>
  );
}
