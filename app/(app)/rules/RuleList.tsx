'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { RuleListItem } from '@/lib/rules/rules-repository';
import type { PromotionEligibilityDetail, PromotionIneligibilityReason } from '@/lib/rules/promotion-eligibility';
import { promoteRule, demoteRule, retireRule } from './actions';
import { withTimeout, ActionTimeoutError } from './with-timeout';

/**
 * Module 04 (Rulebook & Evaluation) story 1.1 / §6.1's own reference
 * markup, plus §5.7's severity lifecycle (promote/demote/retire) and the
 * hard-cap swap chooser — Slice 10e. This is the UI gap PROGRESS.md's own
 * "Module 04 scope gap" entry named: Slice 7 (2026-08-25) built
 * `promoteRule`/`demoteRule`/`retireRule` as backend-only Server Actions
 * with their UI explicitly deferred, and nothing ever picked it up — this
 * component is that UI.
 *
 * The Server Component (`page.tsx`) does the read-only composition
 * (`fetchRulesList`, the `rules.hard` entitlement snapshot); this component
 * owns ALL interactive state — one row per rule, each independently
 * tracking an in-flight promote/demote/retire, a promotion-ineligibility
 * explanation, a hard-cap swap chooser, or a retire confirm step. Matches
 * this file tree's own established "Server Component composes the read,
 * Client Component owns the interaction" split (`RuleEditor.tsx`,
 * `GuidedFrontDoor.tsx`, `AmbientStrip.tsx`).
 *
 * DESIGN-SYSTEM / SPEC-FIDELITY CHOICES, documented per this repo's own
 * established precedent of writing these down rather than assuming they're
 * obvious:
 *
 * - Severity badge reuses `.rq-tag`/`.rq-tag--on`/`.rq-tag--muted` —
 *   `retrospeq-design-system/brand/css/components.css` has never shipped a
 *   `.chip`/`.chip--soft`/`.chip--hard` primitive (§6.1's reference markup
 *   names `class="chip chip--soft"`, but `RuleEditor.tsx`/
 *   `GuidedFrontDoor.tsx` already established the real translation: "Starts
 *   soft" renders as `rq-tag rq-tag--muted`, not an invented `.chip`
 *   class). This component reuses that exact translation for BOTH
 *   severities rather than inventing a second badge primitive: soft is
 *   `rq-tag--muted` (the same "not yet emphasised" treatment "Starts soft"
 *   already uses everywhere else in this app tree), hard is `rq-tag--on`
 *   (the same "this is the active/elevated state" treatment `GuidedRuleCard`
 *   already uses for "Added"). Weight/fill only — no hue, no
 *   success/danger pair invented for either severity.
 * - Per-row promote/demote/retire controls are `rq-btn--ghost`, never the
 *   single-primary `rq-btn` — this page can show many rows at once, and
 *   `.rq-btn` is reserved for "the one decisive action of this view"
 *   (README's own "one .rq-btn per view" rule); a row-level utility action
 *   in a list is the same device `JoinControl.tsx`/`SplitControl.tsx`/
 *   `GroupingChip.tsx`'s own "Dismiss" already use.
 * - The retire confirm step is a genuine `rq-btn--equal` pair ("Yes,
 *   retire" / "Keep it active") — per this slice's own dispatch, a
 *   deliberate, low-frequency, IRREVERSIBLE action (story 2.4: "Retire
 *   only... No pause anywhere") is a different context from AGENTS.md's
 *   "no modal, no confirm, never blocks" rule, which is specifically about
 *   §5.9's live ambient/entry-screen behaviour (proceeding past a risk
 *   breach must never be gated), not a blanket ban on any confirmation
 *   step anywhere in the app. Equal weight, not primary/secondary, for the
 *   same "the product has no business nudging" ethics reasoning
 *   `GuidedFrontDoor.tsx`'s own header documents for Add/Skip — retiring
 *   is the trader's call, not one this UI should visually favour either
 *   way.
 * - The hard-cap swap alert (§6.1's own `alert alert--choice`/`demote-list`
 *   reference markup, newly shipped in `components.css` by this slice) DOES
 *   use a real primary `rq-btn` for "Swap" — unlike the retire confirm
 *   pair above, this is not a fresh, unweighted either-way decision: the
 *   trader already decided to promote (clicked Promote), hit the cap, and
 *   is choosing whether to COMPLETE that action (swap) or abandon it
 *   ("Keep it soft", `rq-btn--ghost`) — the same primary/ghost translation
 *   `RuleEditor.tsx`'s own header already applies to this exact reference
 *   markup's "primary"/"ghost" class names elsewhere in this module. Only
 *   one row's chooser is ever open at a time in normal use, so this never
 *   collides with the "one .rq-btn per view" rule in practice.
 * - Promotion-ineligibility is rendered as a STRUCTURED breakdown built
 *   from `eligibility.detail` (not the raw server `reasons[].message`
 *   prose) specifically so every numeric readout gets its own `.rq-num`
 *   span, per this slice's own dispatch ("eligibility progress numbers ...
 *   e.g. '14 of 20 evaluations'"). `reasons[].code` still decides WHICH
 *   gates to show (only the ones actually failing) — this is a display
 *   choice on top of the same facts the server already computed, not a
 *   second, independently-invented eligibility check.
 * - Free-tier promote is NOT pre-emptively disabled — a deliberate
 *   departure from `RuleEditor.tsx`'s "clear disabled-with-explanation
 *   state" precedent for `rules.create`, found to be the wrong call for
 *   THIS gate during this slice's own E2E self-check:
 *   `promoteRule`'s own validation order (`app/(app)/rules/actions.ts`)
 *   checks ELIGIBILITY before the `rules.hard` entitlement — a free-tier
 *   trader with a genuinely ineligible rule still deserves to see exactly
 *   which gates it's failing (the structured breakdown above), which a
 *   plan-based disabled state would have hidden from every free-tier
 *   trader unconditionally, regardless of whether their rule was even
 *   close to eligible. The honest-rejection-on-attempt alternative this
 *   slice's own dispatch explicitly allowed is the one actually built:
 *   the button always calls `promoteRule` for real, and whichever honest
 *   response comes back renders — the structured ineligibility breakdown,
 *   the hard-cap swap chooser, or (only for a free-tier trader whose rule
 *   IS otherwise eligible) the server's own plain "Hard rules are a Pro
 *   feature. Upgrade to promote a rule." message via the generic
 *   `row.error` path every other unmapped rejection in this component
 *   already uses.
 *
 *   REAL BUG FOUND AND FIXED (independent tester verification, 2026-08-31):
 *   this reasoning had a real gap for the COMMON combined case — a
 *   free-tier trader whose rule is ALSO ineligible on the merits (most
 *   free-tier rules will be both at once) saw ONLY the eligibility
 *   breakdown above, with zero mention that Pro is required at all,
 *   falsely implying that waiting out the gates would eventually let them
 *   promote. Fixed at the SOURCE (`promoteRule`'s own ineligible branch
 *   now also resolves the `rules.hard` entitlement and attaches
 *   `eligibility.proRequired`) rather than by reordering the server's own
 *   check order — the "still deserves to see which gates it's failing"
 *   reasoning above stands, this is additive, not a replacement: the
 *   structured breakdown always renders in full, and an ADDITIONAL line
 *   (below) renders whenever `proRequired` is true, so a free-tier trader
 *   attempting to promote an ineligible rule now always sees both facts
 *   together, never just the gates alone.
 * - Every awaited Server Action call in this component is wrapped in
 *   `withTimeout` (`./with-timeout.ts`) with a 15-second deadline — a
 *   SECOND real bug the independent tester found and reproduced 3/3 in
 *   isolation (search that file's own header for the full mechanism): a
 *   hung network stream produces neither a resolve nor a reject, so the
 *   `try`/`catch` blocks below — which already correctly handle a
 *   REJECTED Server Action call — never even run, and `busy`/`swapBusy`
 *   stay `true` forever with every control permanently disabled. The
 *   timeout forces the awaited promise to settle (by rejecting) regardless
 *   of what the underlying call ends up doing, so the existing `catch`
 *   blocks now always eventually run and always release the busy state.
 *   `TIMEOUT_ERROR_MESSAGE` (distinct from `UNEXPECTED_ERROR_MESSAGE`)
 *   deliberately frames this as "may have already gone through" rather
 *   than "please try again" — per the tester's own finding, the
 *   server-side write can and does still commit even when the client's own
 *   wait times out, so a bare "try again" would be dishonest about what
 *   might already be true.
 * - Retired (and, defensively, `deactivated_by_plan`) rules render in a
 *   native `<details>` disclosure, collapsed by default — the same "less
 *   prominent, browse if you want" device §6.1's own discovery reference
 *   markup already uses (`<details class="catalogue">`), reused here for
 *   the analogous "not the trader's current concern, but not hidden
 *   either" case. No promote/demote controls anywhere in that section —
 *   story 2.4's "retire only... no pause" means a retired rule is a dead
 *   end, and this UI does not pretend otherwise.
 */

