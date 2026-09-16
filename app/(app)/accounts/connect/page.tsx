'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { connectAccount, type AccountActionState } from '../actions';
import { PLATFORM_LABELS, isCredentialedPlatform } from '@/lib/broker/platform-defaults';
import type { Platform } from '@/lib/broker/adapter';

/**
 * UI batch 1b restyle of Module 01 §5.2's connect-account reference
 * markup, against `brand/docs/screens/home-onboarding.html#1.2` /
 * `#1.4` / `#1.5` (inventory rows 1.2/1.3/1.4/1.5). `.segmented`,
 * `.field`, `.explainer`, `.hint`, `.alert`/`.alert--blocking`,
 * `.capability`, and `.push` are all real, already-shipped classes in
 * `retrospeq-design-system/brand/css/components.css` (committed in the
 * "Design program batch 6" pass, well before this slice) — the previous
 * version of this file claimed "there is no `.segmented`/`.field`/
 * `.alert`/`.capability` class in retrospeq-design-system/brand", which
 * was stale by the time it was written, not a decision anyone made;
 * corrected here.
 *
 * Root element is a single `<form>` (not a `<section>` wrapping a
 * `<form>`) so it can be the SAME flex column that both stretches to
 * fill `app/(app)/layout.tsx`'s `<main>` (`.connect` added to
 * `components.css`'s `.dash, .hook { flex: 1 1 auto }` rule) and
 * directly contains the `.push`-wrapped submit button as a flat child
 * — the same shape `.dash`/`.hook` already use. A `.push` nested two
 * flex-columns deep inside a non-growing wrapper has no free space to
 * push into (this exact bug shipped inert across 35 mockup uses until
 * 2026-09-16, see `components.css`'s own comment on `.push`).
 *
 * §5.2's "verification progress with named steps" (frame 1.3, `.verify`
 * ol) describes a genuinely async, multi-step broker round trip. There
 * is still no real adapter (`connectAccount`'s own header comment) —
 * the whole attempt resolves in one Server Action call, so a fabricated
 * multi-item checklist that "advances" on a fixed timer would be
 * exactly the invented progress AGENTS.md's "never fake it" forbids.
 * Kept the prior slice's honest equivalent (the pending state) but
 * swapped the heading/subtext to frame 1.3's own real copy while
 * `pending` is true — that IS an accurate, single-phase description of
 * what's actually happening server-side, unlike a step list with no
 * underlying signal. Inventory 1.3 stays ◐ for this reason, not ●.
 */

const PLATFORMS: Platform[] = ['mt5', 'mt4', 'ctrader', 'binance', 'bybit', 'manual'];

