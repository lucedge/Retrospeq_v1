'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import {
  disconnectAccount,
  updateAccountSettings,
  type AccountSettingsActionState,
} from '../../actions';
// Value import (ACCOUNT_KINDS) from `platform-defaults.ts`, never from
// `accounts-repository.ts` — the latter pulls in `import 'server-only'`
// + direct-`pg` at module scope, which must never reach a client bundle
// (see platform-defaults.ts's comment on this). `TradingAccountRow` is
// imported `type`-only below so it's fully erased at compile time and
// carries no such risk.
import { ACCOUNT_KINDS, PLATFORM_LABELS, type AccountKind } from '@/lib/broker/platform-defaults';
import type { Platform } from '@/lib/broker/adapter';
import type { TradingAccountRow } from '@/lib/broker/accounts-repository';

/**
 * Module 01 §4.5 account settings, built against frame 6.6
 * (`brand/docs/screens/account.html#6.6`): the account's own label as
 * the `<h1>`, platform and account number as the subline, then the
 * editable `.field`s, then — below an `.rq-hr` — the disconnect row
 * explained in plain words, as a `.link`, never a red button.
 *
 * Two deliberate departures from the frame, both because the capability
 * genuinely isn't there (AGENTS.md "never fake it"):
 *  - **Base currency is read-only.** `updateTradingAccountSettingsInputSchema`
 *    accepts `label`/`dayRollover`/`accountKind` only; it is set from the
 *    platform's default at connect time. An editable-looking input that
 *    silently can't save is worse than saying so.
 *  - **No "Delete this account" row.** There is no delete Server Action —
 *    only `disconnectAccount`. Account-wide deletion lives on /privacy
 *    (Module 01 story 5.2). Tracked as a gap on inventory row 6.6 rather
 *    than shipped as a button that does nothing.
 */

const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  personal: 'Personal',
  prop: 'Prop challenge',
  demo: 'Demo',
};

