import { createClient } from '@/lib/supabase/server';
import { canForUser } from '@/lib/entitlements/service';
import { formatUsageFraction } from '@/lib/entitlements/messages';
import { fetchAccountSyncTiers } from '@/lib/rules/rules-repository';
import { getEditableOperands } from '@/lib/rules/editable-operands';
import { RuleEditor } from './RuleEditor';

/**
 * Module 04 (Rulebook & Evaluation) §6.1's `.rule-editor` reference markup
 * / story 1.1 — Slice 10b, the GENERAL rule editor. Distinct from Slice
 * 10a's guided front door (`/rules/start`, three fixed operands): this
 * screen lets a trader pick ANY operand the catalogue and their own
 * connected accounts' tier can support. This slice's own scope boundary
 * (per its own dispatch): CREATE only, `scope: 'global'` only.
 *
 * `scope` OMITTED FROM THIS SCREEN ENTIRELY — a deliberate, documented
 * scope-narrowing, not an oversight (00-foundation §12: log deviations).
 * Story 1.5's `scope = 'strategy'` requires a real `scopeId` (a strategy
 * to attach to), and Module 03 (Field Registry & Strategy) has not been
 * built in this repo yet — there is no strategy picker to offer and no
 * strategy any such rule could reference. Every rule this screen creates
 * is therefore `scope: 'global'`, matching `createRule`'s own default
 * shape for the guided front door (Slice 10a). Once Module 03 ships, this
 * screen (or a follow-up sub-slice) is where a real strategy-scope toggle
 * belongs — building a disabled placeholder for it today would either
 * mislead ("coming soon" for a feature with no target date) or need
 * revisiting the moment strategies exist anyway, so it is omitted
 * outright rather than half-shown. Logged in PROGRESS.md's decision log.
 *
 * TIGHTEN-ONLY (`RULE_LOOSER_THAN_GLOBAL`) IS STRUCTURALLY UNREACHABLE
 * THROUGH THIS SCREEN, confirmed by reading `app/(app)/rules/actions.ts`'s
 * `createRule` directly: `checkTightenOnly` only ever runs when
 * `scope === 'strategy'` (tighten-only is specifically about a
 * strategy-scoped rule being at least as strict as the governing global
 * rulebook — there is no "global rule looser than what" to compare
 * against for another global rule; that is `RULE_UNSATISFIABLE`'s job,
 * still wired below). Since this screen only ever submits `scope:
 * 'global'`, §6.1's tighten-only rejection alert
 * (`data-code="RULE_LOOSER_THAN_GLOBAL"`, the "Use X%" / "Change my
 * rulebook instead" two-button markup) is NOT built here — it would be
 * dead UI no interaction on this screen can ever trigger. `RuleEditor.tsx`
 * still renders the server's own `error.user_message` for every OTHER
 * error code (including `RULE_UNSATISFIABLE`, `checkSatisfiability`'s own
 * check for `scope === 'global'`, which genuinely CAN run through this
 * screen), just without a bespoke two-button treatment that only makes
 * sense for the strategy-vs-global comparison.
 *
 * OPERAND LIST, computed server-side (not left to the client to filter):
 * `getEditableOperands` (`lib/rules/editable-operands.ts`) intersects the
 * static catalogue's `number`/`duration`/`bool`, single-authorable-operator
 * operands with this trader's OWN connected accounts' reported sync tiers
 * (`fetchAccountSyncTiers`) — §4.1: "An account reporting T0 capability
 * must not be offered `stop_moved_against`." Only the resulting operand
 * IDS are sent to the client; `RuleEditor.tsx` re-resolves each one's full
 * catalogue entry via the same static `getOperand()` lookup rather than
 * this page serialising catalogue objects into a prop.
 */
export default async function NewRulePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Same defensive session-expired fallback every other page in this app
  // tree uses (see app/(app)/rules/start/page.tsx, app/(app)/trades/page.tsx).
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const [accountSyncTiers, entitlement] = await Promise.all([
    fetchAccountSyncTiers(user.id),
    canForUser(user.id, 'rules.create'),
  ]);

  const operandIds = getEditableOperands(accountSyncTiers).map((o) => o.id);

  return (
    <section className="flex flex-col gap-6" aria-labelledby="rule-editor-h">
      <div className="flex flex-col gap-2">
        <h1 id="rule-editor-h" className="rq-h1">
          Write a rule
        </h1>
        <p className="rq-body">
          Pick what you want to hold yourself to. Every new rule starts soft and applies to your
          whole rulebook.
        </p>
      </div>

      <RuleEditor
        operandIds={operandIds}
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
