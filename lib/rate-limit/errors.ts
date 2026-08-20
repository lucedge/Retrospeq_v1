/**
 * Thrown by `checkRateLimit` (limiter.ts) when a scope+identifier bucket
 * is over its configured limit for the current window. Every call site
 * in app/(auth)/actions.ts and app/auth/callback/route.ts catches this
 * alongside a Supabase auth error and maps it through the exact same
 * `AUTH_RATE_LIMITED` shape `lib/auth/errors.ts` already defines for
 * Supabase's own `over_email_send_rate_limit` — one user-facing message
 * for "too many attempts," regardless of which layer caught it.
 */
export class RateLimitExceededError extends Error {
  readonly scope: string;
  readonly identifier: string;
  readonly retryAfterSeconds: number;

  constructor(scope: string, identifier: string, retryAfterSeconds: number) {
    super(
      `Rate limit exceeded for scope="${scope}" identifier="${identifier}" ` +
        `(retry after ${retryAfterSeconds}s). Identifier is an IP or a lower-cased ` +
        `email, never a password or other secret — safe to log.`,
    );
    this.name = 'RateLimitExceededError';
    this.scope = scope;
    this.identifier = identifier;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
