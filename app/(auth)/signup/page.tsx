'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { signUpWithEmail, signInWithGoogle } from '../actions';

/**
 * Frames 6.1/6.2 (`brand/docs/screens/account.html`): the signed-out
 * stack, then "check your email" as a `.finding` — "two states in one:
 * the normal 'check your email', and the honest mailer-unavailable
 * error the app already maps (AUTH_MAILER_UNAVAILABLE). No enumeration
 * hints."
 *
 * The email is held in local state purely so the confirmation screen can
 * repeat the address the trader just typed (frame 6.2's `.finding__meta`).
 * It is the submitted address, never a lookup, so it says nothing about
 * whether an account exists — signing up with an already-registered
 * address returns this same screen, word for word (e2e/auth.spec.ts).
 *
 * The frame's "or send it again" affordance is deliberately not built:
 * there is no resend Server Action, and a button that does nothing is
 * worse than the spam-folder hint alone. Tracked on inventory row 6.1.
 */
export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUpWithEmail, undefined);
  const [email, setEmail] = useState('');

  return (
    <div className="auth">
      <div>
        <h1 className="rq-h1">Sign up</h1>
        <p className="auth__thesis">Was this a good decision? Not: did this trade make money.</p>
      </div>

      {state?.success ? (
        <>
          <div className="finding finding--notice" data-confidence="confident">
            <p className="finding__statement" role="status">
              Check your email.
            </p>
            <p className="finding__meta">
              {state.message}
              {email ? ` We sent it to ${email}.` : ''}
            </p>
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-describedby={state?.fieldErrors?.email ? 'email-error' : undefined}
              />
              {state?.fieldErrors?.email && (
                <p id="email-error" className="hint" role="alert">
                  {state.fieldErrors.email[0]}
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
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
              {pending ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <div className="auth__or" aria-hidden="true">
            or
          </div>

          <form action={signInWithGoogle}>
            <button type="submit" className="rq-btn rq-btn--ghost rq-btn--block">
              Continue with Google
            </button>
          </form>

          <p className="auth__foot">
            Already have an account?{' '}
            <Link href="/login" className="link">
              Sign in
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
