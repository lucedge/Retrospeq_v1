import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { fetchNextDecision } from './actions';
import { DecisionCard } from './DecisionCard';
import { RelaxationDecisionCard } from './RelaxationDecisionCard';
import { PromotionDecisionCard } from './PromotionDecisionCard';
import { RetirementDecisionCard } from './RetirementDecisionCard';
import { DetectionDecisionCard } from './DetectionDecisionCard';

/**
 * Module 06 (Review & Graduation) `/review/decisions` — the Part 2 decision
 * flow's own route. Slice 6 shipped graduation only; Slice 7 widens this
 * page to also render relaxation, dispatching on `fetchNextDecision`'s own
 * `kind` discriminant (`actions.ts`'s own header has the full "why
 * per-prompt, not per-screen, entitlement gating" reasoning). Reached from
 * `/review`'s own "N decisions" button (`app/(app)/review/page.tsx`).
 *
 * Same "Server Component does the first read, hands off to a Client
 * Component for interactivity" split `ManualEntryScreen.tsx`
 * (`app/(app)/trades/manual-entry/`) already established — every
 * subsequent accept/defer/recommit/adjust + "load the next decision" round
 * trip happens client-side against the SAME rate-limited Server Actions
 * (all in `./actions.ts`), never a second, un-throttled read path.
 */
export default async function ReviewDecisionsPage() {
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

  const result = await fetchNextDecision();

  if (!result.success) {
    return (
      <p className="rq-sub" role="alert">
        {result.error?.user_message ?? 'Decisions are unavailable right now.'}
      </p>
    );
  }

  if (result.status === 'plan_required') {
    const headline = result.kind === 'promotion' ? 'Making a rule hard is a Pro feature.' : 'Turning a finding into a rule is a Pro feature.';
    const sub = result.kind === 'promotion' ? 'Upgrade to promote or keep this rule soft.' : 'Upgrade to accept or defer graduation decisions.';
    return (
      <section className="flex flex-col gap-3" aria-labelledby="dec-h">
        <h1 id="dec-h" className="rq-h1">
          {headline}
        </h1>
        <p className="rq-sub">{sub}</p>
        <Link href="/review" className="rq-btn rq-btn--ghost">
          Back to your review
        </Link>
      </section>
    );
  }

  if (result.status === 'no_review') {
    return (
      <section className="flex flex-col gap-3" aria-labelledby="dec-h">
        <h1 id="dec-h" className="rq-h1">
          Open your weekly review first.
        </h1>
        <p className="rq-sub">Decisions are tied to your current review — read it before deciding anything.</p>
        <Link href="/review" className="rq-btn">
          Go to your review
        </Link>
      </section>
    );
  }

  if (result.status === 'none_pending') {
    return (
      <section className="flex flex-col gap-3" aria-labelledby="dec-h">
        <h1 id="dec-h" className="rq-h1">
          Nothing to decide right now.
        </h1>
        <p className="rq-sub">Most weeks have none — that&apos;s the normal case.</p>
        <Link href="/review" className="rq-btn">
          Back to your review
        </Link>
      </section>
    );
  }

  if (result.kind === 'relaxation') {
    return <RelaxationDecisionCard initialIndex={result.index} initialTotal={result.total} initialDetail={result.detail} />;
  }

  if (result.kind === 'promotion') {
    return <PromotionDecisionCard initialIndex={result.index} initialTotal={result.total} initialDetail={result.detail} />;
  }

  if (result.kind === 'retirement') {
    return <RetirementDecisionCard initialIndex={result.index} initialTotal={result.total} initialDetail={result.detail} />;
  }

  if (result.kind === 'detection') {
    return <DetectionDecisionCard initialIndex={result.index} initialTotal={result.total} initialDetail={result.detail} />;
  }

  return <DecisionCard initialIndex={result.index} initialTotal={result.total} initialDetail={result.detail} />;
}
