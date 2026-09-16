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
import { twoFactorSubline } from './format';

interface Props {
  enrolled: boolean;
  factorId: string | null;
  /** "22 Aug", or null when the factor carries no usable timestamp. */
  enrolledOn: string | null;
  /** `null` means nobody counted (no verified factor) — never rendered
   *  as `0 left`, which would read as "you have run out". */
  unusedRecoveryCodeCount: number | null;
  /** `lib/auth/mfa-recovery-codes.ts`'s `RECOVERY_CODE_COUNT`, passed
   *  down from the server component (page.tsx) rather than imported
   *  here directly — that module has `import 'server-only'`, which
   *  would break importing it into this client component. */
  totalRecoveryCodeCount: number;
}

/**
 * Module 01 §5.1 — 2FA + session controls, built against frame 6.8.
 * Client component because the enrollment flow is multi-step (QR → code
 * entry → recovery codes shown once) and needs to hold that step in
 * local state between Server Action round trips, per the design
 * system's own "ONE .rq-btn per view" rule: only one step is ever
 * rendered at a time, so only one primary button is ever on screen.
 *
 * The switch is the frame's affordance, but turning two-factor OFF
 * still takes a second, deliberate step (frame 6.6's own rule:
 * "destructive actions confirm on the next step, never immediately") —
 * flipping it off reveals the confirm, it does not disable anything by
 * itself. Turning it ON leaves the switch off until the code is
 * actually verified: a switch that reads "on" before a factor exists
 * would be a lie about the account's security.
 */
