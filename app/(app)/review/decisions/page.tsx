import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { fetchNextGraduationDecision } from './actions';
import { DecisionCard } from './DecisionCard';

/**
 * Module 06 (Review & Graduation) Slice 6 — `/review/decisions`, the Part 2
 * decision flow's own route, GRADUATION ONLY (see `actions.ts`'s own
 * header for the full scope boundary). Reached from `/review`'s own
 * "N decisions" button (`app/(app)/review/page.tsx`), which this slice
 * wires up for real — Slice 5 shipped it `disabled`, per that page's own
 * explicit deferral note.
 *
 * Same "Server Component does the first read, hands off to a Client
 * Component for interactivity" split `ManualEntryScreen.tsx`
 * (`app/(app)/trades/manual-entry/`) already established — every
 * subsequent accept/defer + "load the next decision" round trip happens
 * client-side against the SAME rate-limited Server Actions
 * (`fetchNextGraduationDecision`/`acceptGraduationDecision`/
 * `deferGraduationDecision`, all in `./actions.ts`), never a second,
 * un-throttled read path.
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

  const result = await fetchNextGraduationDecision();

  if (!result.success) {
    return (
      <p className="rq-sub" role="alert">
        {result.error?.user_message ?? 'Decisions are unavailable right now.'}
      </p>
    );
  }

  if (result.status === 'plan_required') {
    return (
      <section className="flex flex-col gap-3" aria-labelledby="dec-h">
        <h1 id="dec-h" className="rq-h1">
          Turning a finding into a rule is a Pro feature.
        </h1>
        <p className="rq-sub">Upgrade to accept or defer graduation decisions.</p>
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

  return <DecisionCard initialIndex={result.index} initialTotal={result.total} initialDetail={result.detail} />;
}
