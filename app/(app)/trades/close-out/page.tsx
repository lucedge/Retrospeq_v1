import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listTradingAccounts } from '@/lib/broker/accounts-repository';
import { listTradesForAccountDay, listTradeCaptures } from '@/lib/ingestion/trades-repository';
import { TRIM_REASON_FIELD_ID, TRIM_REASONS, type TrimReason } from '@/lib/ingestion/trim-reason';
import { formatClockTime, formatDirection, formatRMultiple } from '../format';
import { TrimReasonChips } from './TrimReasonChips';
import { ConfirmDayForm } from './ConfirmDayForm';

/**
 * Module 02 §5.1/§5.2's close-out screen (Slice 7b) — "the trim reason
 * chip row, close-out day list, grouping resolution control" named
 * elements this slice was dispatched to build. §12's own division of
 * labour ("Module 06 owns the screen; this module supplies its data and
 * owns the confirm transaction") is honoured structurally: every write
 * this screen performs goes through Module 02's own
 * `confirmDayAction`/`writeTradeCaptureAction` (`../actions.ts`) — this
 * page and its two client children own presentation only, no new backend
 * logic. A future Module 06 pass can restyle/reorganise this screen
 * without touching either action.
 *
 * `?account=<id>&day=YYYY-MM-DD` — a GET-submitted picker (a `<select>` +
 * `<input type="date">`, no calendar widget) fills these in when either is
 * missing, per this slice's own dispatch ("no calendar widget needed").
 */
export default async function CloseOutPage(props: PageProps<'/trades/close-out'>) {
  const searchParams = await props.searchParams;
  const accountId = typeof searchParams.account === 'string' ? searchParams.account : undefined;
  const day = typeof searchParams.day === 'string' ? searchParams.day : undefined;

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

  if (!accountId || !day) {
    const accounts = await listTradingAccounts(user.id);
    return (
      <section className="flex flex-col gap-6" aria-labelledby="closeout-picker-h">
        <h1 id="closeout-picker-h" className="rq-h1">
          Close out a day
        </h1>
        {accounts.length === 0 ? (
          <p className="rq-sub">
            No accounts yet.{' '}
            <Link href="/accounts/connect" className="underline">
              Connect an account
            </Link>{' '}
            first.
          </p>
        ) : (
          <form method="get" className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="account" className="rq-label">
                Account
              </label>
              <select
                id="account"
                name="account"
                defaultValue={accounts[0].id}
                className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="day" className="rq-label">
                Day
              </label>
              <input
                id="day"
                name="day"
                type="date"
                required
                className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
              />
            </div>
            <button type="submit" className="rq-btn">
              View day
            </button>
          </form>
        )}
      </section>
    );
  }

  const [trades, accounts] = await Promise.all([
    listTradesForAccountDay(user.id, accountId, day),
    listTradingAccounts(user.id),
  ]);
  const account = accounts.find((a) => a.id === accountId);
  const captures = await listTradeCaptures(
    user.id,
    trades.map((t) => t.id),
  );

  const preEntryTradeIds = new Set(captures.filter((c) => c.moment === 'pre_entry').map((c) => c.tradeId));
  const trimReasonByTrade = new Map<string, TrimReason>();
  for (const c of captures) {
    if (
      c.fieldId === TRIM_REASON_FIELD_ID &&
      typeof c.value === 'string' &&
      (TRIM_REASONS as readonly string[]).includes(c.value)
    ) {
      trimReasonByTrade.set(c.tradeId, c.value as TrimReason);
    }
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="closeout-h">
      <h1 id="closeout-h" className="rq-h1">
        Close out {day}
        {account ? ` — ${account.label}` : ''}
      </h1>

      {trades.length === 0 ? (
        <p className="rq-sub">
          No trades recorded for this account on this day. Confirming will mark it a deliberate
          no-trade day.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {trades.map((trade) => (
            <li
              key={trade.id}
              className="rq-card flex flex-col gap-3"
              data-capture={preEntryTradeIds.has(trade.id) ? 'matched' : 'unmatched'}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="rq-row__name">{trade.instrument}</span>
                <span className="rq-sub">{formatDirection(trade.direction)}</span>
                <span className="rq-num">{formatRMultiple(trade.r_multiple)}</span>
                <time className="rq-sub" dateTime={trade.opened_at}>
                  {formatClockTime(trade.opened_at)}
                </time>
                {/* §5.2's `chip--ok`/`chip--muted` — text-only, built on
                    the design system's real `.rq-tag` (no dedicated chip
                    component exists, and `--on`/`--muted` are not a
                    red/green pair). No "Add now" link: Module 03's field
                    registry doesn't exist yet, so there is nothing to link
                    to (deliberate, not an oversight — see this slice's
                    own dispatch). */}
                <span className={preEntryTradeIds.has(trade.id) ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}>
                  {preEntryTradeIds.has(trade.id) ? 'Pre-entry captured' : 'No pre-entry capture'}
                </span>
              </div>
              <TrimReasonChips tradeId={trade.id} initialReason={trimReasonByTrade.get(trade.id) ?? null} />
            </li>
          ))}
        </ul>
      )}

      <ConfirmDayForm accountId={accountId} serverDay={day} hasAnyTrades={trades.length > 0} />
    </section>
  );
}
