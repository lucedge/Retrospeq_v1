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
} as const satisfies Record<string, { ip: RateLimitRule; email?: RateLimitRule }>;

export type RateLimitScope = keyof typeof RATE_LIMITS;
