'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { confirmDayAction, type ConfirmDayActionState } from '../actions';

/**
 * Module 02 §5.2's `<button type="submit" class="primary" data-action=
 * "confirm-day">Day done</button>` — the ONE primary `.rq-btn` on this
 * screen (AGENTS.md's "one primary `.rq-btn` per view"). Wraps
 * `confirmDayAction` via `useActionState`, same pattern
 * `accounts/connect/page.tsx` established.
 *
 * Renders the SPECIFIC refusal reason using the widened error state Slice
 * 7b added to `confirmDayAction` (`gapIds`/`tradeIds`/`trades`), per §9's
 * "silence over wrongness" — never a generic "something's wrong."
 *
 * **`COVERAGE_GAP`: no working "Try again"/retry-sync button.** §5.2's own
 * reference markup shows one (`data-action="retry-sync"`), but there is no
 * real `BrokerAdapter` in this repo (standing infra gap, 00-foundation
 * §10) — a retry button today would either fake a sync against nothing or
 * be permanently broken, neither of which is honest (AGENTS.md's "never
 * fake it"). The copy says so plainly instead.
 */
export function ConfirmDayForm({
  accountId,
  serverDay,
  hasAnyTrades,
}: {
  accountId: string;
  serverDay: string;
  hasAnyTrades: boolean;
}) {
  const [state, formAction, pending] = useActionState<ConfirmDayActionState | undefined, FormData>(
    confirmDayAction,
    undefined,
  );

  if (state?.success && state.result) {
    return (
      <div className="rq-well flex flex-col gap-2" role="status">
        <h2 className="rq-h2">Day closed out</h2>
        <p className="rq-body">
          {state.result.tradesConfirmed.length === 0
            ? 'No new trades to confirm — this day was already settled.'
            : `${state.result.tradesConfirmed.length} trade${
                state.result.tradesConfirmed.length === 1 ? '' : 's'
              } confirmed.`}
        </p>
        <p className="rq-sub">
          {state.result.dayCloseoutInserted
            ? 'This day now counts toward your streak.'
            : 'This day was already closed out — no change to your streak.'}
        </p>
      </div>
    );
  }

  const knownRefusal =
    state?.error?.code === 'CONFIRM_DAY_COVERAGE_GAP' ||
    state?.error?.code === 'CONFIRM_DAY_AMBIGUOUS_GROUPING' ||
    state?.error?.code === 'CONFIRM_DAY_UNRESOLVED_BLOCK_ANOMALY';

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="serverDay" value={serverDay} />
      <input type="hidden" name="kind" value={hasAnyTrades ? 'traded' : 'deliberate_no_trade'} />

      {state?.error?.code === 'CONFIRM_DAY_COVERAGE_GAP' && (
        <div className="rq-well flex flex-col gap-2" role="alert" data-code="SYNC_COVERAGE_GAP">
          <p className="rq-body">{state.error.user_message}</p>
          <p className="rq-sub">
            Sync isn&apos;t automated yet — check back once your broker history is complete.
          </p>
        </div>
      )}

      {state?.error?.code === 'CONFIRM_DAY_AMBIGUOUS_GROUPING' && (
        <div className="rq-well flex flex-col gap-2" role="alert">
          <p className="rq-body">{state.error.user_message}</p>
          <ul className="flex flex-col gap-1">
            {(state.error.tradeIds ?? []).map((id) => (
              <li key={id}>
                <Link href={`/trades#trade-${id}`} className="rq-sub underline">
                  Review this trade
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state?.error?.code === 'CONFIRM_DAY_UNRESOLVED_BLOCK_ANOMALY' && (
        <div className="rq-well flex flex-col gap-2" role="alert">
          <p className="rq-body">{state.error.user_message}</p>
          <ul className="flex flex-col gap-1">
            {(state.error.trades ?? []).map((t) => (
              <li key={t.tradeId}>
                <Link href={`/trades#trade-${t.tradeId}`} className="rq-sub underline">
                  Review this trade (
                  {t.anomalyCode === 'FILL_LATE_ARRIVAL' ? 'a late fill arrived' : 'sync is still catching up'})
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state?.error && !knownRefusal && (
        <p className="rq-sub" role="alert">
          {state.error.user_message}
        </p>
      )}

      <button type="submit" className="rq-btn" disabled={pending}>
        {pending ? 'Closing out…' : 'Day done'}
      </button>
      <p className="rq-sub">About thirty seconds.</p>
    </form>
  );
}