export function SecurityScreenClient({
  enrolled,
  factorId,
  enrolledOn,
  unusedRecoveryCodeCount,
  totalRecoveryCodeCount,
}: Props) {
  const [enrollState, beginAction, beginPending] = useActionState(beginTotpEnrollment, undefined);
  const [confirmState, confirmAction, confirmPending] = useActionState(confirmTotpEnrollment, undefined);
  const [disableState, disableAction, disablePending] = useActionState(disableTotp, undefined);
  const [revokeState, revokeAction, revokePending] = useActionState(revokeOtherSessions, undefined);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  // Once `confirmState.recoveryCodes` exists, the factor is verified and
  // active server-side regardless of what `enrolled`/`factorId` (this
  // render's initial server props) said — reflect that locally so the
  // screen doesn't show a stale "off" state until the next navigation.
  const justEnrolled = Boolean(confirmState?.recoveryCodes) && !acknowledged;
  const showEnrolled = disableState?.success === true ? false : enrolled || justEnrolled;
  const enrollTotp = showEnrolled ? null : (enrollState?.totp ?? null);

  return (
    <>
      {/* The form IS the row: `.settings__row`'s own `flex-shrink: 0` on
          `.switch` only holds if the switch is a direct child — wrapping
          it in a form pushed it off the right edge (caught in this
          slice's own screenshot check). */}
      <form action={beginAction} className="settings__row" data-section="two-factor">
        <span className="settings__label">
          <b>Two-factor authentication</b>
          <span>{twoFactorSubline(showEnrolled, enrolledOn)}</span>
        </span>
        <label className="switch">
          <input
            type="checkbox"
            aria-label="Two-factor authentication"
            checked={showEnrolled}
            disabled={beginPending || disablePending}
            onChange={(e) => {
              if (showEnrolled) {
                // Off direction: reveal the confirm and let the
                // controlled `checked` snap the switch back on — two-
                // factor is still on until the confirm is answered.
                setConfirmingDisable(true);
                return;
              }
              e.currentTarget.form?.requestSubmit();
            }}
          />
          <i />
        </label>
      </form>

      {enrollState?.error && !showEnrolled && (
        <div className="alert alert--blocking">
          <p role="alert">{enrollState.error.user_message}</p>
        </div>
      )}

      {confirmingDisable && showEnrolled && (
        <div className="alert alert--blocking" role="alertdialog" aria-labelledby="disable-2fa-h">
          <h2 id="disable-2fa-h">Turn off two-factor authentication?</h2>
          <p>
            Signing in will need only your password again, and your remaining recovery codes
            stop working.
          </p>
          {disableState?.error && <p role="alert">{disableState.error.user_message}</p>}
          <div className="rq-btn-row">
            <form action={disableAction}>
              <input type="hidden" name="factorId" value={factorId ?? ''} />
              <button
                type="submit"
                className="rq-btn rq-btn--equal rq-btn--block"
                disabled={disablePending}
              >
                {disablePending ? 'Turning off…' : 'Turn it off'}
              </button>
            </form>
            <button
              type="button"
              className="rq-btn rq-btn--equal rq-btn--block"
              onClick={() => setConfirmingDisable(false)}
            >
              Keep it on
            </button>
          </div>
        </div>
      )}

      {justEnrolled && confirmState?.recoveryCodes ? (
        <RecoveryCodesReveal
          codes={confirmState.recoveryCodes}
          onDone={() => setAcknowledged(true)}
        />
      ) : showEnrolled ? (
        <div className="flex flex-col gap-2">
          <p className="rq-label">
            Recovery codes
            {unusedRecoveryCodeCount !== null && (
              <>
                {' · '}
                <span className="rq-num">{unusedRecoveryCodeCount}</span>
                {' of '}
                <span className="rq-num">{totalRecoveryCodeCount}</span> left
              </>
            )}
          </p>
          {/* The codes themselves are stored hashed and shown exactly
              once, at generation — frame 6.8's list of them can only be
              the reveal below, never a re-read. Nothing here echoes a
              code back into the markup. */}
          <p className="hint">
            Each code works once if you lose your authenticator app. They’re shown only
            when they’re generated, so keep the copy you saved.
          </p>
        </div>
      ) : enrollTotp ? (
        <EnrollForm
          totp={enrollTotp}
          confirmState={confirmState}
          confirmAction={confirmAction}
          confirmPending={confirmPending}
        />
      ) : (
        <p className="hint">
          Add an authenticator app (like Authy or Google Authenticator) as a second step when
          you sign in.
        </p>
      )}

      <hr className="rq-hr" />

      <div className="flex flex-col gap-2" data-section="sessions">
        <p className="rq-label">Sessions</p>
        {/* Frame 6.8 lists devices with a per-row sign-out. Supabase Auth
            exposes no session list for a user's own sessions, so there is
            no real list to render — naming that is honest; inventing two
            plausible rows would not be. */}
        <p className="hint">
          There’s no per-device list yet — your sign-ins aren’t something we can list
          back to you. You can end every other session, or end this one too.
        </p>

        {revokeState?.error && (
          <p className="hint" role="alert">
            {revokeState.error.user_message}
          </p>
        )}
        {revokeState?.success && (
          <p className="hint" role="status">
            {revokeState.message}
          </p>
        )}

        <div className="rq-btn-row">
          <form action={revokeAction}>
            <button
              type="submit"
              className="rq-btn rq-btn--ghost rq-btn--block"
              disabled={revokePending}
            >
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
      <p className="hint">
        Scan this code with your authenticator app, or enter the secret manually.
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URI SVG from Supabase, not a static/remote asset Next's <Image> can optimize */}
      <img src={totp.qrCodeSvgDataUri} alt="Authenticator app QR code" width={200} height={200} />
      <div className="field">
        <span className="rq-label" id="totp-secret-label">
          Secret (if you can’t scan)
        </span>
        <code className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-sm" aria-labelledby="totp-secret-label">
          {totp.secret}
        </code>
      </div>

      <input type="hidden" name="factorId" value={totp.factorId} />
      <div className="field">
        <label htmlFor="confirm-code">6-digit code</label>
        <input
          id="confirm-code"
          name="code"
          className="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          required
        />
        {confirmState?.fieldErrors?.code && (
          <p className="hint" role="alert">
            {confirmState.fieldErrors.code[0]}
          </p>
        )}
      </div>

      {confirmState?.error && (
        <div className="alert alert--blocking">
          <p role="alert">{confirmState.error.user_message}</p>
        </div>
      )}

      <button type="submit" className="rq-btn rq-btn--block" disabled={confirmPending}>
        {confirmPending ? 'Verifying…' : 'Verify and turn on'}
      </button>
    </form>
  );
}

function RecoveryCodesReveal({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3" role="alert" aria-live="polite">
      <p className="rq-label">Recovery codes · shown once</p>
      <p className="hint">
        Save these somewhere safe. Each one can be used once if you lose access to your
        authenticator app. They will not be shown again.
      </p>
      <ul className="codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <button type="button" className="rq-btn rq-btn--block" onClick={onDone}>
        I’ve saved these codes
      </button>
    </div>
  );
}
