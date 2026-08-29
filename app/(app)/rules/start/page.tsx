import { createClient } from '@/lib/supabase/server';
import { canForUser } from '@/lib/entitlements/service';
import { formatUsageFraction } from '@/lib/entitlements/messages';
import { seedGuidedRuleThresholds } from '@/lib/rules/guided-front-door';
import { GuidedFrontDoor } from './GuidedFrontDoor';

/**
 * Module 04 (Rulebook & Evaluation) §5.10 / story 1.4 — "the guided
 * three-rule front door." Slice 10a's own scope note (this is a deliberate
 * sub-slice of the larger "Slice 10 — the UI" task, see PROGRESS.md):
 * ONLY this screen. The general rule editor for arbitrary operands (story
 * 1.1), discovery/catalogue browsing (story 1.3), the ambient strip
 * (§5.9), and adherence display (§5.6) are each a separate future
 * sub-slice, not built here.
 *
 * ROUTE CHOICE, documented per this slice's own dispatch ("decide based
 * on what reads most naturally, document the choice"): a DEDICATED route
 * (`/rules/start`), not `app/(app)/rules/page.tsx` doubling as both the
 * empty state AND the future full rulebook list. Reasoning: `/rules`
 * itself (the "your rulebook" screen — the general editor, discovery,
 * severity controls, adherence display) is EXPLICITLY out of scope for
 * this sub-slice and belongs to future sub-slices of the same "Slice 10"
 * task. Building `/rules/page.tsx` now as a guided-front-door-only page
 * would mean either (a) that route has to be substantially restructured
 * the moment the general rulebook list ships, or (b) this slice ends up
 * scope-creeping into building parts of that list to make the empty-state
 * branch coherent. A dedicated route avoids both — it matches this
 * repo's own precedent of separate routes for distinct flows off a shared
 * resource (`/trades/manual-entry`, `/trades/close-out` alongside
 * `/trades` itself, Module 02 Slice 7). Once the general `/rules` list
 * exists, it can link here for a zero-rule trader (or redirect), which is
 * a trivial addition to THAT slice, not a rewrite of this one.
 */
export default async function GuidedRuleFrontDoorPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback every other
  // page in this app tree uses for the rare session-expired-mid-render
  // case (see app/(app)/trades/page.tsx, app/(app)/plan/page.tsx).
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const [seeds, entitlement] = await Promise.all([
    seedGuidedRuleThresholds(user.id),
    canForUser(user.id, 'rules.create'),
  ]);

  return (
    <section className="flex flex-col gap-6" aria-labelledby="guided-rules-h">
      <div className="flex flex-col gap-2">
        <h1 id="guided-rules-h" className="rq-h1">
          Three rules to start with
        </h1>
        <p className="rq-body">
          Every trader needs these. Nothing here is final — every one starts soft, and you can
          change, promote, or retire any of them later.
        </p>
      </div>

      <GuidedFrontDoor
        seeds={seeds}
        entitlement={{
          allowed: entitlement.allowed,
          limit: entitlement.limit,
          used: entitlement.used ?? 0,
          usageFraction: formatUsageFraction(entitlement.used ?? 0, entitlement.limit),
        }}
      />
    </section>
  );
}
