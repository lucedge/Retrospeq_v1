'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { createManualTradeAction, type ManualEntryActionState } from '../actions';

/**
 * Module 02 §4.8's manual-entry form: "one screen, six fields, under 30
 * seconds: instrument, direction, size, entry price, exit price, stop."
 * Field names match `manualTradeInputSchema` exactly
 * (`lib/ingestion/manual-entry.ts`) — `createManualTradeAction` parses
 * `formData` straight against that schema, so this form's `name`
 * attributes are the actual contract, not decorative.
 *
 * Direction uses the design system's real pick-one pills
 * (`.rq-pills`/`.rq-pill.on`), the same component `accounts/connect/
 * page.tsx` uses for platform selection — this is a symmetric two-way
 * choice, not a fast-capture judgment rating, so pills (not steppers/dots)
 * are the right primitive here, matching precedent. The numeric fields
 * (size/prices/stop) are real decimal values a trader is recalling from a
 * closed trade, not a bounded small-integer rating — a text input with
 * `inputMode="decimal"` is the honest control for that, same shape
 * `connect/page.tsx`'s own text inputs use elsewhere in this repo; there
 * is no stepper primitive in the design system built for arbitrary
 * decimal price entry.
 */
export function ManualEntryForm({ accounts }: { accounts: { id: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState<ManualEntryActionState | undefined, FormData>(
    createManualTradeAction,
    undefined,
  );
  const [direction, setDirection] = useState<'long' | 'short'>('long');

  if (state?.success && state.result) {
    return (
      <section className="flex flex-col gap-4" role="status">
        <h2 className="rq-h2">Trade logged</h2>
        <p className="rq-body">
          Everything else — risk, R-multiple, hold time — is derived from what you entered.
        </p>
        <Link href="/trades" className="rq-btn rq-btn--block">
          View your trades
        </Link>
      </section>
    );
  }

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="accountId" className="rq-label">
          Account
        </label>
        <select
          id="accountId"
          name="accountId"
          defaultValue={accounts[0]?.id}
          className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        {state?.fieldErrors?.accountId && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.accountId[0]}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="instrument" className="rq-label">
          Instrument
        </label>
        <input
          id="instrument"
          name="instrument"
          autoComplete="off"
          spellCheck={false}
          className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
        />
        {state?.fieldErrors?.instrument && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.instrument[0]}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="rq-label">Direction</legend>
        <div className="rq-pills" role="radiogroup" aria-label="Direction">
          {(['long', 'short'] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={direction === d}
              className={direction === d ? 'rq-pill on' : 'rq-pill'}
              onClick={() => setDirection(d)}
            >
              {d === 'long' ? 'Long' : 'Short'}
            </button>
          ))}
        </div>
        <input type="hidden" name="direction" value={direction} />
        {state?.fieldErrors?.direction && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.direction[0]}
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="size" className="rq-label">
          Size
        </label>
        <input
          id="size"
          name="size"
          inputMode="decimal"
          autoComplete="off"
          className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
        />
        {state?.fieldErrors?.size && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.size[0]}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="entryPrice" className="rq-label">
          Entry price
        </label>
        <input
          id="entryPrice"
          name="entryPrice"
          inputMode="decimal"
          autoComplete="off"
          className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
        />
        {state?.fieldErrors?.entryPrice && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.entryPrice[0]}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="exitPrice" className="rq-label">
          Exit price
        </label>
        <input
          id="exitPrice"
          name="exitPrice"
          inputMode="decimal"
          autoComplete="off"
          className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
        />
        {state?.fieldErrors?.exitPrice && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.exitPrice[0]}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="stop" className="rq-label">
          Stop (optional)
        </label>
        <input
          id="stop"
          name="stop"
          inputMode="decimal"
          autoComplete="off"
          className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
        />
        {state?.fieldErrors?.stop && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.stop[0]}
          </p>
        )}
      </div>

      {state?.error && (
        <p className="rq-sub" role="alert">
          {state.error.user_message}
        </p>
      )}

      <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
        {pending ? 'Logging…' : 'Log trade'}
      </button>
    </form>
  );
}
