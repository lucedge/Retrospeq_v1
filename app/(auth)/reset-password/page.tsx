'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { requestPasswordReset } from '../actions';

export default function ResetPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, undefined);

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
        <h1 className="rq-h1">Reset your password</h1>
        <p className="rq-sub">We&rsquo;ll email you a link to choose a new one.</p>
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

        {state?.error && (
          <p className="rq-sub" role="alert">
            {state.error.user_message}
          </p>
        )}

        <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
          {pending ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <p className="rq-sub text-center">
        <Link href="/login" className="underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
