'use client';

import { useActionState } from 'react';
import { confirmPasswordReset } from '../../actions';

/**
 * Reached only after app/auth/callback/route.ts has exchanged the
 * emailed reset link's code for a recovery session — this page itself
 * has no access to (and never sees) the reset token. Composed from
 * frame 6.1's `.auth` stack (inventory row 6.2 has no frame of its own).
 */
export default function ResetPasswordConfirmPage() {
  const [state, formAction, pending] = useActionState(confirmPasswordReset, undefined);

  return (
    <div className="auth">
      <div>
        <h1 className="rq-h1">Choose a new password</h1>
        <p className="auth__thesis">This link is single-use and expires shortly.</p>
      </div>

      <form action={formAction} noValidate className="auth">
        <div className="field">
          <label htmlFor="password">New password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            aria-describedby={state?.fieldErrors?.password ? 'password-error' : undefined}
          />
          {state?.fieldErrors?.password && (
            <p id="password-error" className="hint" role="alert">
              {state.fieldErrors.password[0]}
            </p>
          )}
        </div>

        {state?.error && (
          <div className="alert alert--blocking">
            <p role="alert">{state.error.user_message}</p>
          </div>
        )}

        <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
          {pending ? 'Updating…' : 'Set new password'}
        </button>
      </form>
    </div>
  );
}
