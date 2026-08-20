'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import {
  updateAccountSettings,
  type AccountSettingsActionState,
} from '../../actions';
// Value import (ACCOUNT_KINDS) from `platform-defaults.ts`, never from
// `accounts-repository.ts` — the latter pulls in `import 'server-only'`
// + direct-`pg` at module scope, which must never reach a client bundle
// (see platform-defaults.ts's comment on this). `TradingAccountRow` is
// imported `type`-only below so it's fully erased at compile time and
// carries no such risk.
import { ACCOUNT_KINDS, type AccountKind } from '@/lib/broker/platform-defaults';
import type { TradingAccountRow } from '@/lib/broker/accounts-repository';

/**
 * Module 01 §5.2's `.rq-pills`/field markup, same adaptation
 * `app/(app)/accounts/connect/page.tsx` already made from the spec's
 * illustrative `.segmented`/`.field` classes to this repo's real
 * design-system selectors.
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

  return (
    <section className="flex flex-col gap-6" aria-labelledby="settings-h">
      <div className="flex items-center justify-between">
        <h1 id="settings-h" className="rq-h1">
          Account settings
        </h1>
        <Link href="/accounts" className="rq-btn rq-btn--ghost">
          Back to accounts
        </Link>
      </div>

      {state?.success && (
        <p className="rq-sub" role="status">
          Saved.
        </p>
      )}

      {state?.error && (
        <p className="rq-sub" role="alert">
          {state.error.user_message}
        </p>
      )}

      <form action={formAction} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="label" className="rq-label">
            Label
          </label>
          <input
            id="label"
            name="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoComplete="off"
            maxLength={40}
            aria-describedby="label-hint"
            className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
          />
          <p id="label-hint" className="rq-sub">
            Up to 40 characters — how you&apos;ll tell this account apart from your others.
          </p>
          {state?.fieldErrors?.label && (
            <p className="rq-sub" role="alert">
              {state.fieldErrors.label[0]}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="dayRollover" className="rq-label">
            Day ends
          </label>
          <input
            id="dayRollover"
            name="dayRollover"
            value={dayRollover}
            onChange={(e) => setDayRollover(e.target.value)}
            autoComplete="off"
            aria-describedby="rollover-hint"
            className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-base"
          />
          <p id="rollover-hint" className="rq-sub">
            Story 3.1/3.2: broker rollover for forex, e.g. &lsquo;America/New_York 17:00&rsquo; —
            or &lsquo;00:00:00 UTC&rsquo; to match a crypto exchange.
          </p>
          {state?.fieldErrors?.dayRollover && (
            <p className="rq-sub" role="alert">
              {state.fieldErrors.dayRollover[0]}
            </p>
          )}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="rq-label">Account type</legend>
          <div className="rq-pills" role="radiogroup" aria-label="Account type">
            {ACCOUNT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={accountKind === kind}
                className={accountKind === kind ? 'rq-pill on' : 'rq-pill'}
                onClick={() => setAccountKind(kind)}
              >
                {ACCOUNT_KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          <input type="hidden" name="accountKind" value={accountKind} />
          {/* Story 3.4 (v1.1 stub): marking prop stores the label only —
              no firm rulebook exists yet (Module 09, v1.1). Said plainly
              so a trader doesn't expect firm-rule enforcement today. */}
          {accountKind === 'prop' && (
            <p className="rq-sub">
              Firm rulebook features are coming soon. This only labels the account for now.
            </p>
          )}
          {state?.fieldErrors?.accountKind && (
            <p className="rq-sub" role="alert">
              {state.fieldErrors.accountKind[0]}
            </p>
          )}
        </fieldset>

        <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>
    </section>
  );
}
