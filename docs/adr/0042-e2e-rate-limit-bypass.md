# ADR 0042 — E2E rate-limit bypass (dev/test only, fail-closed)

**Date:** 2026-09-14 · **Status:** accepted

## Deviation

Module 01 §7.2 says connect and auth endpoints throttle per user and per IP, "mandatory, no exceptions". `lib/rate-limit/limiter.ts` now returns early when `lib/rate-limit/test-bypass.ts`'s `rateLimitBypassedForTests()` is true.

## Why

The Playwright suite (78 tests across 20 files, 2026-09-13) signs in a fresh user per test from one IP, so a full run structurally exceeds `signin.ip` (20 per 15 min) and 61/78 tests fail with "Too many attempts" regardless of code correctness. Options weighed: (a) loosen the real limits — weakens production; (b) share one session across tests via Playwright `storageState` — breaks the many RLS-isolation tests that need distinct users; (c) a test-only bypass gated the same way `lib/entitlements/dev-tools-guard.ts` already is. (c) chosen.

## Cost / guard

- Two independent explicit conditions: `NODE_ENV !== 'production'` **and** `RETROSPEQ_E2E_RATE_LIMIT_BYPASS === 'true'`. Unset, misspelled, or any non-literal value → limiter runs. Unit-tested in `lib/rate-limit/__tests__/test-bypass.test.ts`.
- One read site. `retrospeq-security-reviewer` treats any second reader of the flag, or any bypass in `lib/rate-limit/limiter.ts` that is not this one call, as a blocking finding.
- The flag is set only by `playwright.config.ts`'s `webServer.env` and never in `.env.local.example`'s active lines.
- `rate-limit.rls.test.ts` / `limiter.test.ts` still prove the real limiter; the bypass is not on in vitest.
