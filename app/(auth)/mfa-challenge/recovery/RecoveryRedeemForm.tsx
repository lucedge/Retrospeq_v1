'use client';

import { useActionState } from 'react';
import { redeemRecoveryCodeAction } from './actions';

export function RecoveryRedeemForm() {
  const [state, formAction, pending] = useActionState(redeemRecoveryCodeAction, undefined);

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="code" className="rq-label">
          Recovery code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          autoComplete="off"
          spellCheck={false}
          required
          autoFocus
          placeholder="XXXX-XXXX-XXXX-XXXX"
          aria-describedby={state?.fieldErrors?.code ? 'code-error' : undefined}
          className="rq-num rounded-md border border-line bg-surface px-3 py-2.5 text-base text-ink"
        />
        {state?.fieldErrors?.code && (
          <p id="code-error" className="rq-sub" role="alert">
            {state.fieldErrors.code[0]}
          </p>
        )}
      </div>

      {state?.error && (
        <p className="rq-sub" role="alert">
          {state.error.user_message}
        </p>
      )}

      <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
        {pending ? 'Checking…' : 'Use this code'}
      </button>
    </form>
  );
}
