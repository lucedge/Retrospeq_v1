import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listTradingAccounts } from '@/lib/broker/accounts-repository';
import {
  listTradesForAccountDay,
  listTradeCaptures,
  listUnresolvedCoverageGapsForAccountDay,
} from '@/lib/ingestion/trades-repository';
import { TRIM_REASON_FIELD_ID, TRIM_REASONS, type TrimReason } from '@/lib/ingestion/trim-reason';
import { fetchStrategyVersionFields } from '@/lib/fields/strategy-repository';
import { fetchFieldsForUser } from '@/lib/fields/fields-repository';
import { formatClockTime, formatDirection, formatRMultiple } from '../format';
import { TrimReasonChips } from './TrimReasonChips';
import { ConfirmDayForm } from './ConfirmDayForm';
import { LateCaptureField, type LateCaptureDataType } from './LateCaptureField';

/**
 * Module 06 (Review & Graduation) §2's daily close-out screen — stories
 * 1.1-1.4. Originally built as a Module 02 placeholder (Slice 7b, "the
 * trim reason chip row, close-out day list, grouping resolution control"
 * named elements; §12's own division of labour: "Module 06 owns the
 * screen; this module supplies its data and owns the confirm
 * transaction"). Module 06 Slice 1 (this pass) is the first real Module
 * 06 ownership of this file's own presentation — see this file's git
 * history for the Slice 7b placeholder header this replaces.
 *
 * Every write this screen performs still goes through Module 02's own
 * `confirmDayAction`/`writeTradeCaptureAction` (`../actions.ts`), plus
 * this slice's own new `writeLateCaptureAction` (story 1.3) — this page
 * and its client children own presentation and READ-side assembly only,
 * matching §10's "this module orchestrates and does not compute."
 *
 * Slice 1's own read of §2's four close-out acceptance criteria against
 * what already existed (see PROGRESS.md's dated decision-log entry for
 * the full reasoning) — summarised here so a future reader doesn't have
 * to re-derive it from a diff:
 *
 *   1.1 "One screen, one confirm. No findings, no prompts, no decisions"
 *       — already true; this pass adds no findings/prompts/decisions.
 *   1.2 "mark a day I deliberately sat out... one tap, streak intact" —
 *       ALREADY functionally wired (`ConfirmDayForm` already sets
 *       `kind: 'deliberate_no_trade'` automatically when the day has zero
 *       trades, and Module 02's `confirmDay` already writes a real
 *       `day_closeouts` row for it) but framed generically ("Day done"
 *       for every case). This pass makes the framing match §2's own
 *       "deliberate, positive choice" language explicitly for the
 *       zero-trade case (see `ConfirmDayForm.tsx`'s own comment).
 *   1.3 "fill a missed pre-entry capture... marked captured_late,
 *       excluded from judgment findings" — the BACKEND round-trip
 *       (`writeTradeCapture`'s `capturedLate` param, Module 02 §4.5) has
 *       existed since Slice 7b, but genuinely NO SCREEN anywhere in this
 *       repo ever called it with `capturedLate: true` until this pass —
 *       confirmed by grep before writing a line of new code. This is the
 *       real, substantive addition in this slice: `LateCaptureField.tsx`
 *       + `writeLateCaptureAction` (`../actions.ts`).
 *   1.4 "blocked when data is missing... named reason and retry" — the
 *       REFUSAL path already existed (`ConfirmDayForm`'s reactive
 *       error-state rendering, Slice 7b), but only surfaced AFTER a
 *       wasted submit. This pass adds a PROACTIVE coverage-gap check
 *       (`listUnresolvedCoverageGapsForAccountDay`, below) so the block
 *       and its reason are visible — and the confirm control genuinely
 *       disabled — before the trader ever taps "Day done," reading
 *       "confirm disabled" literally rather than only "confirm refused."
 *       No working automated retry exists (no real `BrokerAdapter`,
 *       standing infra gap, 00-foundation §10) — the copy says so
 *       honestly, unchanged from Slice 7b's own posture (AGENTS.md's
 *       "never fake it").
 *
 * `?account=<id>&day=YYYY-MM-DD` — a GET-submitted picker (a `<select>` +
 * `<input type="date">`, no calendar widget) fills these in when either is
 * missing.
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
  const [captures, coverageGaps] = await Promise.all([
    listTradeCaptures(
      user.id,
      trades.map((t) => t.id),
    ),
    // Story 1.4 — proactive check, see this file's own header. Only
    // meaningful once we know the account's own `day_rollover` (needed to
    // resolve `day` into the UTC instant range a gap might overlap); if
    // the account row can't be found here (shouldn't happen — the trade
    // list query above is already scoped to this same `accountId`), skip
    // the check rather than throw — the reactive, post-submit refusal
    // path (`ConfirmDayForm`'s existing error-state rendering) still
    // catches it either way, so this is strictly additive, never the only
    // safety net.
    account ? listUnresolvedCoverageGapsForAccountDay(user.id, accountId, day, account.day_rollover) : Promise.resolve([]),
  ]);

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

  // ---------------------------------------------------------------------
  // Story 1.3 — which pre-entry fields are MISSING per trade, i.e. named
  // on the trade's own bound strategy VERSION (never the strategy's
  // current version — see `fetchStrategyVersionFields`'s own header) as
  // `capture_moment: 'pre_entry'`, but with no `trade_captures` row of any
  // moment yet for this specific trade.
  // ---------------------------------------------------------------------
  const capturedFieldIdsByTrade = new Map<string, Set<string>>();
  for (const c of captures) {
    if (!capturedFieldIdsByTrade.has(c.tradeId)) capturedFieldIdsByTrade.set(c.tradeId, new Set());
    capturedFieldIdsByTrade.get(c.tradeId)!.add(c.fieldId);
  }

  const strategyVersionKey = (strategyId: string, version: number) => `${strategyId}::${version}`;
  const distinctStrategyVersions = new Map<string, { strategyId: string; version: number }>();
  for (const trade of trades) {
    if (trade.strategy_id && trade.strategy_version !== null) {
      distinctStrategyVersions.set(strategyVersionKey(trade.strategy_id, trade.strategy_version), {
        strategyId: trade.strategy_id,
        version: trade.strategy_version,
      });
    }
  }
  const strategyVersionFieldsEntries = await Promise.all(
    Array.from(distinctStrategyVersions.entries()).map(async ([key, { strategyId, version }]) => {
      const fields = await fetchStrategyVersionFields(user.id, strategyId, version);
      return [key, fields ?? []] as const;
    }),
  );
  const preEntryFieldIdsByStrategyVersion = new Map<string, string[]>(
    strategyVersionFieldsEntries.map(([key, fields]) => [
      key,
      fields.filter((f) => f.captureMoment === 'pre_entry').map((f) => f.fieldId),
    ]),
  );

  const missingFieldIdsByTrade = new Map<string, string[]>();
  const allMissingFieldIds = new Set<string>();
  for (const trade of trades) {
    if (!trade.strategy_id || trade.strategy_version === null) continue;
    const preEntryFieldIds = preEntryFieldIdsByStrategyVersion.get(strategyVersionKey(trade.strategy_id, trade.strategy_version)) ?? [];
    const captured = capturedFieldIdsByTrade.get(trade.id) ?? new Set<string>();
    const missing = preEntryFieldIds.filter((fieldId) => !captured.has(fieldId));
    if (missing.length > 0) {
      missingFieldIdsByTrade.set(trade.id, missing);
      for (const fieldId of missing) allMissingFieldIds.add(fieldId);
    }
  }

  // Field display metadata (name/data_type/config) for every field id any
  // trade on this page is missing — `fetchFieldsForUser` already returns
  // every active field this user owns (a small set in practice), reused
  // here rather than a second, parallel query (AGENTS.md: grep for an
  // existing utility before writing a parallel one).
  const fieldDisplayById =
    allMissingFieldIds.size > 0
      ? new Map((await fetchFieldsForUser(user.id)).map((f) => [f.fieldId, f]))
      : new Map<string, Awaited<ReturnType<typeof fetchFieldsForUser>>[number]>();

  const coverageGapBlocked = coverageGaps.length > 0;

  return (
    <section className="flex flex-col gap-6" aria-labelledby="closeout-h">
      <h1 id="closeout-h" className="rq-h1">
        Close out {day}
        {account ? ` — ${account.label}` : ''}
      </h1>

      {trades.length === 0 ? (
        <p className="rq-sub">
          Nothing traded on this account today. Confirming records it as a deliberate no-trade day
          — a real, logged decision, not a gap in your history.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {trades.map((trade) => {
            const missingFieldIds = missingFieldIdsByTrade.get(trade.id) ?? [];
            return (
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
                      the design system's real `.rq-tag` (`--on`/`--muted`
                      are not a red/green pair). */}
                  <span className={preEntryTradeIds.has(trade.id) ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}>
                    {preEntryTradeIds.has(trade.id) ? 'Pre-entry captured' : 'No pre-entry capture'}
                  </span>
                </div>
                <TrimReasonChips tradeId={trade.id} initialReason={trimReasonByTrade.get(trade.id) ?? null} />
                {missingFieldIds.length > 0 && (
                  <div className="rq-well flex flex-col gap-3">
                    <p className="rq-sub">Missed pre-entry notes — fill them in now, marked as filled late.</p>
                    {missingFieldIds.map((fieldId) => {
                      const field = fieldDisplayById.get(fieldId);
                      if (!field) return null;
                      // Structurally restricted to fast-capture types at
                      // authoring time (Module 03 §4.4's
                      // `PRE_ENTRY_SAFE_TYPES`) — `number`/`note` can never
                      // reach this branch; still handled defensively
                      // (00-foundation's "should be structurally
                      // impossible, still handled" posture) by simply
                      // never rendering a control for either, rather than
                      // rendering a broken one.
                      if (field.dataType !== 'pick_one' && field.dataType !== 'pick_many' && field.dataType !== 'bool' && field.dataType !== 'rating') {
                        return null;
                      }
                      return (
                        <LateCaptureField
                          key={fieldId}
                          tradeId={trade.id}
                          fieldId={fieldId}
                          fieldName={field.name}
                          dataType={field.dataType as LateCaptureDataType}
                          options={field.config.options}
                          ratingMin={field.config.min}
                          ratingMax={field.config.max}
                        />
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDayForm
        accountId={accountId}
        serverDay={day}
        hasAnyTrades={trades.length > 0}
        coverageGapBlocked={coverageGapBlocked}
        coverageGapCount={coverageGaps.length}
      />
    </section>
  );
}
