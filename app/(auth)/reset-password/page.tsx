'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { requestPasswordReset } from '../actions';

/**
 * Inventory row 6.2. The mockup has no frame of its own for this
 * screen — it is composed from frames 6.1 (the `.auth` stack, the
 * thesis subline, one primary) and 6.2 (the `.finding` confirmation),
 * per `design-build`'s "compose from the catalogue" rule.
 *
 * **No enumeration.** `requestPasswordReset` returns the same message
 * whether or not an account exists ("If an account exists for that
 * email, a reset link is on its way.") and this screen must keep that
 * property: it never echoes the submitted address back, since repeating
 * "we sent it to you@example.com" the way the signup frame does would
 * read as confirmation that the address is registered. e2e/auth.spec.ts
 * compares the whole `<main>` text between an existing and a
 * non-existent address.
 */
export default function ResetPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, undefined);

  return (
    <div className="auth">
      <div>
        <h1 className="rq-h1">Reset your password</h1>
        <p className="auth__thesis">We&rsquo;ll email you a link to choose a new one.</p>
      </div>

      {state?.success ? (
        <>
          <div className="finding finding--notice" data-confidence="confident">
            <p className="finding__statement" role="status">
              Check your email.
            </p>
            <p className="finding__meta">{state.message}</p>
          </div>
          <p className="hint">Didn’t get it? Check your spam folder.</p>
          <p className="auth__foot">
            <Link href="/login" className="link">
              Back to sign in
            </Link>
          </p>
        </>
      ) : (
        <>
          <form action={formAction} noValidate className="auth">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                spellCheck={false}
                required
                aria-describedby={state?.fieldErrors?.email ? 'email-error' : undefined}
              />
              {state?.fieldErrors?.email && (
                <p id="email-error" className="hint" role="alert">
                  {state.fieldErrors.email[0]}
                </p>
              )}
            </div>

            {state?.error && (
              <div className="alert alert--blocking">
                <p role="alert">{state.error.user_message}</p>
              </div>
            )}

            <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
              {pending ? 'Sending…' : 'Send reset link'}
            </button>
          </form>

          <p className="auth__foot">
            <Link href="/login" className="link">
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
