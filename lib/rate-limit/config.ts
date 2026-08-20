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
} as const satisfies Record<string, { ip: RateLimitRule; email?: RateLimitRule }>;

export type RateLimitScope = keyof typeof RATE_LIMITS;