interface HardEntitlementSummary {
  allowed: boolean;
  reason: string;
  limit: number | null;
}

interface RowState {
  rule: RuleListItem;
  busy: boolean;
  error: string | null;
  eligibility: { reasons: PromotionIneligibilityReason[]; detail: PromotionEligibilityDetail; proRequired: boolean } | null;
  hardCapChooser: { ruleId: string; rendered: string }[] | null;
  swapSelectedRuleId: string | null;
  swapBusy: boolean;
  swapError: string | null;
  confirmingRetire: boolean;
}

function initialRowState(rule: RuleListItem): RowState {
  return {
    rule,
    busy: false,
    error: null,
    eligibility: null,
    hardCapChooser: null,
    swapSelectedRuleId: null,
    swapBusy: false,
    swapError: null,
    confirmingRetire: false,
  };
}

/** One line per failing gate, built from `detail` (not the server's own
 *  prose) so every number gets a real `.rq-num` span — see this file's own
 *  header for why. Only ever called for a code present in `reasons`, so
 *  every branch below corresponds to a gate the trader is ACTUALLY failing
 *  right now, never a fabricated one. */
function eligibilityLine(
  code: PromotionIneligibilityReason['code'],
  detail: PromotionEligibilityDetail,
): { key: string; node: React.ReactNode } {
  switch (code) {
    case 'RULE_NOT_OLD_ENOUGH':
      return {
        key: code,
        node: (
          <>
            Active for <span className="rq-num">{Math.max(0, Math.floor(detail.ageDays))}</span> of the{' '}
            <span className="rq-num">42</span> days (6 weeks) needed.
          </>
        ),
      };
    case 'RULE_INSUFFICIENT_EVALUATIONS':
      return {
        key: code,
        node: (
          <>
            <span className="rq-num">{detail.applicableEvaluations}</span> of{' '}
            <span className="rq-num">20</span> applicable evaluations needed so far.
          </>
        ),
      };
    case 'RULE_INSUFFICIENT_COMPLIANCE':
      return {
        key: code,
        node: (
          <>
            <span className="rq-num">{detail.complianceRatio !== null ? (detail.complianceRatio * 100).toFixed(1) : '0'}%</span>{' '}
            followed so far — needs at least <span className="rq-num">95%</span>.
          </>
        ),
      };
    case 'RULE_RECENT_BREAK':
      return {
        key: code,
        node: (
          <>
            Broken <span className="rq-num">{detail.breaksInLastThreeWeeks}</span> time
            {detail.breaksInLastThreeWeeks === 1 ? '' : 's'} in the last 3 weeks — needs zero.
          </>
        ),
      };
  }
}

