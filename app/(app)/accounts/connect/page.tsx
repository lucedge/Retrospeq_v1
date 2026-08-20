'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { connectAccount, type AccountActionState } from '../actions';
import { PLATFORM_LABELS, isCredentialedPlatform } from '@/lib/broker/platform-defaults';
import type { Platform } from '@/lib/broker/adapter';

/**
 * Module 01 §5.2's connect-account reference markup, adapted to this
 * repo's actual design-system classes (rq-h1/rq-label/rq-btn/rq-pill;
 * there is no `.segmented`/`.field`/`.alert`/`.capability` class in
 * retrospeq-design-system/brand — those are the spec's illustrative
 * names, not real selectors here) — see app/(auth)/login|signup/page.tsx
 * for the established useActionState + inline-field-error pattern this
 * follows.
 *
 * §5.2's "verification progress with named steps" is a genuinely async,
 * multi-step UI for a real adapter's network round trip. There is no
 * real adapter yet (this form only ever talks to the fixture adapter via
 * `connectAccount`, see that Server Action's own header comment) so the
 * whole connect attempt resolves in one request — the pending state on
 * the submit button is the honest equivalent for this slice, per the
 * dispatch. A future real-adapter slice can add the real multi-step
 * `aria-live` sequence.
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
    <section className="flex flex-col gap-6" aria-labelledby="connect-h">
      <div className="flex flex-col gap-1">
        <h1 id="connect-h" className="rq-h1">
          Connect your trading account
        </h1>
        <p className="rq-body">
          We ask for your <strong>investor password</strong> or a read-only API key — never a
          credential that can place, modify or close trades. If you paste one that can trade, we
          will reject it and explain why.
        </p>
      </div>

      <form action={formAction} noValidate className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="rq-label">Platform</legend>
          <div className="rq-pills" role="radiogroup" aria-label="Platform">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={platform === p}
                className={platform === p ? 'rq-pill on' : 'rq-pill'}
                onClick={() => setPlatform(p)}
              >
                {PLATFORM_LABELS[p]}
              </button>
            ))}
          </div>
          <input type="hidden" name="platform" value={platform} />
          {state?.fieldErrors?.platform && (
            <p className="rq-sub" role="alert">
              {state.fieldErrors.platform[0]}
            </p>
          )}
        </fieldset>

        {credentialed ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="server" className="rq-label">
                Broker server
              </label>
              <input
                id="server"
                name="server"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="server-hint"
                className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
              />
              <p id="server-hint" className="rq-sub">
                Shown in your terminal under Account.
              </p>
              {state?.fieldErrors?.server && (
                <p className="rq-sub" role="alert">
                  {state.fieldErrors.server[0]}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="login" className="rq-label">
                Account number
              </label>
              <input
                id="login"
                name="login"
                inputMode="numeric"
                autoComplete="off"
                className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
              />
              {state?.fieldErrors?.login && (
                <p className="rq-sub" role="alert">
                  {state.fieldErrors.login[0]}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="credential" className="rq-label">
                {platform === 'binance' || platform === 'bybit' ? 'Read-only API key' : 'Investor password'}
              </label>
              <input
                id="credential"
                name="credential"
                type="password"
                autoComplete="off"
                data-sensitive="true"
                aria-describedby="cred-hint"
                className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
              />
              <p id="cred-hint" className="rq-sub">
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

        {state?.error?.code === 'CONNECT_CREDENTIAL_TOO_PERMISSIVE' && (
          <div className="rq-well flex flex-col gap-2" role="alert">
            <h2 className="rq-h2">That password can place trades</h2>
            <p className="rq-body">
              We did not save it. Please use your investor password instead — it gives us the
              same history without the ability to trade.
            </p>
          </div>
        )}

        {state?.error && state.error.code !== 'CONNECT_CREDENTIAL_TOO_PERMISSIVE' && (
          <p className="rq-sub" role="alert">
            {state.error.user_message}
          </p>
        )}

        <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
          {pending ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </section>
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
    <section className="flex flex-col gap-4" role="status">
      <h1 className="rq-h1">Connected</h1>
      {isManual && (
        <p className="rq-body">
          Manual accounts have no broker connection — you&rsquo;ll log trades yourself.
        </p>
      )}
      <ul className="flex flex-col gap-2">
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
      <Link href="/accounts" className="rq-btn rq-btn--block">
        Go to your accounts
      </Link>
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
  const unavailableLabel = isManual ? 'Entered manually, not synced' : 'Not available on this broker';
  return (
    <li className="flex items-center justify-between rq-well">
      <span className="rq-body">{label}</span>
      <span className={available ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}>
        {available ? 'Available' : unavailableLabel}
      </span>
    </li>
  );
}
