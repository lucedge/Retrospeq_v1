'use client';

import { useState, useTransition } from 'react';
import { toggleNotADecisionAction } from './actions';

/**
 * Module 02 §4.7 / §5.2's `<label class="not-a-decision">` checkbox,
 * "available on every trade, confirmed or not."
 *
 * **Real bug found and fixed via the mandatory screenshot/interaction
 * self-check, not a code read (2026-08-22):** the first version of this
 * component wrapped a `<form action={formAction}>` from `useActionState`
 * around a CONTROLLED checkbox whose `checked` prop was derived purely
 * from the action's returned `state`, submitted by calling
 * `formRef.current?.requestSubmit()` from the checkbox's own `onChange`.
 * That works for the underlying WRITE (a live-DB probe confirmed
 * `not_a_decision` updated correctly in Postgres both times), but the
 * checkbox's own visual `checked` state never updated in place after a
 * REAL native click — it silently stayed at its pre-click value even
 * once the Server Action had resolved and `state`/`checked` had
 * genuinely recomputed to the new value in the component's own render
 * output (confirmed via a temporary debug dump: the computed `checked`
 * variable flipped correctly, but `document.querySelector('input[type=
 * checkbox]').checked` did not) — a real one after a page reload (fresh
 * mount, fresh server props) but never in place. This is the documented
 * React gotcha where a checkbox's internal `_valueTracker` desyncs once
 * the DOM's `checked` property is toggled by a REAL user click and then
 * reset by React to a *different* value in the same tick (which is
 * exactly what happens here while the action is `pending`) — later
 * updates to the same `checked` prop stop reliably reaching the DOM.
 *
 * **Fix: manage `checked` as local React state, set synchronously
 * inside the SAME `onChange` that the native click already fired**
 * (optimistic update, rolled back on a server error) — the standard,
 * reliable pattern for a controlled checkbox, and it sidesteps the
 * tracker-desync class of bug entirely since React's own reconciliation
 * for the toggle happens in the exact same commit as the native event,
 * never asynchronously after an awaited round trip. The Server Action is
 * called directly as a plain async function (valid for a `'use server'`
 * export imported into a Client Component) rather than through a
 * `<form action>` — there is no multi-field form here to justify one.
 */
export function NotADecisionToggle({ tradeId, initialValue }: { tradeId: string; initialValue: boolean }) {
  const [checked, setChecked] = useState(initialValue);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(nextChecked: boolean) {
    const previous = checked;
    setChecked(nextChecked);
    setErrorMessage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('value', nextChecked.toString());
      const result = await toggleNotADecisionAction(tradeId, undefined, formData);
      if (result.error) {
        // Roll back the optimistic flip — never leave the checkbox
        // showing a state the backend didn't actually accept.
        setChecked(previous);
        setErrorMessage(result.error.user_message);
        return;
      }
      if (typeof result.value === 'boolean') {
        setChecked(result.value);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={isPending}
          onChange={(e) => handleChange(e.target.checked)}
          aria-describedby={`not-a-decision-hint-${tradeId}`}
        />
        <span className="rq-body">Not a decision</span>
      </label>
      <p id={`not-a-decision-hint-${tradeId}`} className="rq-sub">
        Stays in your P&amp;L, excluded from analysis.
      </p>
      {errorMessage && (
        <p className="rq-sub" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
