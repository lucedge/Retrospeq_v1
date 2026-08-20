'use client';

import { useActionState, useState } from 'react';
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  revokeOtherSessions,
  revokeAllSessions,
  type SecurityActionState,
} from './actions';

interface Props {
  enrolled: boolean;
  factorId: string | null;
  unusedRecoveryCodeCount: number;
  /** `lib/auth/mfa-recovery-codes.ts`'s `RECOVERY_CODE_COUNT`, passed
   *  down from the server component (page.tsx) rather than imported
   *  here directly — that module has `import 'server-only'`, which
   *  would break importing it into this client component. */
  totalRecoveryCodeCount: number;
}

/**
 * Module 01 §5.1 "Privacy screen" — 2FA + session controls. Client
 * component because the enrollment flow is multi-step (QR -> code entry
 * -> recovery codes shown once) and needs to hold that step in local
 * state between Server Action round trips, per the design system's own
 * "ONE .rq-btn per view" rule: only one step is ever rendered at a time,
 * so only one primary button is ever on screen, even though this page as
 * a whole has several distinct actions available across its two cards.
 */
export function SecurityScreenClient({
  enrolled,
  factorId,
  unusedRecoveryCodeCount,
  totalRecoveryCodeCount,
}: Props) {
  const [enrollState, beginAction, beginPending] = useActionState(beginTotpEnrollment, undefined);
  const [confirmState, confirmAction, confirmPending] = useActionState(confirmTotpEnrollment, undefined);
  const [disableState, disableAction, disablePending] = useActionState(disableTotp, undefined);
  const [revokeState, revokeAction, revokePending] = useActionState(revokeOtherSessions, undefined);
  const [acknowledged, setAcknowledged] = useState(false);

  // Once `confirmState.recoveryCodes` exists, the factor is verified and
  // active server-side regardless of what `enrolled`/`factorId` (this
  // render's initial server props) said — reflect that locally so the
  // screen doesn't show a stale "off" state until the next navigation.
  const justEnrolled = Boolean(confirmState?.recoveryCodes) && !acknowledged;
  const showEnrolled = disableState?.success === true ? false : enrolled || justEnrolled;

  return (
    <>
      <div className="rq-card flex flex-col gap-4" data-section="two-factor">
        <div className="flex items-center justify-between">
          <h2 className="rq-h2">Two-factor authentication</h2>
          <span className={showEnrolled ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}>
            {showEnrolled ? 'On' : 'Off'}
          </span>
        </div>

        {justEnrolled && confirmState?.recoveryCodes ? (
          <RecoveryCodesReveal
            codes={confirmState.recoveryCodes}
            onDone={() => setAcknowledged(true)}
          />
        ) : showEnrolled ? (
          <div className="flex flex-col gap-3">
            <p className="rq-sub">
              Codes from your authenticator app are required to sign in.{' '}
              <span className="rq-num">{unusedRecoveryCodeCount}</span> of{' '}
              <span className="rq-num">{totalRecoveryCodeCount}</span> recovery codes remaining.
            </p>
            <form action={disableAction}>
              <input type="hidden" name="factorId" value={factorId ?? ''} />
              {disableState?.error && (
                <p className="rq-sub" role="alert">
                  {disableState.error.user_message}
                </p>
              )}
              <button type="submit" className="rq-btn rq-btn--ghost" disabled={disablePending}>
                {disablePending ? 'Turning off…' : 'Turn off two-factor authentication'}
              </button>
            </form>
          </div>
        ) : enrollState?.totp ? (
          <EnrollForm
            totp={enrollState.totp}
            confirmState={confirmState}
            confirmAction={confirmAction}
            confirmPending={confirmPending}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="rq-sub">
              Add an authenticator app (like Authy or Google Authenticator) as a second
              step when you sign in.
            </p>
            {enrollState?.error && (
              <p className="rq-sub" role="alert">
                {enrollState.error.user_message}
              </p>
            )}
            <form action={beginAction}>
              <button type="submit" className="rq-btn" disabled={beginPending}>
                {beginPending ? 'Starting…' : 'Enable two-factor authentication'}
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="rq-card flex flex-col gap-4" data-section="sessions">
        <h2 className="rq-h2">Sessions</h2>
        <p className="rq-sub">
          There is no per-device list available yet — Supabase Auth does not expose one
          for your own sessions. You can sign out everywhere else, or sign out of this
          device too.
        </p>

        {revokeState?.error && (
          <p className="rq-sub" role="alert">
            {revokeState.error.user_message}
          </p>
        )}
        {revokeState?.success && (
          <p className="rq-sub" role="status">
            {revokeState.message}
          </p>
        )}

        <div className="rq-btn-row">
          <form action={revokeAction}>
            <button type="submit" className="rq-btn rq-btn--ghost rq-btn--block" disabled={revokePending}>
              {revokePending ? 'Signing out other devices…' : 'Sign out other devices'}
            </button>
          </form>
          <form action={revokeAllSessions}>
            <button type="submit" className="rq-btn rq-btn--ghost rq-btn--block">
              Sign out everywhere
            </button>
          </form>
        </div>
      </div>
    </>
  );
}

function EnrollForm({
  totp,
  confirmState,
  confirmAction,
  confirmPending,
}: {
  totp: NonNullable<SecurityActionState['totp']>;
  confirmState: SecurityActionState | undefined;
  confirmAction: (formData: FormData) => void;
  confirmPending: boolean;
}) {
  return (
    <form action={confirmAction} noValidate className="flex flex-col gap-4">
      <p className="rq-sub">
        Scan this code with your authenticator app, or enter the secret manually.
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URI SVG from Supabase, not a static/remote asset Next's <Image> can optimize */}
      <img src={totp.qrCodeSvgDataUri} alt="Authenticator app QR code" width={200} height={200} />
      <div className="flex flex-col gap-1.5">
        <span className="rq-label">Secret (if you can&apos;t scan)</span>
        <code className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-sm">
          {totp.secret}
        </code>
      </div>

      <input type="hidden" name="factorId" value={totp.factorId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirm-code" className="rq-label">
          6-digit code
        </label>
        <input
          id="confirm-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          required
          className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink tracking-widest"
        />
        {confirmState?.fieldErrors?.code && (
          <p className="rq-sub" role="alert">
            {confirmState.fieldErrors.code[0]}
          </p>
        )}
      </div>

      {confirmState?.error && (
        <p className="rq-sub" role="alert">
          {confirmState.error.user_message}
        </p>
      )}

      <button type="submit" className="rq-btn" disabled={confirmPending}>
        {confirmPending ? 'Verifying…' : 'Verify and turn on'}
      </button>
    </form>
  );
}

function RecoveryCodesReveal({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4" role="alert" aria-live="polite">
      <p className="rq-sub">
        Save these recovery codes somewhere safe. Each one can be used once if you lose
        access to your authenticator app. They will not be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-2">
        {codes.map((code) => (
          <li key={code} className="rq-num rounded-md border border-line bg-surface px-3 py-2 text-sm">
            {code}
          </li>
        ))}
      </ul>
      <button type="button" className="rq-btn" onClick={onDone}>
        I&apos;ve saved these codes
      </button>
    </div>
  );
}
