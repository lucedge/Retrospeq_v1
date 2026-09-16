'use client';

import { useActionState } from 'react';
import { redeemRecoveryCodeAction } from './actions';

/** Frame 6.3's recovery branch. The code is typed, never displayed back:
 *  this form holds no state of its own, so a redeemed or rejected code
 *  is never re-rendered into the markup. */
export function RecoveryRedeemForm() {
  const [state, formAction, pending] = useActionState(redeemRecoveryCodeAction, undefined);

  return (
    <form action={formAction} noValidate className="auth">
      <div className="field">
        <label htmlFor="code">Recovery code</label>
        <input
          id="code"
          name="code"
          className="rq-num"
          type="text"
          autoComplete="off"
          spellCheck={false}
          required
          autoFocus
          placeholder="XXXX-XXXX-XXXX-XXXX"
          aria-describedby={state?.fieldErrors?.code ? 'code-error' : undefined}
        />
        {state?.fieldErrors?.code && (
          <p id="code-error" className="hint" role="alert">
            {state.fieldErrors.code[0]}
          </p>
        )}
      </div>

      {state?.error && (
        <div className="alert alert--blocking">
          <p role="alert">{state.error.user_message}</p>
        </div>
      )}

      <button type="submit" className="rq-btn rq-btn--block" disabled={pending}>
        {pending ? 'Checking…' : 'Use this code'}
      </button>
    </form>
  );
}
