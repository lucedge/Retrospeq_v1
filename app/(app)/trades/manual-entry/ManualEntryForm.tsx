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
 * UI batch 1b restyle against `brand/docs/screens/home-onboarding.html#1.6`:
 * Direction now uses the real `.segmented` native radiogroup (real
 * `<input type=radio>` + `<label>` pairs) — frame 1.6's own reference
 * markup, and the same primitive `accounts/connect/page.tsx` now uses for
 * platform selection. The previous version of this comment claimed
 * `.rq-pills` matched precedent because "there is no `.segmented` class"
 * elsewhere; that was never true of `components.css` (`.segmented` has
 * shipped since the "Design program batch 6" pass) — corrected. The
 * numeric fields (size/prices/stop) are real decimal values a trader is
 * recalling from a closed trade, not a bounded small-integer rating — a
 * `.field` text input with `inputMode="decimal"` (frame 1.6's own shape)
 * is the honest control; this is a post-close data screen ("Post-close
 * data, so typing is allowed here" — frame 1.6's own caption), not a
 * fast-capture judgment rating screen, so keyboard entry is correct here.
 *
 * `accountId`/`onAccountIdChange` (Slice 10d): the account picker is now a
 * CONTROLLED select, lifted to `ManualEntryScreen.tsx` — that sibling
 * component's own ambient strip (§5.9) needs to know which account is
 * selected too, since `getAmbientAccountState` is per-account and the
 * strip must re-fetch the moment this select changes. `onSubmitProceed`
 * (optional) fires on the form's own `onSubmit`, alongside — never
 * blocking or delaying — the real `action={formAction}` submission; see
 * `ManualEntryScreen.tsx`'s `handleProceedPastBreach` for what it does.
 *
 * The `<form>` itself is the flex-growing column that directly contains
 * the `.push`-wrapped submit button (`flex-1` propagated down from
 * `page.tsx`'s `.entry` root through `ManualEntryScreen.tsx` — see that
 * file's own header) — `.push`'s `margin-top: auto` only has free space
 * to consume inside the SAME flex container it's a direct child of.
 */
export function ManualEntryForm({
  accounts,
  accountId,
  onAccountIdChange,
  onSubmitProceed,
}: {
  accounts: { id: string; label: string }[];
  accountId: string;
  onAccountIdChange: (accountId: string) => void;
  onSubmitProceed?: () => void;
}) {
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
    <form action={formAction} onSubmit={onSubmitProceed} noValidate className="flex flex-1 flex-col gap-5">
      <div className="field">
        <label htmlFor="accountId">Account</label>
        <select
          id="accountId"
          name="accountId"
          value={accountId}
          onChange={(e) => onAccountIdChange(e.target.value)}
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

      <div className="field">
        <label htmlFor="instrument">Instrument</label>
        <input id="instrument" name="instrument" autoComplete="off" spellCheck={false} />
        {state?.fieldErrors?.instrument && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.instrument[0]}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="rq-label">Direction</legend>
        <div className="segmented" role="radiogroup" aria-label="Direction">
          {(['long', 'short'] as const).map((d) => (
            <span key={d}>
              <input
                type="radio"
                id={`direction-${d}`}
                name="direction"
                value={d}
                checked={direction === d}
                onChange={() => setDirection(d)}
              />
              <label htmlFor={`direction-${d}`}>{d === 'long' ? 'Long' : 'Short'}</label>
            </span>
          ))}
        </div>
        {state?.fieldErrors?.direction && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.direction[0]}
          </p>
        )}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <div className="field">
          <label htmlFor="size">Size</label>
          <input id="size" name="size" inputMode="decimal" autoComplete="off" className="rq-num" />
          {state?.fieldErrors?.size && (
            <p className="rq-sub" role="alert">
              {state.fieldErrors.size[0]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="entryPrice">Entry price</label>
          <input id="entryPrice" name="entryPrice" inputMode="decimal" autoComplete="off" className="rq-num" />
          {state?.fieldErrors?.entryPrice && (
            <p className="rq-sub" role="alert">
              {state.fieldErrors.entryPrice[0]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="exitPrice">Exit price</label>
          <input id="exitPrice" name="exitPrice" inputMode="decimal" autoComplete="off" className="rq-num" />
          {state?.fieldErrors?.exitPrice && (
            <p className="rq-sub" role="alert">
              {state.fieldErrors.exitPrice[0]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="stop">Stop (optional)</label>
          <input id="stop" name="stop" inputMode="decimal" autoComplete="off" className="rq-num" />
          {state?.fieldErrors?.stop && (
            <p className="rq-sub" role="alert">
              {state.fieldErrors.stop[0]}
            </p>
          )}
        </div>
      </div>

      {state?.error && (
        <div className="alert" role="alert">
          <p>{state.error.user_message}</p>
        </div>
      )}

      <div className="push">
        <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
          {pending ? 'Logging…' : 'Log trade'}
        </button>
      </div>
    </form>
  );
}
