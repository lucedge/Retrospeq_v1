/**
 * Module 01 §7.2 (mandatory, no exceptions): "Connect and auth endpoints
 * throttle per user and per IP." Every scope below is checked against
 * BOTH an `ip:` and (where an identity is known pre-auth) an `email:`
 * identifier — see lib/rate-limit/limiter.ts's `checkRateLimit` and its
 * call sites in app/(auth)/actions.ts / app/auth/callback/route.ts.
 *
 * Numbers are a first-pass judgment call (00-foundation doesn't specify
 * exact thresholds), chosen to tolerate real user error (a mistyped
 * password a few times, a slow reset-link round trip) while still being
 * a real brake on scripted abuse. Revisit with real traffic data once
 * this ships past the shared dev project.
 */
export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  /** signUpWithEmail */
  signup: {
    ip: { limit: 5, windowSeconds: 3600 },
    email: { limit: 3, windowSeconds: 3600 },
  },
  /** signInWithEmail */
  signin: {
    ip: { limit: 20, windowSeconds: 900 },
    email: { limit: 10, windowSeconds: 900 },
  },
  /** requestPasswordReset */
  resetRequest: {
    ip: { limit: 5, windowSeconds: 3600 },
    email: { limit: 3, windowSeconds: 3600 },
  },
  /** confirmPasswordReset — already requires an active recovery session,
   *  so per-IP only; there is no pre-auth email to key on here. */
  resetConfirm: {
    ip: { limit: 10, windowSeconds: 3600 },
  },
  /** signInWithGoogle kick-off (redirect to Google, not a credential
   *  submission) — looser, but still a real endpoint per §7.2. */
  oauthGoogle: {
    ip: { limit: 20, windowSeconds: 3600 },
  },
  /** app/auth/callback/route.ts — PKCE code exchange for OAuth, email
   *  confirmation links, and reset links all land here. */
  callback: {
    ip: { limit: 30, windowSeconds: 3600 },
  },
  /**
   * app/(app)/accounts/actions.ts's `connectAccount` — Module 01 §7.2,
   * verbatim: "Connect ... endpoints throttle per user and per IP." This
   * scope runs post-auth (the caller already has a session), so the
   * `email` field here is reused as a generic second-dimension identifier
   * keyed on the caller's `user.id`, not a literal email address —
   * `enforceRateLimit`'s `email?` parameter is just a string tag prefixed
   * `email:` for bucket namespacing (lib/rate-limit/limiter.ts), it never
   * validates the value's shape. Looser than signup/signin since a real
   * trader may legitimately retry a mistyped server/login/password a few
   * times in a row.
   */
  connectAccount: {
    ip: { limit: 20, windowSeconds: 3600 },
    email: { limit: 10, windowSeconds: 3600 },
  },
  /**
   * app/(app)/accounts/actions.ts's `disconnectAccount` — not explicitly
   * named by Module 01 §7.2's "Connect and auth endpoints" text, but it
   * is credential-destructive and account-scoped, so it gets the same
   * defence-in-depth throttle rather than being left uncovered.
   */
  disconnectAccount: {
    ip: { limit: 30, windowSeconds: 3600 },
    email: { limit: 20, windowSeconds: 3600 },
  },
  /**
   * app/(app)/accounts/actions.ts's `updateAccountSettings` — Module 01
   * stories 3.1-3.4 (rename, rollover, prop label). Not credential- or
   * auth-shaped (no secret involved, no vendor round trip, nothing an
   * offline-guessing script would target) and not destructive
   * (`disconnectAccount`'s tighter budget is for something that destroys
   * a credential) — a trader plausibly edits a label or fixes a rollover
   * typo several times while getting it right, so this gets the loosest
   * budget in this file rather than reusing `connectAccount`'s. Still
   * throttled, not exempt: Module 01 §7.2's "throttle" posture is a
   * blanket one for every write endpoint in this module, not an
   * auth-only rule, and a real per-user/per-IP scope costs nothing to
   * add here versus leaving this one path uncovered.
   */
  accountSettings: {
    ip: { limit: 40, windowSeconds: 3600 },
    email: { limit: 30, windowSeconds: 3600 },
  },
  /**
   * Module 01 story 1.4/1.5 — app/(app)/security/actions.ts.
   * `mfaEnroll`: starting a new TOTP enrollment (issues a fresh secret/QR
   * each call) — loose but real, a trader retrying a scan a few times is
   * normal.
   */
  mfaEnroll: {
    ip: { limit: 20, windowSeconds: 3600 },
    email: { limit: 10, windowSeconds: 3600 },
  },
  /** Confirming enrollment or a sign-in step-up challenge with a 6-digit
   *  code — this is exactly the kind of endpoint an offline TOTP-guessing
   *  script would hammer (10^6 code space), so it's the tightest scope
   *  here. Keyed on user id (post-enrollment-confirm/mid-signin) via the
   *  `email` field's generic-identifier reuse, same pattern as
   *  `connectAccount`. */
  mfaVerify: {
    ip: { limit: 15, windowSeconds: 900 },
    email: { limit: 8, windowSeconds: 900 },
  },
  /** Disabling an enrolled factor — destructive, account-scoped. */
  mfaUnenroll: {
    ip: { limit: 20, windowSeconds: 3600 },
    email: { limit: 10, windowSeconds: 3600 },
  },
  /** Redeeming a recovery code — same tight budget as `mfaVerify` and for
   *  the same reason (a guessable-in-bulk secret), plus this one also
   *  disables 2FA entirely on success, so it gets the tighter of the two
   *  windows. */
  mfaRecoveryRedeem: {
    ip: { limit: 10, windowSeconds: 3600 },
    email: { limit: 5, windowSeconds: 3600 },
  },
  /** Session revocation ("sign out other devices" / "sign out
   *  everywhere") — not credential-guessing-shaped, but still a real,
   *  security-relevant endpoint per Module 01 §7.2's blanket "auth
   *  endpoints throttle" requirement. */
  sessionRevoke: {
    ip: { limit: 30, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /**
   * Module 01 stories 4.1-4.4 — app/(app)/plan/actions.ts.
   * `requestBillingPortal`: no real billing provider exists yet
   * (`lib/entitlements/billing.ts`), so this always fails fast today —
   * still a real write-adjacent endpoint per §7.2's blanket posture, not
   * exempt just because it currently always errors.
   */
  billingPortal: {
    ip: { limit: 40, windowSeconds: 3600 },
    email: { limit: 30, windowSeconds: 3600 },
  },
  /** `devSetPlan` — dev/test-only entitlement override
   *  (`lib/entitlements/subscription-repository.ts`'s
   *  `setUserPlanForTesting`, refuses to run in production regardless).
   *  Tighter than `billingPortal`: this one actually mutates a
   *  security-relevant column, even though only in development. */
  devSetPlan: {
    ip: { limit: 20, windowSeconds: 3600 },
    email: { limit: 10, windowSeconds: 3600 },
  },
  /**
   * Module 01 stories 5.1-5.4 — app/(app)/privacy/actions.ts.
   * `telemetryToggle`: not credential- or destruction-shaped, loosest
   * budget here, matching `accountSettings`'s reasoning (a trader may
   * flip this a few times while deciding).
   */
  telemetryToggle: {
    ip: { limit: 40, windowSeconds: 3600 },
    email: { limit: 30, windowSeconds: 3600 },
  },
  /** `requestExportAction` — runs the whole export job synchronously
   *  today (lib/privacy/export-job.ts), so this is also, incidentally,
   *  the real backstop against a trader hammering "export" repeatedly
   *  and re-running the job each time before `EXPORT_IN_PROGRESS`'s own
   *  duplicate-request guard would otherwise let a second request queue
   *  up. */
  requestExport: {
    ip: { limit: 10, windowSeconds: 3600 },
    email: { limit: 6, windowSeconds: 3600 },
  },
  /** `requestErasureAction` — starts a real, destructive 7-day-grace
   *  flow. Tight, matching `disconnectAccount`'s destructive-action
   *  posture rather than a settings-edit one. */
  requestErasure: {
    ip: { limit: 10, windowSeconds: 3600 },
    email: { limit: 5, windowSeconds: 3600 },
  },
  /** `cancelErasureAction` — not destructive (the opposite), looser. */
  cancelErasureRequest: {
    ip: { limit: 20, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /** `devExecuteErasureNowAction` — DEV/TEST-ONLY (also gated by
   *  `lib/privacy/dev-tools-guard.ts`), but rate-limited regardless per
   *  §7.2's blanket "every write endpoint" posture, same as
   *  `devSetPlan`. This is the single most destructive action in this
   *  slice (a real `auth.admin.deleteUser` call), so it gets the
   *  tightest budget in this file.
   */
  devExecuteErasure: {
    ip: { limit: 5, windowSeconds: 3600 },
    email: { limit: 3, windowSeconds: 3600 },
  },
  /** `requestRestrictionAction` (story 5.3, GDPR Article 18) — not
   *  destructive and fully reversible (unlike erasure), so a looser
   *  budget matching `cancelErasureRequest`'s reasoning rather than
   *  `requestErasure`'s tight one. */
  requestRestriction: {
    ip: { limit: 20, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /** `liftRestrictionAction` — same reasoning, the reversal direction. */
  liftRestriction: {
    ip: { limit: 20, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /**
   * Module 02 Slice 7a — `app/(app)/trades/actions.ts`'s
   * `toggleNotADecisionAction`. Per §4.7, "plain toggle, no reason
   * required," available before or after freeze, and a trader may
   * reasonably flip it back and forth while deciding — the loosest
   * budget in this file, matching `accountSettings`'s reasoning (not
   * credential- or auth-shaped, not destructive, no vendor round trip).
   */
  toggleNotADecision: {
    ip: { limit: 60, windowSeconds: 3600 },
    email: { limit: 40, windowSeconds: 3600 },
  },
  /**
   * `createManualTradeAction` — Module 02 §4.8. Writes real `fills`/
   * `trades` rows (a genuine financial record, unlike a settings edit),
   * but a `manual`-platform account's whole reason to exist is that a
   * trader logs trades by hand, plausibly several in one sitting after
   * a trading session — moderate, not tight.
   */
  manualTradeEntry: {
    ip: { limit: 30, windowSeconds: 3600 },
    email: { limit: 20, windowSeconds: 3600 },
  },
  /**
   * `splitTradeAction`/`joinTradesAction` — Module 02 §4.7, "before
   * freeze only." Restructures existing trade membership rather than
   * creating new financial records, and both are pre-freeze-only by
   * construction (so the worst case is a few wasted attempts against an
   * already-confirmed trade, not runaway data creation) — moderate,
   * slightly tighter than manual entry since these mutate rows a sync
   * may also be touching concurrently.
   */
  splitTrade: {
    ip: { limit: 25, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  joinTrades: {
    ip: { limit: 25, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /**
   * `confirmDayAction` — Module 02 §4.6, "the critical transaction."
   * Freezes rule evaluations permanently once it succeeds, so this is
   * the highest-stakes write in this file, but a trader legitimately
   * retries a refused confirm (coverage gap fixed, ambiguity resolved)
   * a few times in normal use — moderate, matching `connectAccount`'s
   * budget rather than a destructive-action one.
   */
  confirmDay: {
    ip: { limit: 20, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /**
   * `writeTradeCaptureAction` — Module 02 Slice 7b's trim-reason chip row
   * (§3.3/§5.1/§5.2, "one tap, fixed options, always skippable"). Not
   * credential- or destruction-shaped, and re-tagging a trim reason a
   * handful of times while deciding is normal use — similar reasoning to
   * `toggleNotADecision`'s loose budget, kept slightly tighter since this
   * writes per-trade rather than being a single global toggle.
   */
  writeTradeCapture: {
    ip: { limit: 60, windowSeconds: 3600 },
    email: { limit: 40, windowSeconds: 3600 },
  },
  /**
   * `resolveAmbiguousGroupingAction` -- the design-ethics fix closing
   * `GroupingChip.tsx`'s "Same trade" gap (2026-08-23). Same eligibility
   * shape as `splitTrade`/`joinTrades` (before-freeze-only, restructures
   * (here: resolves) an existing trade's own grouping state rather than
   * creating new financial records), but touches strictly fewer columns
   * than either (no trade_fills/trade_events writes, no new trade row) --
   * given the same moderate budget as `splitTrade`/`joinTrades` rather
   * than a tighter one, since it is equally low-risk on a lost race (the
   * worst case is a few wasted attempts against an already-confirmed or
   * already-resolved trade).
   */
  resolveAmbiguousGrouping: {
    ip: { limit: 25, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /**
   * Module 04 (Rulebook & Evaluation) §5.1's authoring pipeline —
   * `app/(app)/rules/actions.ts`'s `createRule`. A real, financially/
   * behaviourally significant write (a new `rules` + `rule_versions`
   * row), but a trader plausibly authors several rules in one sitting
   * (the guided three-rule front door, §5.10, plus ad-hoc strategy
   * rules afterward) — matching `manualTradeEntry`'s "moderate, not
   * tight" reasoning above rather than a destructive-action budget.
   * Also the real backstop against a free-plan trader hammering this
   * action to probe past the 3-rule entitlement cap.
   */
  createRule: {
    ip: { limit: 30, windowSeconds: 3600 },
    email: { limit: 20, windowSeconds: 3600 },
  },
  /**
   * `editRule` — Module 04 §2.5, "changing a threshold." Structurally
   * closer to `splitTrade`/`joinTrades` (restructures/versions an
   * EXISTING record rather than creating a brand-new financial fact)
   * than to `createRule` — same moderate budget as those two, not
   * `accountSettings`'s looser one, since each edit permanently writes a
   * new `rule_versions` row (§2.5: "Edit creates a new version") rather
   * than mutating a label in place.
   */
  editRule: {
    ip: { limit: 25, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /**
   * `previewRule` — Module 04 §5.8, `lib/rules/preview.ts`. Deliberately
   * the LOOSEST, shortest-window budget in this file, unlike every other
   * scope above: this is a READ-ONLY call (`preview()`'s own contract:
   * "writes nothing, ever") driven by a live slider the trader drags
   * during authoring — §12's own performance budget ("Preview < 300ms
   * p95") assumes many rapid calls per authoring session, not the
   * occasional-write cadence `createRule`/`editRule`'s hourly windows are
   * sized for. A 60-second window (rather than this file's usual 900/3600)
   * matches that interactive, bursty usage pattern directly, while still
   * being a real backstop against a scripted flood — a genuine slider drag
   * cannot realistically exceed a few requests per second even at native
   * `input[type=range]` event-firing rates.
   */
  previewRule: {
    ip: { limit: 240, windowSeconds: 60 },
    email: { limit: 150, windowSeconds: 60 },
  },
  /**
   * Module 04 §5.7 — Slice 7's severity lifecycle. `promoteRule`/
   * `demoteRule`/`retireRule` all mutate an EXISTING `rules` row's own
   * lifecycle columns (never create a new financial record, never author
   * a new rule) — structurally the same class as `editRule` above
   * ("restructures/versions an existing record"), so all three get
   * `editRule`'s identical moderate budget rather than `createRule`'s or
   * a destructive-action one. `retireRule` is one-way and `demoteRule` is
   * "freely" per §5.7 (no eligibility gate) — neither is more dangerous
   * than a threshold edit, so there is no reason to tighten either
   * relative to `editRule`.
   */
  promoteRule: {
    ip: { limit: 25, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  demoteRule: {
    ip: { limit: 25, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  retireRule: {
    ip: { limit: 25, windowSeconds: 3600 },
    email: { limit: 15, windowSeconds: 3600 },
  },
  /**
   * Module 04 §5.9 — Slice 8's `recordOverride`. Writes a real
   * `rule_overrides` row (a live, append-only log entry), so this is not
   * `previewRule`'s "writes nothing, ever" case — but it is also not a
   * financially-new-record write like `createRule`/`manualTradeEntry`, and
   * a trader can legitimately proceed past several DIFFERENT visible
   * breaches across one trading session (a session-rule breach visible
   * mid-day, another later, a pre_entry breach on the next fill) — this
   * slice's own dispatch: "closer to previewRule's generosity than
   * createRule's stricter limit." Given loosest-hourly-budget precedent in
   * this file (`writeTradeCapture`/`toggleNotADecision`: a real per-trade
   * write, not credential- or destruction-shaped, plausible several times
   * per sitting) fits this shape better than `previewRule`'s 60-second
   * interactive-slider window (an override is a discrete, deliberate
   * proceed-past-a-breach action, not a rapid-fire UI drag) — this scope
   * reuses `writeTradeCapture`'s exact budget rather than inventing a
   * third number for the same reasoning.
   */
  recordOverride: {
    ip: { limit: 60, windowSeconds: 3600 },
    email: { limit: 40, windowSeconds: 3600 },
  },
  /**
   * Module 04 §5.9 UI — Slice 10d's ambient strip
   * (`app/(app)/trades/manual-entry`). A read-only wrapper around
   * `lib/rules/ambient-state.ts`'s `getAmbientAccountState` (writes
   * nothing, same "read-only, ever" contract that function's own header
   * documents), fetched once on page load PLUS once per account switch —
   * bursty in the same interactive-UI sense `previewRule` is (a trader
   * flipping between two or three accounts while deciding where to log a
   * trade), but nowhere near `previewRule`'s per-keystroke-slider-drag
   * cadence, so this gets a real but looser budget than that 60-second/
   * 240-request window rather than reusing it outright.
   */
  ambientAccountState: {
    ip: { limit: 120, windowSeconds: 60 },
    email: { limit: 80, windowSeconds: 60 },
  },
  /**
   * Module 04 §5.6 UI — Slice 10d part 2's adherence display
   * (`app/(app)/rules/page.tsx`). Read-only end to end
   * (`lib/rules/adherence-display.ts`'s own contract: "never writes
   * anything"), fetched once per page LOAD — unlike `ambientAccountState`
   * (re-fetched on every account switch, a genuinely bursty interactive
   * pattern), this screen has no client-side re-fetch trigger at all today
   * (no week picker, no account switcher), so a real trader session would
   * only ever hit this a handful of times per hour even browsing back and
   * forth. Given an hourly window rather than `ambientAccountState`'s
   * 60-second one, but still a real, non-trivial budget (a trader
   * legitimately reloading the page, or a future week-picker interaction,
   * should never feel throttled) rather than the tightest scope in this
   * file.
   */
  adherenceDisplay: {
    ip: { limit: 90, windowSeconds: 3600 },
    email: { limit: 60, windowSeconds: 3600 },
  },
  /**
   * Module 04 story 1.1 — Slice 10e's rule list/browsing view
   * (`app/(app)/rules/page.tsx`). Read-only end to end
   * (`fetchRulesForUser` writes nothing), fetched once per page load —
   * same shape and reasoning as `adherenceDisplay` immediately above (no
   * client-side re-fetch trigger; a real session hits this a handful of
   * times per hour even browsing back and forth), so it reuses that exact
   * budget rather than inventing a third near-identical number.
   */
  ruleList: {
    ip: { limit: 90, windowSeconds: 3600 },
    email: { limit: 60, windowSeconds: 3600 },
  },
  /**
   * Module 04 §2.5 UI, Slice 10f — `app/(app)/rules/actions.ts`'s
   * `fetchRuleForEdit`, the read that pre-fills the edit-a-threshold
   * control with a rule's CURRENT raw `value`/`op` (§6.1's `.rule-editor`
   * reference markup, opened inline from `RuleList.tsx`). Read-only end to
   * end (`fetchCurrentRuleForEdit` writes nothing) — not as bursty as
   * `previewRule`'s per-keystroke slider drag, but plausibly opened/closed
   * a handful of times in one rulebook-browsing session (a trader opening
   * Edit on two or three different rules while deciding what to change),
   * closer to `recordOverride`/`writeTradeCapture`'s "loose, not
   * credential- or destruction-shaped, several times per sitting is
   * normal" reasoning than to `ruleList`/`adherenceDisplay`'s "once per
   * page load" cadence — reuses that exact budget rather than inventing a
   * fourth near-identical number.
   */
  ruleForEdit: {
    ip: { limit: 60, windowSeconds: 3600 },
    email: { limit: 40, windowSeconds: 3600 },
  },
} as const satisfies Record<string, { ip: RateLimitRule; email?: RateLimitRule }>;

export type RateLimitScope = keyof typeof RATE_LIMITS;