export default function ConnectAccountPage() {
  const [state, formAction, pending] = useActionState<AccountActionState | undefined, FormData>(
    connectAccount,
    undefined,
  );
  const [platform, setPlatform] = useState<Platform>('mt5');
  const credentialed = isCredentialedPlatform(platform);

  if (state?.success) {
    return <ConnectedSummary capabilities={state.capabilities} isManual={state.isManual ?? false} />;
  }

  return (
    <form
      action={formAction}
      noValidate
      aria-labelledby="connect-h"
      className="connect flex flex-1 flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <h1 id="connect-h" className="rq-h1">
          {pending ? 'Checking your account' : 'Connect your trading account'}
        </h1>
        {pending ? (
          <p className="rq-sub" role="status" aria-live="polite">
            This takes a few seconds. We never store a password that can trade.
          </p>
        ) : (
          <p className="explainer">
            We ask for your <strong>investor password</strong> or a{' '}
            <strong>read-only API key</strong> — never a credential that can place, modify or
            close trades. If you paste one that can trade, we will reject it and explain why.
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-2" disabled={pending}>
        <legend className="rq-label">Platform</legend>
        <div className="segmented" role="radiogroup" aria-label="Platform">
          {PLATFORMS.map((p) => (
            <span key={p}>
              <input
                type="radio"
                id={`platform-${p}`}
                name="platform"
                value={p}
                checked={platform === p}
                onChange={() => setPlatform(p)}
              />
              <label htmlFor={`platform-${p}`}>{PLATFORM_LABELS[p]}</label>
            </span>
          ))}
        </div>
        {state?.fieldErrors?.platform && (
          <p className="rq-sub" role="alert">
            {state.fieldErrors.platform[0]}
          </p>
        )}
      </fieldset>

      {credentialed ? (
        <>
          <div className="field">
            <label htmlFor="server">Broker server</label>
            <input
              id="server"
              name="server"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="server-hint"
              disabled={pending}
            />
            <p id="server-hint" className="hint">
              Shown in your terminal under Account.
            </p>
            {state?.fieldErrors?.server && (
              <p className="rq-sub" role="alert">
                {state.fieldErrors.server[0]}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="login">Account number</label>
            <input
              id="login"
              name="login"
              inputMode="numeric"
              autoComplete="off"
              disabled={pending}
            />
            {state?.fieldErrors?.login && (
              <p className="rq-sub" role="alert">
                {state.fieldErrors.login[0]}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="credential">
              {platform === 'binance' || platform === 'bybit' ? 'Read-only API key' : 'Investor password'}
            </label>
            <input
              id="credential"
              name="credential"
              type="password"
              autoComplete="off"
              data-sensitive="true"
              aria-describedby="cred-hint"
              disabled={pending}
            />
            <p id="cred-hint" className="hint">
              Read-only. Never your master password or a key with trade/withdrawal scope.
            </p>
            {state?.fieldErrors?.credential && (
              <p className="rq-sub" role="alert">
                {state.fieldErrors.credential[0]}
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="rq-sub">
          No credentials needed. You&apos;ll log trades yourself — everything except
          auto-import still works.
        </p>
      )}

      {/* `pending` gates every error block below: `useActionState`'s own
          `state` only updates once a submission RESOLVES, so without this
          guard a stale error from a PREVIOUS attempt stays on screen
          (contradicting the "Checking your account" heading above) for
          the whole of a new, still-in-flight submission — caught via the
          screenshot self-check (1.3's "verifying" capture initially showed
          the prior attempt's rejection box under the new pending state). */}
      {!pending && state?.error?.code === 'CONNECT_CREDENTIAL_TOO_PERMISSIVE' && (
        <div className="alert alert--blocking" role="alert">
          <h2>That password can place trades</h2>
          <p>
            We did not save it. Please use your investor password instead — it gives us the
            same history without the ability to trade.
          </p>
        </div>
      )}

      {!pending && state?.error && state.error.code !== 'CONNECT_CREDENTIAL_TOO_PERMISSIVE' && (
        <div className="alert" role="alert">
          <p>{state.error.user_message}</p>
        </div>
      )}

      <div className="push">
        <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
          {pending ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

function ConnectedSummary({
  capabilities,
  isManual,
}: {
  capabilities: AccountActionState['capabilities'];
  isManual: boolean;
}) {
  return (
    <section className="connect flex flex-1 flex-col gap-4" role="status" aria-labelledby="connected-h">
      <div className="flex flex-col gap-1">
        <h1 id="connected-h" className="rq-h1">
          Connected
        </h1>
        <p className="rq-sub">
          {isManual
            ? "Manual accounts have no broker connection — you'll log trades yourself."
            : 'Here is what this broker gives us — including what it doesn’t.'}
        </p>
      </div>
      <div className="capability">
        <ul>
          <CapabilityRow
            label="Trade history and fills"
            available={capabilities?.history ?? false}
            isManual={isManual}
          />
          <CapabilityRow
            label="Open positions"
            available={capabilities?.openPositions ?? false}
            isManual={isManual}
          />
          <CapabilityRow
            label="Stop-loss/target changes"
            available={capabilities?.positionSnapshots ?? false}
            isManual={isManual}
          />
        </ul>
      </div>
      {!isManual && (
        <p className="hint">
          Findings that need stop-loss data will say &ldquo;not available on this broker&rdquo;
          rather than guess.
        </p>
      )}
      <div className="push">
        <Link href="/accounts" className="rq-btn rq-btn--block">
          Go to your accounts
        </Link>
      </div>
    </section>
  );
}

function CapabilityRow({
  label,
  available,
  isManual,
}: {
  label: string;
  available: boolean;
  isManual: boolean;
}) {
  // Story 2.7/2.8: "manual mode" has no broker at all, so "not available
  // on this broker" (§5.2's own reference wording) is inaccurate here —
  // there's no broker to attribute the gap to. Flagged by retrospeq-qa.
  const unavailableLabel = isManual ? 'entered manually, not synced' : 'not available on this broker';
  return (
    <li data-available={available ? 'true' : 'false'}>
      {label}
      {!available && <> — {unavailableLabel}</>}
    </li>
  );
}
