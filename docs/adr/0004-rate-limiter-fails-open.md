# ADR 0004: The rate limiter fails open on unexpected infrastructure errors

**Status:** Accepted, 2026-08-20 (retrospeq-orchestrator, same slice as
ADR 0003).

## Context

`lib/rate-limit/limiter.ts`'s `checkOne` distinguishes two failure
classes when the check against `retrospeq.rate_limit_hits` itself fails:

1. `SupabaseNotConfiguredError` — `SUPABASE_DB_URL` is genuinely unset.
   This is a real configuration gap and, per every other client factory
   in this repo (`lib/supabase/errors.ts`'s `requireEnv` contract, and
   AGENTS.md's "never fake it, always flag it"), must fail loudly. It is
   rethrown, blocking the request.
2. Anything else — a network blip, connection-pool exhaustion, a
   transient Postgres error. These are logged (`console.warn`) and the
   check returns normally, **allowing the request through** rather than
   blocking it.

00-foundation doesn't prescribe which way a rate limiter should fail
when its own storage is unavailable, and this is a genuine
security/availability tradeoff worth recording rather than leaving as
an unstated implementation detail (retrospeq-qa flagged its absence
from `docs/adr/` on this slice's review).

## Decision

Fail open (allow the request) on case 2, not closed.

Reasoning:

- Case 1 already covers the scenario that actually indicates something
  is badly wrong (missing config) — case 2 is specifically the
  "otherwise-working system had a transient hiccup" case.
- An auth outage caused by the rate limiter's own infrastructure would
  be strictly worse for every legitimate user than the residual abuse
  risk of a brief throttling gap during that hiccup. Authentication is
  this product's front door; a self-inflicted outage there fails the
  whole product, not just one control.
- **Supabase Auth's own server-side rate limits remain in effect
  underneath this one regardless.** This was not a theoretical backstop
  — `over_email_send_rate_limit` / `over_request_rate_limit` /
  `over_sms_send_rate_limit` are real GoTrue error codes this repo's
  `mapAuthError` (`lib/auth/errors.ts`) already had to handle before
  this slice's own rate limiter existed at all, discovered while writing
  this slice's E2E tests. A fail-open window in the app-level limiter is
  not a fail-open window in *all* throttling for the endpoint.

## Consequences

- A sustained Postgres connectivity failure (not just a blip) means the
  app-level per-scope limits in `lib/rate-limit/config.ts` are
  effectively unenforced for that duration — bounded only by Supabase
  Auth's own limits, which are coarser and not customized per this
  product's endpoints. This is a known, accepted residual risk, not an
  oversight.
- If real traffic ever shows this being exploited (deliberately
  triggering DB errors to bypass throttling), the fix is narrowing the
  fail-open catch to specific, known-transient error classes (timeout,
  connection reset) and failing closed on anything else — not
  abandoning fail-open entirely, since the outage risk reasoning above
  still holds for genuine infrastructure faults.
- This choice should be revisited once real production traffic and
  monitoring exist; there is no data yet to confirm or challenge the
  tradeoff at the scale this reasoning was made for (a single shared
  dev/test project, no production deployment — see PROGRESS.md "Infra
  gaps").
