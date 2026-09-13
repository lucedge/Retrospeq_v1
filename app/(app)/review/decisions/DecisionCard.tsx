'use client';

import { useState, useTransition } from 'react';
import type { GraduationPromptDetail } from '@/lib/review/decisions/graduation-evidence-detail';
import { acceptGraduationDecision, deferGraduationDecision } from './actions';

/**
 * Module 06 (Review & Graduation) Slice 6, §5.1's `review--decision`
 * reference markup — GRADUATION ONLY. Renders one decision at a time
 * (§2.1 story 2.1: "Part 2 decisions, one at a time. Never interleaved").
 *
 * MAPPING §5.1's reference markup to this repo's REAL, already-shipped
 * design-system classes (not the spec's own illustrative BEM names, which
 * were never shipped as CSS — see docs/adr/0040 for the full reasoning):
 *   - `.evidence`/`.decision-actions` containers -> plain Tailwind layout
 *     (`flex flex-col gap-*`), matching `/review/page.tsx`'s own identical
 *     translation of §5.1's Part 1 markup into this repo's real primitives.
 *   - `.cost` -> `.rq-cost`, an ALREADY-SHIPPED component built for exactly
 *     this "trade-off to weigh, not a warning to dismiss" purpose
 *     (`public/brand/css/components.css`'s own header comment on it).
 *   - `button.primary`/`button.ghost` -> `.rq-btn`/`.rq-btn--ghost` — this
 *     repo's real one-primary-per-view pair, not `.rq-btn--equal` (that's
 *     reserved for a truly symmetric, no-default choice like relaxation's
 *     future recommit/adjust pair — graduation's accept/defer is NOT
 *     symmetric, matching §5.1's own `primary`/`ghost` naming).
 *
 * PROGRESSION TO THE NEXT DECISION — a genuine, load-bearing judgment call
 * (docs/adr/0040 decision 3), found empirically during this slice's own
 * screenshot self-check, not assumed: this component does NOT manage its
 * own "fetch the next decision" client-side state machine. Both
 * `acceptGraduationDecision` and `deferGraduationDecision`
 * (`./actions.ts`) call `revalidatePath('/review/decisions')` on success —
 * per Next.js's own documented Server Actions behaviour
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`:
 * "When a Server Action triggers an immediate revalidation, Next.js does
 * the work inside ONE HTTP request: it runs the action, then re-renders
 * the current route server-side... in the SAME Flight stream"), the
 * `await acceptGraduationDecision(...)` call below does not resolve until
 * `page.tsx` has ALREADY been re-rendered server-side and the resulting
 * tree has ALREADY replaced this component in the DOM (a fresh
 * `<DecisionCard>` instance with the next decision's props, `page.tsx`'s
 * own "no_review"/"none_pending" branch, or — the earlier, wrong version
 * of this file's own now-corrected assumption — nothing at all, since the
 * OLD instance is unmounted by the time any post-await `setState` here
 * would run). A client-side "load the next one" re-fetch was built,
 * shipped, and PROVED DEAD CODE by this slice's own screenshot self-check
 * (the accept flow visibly landed on `page.tsx`'s server-rendered
 * "Nothing to decide right now." — never this component's own
 * client-rendered "done" text, which never once painted across repeated
 * real runs) — removed rather than left in as inert, misleading code.
 * This is a genuine, if slightly unusual, benefit of this repo's own
 * "read the docs, not your training data" rule (AGENTS.md's Next.js
 * banner) paying off directly: the naive client-side re-fetch pattern
 * every other client component in this repo uses for a live re-check
 * (`fetchAmbientState`, `previewRule`) is the WRONG shape here
 * specifically because this screen's own mutations already revalidate
 * the exact route the client is looking at.
 *
 * CONSEQUENCE — no transient "Added the rule: ..." confirmation: because
 * a successful accept unmounts this component before any client-side
 * `setState` after the `await` can ever paint, there is no way for THIS
 * component to show its own success message the way `page.tsx`'s
 * `/review` screen's own compute-on-view screens do. Documented as a
 * deliberate, honest omission (docs/adr/0040) rather than dead code left
 * in pretending to work — a future slice wanting a transient success
 * toast would need a mechanism that survives the automatic route
 * revalidation (e.g. a query-param flash message `page.tsx` reads), which
 * does not exist anywhere in this repo yet and is out of this slice's own
 * scope.
 */

interface CardState {
  errorMessage: string | null;
}

export function DecisionCard({
  initialIndex,
  initialTotal,
  initialDetail,
}: {
  initialIndex: number;
  initialTotal: number;
  initialDetail: GraduationPromptDetail;
}) {
  const [state, setState] = useState<CardState>({ errorMessage: null });
  const [isPending, startTransition] = useTransition();
  const detail = initialDetail;

  function handleAccept() {
    startTransition(async () => {
      const result = await acceptGraduationDecision(detail.promptId);
      // A SUCCESSFUL accept calls `revalidatePath` server-side, which — per
      // this component's own header comment — has ALREADY replaced this
      // instance in the DOM by the time this line runs. Only the FAILURE
      // branch below can ever observably run against a still-mounted
      // component (an honest rejection never revalidates, per `actions.ts`'s
      // own write ordering — nothing changed, so nothing to refresh).
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.' });
      }
    });
  }

  function handleDefer() {
    startTransition(async () => {
      const result = await deferGraduationDecision(detail.promptId);
      if (!result.success) {
        setState({ errorMessage: result.error?.user_message ?? 'Something went wrong. Please try again.' });
      }
    });
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="dec-h">
      <p className="rq-sub">
        Decision <span className="rq-num">{initialIndex}</span> of <span className="rq-num">{initialTotal}</span>
      </p>
      <h1 id="dec-h" className="rq-h1">
        Make {detail.fieldName.toLowerCase()} a rule?
      </h1>

      <div className="rq-card flex flex-col gap-2">
        <p className="rq-body">{detail.statement}</p>
        <p className="rq-sub">{detail.meta}</p>
      </div>

      <div className="rq-cost" role="note">
        <p className="rq-body">{detail.costLine}</p>
      </div>

      <p className="rq-sub">{detail.hint}</p>

      {state.errorMessage && (
        <p className="rq-sub" role="alert">
          {state.errorMessage}
        </p>
      )}

      {detail.canAccept ? (
        <div className="flex flex-col gap-2">
          <button type="button" className="rq-btn" disabled={isPending} onClick={handleAccept}>
            Add the rule
          </button>
          <button type="button" className="rq-btn rq-btn--ghost" disabled={isPending} onClick={handleDefer}>
            Not yet
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="rq-sub">{detail.blockedReason}</p>
          <button type="button" className="rq-btn rq-btn--ghost" disabled={isPending} onClick={handleDefer}>
            Not yet
          </button>
        </div>
      )}
    </section>
  );
}
