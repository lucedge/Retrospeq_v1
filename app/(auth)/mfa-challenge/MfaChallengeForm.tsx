'use client';

import { useActionState } from 'react';
import { verifyMfaChallenge } from './actions';

/** Frame 6.3's `.field` + `.code` input: mono, tabular, tracked out, and
 *  the only thing on the screen that takes a keyboard. */
export function MfaChallengeForm() {
  const [state, formAction, pending] = useActionState(verifyMfaChallenge, undefined);

  return (
    <form action={formAction} noValidate className="auth">
      <div className="field">
        <label htmlFor="code">Code</label>
        <input
          id="code"
          name="code"
          className="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          spellCheck={false}
          // 7, not the frame's 6: `totpCodeSchema` strips whitespace, so
          // one space of slack lets a pasted "482 913" through.
          maxLength={7}
          required
          autoFocus
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
        {pending ? 'Verifying…' : 'Verify'}
      </button>
    </form>
  );
}
