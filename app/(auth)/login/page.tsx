'use client';

import Link from 'next/link';
import { Suspense, useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signInWithEmail, signInWithGoogle } from '../actions';

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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="rq-h1">Sign in</h1>
        <p className="rq-sub">Was this a good decision? Not: did this trade make money?</p>
      </div>

      {resetOk && (
        <p className="rq-sub" role="status">
          Password updated. Sign in with your new password.
        </p>
      )}
      {mfaRecovered && !resetOk && (
        <p className="rq-sub" role="status">
          Two-factor authentication was removed from your account using your recovery
          code. Sign in, then turn it back on from Security if you&apos;d like.
        </p>
      )}
      {oauthError && !resetOk && !mfaRecovered && (
        <p className="rq-sub" role="alert">
          {oauthError === 'AUTH_RATE_LIMITED'
            ? 'Too many attempts. Please wait a few minutes and try again.'
            : "We couldn’t complete sign-in with Google. Please try again."}
        </p>
      )}

      <form action={formAction} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="rq-label">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            aria-describedby={state?.fieldErrors?.email ? 'email-error' : undefined}
            className="rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
          />
          {state?.fieldErrors?.email && (
            <p id="email-error" className="rq-sub" role="alert">
              {state.fieldErrors.email[0]}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="password" className="rq-label">
              Password
            </label>
            <Link href="/reset-password" className="rq-sub underline">
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
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        <span className="rq-label">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <form action={signInWithGoogle}>
        <button type="submit" className="rq-btn rq-btn--ghost rq-btn--block">
          Continue with Google
        </button>
      </form>

      <p className="rq-sub text-center">
        New here?{' '}
        <Link href="/signup" className="underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