export function AccountSettingsForm({
  accountId,
  account,
}: {
  accountId: string;
  account: TradingAccountRow;
}) {
  const boundAction = updateAccountSettings.bind(null, accountId);
  const [state, formAction, pending] = useActionState<AccountSettingsActionState | undefined, FormData>(
    boundAction,
    undefined,
  );

  // Reflects the last save when there was one, otherwise the page's own
  // initial read.
  const current = state?.success && state.account ? state.account : account;

  // Controlled, not `defaultValue` — a real bug caught in this slice's
  // own screenshot self-check: `revalidatePath` inside a *prior*
  // successful save can cause Next to refetch this route's server
  // props before a *later* failed submission's own re-render, which
  // reset an uncontrolled `defaultValue` input back to the last-saved
  // server value and silently discarded whatever invalid text the
  // trader had just typed, right on top of the validation error
  // telling them to fix it. Controlled state only ever changes from
  // typing or a confirmed successful save (the effect below), never
  // from an unrelated server refetch.
  const [label, setLabel] = useState(current.label);
  const [dayRollover, setDayRollover] = useState(current.day_rollover);
  const [accountKind, setAccountKind] = useState<AccountKind>(current.account_kind as AccountKind);

  // React's own recommended "adjusting state during render" pattern
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // rather than a `useEffect` — a plain `useEffect([state])` here
  // trips `react-hooks/set-state-in-effect` (setState synchronously
  // inside an effect body) and, more importantly, would still run
  // one commit late. `syncedState` gates this to exactly once per new
  // `state` object identity (a fresh one only ever appears after a
  // real Server Action round trip), so this never loops.
  const [syncedState, setSyncedState] = useState(state);
  if (state !== syncedState && state?.success && state.account) {
    setSyncedState(state);
    setLabel(state.account.label);
    setDayRollover(state.account.day_rollover);
    setAccountKind(state.account.account_kind as AccountKind);
  }

  const platformLabel =
    PLATFORM_LABELS[account.platform as Platform] ?? account.platform;

  return (
    <section className="account-settings flex flex-col gap-4" aria-labelledby="settings-h">
      <div className="flex flex-col gap-1">
        <h1 id="settings-h" className="rq-h1">
          {current.label}
        </h1>
        <p className="rq-sub">
          {platformLabel}
          {account.provider_ref ? (
            <>
              {' · account '}
              <span className="rq-num">{account.provider_ref}</span>
            </>
          ) : null}
        </p>
        <Link href="/accounts" className="link self-start">
          Back to accounts
        </Link>
      </div>

      {state?.success && (
        <p className="rq-sub" role="status">
          Saved.
        </p>
      )}

      {state?.error && (
        <div className="alert alert--blocking" role="alert">
          <p>{state.error.user_message}</p>
        </div>
      )}

      <form action={formAction} noValidate className="flex flex-col gap-4">
        <div className="field">
          <label htmlFor="label">Label</label>
          <input
            id="label"
            name="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoComplete="off"
            maxLength={40}
            aria-describedby="label-hint"
          />
          <p id="label-hint" className="hint">
            Up to 40 characters — how you’ll tell this account apart from your others.
          </p>
          {state?.fieldErrors?.label && (
            <p className="hint" role="alert">
              {state.fieldErrors.label[0]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="dayRollover">Day ends</label>
          <input
            id="dayRollover"
            name="dayRollover"
            value={dayRollover}
            onChange={(e) => setDayRollover(e.target.value)}
            autoComplete="off"
            aria-describedby="rollover-hint"
            className="rq-num"
          />
          <p id="rollover-hint" className="hint">
            Sets which trades belong to which day, e.g. &lsquo;America/New_York 17:00&rsquo; for a
            forex broker&rsquo;s rollover or &lsquo;00:00:00 UTC&rsquo; for a crypto exchange.
            Change it only if your broker&rsquo;s rollover differs.
          </p>
          {state?.fieldErrors?.dayRollover && (
            <p className="hint" role="alert">
              {state.fieldErrors.dayRollover[0]}
            </p>
          )}
        </div>

        <div className="field">
          <span className="rq-label" id="base-currency-label">
            Base currency
          </span>
          {/* Read-only on purpose — see this file's header. Rendered as a
              value, not a disabled-looking input, so it never reads as
              something that failed to save. */}
          <p className="rq-num text-base" aria-labelledby="base-currency-label">
            {account.base_currency}
          </p>
          <p className="hint">
            Set from your platform when you connected this account. Changing it isn’t
            supported yet.
          </p>
        </div>

        <fieldset className="field">
          <legend className="rq-label">Account type</legend>
          <div className="segmented">
            {ACCOUNT_KINDS.map((kind) => (
              <span key={kind}>
                <input
                  type="radio"
                  id={`account-kind-${kind}`}
                  name="accountKind"
                  value={kind}
                  checked={accountKind === kind}
                  onChange={() => setAccountKind(kind)}
                />
                <label htmlFor={`account-kind-${kind}`}>{ACCOUNT_KIND_LABELS[kind]}</label>
              </span>
            ))}
          </div>
          {/* Story 3.4 (v1.1 stub): marking prop stores the label only —
              no firm rulebook exists yet (Module 09, v1.1). Said plainly
              so a trader doesn't expect firm-rule enforcement today. */}
          {accountKind === 'prop' && (
            <p className="hint">
              Firm rulebook features are coming soon. This only labels the account for now.
            </p>
          )}
          {state?.fieldErrors?.accountKind && (
            <p className="hint" role="alert">
              {state.fieldErrors.accountKind[0]}
            </p>
          )}
        </fieldset>

        <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>

      <hr className="rq-hr" />

      <form action={disconnectAccount.bind(null, accountId)} className="settings__row">
        <span className="settings__label">
          <b>Disconnect</b>
          <span>Stops syncing. Keeps your history and findings.</span>
        </span>
        <button type="submit" className="link">
          Disconnect
        </button>
      </form>
    </section>
  );
}
