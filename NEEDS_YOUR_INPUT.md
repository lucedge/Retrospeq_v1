# Needs your input

If this file has no entries below the line, **nothing needs you right
now** — agents are unblocked and working. If an entry appears, it
means an agent hit something only you can resolve (a real account, a
credential, a genuine product-decision gap) and stopped rather than
faking it. See `AGENTS.md` → "When something needs the owner" for the
rule this file exists to enforce.

Check this file (not `PROGRESS.md`'s prose) when you want a fast, glanceable
answer to "does anything need me right now."

---

## Transactional email is broken on the shared dev/test Supabase project

**What's needed:** Check the Supabase dashboard (Authentication → Email
Templates / SMTP Settings) for the shared dev/test project
(`vbuzudbipftgsuosreuy`, per `docs/adr/0002-shared-dev-supabase-project.md`)
— `signUp()` and `resetPasswordForEmail()` both return a `500
unexpected_failure` (surfaces in this app as `AuthRetryableFetchError` →
mapped to `AUTH_MAILER_UNAVAILABLE`, "We couldn't send that email right
now"). Confirmed directly and repeatedly (2026-08-20, both
retrospeq-tester and this orchestrator session, independently, hours
apart) against a real signup with a fresh email each time — not a
one-off blip. Likely cause: no custom SMTP configured, combined with
Supabase's built-in test mailer being disabled/exhausted/misconfigured
on this project — but that's a guess; only dashboard access can confirm.

**Why an agent can't fix this:** no API or DB permission controls a
Supabase project's mailer configuration — it's dashboard-only.

**What's stalled:** 3 of 5 Module 01 email-dependent E2E tests
(`e2e/auth.spec.ts` — signup happy path, signup-with-existing-email,
password-reset no-enumeration) cannot complete the "check your email"
step and fail at that assertion. This does **not** block marking Module
01's auth slice (stories 1.1-1.3) done: the underlying logic for all
three flows is fully verified other ways — 100% branch coverage on
`mapAuthError` including this exact failure mode
(`lib/auth/__tests__/errors.test.ts`), the other 2 E2E tests pass
(invalid-credentials, reset-password/confirm render), and RLS/unit
coverage is comprehensive. It does mean nobody has watched a real
confirmation or reset email actually arrive yet.

**What was built in the meantime:** nothing stubbed — the code paths are
real and correctly mapped; this is purely an external service check.

---

_(`SUPABASE_DB_URL` was supplied 2026-08-20 and connection/migration verification is done, see PROGRESS.md decision log. The `retrospeq` schema is real.)_

One still-open, non-blocking item whenever convenient: the "Exposed schemas" dashboard toggle (Project Settings → API → add `retrospeq`) — only needed for the app's own client-side/REST access at runtime (e.g. `.from()`/`.rpc()` calls), not for anything happening right now. `lib/rate-limit/limiter.ts` (added 2026-08-20) works around this by using a direct Postgres connection instead, so this is not blocking that either.
