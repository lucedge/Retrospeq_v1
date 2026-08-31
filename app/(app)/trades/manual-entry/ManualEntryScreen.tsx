'use client';

import { useEffect, useRef, useState } from 'react';
import type { AmbientAccountState } from '@/lib/rules/ambient-state';
import { fetchAmbientState, recordOverride } from '../../rules/actions';
import { AmbientStrip } from './AmbientStrip';
import { ManualEntryForm } from './ManualEntryForm';

/**
 * Module 04 (Rulebook & Evaluation) §5.9 UI — Slice 10d. The client-side
 * container `page.tsx` (a Server Component) hands off to: owns the
 * currently-selected account id (previously an uncontrolled `<select>`
 * living entirely inside `ManualEntryForm.tsx`, now lifted here since the
 * ambient strip is a SIBLING that also needs to know which account is
 * selected, per this slice's own dispatch — `getAmbientAccountState` is
 * per-account, and the account is chosen inside this client-rendered
 * form, so nothing server-rendered alone can react to a switch).
 *
 * `page.tsx` still does one real server-side read (the account list PLUS
 * an initial `getAmbientAccountState` for the default account) so the
 * ambient strip has real data on first paint, not a loading flash for the
 * common case of a trader who never switches accounts — every SUBSEQUENT
 * switch re-fetches via `fetchAmbientState` (`app/(app)/rules/actions.ts`),
 * the same "Server Action wraps a read-only lib function, called live from
 * a client effect" shape `GuidedFrontDoor.tsx` already established for
 * `previewRule`.
 *
 * `initialAmbientError`: `page.tsx`'s own SSR call to `getAmbientAccountState`
 * is wrapped in the SAME try/catch shape `fetchAmbientState` already uses
 * (see that Server Action's header) — a genuinely malformed rule
 * (`RuleEvaluationError`, deliberately uncaught INSIDE `getAmbientAccountState`
 * itself) must degrade only the ambient section on first paint too, not
 * just on a later account switch. Seeding `ambientError`'s initial state
 * from this prop reuses the exact rendered fallback below (no second error
 * UI invented) — the rest of this screen (account picker, the form itself)
 * is unaffected either way.
 */
export function ManualEntryScreen({
  accounts,
  initialAccountId,
  initialAmbient,
  initialAmbientError = null,
}: {
  accounts: { id: string; label: string }[];
  initialAccountId: string;
  initialAmbient: AmbientAccountState | null;
  initialAmbientError?: string | null;
}) {
  const [accountId, setAccountId] = useState(initialAccountId);
  const [ambient, setAmbient] = useState<AmbientAccountState | null>(initialAmbient);
  const [ambientLoading, setAmbientLoading] = useState(false);
  const [ambientError, setAmbientError] = useState<string | null>(initialAmbientError);
  const requestIdRef = useRef(0);
  // The account id `ambient`'s CURRENT data actually reflects — starts at
  // `initialAccountId` since `page.tsx` already fetched that one
  // server-side. A VALUE comparison, not an invocation-COUNT ref: an
  // earlier version of this guard used a plain `useRef(false)` "have we
  // run once yet" flag, which is silently WRONG under React's Strict Mode
  // (`next dev`'s default) — Strict Mode deliberately double-invokes every
  // effect once per real mount to surface impure effects, and a
  // count-based guard consumes its "first run" on the THROWAWAY invocation,
  // letting the SECOND (kept) invocation fall through into the "real
  // fetch" branch and wipe `ambient` back to `null` for an account that
  // never actually changed — reproduced directly (a genuine, unwanted
  // extra `fetchAmbientState` round trip firing on every ordinary page
  // load, confirmed via added instrumentation before this fix, not
  // assumed). Comparing VALUES instead of counting invocations is
  // idempotent regardless of how many times Strict Mode (or any future
  // remount-simulating React feature) calls this effect for the SAME
  // `accountId` — only a genuine value change ever triggers a real fetch.
  const lastFetchedAccountId = useRef(initialAccountId);

  useEffect(() => {
    if (accountId === lastFetchedAccountId.current) return;
    lastFetchedAccountId.current = accountId;

    const thisRequestId = ++requestIdRef.current;
    // Blank the strip immediately on switch rather than leaving the
    // PREVIOUS account's facts on screen under the new account's label —
    // showing stale numbers next to a changed selection would be exactly
    // the kind of fabricated-looking state AGENTS.md's "never fake it"
    // forbids, even for the brief moment before the real read resolves.
    setAmbient(null);
    setAmbientLoading(true);
    setAmbientError(null);
    fetchAmbientState(accountId)
      .then((result) => {
        if (requestIdRef.current !== thisRequestId) return; // a newer switch superseded this request
        if (result.success && result.state) {
          setAmbient(result.state);
        } else {
          setAmbientError(result.error?.user_message ?? 'Account state is unavailable right now.');
        }
      })
      .catch(() => {
        if (requestIdRef.current !== thisRequestId) return;
        setAmbientError('Account state is unavailable right now.');
      })
      .finally(() => {
        if (requestIdRef.current === thisRequestId) setAmbientLoading(false);
      });
  }, [accountId]);

  /**
   * §5.9, verbatim: "When the trader proceeds past a visible breach, write
   * a `rule_overrides` row. Not a penalty... No modal, no confirm step, no
   * acknowledgment. Never blocks." Wired as the manual-entry form's own
   * `onSubmit` — fired the instant the trader clicks "Log trade," in
   * parallel with (never awaited by, never able to delay or fail) the real
   * `createManualTradeAction` Server Action the form's own `action` prop
   * still runs normally. Every currently-`breach`-tinted rule (a broken
   * HARD rule — the ambient engine's own tint vocabulary, `watch` for a
   * broken SOFT rule is deliberately NOT overridden here, matching this
   * slice's own dispatch: "For each AmbientRuleState with tint ===
   * 'breach'...") gets its own `rule_overrides` row.
   *
   * `tradeId: null` always — per this slice's own dispatch and
   * `rule-overrides-repository.ts`'s own header ("an override can occur
   * pre-entry, before any trade row exists yet"): this fires at the
   * moment of the decision to proceed, which is the pre-entry moment
   * §5.9's own flow diagram describes, not a later "attach it to whatever
   * trade this becomes" step — this repo's own `RecordOverrideInput`
   * shape (`tradeId: string | null`) exists exactly to represent that
   * moment without needing a trade row to already exist.
   */
  function handleProceedPastBreach() {
    if (!ambient) return;
    for (const rule of ambient.rules) {
      if (rule.tint !== 'breach') continue;
      recordOverride({ ruleId: rule.ruleId, tradeId: null, observed: rule.observed }).catch((err) => {
        console.error('[manual-entry] recordOverride failed:', err);
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <AmbientStrip state={ambient} loading={ambientLoading} />
      {ambientError && (
        <p className="rq-sub" role="alert">
          {ambientError}
        </p>
      )}
      <ManualEntryForm
        accounts={accounts}
        accountId={accountId}
        onAccountIdChange={setAccountId}
        onSubmitProceed={handleProceedPastBreach}
      />
    </div>
  );
}
