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
} as const satisfies Record<string, { ip: RateLimitRule; email?: RateLimitRule }>;

export type RateLimitScope = keyof typeof RATE_LIMITS;
