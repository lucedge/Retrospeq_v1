import { createClient } from '@/lib/supabase/server';
import { fetchAdherenceDisplay } from './actions';
import { AdherenceSection } from './Adherence';

/**
 * Module 04 (Rulebook & Evaluation) §5.6 UI / story 3.3 — Slice 10d part 2.
 *
 * **SCOPE, verbatim per this slice's own dispatch: THE ADHERENCE DISPLAY
 * ONLY.** Deliberately NOT built here: the general rule list/management UI
 * (story 1.1's "one sentence, one tappable number" list view, severity
 * promote/demote/retire controls) and discovery (ranked detections leading,
 * catalogue behind search, §1.3/Slice 10c) — both are genuinely separate
 * future sub-slices of the same "Slice 10 — the UI" task (see PROGRESS.md),
 * not stubbed or half-built here. The `<AdherenceSection>` below is
 * rendered as this page's own top section specifically so that future work
 * can add the rule list BELOW it without restructuring anything here — see
 * the comment at the bottom of this file's own JSX for exactly where that
 * belongs.
 *
 * **ROUTE CHOICE**: this IS `app/(app)/rules/page.tsx` (not a new dedicated
 * route like `/rules/start` or `/rules/new`), unlike Slice 10a's own
 * explicit choice to avoid this exact file for the guided front door.
 * That reasoning does not apply here: 10a avoided `/rules/page.tsx`
 * specifically because building the GUIDED FRONT DOOR here would have
 * meant either restructuring this route the moment the real rulebook list
 * shipped, or scope-creeping into building that list early to make an
 * empty-state branch coherent. The adherence display has neither problem —
 * it is not a stand-in for a future screen's shape, it is a genuine,
 * permanent section OF the eventual "your rulebook" screen this route was
 * always going to become (§6.1's own reference markup places `.adherence`
 * as one section on the same page as the rule list, not a separate route).
 * Building it here first, and adding the rule list alongside it later, is
 * the direct, non-restructuring path — the inverse situation from 10a's,
 * not an inconsistency with it.
 *
 * **Calling `fetchAdherenceDisplay` (the rate-limited Server Action)
 * directly, not `getAdherenceDisplayForUser` (the underlying library
 * function) — a deliberate difference from `trades/manual-entry/page.tsx`'s
 * own precedent**, which calls `getAmbientAccountState` directly to avoid a
 * loading flash on a latency-sensitive pre-trade screen, bypassing
 * `fetchAmbientState`'s own rate limit for that one initial read. This page
 * has no equivalent "must paint before anything else" requirement (nobody
 * is mid-trade waiting on it), so there is no real UX cost to routing EVERY
 * read through the same rate-limited, session-scoped entry point a future
 * client-triggered re-fetch (e.g. a week picker) would also use — strictly
 * safer by default, not merely equally safe, with no offsetting downside.
 */
export default async function RulesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback every other page in
  // this app tree uses (see app/(app)/rules/start/page.tsx,
  // app/(app)/trades/manual-entry/page.tsx).
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const result = await fetchAdherenceDisplay();

  return (
    <section className="flex flex-col gap-6" aria-labelledby="rules-h">
      <h1 id="rules-h" className="rq-h1">
        Your rulebook
      </h1>

      {result.success && result.display ? (
        <AdherenceSection display={result.display} />
      ) : (
        <p className="rq-sub" role="alert">
          {result.error?.user_message ?? 'Adherence is unavailable right now.'}
        </p>
      )}

      {/* Future sub-slice: the general rule list (story 1.1 — one sentence,
          one tappable number per rule, severity promote/demote/retire
          controls) and discovery (§1.3 — ranked detections leading,
          catalogue behind search) belong here, as additional sections below
          the adherence display — not built in this dispatch. */}
    </section>
  );
}