export function RuleList({
  initialRules,
  hardEntitlement,
}: {
  initialRules: RuleListItem[];
  hardEntitlement: HardEntitlementSummary;
}) {
  const [rows, setRows] = useState<RowState[]>(() => initialRules.map(initialRowState));

  function patchRow(ruleId: string, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r) => (r.rule.ruleId === ruleId ? { ...r, ...patch } : r)));
  }

  /** Same shape as `patchRow`, but for merging into a row's `.rule` — always
   *  via the functional `setRows` updater (never a `rows.find(...)` read
   *  off the closured `rows` variable), so a patch applied after an
   *  `await` can never clobber a concurrent, unrelated state update that
   *  happened to this same array in the meantime. Every mutation in this
   *  component goes through one of these two helpers for exactly this
   *  reason — matching `RuleEditor.tsx`/`GuidedFrontDoor.tsx`'s own
   *  established "functional setState updater, never a stale read"
   *  convention. */
  function patchRule(ruleId: string, rowPatch: Partial<RowState>, rulePatch: Partial<RuleListItem>) {
    setRows((prev) =>
      prev.map((r) => (r.rule.ruleId === ruleId ? { ...r, ...rowPatch, rule: { ...r.rule, ...rulePatch } } : r)),
    );
  }

  function findRendered(ruleId: string): string {
    return rows.find((r) => r.rule.ruleId === ruleId)?.rule.rendered ?? 'That rule';
  }

  /** Generic, honest fallback for a Server Action call that THREW rather
   *  than resolving with its own typed error shape (a network hiccup, an
   *  unexpected server-side exception) — found as a real gap during this
   *  slice's own E2E self-check of `handleSwap` below (see that function's
   *  own header). Every async handler in this component routes an
   *  unexpected throw through here so a trader is never left staring at a
   *  permanently "busy" control with no explanation and no way to retry. */
  const UNEXPECTED_ERROR_MESSAGE = 'Something unexpected went wrong. Please try again.';

  /** See this file's own header for the full "hard-cap swap gets stuck in
   *  Swapping… forever" bug this closes. 15s is generous relative to this
   *  slice's own E2E suite's own `{ timeout: 10_000 }` expectations for a
   *  successful round trip, so a real (non-hung) call never brushes this
   *  deadline in practice. */
  const ACTION_TIMEOUT_MS = 15_000;

  /** Deliberately distinct from `UNEXPECTED_ERROR_MESSAGE` — see this
   *  file's own header ("Every awaited Server Action call...") for why a
   *  bare "try again" would be dishonest here specifically. */
  const TIMEOUT_ERROR_MESSAGE =
    'This is taking longer than expected. It may have already gone through — refresh the page to check, or try again below.';

  function messageForCaughtError(err: unknown): string {
    return err instanceof ActionTimeoutError ? TIMEOUT_ERROR_MESSAGE : UNEXPECTED_ERROR_MESSAGE;
  }

  async function handlePromote(ruleId: string) {
    patchRow(ruleId, { busy: true, error: null, eligibility: null });
    try {
      const result = await withTimeout(promoteRule(ruleId), ACTION_TIMEOUT_MS);
      if (result.success) {
        patchRule(ruleId, { busy: false }, { severity: 'hard', promotedAt: result.promotedAt ?? null });
        return;
      }
      if (result.error?.code === 'RULE_PROMOTION_NOT_ELIGIBLE' && result.eligibility) {
        patchRow(ruleId, { busy: false, eligibility: result.eligibility });
        return;
      }
      if (result.error?.code === 'RULE_HARD_CAP' && result.hardCapChooser) {
        patchRow(ruleId, { busy: false, hardCapChooser: result.hardCapChooser, swapSelectedRuleId: null, swapError: null });
        return;
      }
      patchRow(ruleId, { busy: false, error: result.error?.user_message ?? 'Something went wrong. Please try again.' });
    } catch (err) {
      patchRow(ruleId, { busy: false, error: messageForCaughtError(err) });
    }
  }

  async function handleDemote(ruleId: string) {
    patchRow(ruleId, { busy: true, error: null });
    try {
      const result = await withTimeout(demoteRule(ruleId), ACTION_TIMEOUT_MS);
      if (result.success) {
        patchRule(ruleId, { busy: false }, { severity: 'soft' });
        return;
      }
      patchRow(ruleId, { busy: false, error: result.error?.user_message ?? 'Something went wrong. Please try again.' });
    } catch (err) {
      patchRow(ruleId, { busy: false, error: messageForCaughtError(err) });
    }
  }

  function handleRetireClick(ruleId: string) {
    patchRow(ruleId, { confirmingRetire: true, error: null });
  }

  function handleRetireCancel(ruleId: string) {
    patchRow(ruleId, { confirmingRetire: false });
  }

  async function handleRetireConfirm(ruleId: string) {
    patchRow(ruleId, { busy: true, error: null });
    try {
      const result = await withTimeout(retireRule(ruleId), ACTION_TIMEOUT_MS);
      if (result.success) {
        patchRule(
          ruleId,
          { busy: false, confirmingRetire: false },
          { state: 'retired', retiredAt: result.retiredAt ?? null },
        );
        return;
      }
      patchRow(ruleId, {
        busy: false,
        confirmingRetire: false,
        error: result.error?.user_message ?? 'Something went wrong. Please try again.',
      });
    } catch (err) {
      patchRow(ruleId, { busy: false, confirmingRetire: false, error: messageForCaughtError(err) });
    }
  }

  function handleSwapSelect(originalRuleId: string, demoteRuleId: string) {
    patchRow(originalRuleId, { swapSelectedRuleId: demoteRuleId, swapError: null });
  }

  function handleKeepSoft(originalRuleId: string) {
    patchRow(originalRuleId, { hardCapChooser: null, swapSelectedRuleId: null, swapError: null });
  }

  /**
   * §6.1's "Swap" — demote the CHOSEN rule, then promote the ORIGINAL one.
   * Sequential, not parallel: the second call's own correctness (the cap
   * check inside `promoteRuleSeverity`'s guarded UPDATE) depends on the
   * first one having actually committed first. Every partial-failure
   * branch is reported honestly (per this slice's own dispatch) — a
   * trader who demotes successfully but then fails to promote sees exactly
   * that, never a silent no-op or a generic error that could describe
   * either half.
   *
   * REAL BUG FOUND AND FIXED during this slice's own E2E self-check
   * (2026-08-31): the body below originally had no top-level `try`/`catch`
   * — when either awaited Server Action call THREW rather than resolving
   * with its own typed error shape (reproduced live: a transient dev-server
   * RSC stream interruption on the `demoteRule` round trip, "The
   * destination stream closed early", surfaced to the client as a rejected
   * fetch, not a resolved `{success:false, error:{...}}`), the whole
   * `handleSwap` async function aborted silently mid-flight — no further
   * code ever ran, so `swapBusy` was never reset to `false` and the trader
   * was left staring at a permanently disabled "Swapping…" button with no
   * explanation and no way to retry. Wrapping the body below in a single
   * `try`/`catch` (mirroring the same fix applied to every other async
   * handler in this file) closed THAT specific gap.
   *
   * SECOND, DEEPER BUG FOUND AND FIXED (independent tester verification,
   * 2026-08-31): a `try`/`catch` alone is not sufficient. Reproduced 3/3 in
   * isolation, the tester found that when the SECOND (`promoteRule`) call's
   * own promise never SETTLES at all — no resolve, no reject, the exact
   * shape of a genuinely hung stream, distinct from the throw-path bug
   * above — the `catch` block never runs either, because nothing ever
   * rejects. `swapBusy` stayed `true` and every control in the alert stayed
   * `disabled` forever, with no error and no way out — server-side the
   * promotion still eventually committed correctly (confirmed via reload,
   * no data loss), so this was purely a client-side dead end. Both awaited
   * calls below are now wrapped in `withTimeout` (`./with-timeout.ts`,
   * 15s) — see that file's own header for the full mechanism — which
   * forces the awaited promise to settle (reject) even if the underlying
   * call never does, so the existing `catch` block below is now always
   * reachable. On an `ActionTimeoutError` specifically, `swapError` reads
   * `TIMEOUT_ERROR_MESSAGE` ("may have already gone through — refresh...")
   * rather than the generic `UNEXPECTED_ERROR_MESSAGE`, per this file's own
   * top-level header — a bare "try again" would be dishonest given the
   * server-side write can and does still land after the client gives up.
   * One residual, inherent limitation this fix does NOT (and cannot) fully
   * solve, same as every other action in this app: if a call genuinely
   * committed server-side but the CLIENT's own fetch then failed to
   * resolve (whether via a throw or via this timeout), this UI cannot
   * distinguish that from a call that never happened at all —
   * `revalidatePath('/rules')` (already called by every mutating action
   * here) plus the honest "refresh to check" framing is the same
   * eventual-correction posture every other write in this app already
   * relies on for that narrow class of network partial-failure, not a new
   * gap this slice introduces.
   */
  async function handleSwap(originalRuleId: string, demoteRuleId: string) {
    patchRow(originalRuleId, { swapBusy: true, swapError: null });
    const demotedRendered = findRendered(demoteRuleId);

    try {
      const demoteResult = await withTimeout(demoteRule(demoteRuleId), ACTION_TIMEOUT_MS);
      if (!demoteResult.success) {
        patchRow(originalRuleId, {
          swapBusy: false,
          swapError: demoteResult.error?.user_message ?? 'Something went wrong moving that rule back to soft. Please try again.',
        });
        return;
      }

      // The demote genuinely happened — reflect it immediately regardless
      // of what the follow-up promote does next. This row may not even be
      // the one currently rendering the chooser (it's a different rule in
      // the list), so it is patched independently of `originalRuleId`'s
      // own row.
      setRows((prev) => prev.map((r) => (r.rule.ruleId === demoteRuleId ? { ...r, rule: { ...r.rule, severity: 'soft' } } : r)));

      const promoteResult = await withTimeout(promoteRule(originalRuleId), ACTION_TIMEOUT_MS);
      if (promoteResult.success) {
        patchRule(
          originalRuleId,
          { swapBusy: false, hardCapChooser: null, swapSelectedRuleId: null },
          { severity: 'hard', promotedAt: promoteResult.promotedAt ?? null },
        );
        return;
      }

      if (promoteResult.error?.code === 'RULE_HARD_CAP' && promoteResult.hardCapChooser) {
        // Structurally unexpected (the swap just freed a slot), but
        // handled honestly rather than assumed impossible — a third
        // concurrent promotion elsewhere could have refilled the cap in
        // between.
        patchRow(originalRuleId, {
          swapBusy: false,
          hardCapChooser: promoteResult.hardCapChooser,
          swapSelectedRuleId: null,
          swapError: `"${demotedRendered}" is now soft, but the cap filled again before this could complete — choose again.`,
        });
        return;
      }

      patchRow(originalRuleId, {
        swapBusy: false,
        hardCapChooser: null,
        swapSelectedRuleId: null,
        swapError: `"${demotedRendered}" was moved back to soft, but promoting this rule failed: ${
          promoteResult.error?.user_message ?? 'please try again.'
        } You can try promoting again now that you have room.`,
      });
    } catch (err) {
      patchRow(originalRuleId, { swapBusy: false, swapError: messageForCaughtError(err) });
    }
  }

  const activeRows = rows.filter((r) => r.rule.state === 'active');
  const inactiveRows = rows.filter((r) => r.rule.state !== 'active');
  const activeHardCount = activeRows.filter((r) => r.rule.severity === 'hard').length;

  if (activeRows.length === 0 && inactiveRows.length === 0) {
    return (
      <section className="flex flex-col gap-4" aria-labelledby="rule-list-h">
        <h2 id="rule-list-h" className="rq-h2">
          Your rules
        </h2>
        <p className="rq-sub">You haven&apos;t written any rules yet.</p>
        <div className="rq-btn-row">
          <Link href="/rules/start" className="rq-btn rq-btn--equal">
            Guided setup
          </Link>
          <Link href="/rules/new" className="rq-btn rq-btn--equal">
            Write a rule
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="rule-list-h">
      <div className="flex items-center justify-between gap-2">
        <h2 id="rule-list-h" className="rq-h2">
          Your rules
        </h2>
        <Link href="/rules/new" className="rq-btn rq-btn--ghost">
          Write a rule
        </Link>
      </div>

      {/* `limit === 0` is Free's structural exclusion (`rules.hard: {free:
          0}`, `reason: 'plan'`), not a real quota to report a fraction
          against — showing "0 of 0 used" there would be a confusing,
          meaningless readout, so this line only renders for a real,
          nonzero cap (Pro's 6). */}
      {hardEntitlement.limit !== null && hardEntitlement.limit > 0 && (
        <p className="rq-sub">
          Hard rules: <span className="rq-num">{activeHardCount}</span> of{' '}
          <span className="rq-num">{hardEntitlement.limit}</span> used.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {activeRows.map((row) => (
          <RuleRow
            key={row.rule.ruleId}
            row={row}
            onPromote={() => handlePromote(row.rule.ruleId)}
            onDemote={() => handleDemote(row.rule.ruleId)}
            onRetireClick={() => handleRetireClick(row.rule.ruleId)}
            onRetireCancel={() => handleRetireCancel(row.rule.ruleId)}
            onRetireConfirm={() => handleRetireConfirm(row.rule.ruleId)}
            onSwapSelect={(demoteRuleId) => handleSwapSelect(row.rule.ruleId, demoteRuleId)}
            onSwap={() => row.swapSelectedRuleId && handleSwap(row.rule.ruleId, row.swapSelectedRuleId)}
            onKeepSoft={() => handleKeepSoft(row.rule.ruleId)}
          />
        ))}
      </ul>

      {inactiveRows.length > 0 && (
        <details className="rq-well">
          <summary className="rq-sub">
            Retired rules (<span className="rq-num">{inactiveRows.length}</span>)
          </summary>
          <ul className="flex flex-col gap-2 pt-2">
            {inactiveRows.map((row) => (
              <li key={row.rule.ruleId} className="rq-row">
                <span className="rq-body flex-1">{row.rule.rendered}</span>
                <span className={row.rule.severity === 'hard' ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}>
                  {row.rule.severity === 'hard' ? 'Hard' : 'Soft'}
                </span>
                <span className="rq-tag rq-tag--muted">
                  {row.rule.state === 'retired' ? 'Retired' : 'Paused by your plan'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function RuleRow({
  row,
  onPromote,
  onDemote,
  onRetireClick,
  onRetireCancel,
  onRetireConfirm,
  onSwapSelect,
  onSwap,
  onKeepSoft,
}: {
  row: RowState;
  onPromote: () => void;
  onDemote: () => void;
  onRetireClick: () => void;
  onRetireCancel: () => void;
  onRetireConfirm: () => void;
  onSwapSelect: (demoteRuleId: string) => void;
  onSwap: () => void;
  onKeepSoft: () => void;
}) {
  const { rule } = row;

  return (
    <li>
      <section className="rq-card flex flex-col gap-3" aria-label={rule.rendered}>
        <div className="flex items-start justify-between gap-3">
          <p className="rule-sentence rq-body flex-1">{rule.rendered}</p>
          <span className={rule.severity === 'hard' ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}>
            {rule.severity === 'hard' ? 'Hard' : 'Soft'}
          </span>
        </div>

        {row.error && (
          <p className="rq-sub" role="alert">
            {row.error}
          </p>
        )}

        {row.eligibility && (
          <div className="rq-well flex flex-col gap-1" role="status">
            <p className="rq-sub">Not yet eligible to promote:</p>
            <ul className="flex flex-col gap-1">
              {row.eligibility.reasons.map((reason) => {
                const line = eligibilityLine(reason.code, row.eligibility!.detail);
                return (
                  <li key={line.key} className="rq-sub">
                    {line.node}
                  </li>
                );
              })}
            </ul>
            {/* Bug fix (independent tester verification, 2026-08-31): a
                free-tier trader must ALWAYS see this alongside the gates
                above, never the gates alone — see this file's own header
                ("REAL BUG FOUND AND FIXED... free-tier promote") for why
                showing only the eligibility breakdown falsely implies
                waiting out the gates would eventually be enough. */}
            {row.eligibility.proRequired && (
              <p className="rq-sub">Hard rules are also a Pro feature. Upgrade to promote a rule.</p>
            )}
          </div>
        )}

        {row.hardCapChooser && (
          <div className="alert alert--choice" role="alertdialog" aria-labelledby={`cap-h-${rule.ruleId}`}>
            <h2 id={`cap-h-${rule.ruleId}`}>
              You already have <span className="rq-num">{row.hardCapChooser.length}</span> hard rules
            </h2>
            <p className="rq-sub">
              Hard rules work because there are few of them. To make this one hard, choose one to move back to
              soft.
            </p>
            <ul className="demote-list">
              {row.hardCapChooser.map((c) => (
                <li key={c.ruleId}>
                  <label>
                    <input
                      type="radio"
                      name={`demote-${rule.ruleId}`}
                      value={c.ruleId}
                      checked={row.swapSelectedRuleId === c.ruleId}
                      disabled={row.swapBusy}
                      onChange={() => onSwapSelect(c.ruleId)}
                    />
                    {c.rendered}
                  </label>
                </li>
              ))}
            </ul>
            {row.swapError && (
              <p className="rq-sub" role="alert">
                {row.swapError}
              </p>
            )}
            <div className="rq-btn-row">
              <button type="button" className="rq-btn" disabled={!row.swapSelectedRuleId || row.swapBusy} onClick={onSwap}>
                {row.swapBusy ? 'Swapping…' : 'Swap'}
              </button>
              <button type="button" className="rq-btn rq-btn--ghost" disabled={row.swapBusy} onClick={onKeepSoft}>
                Keep it soft
              </button>
            </div>
          </div>
        )}

        {row.confirmingRetire ? (
          <div className="rq-well flex flex-col gap-2">
            <p className="rq-sub">
              Retiring stops this rule from being evaluated going forward. Past evaluations stay exactly as they
              were. This can&apos;t be undone.
            </p>
            <div className="rq-btn-row">
              <button type="button" className="rq-btn rq-btn--equal" disabled={row.busy} onClick={onRetireConfirm}>
                {row.busy ? 'Retiring…' : 'Yes, retire'}
              </button>
              <button type="button" className="rq-btn rq-btn--equal" disabled={row.busy} onClick={onRetireCancel}>
                Keep it active
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {rule.severity === 'soft' ? (
              <button type="button" className="rq-btn rq-btn--ghost" disabled={row.busy} onClick={onPromote}>
                {row.busy ? 'Promoting…' : 'Promote to hard'}
              </button>
            ) : (
              <button type="button" className="rq-btn rq-btn--ghost" disabled={row.busy} onClick={onDemote}>
                {row.busy ? 'Demoting…' : 'Demote to soft'}
              </button>
            )}
            <button type="button" className="rq-btn rq-btn--ghost" disabled={row.busy} onClick={onRetireClick}>
              Retire
            </button>
          </div>
        )}
      </section>
    </li>
  );
}
