/**
 * Client-side deadline for an awaited Server Action call — Module 04
 * Slice 10e bug-fix pass (2026-08-31), closing a real, reproduced bug the
 * independent tester found: a `try`/`catch` around an `await someAction()`
 * call only catches a REJECTION. A Server Action call whose underlying
 * network stream hangs (the tester correlated this with a known
 * dev-server/Turbopack "destination stream closed early" artifact, but the
 * UI gap is real regardless of what triggers the hang in any given
 * environment) produces neither a resolve nor a reject — the promise never
 * SETTLES at all — so the surrounding `catch` block never runs, `busy`/
 * `swapBusy` never clears, and every control in `RuleList.tsx` stays
 * `disabled` forever with no error shown and no way out.
 *
 * `Promise.race` is the fix: Server Actions don't expose an
 * `AbortController` the way `fetch` does (there is no way to actually
 * cancel the in-flight action from the client), so this does not abort
 * anything server-side — it forces the CLIENT's own awaited promise to
 * settle (by rejecting) after `timeoutMs`, regardless of whether the
 * underlying action promise ever does. That is sufficient to close the
 * bug: `RuleList.tsx`'s existing `catch` blocks already reset every
 * `busy`/`swapBusy` flag and show an honest message once ANY rejection
 * reaches them — the only gap was that a hang could never reach them at
 * all. The abandoned original promise is left to settle in the background
 * (its own `.then`/`.catch` here is a no-op once the race is already
 * decided) — if it eventually succeeds, `revalidatePath('/rules')` (already
 * called by every mutating action in `app/(app)/rules/actions.ts`) is the
 * same eventual-correction mechanism this app already relies on for the
 * "client gave up before the server finished" class of gap; the caller-side
 * message this timeout produces is written to say exactly that (see
 * `RuleList.tsx`'s `TIMEOUT_ERROR_MESSAGE`), not to claim the action never
 * happened.
 */

export class ActionTimeoutError extends Error {
  constructor(message = 'Timed out waiting for a response.') {
    super(message);
    this.name = 'ActionTimeoutError';
  }
}

/**
 * Races `promise` against a `timeoutMs` deadline. Resolves/rejects exactly
 * as `promise` would if it settles first; rejects with `ActionTimeoutError`
 * if `timeoutMs` elapses first. The deadline timer is always cleared once
 * `promise` itself settles (whichever happens first), so a fast-resolving
 * call never leaves a dangling timer running.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ActionTimeoutError(`Timed out after ${timeoutMs}ms waiting for a response.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
