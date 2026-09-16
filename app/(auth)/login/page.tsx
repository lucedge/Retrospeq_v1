'use client';

import Link from 'next/link';
import { Suspense, useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signInWithEmail, signInWithGoogle } from '../actions';

/**
 * Frame 6.1 (`brand/docs/screens/account.html#6.1`): "the signed-out
 * card: one primary, Google as ghost, the thesis as a quiet subline.
 * Real input types and autocomplete."
 */

// useSearchParams() opts this tree out of static rendering unless
// wrapped in Suspense (Next.js app-router requirement) — the query
// params it reads (`?error=`, `?reset=success`) only ever arrive from
// this module's own redirects (signInWithGoogle's failure path,
// confirmPasswordReset's success path), never from user input.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [state, formAction, pending] = useActionState(signInWithEmail, undefined);
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');
  const resetOk = searchParams.get('reset') === 'success';
  const mfaRecovered = searchParams.get('mfa_recovered') === '1';

  return (
    <div className="auth">
      <div>
        <h1 className="rq-h1">Sign in</h1>
        <p className="auth__thesis">Was this a good decision? Not: did this trade make money.</p>
      </div>

      {resetOk && (
        <p className="hint" role="status">
          Password updated. Sign in with your new password.
        </p>
      )}
      {mfaRecovered && !resetOk && (
        <p className="hint" role="status">
          Two-factor authentication was removed from your account using your recovery code.
          Sign in, then turn it back on from Security if you&apos;d like.
        </p>
      )}
      {oauthError && !resetOk && !mfaRecovered && (
        <div className="alert alert--blocking">
          <p role="alert">
            {oauthError === 'AUTH_RATE_LIMITED'
              ? 'Too many attempts. Please wait a few minutes and try again.'
              : 'We couldn’t complete sign-in with Google. Please try again.'}
          </p>
        </div>
      )}

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

        <div className="field">
          <div className="field__row">
            <label htmlFor="password">Password</label>
            <Link href="/reset-password" className="link text-xs">
              Forgot?
            </Link>
          </div>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
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
          {pending ? 'Signing in…' : 'Sign in'}
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
        New here?{' '}
        <Link href="/signup" className="link">
          Create an account
        </Link>
      </p>
    </div>
  );
}
