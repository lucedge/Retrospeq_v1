'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { signUpWithEmail, signInWithGoogle } from '../actions';

export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUpWithEmail, undefined);

  if (state?.success) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="rq-h1">Check your email</h1>
        <p className="rq-body">{state.message}</p>
        <Link href="/login" className="rq-sub underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="rq-h1">Create your account</h1>
        <p className="rq-sub">Was this a good decision? Not: did this trade make money?</p>
      </div>

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
          <label htmlFor="password" className="rq-label">
            Password
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
          {pending ? 'Creating account…' : 'Create account'}
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
        Already have an account?{' '}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
