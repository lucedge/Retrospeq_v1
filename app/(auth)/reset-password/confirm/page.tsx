'use client';

import { useActionState } from 'react';
import { confirmPasswordReset } from '../../actions';

/**
 * Reached only after app/auth/callback/route.ts has exchanged the
 * emailed reset link's code for a recovery session — this page itself
 * has no access to (and never sees) the reset token.
 */
export default function ResetPasswordConfirmPage() {
  const [state, formAction, pending] = useActionState(confirmPasswordReset, undefined);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="rq-h1">Choose a new password</h1>
        <p className="rq-sub">This link is single-use and expires shortly.</p>
      </div>

      <form action={formAction} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="rq-label">
            New password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            aria-describedby={state?.fieldErrors?.password ? 'password-error' : undefined}
            className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
          />
          {state?.fieldErrors?.password && (
            <p id="password-error" className="rq-sub" role="alert">
              {state.fieldErrors.password[0]}
            </p>
          )}
        </div>

        {state?.error && (
          <p className="rq-sub" role="alert">
            {state.error.user_message}
          </p>
        )}

        <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
          {pending ? 'Updating…' : 'Set new password'}
        </button>
      </form>
    </div>
  );
}
