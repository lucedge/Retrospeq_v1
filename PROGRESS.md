# Retrospeq build ledger

Single source of truth for "what's done, what's next, what's blocked."
Every agent (coder, tester, security-reviewer, qa, orchestrator) reads
this before starting and updates it before finishing. This is the only
continuity mechanism across context resets and scheduled-restart gaps
— treat a stale or missing update as a bug in the run, not a formality.

## Autonomy policy

Owner-approved 2026-08-19: agents may commit and push to `main` and
deploy to production with no human review gate. This does not waive
the mandatory quality gates in AGENTS.md ("Security bar", "Testing
bar") — those are the spec's own definition of done, not a
discussion-avoidance layer. A module is not "complete" in this ledger
until its security tests and RLS coverage pass, regardless of push
authority.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Golden fixture library + shadow harness | Fixture library built (8/8, `fixtures/golden/`); shadow harness infrastructure built (`shadow_runs` migration + `lib/analytics/shadow-harness/`), unit/property tested, and **RLS cross-user isolation now verified against the live DB** (2026-08-20 — the `profiles`-table forward dependency that blocked this is resolved; see decision log). Harness infra only — no real shadow analytics registered yet, tracked for Phase 3 alongside Module 05's edge engine |
| 1 | Module 01 (Identity & Accounts) + Module 02 (Trade Ingestion & Model) | **COMPLETE (2026-08-23).** Module 01 and Module 02 are both fully built — coded, tested, security-reviewed, QA-reviewed. Every backend security review either module required found and closed at least one real issue before passing (concurrency races in `erasure.ts`, `confirm.ts`, and `split-join.ts` — all the same bug class, all fixed with the same atomic-conditional-UPDATE pattern; a DB-level lock-enforcement gap in `trade_captures`; a freeze-trigger transition-window gap) — the gate did its job every time it fired, never rubber-stamped. Phase 1 boundary process done: a `simplify` pass over Module 02's ~7,770 lines of production code (two safe extractions applied, several real-but-riskier findings deliberately deferred with reasoning logged), then `retrospeq-docs` brought `docs/DEVELOPMENT.md` fully current. 951 tests passing, 12 skip-guard fallbacks, 0 failed. Clean build/lint/tsc. |
| 2 | Module 04 (Rulebook & Evaluation) + Module 08 onboarding | Not started |
| 3 | Module 03 (Field Registry & Strategy) + Module 05 (Analytics & Findings) | Not started |
| 4 | Module 06 (Review & Graduation) + Module 07 (Engagement) | Not started |
| v1.1 | Module 09 (Prop firm rulebooks) + Module 10 (AI layer) | Deferred |

## Current task

**→ Phase 1 (Module 01 + Module 02) is COMPLETE as of 2026-08-23. Phase 2
(Module 04: Rulebook & Evaluation, + Module 08 onboarding) has NOT started
yet — that is the next work.** Read `retrospeq-design-system/modules/
04-rulebook-and-evaluation.md` and `08-onboarding-and-home.md` in full,
plus `00-foundation.md`, before starting. Module 04 depends directly on
Module 02's `trades`/`trade_facts`/`trade.confirmed` (now real — the
2026-08-22 decision-log entry that deferred reordering to Phase 2 is now
moot, Module 02 is done, build Module 04 against the real schema, not a
stub). Module 08's onboarding flow composes Modules 01+02, which now
both exist for real. Break Module 04 into slices the same way Module 02
was (field registry/expression-catalogue schema first, then the
evaluation engine itself — remember the non-negotiable "no compound
rules, no AND/OR, ever, in the model/API/UI" and "rule expression engine:
`{operand_id, op, value}` only, never compiled to SQL, never eval'd" —
these are the two things most likely to get silently violated if built
carelessly). The rest of this "Current task" section below is the full
historical build log for Phase 0/Phase 1 — read it for context on
established patterns (direct-pg access, the RLS shapes, the two-phase
withUserConnection/withServiceRoleConnection write pattern, the atomic
concurrency-guard pattern needed on any mutable status/timestamp column)
but the ACTIONABLE next step is Phase 2, not anything below this
paragraph.

---

**Phase 0 — complete.** 8/8 golden fixtures (`fixtures/golden/`); shadow
harness infrastructure (`lib/analytics/shadow-harness/`, `shadow_runs`
table) built, tested (27 tests, ~98% coverage), and as of 2026-08-20 its
RLS is now actually verified against the live DB too (the `profiles`
forward-dependency block resolved once Module 01's migration landed —
see decision log). Real shadow-analytic registrations (`spec.weekday`
etc.) remain deferred to Phase 3 (need Module 02's confirmed trades +
Module 05's edge engine) — not a regression, always the plan.

**Phase 1 — in progress. Module 01 slice 1 done** (stories 1.1-1.3:
email/Google signup, sign-in, sign-out, password reset):

- `supabase/migrations/20260820010000_profiles.sql` — `profiles` table
  + `handle_new_user` trigger, `20260820020000_retrospeq_schema_grants.sql`
  — schema-level GRANTs to anon/authenticated/service_role (a real gap
  found while writing RLS tests: GRANT is necessary but not sufficient,
  RLS does the narrowing — see that migration's own header), and
  `20260820030000_rate_limit_hits.sql` — the rate-limit bookkeeping
  table + `increment_rate_limit()` function. All three applied to and
  verified against the live shared dev Supabase project.
- `lib/supabase/`, `lib/auth/`, `app/(auth)/`, `app/auth/callback/`,
  `proxy.ts` — the auth Server Actions, error mapping, Zod schemas, and
  the four UI screens (login/signup/reset-password/reset-password-confirm).
- `lib/rate-limit/` — Module 01 §7.2's mandatory per-IP-and-per-user
  throttle on every auth endpoint, added after retrospeq-security-reviewer
  correctly failed the slice for having zero throttling on first pass.
  Direct-`pg` fixed-window counter (ADR 0003 explains why not
  supabase-js), fails loudly on missing config, fails open on unexpected
  DB errors (ADR 0004 explains the tradeoff).
- Tests: 131 passing, 3 skip-guard fallbacks (env-gated live-DB suites —
  the env is present in this repo, so they actually ran), 99.34%
  line coverage on all new code. RLS cross-user isolation verified live
  for `profiles` and `rate_limit_hits` (zero-policy/service-role-only
  shape for the latter, matching `account_credentials`'s spec'd shape).
  `npm run build` and `npm run lint` both clean.
- E2E (`e2e/auth.spec.ts`, Playwright — browsers installed to
  `E:\playwright-browsers`, not the default C: path, same disk-space
  constraint as the npm cache redirect): 2/5 pass outright
  (invalid-credentials error path, reset-password/confirm empty-state
  render — screenshots reviewed, match the design system). The other
  3 (signup happy path, signup-duplicate-email, password-reset
  no-enumeration) cannot complete past their "check your email" step —
  **the shared dev Supabase project's transactional email sending is
  genuinely broken** (`500 unexpected_failure`, confirmed independently
  by both retrospeq-tester and this orchestrator session hours apart),
  not a code defect — see `NEEDS_YOUR_INPUT.md`. The exact failure mode
  is itself proof the error-mapping code works correctly
  (`AUTH_MAILER_UNAVAILABLE`, 100%-covered branch in
  `lib/auth/__tests__/errors.test.ts`).
- Security-reviewed: one blocking FAIL (missing rate limiting) on first
  pass, fixed, re-reviewed, PASS. QA-reviewed: PASS, two findings
  (missing ADRs, an unverified "sessions invalidated on reset" claim)
  both fixed same-session (ADR 0003/0004 written; `confirmPasswordReset`
  now explicitly calls `signOut({ scope: 'others' })` instead of
  assuming `updateUser` does it, with a test proving the call happens
  in the right order and doesn't block the redirect on its own failure).

**Module 01 stories 2.x — backend foundation done and reviewed.**
Built (not yet UI-wired — that's the next slice):

- `supabase/migrations/20260820040000_trading_accounts.sql` —
  `retrospeq.trading_accounts` (standard owner RLS policy) and
  `retrospeq.account_credentials` (RLS enabled, owner INSERT+DELETE
  policies only, deliberately **no** SELECT or UPDATE policy for any
  client role, per Module 01 §3.3) exactly per spec §3.1. Applied to and
  verified against the live shared dev Supabase project (tables, RLS
  enabled flags, exact policy predicates, and table-level GRANTs all
  confirmed via `information_schema`/`pg_policies` — same verification
  method as prior migrations).
- `lib/broker/adapter.ts` — the `BrokerAdapter` interface
  (00-foundation §10.1) with full TypeScript types for
  `Fill`/`Position`/`PositionSnap`/`TierFlags`/`AccountHandle`, informed
  by Module 02's golden fixtures' fill shape and the `fills`/
  `position_snapshots` table DDL. A conforming `connect()` implementation
  must perform Module 01 §4.1's mandatory read-only verification
  internally (there's no separate adapter method for it — the interface
  itself fixes this) and throw one of four typed errors
  (`BrokerAuthFailedError`, `BrokerCredentialTooPermissiveError`,
  `BrokerServerUnknownError`, `BrokerVendorUnavailableError`) for the
  taxonomy in Module 01 §9.
- `lib/broker/fixture-adapter.ts` — a deterministic, clearly-named
  fixture/test-only `BrokerAdapter` (`import 'server-only'`), never a
  stand-in silently presented as a real broker; `behavior` is a required
  config field (`connect_ok` | `auth_failed` |
  `credential_too_permissive` | `server_unknown` | `vendor_unavailable`),
  so a caller must explicitly choose which scenario it exercises.
- `lib/broker/envelope-encryption.ts` — the crypto layer
  (`encryptCredential`/`decryptCredential`, Node's built-in `crypto`,
  AES-256-GCM). `createKmsMasterKeyProvider()` throws
  `KmsNotConfiguredError` unconditionally — no external KMS vendor
  chosen yet (infra gap) — with a `TODO(kms)` marking exactly where the
  real vendor SDK call goes once one exists. No static/local
  fallback key exists anywhere in this file.
- `lib/broker/connect.ts` — the connection-flow orchestration (Module 01
  §4.1 steps 2-6): Zod-validated input, `adapter.connect()`, the
  mandatory read-only check (enforced by the adapter's own contract,
  plus a defence-in-depth re-check on `handle.verifiedReadonly` here),
  `adapter.capabilities()`, `encryptCredential`. Returns what to persist;
  does not touch Postgres itself (kept out of scope for this slice).
- **Real, load-bearing finding, not just a test artifact:** while writing
  the live-DB RLS test for `account_credentials`, discovered and verified
  (Postgres 17.6, reproduced on an isolated scratch table) that a table
  with INSERT+DELETE policies but no SELECT policy cannot support a
  WHERE-qualified UPDATE/DELETE under RLS at all — Postgres folds the
  query to "One-Time Filter: false" regardless of whether the row would
  match the DELETE policy's own USING clause. `docs/adr/0005-account-
  credentials-writes-via-service-role.md` documents this and the
  consequence: the real connect/disconnect Server Action (next slice)
  must use the service-role client for `account_credentials` writes,
  with ownership checked at the application layer — not a direct
  RLS-scoped client call. `lib/broker/connect.ts`'s doc comment points
  at this ADR so it isn't rediscovered the hard way again.
- Tests: 30 unit tests in `lib/broker/__tests__/` (envelope round-trip +
  tamper detection on all four fields, fixture-adapter behavior
  coverage, and `connect.ts`'s master-credential-rejection path tested
  at the weight Module 01 §7.2/§8 requires — including a defence-in-depth
  case for a hypothetically misbehaving adapter, plus a regression test
  for the Zod fix below) — 98.68% line coverage on `lib/broker/`. Plus
  19 live-DB RLS tests in `lib/supabase/__tests__/trading-accounts.rls.test.ts`
  (cross-user isolation on both tables, the check-constraint backstop,
  and the service-role-only access pattern for credentials, including
  the ADR 0005 behavior). Full suite: **180 passing**, 4 skip-guard
  fallbacks (unaffected — env is present). `npm run build` and
  `tsc --noEmit` both clean; lint has only pre-existing-pattern warnings
  (unused `_prefixed` params, matching an existing warning already in
  `app/(auth)/actions.ts`).
- **Security-reviewed: one FAIL, fixed, re-reviewed PASS.**
  `connectTradingAccountInputSchema` used plain `z.object()`, which
  silently strips unrecognised keys instead of rejecting them —
  violates 00-foundation §4.2's "reject unknown keys," verbatim.
  Switched to `z.strictObject()`; added a regression test proving an
  unrecognised key blocks the flow before the adapter is ever called.
  Re-reviewed: PASS. Every other area (RLS shape, envelope encryption,
  the read-only-verification chain, vendor-type isolation, no-credential-
  in-errors, ADR 0005's RLS reasoning) passed on the first review.
- **QA-reviewed: PASS**, with one forward-looking note (not a fix
  needed now): story 2.3 ("crypto trader ... keys with trade or
  withdrawal scope rejected with a named reason") isn't fully
  representable yet — the current error taxonomy folds every
  too-permissive credential (MT master password or an overprivileged
  crypto API key alike) into one `CONNECT_CREDENTIAL_TOO_PERMISSIVE`
  with one fixed, MT-investor-vs-master-worded message. Reasonable for
  this broker-generic slice; whichever future slice builds a real
  crypto-exchange adapter needs a scope-specific rejection reason, not
  reuse of this exact message unchanged.
- `docs/runbook.md` — two new entries for alerting conditions this
  slice's code makes real: "Any credential decryption failure" (pages
  on-call, 00-foundation §7.3) and "Broker/vendor connection outage
  during connect" (`CONNECT_VENDOR_UNAVAILABLE`).
- **Explicitly NOT built in this slice** (by design, per the dispatch):
  any UI screen, the Server Action that actually performs the
  `trading_accounts`/`account_credentials` INSERT (the next slice —
  must follow ADR 0005's service-role guidance), and Module 02's
  sync/import.
**Module 01 stories 2.x — UI/Server-Action layer built, reviewed, done.**

- `docs/adr/0006-account-writes-direct-postgres.md` — a real, live-probed
  finding while wiring the Server Action: PostgREST returns
  `406 PGRST106 "Invalid schema: retrospeq"` for `trading_accounts` too,
  not just the credentials table ADR 0005 already knew about — the
  `retrospeq` schema still isn't in "Exposed schemas" (unchanged from
  ADR 0002/0003's finding). Both `lib/supabase/server.ts`'s RLS-scoped
  client and `lib/supabase/service.ts`'s service-role client would 404
  against any `retrospeq` table via `.from()`. Resolution: `lib/supabase/direct.ts`,
  a direct-`pg` module (mirrors ADR 0003's rate-limiter pattern) with two
  entry points — `withUserConnection` (`SET LOCAL ROLE authenticated` +
  `request.jwt.claims`, genuinely RLS-enforced, not just app-layer-trusted)
  and `withServiceRoleConnection` (`SET LOCAL ROLE service_role`,
  bypasses RLS per ADR 0005). This satisfies ADR 0005's requirement in
  spirit — same security property, reached one layer below PostgREST —
  not by literally using `lib/supabase/service.ts`.
- `lib/broker/accounts-repository.ts` — all `trading_accounts`/
  `account_credentials` reads/writes the Server Actions need, built on
  `lib/supabase/direct.ts`. `DuplicateAccountError` maps the
  `(user_id, platform, provider_ref)` unique-violation to a friendly
  message.
- `lib/broker/platform-defaults.ts` — per-platform label/day-rollover/
  currency/credential-kind defaults (story 3.1/3.2's rollover defaults;
  editing them is that story's own settings screen, not this slice's).
- `app/(app)/layout.tsx` (minimal authenticated shell + auth guard),
  `app/(app)/accounts/page.tsx` (account list, direct-pg read since
  `.from()` can't reach this schema), `app/(app)/accounts/connect/page.tsx`
  (connect form, `useActionState`), `app/(app)/accounts/actions.ts`
  (`connectAccount`/`disconnectAccount` Server Actions).
- `connectAccount` only ever constructs `lib/broker/fixture-adapter.ts`'s
  fixture adapter (no real vendor exists — PROGRESS.md's own standing
  gap) via a clearly-commented, dev-only `pickFixtureBehavior` heuristic
  keyed on the submitted credential text (e.g. containing "master" ->
  simulated `credential_too_permissive`), so the connect screen is
  genuinely exercisable end-to-end including the mandatory rejection
  path, not just simulating success.
- **Real bug found and fixed via the mandatory screenshot self-check,
  not just a code read:** `createKmsMasterKeyProvider()` was originally
  called eagerly as a call argument
  (`connectTradingAccount(adapter, input, createKmsMasterKeyProvider())`) —
  since it throws unconditionally (no real KMS yet), JS's eager argument
  evaluation meant it threw *before* `connectTradingAccount` ever ran,
  short-circuiting Module 01 §4.1 steps 3-4 (auth + the mandatory
  read-only check) for every credentialed attempt and masking
  `CONNECT_CREDENTIAL_TOO_PERMISSIVE`/`CONNECT_AUTH_FAILED`/etc behind a
  generic KMS error. A screenshot of submitting a "...master-password"
  credential showed the wrong message (KMS-not-configured instead of the
  rejection alert), which is what caught it. Fixed with
  `lazyKmsMasterKeyProvider()` — defers the real provider call (and its
  throw) until `wrapDataKey` is actually invoked inside step 6, which
  only happens after steps 3-4 already succeeded. Regression test added
  (`app/(app)/accounts/__tests__/actions.test.ts`) proving a master
  credential still surfaces the correct rejection even with an
  always-throwing KMS provider.
- **Consequence, not a bug, documented in `docs/runbook.md`'s new
  entry:** every *credentialed* platform (MT4/MT5/cTrader/Binance/Bybit)
  still cannot complete a real connect today — it correctly fails at
  step 6 with a named `CONNECT_KMS_NOT_CONFIGURED` error rather than
  faking success, because no real external KMS exists yet (standing
  infra gap). Only `manual` accounts work end-to-end right now. This is
  the expected, honest behavior per AGENTS.md ("never fake it"), not a
  regression — verified directly: the rejection/auth-failure/manual
  paths were screenshot-confirmed working; a real KMS is a genuine
  prerequisite before any credentialed platform can be enabled in
  production.
- Tests: 16 new Server Action unit tests (mocked session/repository/KMS,
  `app/(app)/accounts/__tests__/actions.test.ts`) plus 5 new live-DB
  tests (`lib/broker/__tests__/accounts-repository.live.test.ts`) proving
  `lib/supabase/direct.ts` genuinely enforces RLS and the service-role
  bypass against the real shared dev/test project (cross-user isolation,
  duplicate-account rejection, the full connect->disconnect lifecycle).
  Full suite: **203 passing**, 5 skip-guard fallbacks (env present,
  nothing actually skipped except each live suite's own inert
  placeholder). `npm run build`, `tsc --noEmit`, and `npm run lint` all
  clean (lint: only pre-existing-pattern `_prefixed`-unused-param
  warnings). One live-DB test needed its timeout raised from vitest's
  5000ms default to 20s (`accounts-repository.live.test.ts`'s full
  connect->disconnect lifecycle test chains 8 sequential live-DB round
  trips — a genuine budget issue, reproduced consistently, not a flake).
- Screenshot self-check performed against the real running dev server +
  real Supabase Auth (a confirmed test user created via the GoTrue admin
  API, since transactional email is still broken on this project — see
  `NEEDS_YOUR_INPUT.md`): empty account list, empty connect form, the
  live rejection alert, the manual-platform success/capability screen,
  the account list with a connected manual account, and the
  disconnected state after clicking Disconnect — all screenshots
  reviewed and matched the design system (amber accent only, no red/
  green, one primary `.rq-btn` per view, `.rq-tag`-based status chips
  carrying text not colour, `.rq-pill` platform picker).
- **Security-reviewed: one FAIL, fixed, re-reviewed PASS.** Module 01
  §7.2's mandatory "service-role inventory" test (originally written for
  `createServiceRoleClient(` only, per `lib/supabase/service.ts`'s own
  doc comment) had gone stale — nothing enumerated the new
  `withServiceRoleConnection(` call sites this slice added. Fixed with
  `lib/supabase/__tests__/service-role-inventory.test.ts`, which walks
  the whole repo source tree and asserts the exact file set containing
  either pattern matches a reviewed allowlist (exact-set equality, so a
  new unreviewed call site anywhere fails it). `lib/supabase/service.ts`'s
  doc comment updated to describe both RLS-bypass mechanisms instead of
  only the one it originally covered. Re-reviewed: PASS. Every other
  area (JWT-claims simulation genuinely enforcing RLS not just app-layer
  trust, service-role call-site scoping, `pickFixtureBehavior`'s safety,
  rate limiting, credential-leakage) passed on the first review.
- **QA-reviewed: PASS**, with one drift item and one copy nit, both
  fixed same-session: (1) this PROGRESS.md section itself was stale
  (said "200 passing" after the security fix added 3 more tests) — now
  corrected. (2) The manual-account success screen was reusing
  credentialed-platform copy ("Not available on this broker") for a
  mode that has no broker at all — fixed with an `isManual` flag threaded
  through `AccountActionState` so manual accounts now say "Entered
  manually, not synced"; re-screenshotted and visually confirmed
  (`tmp/dev-screenshots/connect-success.png`).

**Module 01 stories 1.4 (session list/revoke) + 1.5 (2FA/TOTP) — coder
pass complete, tester/security-reviewer/qa passes pending.**

- `supabase/migrations/20260821010000_mfa_recovery_codes.sql` —
  `retrospeq.mfa_recovery_codes` (standard owner RLS policy per
  00-foundation §3.1 default; no §3.3 exception applies since only
  SHA-256 hashes are stored, never plaintext — see the migration's own
  comment). Applied to and verified against the live shared dev
  Supabase project (RLS-enabled flag and the exact policy confirmed via
  `pg_policies`, same verification method as every prior migration).
- `lib/auth/mfa-recovery-codes.ts` (10-code batch generation/hashing,
  pure functions), `lib/auth/mfa-recovery-repository.ts` (direct-pg
  reads/writes via `withUserConnection`, per ADR 0002/0003/0006 — this
  table lives in the `retrospeq` schema too), `lib/auth/mfa-admin.ts`
  (the one new `createServiceRoleClient(` call site — service-role
  `auth.admin.mfa.listFactors`/`deleteFactor`, used only for recovery-
  code redemption), `lib/auth/mfa-schemas.ts` (Zod boundary schemas).
  `docs/adr/0007-mfa-recovery-codes-own-system.md` records why: Supabase
  Auth's MFA API issues no recovery codes of its own (verified directly
  against `node_modules/@supabase/auth-js`'s shipped types, not
  assumed), and why redemption removes 2FA entirely (via the admin API)
  rather than granting a one-time step-up (`mfa.unenroll()` itself
  requires an aal2 session, which a trader who lost their device cannot
  reach — the exact scenario recovery exists for).
- `app/(app)/security/actions.ts` + `page.tsx` + `SecurityScreenClient.tsx`
  — the "Privacy screen"'s session/2FA half (export/delete/telemetry are
  stories 5.x, out of scope this slice). `beginTotpEnrollment` /
  `confirmTotpEnrollment` / `disableTotp` wrap `supabase.auth.mfa.*`
  directly; `revokeOtherSessions`/`revokeAllSessions` wrap
  `signOut({scope: 'others' | 'global'})` — see the decision-log entry
  below for why that, not a device list, is story 1.4's real shape.
- `app/(auth)/actions.ts`'s `signInWithEmail` now checks
  `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` after a
  successful password sign-in and redirects to the new
  `app/(auth)/mfa-challenge/` route (TOTP entry,
  `challengeAndVerify()`) when a verified factor exists and the session
  is still `aal1`; `app/(auth)/mfa-challenge/recovery/` is the paired
  lost-device path (`redeemRecoveryCodeAction`). Both routes re-derive
  the AAL check themselves rather than trusting the redirect that led
  there, so a direct/bookmarked visit never traps a trader who doesn't
  need to be there.
- **Real bug found and fixed via the mandatory screenshot self-check,
  not a code read:** `enroll()`'s own TS doc comment says to prepend
  `data:image/svg+xml;utf-8,` to the returned `totp.qr_code` before
  using it as an `<img src>` — but a live probe against this project's
  actual Supabase Auth response showed `qr_code` **already comes back
  with that prefix included**. Following the doc comment literally
  double-prefixed the data URI, rendering a broken image
  (`naturalWidth: 0`) with only the alt text visible — caught by the
  screenshot showing a blank QR area, not by inspecting the code.
  `toQrCodeDataUri()` in `app/(app)/security/actions.ts` now normalizes
  either shape defensively; a regression test asserts no double-prefix.
- Tests: 63 new unit tests (`lib/auth/__tests__/mfa-*.test.ts`,
  `app/(app)/security/__tests__/actions.test.ts`,
  `app/(auth)/mfa-challenge/__tests__/actions.test.ts`,
  `app/(auth)/mfa-challenge/recovery/__tests__/actions.test.ts`, plus 6
  new cases in the existing `app/(auth)/__tests__/actions.test.ts` for
  `signInWithEmail`'s step-up redirect) — 100% line coverage on every
  new `lib/auth/` file. Plus 10 new live-DB RLS tests
  (`lib/supabase/__tests__/mfa-recovery-codes.rls.test.ts`, cross-user
  isolation + the service-role bypass, same pattern as
  `trading-accounts.rls.test.ts`). `lib/supabase/__tests__/service-role-inventory.test.ts`'s
  allowlist updated for the one new `createServiceRoleClient(` call
  site. Full suite: **277 passing**, 6 skip-guard fallbacks (env
  present, nothing actually skipped). `npm run build`, `tsc --noEmit`,
  and `npm run lint` all clean (lint: only the same pre-existing
  `_prefixed`-unused-param warning pattern already noted elsewhere).
- Screenshot self-check against the real dev server + real Supabase
  Auth (a confirmed test user via the GoTrue admin API, plus a
  self-contained RFC 6238 TOTP implementation in the throwaway
  `tmp/screenshot-security.mjs` — no new npm dependency — to compute
  real 6-digit codes from the enrollment secret and drive the whole
  enroll -> verify -> recovery-codes-shown-once -> sign-out ->
  sign-in -> MFA-challenge -> home flow end-to-end): 2FA off, QR-code
  mid-enrollment (post-fix, rendering correctly), recovery codes shown
  once, 2FA on with "10 of 10 recovery codes remaining", the sign-in
  step-up screen, and the recovery-code redemption screen — all
  reviewed and matched the design system (amber accent only, no
  red/green, exactly one primary `.rq-btn` visible in every rendered
  state even though the page as a whole has several actions, `.rq-num`
  on every number/code). Also directly confirmed an *unverified*
  (started-but-not-confirmed) TOTP factor correctly does NOT trigger the
  sign-in step-up — only a verified one does.
- **Not yet done: retrospeq-tester/security-reviewer/qa passes.**
  Security review is mandatory here (touches auth/session security,
  MFA, a new service-role call site). Noted for retrospeq-tester: a real
  E2E suite for this flow needs the same real-TOTP-code-generation
  approach the screenshot script above already proves out (RFC 6238
  against the enrollment secret) — `speakeasy`/`otplib` or an equivalent
  would be a reasonable dependency to add for that pass rather than
  reimplementing it a second time; neither is installed yet.

**Module 01 stories 3.x (account settings) — coder pass complete,
tester/security-reviewer/qa passes pending.** No new tables/RLS/migrations
— edits the existing `trading_accounts` columns (`label`, `day_rollover`,
`account_kind`) that stories 2.x's connect flow already defaults.

- `lib/broker/accounts-repository.ts` — `updateTradingAccountSettings(userId, accountId, input)`
  (`WHERE id = ... AND user_id = ...`, `RETURNING`, under `withUserConnection`
  — this table has a real owner SELECT policy, unlike `account_credentials`,
  so `RETURNING` works here, ADR 0005's caveat doesn't apply) and
  `getTradingAccount(userId, accountId)` for the settings screen's prefill
  read. `dayRolloverSchema`/`updateTradingAccountSettingsInputSchema`
  (Zod, `z.strictObject`) validate the write.
- **Real finding, not invented for this slice:** `day_rollover` already
  has two distinct literal formats in live use across this repo —
  `'<IANA zone> HH:MM'` (`'America/New_York 17:00'`) and `'HH:MM:SS UTC'`
  (`'00:00:00 UTC'`, every golden fixture's crypto account and
  `platform-defaults.ts`'s crypto default). `dayRolloverSchema` validates
  against both rather than picking one — "don't invent a new format"
  meant matching real existing data, not normalizing it to a third shape.
- `ACCOUNT_KINDS`/`AccountKind` (`personal | prop | demo`, migration's own
  comment) now live in `lib/broker/platform-defaults.ts`, not
  `accounts-repository.ts` — a real build failure caught this:
  `accounts-repository.ts` pulls in `import 'server-only'` + direct-`pg`
  at module scope, and the settings form (a client component) needs the
  enum. `accounts-repository.ts` re-exports both so server call sites are
  unaffected; only the client form imports from `platform-defaults.ts`
  directly.
- `app/(app)/accounts/actions.ts`'s `updateAccountSettings` Server Action
  (session check, `accountSettings` rate-limit scope, Zod parse, repository
  call, `revalidatePath` on both `/accounts` and the settings route) and
  a new `app/(app)/accounts/[id]/settings/` route (server `page.tsx` +
  client `AccountSettingsForm.tsx`, same split as `security/page.tsx` +
  `SecurityScreenClient.tsx`) reached from a new "Settings" action on each
  account card in `app/(app)/accounts/page.tsx`, per Module 01 §5.1's
  literal "Actions: rename, settings, disconnect."
- `lib/rate-limit/config.ts`'s new `accountSettings` scope: looser than
  `connectAccount`/`disconnectAccount` (40/hr IP, 30/hr user) — not
  credential- or auth-shaped, not destructive, a trader plausibly retries
  a label/rollover edit a few times while getting it right. Still
  throttled, not exempt, per §7.2's blanket write-endpoint posture.
- Story 3.4 (prop marking, v1.1 stub), scope boundary logged explicitly
  per the dispatch: setting `account_kind = 'prop'` is data plumbing only
  — the settings form shows "Firm rulebook features are coming soon. This
  only labels the account for now." No rulebook logic, no Module 09 code,
  exactly per spec's "in v1 this stores the label and surfaces 'coming
  soon' — it does not create a rulebook."
- **Real bug found and fixed via the mandatory screenshot self-check, not
  a code read:** the settings form originally used uncontrolled
  `defaultValue` inputs. A prior *successful* save's `revalidatePath` call
  could cause Next to refetch the route's server props before a
  *subsequent failed* submission's own re-render landed, which reset the
  label field back to the last-saved server value and silently discarded
  whatever invalid text the trader had just typed — right on top of the
  validation error telling them to fix it. Caught by a screenshot of the
  40-char rejection showing "FTMO Challenge" (the prior save) in the field
  instead of the 41-`x` string actually submitted. Fixed by making
  `label`/`dayRollover`/`accountKind` controlled state that only
  re-syncs from the server on a confirmed successful save (React's
  documented "adjusting state during render" pattern, not a `useEffect` —
  the latter tripped `react-hooks/set-state-in-effect`), never on an
  unrelated revalidation. Re-screenshotted and confirmed the typed value
  now survives a validation error (`tmp/dev-screenshots/account-settings-label-too-long.png`).
- Tests: 24 new pure unit tests for the Zod schemas
  (`lib/broker/__tests__/account-settings-schemas.test.ts` — every real
  `day_rollover` shape accepted/rejected correctly, the 40-char boundary,
  `strictObject`'s unknown-key rejection, every `account_kind` value), 11
  new Server Action unit tests in `app/(app)/accounts/__tests__/actions.test.ts`
  (happy path, story 3.4's prop-label-only path, validation failures,
  not-found/not-owned, session-missing, rate-limited), and 3 new live-DB
  tests in `lib/broker/__tests__/accounts-repository.live.test.ts`
  (owner update succeeds and returns the updated row; a second user's
  call against user A's account touches zero rows and returns `null` —
  cross-user isolation proven against the real shared dev DB, not
  assumed from the table's existing RLS coverage; plus a third,
  orchestrator-added test for `getTradingAccount` itself — flagged by
  retrospeq-qa as having zero direct coverage despite being exactly what
  the settings page uses to decide "render the form" vs "we couldn't
  find that account," which is the safety property that keeps a
  stranger's account id in the URL from leaking whether it exists).
  Full suite: **321 passing**, 7 skip-guard fallbacks (env present,
  nothing actually skipped). `npm run build`, `npm run lint` both clean
  (lint: only the same pre-existing `_prefixed`-unused-param warning
  pattern already noted elsewhere).
- Screenshot self-check (`tmp/screenshot-account-settings.mjs`, real dev
  server + real Supabase Auth test user, same established pattern as
  `tmp/screenshot-accounts.mjs`): account list with the new "Settings"
  action visible, the settings screen prefilled with the connect flow's
  defaults, the prop-challenge "coming soon" state, a successful save,
  and the 40-char validation error (post-fix, preserving the typed value)
  — all reviewed and matched the design system (amber accent only, no
  red/green, exactly one primary `.rq-btn` per view — "Settings"/
  "Disconnect"/"Back to accounts" are all `.rq-btn--ghost`, "Save" is the
  one primary — `.rq-num` on the day-rollover value matching the account
  list's own numeric-time-display precedent, `.rq-pill` account-type
  picker matching the connect screen's platform picker).
- Does not touch credentials, encryption, or new RLS/migrations — the
  existing `trading_accounts` RLS (already tested) covers the new write
  path, proven again here at the repository-function level, not just
  assumed. Per AGENTS.md's security-review trigger list ("auth,
  credentials, RLS, or the rule engine"), a full security-reviewer pass
  is likely not strictly required for this slice; flagged for the
  orchestrator to decide, not skipped unilaterally.
- No new runbook entry — Module 01 §9's error table already covers every
  code this Server Action can surface (`ACCOUNT_NOT_FOUND`,
  `ACCOUNT_RATE_LIMITED`, `ACCOUNT_SESSION_MISSING`, none of them new
  alerting conditions per §7.3), and this is a low-risk settings edit
  with no credential/decryption/vendor-outage path — stated explicitly
  rather than inventing an entry for the sake of one.
- **QA-reviewed: PASS**, two quick fixes applied same-session: (1) the
  label `<input>` had no `maxLength` HTML attribute (only static hint
  text) — server-side Zod validation was always the real authority, but
  added `maxLength={40}` anyway for the UX affordance, matching this
  repo's own precedent elsewhere (`MfaChallengeForm.tsx`). Confirmed the
  existing 40-char-rejection tests exercise the schema/Server Action
  directly and are unaffected by the browser-level cap. (2) this
  PROGRESS.md section itself was stale (said "320 passing" / "2 new
  live-DB tests" before the orchestrator's `getTradingAccount` test
  landed) — corrected above.

**Module 01 stories 4.x (plan and entitlement) — built, security-reviewed
with one FAIL then a re-review FAIL on the testing bar specifically, both
now fixed. Genuinely done as of this session, not just coder-complete.**

- `lib/entitlements/` (`can()`, `capability-table.ts`'s exact transcription
  of §4.3's table, `resolve.ts`'s pure resolution functions,
  `account-usage.ts`'s real `account.connect` counter, `downgrade.ts`'s
  §4.4 downgrade/upgrade logic on `trading_accounts`, `subscription-
  repository.ts`, `billing.ts`'s honest "not configured yet" failure,
  `messages.ts`, `schemas.ts`), `supabase/migrations/20260821020000_subscriptions.sql`
  (`subscriptions` + `analytic_config`, ADR 0008's read-only-to-owner RLS
  shape), `supabase/migrations/20260821030000_trading_accounts_status_plan_limited.sql`,
  `app/(app)/plan/{actions,page}.tsx`. Committed as an emergency checkpoint
  when the prior session hit its usage limit mid-run — coder-complete and
  unit-tested at the time (321 passing), but explicitly **not yet**
  security-reviewed or tester-reviewed per that commit's own message.
- **retrospeq-security-reviewer reviewed it in two passes.** First FAIL
  (hardening): the dev-only entitlement-override tool
  (`setUserPlanForTesting`/`devSetPlan`/the plan page's render gate) each
  checked `process.env.NODE_ENV !== 'production'` independently — not real
  defense-in-depth, since all three are the same single condition and a
  misconfigured/unset `NODE_ENV` would fail all three open simultaneously
  at the exact point (`service_role`, RLS-bypassing) where RLS provides
  zero backstop. Fixed same-session (prior to this entry) with
  `lib/entitlements/dev-tools-guard.ts`'s `devEntitlementToolsEnabled()` —
  a single shared gate requiring TWO independent, both-explicit conditions
  (`NODE_ENV !== 'production'` AND an opt-in env var, unset/misconfigured
  always meaning OFF). Second FAIL (this session, testing bar
  specifically, not a code defect): two concrete missing-test items —
  (1) `docs/adr/0008-subscriptions-read-only-rls.md` and the subscriptions
  migration's own closing comment both referenced
  `lib/supabase/__tests__/subscriptions.rls.test.ts` as proof of the RLS
  shape against the live DB, but that file did not exist; (2) zero unit
  tests existed anywhere under `lib/entitlements/` despite Module 01
  §7.1 explicitly requiring "entitlement resolution across every plan ×
  capability pair" and "downgrade deactivates without deleting; upgrade
  restores exactly."
- **Both gaps closed for real this session, dispatched to retrospeq-tester:**
  - `lib/supabase/__tests__/subscriptions.rls.test.ts` (18 tests, live DB):
    proves `subscriptions`' RLS shape exactly as ADR 0008 claims — a user
    reads their own row (confirming the `handle_new_user` trigger's
    `plan='free'`/`status='active'` defaults), cannot read a second user's
    row, an anonymous client reads nothing, and critically **cannot
    self-write `plan='pro'` via a direct `UPDATE ... WHERE user_id =
    auth.uid()`** (zero rows affected — the core security property the
    whole RLS shape exists to prevent, a free self-granted paid plan with
    no billing event). Also covers INSERT/DELETE (both correctly blocked;
    INSERT throws an explicit RLS-violation error rather than affecting
    zero rows — a real, verified distinction from UPDATE/DELETE's silent
    no-op, matching the same shape `trading-accounts.rls.test.ts` already
    established for `account_credentials`) and the service-role bypass
    (read + write both work as `service_role`, proving
    `setUserPlanForTesting`'s real write path). `analytic_config`'s RLS
    covered in the same file: every authenticated user reads every row
    (`using (true)`, no `user_id` column), no client role can write.
  - 11 new unit-test files under `lib/entitlements/__tests__/`
    (`resolve.test.ts`, `can.test.ts`, `downgrade.test.ts` +
    `downgrade.live.test.ts`, `subscription-repository.test.ts`,
    `billing.test.ts`, `account-usage.test.ts`, `messages.test.ts`,
    `schemas.test.ts`, `service.test.ts`, plus the pre-existing
    `dev-tools-guard.test.ts`): every plan × capability pair from §4.3's
    table asserted literally (boolean capabilities' yes/no per plan;
    quantity capabilities' under/at/over-cap and the `null`-unlimited and
    `limit=0`-plan-exclusion branches), including the `'not_yet_checkable'`
    fail-closed case for `rules.create`/`rules.hard`/`strategy.create`/
    `fields.custom` (no backing table yet) asserted explicitly rather than
    skipped. `account.connect` tested with an injected fake `UsageCounter`
    (under/at/over cap, unlimited-on-pro). `downgrade.ts` gets BOTH a
    mocked SQL-shape test (exact query text/params — `order by
    connected_at asc nulls last, created_at asc`, `offset $2`, the
    null-free-cap defensive branch) AND a live-DB scenario per this task's
    own "prefer the live-DB version" guidance: 3 real accounts with
    staggered `connected_at`, downgrade to Free (cap=1) — proves the
    OLDEST-connected account is the one kept `connected` and the other two
    become `plan_limited` (not deleted — all 3 rows still exist), then
    upgrading reactivates both exactly. `getUserPlan`'s fail-closed
    default (missing/unrecognised plan → `'free'`, with a `console.warn`)
    and `setUserPlanForTesting`'s guard (mocking `dev-tools-guard.ts`
    itself, not re-testing its internals) both covered.
  - **Result: `lib/entitlements/` now at 100% line/branch/function
    coverage** (was 0% before this session). Full repo suite: **424
    passing, 9 skipped** (all 9 are the deliberate `describe.skipIf(!!env)`
    skip-acknowledgment blocks paired with every live-DB suite in this
    repo — the env IS present here, so every real live-DB test actually
    ran, nothing silently faked). Overall repo coverage **98.82%
    lines / 94.25% branch** — both comfortably above 00-foundation §9.1's
    70% overall bar.
- **A third, separate finding, not one of the two dispatched gaps but
  caught while running the required checks:** `npm run build` /
  `npx tsc --noEmit` were genuinely broken on `main` before this session's
  fix — `lib/entitlements/__tests__/dev-tools-guard.test.ts` (written
  during the earlier hardening fix, "unit tests already written and
  passing" per that fix's own description, but only ever run via
  `vitest`, never `tsc`) directly assigned/`delete`d `process.env.NODE_ENV`,
  which current `@types/node` types as a readonly property of
  `NodeJS.ProcessEnv` — `tsc` genuinely rejects this (TS2540/TS2704) even
  though it works at runtime under plain Node, and `next build`'s own
  type-check step runs `tsc` over every `.ts` file in the repo including
  test files, so this was a real, verified build break (confirmed via
  `git stash` against the untouched committed tree before writing anything
  new), not hypothetical. Fixed by switching to vitest's built-in
  `vi.stubEnv`/`vi.unstubAllEnvs()` (designed exactly for this, sidesteps
  the readonly-property issue entirely) — same test coverage, now
  type-clean. `npm run build`, `npx tsc --noEmit`, and `npm run lint`
  (0 errors; the only warnings are the repo's existing pre-existing-pattern
  `_prefixed`-unused-param warnings, unrelated to this slice) all
  confirmed clean after the fix, not just claimed.
- **retrospeq-qa reviewed it: PASS with one quick fix, applied and
  re-verified same session.** `app/(app)/accounts/page.tsx`'s `StatusChip`
  hardcoded the label `'Pending'` for any status it didn't specifically
  recognise — which now includes the real `'plan_limited'` value
  `lib/entitlements/downgrade.ts` writes on a downgrade. `'Pending'`
  reads as "still connecting," actively misleading for a downgraded
  account (the opposite of the "degrades honestly" claim `downgrade.ts`'s
  own doc comment made about this exact fallback). Fixed with
  `humanizeStatus()` — a readable fallback derived from the actual status
  string (`'plan_limited'` → `'Plan limited'`) instead of a reassuring
  guess — exported and unit-tested directly
  (`app/(app)/accounts/__tests__/humanize-status.test.ts`, 5 tests; this
  repo has no React-rendering test infra, so the pure string-
  transformation logic that was the actual bug gets direct coverage, not
  a full component render). Every other area QA checked — non-negotiables,
  story 4.1's honest "not enough data" framing for not-yet-checkable
  capabilities, story 4.2's dev-tool timing claims, `analytic_config`
  seeding nothing fake, ADR 0008 matching the live SQL — passed outright.
- **Module 01 stories 4.x is now genuinely done**: coded, security-reviewed
  (two rounds, both resolved), tested (both testing-bar gaps closed with
  real live-DB and unit-test evidence), QA-reviewed (one quick fix, applied),
  429 passing overall. Committed and pushed.

**Module 01 stories 5.x (rights/privacy) — coder pass complete, real
end-to-end functionality, not stubs. retrospeq-tester/security-reviewer/qa
passes still needed before this slice (and Module 01 as a whole) can be
marked done. Mandatory security review flagged explicitly** — this
slice touches credential destruction, RLS on two new tables plus a new
service-role-only table, and a real hard-delete account-erasure
capability.

- `supabase/migrations/20260821040000_audit_privacy.sql` — `audit_log`
  (Module 01 §3.3's literal shape: owner SELECT, service-role-only
  writes), `data_requests` (owner SELECT + owner INSERT, service-role-only
  status transitions — a genuine judgment call, `docs/adr/0009-data-requests-rls-shape.md`),
  and `erasure_tombstones` (new, not in the spec's own DDL — service-role-only
  for every command, no client policy at all; exists because
  `data_requests` itself cascades away with the account it was about, so
  a tombstone needs a table that doesn't — `docs/adr/0010-erasure-explicit-delete-order.md`
  reasons through this and the FK-safe-explicit-list-vs-cascade tension
  in full). Applied to and verified against the live shared dev Supabase
  project (RLS-enabled flags and exact policy predicates confirmed via
  `pg_policies`).
- **Real bug found and fixed, not hypothetical — `createServiceRoleClient()`
  (`lib/supabase/service.ts`) was broken for any REAL (non-mocked) call
  on this repo's pinned Node 20.11.0**, discovered while researching this
  slice (needed the factory for `auth.admin.getUserById`/`deleteUser`,
  this repo's actual first *tested* real call site of it). `@supabase/supabase-js`'s
  `SupabaseClient` constructor unconditionally builds a `RealtimeClient`,
  which unconditionally resolves a native `WebSocket` constructor —
  unavailable on Node <21 — so ANY real call to this factory (including
  `lib/auth/mfa-admin.ts`'s recovery-code redemption, shipped in an
  earlier slice) has been silently broken in this environment since it
  was introduced, masked only because every prior test/screenshot pass
  either mocked this module directly or never happened to exercise
  recovery-code redemption for real. Fixed with a harmless
  `realtime.transport` placeholder (verified directly: `.auth.admin.*`
  and `.storage.*` both work end-to-end against the live project with
  the fix; neither is ever used for realtime channels in this codebase).
  `lib/supabase/__tests__/service.test.ts` updated to assert the fix.
- **A second real bug, also found via the mandatory screenshot self-check,
  not a code read: `pg`'s default type parsers deserialize `timestamp`/
  `timestamptz` columns into JS `Date` objects, but every `Row` interface
  in this codebase (`TradingAccountRow`, `SubscriptionRow`,
  `DataRequestRow`, etc.) types those columns as `string`** — matching
  how PostgREST/`supabase-js` actually serialize them, the shape this
  codebase has always assumed. Silent and dormant until
  `app/(app)/privacy/page.tsx` tried to render `data_requests.expires_at`
  directly as JSX text, which crashed React ("Objects are not valid as a
  React child"). The identical latent risk exists in
  `app/(app)/accounts/page.tsx`'s `last_sync_at` rendering too — dormant
  only because no account has ever had a non-null `last_sync_at` yet
  (Module 02's sync worker doesn't exist). Fixed once, globally, not
  patched per call site: `lib/supabase/pg-type-parsers.ts` overrides the
  two relevant OIDs to return the raw ISO-8601 text Postgres already
  sends, imported for its side effect by `lib/supabase/direct.ts` and
  `lib/rate-limit/limiter.ts` (both `pg.Pool` owners) and by the live-DB
  test helpers. `lib/supabase/__tests__/pg-type-parsers.test.ts` proves
  it directly.
- `lib/privacy/` — `audit-repository.ts`, `data-requests-repository.ts`,
  `tombstone-repository.ts`, `profile-repository.ts` (story 5.4's
  telemetry toggle — a plain owner-scoped write against the existing
  `profiles` RLS, no new pattern), `export.ts` (the pure-ish
  bundle-assembly logic, deliberately separable from I/O so a future
  queue worker can call it unchanged once Module 02 makes this genuinely
  need to be async — §11's "<5 min p95" budget is trivially met at
  today's real data volume: profile + trading accounts minus credentials
  + subscription + MFA recovery-code metadata minus the codes themselves,
  **no `fills`/`trades` section exists because Module 02 doesn't exist —
  never fabricated**), `export-job.ts` (Storage upload/signed-URL/status-transition
  orchestration), `storage.ts` (Supabase Storage via the now-fixed
  `createServiceRoleClient()` — **the export bucket is created via code**,
  verified directly that a service-role key can create a Storage bucket
  through the REST API with no owner/dashboard action needed), `erasure.ts`
  (§4.6's full flow — request/grace/cancel/execute), `email-provider.ts`
  (the confirmation-email dependency, honestly unconfigured — see below),
  `dev-tools-guard.ts` (mirrors `lib/entitlements/dev-tools-guard.ts`'s
  two-condition shape, its own separate env var), `schemas.ts`.
- **Story 5.1 (export):** `requestExport` runs the whole job synchronously
  inside the Server Action today (explicitly noted in the code as needing
  to become async/queued once Module 02 adds real trade volume — no queue
  infra exists yet, per PROGRESS.md's own standing gap, so nothing was
  built that doesn't exist). Produces a real JSON file and a real CSV file,
  uploaded to a real Supabase Storage bucket, delivered via two real
  30-day signed URLs (stored as a JSON manifest in `data_requests.artifact_url`,
  since one text column has to hold two files' URLs — documented in the
  migration).
- **Stories 5.2/5.3 (erasure) — the highest-stakes code in this slice:**
  `requestErasure` (7-day grace, `EXPORT_IN_PROGRESS`-style duplicate
  guard), `cancelErasure` (only while still `pending`), `executeErasure`
  (destroys credentials FIRST, then an EXPLICIT FK-safe delete list —
  not cascade reliance, per `docs/adr/0010` — for `mfa_recovery_codes`/
  `trading_accounts`/`subscriptions`, unlinks telemetry pseudonyms
  (documented no-op — no pipeline exists), records a tombstone
  (`hash(email)`, timestamp, request id — new `erasure_tombstones` table),
  registers backup-replay deletion (documented no-op — no backup system
  exists for this free-tier project, 00-foundation §1.1), writes an
  `audit_log` entry that survives the account (`user_id` nulled, not
  cascaded), attempts a best-effort confirmation email (never blocks
  deletion on it), and finally deletes the `auth.users` row via the
  now-fixed `createServiceRoleClient()`). A dev/test-only immediate-execution
  path (`{ bypassGracePeriod: true }`) exists for testing, gated by its
  own two-condition guard (`lib/privacy/dev-tools-guard.ts`), same
  honesty posture as `setUserPlanForTesting`.
- **Honest scope boundaries, stated explicitly rather than silently
  omitted, per this slice's own dispatch:** grace-period "no sync, no
  analytics" restriction is not independently enforceable (Module 02/05
  don't exist) — only the request-exists/cancellable half is real.
  Telemetry opt-out has nothing to gate yet (no telemetry pipeline
  exists) — the toggle itself, persisted and immediately effective the
  moment any future telemetry code checks it, is the correct and
  complete scope. "Immutability does not survive erasure" has nothing to
  apply to (no frozen evaluations/fills exist yet) — noted in
  `docs/adr/0010`, not built for data that doesn't exist.
- **Confirmation email is honestly unconfigured, not faked.**
  `lib/privacy/email-provider.ts` throws `EmailProviderNotConfiguredError`
  unconditionally (same shape as `createKmsMasterKeyProvider`/
  `getBillingPortalUrl`) — this is a genuinely separate dependency from
  Supabase Auth's own (already-known-broken) mailer, per 00-foundation
  §10's own "Email provider" row. `executeErasure` calls it, catches the
  failure, logs it loudly, and proceeds with deletion regardless — a
  missing confirmation email is never a valid reason to retain a
  trader's data. Tracked in PROGRESS.md's "Infra gaps" below (not
  `NEEDS_YOUR_INPUT.md` — nothing is stalled by this; the erasure flow
  works correctly without it).
- `app/(app)/privacy/` — `page.tsx` (telemetry toggle, export status/download,
  delete-account request/pending/cancel states) + `actions.ts`. Linked from
  `app/(app)/layout.tsx`'s nav alongside Plan/Security. Design-system
  check: the default (no pending request) state has **zero** primary
  `.rq-btn`s — telemetry/export/delete are peer, independent controls,
  not one task flow, so none is elevated (README.md: "if a screen needs
  two primary actions, it's doing two jobs"); the one exception is
  "Cancel deletion," the sole primary `.rq-btn` and only while a deletion
  is actually pending — reassuring a trader out of an in-progress
  deletion is the opposite of the dark-pattern risk `.rq-btn--equal`
  exists to prevent, so elevating it there is deliberate, not an
  oversight.
- `lib/rate-limit/config.ts` — six new scopes (`telemetryToggle`,
  `requestExport`, `requestErasure`, `cancelErasureRequest`,
  `devExecuteErasure`), every write endpoint in this slice throttled per
  §7.2's blanket posture, `devExecuteErasure` tightest of all (the single
  most destructive real action in this slice).
- Tests: **99 new tests** across `lib/privacy/__tests__/` (unit, mocked —
  every repository, `erasure.ts`'s full branch set including the
  destructive-order proof via call-order tracking, `export-job.ts`,
  `storage.ts`, `email-provider.ts`, `dev-tools-guard.ts`, `schemas.ts`),
  `app/(app)/privacy/__tests__/actions.test.ts` (16 tests, mocked Server
  Actions), `lib/supabase/__tests__/audit-privacy.rls.test.ts` (19
  live-DB RLS tests — 100% coverage on all three new tables, cross-user
  isolation, the core "cannot self-write status=completed" property for
  `data_requests`), and **`lib/privacy/__tests__/erasure.live.test.ts`
  (4 live-DB tests against a real disposable GoTrue test user) — the
  highest-value test in this slice: proves credentials are destroyed,
  every owned row is gone, the tombstone survives with a one-way-hashed
  email, the `audit_log` entry survives with `user_id` nulled, and the
  real `auth.users` row is genuinely gone (confirmed via
  `auth.admin.getUserById` returning 404, not just a local table check)
  — full destructive lifecycle, real data, not a mock.**
- Screenshot self-check (`tmp/screenshot-privacy.mjs`, real dev server +
  real Supabase Auth test user): default privacy screen, telemetry
  opted-out, export-ready with real download links, erasure-pending with
  the grace-period date and the one primary "Cancel deletion" button, and
  erasure-canceled — all reviewed and matched the design system (amber
  accent only, no red/green, `.rq-well` sections matching the plan/security
  screens' established look). **Both real bugs above (the service-role
  WebSocket throw and the pg Date-object crash) were caught by this
  self-check, not a code read** — the flow silently redirected without
  actually completing until both were fixed, exactly the "wait, that's
  wrong" class of finding this convention exists to catch.
- `docs/adr/0009-data-requests-rls-shape.md`, `docs/adr/0010-erasure-explicit-delete-order.md`
  — both genuine judgment calls, reasoned through in full. `docs/runbook.md`'s
  new "Erasure execution stuck or failed" entry (the two failure
  severities, how to check, action for each) — "Any credential decryption
  failure" and "Broker/vendor connection outage during connect" already
  existed from an earlier slice, not duplicated.
- **retrospeq-security-reviewer: one blocking FAIL, fixed, re-reviewed
  PASS.** `executeErasure` originally did a non-atomic check-then-act
  status transition (read the row, check `status === 'pending'` in
  application code, then write `'processing'` unconditionally) — two
  concurrent calls for the same request could both pass the check
  before either write landed, both proceed through the destructive
  path, and the loser's `auth.admin.deleteUser` call would fail and
  throw a false "needs manual on-call follow-up" incident even though
  the erasure had fully succeeded. Fixed with
  `markDataRequestProcessing()` (`lib/privacy/data-requests-repository.ts`)
  — a single atomic `UPDATE ... WHERE status = 'pending'`, mirroring
  `cancelDataRequest`'s already-correct pattern — and `executeErasure`
  now aborts cleanly (before any destructive work) if it loses that
  race. Proven with a real concurrency test
  (`lib/privacy/__tests__/erasure.live.test.ts`: two genuinely
  concurrent `executeErasure` calls against the same live-DB row,
  `Promise.allSettled`, asserting exactly one wins) plus a mocked
  complement. Re-reviewed: PASS. Every other area (credential-first
  destruction order, tombstone anonymity, RLS self-write prevention on
  all three new tables, export's exclusion of secrets, rate limiting,
  the retroactive `createServiceRoleClient()`/mfa-admin fix) passed on
  the first review.
- **retrospeq-qa: two must-fix items, both applied and re-verified
  same session.** (1) The delete-account screen's copy claimed
  "Your credential is destroyed immediately when this is requested" —
  false; credentials are destroyed at EXECUTION (after the 7-day grace
  elapses, or via the dev bypass), not at request time, per §4.6's own
  flow and the shipped code. Fixed the copy in
  `app/(app)/privacy/page.tsx` to describe what actually happens. (2)
  Story 5.3 ("access, erasure, restriction, objection, portability all
  implemented as code paths") had two of five unmet: `data_requests
  .kind` included `'restriction'` in its schema but nothing ever
  created/read/canceled a row of that kind (an unwired enum value, not
  a code path), and `'objection'` had no representation anywhere. Fixed
  restriction with a new, genuinely wired `lib/privacy/restriction.ts`
  (`requestRestriction`/`getActiveRestriction`/`liftRestriction`, reusing
  the exact same `data_requests` machinery erasure/export already
  established — no new schema/RLS needed since RLS doesn't care about
  `kind`), a Privacy-screen section, two new Server Actions, two new
  rate-limit scopes, and 6 unit tests. Same honest-scope-boundary
  posture as everywhere else in this slice: restriction is a real,
  visible, cancellable request — what it would actually *suspend*
  (Module 02 sync, Module 05 analytics) doesn't exist yet to suspend.
  Objection: NOT built as a separate mechanism — logged as a deliberate
  decision (see decision log) that telemetry opt-out (story 5.4,
  already real) already IS the objection mechanism for the one
  legitimate-interest-based processing this product currently does
  (§13's own data policy: "legitimate interest for telemetry with
  opt-out") — building a second, parallel "object" flow with nothing
  distinct to object to would be inventing UI for a right with no
  current referent, not a more complete implementation.
- **Module 01 stories 5.x is now genuinely done — the last slice of
  Module 01.** Coded, security-reviewed (one FAIL, fixed, re-reviewed
  PASS), QA-reviewed (two must-fix items, fixed), tested throughout.
  Full repo suite: **554 passing** (after the restriction code path and
  the `pg-type-parsers.ts` ISO-8601 correction below), 9 skip-guard fallbacks (env present,
  nothing actually skipped). `npm run build`, `npx tsc --noEmit`, and
  `npm run lint` all clean.
- **Module 01 (Identity & Accounts) is now complete in full** — every
  story group (1.1-1.3 auth, 1.4-1.5 sessions/2FA, 2.x account
  connection, 3.x settings, 4.x entitlements, 5.x rights/privacy)
  coded, tested, security-reviewed, QA-reviewed, committed. Ready for
  the Phase 1 boundary process (§`/code-review` pass +
  `retrospeq-docs` dispatch) once Module 02 also lands, per AGENTS.md
  step 5 ("before marking a *phase* — not every slice — complete").

**Module 02 (Trade Ingestion & Model) — slice 1 of several: schema +
block derivation only, by deliberate dispatch scope (the grouping engine
is a separate, later slice on purpose, per Module 02's own "largest and
highest-risk module in v1" framing). Genuinely done as of this session:
coded, tested, security-reviewed (one FAIL round, fixed, re-reviewed
PASS), QA-reviewed (PASS). Committed and pushed.**

- `supabase/migrations/20260822010000_ingestion_schema.sql` — all 11
  tables from Module 02 §3.1 (`fills`, `blocks`, `trades`, `trade_fills`,
  `trade_events`, `arm_events`, `trade_captures`, `sync_runs`,
  `coverage_gaps`, `day_closeouts`, `position_snapshots`), §3.2's indexes
  verbatim, check constraints transcribing every enum-like text column's
  documented vocabulary. Applied to and verified against the live shared
  dev Supabase project (11/11 tables, RLS-enabled flags, exact policy
  predicates, and the delete-trigger's behaviour all confirmed via
  `information_schema`/`pg_policies` plus a live trigger-behaviour test —
  same verification method as every prior migration).
- **RLS is deliberately NOT the uniform "for all" default on every
  table** — `docs/adr/0011-ingestion-rls-shape.md` reasons through three
  shapes from each table's own DDL comment: append-only (`fills`,
  `trade_events` — owner SELECT+INSERT, no UPDATE/DELETE, per
  00-foundation §2.4's "frozen on write"), derived/never-user-editable
  (`blocks`, `trade_fills`, `sync_runs`, `coverage_gaps`, `day_closeouts`,
  `position_snapshots` — owner SELECT only), and genuinely user-driven
  (`trades`, `arm_events`, `trade_captures` — standard owner "for all,"
  since §4.7 names real client corrections: the `not_a_decision` toggle,
  manual split/join, deleting a manual trade before freeze). `trade_fills`
  gains a `user_id` column not in the spec's literal DDL — the one table
  missing one, needed to avoid a join-based RLS policy (00-foundation
  §3.1 names this as a specific anti-pattern). Two mechanical
  referential-integrity reconciliations also applied (not their own
  ADR — logged here): `blocks.account_id`/`position_snapshots.account_id`
  gained the same `references trading_accounts(id) on delete cascade`
  every other `account_id` column in this migration already has (the
  spec's own DDL block omits it inconsistently, with nothing in the
  module text explaining why), and `arm_events.account_id`'s FK gained an
  explicit `on delete cascade` (the spec gives it a bare `references`
  with no delete action, which would silently block account erasure once
  this table has rows).
- **`trades` gets a `BEFORE DELETE` trigger**
  (`forbid_broker_confirmed_trade_delete`) enforcing §4.7's "Delete a
  broker-confirmed trade: Never" / "Delete a manual trade: Before freeze
  only" — checked across both `trade_fills` AND `trade_events` for a
  non-`manual:`-prefixed backing fill, since a flip-opened trade
  (`docs/adr/0001`) has its entry-side fact in `trade_events` only. **A
  real gap found via this slice's own live-DB test, not hypothetical:**
  Postgres fires row triggers on CASCADE-originated deletes too, so this
  trigger would have silently blocked account erasure (`trading_accounts`
  → `trades` cascade) for any user with a broker-confirmed trade —
  directly contradicting 00-foundation §5.4 ("immutability is a product
  invariant, not a legal one... Erasure deletes; it does not tombstone").
  Fixed with a transaction-local escape hatch
  (`set_config('retrospeq.erasure_in_progress', 'true', true)`) the
  trigger checks first — documented in the trigger's own body and in ADR
  0011, as a required step for whichever future slice extends
  `lib/privacy/erasure.ts` to cover Module 02's tables. The "regrouping
  blocked after freeze" invariant (00-foundation §9.2) is explicitly
  **not** enforced by a trigger yet — flagged inline in the migration as
  deferred to the grouping-engine slice, which needs to exist first to
  know the real column set to lock.
- `lib/ingestion/server-day.ts` — the `server_day` computation, generalized
  from `fixtures/README.md`'s documented formula to handle BOTH real
  `day_rollover` literal shapes in this repo (`'HH:MM:SS UTC'`, every
  fixture; `'<IANA zone> HH:MM'`, `lib/broker/platform-defaults.ts`'s real
  connect-flow default). Proved algebraically equivalent to the fixture
  README's `date(filled_at − 22h) + 1 day` formula for any non-midnight
  rollover, with local-midnight rollovers (crypto's `00:00:00 UTC`)
  special-cased explicitly (the general `>=`/`+1` rule degenerates to
  "always +1" at exactly `R=0`, which is wrong and directly contradicted
  by the fixture's own crypto formula) — full derivation in the file's own
  header comment, not just asserted.
- `lib/ingestion/blocks.ts` — block derivation per Module 02 §4.2,
  verbatim algorithm, using `decimal.js` (new dependency, `10.6.0`, chosen
  over hand-rolled string arithmetic for correctness/readability — no
  real tradeoff worth its own ADR) throughout for the running-volume
  comparison to exact zero, never JS `number`. Handles the flip/no-flat-point
  case (a single fill crossing zero closes one block and opens another
  "at the same instant," §4.2) by splitting the crossing fill's
  contribution across two `FillBlockAssignment` entries — one closing,
  one opening — without ever creating a second physical fill row (this is
  purely block-boundary logic, deliberately distinct in scope from ADR
  0001's `trade_fills`/`trade_events` resolution, which the file's own
  header comment cross-references so the two don't get confused later).
  Defensive re-run/dedup-by-`id` built in (idempotency), since real
  callers will feed it output from `fills` re-fetches that may overlap.
- Tests: **`lib/ingestion/__tests__/golden-fixtures.test.ts`** replays
  literally all 8 golden fixtures (not a subset) — asserts every fixture's
  `fills[].server_day` and `blocks[]` (matched by instrument/opened_at/
  account, not array position, since real UUIDs aren't in the fixture
  files) match `expected.json` exactly: **17/17 passing**
  (`simple_daytrades`, `scaled_in_out`, `swing_with_intraday`,
  `flip_no_flat`, `partial_fills_subsecond`, `overnight_weekend`,
  `multi_currency`, `gapped_history` — 2 tests each + 1 harness-sanity
  test). `lib/ingestion/__tests__/server-day.test.ts` (12 tests, both
  `day_rollover` formats, boundary-second cases). `lib/ingestion/__tests__/blocks.property.test.ts`
  (`fast-check`, 200 runs each) — "no block spans a flat point except at
  its own boundaries," "deterministic for identical input" (including
  arrival-order independence), "re-running over an overlapping window
  changes nothing" (exact-duplicate and superset cases), a dedicated
  flip-fixture-shape unit test, and input-validation coverage. Combined:
  **`lib/ingestion/` at 100% line coverage on `blocks.ts`, 97.61% on
  `server-day.ts`** (well above 00-foundation §9.1's 90% engine bar) —
  the one uncovered branch is a defensive `Intl.DateTimeFormat`
  malformed-output guard, not reachable via any real input.
  `lib/supabase/__tests__/ingestion-schema.rls.test.ts` (originally 19
  live-DB tests: RLS-enabled + exact policy-shape audit across all 11
  tables, cross-user isolation on `fills`/`blocks`/`trades`, and the
  delete trigger's three real behaviours — reject a broker-originated
  trade (even for `service_role`), allow a manual trade before freeze,
  reject a manual trade after freeze). Full repo suite at coder-handoff:
  **611 passing**, 10 skip-guard fallbacks (env present, nothing actually
  skipped). `npm run build`, `npx tsc --noEmit`, and `npm run lint` all
  clean (lint: only the same pre-existing `_prefixed`-unused-param
  warning pattern already noted elsewhere).
- **retrospeq-security-reviewer: one blocking FAIL, fixed, re-reviewed
  PASS.** Three real findings, all fixed by the orchestrator directly
  (not re-dispatched to coder, per the same pattern used for smaller
  fixes elsewhere this session): (1) `signedVolume()` in
  `lib/ingestion/blocks.ts` guarded against negative/zero volume but not
  `NaN`/`Infinity` — `Decimal('NaN')` passes `isNegative()`, `isZero()`,
  and `isPositive()` all as false, so a malformed `numeric` value (which
  Postgres genuinely accepts — no CHECK constraint prevents it) would
  silently poison the running-volume total instead of failing loudly as
  the function's own error message promised. Fixed with an added
  `!magnitude.isFinite()` check; 6 new adversarial-input tests in the new
  `lib/ingestion/__tests__/blocks.test.ts` (NaN, Infinity, zero,
  negative, garbage text, and a large-but-finite non-regression case).
  (2) `fills`' client-INSERT policy (`fills_owner_insert`) checked
  `user_id = auth.uid()` but not that `provider_ref` actually carries the
  `manual:` prefix the delete-trigger's broker-vs-manual classification
  depends on — a client could self-insert a fill with an arbitrary
  `provider_ref`, colliding with a real broker deal id. Fixed by adding
  `and provider_ref like 'manual:%'` to the `WITH CHECK` clause, both in
  the migration file and applied live against the running database
  (verified via `pg_policies`). (3) 8 of the 11 tables
  (`trade_fills`/`trade_events`/`arm_events`/`trade_captures`/
  `sync_runs`/`coverage_gaps`/`day_closeouts`/`position_snapshots`) had
  zero actual cross-user-isolation test coverage — the original RLS test
  file only checked `pg_policies` metadata for those 8, never a real
  row-level access attempt. Fixed by seeding real rows for all 8 in
  `beforeAll` and adding 5 new `describe` blocks (~14 new test cases)
  proving user B genuinely cannot read/write user A's rows, and that
  direct client INSERTs are correctly rejected on the SELECT-only tables.
  Re-reviewed (a fresh, focused pass): **PASS** — the NaN/Infinity fix
  independently confirmed correct with non-tautological tests, three
  spot-checked isolation tests confirmed to use a genuine Postgres role
  switch (`SET LOCAL ROLE` + `request.jwt.claims`, not a mock), the
  `manual:%` policy confirmed live via `pg_policies` and confirmed
  compatible with Module 02 §4.8's manual-entry `provider_ref = 'manual:'
  || uuid` shape (would not false-block a legitimate future manual entry).
- **retrospeq-qa: PASS**, no blocking findings. Confirmed 11/11 RLS
  coverage with shapes matching each table's actual data semantics (not
  copy-pasted), the block-derivation algorithm's exact-decimal posture,
  and that deferring golden-fixture `trades[]` replay to the (not-yet-built)
  grouping-engine slice is a genuine pipeline-stage boundary per §4.2 vs
  §4.3, not a gap in this review's scope — `golden-fixtures.test.ts`
  already replays `fills[].server_day` and `blocks[]` across all 8
  fixtures today. One minor non-blocking note: this PROGRESS.md section's
  prose undercounted the RLS test file's test count after the
  security-fix round grew it — corrected in this update.
- **Module 02 Slice 1 is now genuinely done.** Full repo suite after all
  fixes: **630 passing**, 10 skip-guard fallbacks (env present, nothing
  actually skipped), `npm run build`/`npx tsc --noEmit`/`npm run lint`
  all clean.
- **Explicitly NOT built in this slice, by design per the dispatch:** the
  sync pipeline (§4.1), the grouping engine's confidence scoring/signals/
  resting-baseline split (§4.3 — this slice only derives block
  boundaries, the *upper bound* on a trade, not trades themselves), the
  trade-event/arm-matching/confirm-freeze transaction logic (§4.5/§4.6),
  manual entry's Server Action, and any UI (no rendered surface exists for
  this slice — screenshot self-check explicitly skipped, matching how
  Module 01's account-settings *backend* slice handled the same
  situation).
- No new `docs/runbook.md` entry: 00-foundation §7.3's alerting
  conditions (sync failure rate, credential decryption failure, missed
  scheduled job, analytic/shadow-analytic error rates) all require a
  running sync pipeline or analytics engine, neither of which exists yet
  in this repo — stated explicitly rather than inventing an entry ahead
  of the code that would trigger it, same posture as the account-settings
  slice's "no new runbook entry" note.
- **Flagged for the orchestrator: a `retrospeq-security-reviewer` pass is
  warranted here**, not skipped — this slice adds RLS to 11 new financial-data
  tables (AGENTS.md's own trigger list example), including a
  non-default RLS shape reasoned out per-table (ADR 0011) and a delete
  trigger with a security-relevant escape hatch
  (`retrospeq.erasure_in_progress`) that a future slice must remember to
  set correctly — exactly the kind of judgment call this repo's own
  security-review trigger list exists to catch a second pair of eyes on.

**Module 02 Slice 2 (grouping engine §4.3 + derived trade facts §4.4) —
genuinely done as of this session: coded by retrospeq-coder,
independently test-verified by retrospeq-tester, QA-reviewed PASS
(2026-08-21, no blockers). A dedicated security-reviewer pass was
judged not warranted for this slice by both retrospeq-tester and
retrospeq-qa independently (pure functions, zero DB/credential/RLS/
rule-eval surface — grepped for `supabase`/`createClient`/SQL/
`process.env`, zero matches) — deferred to the sync-pipeline/confirm-
transaction slice where a real write path and RLS will actually exist
to review. Committed and pushed.** `lib/ingestion/grouping.ts` (`groupBlock`, the weighted
signal table, the resting-baseline algorithm, confidence bands,
split-propensity score-application) and `lib/ingestion/trade-facts.ts`
(`computeTradeFacts`, §4.4's derived-fact formulas, the peak-not-initial
`risk_pct` convention). Pure functions, no DB access — same posture as
`blocks.ts`. Scope boundaries the coder documented and this pass
confirmed are genuine, deliberate, spec-consistent narrowings (not gaps):
`split_propensity`'s learning/persistence loop, real arm-event matching
(§4.5), and physical splitting on any non-baseline signal are all later
slices — a non-baseline signal that scores confident-split strength is
correctly surfaced as `ambiguous` (asks) rather than auto-applied,
because none of them has a spec-defined local cut point the way the
resting-baseline excursion does.

- **Independent test pass, not a re-read.** Read Module 02 §4.3/§4.4 and
  both source files in full against their own header doc comments (both
  files record every judgment call made reconciling the spec's prose into
  code — read before assuming anything is missing). Ran the existing
  suite directly rather than trusting the coder/orchestrator's reported
  numbers, and confirmed it was genuinely green: `lib/ingestion` — 8 test
  files, 94 tests, 0 failed.
- **One real infra issue hit and worked around, not silently ignored:**
  the default `npx vitest run` fails outright with `ENOSPC` on this
  machine — the `C:` drive is at 0 bytes free (matches the existing
  2026-08-19 decision-log note about npm cache being redirected off `C:`,
  but Vitest's own OS-temp usage wasn't covered by that redirect). Worked
  around per-invocation with `TEMP`/`TMP`/`TMPDIR` pointed at `E:/tmp_vitest`
  (cleaned up after). **Flagging this as a standing infra gap** (added
  below) rather than a one-off — any agent running `npm test`/`vitest`
  on this machine without the override risks a false "tests won't run"
  read.
- **Golden fixture replay verified to genuinely exercise `trades[]` for
  all 8 fixtures**, not blocks/fills leftovers from Slice 1 — spot-checked
  `flip_no_flat` (ADR 0001's flip case: `trade_short`'s `initial_stop`/
  `initial_risk_pct`/`risk_pct`/`r_multiple` all correctly `null`, the
  synthetic `trade_events` entry correctly asserted) and
  `swing_with_intraday` (5 real trades asserted from 1 block/10 fills,
  each intraday excursion's `grouping_confidence: confident_split` and
  `grouping_signals: {resting_baseline_excursion: 0.75}` checked against
  real computed values, not just array length).
- **Property tests assessed as testing real invariants with adequately
  varied generators**, not narrow/tautological: determinism (exact-repeat
  and arrival-order-shuffle, 200 runs each), the price-proximity-never-
  decides invariant (verified directly in `grouping.ts` — no scoring
  function reads `.price`; `GROUPING_SIGNAL_WEIGHTS.price_proximity` is
  hard-coded `0` and unreferenced by any scorer), and the resting-baseline
  split on a generated swing-plus-1-4-excursions shape (asserts exact
  trade count, fill-membership completeness, and per-excursion confidence/
  signals). The orchestrator's own fix — rewriting a stale test that
  wrongly asserted physical splitting on a non-baseline `confident_split`-
  strength signal, plus a companion propensity-suppression test — was
  reviewed here and confirmed correct against the documented scope
  boundary, not just re-trusted.
- **Found and fixed a real gap: `trade-facts.ts` had zero dedicated unit
  or property tests before this pass** — `computeTradeFacts` was only
  ever exercised indirectly through the 8 golden fixtures, every one of
  which is a closed trade with a real stop. That left several genuinely
  reachable branches of this exported pure function untested: the
  still-open-trade path (no exit-side member yet — `exitPriceAvg`/
  `holdSeconds`/`outcome` all `null` per §4.4), the `scratch` outcome
  band, the `contractValue` default, and the function's own input-
  contract guards (empty member list, first member not `role: 'entry'`,
  the internal VWAP zero-total-volume guard). Added
  `lib/ingestion/__tests__/trade-facts.test.ts` (8 unit tests covering
  all of the above) and `lib/ingestion/__tests__/trade-facts.property.test.ts`
  (4 property tests, 200 runs each, on the two Module 02 §7.2 invariants
  named for this file specifically — "sum of fill P&L equals trade
  `realized_pnl`" and "`risk_pct >= initial_risk_pct` always" — that were
  previously only spot-checked against fixed fixture values, never
  property-tested against generated input).
- **Coverage, verified directly (not re-quoted):** `grouping.ts` 98.61%
  line / 95.79% branch (unchanged by this pass — already clearing
  00-foundation §9.1's 90%-line bar comfortably). `trade-facts.ts` went
  from 91.76%/81.39% to **100%/100%** line/branch after the new tests.
  `grouping.ts`'s two remaining uncovered spots (`sign()`'s zero-volume
  throw; `assignRoles`'s empty-member-list throw) were read directly and
  judged genuinely unreachable via the public `groupBlock` API — internal
  invariant guards protecting conditions the block-derivation contract
  already rules out (a block never touches zero mid-span; `groupBlock`
  never calls `assignRoles` with an empty slice) — not worth chasing for
  coverage's own sake, noted rather than silently left unexplained.
- **Full repo suite after the new tests: 680 passing** (up from 668
  before this pass), 10 skip-guard fallbacks (env present, nothing
  actually skipped), 0 failed. `npm run build`, `npx tsc --noEmit`,
  `npm run lint` all clean (lint: 0 errors, 17 pre-existing warnings
  unrelated to this slice).
- **Not run: RLS / integration / E2E for this slice** — correctly out of
  scope, not a gap. Module 02 §7.2's other DB-level invariants
  ("regrouping after `confirmed_at` is impossible at the DB level",
  "every fill belongs to exactly one trade [unique index]") and all of
  §7.3's integration cases and §7.4's E2E flow need the `trades`/
  `trade_fills` write path and a rendered surface, neither of which
  exists yet — both remain for the sync-pipeline/confirm-transaction/UI
  slices. No screenshot self-check for the same reason (no UI surface in
  this slice).
- **Security-reviewer: not warranted for this slice specifically.** No
  DB access, no credentials, no rule-evaluation boundary, no vendor type
  — `grouping.ts`/`trade-facts.ts` are pure functions over already-
  materialised data (their own header comments say so explicitly). The
  one non-negotiable genuinely at stake here — price proximity banned
  from grouping — is directly, repeatedly property-tested (see above),
  not just asserted in a comment. Recommend the eventual security-reviewer
  pass land once the sync pipeline/confirm-transaction slice adds the
  real `trades`/`trade_fills` write path and RLS, matching how Slice 1's
  security review only made sense once real tables existed — reviewing
  pure grouping/facts math today would mean reviewing arithmetic, not
  security surface.

**Module 02 Slice 3 (sync pipeline §4.1 DB-writing orchestration) —
genuinely done: coded, tested, security-reviewed (PASS, mandatory per
this slice's own dispatch since it decrypts credentials and writes real
financial data via service-role), QA-reviewed (PASS). See the full
review writeup further below.** This is the first slice
in Module 02 where `trades`/`trade_fills`/`trade_events`/`blocks`/`fills`/
`sync_runs`/`coverage_gaps` rows actually get written for real, gluing
Slices 1-2's pure functions (`blocks.ts`/`grouping.ts`/`trade-facts.ts`)
into one DB-writing pipeline.

- `lib/ingestion/sync.ts` — `runSync(accountId, adapter, options)`. Total
  for every `trading_accounts.platform` (never throws for a manual
  account — returns `{ skipped: true, reason: 'manual_account' }`, since
  §4.8 manual entry has no credential and doesn't sync through this path
  at all). Runs entirely under `withServiceRoleConnection` (this is a
  trusted backend process, not a client request, per the dispatch), every
  query explicitly scoped to the one `accountId`/`userId` in play. Writes
  a real `sync_runs` row (`ok | partial | failed`, `fills_seen`,
  `fills_new`, `window_from/to`, `tier`, `trigger`, `error_code`) on every
  call, including failures (credential/adapter/KMS errors all map to a
  named `SyncErrorCode` rather than throwing past the caller).
- **Judgment calls made reconciling §4.1's prose into code (all
  documented in `sync.ts`'s own header comment, per this slice's
  dispatch instruction — flagged here for visibility, not repeated in
  full):**
  1. Overlap window default: 6 hours (`DEFAULT_OVERLAP_MS`), inside the
     dispatch's own suggested 1-24h range, overridable.
  2. `since` on an account's first-ever sync (no prior `sync_runs` row):
     `trading_accounts.connected_at` (falling back to `created_at`), no
     overlap subtraction (nothing to overlap against yet).
  3. Coverage-gap detection (step 5): any positive gap between
     `window_from` and the earliest returned fill is recorded — EXCEPT on
     an account's first-ever sync, which is deliberately EXEMPT. This
     exemption is a real correctness fix found while testing, not just a
     judgment call: without it, `window_from = connected_at` (routinely
     well before a brand-new account's first real trade) would make
     EVERY first sync of EVERY account falsely report a coverage gap the
     moment it found its first fill — a false positive on the common
     case, not the rare one.
  4. **Block/trade recompute scope (steps 6-9) — the single biggest scope
     decision in this slice.** An (account, instrument) span that already
     has ANY matching `blocks` row (matched by exact `opened_at` instant)
     is left COMPLETELY UNTOUCHED on resync — no write of any kind,
     confirmed or not. Only genuinely brand-new blocks (no existing row
     at all) are derived, grouped, and written. This trivially and
     unambiguously satisfies "never touch a confirmed trade" (nothing
     pre-existing is ever touched, full stop), at the real, deliberate
     cost of NOT implementing "append new fills to an already-open
     unconfirmed block across a resync boundary" in this slice — a
     genuine, known limitation, not silently dropped. Building that
     safely turned out to be a much larger feature than it first looked:
     `trades`' own delete trigger (ADR 0011) makes ANY trade backed by a
     real (non-`manual:`) fill permanently non-deletable regardless of
     `confirmed_at`, so "recompute" can never mean "delete and re-derive
     from scratch" for a real account the way the pure
     `groupBlock`/`deriveBlocks` functions do in isolation — a real,
     in-place, matching/updating regrouping algorithm is separate,
     larger future work. When a matched existing block's freshly
     recomputed fill membership includes fills not yet reflected in its
     stored trade(s), that's detected and surfaced in the result's
     `anomalies` array (+ `console.warn`) as `FILL_LATE_ARRIVAL`
     (confirmed block — §9's own named error code) or
     `BLOCK_EXTENSION_DEFERRED` (unconfirmed, just out of scope) — never
     a silent rewrite either way.
- **A real, load-bearing schema gap found and fixed, not invented:**
  `trading_accounts` had no equity/balance column at all, and
  `BrokerAdapter` has no method that returns one — but §4.4's
  `risk_pct`/`initial_risk_pct`/`r_multiple` formulas all divide by
  account equity. `supabase/migrations/20260822020000_trading_accounts_starting_equity.sql`
  adds `starting_equity numeric(20,8)`, nullable, no default (applied to
  and verified against the live project). `trade-facts.ts`'s
  `TradeFactsAccountContext.startingEquity` widened from `string` to
  `string | null` — when null (every real synced account today, since
  nothing populates it yet), `computeTradeFacts` treats it exactly like
  the existing "stop unknown" case: risk/R fields all `null`, "not
  applicable," never a fabricated value. Full reasoning, alternatives
  considered, and consequences in
  `docs/adr/0013-trading-accounts-starting-equity-nullable.md`.
- **The tracked infra-gap fix, done as instructed:**
  `lib/broker/accounts-repository.ts`'s `deleteAllTradingAccountsForUser`
  now calls `select set_config('retrospeq.erasure_in_progress', 'true', true)`
  as the first statement inside its `withServiceRoleConnection` callback,
  before the `delete from trading_accounts` — same transaction, so
  `forbid_broker_confirmed_trade_delete` (ADR 0011) stands down for this
  one erasure-execution transaction only. **Proven two ways, not just
  claimed:** (1) a new live-DB test in `lib/privacy/__tests__/erasure.live.test.ts`
  seeds a real broker-confirmed trade (block + non-manual fill + trade
  with `confirmed_at` set) and asserts `executeErasure` genuinely
  succeeds and removes it; (2) the fix was TEMPORARILY reverted in a
  scratch check (never committed) and the same test was confirmed to
  fail with exactly the predicted error (`"trades: cannot delete trade
  ... after freeze"`) before being restored — the "would have failed
  before" claim is verified, not assumed.
- **Golden-fixture parity proof (00-foundation §9.3's mandatory fixture
  replay, applied to the DB-writing orchestration specifically), against
  the live DB:** `lib/ingestion/__tests__/sync.live.test.ts` drives
  `runSync` end-to-end through a `createFixtureBrokerAdapter`-wrapped
  fixture (`simple_daytrades`, `scaled_in_out`, `flip_no_flat` — 3 of the
  mandatory 2-3, including the ADR-0001 flip/`trade_events` case) and
  asserts the REAL Postgres `trades` rows it produces match each
  fixture's `expected.json` exactly (matched by fill-membership
  signature, same convention `golden-fixtures.test.ts` already
  established), including risk/R fields (fixtures always supply a real
  `starting_equity`, so this also proves ADR 0013's non-null path). Also
  proves re-running the identical sync is a true no-op (dedup,
  00-foundation §6.4).
- **The "never touch a confirmed trade" invariant — proven live, not
  just unit-tested:** seeds a real confirmed block/trade/fill pair
  directly, then syncs a genuinely late-arriving fill landing inside that
  confirmed span. Proves the fill IS captured in `fills` (append-only,
  unconditional) but the block/trade rows are byte-for-byte unchanged, no
  new `trade_fills`/`trade_events` row references the late fill, and the
  anomaly is surfaced (`FILL_LATE_ARRIVAL`) rather than silently dropped.
- Also live-tested: coverage-gap detection on a genuine steady-state
  (non-first) sync writes a real `coverage_gaps` row and `status =
  'partial'`; cross-account isolation during a two-account, two-user sync
  scenario (no fill/trade ever crosses accounts).
- Tests: 26 unit tests (`lib/ingestion/__tests__/sync.test.ts` — pure
  helpers: window/gap/scrub/error-classification/tier-normalization logic,
  plus mocked-DB control-flow tests for the manual short-circuit,
  account-not-found, no-credential, and adapter-error-mapping paths — a
  deliberate scoping decision, documented in that file's own header, NOT
  to hand-roll an in-memory Postgres stand-in for the write phase, since
  that risks diverging from real Postgres exactly where correctness
  matters most; the write phase is proven live instead), 7 live-DB tests
  in `sync.live.test.ts` (6 passing + 1 inert skip-guard, env present),
  plus 2 new unit tests in `trade-facts.test.ts` for the null-equity
  branch ADR 0013 added. `lib/supabase/__tests__/service-role-inventory.test.ts`'s
  allowlist updated for the one new `withServiceRoleConnection(` call
  site. Full repo suite: **715 passing**, 11 skip-guard fallbacks (env
  present, nothing actually skipped). Coverage: `sync.ts` 100% line /
  92.1% branch (comfortably above the 90%-line engine bar); repo-wide
  99.19% lines / 94.4% branch. `npm run build`, `npx tsc --noEmit`, and
  `npm run lint` all clean (lint: 0 errors, the same 17 pre-existing
  `_prefixed`-unused-param warnings already noted elsewhere, none new).

**retrospeq-tester independent pass, 2026-08-22 — Slice 3 (`sync.ts`
§4.1). Re-ran everything from scratch, did not trust the coder's
reported numbers.** Confirmed the coder's own report exactly: 715
passing / 11 skip-guard fallbacks / 0 failed before I touched anything,
`sync.ts` 100% line / 92.1% branch, `npm run build` / `npm run lint` /
`npx tsc --noEmit` all clean. Then found and closed a real coverage gap,
and formed an independent judgment on judgment call #4:

- **The one meaningfully untested branch, found by reading the
  uncovered-branch HTML report, not just the percentage:** of `sync.ts`'s
  six uncovered branches at 92.1%, five were genuinely defensive
  (invariant-violation throws that should never fire, a `?? {}` fallback
  on a field the `Fill` type never actually omits, an unreachable ternary
  arm in a single-element reduce). The sixth was **not** defensive: `code
  = isConfirmed ? 'FILL_LATE_ARRIVAL' : 'BLOCK_EXTENSION_DEFERRED'`'s
  false branch — i.e. the entire `BLOCK_EXTENSION_DEFERRED` code path,
  judgment call #4's own centerpiece — had **zero test coverage**. The
  existing live-DB test proved the CONFIRMED case (`FILL_LATE_ARRIVAL`)
  byte-for-byte; nothing proved the unconfirmed case actually detects and
  reports correctly rather than, say, silently returning without
  populating `anomalies` at all. Added three new live-DB tests to
  `sync.live.test.ts` closing this: (1) a still-open unconfirmed block
  gains an "add" fill on a second sync — asserts `BLOCK_EXTENSION_DEFERRED`
  fires, block/trade byte-for-byte unchanged, `status: 'partial'`; (2) the
  **sharper** case — a position that genuinely FLATTENS via its exit fill
  arriving on a later sync stays permanently `status: 'open'`,
  `closed_at: null`, `exit_price_avg: null` in `trades`, because a matched
  block is matched by `opened_at` alone, regardless of whether the new
  fill would have closed it. This is the load-bearing practical
  consequence of judgment call #4 and it was previously asserted only in
  prose, never in a test. `sync.ts` branch coverage: **92.1% → 95.72%**
  (100% line unchanged). Also added a live test for the
  `connected_at`-null → `created_at`-fallback branch (judgment call #2's
  own documented fallback, likewise previously untested) and a live test
  for mixed-batch dedup (one already-known fill + one genuinely new fill
  for a different instrument in the same sync call, plus a third identical
  re-sync proving full no-op) — the existing dedup proof was only ever
  "re-run the exact same fully-duplicate batch," never a batch mixing old
  and new. **Full suite after additions: 719 passing, 11 skipped, 0
  failed** (up from 715 — 4 new tests, all live-DB). `sync.ts` coverage:
  100% line / 95.72% branch / 88.88% funcs (the two uncovered functions
  are the never-exercised real-KMS `wrapDataKey`/`unwrapDataKey` lazy
  wrappers — expected, matches the standing no-KMS infra gap, not a test
  gap). Repo-wide: 99.19% lines / 94.91% branch.
- **Independent judgment on judgment call #4 (asked to form my own, not
  just accept the coder's framing): accept the SCOPE as written — deferring
  the code that never touches an existing block is the right v0 call,
  it never silently drops or corrupts data, and it's now actually tested,
  not just documented — but do not accept the CONSEQUENCE as adequately
  flagged.** The header comment frames this primarily around "gains new
  fills... does NOT get its trade updated" — technically correct but
  undersells the sharpest case: a trade that is really, actually closed
  (flat) will sit as `status: 'open'` in the database **forever**, with no
  mechanism in this repo today that will ever revisit it, because a
  matched block is matched by `opened_at` alone and is never re-examined
  once it exists — not on the next sync, not on the hundredth. This
  matters concretely for Module 02 §4.6 (confirm/freeze, not yet built,
  Slice 6): the auto-confirm-after-7-days rule only fires for trades with
  `closed_at` set, so a trade stuck `open` this way will never
  auto-confirm and will never appear correctly on a close-out screen
  either — it's not merely "missing some stats," it's a trade that never
  resolves through the normal lifecycle at all unless something new
  (in-place block-extension, or an explicit manual split/join touching it)
  is built before real users hit this. **Flagging as a concrete
  requirement for whoever scopes Slice 4/6, not just a "known
  limitation" to note in passing:** either (a) implement in-place block
  extension before Slice 6 ships, or (b) have the confirm/freeze
  transaction and the close-out UI explicitly detect and surface trades
  with a live `BLOCK_EXTENSION_DEFERRED` anomaly (similar to how a
  coverage gap already blocks close-out) rather than letting them sit
  invisibly stuck. This is now a live-DB-tested, reproducible fact about
  the current code (see the "sharpest practical edge" test above), not a
  theoretical concern.
- **Security-relevant scan (for the mandatory security-reviewer pass that
  follows this one, not a substitute for it):** traced `credentialInput`/
  `plaintext` through `buildCredentialInput` and `runSync`'s `try` block —
  the decrypted secret is consumed exactly once by `adapter.connect()`
  and never appears in a `console.*` call, a DB write, or the returned
  `RunSyncResult`/`RunSyncSkippedResult` shape anywhere in this file.
  `classifySyncError`'s `catch` block logs/persists only the mapped
  `SyncErrorCode` enum, never the raw `err` (no vendor message ever
  reaches `sync_runs.error_code` or a log line). `AccountHandle` (the
  object that does cross the `adapter.connect()` boundary back into this
  file) is typed with only `adapterId`/`providerAccountRef`/
  `verifiedReadonly` — no credential-shaped field exists for a leak to
  hide in. No new finding beyond what the coder's own header already
  documents; this is a second, independent look at the same surface.
- No RLS work needed from this pass — Slice 3 wrote to tables (`fills`,
  `blocks`, `trades`, `trade_fills`, `trade_events`, `sync_runs`,
  `coverage_gaps`) whose RLS was already established and verified in
  Slices 1-2 (`lib/supabase/__tests__/ingestion-schema.rls.test.ts`,
  already in the 74-file suite this pass re-ran); this slice added no new
  table.
- `docs/runbook.md`: updated the existing "Any credential decryption
  failure" and "Every credentialed connect attempt fails because KMS
  isn't configured" entries to reflect that the sync worker is now real
  (both were written "ahead of the worker existing" and were stale the
  moment this slice landed); added a new "Sync failure rate > 5% over 15
  min" entry (00-foundation §7.3) documenting the real, reachable
  `sync_runs.status = 'failed'`/`error_code` signal and today's expected
  100%-KMS-gap baseline for credentialed accounts.
- `docs/adr/0013-trading-accounts-starting-equity-nullable.md` — the one
  new ADR this slice needed (a genuine missing-dependency gap between
  Module 01's schema and Module 02's formulas, not a 00-foundation
  convention deviation, but still "the decision most likely to be
  revisited by someone who does not know why it was made," per Module 02
  §14's own documentation posture).
- **Explicitly deferred, per this slice's own dispatch, not silently
  dropped:** step 8 arm-event matching (§4.5) — a named, commented hook
  point exists in `sync.ts`, no matching logic implemented; step 10
  emitting events to Module 04/Module 07 — neither module exists yet,
  and per §4.6 the real evaluation-freeze event belongs to the
  confirm/freeze transaction anyway, not sync time; the actual
  cron/API-route/UI trigger surface that decides which `trigger` value to
  pass and calls `runSync` — this slice only makes `runSync` correctly
  accept and record whichever of `'scheduled' | 'on_demand' | 'connect'`
  a caller passes.
- **Not built in this slice, flagged as a genuine, known limitation (see
  judgment call #4 above):** in-place recompute of an already-open,
  unconfirmed block that gains new fills across a resync boundary (a
  still-building scaled position, synced twice while still open) — a
  candidate for a dedicated follow-up slice once needed, not a forgotten
  requirement.
- **retrospeq-security-reviewer: PASS, no findings, 2026-08-21.** All six
  items from the dispatch verified directly against code, not trusted
  from doc comments: (1) credential handling — `plaintext` never leaves
  `buildCredentialInput`'s stack beyond `adapter.connect()`, no
  console/log/error/`sync_runs.error_code` path ever carries it,
  `scrubRawPayload` applied unconditionally on the one fills-insert path
  with a substring-match fragment list that also catches compound keys
  like `access_token`; (2) every service-role query in `sync.ts`
  explicitly scopes to `account_id`/`user_id` — no unscoped query found;
  (3) the erasure escape hatch's `set_config(..., true)` is genuinely
  transaction-local (Postgres guarantee, reverts on commit or rollback,
  cannot leak to a later operation on a reused pooled connection); (4)
  every query is parameterized, no string-interpolated SQL from
  fill-derived/adapter-influenced data anywhere; (5) decrypt/KMS failures
  are caught before any table write, no partial-success `sync_runs` row
  possible; (6) confirmed by repo-wide grep — nothing outside this
  pipeline and its own tests reads `trades` today, so the
  `BLOCK_EXTENSION_DEFERRED` stuck-open-trade gap (next paragraph) is a
  real functional gap but not currently an exploitable or misleading one.
- **retrospeq-qa: PASS, with one process fix applied.** Confirmed the
  null-propagation composition between ADR 0012 (percentage-number
  convention) and ADR 0013 (nullable `starting_equity`) is correct —
  `trade-facts.ts` short-circuits to `null` risk fields before the ×100
  step, never `NaN` or a fabricated zero. Confirmed "never touch a
  confirmed trade" is genuinely enforced by construction (the skip in
  `recomputeInstrument` is unconditional on any existing block match, not
  conditioned on `confirmed_at`) and proven by a real, non-tautological
  live-DB test. Confirmed no rate-limiting gap (no Server Action/API
  route calls `runSync` yet in this slice — nothing to throttle). One
  process fix: this PROGRESS.md section hadn't yet recorded the
  security-reviewer PASS above at the time QA reviewed — now corrected.

**Module 02 Slice 3 is now genuinely done** — coded, independently
tested (tester found and closed a real coverage gap on the
`BLOCK_EXTENSION_DEFERRED` path), security-reviewed (PASS), QA-reviewed
(PASS). 719 tests passing, 11 skipped, 0 failed. `sync.ts` 100% line /
95.72% branch. Clean build/lint/tsc.

**Module 02 Slice 4 (arm-event matching §4.5 + the pre-entry capture
lock) — genuinely done as of this session: coded, tested, security-
reviewed (one blocking FAIL, fixed with a real DB-level trigger,
re-reviewed PASS), QA-reviewed (PASS). See the closeout paragraph after
the tester section below for the full FAIL→fix→PASS story.**

- `lib/ingestion/arm-matching.ts` — the pure `match(arm, fills)` decision
  from §4.5's pseudocode (`matchArmEvent`), no DB access, same posture as
  `grouping.ts`/`trade-facts.ts`. Five judgment calls reconciling §4.5's
  prose into code, all documented in the file's own header (full detail
  there): (1) "candidates" is read as candidate ENTRY FILLS, literally
  per the pseudocode's own `role = 'entry'` clause, but since an entry
  fill maps 1:1 to its trade, this is equivalent to "candidate trades
  identified by their entry fill" — both readings reconciled, not
  competing; (2) the spec names outcomes for 0-candidates-window-expired
  (`never_filled`), 1 (`matched`), and >1 (`ambiguous`) but says nothing
  about 0-candidates-window-still-open — read as "no state change, stays
  `pending`" per 00-foundation §6.2's silence principle, matching
  `arm_events.match_state`'s own DDL default; (3) the window boundary
  ("between armed_at and armed_at + WINDOW") is a closed interval on both
  ends; (4) side/direction matching reuses `trade-facts.ts`'s exact
  buy→long/sell→short mapping, one canonical definition, not a second
  parallel one; (5) `WINDOW` default 30 min, overridable.
- `lib/ingestion/trade-captures.ts` — `writeTradeCapture`/
  `lockPreEntryCaptures`, the pre-entry lock (§4.5's second paragraph,
  §4.7's "Edit pre-entry captures: Never after lock"). Real design
  finding recorded in the file's own header: `trade_captures`' primary
  key is `(trade_id, field_id)` only — NOT `(trade_id, field_id, moment)`
  — so there is exactly one row per field per trade ever, which makes
  "never after lock" enforceable as a flat reject-on-conflict rather than
  a versioned append: once a `(trade_id, field_id)` row exists with
  `moment = 'pre_entry'`, every later write attempt for that same pair is
  rejected outright (`{ applied: false, reason: 'pre_entry_locked' }`),
  never silently overwritten. This is also the one general write path any
  FUTURE `trade_captures` writer (Module 03/06's capture UI) should route
  through — nothing else writes to this table yet in this repo, so there
  was nothing to retrofit.
- `lib/ingestion/sync.ts` — real Step 8 wiring
  (`matchPendingArmEvents`), replacing the prior slice's documented
  no-op hook. **Judgment call, also documented in the file's own header:**
  rather than tracking "new entry fills written this run" as a narrower
  set, this re-evaluates EVERY `pending` `arm_events` row for the account
  against its own instrument's full current entry-fill history, every
  sync — deliberately conflating §4.1 step 8 with the `never_filled`
  sweep the dispatch left open-ended ("a sync-triggered sweep is
  reasonable for this slice's scope") into one pass. Cheap (bounded by
  the account's own pending-arm count via the existing `arm_pending`
  partial index), idempotent, and correct for both goals. `RunSyncResult`
  gained three new fields (`armEventsMatched`/`armEventsAmbiguous`/
  `armEventsNeverFilled`) — additive, no existing test broke.
- **Real, unrelated pre-existing build break found and fixed while
  running the mandatory `npm run build` check**, not caused by this
  slice: `lib/ingestion/__tests__/sync.live.test.ts`'s `exitFill` object
  (written in Slice 3) had `close_reason: 'manual'` widen to plain
  `string` (no `as const`), which `tsc` rejects against `Fill`'s
  `CloseReason | null` type when passed through `fills: Fill[]`. Verified
  via `git stash` that this was already broken on `main` before this
  session touched anything (Slice 3's own commit apparently only ran
  `vitest`, never `npm run build`, so `next build`'s own type-check step
  — which walks every `.ts` file including tests — never caught it).
  One-line fix (`'manual' as const`).
- Tests: 26 unit tests (`arm-matching.test.ts`) + 3 property tests
  (`arm-matching.property.test.ts`, `fast-check`, 200 runs each — the
  dispatch's own required invariant, "the outcome only ever depends on
  candidates within the window, never on later fills," plus determinism
  and a full state-vs-qualifying-candidate-count check) covering 0/1/many
  candidates, both window boundary edges, the buy/sell↔long/short
  mapping, and the pending-vs-never_filled distinction. Plus 5 new live-DB
  tests (`arm-matching.live.test.ts`, against the real shared dev/test
  Supabase project): matched (arm_events → matched, matched_trade_id set,
  `trade_captures` pre_entry rows written), ambiguous (two qualifying
  trades → `match_candidates` populated, matched_trade_id stays null, **no**
  `trade_captures` written for either trade), never_filled (window expired,
  zero candidates, row retained not discarded), still-pending (window open,
  zero candidates, no write), and the pre-entry-lock immutability
  invariant itself (a second write attempt to a locked field is rejected
  byte-for-byte, a *different*, never-locked field writes and edits
  normally). One real bug caught by the live suite itself, not by code
  review: `arm_events.matched_trade_id` has no `ON DELETE` clause (Module
  02 §3.1's own literal DDL), so the live test's cleanup helper had to
  delete `arm_events` rows before deleting `trades`, and the cleanup was
  hardened with a `try/catch` + explicit `ROLLBACK` so one test's cleanup
  failure can't poison the shared connection's transaction state for every
  subsequent test in the file (this actually happened once during
  development, confirmed the fix, not hypothetical).
  Full suite: **753 passing**, 12 skipped (all live-DB skip-guard
  placeholders — env is present, every real live-DB test in the repo
  actually ran). `arm-matching.ts` 100% lines / 96.15% branch,
  `trade-captures.ts` 100% lines / 100% branch, `sync.ts` 100% lines /
  95.23% branch — all comfortably above the 90%-line engine bar. Repo-wide:
  99.22% lines / 94.94% branch. `npm run build`, `npx tsc --noEmit`, and
  `npm run lint` all clean (lint: only the same pre-existing
  `_prefixed`-unused-param warning pattern already noted elsewhere).
- **No new tables, no new RLS shape** — `arm_events`/`trade_captures`
  already exist with standard owner "for all" RLS from Slice 1's
  migration; this slice only writes to them via the existing
  `withServiceRoleConnection` (RLS-bypassing, already-reviewed) path
  `sync.ts` already established in Slice 3. Every new SQL statement in
  `matchPendingArmEvents`/`writeTradeCapture` is parameterised — no
  string interpolation, no dynamic SQL construction. **This orchestrator's
  own read: a dedicated retrospeq-security-reviewer pass is probably NOT
  strictly required for this slice** (no new credential/RLS/injection
  surface per AGENTS.md's trigger list), but flagged for the security
  reviewer/qa's own call to make, not skipped unilaterally — matching
  this repo's established precedent for lower-risk slices (e.g. Module 01
  stories 3.x/4.x's own "flagged, not decided here" pattern).
- No new `docs/runbook.md` entry: no new alerting condition was
  introduced (00-foundation §7.3 / Module 02 §9) — `arm_events`
  transitioning to `ambiguous`/`never_filled` are expected, named product
  states ("Not an error — a question," matching `GROUPING_AMBIGUOUS`'s
  own existing treatment in §9's error table), not failures. No ADR
  written either — every judgment call above is a prose-to-code
  translation of genuinely ambiguous spec wording, not a deviation FROM a
  stated 00-foundation convention, matching `grouping.ts`'s own
  established "recorded in the file header + this decision log, no
  dedicated ADR" precedent.
- **Explicitly out of scope, not built** (per the dispatch): the "arm a
  setup" creation flow/UI (Module 03/08 territory — every `arm_events`
  row in this slice's own live tests is seeded directly via SQL, since no
  Server Action creates one yet), the ambiguous-arm resolution UI ("ask
  at close-out"), and anything about `strategy_id`/`strategy_version`/
  `trigger_state` beyond passing them through untouched.

- **retrospeq-tester: independent pass complete, 2026-08-22.** Not a
  re-read — re-derived each finding against §4.5's text and the code
  directly.
  - Judgment call #1 ("candidates" = candidate entry fills = candidate
    trades, 1:1) verified correct, not just plausible: forced by the
    spec's own `trade_fills_fill_unique` invariant (one entry fill per
    trade, one trade per fill), so the two readings are provably the same
    set, not a convenient reconciliation.
  - Judgment call #2 (0 candidates, window open → stays `pending`, no
    write) verified NOT to create a silently-skipped match: `sync.ts`'s
    `matchPendingArmEvents` re-queries every `pending` `arm_events` row
    against the account's FULL current entry-fill history on *every*
    sync (not just fills new to that run), so a qualifying fill arriving
    on any later sync is always found. Confirmed by tracing the code and
    by the "still-pending" live test.
  - Window boundary: both edges (`armed_at` exactly, `armed_at + WINDOW`
    exactly) are unit-tested, plus 1ms-inside/1ms-outside on both sides —
    genuinely exercises the edges, not just interior/exterior points.
  - Traced `sync.ts` Step 8 confirms it does both jobs (new-fill matching
    and the stale-pending sweep) in one pass, as documented — verified,
    not just trusted.
  - Pre-entry lock test (`arm-matching.live.test.ts`) is a real
    adversarial test: seeds a locked field, issues a genuine second
    `writeTradeCapture` call with a different value/moment, asserts
    `{ applied: false }` and the row byte-for-byte unchanged, then proves
    a *different*, unlocked field still writes/edits normally (so the
    test isn't accidentally proving "writes never work").
  - `match_candidates` on `ambiguous` is populated with real usable data
    (`{ tradeIds: [...], fillIds: [...] }`), not a bare boolean — proven
    by the live "two qualifying entry fills" test reading it back.
  - **Gap found and closed:** the ADR-0001 union branch in
    `matchPendingArmEvents` (candidate entry fills sourced from
    `trade_events.kind = 'entry'` for a flip-opened trade, not
    `trade_fills`) had zero test coverage — every existing test's
    candidate set came from the `trade_fills` half of the `UNION ALL`
    only. Added a new live test
    (`arm-matching.live.test.ts`, "ADR-0001 flip-opened trade") that
    reproduces `fixtures/golden/flip_no_flat`'s exact fill shape, arms a
    `short` setup that can only match via the flip-opened trade's
    `trade_events` entry, and asserts both the match AND that the
    matched trade's entry really is a `trade_events` row (0 `trade_fills`
    entry rows, 1 `trade_events` entry row) — otherwise the test wouldn't
    actually prove the union branch works. Passes.
  - **Real DB-level gap found, empirically proven (not just read off the
    migration comment) — resolved same session, see the closeout
    paragraph below, not left open:** `trade_captures`' "never after lock" invariant (§4.5's
    second paragraph, §4.7) is enforced ONLY inside
    `writeTradeCapture` — there is no DB trigger/CHECK backing it.
    `trade_captures` carries the standard owner "for all" RLS policy
    (`using/with check (user_id = auth.uid())`), so any client holding a
    valid session for the trade's own owner can `UPDATE` an
    already-locked `moment = 'pre_entry'` row directly via PostgREST/a
    browser Supabase client, bypassing `writeTradeCapture` entirely. The
    Slice-1 migration comment already flagged this ("the 'never after
    lock' rule ... is NOT enforced here ... deferred to that slice, same
    posture as the grouping-freeze trigger note on `trades`") and named
    THIS slice (§4.5's arm-matching mechanism) as where it'd be
    addressed — it wasn't, at the DB level. Added a new live test
    (`arm-matching.live.test.ts`, "DB-level gap check") that issues a
    direct `authenticated`-role `UPDATE` against an already-locked row
    (via the repo's existing `asRole` RLS-test harness) and confirms it
    is NOT rejected (`rowsAffected === 1`) — proving the gap empirically
    rather than asserting it from the migration's own comment. No
    exploitable path exists TODAY (no client-facing Server Action/UI
    writes `trade_captures` yet — Module 03/06 territory), so this is not
    a blocking finding for Slice 4 itself, but it is a real, now-provable
    gap that whoever builds the capture UI must either route exclusively
    through `writeTradeCapture` or close with a DB-level trigger
    (mirroring the `trades_forbid_broker_confirmed_delete` pattern
    already established in this schema) before that UI ships a genuine
    client write path. Flagging for security-reviewer/qa's own call
    rather than deciding unilaterally that it's fine to leave.
  - Confirmed the repo-wide FK-ownership gap already logged above (2026-
    08-22 entry, "several RLS INSERT/'for all' policies check `user_id =
    auth.uid()` but not that referenced foreign keys ... actually belong
    to that same user") concretely applies to `arm_events.account_id` and
    `trade_captures.trade_id` too (both "for all" policies check only
    `user_id`), not just the `fills`/`trade_events` tables the original
    entry named — same repo-wide gap, wider blast radius than previously
    written down, no new entry needed since the existing one already
    covers "repo-wide."
  - RLS: automated, table-list-driven (`ALL_TABLES` in
    `ingestion-schema.rls.test.ts`), covers all 11 Module 02 tables
    including `arm_events`/`trade_captures` — established in Slice 1,
    still passing, not sampled.
  - Golden fixtures: this slice does not touch the grouping engine
    (`grouping.ts`/`blocks.ts` unmodified — confirmed via `git diff`), so
    a replay is not the §9.3 bar's trigger here; the fixture-parity live
    tests in `sync.live.test.ts` (Slice 3's, unaffected by this slice)
    still pass regardless.
  - No dedicated E2E for §7.4's "Arm → fill → in-trade → trim with
    reason → close → close-out → confirm" flow — correctly out of reach
    for this slice: trim-reason capture, close-out, and the confirm/
    freeze transaction don't exist in this repo yet (Slices 5-7). No UI
    shipped in this slice either, so no screenshot pass applies.
  - Full suite after my two added tests: **755 passing, 12 skipped, 0
    failed** (up from 753/12/0 — my 2 additions, no regressions).
    Coverage unchanged from the coder's report: `arm-matching.ts` 100%
    lines / 96.15% branch, `trade-captures.ts` 100%/100%, `sync.ts` 100%
    lines / 95.23% branch — all comfortably above the 90%-line engine
    bar. Repo-wide 99.22% lines / 94.94% branch, above the 70% overall
    bar. `npm run build`, `npx tsc --noEmit`, `npm run lint` all clean
    (same 17 pre-existing unrelated warnings, 0 errors).
  - **Recommendation on security review:** a dedicated
    retrospeq-security-reviewer pass IS warranted for this slice — not
    because the new service-role write pattern itself needs re-review
    (that part is genuinely covered by Slice 3's prior PASS, same
    connection/parameterization posture, no new injection surface), but
    specifically to make a documented, authoritative call on the
    `trade_captures` DB-level lock-enforcement gap above (real, newly
    load-bearing now that this slice is the "arm-matching mechanism" the
    Slice-1 migration comment pointed to) before Module 03/06 builds a
    real client write path on top of it. A narrow-scope review of that
    one question is enough; it doesn't need to re-walk Slice 3's whole
    checklist.

- **retrospeq-security-reviewer: one blocking FAIL, fixed, re-reviewed
  PASS, 2026-08-22.** Failed the slice on exactly the gap tester found
  and proved empirically: `trade_captures`' "never after lock" invariant
  (stated twice in the spec, §4.5 and §4.7, the same weight as AGENTS.md's
  "rule evaluations freeze and are never recomputed retroactively"
  non-negotiable) was enforced only in application code, and the
  Slice-1 migration's own comment had already named THIS slice as where
  it would close — deferring it a second time was judged not
  acceptable, unlike genuinely new gaps that get tracked for later.
  Provided ready-to-apply migration SQL modeled on the existing
  `forbid_broker_confirmed_trade_delete` trigger. Fixed by the
  orchestrator: `supabase/migrations/20260822030000_trade_captures_pre_entry_lock_trigger.sql`
  (`retrospeq.forbid_pre_entry_capture_edit`, a `BEFORE UPDATE` trigger
  rejecting any edit to a row where `OLD.moment = 'pre_entry'`), applied
  live and verified against the real shared dev Supabase project
  (`pg_trigger`/`pg_proc`), with `arm-matching.live.test.ts`'s
  "DB-level gap check" test flipped from proving the bypass succeeds to
  proving it's now rejected (`.rejects.toThrow(/cannot edit a locked
  pre_entry capture/)`). Re-reviewed: PASS — independently confirmed the
  trigger covers both a literal `UPDATE` and `writeTradeCapture`'s own
  `ON CONFLICT ... DO UPDATE` path (verified live, not assumed), that it
  is not overbroad (a legitimate edit to a non-`pre_entry` row still
  succeeds, confirmed live), and that it doesn't interfere with the
  erasure cascade-delete path (`BEFORE UPDATE` only, never fires on
  `DELETE`).
- **retrospeq-qa: PASS**, no blocking findings. Confirmed the fix
  genuinely closes the gap (read the trigger SQL directly, didn't just
  trust the two prior reviews), confirmed §4.5's "ambiguous... never
  guess" and "never_filled retains the row, doesn't discard" are both
  real, confirmed the scope boundaries (no arm-creation UI, no
  ambiguous-resolution UI) are honestly stated. One non-blocking
  performance note for a future pass: `matchPendingArmEvents` issues one
  candidate-fill query per pending `arm_events` row (N+1 shape) rather
  than one batched query — not a budget-breaker today given the
  `arm_pending` partial index and the 30-minute window keeping the
  pending set small, but worth batching if this ever scales to accounts
  with many concurrently pending arms.
- **Module 02 Slice 4 is now genuinely done.** Full suite: **755
  passing**, 12 skipped, 0 failed. `npm run build`, `npx tsc --noEmit`,
  `npm run lint` all clean.

**Module 02 Slice 5 (confirm/freeze transaction §4.6) — coder pass
complete, real functionality against the real live DB, not stubs.
tester/security-reviewer/qa passes still needed before this slice (and
Module 02 as a whole) can be marked done. Security review flagged as
warranted below, not decided unilaterally.**

- `lib/ingestion/confirm.ts` — `confirmDay(accountId, serverDay, options)`
  (the user-initiated confirm/freeze transaction for ONE account/day) and
  `autoConfirmStaleTrades(options)` (the daily 7-day sweep), both running
  as a single `withServiceRoleConnection` transaction each, matching
  `sync.ts`'s established pattern (every query explicitly scoped to the
  account/user resolved from the loaded account row, per ADR 0005's
  caveat). `confirmDay` implements §4.6's three assertions literally:
  no unresolved `coverage_gaps` row overlapping the server_day, no
  `grouping_confidence = 'ambiguous'` trade anywhere in the day, and — this
  slice's own required extension, not literal spec text — no eligible
  trade's backing block has a fill not yet reflected in its derived facts
  (`sync.ts`'s own `BLOCK_EXTENSION_DEFERRED`/`FILL_LATE_ARRIVAL`
  anomalies, previously only logged and ignored). Refusals are a
  structured, typed, discriminated-union result
  (`ConfirmDayResult`/`code`/per-code detail), never a thrown generic
  string; a genuine caller bug (unknown `accountId`, zero trade rows with
  no explicit `kind` override) throws a named error class instead, same
  split `sync.ts` already established between "legitimate but blocked"
  and "caller bug."
- **This is the mechanism that closes the tracked BLOCK_EXTENSION_DEFERRED
  gap Slice 3/4's tester pass flagged as "a firm requirement, not just a
  'revisit if it becomes a blocker'":** rather than building in-place
  block extension (still out of scope, a genuinely larger feature), a
  stuck-open/stale-facts trade can now also never be silently CONFIRMED
  with incomplete facts — both `confirmDay` and `autoConfirmStaleTrades`
  refuse/skip it instead. `lib/ingestion/sync.ts` was refactored (no
  behavior change, all 26 existing unit + 11 live tests still pass
  unmodified) to factor the "does this block's fresh fill membership agree
  with what's recorded" check out of `recomputeInstrument` into a shared,
  exported `loadInstrumentBlockState`/`findUnrecordedBlockFills`/
  `findUnrecordedFillsForBlock` — the literal same correctness question,
  now asked once, not duplicated.
- `lib/ingestion/server-day.ts` — new `computeServerDayRange(serverDay,
  dayRollover)`, the documented inverse of `computeServerDay` (needed
  because `coverage_gaps` stores UTC instant ranges but `trades.server_day`
  is a plain date, and there's no column carrying the instant range a
  server_day covers). Two-pass IANA-zone-aware wall-clock→UTC conversion
  (`localWallClockToUtc`), verified algebraically against the fixture
  README's own reverse formula, then confirmed by a full round-trip
  property test (200 runs × 5 rollover shapes, `fast-check`) AND against
  every real fill in all 8 golden fixtures.
- **Judgment calls made reconciling §4.6's prose into code (full detail in
  `confirm.ts`'s own header comment, summarized in the decision log
  below):** (1) the coverage-gap overlap test's own derivation; (2) the
  ambiguous-grouping assertion scans every trade in the day, not just the
  confirmation-eligible subset — an ambiguous OPEN trade would otherwise
  slip past on a technicality; (3) the stale-block guard's existence and
  scope (this slice's own extension of §4.6, not literal text); (4)
  `day_closeouts.kind` defaults to `'traded'` whenever the day has ANY
  trade row (even if all already confirmed — a legitimate idempotent
  re-confirm), and is a required, explicit caller error only when the day
  has ZERO trade rows of any status and no override was supplied; (5) the
  day_closeouts insert is `ON CONFLICT ... DO NOTHING`, genuinely
  idempotent, documented why (a stray trade landing between a page reload
  and a second click).
- **`autoConfirmStaleTrades` — two judgment calls flagged explicitly for
  the decision log, per the dispatch's own request:**
  1. **Never inserts a `day_closeouts` row, full stop** — read literally
     from §4.6's "gets a day_closeouts row only if the user closed it
     out." `day_closeouts` rows are created EXCLUSIVELY by `confirmDay`
     (the only INSERT statement into this table in the whole repo). An
     alternative reading ("insert one anyway, just never counted toward
     the streak") was considered and rejected — it would require either a
     new column speculatively invented ahead of Module 07 existing to
     define what it means, or overloading `confirmed_by = 'auto_7d'` on
     `day_closeouts` itself, a decision better left to whichever slice
     actually builds the streak.
  2. **The stale/incomplete-block guard IS applied to auto-confirm too,**
     reasoned through rather than skipped: a `status = 'closed'` trade
     (the only kind ever eligible for auto-confirm) can still share its
     block with an already-CONFIRMED sibling trade (§4.3: "a block is the
     upper bound on a trade, not the answer" — one block can host
     multiple trades), and a late fill on that shared block is exactly
     `sync.ts`'s `FILL_LATE_ARRIVAL` case. Applied as a PER-TRADE skip
     (`tradesSkippedStaleBlock`), not a whole-sweep refusal — this sweep
     spans every account/user in one call, so failing the entire batch
     over one trade's stale block would have a far wider blast radius than
     `confirmDay`'s own per-day scope justifies. **A third guard, beyond
     the literal dispatch, added and flagged here rather than silently
     included:** `autoConfirmStaleTrades`'s eligibility query also
     excludes `grouping_confidence = 'ambiguous'` trades — nothing in
     §4.6's own sentence mentions this, but auto-confirming an ambiguous
     trade would silently freeze rule evaluations (once Module 04 exists)
     over facts the product hasn't decided are correct yet, the same
     freeze-honesty failure mode the stale-block guard exists to prevent.
- Tests: **live-DB integration tests are the primary bar for this slice**
  per its own dispatch (a DB transaction, not a pure function) —
  `lib/ingestion/__tests__/confirm.live.test.ts` (17 tests): normal
  confirm + idempotent re-confirm, never-confirms-an-open-trade, refusal
  on coverage gap (plus a same-day-boundary negative control proving the
  overlap test is scoped, not "any gap on the account"), refusal on
  ambiguous grouping, refusal on `UNRESOLVED_BLOCK_ANOMALY` built via the
  REAL `sync.ts` two-sync `BLOCK_EXTENSION_DEFERRED` scenario (not
  hand-simulated) with both `anomalyCode` branches exercised
  (`BLOCK_EXTENSION_DEFERRED` and, via a confirmed-sibling-trade setup,
  `FILL_LATE_ARRIVAL`), the two thrown-error caller-bug paths, the
  `deliberate_no_trade` override, auto-confirm's 7-day threshold on both
  sides, auto-confirm's stale-block skip (constructed the same
  confirmed-sibling-block way), auto-confirm's ambiguous-exclusion, and a
  true-no-op case. Plus `lib/ingestion/__tests__/confirm.test.ts` (1
  mocked-DB unit test for `autoConfirmStaleTrades`'s `options.now` default
  fallback — deliberately NOT live-tested, since driving that branch
  against the real shared dev DB with an unbounded real "now" risks
  touching genuine unrelated data in that shared project). Plus
  `computeServerDayRange` unit + property tests in
  `lib/ingestion/__tests__/server-day.test.ts` /
  `server-day-range.property.test.ts` (24 + 10 tests). Full repo suite:
  **792 passing**, 12 skip-guard fallbacks (env present, nothing actually
  skipped). Coverage: `confirm.ts` **100% line / 100% branch / 100%
  func**, `sync.ts` unchanged at 100% line / 93.43% branch after the
  refactor (no regression). `npm run build`, `npx tsc --noEmit`, and
  `npm run lint` all clean (lint: only the same 17 pre-existing
  `_prefixed`-unused-param warnings, 0 errors).
- `docs/runbook.md` — new "Trades stuck unable to confirm — coverage-gap /
  block-anomaly backlog" entry, closing Module 02 §14's own named
  requirement ("coverage gap backlog and late-fill anomaly") that the
  "Sync failure rate" entry had explicitly forward-referenced as "not yet
  written" — this is the first slice where these conditions actually block
  something (a confirm refusal, an auto-confirm skip) rather than just
  being logged.
- No new ADR: every judgment call above is a prose-to-code translation of
  genuinely ambiguous §4.6 wording (recorded in `confirm.ts`'s own header
  + this decision log), not a deviation FROM a stated 00-foundation
  convention — same "no dedicated ADR" precedent `grouping.ts`/
  `arm-matching.ts` already established for this repo.
- **Explicitly out of scope, not built** (per the dispatch): any UI/Server
  Action/cron trigger surface for either function, Module 04/05/07's
  actual event handlers (documented no-ops only, same posture as `sync.ts`
  step 10), §4.7's corrections (manual split/join, `not_a_decision`
  toggle) and §4.8's manual entry (Slice 6), and resolving/closing
  existing `coverage_gaps` rows (`resolved_at` is only ever READ by this
  slice, never written — a sync/review-flow concern).
- **Recommendation on security review: yes, warranted.** This transaction
  is the mechanism that makes AGENTS.md's "rule evaluations freeze at
  close-out and are never recomputed retroactively" non-negotiable
  actually enforceable (even though Module 04 doesn't exist yet to write a
  frozen evaluation) and implements "regrouping is blocked" after
  `confirmed_at` — the single most safety-critical function named
  anywhere in Module 02's own spec text ("the critical transaction"). Not
  decided unilaterally; flagged for the security-reviewer's own call, per
  this repo's established practice.

**retrospeq-tester: independent pass complete, 2026-08-22 (own thread,
not a re-read of the coder's claims).** Read Module 02 §4.6 in full,
`confirm.ts` in full including its header, `sync.ts`'s shared
`loadInstrumentBlockState`/`findUnrecordedFillsForBlock` refactor, and
`server-day.ts`'s `computeServerDayRange`. Ran the full suite myself
independently (not trusting the orchestrator's own run).

- **Judgment call #1 (the third, self-added `UNRESOLVED_BLOCK_ANOMALY`
  assertion) — reasoning is sound, endorsed.** Refusing to confirm a
  trade whose backing block has an unrecorded fill genuinely prevents an
  irreversible harm (a frozen `rule_evaluation`/adherence fact that can
  never be recomputed once Module 04 exists, per AGENTS.md's own
  non-negotiable) in exchange for a recoverable one (a trade sitting
  unconfirmed). That asymmetry — permanent corruption vs. temporary
  inconvenience — is exactly what §9's "silence over wrongness" exists
  to enforce, and this slice applies it correctly to a case §4.6's
  literal text doesn't mention. **Confirmed the flagged consequence is
  real and already honestly documented, not glossed over:** there is no
  way in this repo today to distinguish "stale, more fills genuinely
  still coming" from "stale forever, a data anomaly" — a trade can sit
  `status: 'closed'`, `confirmed_at: null` indefinitely with no path
  back into the lifecycle until Slice 6 (manual split/join) or a future
  in-place block-extension feature exists. The coder already wrote this
  up explicitly in both `confirm.ts`'s own header and a new
  `docs/runbook.md` entry ("Trades stuck unable to confirm —
  coverage-gap / block-anomaly backlog") that names the exact same risk
  and recommends it inform Slice 6/in-place-extension prioritization —
  this is the right way to leave an accepted gap, not a silent one.
  `autoConfirmStaleTrades` applies the identical guard, confirmed live
  (its own dedicated test skips a stale-block trade and reports it in
  `tradesSkippedStaleBlock`, never silently auto-confirms it) — same
  reasoning, same honest gap.
- **Verified "never confirm an open trade."** The eligibility filter is
  applied in application code after fetching all of the day's trades
  (`status === 'closed' && confirmed_at === null`), not a raw SQL
  `WHERE` clause — deliberate, since the ambiguous-grouping assertion
  needs to scan every trade in the day regardless of status. Live test
  ("never confirms an open trade") proves a `status='open'` trade
  sharing the day with an eligible closed trade is left completely
  untouched (`status`/`confirmed_at`/`confirmed_by` all unchanged).
  Real, not just asserted.
- **Verified `autoConfirmStaleTrades` never inserts a `day_closeouts`
  row.** Re-derived from §4.6's own words ("gets a day_closeouts row
  only if the user closed it out") — agree this is the more defensible
  reading over inventing a new column speculatively, per the coder's own
  reasoning. The live test proves the row's actual absence via a direct
  `select from day_closeouts` (not just that the function returned
  without erroring).
- **Verified the coverage-gap overlap assertion, added two missing
  boundary-case tests.** `computeServerDayRange` + a half-open-interval
  `gap_from < dayEnd and gap_to > dayStart` test were already correct
  and covered for "gap entirely inside the day" and "gap entirely
  outside the day," but two cases the dispatch specifically named were
  untested: a gap that **touches** the day boundary exactly
  (`gap_to === dayStart` or `gap_from === dayEnd`) without truly
  overlapping, and a genuinely-overlapping gap with `resolved_at` set.
  **Added both** to `confirm.live.test.ts` — both pass, confirming the
  half-open-interval semantics and the `resolved_at is null` filter are
  correct at the boundary, not just in the middle.
- **Verified the ambiguous-grouping assertion is real** — live test
  proves refusal and reports the correct blocking trade id, constructed
  via direct SQL insert of a `grouping_confidence = 'ambiguous'` row
  rather than through `runSync` against a fixture. Checked: **no golden
  fixture in this repo produces an ambiguous grouping by default**
  (confirmed via `grep` across `fixtures/` and
  `golden-fixtures.test.ts` — zero matches for "ambiguous"), so a direct
  SQL seed is the only available option today, not a shortcut taken in
  place of a real one. Acceptable, but worth noting for whoever owns the
  fixture library: an `ambiguous`-producing fixture doesn't exist yet,
  so this assertion has never been proven against the real grouping
  engine's output, only against a hand-constructed row shaped like what
  it would produce.
- **Verified `server-day-range.property.test.ts` is real.** `fast-check`,
  200 runs per property, across all 5 `day_rollover` shapes this repo
  actually uses (both UTC-literal and IANA-zone formats, including one
  local-midnight special case), generated instants spanning 2020-2030
  (crosses real DST transitions for the IANA-zone cases, not
  hand-picked). Two independent properties: `computeServerDayRange` is a
  faithful round-trip inverse of `computeServerDay` at both edges of the
  returned range, and every instant `computeServerDay` maps to `D` falls
  inside `computeServerDayRange(D)`. Real, not decorative.
- **Ran the full suite independently:** 792 passing, 12 skipped, 0
  failed — matches the orchestrator's own run exactly, not just trusted.
  `confirm.ts` **100% line/branch/function/statement**, `sync.ts`
  unchanged at **100% line, 93.43% branch, 90.9% function** after the
  refactor — verified via `--coverage`, not taken on the coder's word.
  `npm run build`, `npx tsc --noEmit`, `npm run lint` all clean (17
  pre-existing unused-var warnings elsewhere in the repo, none new, 0
  errors).
- **Added 3 tests of my own** (all passing) in
  `lib/ingestion/__tests__/confirm.live.test.ts`: the two coverage-gap
  boundary cases above, plus one genuine new finding —
  **`confirmDay` has no atomic guard against concurrent double-processing
  of the same (account, server_day).** Two `Promise.allSettled`
  concurrent `confirmDay` calls for the same account/day BOTH fulfill
  and BOTH report the same trade as confirmed — the `UPDATE
  retrospeq.trades SET confirmed_at = ...` has no `WHERE confirmed_at IS
  NULL` (or equivalent atomic transition) guarding it, unlike
  `erasure.ts`'s `data_requests.status`-column atomic
  pending→processing transition (itself a real fix for a
  retrospeq-security-reviewer FAIL, 2026-08-21, from an almost identical
  shape of race). `day_closeouts` IS protected (`ON CONFLICT DO
  NOTHING`, verified only one row ever exists), but `trades.confirmed_at`
  is not — it silently ends up as whichever of the two concurrent
  transactions' UPDATE commits last, not deterministically the first
  caller's. **Not a live corruption today** (step 10's `trade.confirmed`
  emission to Module 04 is a documented no-op, so nothing double-fires
  yet), but this is exactly the shape of bug that becomes a real
  double-emit hazard (two frozen `rule_evaluations` for one trade) the
  moment Module 04 exists to listen for that event, and it is currently
  **undocumented** — neither `confirm.ts`'s own header nor PROGRESS.md's
  decision log mentions it. Flagged as a concrete, test-proven finding
  for the security reviewer, not a hypothesis. Test:
  `confirm.live.test.ts` → "SECURITY FINDING (independent test pass,
  2026-08-22): two genuinely concurrent confirmDay calls...".
- **Independent judgment on security review: agree, yes, warranted —
  and specifically endorse flagging `autoConfirmStaleTrades`'s
  unscoped, cross-account/cross-user sweep as a genuinely new shape of
  service-role usage in this repo.** Every other `withServiceRoleConnection`
  caller in this codebase (per ADR 0005's own caveat) filters explicitly
  on one caller-supplied `user_id`/`account_id`; `autoConfirmStaleTrades`
  takes NO scoping parameter at all and legitimately touches every
  account/user in one call — safe as currently written (the UPDATE only
  ever targets ids its own prior SELECT produced under the service role,
  never a caller-supplied id), but its own function signature offers
  **zero built-in protection** if a future slice ever wires it to a
  route reachable by anything other than a genuinely trusted cron/system
  context — there is no parameter, no internal check, nothing to prevent
  an accidentally-exposed endpoint from triggering a full cross-user
  sweep. Recommend the security reviewer treat "verify the eventual
  trigger surface (Slice 6/7+) enforces service/cron-only invocation,
  never an end-user-reachable one" as a first-class, written-down
  requirement now, before that surface is built, not discovered
  after. Combined with the concurrent-double-processing finding above,
  recommend the security review explicitly cover: (1) the
  confirmed_at-is-null-less UPDATE race, (2) the cross-account sweep's
  total lack of caller-identity restriction, and (3) the repo-wide
  RLS-INSERT-foreign-key gap already tracked in "Infra gaps" below (not
  new to this slice, but `trades`' "for all" policy is one of the
  tables named there, and this slice's writes go through it via
  `withServiceRoleConnection`, bypassing RLS entirely for both — worth
  the reviewer double-checking this slice doesn't rely on that RLS gap
  being closed for its own safety, since it doesn't: `confirm.ts` never
  goes through `authenticated`-role RLS at all, only `service_role`,
  so this is a defense-in-depth note, not a live gap for this slice
  specifically).
- **Not independently re-verified (infra-gated, same as every other live
  test in this repo):** RLS cross-user isolation for the tables
  `confirm.ts` touches (`trades`, `day_closeouts`, `coverage_gaps`) was
  already asserted 100%-of-tables/automated against the real live dev
  Postgres project in `lib/supabase/__tests__/ingestion-schema.rls.test.ts`
  (ran and passed again in this same suite run) — this slice adds no new
  tables, so no new RLS surface exists to test. Golden-fixture replay:
  this slice does not touch the grouping engine itself, so §9.3's
  fixture-replay requirement doesn't apply to `confirm.ts` directly;
  `sync.ts`'s own golden-fixture-parity tests (unchanged this slice)
  were re-run and still pass.

Full suite after my additions: **795 passing** (792 + 3 new), 12
skipped, 0 failed.

- **retrospeq-security-reviewer: one blocking FAIL, fixed, re-reviewed
  PASS, 2026-08-22.** Failed on exactly the concurrency race tester
  found: `confirmDay`'s per-trade UPDATE had no atomic guard (`WHERE id
  = $1 AND account_id = $2`, no `status = 'closed' AND confirmed_at IS
  NULL`), so two genuinely concurrent calls could both "win," leaving
  `confirmed_at`/`confirmed_by` as whichever transaction committed last
  — the same bug shape as an earlier real FAIL in
  `lib/privacy/erasure.ts` (`executeErasure`'s non-atomic
  pending→processing transition). Provided the exact fix, mirroring
  `markDataRequestProcessing`'s pattern. Fixed by the orchestrator in
  both places: (1) `confirmDay`'s per-trade UPDATE, adding `and status =
  'closed' and confirmed_at is null`, only pushing to `tradesConfirmed`
  when `rowCount > 0`; (2) `autoConfirmStaleTrades`'s bulk UPDATE, which
  turned out to have a second, distinct bug beyond the race — without
  the same guard, a trade a concurrent `confirmDay` call had already
  confirmed as `'user'` could get silently overwritten to `'auto_7d'`,
  corrupting confirmation provenance, not just racing on who "wins."
  Fixed with the same guard plus `returning id` so the function only
  reports rows it actually touched. Updated the existing race regression
  test to assert exactly one winner/one empty-list loser (was
  previously proving the bug, now proves the fix), and added a new
  regression test racing `confirmDay` against `autoConfirmStaleTrades`
  directly for the provenance-corruption scenario specifically (the
  re-review noted no dedicated test existed for it). Re-reviewed: PASS —
  independently confirmed correct Postgres READ-COMMITTED semantics in
  both locations, confirmed the additional provenance fix was correctly
  reasoned (not invented busywork), confirmed both regression tests are
  real and would fail against the pre-fix code. Every other area
  (`UNRESOLVED_BLOCK_ANOMALY` guard safety, scoping/parameterization,
  RLS/trigger interaction, the `autoConfirmStaleTrades` cross-account
  sweep's necessity) passed on the first review.
- **retrospeq-qa: PASS**, no blocking findings. Independently confirmed
  (not trusting prior claims): no code path anywhere in the repo can
  still mutate a confirmed trade's derived facts (`sync.ts`'s
  `recomputeInstrument` leaves any matched existing block/trade
  completely untouched, confirmed or not); the `UNRESOLVED_BLOCK_ANOMALY`
  guard only ever refuses, never proceeds with stale facts, and is
  scoped per trade/block/day, not a blanket account-wide refusal;
  `autoConfirmStaleTrades` never inserts a `day_closeouts` row under any
  circumstance (grepped — the only INSERT into that table anywhere in
  the repo is in `confirmDay`); both concurrency regression tests are
  real and would fail pre-fix; all three refusal types
  (`COVERAGE_GAP`/`AMBIGUOUS_GROUPING`/`UNRESOLVED_BLOCK_ANOMALY`) report
  specific, actionable blocking ids, not a generic refusal — what Slice
  7's UI will need. One minor, already-honestly-logged (not blocking)
  note: `day_closeouts.kind` isn't retroactively updated from
  `deliberate_no_trade` to `traded` if a late trade appears after a
  no-trade closeout — a known, narrow, accepted gap, not swept under the
  rug.
- **Module 02 Slice 5 is now genuinely done.** Full suite: **796
  passing**, 12 skipped, 0 failed. `npm run build`, `npx tsc --noEmit`,
  `npm run lint` all clean.

**Module 02 Slice 6, part 1 (§4.7 `not_a_decision` toggle + §4.8 manual
entry) — independent tester QA pass, 2026-08-22.** Coded by
retrospeq-coder, interrupted mid-session by a usage-limit reset, resumed
and bug-fixed by the orchestrator, then independently re-tested (not a
re-read of prior claims) per this task's own dispatch. Scope: manual
split/join, the correction-flow UI, and Slice 7's UI wiring are all still
NOT built — this covers only `lib/ingestion/corrections.ts`
(`toggleNotADecision`), `supabase/migrations/20260822040000_trades_freeze_
regrouping_trigger.sql` (`retrospeq.forbid_frozen_trade_regrouping`), and
`lib/ingestion/manual-entry.ts` (`createManualTrade`).

- **Freeze trigger, verified independently, not trusted from the
  migration's own comment:** read the SQL directly. The allowlist
  (`to_jsonb(NEW) - 'not_a_decision' IS DISTINCT FROM to_jsonb(OLD) -
  'not_a_decision'`) genuinely excuses only that one column — confirmed
  via `trades-freeze-trigger.live.test.ts`'s "(b) not_a_decision paired
  with another column change in the SAME statement is still rejected"
  case, which already existed and passes: a same-statement change to
  `not_a_decision` AND `entry_price_avg` together is still rejected
  whole. The `WHEN (OLD.confirmed_at is not null)` clause genuinely
  exempts `confirmDay`/`autoConfirmStaleTrades`'s own NULL->value
  transition (WHEN evaluates against the row's OLD state before the
  trigger body ever runs, so a still-unconfirmed row never enters the
  function body at all) — confirmed by reading the SQL, not just the
  comment, and both (c) live-DB cases (`confirmDay` and
  `autoConfirmStaleTrades`'s own UPDATEs succeeding with the trigger
  active) pass.
- **Manual entry's "no parallel code path" claim, verified concretely:**
  `manual-entry.ts` imports `recomputeInstrument` from `./sync.ts` — grepped
  the repo, confirmed exactly one function definition of that name exists
  (`sync.ts:930`), no shadow/duplicate implementation anywhere. The
  `sync.ts` diff that exports it is minimal and honest: a new, narrower
  `RecomputeInstrumentAccountContext` interface (5 fields
  `recomputeInstrument` actually reads) plus `export`, no logic changes.
  Live test confirms `grouping_confidence: 'confident_single'` and
  `grouping_source: 'auto'` on the resulting trade — falls out naturally
  from the real pipeline, not special-cased (there is no code anywhere in
  `manual-entry.ts` that sets either field directly).
- **Two-phase write's RLS boundary, verified live:** re-ran
  `manual-entry.live.test.ts`'s "a second user cannot create a manual
  trade against the first user's account" case against the real DB —
  genuinely rejected at phase 1 (`ManualEntryAccountNotFoundError`, RLS's
  own `trading_accounts_owner` policy scoping the SELECT to zero rows for
  a non-owner), not an application-level check papering over an RLS gap;
  confirmed zero fills/trades exist for the account afterward.
  Non-manual-platform rejection (`ManualEntryNotManualPlatformError`) is
  also loud (a named, thrown error) and verified live to leave zero
  `manual:%` fills behind — matches this slice's own dispatch, "must fail
  loudly, never silently create a fake manual fill on a real broker
  account."
- **Repo-wide sweep for the "$5 inconsistent types deduced" SQL bug
  pattern** (the orchestrator's own fix, applied to two files while
  resuming this interrupted slice): wrote a script scanning every
  `.test.ts` file's SQL template literals for a parameter used both bare
  and with an explicit cast in the same query. Found none beyond the two
  already-fixed files — every other repeated-parameter case in this repo
  (`arm-matching.live.test.ts`, `confirm.live.test.ts`, `sync.live.test.ts`,
  etc.) uses two explicit, consistent casts (`$4::timestamptz, ...,
  $4::date`), which Postgres accepts fine. No further instances existed.
- **New, real gap found and flagged (not present in either file's own
  header before this pass): the two-phase write's orphaned-fills window.**
  `withUserConnection`/`withServiceRoleConnection` each commit their own,
  independent transaction (`lib/supabase/direct.ts`'s `withRole`) — there
  is no single transaction spanning phase 1 and phase 2. If phase 1 (the
  two synthetic `fills` rows) commits and phase 2
  (`recomputeInstrument`) then throws for any reason, those two fills are
  left durably committed with no block/trade ever derived from them —
  and because `sync.ts`'s `runSync` explicitly skips `platform = 'manual'`
  accounts, nothing else in this repo will ever retry deriving a trade
  from them. `createManualTrade` itself still fails loudly (the caller's
  promise rejects) — this is not a silent failure at the call site, it is
  the absence of any cleanup/retry/visibility for what phase 1 already
  committed. Proved live, not asserted: added
  `lib/ingestion/__tests__/manual-entry-phase2-failure.live.test.ts` (a
  separate file, since it mocks `recomputeInstrument` to throw, which
  would otherwise break every happy-path test in `manual-entry.live.test.ts`)
  — confirms the two fills exist and are durable while zero blocks/trades
  exist for the account afterward. Documented in `manual-entry.ts`'s own
  header ("Known gap" section) with three honestly-scoped candidate fixes
  (a reconciliation sweep akin to `autoConfirmStaleTrades`; a narrow,
  reviewed INSERT policy letting phase 1+2 share one transaction; or
  surfacing orphaned fills to the user as a visible "entry failed
  partway, retry" state) — not fixed in this pass, since picking one is a
  deliberate design decision, not a QA-pass fix. This is a real,
  currently-live gap in this codebase, not a hypothetical — flagging here
  rather than letting it sit undocumented.
- **Judgment: security-reviewer pass IS warranted before this slice is
  called fully done**, agreeing with the orchestrator's own lean — not
  because anything found here failed, but because the surface touched is
  exactly the kind this project's security bar treats as mandatory-review,
  not optional: a new DB trigger altering write semantics on every
  confirmed trade (`retrospeq.forbid_frozen_trade_regrouping`), a new
  client-writable RLS INSERT path (`fills_owner_insert`'s `manual:%`
  carve-out, the first genuinely novel untrusted-input boundary since
  Slice 1's schema was reviewed), and a two-phase transaction split
  crossing two different DB privilege levels. Everything checked out
  correct in this pass, but "checked out correct under independent
  testing" and "reviewed by retrospeq-security-reviewer" are not the same
  gate, and this file's own header explicitly asks for the latter
  ("Explicitly flagged for the security reviewer, not decided
  unilaterally").
- Added one new live test (`manual-entry-phase2-failure.live.test.ts`,
  above). Full suite: **847 passing** (846 + 1 new), 12 skipped, 0
  failed — all live-DB tests genuinely ran (Supabase env vars present in
  `.env.local`, not mocked/skipped). Coverage: **99.2% lines / 95.02%
  branches overall**; `lib/ingestion/corrections.ts` 100% lines,
  `lib/ingestion/manual-entry.ts` 97.75% lines (the one uncovered branch
  is a "structurally impossible" defensive throw, matching the file's own
  documented reasoning for why it's not exercised) — both well above the
  90%/70% bar. `npm run build`, `npx tsc --noEmit`, `npm run lint` all
  clean (lint: 0 errors, 17 pre-existing warnings unrelated to this
  slice). E2E/screenshot requirement not applicable yet — confirmed via
  grep that no Server Action or UI wiring calls either function anywhere
  under `app/` (both files' own headers already say this is deferred to
  Slice 7); nothing to screenshot for a code path with no UI surface yet.
  Golden-fixture replay not re-run as a dedicated step since neither
  `corrections.ts` nor `manual-entry.ts` modifies `grouping.ts` itself
  (manual-entry.ts calls the unchanged `recomputeInstrument`) — but
  `sync.live.test.ts`'s existing golden-fixture-parity suite (3 fixtures)
  ran as part of the full suite and still passes, which is the relevant
  regression signal for "did this slice disturb the grouping engine."
- **retrospeq-security-reviewer: PASS with two non-blocking follow-ups,
  both applied and re-verified PASS same session, 2026-08-22.** No
  blocking finding — everything the tester's pass already checked out
  correct held up under review too. Two forward-looking items
  recommended before Module 04/05/06 start touching `trades`, both
  closed immediately rather than left tracked:
  1. **The freeze trigger's transition-window exemption.** The original
     `20260822040000` trigger's `WHEN (OLD.confirmed_at is not null)`
     clause meant the trigger's function body never ran at all for the
     specific UPDATE that sets `confirmed_at` for the first time — safe
     TODAY only because `confirmDay`/`autoConfirmStaleTrades` are both
     hardcoded, fixed-column UPDATEs with no client-controlled column
     set, but a structural gap a future bug (Module 04/05/06) could
     exploit to smuggle an unauthorized column change into that same
     statement. Fixed with a follow-up migration,
     `supabase/migrations/20260822050000_trades_freeze_trigger_close_transition_gap.sql`
     — removes the `WHEN` clause, moves the branching inside the
     function body (already-frozen: unchanged `not_a_decision`-only
     allowlist; transitioning-into-confirmed: widens the allowlist to
     also include `confirmed_at`/`confirmed_by`/`status` for that one
     statement only; neither: unrestricted, matching pre-freeze
     behavior). Applied live, verified via `pg_get_triggerdef` (no `WHEN`
     clause remains), and proven with a new live test ("(d) closes the
     transition-window gap") that a raw UPDATE smuggling
     `entry_price_avg` into the same statement that sets `confirmed_at`
     is now rejected and rolled back completely, while the legitimate
     transition shape still succeeds unchanged. All 7 pre-existing cases
     in that test file re-ran and still pass, confirming the fix altered
     nothing previously tested.
  2. **A missing negative-case RLS test for `fills_owner_insert`'s
     `manual:%` check.** Only the success case (manual-prefixed insert)
     and the cross-user rejection were previously tested — a same-user,
     non-`manual:`-prefixed insert attempt (the exact case that prevents
     colliding with a real broker deal id) had never actually been
     proven to fail. Added to `lib/supabase/__tests__/ingestion-schema.rls.test.ts`,
     verified live: rejected with a genuine RLS violation.
  - Re-reviewed (focused pass): PASS, both fixes independently confirmed
    correct against the live database, not just the file contents.
- **retrospeq-qa: PASS**, no blocking findings. Independently re-derived
  (not trusted from the security-reviewer's sign-off) that the freeze
  trigger's three branches — already-frozen, transitioning-into-confirmed,
  ordinary pre-freeze — are mutually exclusive and exhaustive over the
  (OLD, NEW) `confirmed_at` state space, and specifically confirmed the
  already-frozen branch also correctly rejects an attempted *un-freeze*
  (`confirmed_at` going non-null → null), since that changes the compared
  JSON too. Confirmed `toggleNotADecision` takes no reason parameter and
  invents none. Confirmed "no parallel code path" directly (read the
  import, grepped for a second `recomputeInstrument` definition — none
  exists). Judged the shared-`now()` timestamp default for manual entry
  as an honest "we don't know when" signal (`hold_seconds = 0`) rather
  than a fabricated duration, consistent with the product's "was this a
  good decision" honesty framing, not a violation of it.
- **Module 02 Slice 6, part 1 is now genuinely done** — `not_a_decision`
  toggle, the freeze-regrouping trigger (both migrations), and manual
  entry's backend write path. Coded, independently tested, security-
  reviewed (two follow-ups found and closed same session), QA-reviewed.
  Full suite: **849 passing**, 12 skipped, 0 failed. `npm run build`,
  `npx tsc --noEmit`, `npm run lint` all clean. **Manual split/join
  (§4.7), the correction-flow UI, and manual-entry's actual UI form
  remain — see "Next slice."**

**Module 02 Slice 6b (§4.7 manual split + manual join) — coded and
independently live-tested, 2026-08-22. Security-reviewer and QA passes
still needed before this slice (and the rest of Module 02's backend) can
be marked done.**

- `lib/ingestion/split-join.ts` — `splitTrade(userId, tradeId,
  splitAtFillId)` and `joinTrades(userId, tradeIdA, tradeIdB)`, both
  reusing `grouping.ts`'s `assignRoles` (now exported, no behavior change)
  and `trade-facts.ts`'s `computeTradeFacts` unchanged — "recomputes
  facts" means literally calling the same functions the sync pipeline
  calls, no parallel logic. `lib/ingestion/grouping.ts`'s `assignRoles`
  export is the only change to a previously-reviewed file in this slice.
- **Two-phase write, same `withUserConnection` → `withServiceRoleConnection`
  pattern `manual-entry.ts`/`confirm.ts` already established** — but with
  one deliberate improvement: phase 1 here is PURE VALIDATION (no writes at
  all), so unlike `manual-entry.ts`'s own documented "orphaned-fills
  window" gap, this slice has no analogous partial-write risk — every
  mutation for both functions happens inside phase 2's own single
  transaction, so a mid-operation failure rolls back everything phase 2
  attempted, leaving the pre-operation state completely intact. Phase 2
  re-validates ownership/freeze/boundary-membership from scratch (closes
  the narrow race where a concurrent `confirmDay`/`autoConfirmStaleTrades`
  freezes the trade between phase 1 committing and phase 2 starting).
- **`joinTrades`' delete-trigger interaction — the one genuinely fragile
  mechanism in this slice, exactly as dispatched:** the absorbed trade's
  `trade_fills`/`trade_events` rows are reassigned onto the surviving trade
  FIRST, then the absorbed trade row is deleted, in the SAME phase-2
  transaction — so `forbid_broker_confirmed_trade_delete`'s exists-check
  (evaluated against CURRENT membership, not history) finds nothing backing
  the absorbed trade and permits the delete regardless of whether it was
  originally broker-originated. Proven with a dedicated live test using
  REAL (non-`manual:`) provider-ref fills, not reasoned about only — see
  `__tests__/split-join.live.test.ts`'s join happy-path test, which
  deliberately uses broker-shaped provider refs for exactly this reason,
  plus a second dedicated test exercising the `trade_events` reassignment
  branch specifically (a survivor carrying an ADR-0001 synthetic
  flip-opening entry, built from the real `flip_no_flat` golden fixture via
  `runSync`).
- **Judgment calls made (logged here per 00-foundation §12, full reasoning
  in `split-join.ts`'s own header — none deviate from a stated
  00-foundation convention, so no new ADR was written; flagged for
  security-reviewer/QA to confirm that judgment, not decided unilaterally
  as final):**
  1. Both resulting trades' `grouping_confidence` → `'confident_single'`,
     `grouping_signals` cleared to `{}` — "a user-directed
     split/join has no ambiguity left by definition" (this slice's own
     dispatch, verbatim).
  2. `grouping_source`: `'user_split'` for both trades a split produces
     (§4.7's literal value); `'user_join'` for a join's survivor — both
     verified against `trades_grouping_source_check`'s exact allowed list
     before use.
  3. `ambiguity_resolved_at` set to the operation's own timestamp on every
     trade touched, regardless of prior confidence — read as "the last
     time a human decided this trade's own boundary."
  4. Split boundary validation exactly as dispatched: not a current member
     → `SplitBoundaryNotMemberError`; the ADR-0001 synthetic flip-opening
     entry → `SplitBoundaryIsSyntheticEntryError`; the chronologically-first
     member (and not synthetic) → `SplitBoundaryIsFirstMemberError`. The
     synthetic check is deliberately ordered BEFORE the first-member check
     — a real synthetic entry is always a trade's own first member (proved
     in the file's header), so checking index-zero first would make the
     more specific, more informative error permanently unreachable.
  5. Join's surviving trade: the chronologically-earlier one (`opened_at`),
     tying on `id` for a fully deterministic choice — this slice's own
     dispatch's suggested reading.
  6. A known, accepted, explicitly-flagged (not silently swept)
     limitation: the boundary-validation rules are implemented exactly as
     dispatched, no more — a pathological user-chosen split boundary that
     makes a subset cross net-flat more than once has no additional
     restriction added beyond what was asked, since `assignRoles` itself
     has no such invariant of its own to violate (it just produces
     whatever facts fall out) and no data corruption results. Documented as
     a product-design question for whoever builds Slice 7's UI, not
     invented scope-creep here.
- **Tests: `lib/ingestion/__tests__/split-join.live.test.ts`, 13 live-DB
  tests** (env present, all genuinely ran, none skipped) — split's happy
  path (member reassignment, recomputed facts, `grouping_source` on both),
  split refusing a confirmed trade / an invalid boundary (both first-member
  and synthetic-entry cases, the latter via a real `flip_no_flat`-derived
  trade through `runSync`, not hand-simulated), split RLS cross-user
  isolation; join's happy path (built with REAL, non-`manual:` provider
  refs specifically to double as the delete-trigger proof), join refusing
  different-block / already-confirmed / same-trade-twice / cross-user
  attempts, join's synthetic-entry-survivor case (the `trade_events`
  reassignment branch specifically); a full split-then-join round trip
  proving facts match the original modulo `grouping_source`. Coverage on
  `lib/ingestion/split-join.ts`: **92.2% lines, 81.52% branches, 100%
  functions** — comfortably above the 90%/70% bar; the uncovered lines are
  all "should be structurally impossible" defensive throws, same accepted
  pattern `manual-entry.ts` already established (97.75% lines there, for
  the identical reason).
- `lib/supabase/__tests__/service-role-inventory.test.ts`'s allowlist
  updated for the one new `withServiceRoleConnection(` call site
  (`lib/ingestion/split-join.ts`'s phase 2, for both functions).
  `docs/runbook.md`'s "Trades stuck unable to confirm" entry updated —
  manual split/join is no longer "not yet built"; it is now a genuine
  in-product path back into the normal lifecycle for an ambiguous or stuck
  trade (though NOT for the `BLOCK_EXTENSION_DEFERRED`/`FILL_LATE_ARRIVAL`
  case specifically, since split/join operate on a trade's existing
  membership, not on a fill the block-derivation pass hasn't assigned to
  any trade yet — that gap is unchanged, still needs in-place block
  extension).
- Full suite: **862 passing** (849 + 13 new), 12 skipped (env-gated
  skip-guard fallbacks — env present, nothing actually skipped). `npm run
  build`, `npx tsc --noEmit`, `npm run lint` all clean (lint: 0 errors, the
  same 17 pre-existing-pattern warnings, none new).
- **Explicitly NOT built in this slice, per its own dispatch:** any Server
  Action or UI wiring for either operation (Slice 7's job, matching every
  other backend-only slice's established boundary in this module).
- **Security-review recommendation: YES, warranted, agreeing with this
  slice's own dispatch.** The `joinTrades` reassign-then-delete interaction
  with `forbid_broker_confirmed_trade_delete` is exactly the kind of
  "clever mechanism that could have a subtle hole" this project's security
  bar exists to catch a second pair of eyes on — the coder's own reasoning
  and live test prove it works for the cases tested, but "checked out
  correct under the author's own testing" and "reviewed by
  retrospeq-security-reviewer" are not the same gate, per this repo's own
  established precedent (Slice 6 part 1's freeze-trigger review, Slice 5's
  confirm-transaction review). Not yet dispatched.

**Module 02 Slice 6b — independent `retrospeq-tester` pass, 2026-08-22.**
Read Module 02 §4.7 in full, `split-join.ts` in full including its header
(all 6 judgment calls), and `__tests__/split-join.live.test.ts` in full.
This was a genuine re-derivation, not a re-read of the coder's own claims:

- **Delete-trigger workaround (the highest-priority item) — independently
  verified safe, not just plausible.** Traced `joinTrades`' phase 2 body
  line-by-line against `withServiceRoleConnection`'s implementation
  (`lib/supabase/direct.ts`'s `withRole`): a single Postgres client, one
  `BEGIN`...`COMMIT` per call, every `client.query(...)` call in the
  reassignment `for` loop and the trailing `DELETE` is `await`ed in
  sequence on that same client before the transaction commits — there is
  no async-ordering gap, no missing `await`, no second connection that
  could race it. Cross-checked `forbid_broker_confirmed_trade_delete`'s
  actual SQL (`20260822010000_ingestion_schema.sql` lines 262-275): it is
  a plain `exists(...)` against current `trade_fills`/`trade_events`
  membership at delete-time, exactly as documented, with no history
  tracking to defeat. The coder's own live test ("happy path + the
  delete-trigger interaction") is a real adversarial proof, not a weaker
  stand-in: both trades in that test are seeded with real, non-`manual:`
  provider refs (`join-a-entry`/`join-a-exit`/`join-b-entry`/`join-b-exit`),
  the ABSORBED trade (`tradeB`, the later one) is specifically the one
  carrying broker-shaped refs, and the test asserts both that the absorbed
  trade row is gone (`count = 0`) AND that its underlying `fills` rows
  still exist untouched — i.e. it proves the trigger's actual protected
  invariant ("no broker-originated financial fact is destroyed") holds,
  not merely that the delete didn't throw. A second dedicated live test
  proves the `trade_events` (not just `trade_fills`) reassignment branch
  fires, via a real ADR-0001 synthetic flip-opening entry driven through
  `runSync`. **Independent judgment: this mechanism is sound.** It relies
  on a real, cited property of the trigger (current-membership-only
  check) rather than a coincidence, the reassign-then-delete ordering is
  transaction-atomic (a mid-loop failure rolls back everything, per
  `withRole`'s catch/rollback), and the two live tests exercise exactly
  the dangerous path (real broker-shaped refs, on the absorbed side)
  rather than a weakened `manual:`-prefixed stand-in.
- **Split boundary validation — independently exercised, one gap found
  and closed.** All three named refusal cases (`SplitTradeAlreadyConfirmedError`,
  `SplitBoundaryIsFirstMemberError`, `SplitBoundaryIsSyntheticEntryError`
  via a real `flip_no_flat`-derived trade through `runSync`) are genuine
  live-DB tests, not unit-level logic checks. Found one real gap per the
  dispatch's own prompt ("what if `splitAtFillId` doesn't belong to the
  trade at all"): the existing `SplitBoundaryNotMemberError` test only
  used a syntactically-valid-but-nonexistent UUID, never a REAL fill id
  that belongs to a different trade. Functionally this is the same code
  path (`rows.findIndex` over the target trade's own member rows returns
  -1 either way — confirmed by reading `loadAndValidateSplit`), so it was
  not a correctness bug, but it was a materially weaker proof of the
  adversarial case the dispatch specifically asked about. **Added**
  `lib/ingestion/__tests__/split-join.live.test.ts`'s new test "refuses a
  fill id that is REAL but belongs to a different trade entirely" — seeds
  two independent real trades for the same user, attempts to split trade A
  at a real, currently-backing fill id that belongs to trade B, asserts
  `SplitBoundaryNotMemberError` and that neither trade's `trade_fills` rows
  changed (`count = 4` across both, unchanged). Passes.
- **Role re-derivation correctness — hand-verified arithmetically, both
  operations, matches golden-fixture-review rigor.** Split happy path (4
  fills: buy 50000@1.10000, buy 50000@1.09900, sell 50000@1.10500,
  sell 50000@1.10800; split at the trim): hand-computed
  `entry_price_avg` for subset 1 = VWAP(1.10000×50000, 1.09900×50000)/100000
  = 1.09950000, matches the test's asserted value; subset 2's re-derived
  `entry_price_avg` = VWAP(1.10500×50000, 1.10800×50000)/100000 =
  1.10650000, matches; `peak_volume` 100000 on both, `realized_pnl`
  650.00000000 (250+400, broker P&L stays attached to its own fill),
  matches. Join happy path (two independently-closed round-trip trades
  merged): traced `assignRoles`' actual role output for the 4-member
  merged sequence — because trade A was already closed before trade B
  opened, `assignRoles`' running-total walk produces roles
  `[entry, exit, add, exit]` (a genuine instance of the "pathological
  sequence" the file's own header flags as a known, accepted, non-corrupting
  limitation for the SPLIT case — here it occurs naturally on JOIN's own
  happy path, not just as a hypothetical). Verified `computeTradeFacts`
  handles this correctly regardless: it classifies members by
  `role === 'entry' || 'add'` vs `'trim' || 'exit'` via `.filter()`, not by
  sequence position, so `entryPriceAvg` = VWAP(2000, 2020) = 2010,
  `exitPriceAvg` = VWAP(2010, 2030) = 2020, `realizedPnl` = 10+10 = 20,
  `peakVolume` = 1 (running total never exceeds 1 in magnitude) — all
  match the test's asserted values exactly, and the arithmetic is
  independently correct, not merely "some value got written." This is a
  reassuring finding in its own right: the filter-based (not
  sequence-based) design in `computeTradeFacts` is robust to exactly the
  kind of odd role ordering a join of two already-closed trades produces.
- **Round-trip test — confirmed it proves something real.** Read
  `split-join.ts`'s own `recomputeGroup`/`assignRoles` logic against the
  round-trip test's assertions: split then re-join of the same two halves
  converges every recomputed fact column (`direction`, `status`,
  `entry_price_avg`, `exit_price_avg`, `peak_volume`, `initial_stop`,
  `risk_pct`, `initial_risk_pct`, `r_multiple`, `realized_pnl`, `outcome`,
  `hold_seconds`) back to the pre-split values, with only `grouping_source`
  differing (`'user_join'`, as expected) — a real "both operations ran
  AND produced arithmetically-consistent output" proof, not just "neither
  threw."
- **RLS cross-user isolation — genuine, both operations.** Both RLS tests
  use `withUserConnection`'s real `authenticated` role + `auth.uid()`
  resolution (not an app-layer ownership `if`), attempt the operation as a
  second, unrelated real auth user, assert the named not-found error, and
  assert zero rows changed afterward. Confirmed by reading
  `loadAndValidateSplit`/`loadAndValidateJoin`'s phase-1 call: it runs
  inside `withUserConnection(userId, ...)`, so a cross-user attempt is
  rejected by Postgres RLS itself (the `WHERE user_id = $2` scoping plus
  the underlying RLS policy both apply), not by an application-level
  ownership check that could be bypassed by calling the DB layer directly.
- **Edge cases from the dispatch — all checked, all sound.**
  `tradeIdA === tradeIdB` is rejected by a cheap synchronous equality
  check (`JoinTradeSameTradeError`) before any DB round-trip, tested live.
  A trade with the minimum 2 members: the round-trip test's own split
  (2-member trade, boundary at the only valid non-first index) is exactly
  this case and it succeeds, producing two genuinely non-empty 1-member
  groups — confirmed `assignRoles` can't produce an empty group here
  because the only valid split point on a 2-member trade is index 1,
  which by construction leaves exactly 1 member in each subset. A 1-member
  (never-closed single-fill) trade can never be successfully split at all
  — its only member is always index 0, always rejected by
  `SplitBoundaryIsFirstMemberError` — not explicitly tested as its own
  case but logically forced by the existing boundary checks, confirmed by
  reading the validation order.
- **Coverage independently re-measured after the added test:**
  `split-join.ts` **92.2% lines / 81.52% branches / 100% functions**
  (unchanged by the new test, since it exercises an already-covered code
  path with a stronger adversarial fixture rather than a new branch) —
  matches the coder's own reported numbers. Remaining uncovered lines
  (779-782, 789-792) are the same "should be structurally impossible"
  defensive throws already accepted for `manual-entry.ts`'s identical
  pattern — read both, agree they're not reachable without a schema-level
  data-corruption bug.
- **Golden fixtures:** the fixture library exists (`fixtures/golden/`,
  built in Phase 0) and this slice correctly replays through it —
  `flip_no_flat`'s real `input.json` is driven through the actual
  `runSync` pipeline (not hand-simulated) for both the synthetic-entry
  split-refusal test and the synthetic-entry join-survivor test. No gap
  here.
- **Property-based tests:** no NEW property-based test file exists for
  `split-join.ts` itself. Judged acceptable, not a gap to flag as missing:
  this slice adds no new grouping/rule logic of its own — it exclusively
  reuses `grouping.ts`'s `assignRoles` and `trade-facts.ts`'s
  `computeTradeFacts` unchanged, and both of those already have their own
  property-based suites (`grouping.property.test.ts`,
  `trade-facts.property.test.ts`) covering the 00-foundation §9.2
  invariants (every fill in exactly one trade, sum of fill P&L = trade
  P&L, deterministic grouping, no currency mixing) at the primitive level
  those functions operate at. This slice's own live-DB tests additionally
  prove the invariants hold end-to-end through actual DB writes (member
  reassignment row counts, the round-trip convergence test).
- Full suite re-run independently: **863 passing** (862 + 1 new),
  12 skipped (env-gated fallbacks, env present, nothing actually
  skipped), 0 failed. One transient failure seen on an initial full-suite
  run (`manual-entry.live.test.ts`, unrelated to this slice) reproduced as
  a pass both in isolation and on a clean full-suite re-run — judged a
  flake from parallel live-DB test files contending on `lib/supabase/
  direct.ts`'s capped connection pool (`max: 3`), not a real regression;
  flagged here rather than silently dismissed. `npm run build`, `npx tsc
  --noEmit`, `npm run lint` all re-run and clean (lint: 0 errors, the same
  17 pre-existing warnings, none new).
- **Independent agreement: yes, a `retrospeq-security-reviewer` pass is
  still warranted before this slice is marked done**, for the same reason
  the coder flagged it — the delete-trigger workaround checked out clean
  under this independent adversarial pass, but a second, security-focused
  read (specifically: are there OTHER ways to reach `joinTrades`' delete
  with a still-backed absorbed trade — e.g. a future caller passing
  already-stale `survivor`/`absorbed` data, or a concurrent second
  `joinTrades` call racing the same trade pair) is the kind of check this
  project's own established precedent (Slice 5's confirm-transaction
  review, Slice 6 part 1's freeze-trigger review) treats as a distinct
  gate from tester verification, not a substitute for it.
- **retrospeq-security-reviewer: one blocking FAIL, fixed, re-reviewed
  PASS, 2026-08-22.** The join/delete legitimacy question itself
  (reassign-then-delete vs. a disguised gaming vector) was independently
  re-derived and judged genuinely legitimate: §4.7's "never delete" rule
  exists to stop a trader hiding a decision from analysis, and the
  trigger's own comment frames it that way — join does the opposite,
  recomputing facts over the FULL merged member set so nothing is hidden
  or lost, and the join is bounded to "same block only" so it can't merge
  two genuinely unrelated decisions. The one real, blocking finding: both
  functions' trade-updating UPDATE (inside phase 2) had no atomic guard
  against a concurrent `confirmDay`/`autoConfirmStaleTrades` call
  freezing the trade in the gap between phase 2's own entry
  re-validation SELECT and its later UPDATE — the identical bug class
  already found and fixed in `confirm.ts` earlier this session, left
  unapplied here. Fixed by the orchestrator: `and confirmed_at is null`
  added to both UPDATE WHERE clauses (`splitTrade`'s original-trade
  update, `joinTrades`' survivor update), throwing
  `SplitTradeAlreadyConfirmedError`/`JoinTradeAlreadyConfirmedError` on a
  lost race, positioned before ANY side-effecting work in either function
  (the new-trade insert for split; member reassignment and the
  absorbed-trade delete for join) — a lost race means nothing else in
  that phase-2 call ever runs. Two new deterministic live tests added
  (not `Promise.allSettled` timing luck): a second raw `pg.Client` opens
  an uncommitted confirm-shaped UPDATE on the trade and holds it open,
  forcing the real `splitTrade`/`joinTrades` call to genuinely block on
  the same Postgres row lock — deterministic every run, not dependent on
  JS scheduling. Re-reviewed: PASS — the security-reviewer independently
  judged this technique sounder than the `Promise.allSettled` approach
  used elsewhere, confirmed it exercises the exact fixed code path (not
  an unrelated one), and confirmed the guard placement leaves no
  half-applied write possible in either function (verified against
  `withServiceRoleConnection`'s own `begin`/`commit`/`rollback` wrapping).
- **retrospeq-qa: PASS**, no blocking findings, reviewed with real
  scrutiny given this is the highest-blast-radius mechanism in the
  module. Independently re-derived (not accepted from the security
  reviewer's own conclusion) that every fact from an absorbed trade
  survives a join fully intact and auditable: `computeTradeFacts` sums
  `realized_pnl` additively across the full merged member set (verified
  arithmetically against a real test case, `10 + 10 = 20.00000000`), and
  every `trade_fills`/`trade_events` row is reassigned (not deleted) to
  point at the surviving trade before the absorbed row itself is removed
  — the underlying `fills` rows (the actual broker facts) are never
  touched at all. Confirmed the "same block only" join constraint is
  genuinely enforced (not just documented) via a real test. Confirmed
  the simple "already confirmed at call time" case is independently
  caught by phase 1's own check (not solely by the new race guard, which
  exists only for the race-specific window). Confirmed the concurrency
  guard clauses are correctly the first side-effecting statement in each
  function's phase 2, read directly rather than trusted.
- **Module 02 Slice 6b is now genuinely done.** Full suite: **865
  passing**, 12 skipped, 0 failed. `npm run build`, `npx tsc --noEmit`,
  `npm run lint` all clean. **This completes Module 02's entire backend
  (§4.1-§4.8) — every ingestion pipeline stage from sync through
  confirm/freeze through corrections now exists, tested and reviewed.**

**Module 02 Slice 7a (Server Actions layer + trade list screen, §5.1/§5.2's
first two elements) — coder pass complete, 2026-08-22. This is the FIRST
Module 02 slice with a rendered surface. retrospeq-tester/security-reviewer/qa
first two elements) — genuinely done as of this session: coded, tested
(including a full E2E suite and a live-DB ownership-check proof),
security-reviewed (PASS), QA-reviewed (PASS). See the closeout
paragraphs below the tester section for the full FAIL-free PASS story
(security review found no blocking issue, only confirmed the flagged
`confirmDayAction` ownership check was already correct).**

- `app/(app)/trades/actions.ts` — thin Server Action wrappers around
  every Module 02 backend write function built in Slices 1-6b:
  `toggleNotADecisionAction`, `createManualTradeAction`, `splitTradeAction`,
  `joinTradesAction`, `confirmDayAction`. Same shape as
  `app/(app)/accounts/actions.ts`'s established pattern throughout:
  session check → rate-limit check (5 new `lib/rate-limit/config.ts`
  scopes — `toggleNotADecision`, `manualTradeEntry`, `splitTrade`,
  `joinTrades`, `confirmDay`, tightness-by-destructiveness per this
  slice's own dispatch) → Zod-parse the boundary input → call the
  backend function → map every thrown error to a named, user-safe
  message (never a raw error/stack) → `revalidatePath('/trades')`.
- **A real, security-relevant finding, not invented for this slice:**
  `lib/ingestion/confirm.ts`'s `confirmDay(accountId, serverDay, options)`
  is — by its own header comment — a TRUSTED BACKEND-PROCESS transaction
  (same posture as `sync.ts`): it resolves `accountId` to a row and an
  owning `user_id` but never checks that `user_id` against a caller's own
  session, because until this slice nothing ever called it from a
  client-reachable boundary. `confirmDayAction` is the FIRST such
  boundary, so it adds the ownership check itself
  (`isAccountOwnedByUser`, the same function `disconnectAccount`/
  `updateAccountSettings` already use for the identical reason) — without
  it, any signed-in trader could pass an arbitrary `accountId` belonging
  to a different user and confirm/freeze THEIR day. Explicitly flagged in
  `actions.ts`'s own header for the security reviewer, not decided as a
  closed question unilaterally. `splitTradeAction`/`joinTradesAction`
  need no equivalent addition — `splitTrade`/`joinTrades` themselves
  already enforce ownership internally (Slice 6b), and this action layer
  passes only the caller's own `user.id`, never a client-submitted value,
  to that check.
- `lib/ingestion/trades-repository.ts` (new) — `listOpenTrades`,
  `listClosedUnconfirmedTrades`, `listConfirmedTrades` (status-scoped,
  `withUserConnection`, genuinely RLS-enforced, no new RLS surface —
  reuses `trades_owner`'s existing "for all" policy from Slice 1), and
  `listTradeMembers` (batched `trade_fills`/`fills` UNION
  `trade_events`/`fills` query across many trade ids in one round trip,
  extending the same union `split-join.ts`'s `loadTradeMemberRows`
  already established rather than reimplementing it). `TRADE_COLUMNS`
  exported from `lib/ingestion/corrections.ts` so this file's SELECT list
  can never silently drift from `toggleNotADecision`'s own — one column
  list, not two.
- `app/(app)/trades/page.tsx` — the trade list screen: open positions
  (`<article class="position">`-shaped card, adapted to this repo's real
  `.rq-*` selectors, same adaptation `accounts/page.tsx`/
  `AccountSettingsForm.tsx` already made from the spec's illustrative
  classes), closed-unconfirmed and confirmed trades (`<article
  class="trade">`-shaped row, native `<details>`/`<summary>` for the
  expandable fills table — no client JS needed for that disclosure), and
  the "not enough data yet" empty state for a zero-trade account
  (AGENTS.md's own non-negotiable — a correct, intended state, not an
  error).
- **Conviction and `pos.live_r` deliberately omitted from the open
  position card**, not shown as fake/blank values — this module has no
  conviction-capture UI built yet (Module 03/08 territory) and
  `pos.live_r` is a Module 05 analytic that doesn't exist yet. Rendering
  either with a placeholder would be exactly the fabrication AGENTS.md
  forbids.
- **The ambiguous-grouping chip's honest-scoping decision** (Module 02
  §4.3's ambient chip, "Same trade" / "Separate" / "Later"), documented
  in `GroupingChip.tsx`'s own header: **"Later" is a genuine, real no-op**
  (client-side dismiss for the session, no server call — exactly §4.3's
  own words, "ignored, it batches into close-out," which is real
  behaviour, not a stub). **"Same trade"/"Separate" are shown but
  DISABLED**, with an honest inline note, rather than wired to a fake
  action — neither has a real one-tap backend operation yet ("Same
  trade" has no corresponding write at all; "Separate" would need a
  specific `splitAtFillId` a single tap cannot supply, and Module 02
  §4.7 is explicit that split/join always take an explicit fill id,
  never inferred). Wiring either to `splitTradeAction`/`joinTradesAction`
  today would mean guessing a boundary (a `§9` "silence over wrongness"
  violation) or silently doing nothing while looking like it worked
  (explicitly forbidden by this slice's own dispatch). Deferred to Slice
  7c, which can deep-link "Separate" to a real manual-split control once
  one exists.
- **A "sync now" Server Action was deliberately NOT built**, per this
  slice's own dispatch — no real `BrokerAdapter` exists yet (standing
  infra gap, 00-foundation §10), and a client-triggered sync button today
  would either fake success against the fixture adapter or surface a
  permanently-broken button, neither honest. Deferred until a real vendor
  adapter exists.
- **A real bug found and fixed via the mandatory screenshot/interaction
  self-check, not a code read:** the first version of `NotADecisionToggle.tsx`
  wrapped a `<form action={formAction}>` from `useActionState` around a
  controlled checkbox whose `checked` prop was derived from the action's
  returned `state`, submitted via `formRef.current?.requestSubmit()` on
  the checkbox's own `onChange`. A live-DB-backed Playwright probe
  (`tmp/verify-toggle-persist.mjs`, not committed — throwaway per
  convention) proved the underlying WRITE always succeeded (Postgres
  `not_a_decision` updated correctly both directions), but the checkbox's
  own visual state never updated IN PLACE after a real native click — it
  silently stayed at its pre-click value even once the action had fully
  resolved and the component's own computed `checked` variable had
  genuinely flipped (confirmed via a temporary debug dump). It only ever
  showed correctly after a full page reload (fresh mount). This is the
  documented React gotcha where a checkbox's internal `_valueTracker`
  desyncs once the DOM's `checked` property is toggled by a real user
  click and then reset by React to a *different* value in the same tick
  (exactly what happens while the action is pending) — later updates to
  the same `checked` prop stop reliably reaching the DOM. **Fixed** by
  rewriting the component around local `useState`/`useTransition`
  (optimistic update set synchronously inside the same `onChange` the
  native click fired, rolled back on a server error), calling the Server
  Action directly as a plain async function rather than through a form —
  the standard, reliable pattern for a controlled checkbox, verified
  afterward to flip visually in under 50ms and to persist correctly
  through a reload, both directions, via the same probe script.
- Tests: 52 new unit tests (`app/(app)/trades/__tests__/actions.test.ts`
  — 37 tests, happy path/validation/rate-limited/session-missing/
  not-found-or-not-owned for all 5 actions, matching
  `accounts/__tests__/actions.test.ts`'s established pattern;
  `app/(app)/trades/__tests__/format.test.ts` — 15 tests for the pure
  formatting helpers, including the "null never becomes a fake 0/0%"
  cases) plus 5 new live-DB tests
  (`lib/ingestion/__tests__/trades-repository.live.test.ts` — status
  scoping, cross-user isolation, `listTradeMembers` batching and scoping,
  per this slice's own dispatch: "don't re-prove RLS shape, just confirm
  the repository reads correctly scope to user_id"). Full suite: **922
  passing**, 12 skipped (env-gated skip-guard fallbacks, env present,
  nothing actually skipped), 0 failed. `npm run build`, `npx tsc --noEmit`,
  `npm run lint` all clean (lint: 0 errors, the same 17 pre-existing
  warnings, none new).
- Screenshot self-check (`tmp/screenshot-trades.mjs`, real dev server +
  real Supabase Auth test users via the GoTrue admin API, REAL seeded
  trade data via a direct-`pg` seed script covering every required
  state: an open position with confident grouping, an open position
  with ambiguous grouping — the chip renders — a closed-unconfirmed
  4-fill trade, a closed-unconfirmed trade with ambiguous grouping and a
  null `r_multiple`, a confirmed trade with `not_a_decision` pre-checked,
  and a second zero-trade account for the empty state): all reviewed —
  no red/green anywhere (the grouping chip uses `.rq-cost`, amber, the
  design system's own "trade-off to weigh" treatment, not a warning
  colour), zero `.rq-btn` primary elements on this read-focused list view
  (acceptable — the rule this repo has followed elsewhere is "never two,"
  not "always exactly one"; a natural primary action doesn't exist here
  without inventing scope, since manual entry's form is Slice 7b), `.rq-num`
  on every price/volume/R-multiple/risk-percent value, the grouping chip
  only appears on the two genuinely `ambiguous` trades, the null-`r_multiple`
  trade renders an honest dash never a fake 0, and the empty state renders
  correctly ("Not enough data yet..."). The checkbox toggle fix above was
  also independently verified end-to-end in this same pass (instant
  optimistic flip, correct DB persistence, correct reload-survival).
- **Explicitly out of scope for this slice, per its own dispatch:** the
  close-out screen, the manual-entry form UI, split/join UI controls
  beyond the grouping chip's own honest-scoping decision, trim-reason
  chips — all Slice 7b/7c.
- No new runbook entry — this slice introduces no new alerting condition
  of its own (every error code surfaced maps onto Module 02 §9's already-
  documented taxonomy; `docs/runbook.md`'s existing "Trades stuck unable
  to confirm" entry already covers `confirmDay`'s refusal codes and was
  last updated for Slice 6b). No new ADR — nothing here deviates from a
  stated 00-foundation convention; the `confirmDayAction` ownership-check
  addition follows the SAME pattern `disconnectAccount`/
  `updateAccountSettings` already established, not a new one.

**Module 02 Slice 7a — independent retrospeq-tester pass, 2026-08-22.
Confirms the coder pass; adds real coverage that was missing, finds one
minor design-system-fidelity gap (not blocking), and confirms the
security-reviewer flag is warranted.**

- **`confirmDayAction`'s ownership check — independently confirmed real,
  not just correctly wired to a mock.** Read `confirm.ts`'s `confirmDay`
  directly: it resolves `accountId` via `withServiceRoleConnection` and
  never checks the resolved `user_id` against any caller — the coder's
  finding is accurate, not overstated. The existing unit test
  (`actions.test.ts`) only proves the Server Action calls a *mocked*
  `isAccountOwnedByUser` and short-circuits on `false` — it does not
  prove the real function rejects a real stranger. Added
  `app/(app)/trades/__tests__/confirm-day-action.live.test.ts` (2 tests,
  live dev/test Postgres, real `isAccountOwnedByUser` + real `confirmDay`,
  only the cookie-dependent `createClient`/`getClientIp` mocked since
  those structurally require a running Next.js request context this repo
  has no test harness for): a stranger's `confirmDayAction` call against
  another user's real account and a real eligible trade is rejected with
  `TRADE_ACCOUNT_NOT_FOUND`, `confirmDay` is never reached, and the
  victim's trade is left completely untouched (asserted directly against
  the DB row, not a mock call count) — plus a positive control proving
  the real owner, same code path, genuinely confirms the day. Both pass.
  **This independently confirms the coder's finding and closes the "only
  proven against a mock" gap** — a security-reviewer pass is still
  warranted given the stakes (this is the first client-reachable path to
  freezing rule evaluations — AGENTS.md's "Rule evaluations freeze at
  close-out and are never recomputed retroactively" — so a false negative
  here would be a critical, not cosmetic, defect), but the check itself
  is confirmed present, correctly placed before `confirmDay`, and
  effective against a live DB, not just a unit-test double.
- `lib/ingestion/trades-repository.ts` — read in full: every query scopes
  via `withUserConnection` (confirmed by reading `direct.ts`'s
  `withUserConnection`, which is genuinely RLS-enforced, `SET LOCAL ROLE
  authenticated` + `request.jwt.claims`), never the service-role client —
  this file is not a second RLS-bypass surface. All four functions
  additionally filter
  explicitly on `user_id = $1`/`tf.user_id = $2` in SQL, belt-and-braces
  alongside RLS, matching this repo's established double-check posture.
- `actions.ts` — all 5 Server Actions confirmed to have: a session check
  (`requireSessionUser`) before any other work; a rate-limit check using
  one of the 5 new `lib/rate-limit/config.ts` scopes, each a real,
  compile-time-validated key (`RateLimitScope = keyof typeof
  RATE_LIMITS`), not a typo'd/no-op string; Zod validation
  (`z.strictObject`/`z.uuid`) before any backend call; every thrown error
  mapped to a named code + a hand-written `user_message`, confirmed via
  the `internalErrorState` helper which always logs the raw error
  server-side (`console.error`) and returns a fixed, generic message —
  spot-checked with a raw Postgres-shaped error message and confirmed it
  never reaches `JSON.stringify(result)`; `revalidatePath('/trades')`
  called on every success path. Rate-limit budgets
  (`toggleNotADecision` 60/40, `manualTradeEntry` 30/20, `splitTrade`/
  `joinTrades` 25/15, `confirmDay` 20/15, ip/identity per hour) reviewed
  against the file's existing scopes (`accountSettings` 40/30,
  `connectAccount` 20/10, etc.) — consistent scale, not accidentally
  permissive, tightened roughly by destructiveness as documented inline.
- Spot-checked 3 unit tests in `actions.test.ts` for tautology: the
  `toggleNotADecisionAction` "rate limited" test (mocks a real
  `RateLimitExceededError` thrown from the rate-limit call, asserts the
  backend function is never invoked — real, not a no-op assertion), the
  "never leaks a raw internal error message" test (throws a realistic
  Postgres-shaped error, asserts the sanitized code AND that the raw
  string is absent from the serialized result — real), and the
  `confirmDayAction` "not owned" test (asserted above) — all genuine,
  none tautological.
- **Independent screenshot/E2E pass, real dev server + real Supabase Auth
  test users + real seeded Postgres data**, added as a permanent E2E
  suite (`e2e/trades.spec.ts`, 5 tests, none existed before this pass —
  Module 02 had zero E2E coverage of its first rendered surface) rather
  than a throwaway script, covering §7.4's "core flow + one failure
  path" bar: empty state, a populated list (2 open incl. one ambiguous,
  1 closed-unconfirmed, 2 confirmed — one win, one loss, one scratch, one
  long, one short), the grouping chip's disabled-buttons + "Later"
  dismissal, the not-a-decision checkbox toggle (re-verified independently
  of the coder's own probe, both directions, **with a direct DB read**
  proving the write actually lands, not just that the optimistic client
  state flips), and the failure path (a cleared-cookie "expired session"
  mid-navigation redirects to `/login` honestly, no raw error). All 5
  pass. Screenshots read back and checked against the design-system bar:
  no red/green anywhere — win/loss/scratch outcomes and long/short
  direction are both plain text/data-attributes only, confirmed no CSS
  rule anywhere selects on `data-outcome`; the ambiguous-grouping chip is
  the sanctioned `.rq-cost` amber "trade-off to weigh," never a warning
  colour; `.rq-num` spot-checked present on risk %, R-multiple (including
  a genuine negative, `-1.0R`, rendered in plain text/weight, no colour);
  the "Same trade"/"Separate" buttons are genuinely `disabled` (Playwright
  actionability itself refuses to click them, not merely dimmed — proven,
  not just read from CSS) with the honest inline note; the empty state
  shows real "Not enough data yet" copy with zero fake table/card markup.
  Session cleanup for both this suite's and the coder's own test users
  confirmed complete (0 leftover `retrospeq-e2e-trades-*` auth.users rows
  after the run).
- **One real, minor finding: `.rq-btn--equal` fidelity gap in
  `GroupingChip.tsx`.** Every other `.rq-btn` variant in this codebase is
  applied in combination with the base `.rq-btn` class (`className="rq-btn
  rq-btn--ghost"`, confirmed via `privacy/page.tsx`'s own usage) — the
  base class supplies the design system's actual touch-target sizing
  (`min-height: 44px`), radius token, and base font size.
  `GroupingChip.tsx`'s "Same trade"/"Separate" buttons use
  `rq-btn--equal` ALONE, substituting ad hoc Tailwind utility classes
  (`rounded-md px-3 py-2 text-sm`) instead of reusing those tokens. Not a
  red/green or ethics violation (the equal-pair styling itself, and the
  honest disabled note, are both correct), and both buttons are disabled
  in this slice so it's not yet user-facing, but it should be fixed to
  `className="rq-btn rq-btn--equal ..."` before Slice 7c makes these
  buttons live, to get the canonical 44px touch target back. Flagged for
  whoever picks up Slice 7c, not filed as a blocking defect against this
  slice.
- Also flagged, non-blocking: the open-position card's age (`formatAge`,
  e.g. "2d 6h") and the fill-count span (`formatFillCount`, e.g. "1
  fill") are both numeric/measurement values rendered as plain `rq-sub`
  text, not wrapped in `.rq-num`, unlike risk %/R-multiple/volume/price
  on the same screen which correctly are. The design-system rule reads
  "no exceptions" — worth a follow-up pass even though these read more as
  descriptive labels than measurements.
- **Coverage note, pre-existing repo-wide scope, not introduced by this
  slice:** `vitest.config.ts`'s coverage `include` is `lib/**/*.ts` only
  — `app/(app)/trades/actions.ts`/`page.tsx`/`format.ts`/
  `GroupingChip.tsx`/`NotADecisionToggle.tsx` have real unit/E2E tests
  (confirmed above) but produce no coverage percentage in the report at
  all; this matches every other `app/` Server Action file in the repo
  (`accounts/actions.ts` etc.) so it's a standing, repo-wide gap rather
  than something specific to this slice, but is worth flagging since
  00-foundation §9.1's "70% overall" line doesn't explicitly say "lib/
  only." All `lib/ingestion` files touched by this slice
  (`trades-repository.ts`) are at 100% line coverage; `lib/` overall is
  98.48%, `lib/rate-limit` (the 5 new scopes) is 98.93%.
- Full suite, run independently (`TEMP="E:\tmp_vitest" TMP="E:\tmp_vitest"
  TMPDIR="E:/tmp_vitest" npx vitest run --coverage`): **924 passing** (922
  from the coder pass + 2 new live tests added here), 12 skipped
  (confirmed genuinely env-gated fallbacks, not silently-skipped real
  coverage — the live-DB env is present and every `.skipIf(!env)` suite
  ran for real), 0 failed. `npm run build`, `npx tsc --noEmit`, and
  `npx eslint "app/(app)/trades" lib/ingestion/trades-repository.ts
  lib/rate-limit/config.ts e2e/trades.spec.ts` all re-run independently,
  all clean.
- **retrospeq-security-reviewer: PASS, no blocking findings, 2026-08-22.**
  Independently verified (not trusting the coder/tester's own claims):
  `confirmDayAction`'s ownership check genuinely runs before `confirmDay`
  is ever called, sources the "who is asking" half from
  `requireSessionUser()`'s real session (never a client-suppliable
  value), and `isAccountOwnedByUser` genuinely enforces RLS (`SET LOCAL
  ROLE authenticated`, not app-layer trust) — there is exactly one call
  site reaching `confirmDay`, no bypass path. All 5 Server Actions
  confirmed to have session check, rate limiting (new scopes reviewed as
  reasonably tight, `confirmDay` deliberately the tightest given it's
  the highest-stakes write), input validation, and safe error mapping
  (no raw error/stack ever reaches the client). `trades-repository.ts`
  confirmed genuinely RLS-scoped via `withUserConnection` throughout,
  including the fills-union query (`trade_fills`/`trade_events`), which
  can't cross a user boundary since both legs filter independently on
  top of each table's own RLS. No new injection surface, all queries
  parameterized.
- **Fixed same session, a real minor design-system nit tester flagged
  as non-blocking:** `GroupingChip.tsx`'s disabled "Same trade"/
  "Separate" buttons were missing the base `.rq-btn` class every other
  button variant in this codebase combines with `.rq-btn--equal`/
  `.rq-btn--ghost` — losing the design system's touch-target/radius/font
  tokens. Fixed (`rq-btn--equal rounded-md px-3 py-2 text-sm opacity-50`
  → `rq-btn rq-btn--equal opacity-50` on both buttons); re-verified
  build/lint/tsc clean.
- **retrospeq-qa: PASS**, no blocking findings, reviewed with real
  design-system rigor as the first Module 02 UI surface deserves.
  Independently confirmed (read the actual CSS/classNames, not trusted
  from prior claims): every trade row's headline number is R-multiple,
  never a dollar amount; `data-outcome`/`data-status` have zero matching
  color rules anywhere in the brand CSS — win/loss/scratch and
  long/short are both plain text; the empty state renders honest prose,
  not a hidden/zeroed section. `.rq-num` genuinely present on every
  numeric metric of consequence (R-multiple, risk %, price, volume);
  `formatAge`/`formatFillCount` NOT needing `.rq-num` confirmed against
  Module 02 §5.2's own reference markup, which doesn't apply it to the
  equivalent `<time class="position__age">`/`<span class="trade__
  fillcount">` elements either — not a violation, matching spec
  precedent. Zero primary `.rq-btn` on this screen judged correct, not a
  gap: §5.1 lists "close-out day list" as a separate element from
  "trade list row," so the natural primary action belongs to Slice
  7b/Module 06, not this slice. Re-verified the grouping chip's disabled
  buttons are still genuinely non-interactive after the `.rq-btn` fix
  (real `disabled` attribute, confirmed via pixel-level screenshot
  crop, not just dimmed styling). Re-verified the `not_a_decision`
  checkbox fix is sound by reading the component directly, independently
  confirmed by a real Playwright E2E test clicking the actual checkbox
  and checking the DB row. Confirmed the mandatory screenshot self-check
  was genuinely done (real screenshots under `tmp/dev-screenshots/`,
  plus a permanent 5-test E2E suite, not just unit-tested Server Action
  logic).
- **Module 02 Slice 7a is now genuinely done.** Full suite: **924
  passing**, 12 skipped, 0 failed. `npm run build`, `npx tsc --noEmit`,
  `npm run lint` all clean.
- **Module 02 Slice 7b built (2026-08-23) — coded and self-checked by
  retrospeq-coder, not yet reviewed by tester/qa/security-reviewer.**
  Resumed from an earlier dispatch that was interrupted after building
  only backend groundwork (`lib/ingestion/trade-captures.ts`'s
  `TRIM_REASON_FIELD_ID`/`TRIM_REASONS`, `lib/rate-limit/config.ts`'s
  `writeTradeCapture` scope, `trades-repository.ts`'s
  `listTradesForAccountDay`/`listTradeCaptures`,
  `app/(app)/trades/actions.ts`'s `writeTradeCaptureAction` and the
  widened `ConfirmDayActionState` error shape) — that groundwork was
  reviewed on its own merits and built on, not redone. This dispatch
  added the close-out screen (`app/(app)/trades/close-out/{page,
  ConfirmDayForm,TrimReasonChips}.tsx`), the manual-entry form
  (`app/(app)/trades/manual-entry/{page,ManualEntryForm}.tsx`), and
  real split/join UI controls (`app/(app)/trades/{SplitControl,
  JoinControl,AutoExpandFillsOnHash}.tsx`, wired into `trades/page.tsx`'s
  new shared `TradeFillsSection`), closing Slice 7a's own documented
  deferral of `GroupingChip.tsx`'s "Separate" action. New repository
  read: `trades-repository.ts`'s `listJoinableTradeGroups`. New unit
  tests: `writeTradeCaptureAction` (7 cases — happy path, session
  missing, rate limited, invalid input, not-owned, locked, internal-error
  leak) in the existing `app/(app)/trades/__tests__/actions.test.ts`.
  Full suite: **931 passing**, 12 skipped, 0 failed (up from 924 —
  matches the 7 new tests, nothing else changed). `npm run build`,
  `npm run lint` clean.
  **One real build-time bug the mandatory "leave the build green" step
  caught, not a code read:** `TrimReasonChips.tsx` (a Client Component)
  imported `TRIM_REASONS`/`TrimReason` from `lib/ingestion/
  trade-captures.ts`, which starts with `import 'server-only'` — Turbopack
  correctly failed the build ("'server-only' cannot be imported from a
  Client Component module"). Fixed by extracting those constants into a
  new `lib/ingestion/trim-reason.ts` with no `server-only` import,
  re-exported from `trade-captures.ts` for the existing server-side
  import in `actions.ts`. Not an ADR-worthy deviation — a Next.js
  server/client boundary fix, documented inline in both files.
  **Screenshot self-check (`tmp/screenshot-closeout-manual-split-join.mjs`,
  a real Supabase test-user + live dev server, not a mock) also caught a
  real timing bug in the *test script itself*, not the product code**:
  the first pass captured every post-submit screenshot mid-transition
  (still showing "Closing out…"/"Logging…"/"Splitting…"/"Joining…")
  because `waitForSelector('[role="alert"], [role="status"]')` matched
  Next.js's own always-present dev-mode rendering-indicator badge
  (`role="status"`) instead of waiting for the real result — fixed by
  waiting on the pending-state text disappearing instead. Once fixed, all
  six required scenarios rendered correctly and were verified as real,
  not assumed: a coverage-gap refusal (honest no-retry-sync copy, no dead
  button), an ambiguous-grouping refusal (a real `/trades#trade-<id>`
  link), a clean close-out with a trim-reason pill tapped and visibly
  selected before "Day done" confirms it ("1 trade confirmed... counts
  toward your streak"), the manual-entry form's zero-manual-accounts
  state and a real submission producing "Trade logged", a real split via
  the UI (one ambiguous 2-fill open BTCUSD position became two
  independent open positions, `risk_pct` honestly `—` post-recompute
  since the seed fills carried no `stop_at_fill`, never a fabricated
  value), and a real join via the UI (two 2-fill ETHUSD trades sharing a
  `block_id` merged into one real 4-fill trade, the pre-join joinable-pair
  entry correctly disappearing from "Same position, separate trades"
  after). The join step also incidentally proved a genuine product
  behaviour worth naming: performing a split creates a brand-new
  joinable pair in the same render pass (the two new same-block trades
  are, correctly, both immediately eligible to be joined again) — the
  test script's first pass used an under-specific button locator that
  hit this new pair instead of the intended one, fixed by naming the
  target instrument in the locator; not a product bug, but a reminder
  that "Same position, separate trades" can grow from an action taken
  on the same page, not just from sync.
  **Judgment calls made, none deviating from a stated 00-foundation
  convention:** (1) `OpenPositionCard` now renders a fills section (with
  a working split control) but ONLY when `grouping_confidence ===
  'ambiguous'` — §5.2's own open-position reference markup has no fills
  table, so this stays true for the ordinary case; it exists specifically
  so `GroupingChip`'s "Separate" link has a same-card destination to open,
  via a small client-side assist (`AutoExpandFillsOnHash.tsx`) since a
  native `<details>` isn't reliably auto-opened by every browser just
  because a URL fragment targets it. (2) The trim-reason chip row is
  rendered once per trade at close-out, not per scale-out fill in
  real time — no real-time fill-notification surface exists yet (already
  flagged in the interrupted prior session's own `trade-captures.ts`
  header, restated here). (3) "Skip" is a transient, client-only
  dismissal (never persisted), matching `GroupingChip`'s existing
  "Later" precedent — reappears on reload, which is the honest reading
  of "always skippable," not "skip is remembered forever." (4) The
  join list offers consecutive pairs, not an N-way join, when a block
  hosts more than two eligible trades, matching `joinTrades`'s own
  two-argument signature. (5) Close-out's hidden `kind` field defaults
  to `'traded'` when the day has any trades, else `'deliberate_no_trade'`
  automatically — completes the confirm flow honestly for a genuinely
  empty day without inventing streak/no-trade-day UI (Module 07/08
  territory, explicitly out of scope). **Security-review recommendation
  (coder's own, not final):** the one new server-side write this slice
  adds beyond Slice 7a (`writeTradeCaptureAction`) was already built and
  reasoned through in the interrupted prior session, including its
  explicit `trade_captures` ownership check — this dispatch reused that
  reasoning rather than re-deriving it, and every other write this slice
  triggers from the UI (`splitTradeAction`/`joinTradesAction`/
  `confirmDayAction`/`createManualTradeAction`) is Slice 7a's own
  already-reviewed code, called with no new privilege path. Recommend a
  fresh security pass focus narrowly on `writeTradeCaptureAction` (not
  yet independently reviewed) and on the new client components
  (`SplitControl`/`JoinControl`/`TrimReasonChips`) purely for "does the
  client only ever call the already-reviewed Server Action, never a new
  privileged path" — expect this to be fast, not a full Module 02
  re-review.
  **Not marked done — that's tester/qa's call next, then security-reviewer
  if their pass agrees a narrow one is warranted.**

- **retrospeq-tester independent pass on Slice 7b (2026-08-23) — a real
  re-test, not a re-read of the coder's own self-check.** Findings:
  1. **`writeTradeCaptureAction`'s explicit ownership check is real and
     correctly placed.** Read `app/(app)/trades/actions.ts` in full: the
     `select 1 from retrospeq.trades where id = $1 and user_id = $2` query
     runs inside the same `withUserConnection` block, before
     `writeTradeCapture` is ever called, and its result gates whether that
     call happens at all. Independently confirmed `trade_captures_owner`'s
     RLS policy (`20260822010000_ingestion_schema.sql`) really is
     `user_id = auth.uid()` only — no clause ties `trade_id` back to its
     owning trade — so this check is not defence-in-depth on top of an
     already-sufficient RLS policy, it is the actual security boundary for
     this write path, exactly as the coder's comment claims. Agree with
     the coder's own narrow-pass recommendation: this one write path is
     sound; nothing else in the file introduces a new privileged path.
  2. **Close-out's three refusal codes render honestly, with real detail,
     and `COVERAGE_GAP` has no working retry-sync control.** Verified by
     reading `ConfirmDayForm.tsx` and independently via a real browser
     (screenshots below) — `COVERAGE_GAP` shows the actual gap count in
     the message text (not a generic "something's wrong"), plus an
     explicit "Sync isn't automated yet" note; no `<button>` or `<a>`
     matching /retry/i exists anywhere on the page (asserted in a new E2E
     test, not just eyeballed). `AMBIGUOUS_GROUPING` and
     `UNRESOLVED_BLOCK_ANOMALY` both render real `/trades#trade-<id>` deep
     links per blocking trade.
  3. **Split/join controls correctly mirror the backend's own eligibility
     rules — verified at the query level, not assumed.** `SplitControl`
     is only offered for `index > 0 && !member.syntheticEntryEvent`; cross-
     checked `listTradeMembers`'s `order by trade_id, filled_at, fill_id`
     against `split-join.ts`'s own `loadTradeMemberRows`'s identical
     `order by filled_at, fill_id` — the two orderings agree, so "index 0"
     means the same fill in both places. `listJoinableTradeGroups`'s
     `where user_id = $1 and confirmed_at is null`, grouped by `block_id`,
     size > 1, matches `joinTrades`'s own `loadAndValidateJoin` precondition
     exactly (same block, both unconfirmed, no adjacency requirement either
     side imposes).
  4. **Real gap found and closed: three new `trades-repository.ts`
     functions shipped with zero test coverage.** Full-suite coverage
     before this pass showed `trades-repository.ts` at only 55.2% lines
     (95-193 uncovered) — exactly `listTradesForAccountDay`,
     `listTradeCaptures`, and `listJoinableTradeGroups`, all three
     backing client-reachable screens (close-out, the trade list's join
     section). Added 6 new live-DB tests to
     `lib/ingestion/__tests__/trades-repository.live.test.ts` (scoping
     correctness + RLS cross-user isolation for all three) — file now at
     100% lines. One near-miss caught before landing: an early draft of
     the "excludes a confirmed trade" test used
     `update ... where id != $1` to confirm one trade, which would have
     mutated every OTHER trade in the shared live-DB test project
     (parallel suites) — narrowed to `where id = $1` before running.
  5. **Independent screenshot self-check, real browser, real dev server,
     real Supabase Auth — not a re-trust of the coder's own screenshots.**
     New permanent suite `e2e/trades-slice7b.spec.ts` (7 tests, all
     passing in isolation) covers: `COVERAGE_GAP` refusal, `AMBIGUOUS_
     GROUPING` refusal + deep-link-and-auto-expand, a successful close-out
     with a trim-reason chip tapped first, manual-entry's zero-accounts
     state, a real manual-entry submission, a real split via the UI (DB-
     verified: 1 trade becomes 2), and a real join via the UI (DB-verified:
     2 trades become 1). Also updated `e2e/trades.spec.ts`'s grouping-chip
     test, which had gone stale: it asserted "Separate" was disabled
     (Slice 7a's own deferral), but Slice 7b deliberately closed that
     deferral, making "Separate" a real link — a passing-but-wrong
     assertion is worse than a failing one, so this was fixed, not left.
     Screenshots reviewed directly (`Read` on each PNG, not just asserted
     on): no red/green anywhere (the accent colour used throughout —
     pills, primary buttons, the grouping-chip's warm well — is the brand
     amber, never a semantic success/danger pair); every numeric value
     (`+1.5R`, `1.0%`, prices) rendered in `.rq-num`; exactly one primary
     `.rq-btn` per screen (close-out's "Day done", manual-entry's "Log
     trade" — "Skip"/pills/ghost buttons correctly excluded); the trim-
     reason chip row and grouping chip both use plain outline/pill styling
     with no colour-coded states. The split screenshot incidentally proved
     a genuine, correct product behaviour: performing a split immediately
     creates a new joinable pair in the same block (both post-split trades
     show up under "Same position, separate trades" right after), matching
     the coder's own self-check finding.
  6. **`server-only` poisoning fix verified independently**: a clean
     `npm run build` (Turbopack) succeeds; `lib/ingestion/trade-captures.ts`
     re-exports `TRIM_REASON_FIELD_ID`/`TRIM_REASONS`/`TrimReason` from the
     new `lib/ingestion/trim-reason.ts` with no circular import (`trim-
     reason.ts` has no imports from `trade-captures.ts`) and no duplicate
     runtime definition (single source, re-exported, not copy-pasted).
  **Rate-limiting was legitimately triggered by this pass's own repeated
  E2E runs against the real signin scope (`ip:::1`, 20/900s), not a bug**
  — confirmed by inspecting `retrospeq.rate_limit_hits` directly; cleared
  the test-only buckets between runs (a test-environment reset, not a
  product change) rather than weakening the limit.
  **Full suite after this pass: 937 passing (up from 931 — 6 new live-DB
  repository tests), 12 skipped, 0 failed. Coverage: 98.5% lines / 93.75%
  branches / 98.75% functions overall** — every ingestion-engine file
  (`grouping.ts` 98.61%, `confirm.ts` 100%, `blocks.ts` 100%, `split-
  join.ts` 91.23%, `arm-matching.ts` 100%) clears the 90%-line bar,
  `trades-repository.ts` now clears it too (100%, was 55.2%). `npm run
  build`, `npm run lint` (0 errors, 17 pre-existing warnings unrelated to
  this slice), `npx tsc --noEmit` all clean, run independently, not
  trusted from the coder's own report. **Not run/verified by this pass:
  golden-fixture replay** — this slice touches no grouping-engine code
  (UI + read-only repository queries only), so 00-foundation §9.3's replay
  requirement doesn't apply here; flagging explicitly rather than silently
  omitting.
  **Verdict: agree with the coder's own security-review recommendation —
  a narrow pass on `writeTradeCaptureAction` specifically is warranted and
  sufficient, not a full Module 02 re-review.** Every other write this
  slice's UI triggers (`splitTradeAction`/`joinTradesAction`/
  `confirmDayAction`/`createManualTradeAction`) is Slice 7a's own
  already-reviewed code, called with no new privilege path — independently
  re-confirmed here, not just re-stated. **Slice 7b is now tester-passed.
  Next: retrospeq-qa (non-negotiables + design-system check) and
  retrospeq-security-reviewer's narrow pass on `writeTradeCaptureAction`.**
- **retrospeq-qa design-ethics finding on Slice 7b, fixed same session
  (2026-08-23):** `GroupingChip.tsx`'s ambient grouping question is a
  `.rq-btn--equal` pair (AGENTS.md: "no primary/secondary distinction ...
  the relaxation prompt must not imply a recommendation"). Slice 7b wired
  "Separate" to a real deep link but left "Same trade" permanently
  `disabled` (Slice 7a's own honest-scoping note — no backing write
  existed), breaking the pair's required symmetry once "Separate" became
  real: one option worked, the other looked permanently unavailable.
  **Fix: built the missing write for real rather than reverting
  "Separate" to disabled.** New backend function
  `resolveAmbiguousGroupingAsSingle(userId, tradeId)`
  (`lib/ingestion/split-join.ts`) resolves an `ambiguous` trade's grouping
  VERDICT to `confident_single` with **no membership change at all** — no
  `trade_fills`/`trade_events` writes, no new trade row, no delete — the
  simplest of the three corrections operations in that file. Backed by a
  new migration
  (`supabase/migrations/20260823010000_trades_grouping_source_confirmed_single.sql`)
  widening `trades_grouping_source_check` to allow a new
  `'user_confirmed_single'` value (deliberately distinct from
  `'user_split'`/`'user_join'`, which both restructure membership — this
  one never does), applied to and verified against the live shared dev
  Supabase project (`information_schema`/`pg_get_constraintdef` plus a
  direct bogus-value-still-rejected probe). Follows every established
  convention from `splitTrade`/`joinTrades` exactly: named errors
  (`ResolveAmbiguousGroupingNotFoundError`/`AlreadyConfirmedError`/
  `NotAmbiguousError`), the `withUserConnection` -> `withServiceRoleConnection`
  two-phase shape, and — the specific bug class
  retrospeq-security-reviewer already found and fixed twice this session
  in `splitTrade`/`joinTrades` — the atomic `and confirmed_at is null`
  concurrency guard applied to the write from the start, not bolted on
  after a race was found. New Server Action
  `resolveAmbiguousGroupingAction` (`app/(app)/trades/actions.ts`) and rate
  limit scope `resolveAmbiguousGrouping`
  (`lib/rate-limit/config.ts`, same moderate budget as `splitTrade`/
  `joinTrades`). `GroupingChip.tsx`'s "Same trade" button now calls it for
  real — `disabled`/dimmed styling and the "Not available yet" copy both
  removed; both buttons in the `.rq-btn--equal` pair are now genuinely
  live, equal, real actions with no CSS or behavioural asymmetry. **Tests:**
  5 new live-DB tests in `lib/ingestion/__tests__/split-join.live.test.ts`
  (happy path — confirmed via direct Postgres query that membership is
  untouched; refuses a confirmed trade; refuses a non-ambiguous trade; RLS
  cross-user isolation; the concurrency guard, using the same
  held-uncommitted-transaction-on-a-raw-connection technique
  `splitTrade`'s own concurrency test established) — all passing. 8 new
  unit tests in `app/(app)/trades/__tests__/actions.test.ts` (happy path,
  session missing, rate limited, validation failure, all three named
  error mappings, internal-error-never-leaks) — all passing. Full suite:
  **950 passing** (up from 937), 12 skipped, 0 failed. `npm run build`,
  `npx tsc --noEmit` clean; `npm run lint` 0 errors, 19 warnings (up from
  17 — two new, both the same `_prevState`/`_formData`-unused-because-
  this-action-takes-no-form-fields pattern already established at
  `app/(auth)/actions.ts:152`, not a new category). **Screenshot
  self-check** (`tmp/screenshot-grouping-chip-symmetry.mjs`, real dev
  server, real Supabase Auth, real Postgres verification, not simulated):
  before-state screenshot shows both "Same trade"/"Separate" visually
  identical (same outline, weight, no dimming, no color distinction) on
  two independent ambiguous open positions; clicking "Same trade" on one
  produces a real DB row change (`grouping_confidence` ->
  `confident_single`, `grouping_source` -> `'user_confirmed_single'`,
  `ambiguity_resolved_at` set) confirmed by direct query, and that trade's
  chip disappears while the untouched sibling trade's chip is unaffected;
  "Separate" on the remaining trade still opens its real fills section
  with a working "Split here" control, proving the other half of the pair
  is equally real, not regressed by this fix. No red/green anywhere in
  any screenshot. **Not run by this pass: retrospeq-qa/security-reviewer
  re-verification of this specific fix — flagging explicitly, per this
  file's own header ("not marked done — that's the qa/security-reviewer's
  call"). Security-reviewer recommendation (not a unilateral decision): a
  narrow pass on `resolveAmbiguousGroupingAsSingle` +
  `resolveAmbiguousGroupingAction` is warranted for the same reason
  `writeTradeCaptureAction` already got one — a new write to `trades`
  interacting with the freeze trigger and `confirmed_at` semantics, the
  exact pattern that has required review every other time it appeared in
  this module. Can likely be folded into the same security-reviewer pass
  already queued for `writeTradeCaptureAction` rather than a separate
  dispatch, since both are narrow, both touch the same table/trigger.**

- **retrospeq-tester independent re-verification of the `resolveAmbiguousGroupingAsSingle`
  design-ethics fix (2026-08-23, separate pass from the coder's own
  self-check above) — confirms the core claims, found and fixed one real
  gap in the test suite, added one missing test:**
  - **Zero-membership-writes claim: CONFIRMED by direct code reading.**
    `resolveAmbiguousGroupingAsSingle` (`lib/ingestion/split-join.ts`)
    contains exactly one write statement in its entire body — the guarded
    `UPDATE retrospeq.trades SET grouping_confidence=..., grouping_signals=...,
    grouping_source=..., ambiguity_resolved_at=...`. No `trade_fills`/
    `trade_events` statement appears anywhere in the function or its shared
    `loadAndValidateResolveAmbiguous` helper.
  - **Atomic concurrency guard: CONFIRMED present and correctly placed** —
    `where id = $1 and confirmed_at is null` is literally in the UPDATE's own
    WHERE clause (not a separate check), `rowCount` is checked immediately
    after, `ResolveAmbiguousGroupingAlreadyConfirmedError` thrown on a lost
    race. Verified this is the REAL protection, not just present syntax, by
    directly deleting the clause and re-running the concurrency test (see
    below) — it then failed, hitting the DB-level
    `forbid_frozen_trade_regrouping` trigger's raw, untranslated Postgres
    error instead of the clean named error. Restored immediately after
    confirming.
  - **Real, non-trivial finding: the concurrency-guard test, as originally
    written (100ms fixed `setTimeout` before releasing the raw connection's
    held lock), was NOT actually exercising the atomic guard it claimed to
    prove — for ANY of the three operations in this file (`splitTrade`,
    `joinTrades`, `resolveAmbiguousGroupingAsSingle`), not just the new one.**
    Coverage showed the guarded UPDATE's own `rowCount !== 1` throw branch had
    ZERO hits across the entire test file, including its own dedicated
    concurrency tests. Root cause: in this environment, the cumulative
    round-trip latency of phase 1 + phase 2's own connect/BEGIN/SELECT chain
    routinely exceeds 100ms on its own, so by the time the guarded UPDATE
    is even sent, the racing connection has usually already committed — the
    race gets caught by phase 2's own EARLIER upfront re-validation SELECT
    (a read-then-act check, not the atomic guard) before the guarded UPDATE
    is ever reached. Proven empirically: temporarily removed the atomic
    `and confirmed_at is null` clause from all three guarded UPDATEs in turn
    and reran each operation's own "concurrency guard" test — **all three
    still passed**, meaning none of them were actually proving what their own
    names/comments claimed. **Fixed for `resolveAmbiguousGroupingAsSingle`
    only** (the function under direct review this pass): replaced the fixed
    sleep with a new `waitForBlockedQuery()` helper
    (`lib/ingestion/__tests__/split-join.live.test.ts`) that polls
    `pg_stat_activity` for a backend whose query matches the guarded UPDATE's
    own text and whose `wait_event_type = 'Lock'` — i.e. proof from Postgres
    itself that the guarded UPDATE is genuinely on the lock queue — before
    committing the race connection. Re-verified this new version: passes
    against the real guarded code, and genuinely FAILS (non-tautological)
    when the atomic clause is removed. **`splitTrade`'s and `joinTrades`'
    own concurrency tests have the SAME weakness and were NOT touched by this
    pass** (pre-existing, inherited pattern predating this session's fix, out
    of this narrow review's scope to silently rewrite) — flagging for
    whoever next touches those two tests or does a broader concurrency-test
    audit; they currently prove "some check catches this race" rather than
    "the atomic guard specifically catches this race."
  - **`ResolveAmbiguousGroupingNotAmbiguousError` refusal: confirmed genuine,
    one test gap closed.** The existing test only proved refusal against
    `confident_single`; added a second test proving refusal against
    `confident_split` too (the schema's third `grouping_confidence` value,
    `trades_grouping_confidence_check`) — this function's `!== 'ambiguous'`
    check is a refusal rule specific to it (`splitTrade`/`joinTrades` don't
    look at `grouping_confidence` at all), so it deserved proof against both
    non-ambiguous values, not just one.
  - **Equal-pair symmetry: independently confirmed genuine, not just
    re-read.** `GroupingChip.tsx`'s "Same trade" (`<button>`) and "Separate"
    (`<a>`) both carry identical `className="rq-btn rq-btn--equal"` with no
    conditional/dimmed styling in their default state; "Same trade"'s
    `disabled={isPending}` is `false` by default and only true transiently
    mid-submit, "Separate" (an anchor) has no `disabled` concept at all —
    no default-state asymmetry. Read `tmp/dev-screenshots/grouping-chip-
    symmetry-before.png`, `grouping-chip-same-trade-clicked.png`,
    `grouping-chip-separate-still-works.png`, `trades-grouping-chip-
    same-trade.png`, `trades-grouping-chip-separate.png` directly —
    both buttons render with identical outline/weight/no color distinction
    in the default state; the gray-fill hover/focus state observed in two of
    the screenshots is applied symmetrically to whichever button is
    interacted with (confirmed by comparing both screenshots side by side),
    not a permanent asymmetry. No red/green anywhere. Post-click, the
    resolved trade's chip disappears while the untouched sibling's chip and
    "Ambiguous grouping" badge are unaffected, matching the coder's own
    described optimistic-dismiss behavior.
  - **Tests: 951 passing** (up from 950 — the coder's own 5 new live-DB
    tests plus this pass's 1 new `confident_split` test, minus 0 net since
    the concurrency test was rewritten in place, not added), 12 skipped, 0
    failed. `npm run build`, `npx tsc --noEmit`, `npm run lint` (0 errors,
    19 warnings, same pre-existing pattern) all re-run independently and
    clean.
  - **Security-review recommendation: independently agree a pass is
    warranted, not deferring to the coder's own flag.** This is a new write
    to `retrospeq.trades` that interacts directly with the freeze/
    `confirmed_at` semantics and the `forbid_frozen_trade_regrouping`
    trigger — the exact shape that required review (and, twice, found real
    concurrency bugs) every other time it appeared in this session
    (`confirm.ts`, `splitTrade`, `joinTrades`). The atomic guard here is
    correctly shaped and the zero-membership-writes claim holds, but the
    now-documented gap in how the guard was being *tested* (not the guard
    itself) is exactly the kind of thing a second reviewer should
    independently re-check rather than take on trust from one pass. Can
    fold into the same already-queued pass on `writeTradeCaptureAction` per
    the coder's own note, no separate dispatch needed.
  - **Not verified this pass (infra/scope, not silently assumed passing):**
    no golden-fixture replay was run for this change — correctly out of
    scope, `resolveAmbiguousGroupingAsSingle` never touches the grouping
    engine's fixture-covered surface (no `trade_fills`/`trade_events`
    writes, no re-derivation of roles), consistent with 00-foundation §9.3
    applying only to changes that touch the grouping engine itself. RLS on
    `retrospeq.trades` was not re-audited from scratch (it's an existing
    table with an existing, already-covered `trades_owner` policy — this
    pass added a new WRITE code path against that table, not a new table or
    a new policy, so 00-foundation §9.1's "100% of tables" bar doesn't gain
    a new denominator here; RLS cross-user isolation for this specific
    operation IS covered by its own dedicated live test, confirmed passing
    above).

- **retrospeq-security-reviewer: PASS, no findings, 2026-08-23.**
  Narrow pass on `resolveAmbiguousGroupingAsSingle`/
  `resolveAmbiguousGroupingAction` (the genuinely new write path from
  the design-ethics fix). Independently confirmed: zero membership
  writes (the function's only write is the one guarded `trades` UPDATE,
  no `trade_fills`/`trade_events` touched); the atomic
  `and confirmed_at is null` concurrency guard was present from this
  function's FIRST version, not bolted on after a FAIL like its two
  siblings (`splitTrade`/`joinTrades`) needed — the right way to build
  it the first time; the new concurrency test's determinism is genuine
  and specific to this function (`'user_confirmed_single'` is a literal
  string unique to this function's guarded UPDATE, unlike `splitTrade`/
  `joinTrades`' shared parameterized clause, so `waitForBlockedQuery`'s
  pattern match can't ambiguously match anything else); the new
  "refuses a non-ambiguous trade" rule is correct and distinct from the
  "already confirmed" check; RLS/ownership genuinely enforced; the
  migration's new `grouping_source` value is safe, distinct, and
  well-documented; no injection surface, no raw error leakage, rate
  limiting present and reasonable.
- **retrospeq-qa: PASS, no findings, 2026-08-23 — Module 02 complete.**
  Independently re-verified the equal-pair symmetry fix by reading
  `GroupingChip.tsx` directly (both buttons share identical classes, no
  `disabled` on either in default state, `.rq-btn--equal`'s CSS has a
  single undifferentiated rule set) and confirmed both paths lead to a
  real, working outcome. Formed an independent view on the orchestrator's
  decision to revert `splitTrade`'s/`joinTrades`' own concurrency tests
  to their original fixed-delay approach (after the deterministic
  technique hit real connection-pool interference) — judged this an
  acceptable, honestly-documented test-precision tradeoff, not a
  blocker, since the underlying code fix in both functions is unchanged
  from its own already-passed security review. Spot-checked every §5.1
  UI element (open position card with grouping chip, trade list row
  with expandable fills, trim reason chip row, close-out day list,
  grouping resolution control, manual entry form) has a real, working
  implementation, not just a claim. Re-swept the non-negotiables across
  all of `app/(app)/trades/` (not just this fix's files): zero red/green
  matches repo-wide, R-multiple the only headline number, `.rq-num` on
  every numeric display, honest empty/N-A states throughout.
- **Module 02 Slice 7b is now genuinely done — and this completes
  Module 02's entire feature set: backend §4.1-§4.8 (Slices 1-6b) plus
  UI §5.1/§5.2 (Slices 7a-7b).** Full suite: **951 passing**, 12
  skipped, 0 failed. `npm run build`, `npx tsc --noEmit`, `npm run lint`
  all clean.

**Next: run the Phase 1 boundary process** (AGENTS.md step 5 —
`/code-review` or `simplify`, then dispatch `retrospeq-docs` to refresh
`docs/DEVELOPMENT.md`) before marking Phase 1 complete in the Phase
status table, since Module 01 + Module 02 are both now fully done. The
BLOCK_EXTENSION_DEFERRED tracked gap from Slice 3/4 is closed at the
confirm-transaction level (Slice 5) — a stuck-open/stale-facts trade can
no longer be silently confirmed — but in-place block extension itself is
still not built; a trade whose block gains a late fill after derivation
can still sit unconfirmed indefinitely (manual split/join doesn't reach
this specific case — see the runbook entry). Also still open: resolving
`coverage_gaps` rows (nothing sets `resolved_at` anywhere in this repo
yet) — flagged in the runbook, not silently dropped. A known, tracked,
non-blocking test-precision limitation remains in `splitTrade`'s/
`joinTrades`' own concurrency-guard tests (see "KNOWN LIMITATION" in
`lib/ingestion/__tests__/split-join.live.test.ts`) — a reasonable future
pickup, not required before Phase 1 is marked complete.

## Needs-your-input signal

See `NEEDS_YOUR_INPUT.md` at the repo root — that file, not this
section, is the fast glanceable answer to "does anything need the
owner right now." This "Infra gaps" list below is the standing,
known-future-needs reference; `NEEDS_YOUR_INPUT.md` is only for things
actually stalling current work. See AGENTS.md → "When something needs
the owner — never fake it, always flag it."

## Infra gaps (tracked, not blocking on code)

- [ ] No Vercel project for Retrospeq. Owner needs to create one and either connect this repo via Vercel's GitHub integration or supply a deploy token.
- [x] ~~No Supabase project for Retrospeq~~ — **dev/test only, as of 2026-08-20, and now actually verified, not just configured.** Sharing the existing LuceEdge project (`vbuzudbipftgsuosreuy`), isolated via a dedicated `retrospeq` Postgres schema — see `docs/adr/0002-shared-dev-supabase-project.md`. `.env.local` has the URL, keys, and `SUPABASE_DB_URL` (direct connection). The `retrospeq` schema has been created for real (`20260819010000_init_schema.sql` applied and confirmed via `information_schema`). **Still open, not closed by this:** a dedicated paid-tier project is required before real launch (00-foundation §1.1) — this only unblocks local RLS/migration verification.
- [ ] No external KMS account (AWS KMS / GCP KMS / equivalent) for the envelope-encryption master key. Cannot be created by an agent — needs owner action.
- [x] ~~No git remote for this repo~~ — **resolved**, `origin` now points at `https://github.com/lucedge/Retrospeq_v1.git` (a dedicated repo, not the LuceEdge one — confirmed 2026-08-20). **New, smaller gap:** `git push` to `origin main` is being blocked in this environment by a local permission-system classifier (not a git/GitHub-side rejection — the command was denied before it ran). Commits are landing locally and are safe; they are not reaching the remote. Flagged for the owner to check the permission/auto-mode settings for this session type if pushes are expected to go through automatically per the autonomy policy above.
- [ ] Broker integration vendor undecided (00-foundation §10). Build against `BrokerAdapter` only; do not let a vendor type leak past the adapter.
- [ ] No transactional email provider configured (00-foundation §10's "Email provider" row — a separate dependency from Supabase Auth's own, already-broken mailer). `lib/privacy/email-provider.ts` (Module 01 stories 5.x, 2026-08-21) throws `EmailProviderNotConfiguredError` unconditionally rather than faking a send. Not currently blocking anything real: `lib/privacy/erasure.ts`'s confirmation email is best-effort and never gates the actual deletion, so this is a standing gap, not a stalled task — see that file's own doc comment. Needs an owner-created account with a real provider (Resend/SendGrid/Postmark/etc) plus its API key wired into env vars.
- [ ] Node version is 20.11.0; several deps warn they want >=22 (`@supabase/*@2.112.3`, `eslint-visitor-keys@5`). Still warn-only for those. **One hard incompatibility already hit and fixed**: vitest 4.x pulls in a rolldown-based Vite that requires `node:util`'s `styleText` (Node ≥20.12) — pinned `vitest`/`@vitest/coverage-v8` to `3.2.7` instead (classic esbuild-based Vite, no rolldown), see decision log. Revisit the pin when Node is upgraded past 20.11.
- [x] ~~Module 01's erasure flow will break the moment any user has a broker-confirmed `trades` row, until fixed.~~ **Fixed 2026-08-22, Module 02 Slice 3** — `lib/broker/accounts-repository.ts`'s `deleteAllTradingAccountsForUser` now sets `retrospeq.erasure_in_progress` (transaction-local `set_config`) before deleting `trading_accounts`, so `forbid_broker_confirmed_trade_delete`'s escape hatch (docs/adr/0011) actually fires for real erasure executions. Verified two ways: (1) a new live-DB test (`lib/privacy/__tests__/erasure.live.test.ts`, "succeeds for a user with a real broker-confirmed trade") seeds a genuine broker-confirmed trade and proves `executeErasure` now succeeds; (2) the fix was temporarily reverted in a scratch, never-committed check and the same test was confirmed to fail with exactly the predicted trigger error first, then restored — not just assumed fixed. This was the concrete trigger for this slice needing the first real Module 02 trade-write path (`lib/ingestion/sync.ts`), exactly as this entry predicted.
- [ ] **`C:` drive is at 0 bytes free on this machine, and Vitest's own OS-temp usage isn't covered by the existing npm-cache redirect.** The 2026-08-19 decision-log entry redirected npm's cache/tmp to `E:/npm-cache`/`E:/npm-tmp`, but `npx vitest run` (default `TEMP`/`TMP`) still fails outright with `ENOSPC` — found 2026-08-21 during an independent test pass on Module 02 Slice 2. Worked around per-invocation with `TEMP="E:\tmp_vitest" TMP="E:\tmp_vitest" TMPDIR="E:/tmp_vitest" npx vitest run ...` (directory created and cleaned up after each run). Not fixed at the environment level — that would mean either freeing real space on `C:` (owner action, not an agent one) or setting `TEMP`/`TMP` machine-wide/in a shared config, which risks affecting unrelated projects on this machine (`E:\LuceEdge`, `Pesa Hi Pesa`) the same way the npm-cache redirect note already flagged. Any agent running `vitest` directly (not through a wrapper that already sets this) should apply the same override rather than concluding the suite doesn't run. **Same root cause hit `npx playwright install chromium` too (2026-08-23, GroupingChip symmetry screenshot self-check)**: Playwright wanted `chromium_headless_shell-1234` (not present) and downloading it to `C:\Users\hp\AppData\Local\ms-playwright` failed outright with `ENOSPC`. Worked around WITHOUT downloading anything: an older `chromium-1223` (full Chrome, not headless_shell) was already fully installed there from a prior session, so `chromium.launch({ executablePath: 'C:\\Users\\hp\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe' })` works with zero new disk writes. Any agent hitting the same `chromium_headless_shell` `ENOSPC` should check for an existing `chromium-*` (non-headless_shell) directory under `ms-playwright` before assuming screenshots are blocked.
- [ ] **Repo-wide: several RLS INSERT/"for all" policies check `user_id = auth.uid()` but not that referenced foreign keys (`account_id`, `trade_id`, etc.) actually belong to that same user.** Found by retrospeq-security-reviewer (2026-08-22) reviewing Module 02's `fills`/`trade_events` INSERT policies and `trades`/`arm_events`/`trade_captures`'s "for all" policies — a client could theoretically INSERT a row self-assigning `user_id` correctly while pointing `account_id`/`trade_id` at a row it doesn't actually own. Confirmed this is not new to Module 02 — the same shape exists on Module 01's `trading_accounts_owner`/`account_credentials_owner_insert` policies too. Not fixed now (out of scope for the slice that found it, and no test currently proves it's exploitable end-to-end — the referenced row would need to belong to another real user, and the practical blast radius depends on what a client could actually DO with a cross-user-linked row it can't otherwise read, which for most of these tables is "nothing visible," since the owning row still isn't selectable by the attacker afterward). Worth a dedicated pass adding `and exists (select 1 from retrospeq.trading_accounts where id = account_id and user_id = auth.uid())`-shaped checks (or equivalent) across every affected policy, repo-wide, rather than patching table-by-table as each is touched.

## Decision log

Format: `YYYY-MM-DD — decision — why — spec/section it reconciles`

- 2026-08-23 — Phase 1 boundary process, step 1: `simplify` pass over
  Module 02's production code (`lib/ingestion/*.ts` +
  `app/(app)/trades/**`, ~7,770 lines across 26 files, diffed against
  `803336b` — the commit right before Module 02 started), per AGENTS.md
  step 5's explicit allowance for "`simplify` on the specific files just
  written, for a lighter pass" given the phase's total size. Ran the
  skill's own 4-parallel-agent protocol (reuse / simplification /
  efficiency / altitude). Most of the code held up well for a 9-slice,
  multi-pass build — reviewers specifically called out `TRADE_COLUMNS`,
  `recomputeInstrument`, `assignRoles`, and `TRIM_REASON_FIELD_ID` as
  genuinely-reused shared helpers, not duplicated, and confirmed the
  `sync.ts`/`confirm.ts` block-anomaly-guard interface is a clean
  cross-file boundary, not a bandaid.
  - **Applied** (pure, behavior-preserving extractions, re-tested after
    each): (1) `app/(app)/trades/actions.ts`'s 7 Server Actions each
    open with an identical 8-line session-check + rate-limit-check
    block — collapsed into one `requireSessionAndRateLimit(scope)`
    helper; (2) `lib/ingestion/confirm.ts`'s `autoConfirmStaleTrades`
    filtered its confirmed-id list via a reverse-iteration `splice`
    loop mutating a `const` array in place — replaced with a plain
    `.filter()` into a new `confirmedIds` binding, same result, no
    mutation.
  - **Deliberately skipped, per the skill's own "skip if it would
    change intended behavior... note the skip rather than arguing with
    it" instruction** — all genuinely real findings, but judged higher
    risk than value for a lighter pass over code that was security-
    reviewed multiple times today specifically for concurrency
    correctness: the `scopeToUserId ? ... : ...`/guarded-UPDATE-
    rowCount-check patterns repeated 3x within `split-join.ts` (touches
    the exact guard logic re-verified by security review hours ago —
    consolidating it correctly would need the same live-DB
    re-verification, out of scope here); `sync.ts`'s per-fill/per-member
    INSERT loops and `confirm.ts`'s per-trade UPDATE in `confirmDay`
    batching into bulk statements (genuine efficiency wins, but change
    the `RETURNING`/row-tracking semantics of already-hardened write
    paths); `JoinControl.tsx`/`SplitControl.tsx` UI-component
    consolidation and `ManualEntryForm.tsx`'s 4 near-identical field
    blocks (already screenshot-verified, would need re-verification);
    `issuesToFieldErrors()`'s duplication with `app/(app)/accounts/
    actions.ts` (would touch a Module 01 file outside this diff's
    scope); the `trading_accounts`-by-id query duplicated across
    `sync.ts`/`split-join.ts`/`manual-entry.ts` (each has a genuinely
    different, already-documented column subset); `blocks.ts`'s
    duplicated `DerivedBlock` object-literal construction (touches
    `deriveBlocks`, the single highest-blast-radius function in the
    module if a transcription error slipped in); `arm-matching.ts`'s
    exported-but-uncalled `isArmEventExpired` (its own test file
    references it; removing an exported, tested function isn't a
    behavior-preserving change without also touching that test).
    Several of these are worth a dedicated future pass with real
    re-testing budget, not a phase-boundary cleanup — noted here so
    they aren't rediscovered as "nobody looked at this."
  - Re-ran the full suite after each applied fix: 951 passing, 12
    skipped, 0 failed throughout. `npm run build`, `npx tsc --noEmit`,
    `npm run lint` all clean.

- 2026-08-23 — Module 02 Slice 7b design-ethics fix: added a third,
  distinct `grouping_source` value, `'user_confirmed_single'` (migration
  `20260823010000_trades_grouping_source_confirmed_single.sql`), backing a
  new `resolveAmbiguousGroupingAsSingle` corrections operation
  (`lib/ingestion/split-join.ts`). Not a literal §4.7 line item — §4.7
  only names "Manual split"/"Manual join" — but a direct, small
  consequence of AGENTS.md's `.rq-btn--equal` symmetry rule once
  "Separate" became real: leaving "Same trade" permanently disabled
  implied a recommendation between two options the design system requires
  to be equal. Chose a NEW distinct value over reusing `'user_split'`/
  `'user_join'` specifically because this operation, unlike those two,
  never touches `trade_fills`/`trade_events` membership — conflating the
  provenance would misrepresent what actually happened to any future
  analytics/audit code reading `grouping_source`. Full reasoning inline in
  `resolveAmbiguousGroupingAsSingle`'s own header comment and the
  migration's own comment. Reconciles no spec disagreement (§4.7 doesn't
  forbid a third corrections operation, it just doesn't anticipate this
  one); reconciles a real design-system tension the spec's own reference
  markup for `GroupingChip` (§5.2) didn't resolve on its own, since that
  markup predates "Separate" having a real backing write.
- 2026-08-23 — Module 02 Slice 7b (close-out screen, manual entry form,
  split/join UI controls — §5.1's remaining elements). Full reasoning
  inline in the new files' own headers (`app/(app)/trades/close-out/
  {page,ConfirmDayForm,TrimReasonChips}.tsx`,
  `app/(app)/trades/manual-entry/{page,ManualEntryForm}.tsx`,
  `app/(app)/trades/{SplitControl,JoinControl,AutoExpandFillsOnHash}.tsx`,
  `trades-repository.ts`'s `listJoinableTradeGroups`), summarized in
  "Current task" above. Resumed from an interrupted prior dispatch's
  backend groundwork rather than redoing it. Judgment calls worth
  restating here: (1) `OpenPositionCard` now renders a fills section
  (with a working split control) only when `grouping_confidence ===
  'ambiguous'`, beyond §5.2's literal open-position markup, specifically
  so `GroupingChip`'s "Separate" link has a same-card destination — closes
  Slice 7a's own documented deferral; (2) the trim-reason chip row is
  rendered once per trade at close-out, not per scale-out fill in real
  time (no real-time fill-notification surface exists yet); (3) "Skip" is
  a transient, client-only dismissal, matching `GroupingChip`'s existing
  "Later" precedent, not a persisted "never ask again"; (4) the join list
  offers consecutive pairs (not an N-way join) when a block hosts more
  than two eligible trades, matching `joinTrades`'s own two-argument
  signature; (5) close-out's hidden `kind` field defaults to `'traded'`
  when the day has any trades, else `'deliberate_no_trade'` automatically,
  completing the confirm flow honestly for a genuinely empty day without
  inventing streak/no-trade-day UI (Module 07/08 territory). None of
  these deviate from a stated 00-foundation convention, so no new ADR.
  **One real build bug found and fixed via the mandatory `npm run build`
  step** (not a code read): `TrimReasonChips.tsx`, a Client Component,
  imported constants from `lib/ingestion/trade-captures.ts`, whose
  `import 'server-only'` poisons any client bundle importing it, even for
  a plain string constant — Turbopack correctly failed the build. Fixed
  by extracting `TRIM_REASON_FIELD_ID`/`TRIM_REASONS`/`TrimReason` into a
  new `lib/ingestion/trim-reason.ts` with no `server-only` import,
  re-exported from `trade-captures.ts` for the existing server-side
  import site. **One real test-script timing bug found via the mandatory
  screenshot self-check** (not the product code): the first screenshot
  pass captured every post-submit state mid-transition because
  `waitForSelector('[role="status"]')` matched Next.js's own
  always-present dev-mode rendering-indicator badge instead of the real
  result — fixed by waiting for the pending-state button text to clear.
  Once fixed, all six required scenarios (coverage-gap refusal,
  ambiguous-grouping refusal with a real deep link, a clean close-out
  with a trim-reason pill tapped, the manual-entry form's
  zero-manual-accounts state and a real submission, a real split via the
  UI, a real join via the UI) rendered correctly — screenshots under
  `tmp/dev-screenshots/{closeout,manual-entry,split,join}-*.png`. Not
  marked done — awaiting retrospeq-tester and retrospeq-qa, with a
  narrow-scope security-reviewer recommendation (see "Current task").
- 2026-08-22 — Module 02 Slice 7a (Server Actions + trade list screen,
  §5.1/§5.2). Full reasoning inline in `app/(app)/trades/actions.ts`'s and
  `app/(app)/trades/GroupingChip.tsx`'s own headers, summarized in
  "Current task" above. Three judgment calls worth restating here: (1)
  `confirmDayAction` adds an ownership check `confirmDay` itself doesn't
  perform (that function is a trusted-backend-process transaction, same
  posture as `sync.ts` — this Server Action is the first client-reachable
  boundary in front of it), flagged explicitly for security review, not
  decided as closed; (2) the grouping chip's "Same trade"/"Separate"
  buttons are shown but disabled with an honest note rather than wired to
  a guessed or silently-no-op action, since neither has a real one-tap
  backend operation yet; (3) no "sync now" action was built — no real
  `BrokerAdapter` exists (standing infra gap), so a sync trigger would
  have to fake success. None of these deviate from a stated
  00-foundation convention, so no new ADR.
- 2026-08-22 — Module 02 Slice 6b (manual split/join §4.7,
  `lib/ingestion/split-join.ts`). Full reasoning in that file's own header,
  summarized in "Current task" above — the six judgment calls flagged
  there: `grouping_confidence`/`grouping_source`/`ambiguity_resolved_at`
  values for both operations' resulting trades; split's boundary-validation
  error ordering (synthetic-entry check before first-member check, so the
  more specific error is reachable at all, given a real synthetic entry is
  always a trade's own first member); join's surviving-trade choice
  (chronologically-earlier `opened_at`, tying on `id`); and an explicitly
  accepted, not silently swept, limitation (a pathological user-chosen
  split boundary can produce a subset that crosses net-flat more than
  once — no additional restriction added beyond what the dispatch
  specified, since `assignRoles` has no such invariant of its own and no
  data corruption results). None of the six deviate from a stated
  00-foundation convention, so no new ADR was written for this slice —
  flagged for security-reviewer/QA to confirm that call, not decided as
  final unilaterally.
- 2026-08-22 — Module 02 Slice 5 (confirm/freeze transaction §4.6,
  `lib/ingestion/confirm.ts`). Full reasoning in that file's own header,
  summarized in "Current task" above — flagging the two calls the
  dispatch specifically asked to be logged: (1) `autoConfirmStaleTrades`
  never inserts a `day_closeouts` row, ever, read literally from "gets a
  day_closeouts row only if the user closed it out" — `day_closeouts`
  rows exist exclusively via `confirmDay`'s own INSERT, the only one in
  the repo; (2) the stale/incomplete-block guard (this slice's own
  extension of §4.6, not literal spec text — the mechanism that closes
  the BLOCK_EXTENSION_DEFERRED gap Slice 3/4's tester flagged as a firm
  requirement) IS applied to `autoConfirmStaleTrades` too, as a per-trade
  skip rather than a whole-sweep refusal, because a `status = 'closed'`
  trade can still share its block with an already-confirmed sibling trade
  (§4.3's "a block can host multiple trades") and hit the FILL_LATE_ARRIVAL
  case. A third, unprompted addition also logged for visibility:
  `autoConfirmStaleTrades` excludes `grouping_confidence = 'ambiguous'`
  trades from its eligibility query — not named in §4.6's own sentence,
  added because auto-confirming an ambiguous trade would silently freeze
  facts the product hasn't decided are correct yet, the same freeze-
  honesty concern the stale-block guard exists to address. `sync.ts` was
  refactored (no behavioral change, full existing test suite unmodified
  and still green) to share its block/fill-membership-state computation
  with `confirm.ts` via new exported `loadInstrumentBlockState`/
  `findUnrecordedBlockFills`/`findUnrecordedFillsForBlock` — one
  correctness question, one implementation, per §14's own "internal note"
  documentation posture applied here to a mechanism rather than a single
  formula.
- 2026-08-21 — Module 02 Slice 4 (arm-event matching §4.5,
  `lib/ingestion/arm-matching.ts`/`lib/ingestion/trade-captures.ts`/
  `lib/ingestion/sync.ts`). Five judgment calls reconciling §4.5's
  pseudocode into code (full detail in `arm-matching.ts`'s own header,
  summarized in "Current task" above): (1) "candidates" read as candidate
  ENTRY FILLS per the pseudocode's literal `role = 'entry'` clause, which
  is equivalent to "candidate trades identified by their entry fill"
  since an entry fill maps 1:1 to its trade — reconciling two compatible
  readings, not choosing between conflicting ones; (2) the unstated
  "0 candidates, window not yet expired" case stays `pending` (no write),
  per 00-foundation §6.2's silence principle and `arm_events`'
  `match_state` DDL default; (3) the window boundary is a closed interval
  on both ends; (4) side/direction matching reuses `trade-facts.ts`'s
  existing buy→long/sell→short mapping verbatim, no second parallel
  definition; (5) default WINDOW 30 min, overridable. A sixth, separate
  judgment call in `sync.ts`'s own header: rather than tracking "new
  entry fills written this run" as a distinct set, `matchPendingArmEvents`
  re-evaluates every `pending` `arm_events` row against its instrument's
  full current entry-fill history every sync, deliberately merging §4.1
  step 8 with the open-ended `never_filled` sweep into one idempotent
  pass. A real, load-bearing design finding, not a judgment call:
  `trade_captures`' primary key is `(trade_id, field_id)` only (no
  `moment` column in the key), so "never after lock" (§4.5/§4.7) is
  enforced as an outright reject-on-conflict in `writeTradeCapture`, not
  a versioned/append-only history — documented in `trade-captures.ts`'s
  own header since it's the kind of thing someone will otherwise
  "helpfully" try to fix into a `moment`-keyed composite PK later.
- 2026-08-22 — Module 02 Slice 3 (sync pipeline §4.1 DB-writing
  orchestration, `lib/ingestion/sync.ts`). Four judgment calls reconciling
  §4.1's prose into code, all documented in the file's own header comment
  (full detail there, summarized in "Current task" above, not repeated a
  third time here): (1) overlap window default 6h; (2) `since` on a
  first-ever sync is `connected_at`, no overlap subtraction; (3)
  coverage-gap detection is skipped entirely on an account's first-ever
  sync — a real correctness fix (not just a judgment call) found while
  testing: without this exemption, `window_from = connected_at` would
  make EVERY first sync of EVERY account falsely report a gap the moment
  it found its first real fill; (4) block/trade recompute (§4.1 steps
  6-9) is scoped to ONLY brand-new blocks in this slice — any block that
  already has an existing DB row (confirmed or not) is left completely
  untouched on resync, deferring "append new fills to an already-open
  unconfirmed block across a resync boundary" to a future slice. This
  is the single biggest scope decision in the slice: it trivially and
  unambiguously satisfies "never touch a confirmed trade" (the mandatory
  invariant), at the cost of not handling the in-place-extension case yet
  — building that safely turned out to require a real matching/updating
  regrouping algorithm, not a simple recompute, because `trades`' own
  delete trigger (ADR 0011) makes any broker-backed trade permanently
  non-deletable regardless of `confirmed_at`, so "recompute" can never
  mean delete-and-rederive for a real account the way the pure
  `deriveBlocks`/`groupBlock` functions do in isolation.
- 2026-08-22 — A real, load-bearing schema gap found while building the
  above: `trading_accounts` has no equity/balance column, and
  `BrokerAdapter` has no method returning one, but Module 02 §4.4's
  `risk_pct`/`initial_risk_pct`/`r_multiple` formulas all divide by
  account equity. Resolved by adding `trading_accounts.starting_equity`
  (nullable, no default,
  `supabase/migrations/20260822020000_trading_accounts_starting_equity.sql`)
  and widening `trade-facts.ts`'s `TradeFactsAccountContext.startingEquity`
  to `string | null` — null is treated exactly like the existing "stop
  unknown" case (risk/R fields all null, never fabricated). Given its own
  ADR (`docs/adr/0013-trading-accounts-starting-equity-nullable.md`) since
  it's the kind of decision "most likely to be revisited by someone who
  does not know why it was made," per Module 02 §14's own documentation
  posture — not a 00-foundation convention deviation, a genuine
  missing-dependency gap between two modules' specs.
- 2026-08-22 — Fixed the standing tracked infra gap: `lib/privacy/erasure.ts`'s
  `deleteAllTradingAccountsForUser` (in `lib/broker/accounts-repository.ts`)
  now sets the `retrospeq.erasure_in_progress` escape hatch before
  deleting `trading_accounts`, so ADR 0011's trigger stands down correctly
  for real erasure executions — this was inert until this same slice
  built the first real Module 02 trade-write path, exactly as the
  original infra-gap note predicted. Proven live (a real broker-confirmed
  trade seeded, erasure succeeds) and proven to have genuinely been
  broken before the fix (temporarily reverted in a scratch,
  never-committed check; the same test failed with exactly the predicted
  trigger error; fix restored) — see "Current task" above for the
  live-DB test details.
- 2026-08-21 — Closing out the standing Module 04+08-reorder offer
  explicitly, so it's on record as considered-and-declined for this
  slice too, not silently missed. The owner's conditional authorization
  to reorder ahead of Module 02 (logged 2026-08-22 below, in the earlier
  entry — dates in this log are as agents dated them at the time, not
  strictly monotonic across session-limit resets) was raised again
  mid-Slice-2. Decision: **did not reorder — this was a deliberate
  judgment call, not an oversight.** Reasoning: Slice 2 was already
  substantially built (the interrupted coder pass had a working,
  well-documented `grouping.ts`/`trade-facts.ts` with only one stale
  test to fix) when the reminder arrived — switching modules mid-slice
  to re-litigate a "is Module 02 too big" question that the previous
  session's check had already answered "no, not stuck, just large"
  would have wasted the interrupted work and re-incurred the same
  spec-reading cost Module 04/08 would require, for no benefit. Slice 2
  finished cleanly in this session (680 tests passing, QA PASS, no
  blockers) — confirming the earlier assessment held. The standing
  offer to reorder remains open for a future slice if one genuinely
  stalls; it simply didn't apply here since nothing stalled.

- 2026-08-22 — retrospeq-tester independent pass on Module 02 Slice 2
  (grouping engine §4.3 + derived trade facts §4.4, coded by
  retrospeq-coder). Not a re-read: re-derived the spec sections from
  scratch, read both source files' own header doc comments in full, and
  ran the suite directly rather than trusting reported numbers. Result:
  the coder's implementation and the orchestrator's own mid-session fix
  (a stale property test wrongly asserting physical splitting on a
  non-baseline signal, rewritten to match the documented "ambiguous, not
  auto-applied" scope boundary) both held up under independent scrutiny.
  Found and closed one real gap: `trade-facts.ts` had no dedicated unit
  or property tests at all before this pass — only indirect coverage via
  8 always-closed golden fixtures — leaving the still-open-trade path,
  the `scratch` outcome band, the `contractValue` default, and the
  function's own input-contract guards untested. Added
  `lib/ingestion/__tests__/trade-facts.test.ts` and
  `trade-facts.property.test.ts` (the latter covering Module 02 §7.2's
  "sum of fill P&L equals trade `realized_pnl`" and "`risk_pct >=
  initial_risk_pct` always" invariants directly, not just via fixed
  fixture values); `trade-facts.ts` line/branch coverage went from
  91.76%/81.39% to 100%/100%. Also found and flagged (not fixed — an
  environment issue, not a code one) that default `npx vitest run` fails
  with `ENOSPC` on this machine because `C:` has 0 bytes free and the
  existing npm-cache redirect doesn't cover Vitest's own OS-temp usage —
  worked around per-invocation via `TEMP`/`TMP`/`TMPDIR`, logged as a new
  Infra gaps entry. Full detail in "Current task" above, under "Module 02
  Slice 2." Judged a dedicated security-reviewer pass not warranted for
  this slice specifically (pure functions, no DB/credentials/rule-eval
  boundary) — recommended it land with the sync-pipeline/confirm-
  transaction slice instead, once a real write path and RLS exist to
  review.

- 2026-08-22 — Owner offered explicit authorization to reorder Module 04
  (Rulebook & Evaluation) + Module 08 (Onboarding) ahead of finishing
  Module 02, conditional on Module 02 "proving too large/complex to make
  good continuous progress" — with instructions to check the actual
  spec dependencies, not reflexively reorder. Checked both specs
  directly before deciding: **did not reorder, continuing Module 02 as
  originally planned.** Reasoning:
  - Module 04's own §11 "Dependencies" names Module 02 explicitly
    ("trade facts, `trade.confirmed`"), and §13 "Relationships" states
    Module 02 "owns the freeze trigger" — the event that causes
    `rule_evaluations` to be written at all. The security-critical
    `evaluate(rule_version, trade_facts)` function (§5.3) operates on
    exactly the derived columns Module 02's `trades` table produces
    (`risk_pct`, `r_multiple`, `hold_seconds`, etc.) — there is no
    synthetic stand-in that would make this a real test of the actual
    evaluator the way Phase 0's shadow harness used synthetic analytics
    for genuinely generic infrastructure. Preview (§5.8) reads
    `operand_distributions`, which the ERD (§3.2) states is
    "materialised from trades." Tighten-only/satisfiability validation
    (§5.2) doesn't need trades, but that's a small fraction of the
    module — the evaluation engine and preview are its actual point.
  - Module 08's own onboarding sequence (§5.1) is *literally*
    "Connect account → Module 01 → Import history → Module 02 → THE
    HOOK." Its dashboard state machine (§7) is defined entirely in
    terms of `trades.status`, unconfirmed trades, and close-out — all
    Module 02 concepts. §13 states this module "composes and does not
    compute" — without Module 02 there is nothing real to compose.
  - Module 02 was not actually stuck at the time of this check — Slice
    1 (schema + block derivation) had just landed clean: 611 tests
    passing, all 8 golden fixtures replaying correctly individually,
    live-DB verified, one ADR written for a real RLS-shape judgment
    call. The owner's own guidance was conditional on genuine
    difficulty, and that condition wasn't met.
  - This reasoning should be revisited if a later Module 02 slice (the
    grouping engine specifically, the highest-risk piece) genuinely
    stalls — the owner's offer to reorder remains standing, this is a
    decision for right now, not a closed door.

- 2026-08-22 — Module 02 schema + block-derivation slice. Two spec-internal
  reconciliations, both mechanical, not genuine design tensions like ADR
  0001's: (1) `blocks.account_id`/`position_snapshots.account_id` in
  Module 02 §3.1's literal DDL carry no `references trading_accounts(id)`
  at all, inconsistent with every other `account_id` column in the same
  DDL block (`fills`, `trades`, `sync_runs`, `coverage_gaps`,
  `day_closeouts` all have it) — added the FK for consistency, read as an
  omission rather than a deliberate choice (nothing in the module text
  explains a difference). (2) `arm_events.account_id` has a bare
  `references trading_accounts(id)` with no `on delete cascade`, which
  would silently block account erasure once this table has rows — added
  the cascade to match every other cascading FK in this file. Full
  per-table RLS-shape reasoning (why `fills`/`trade_events` are
  append-only-restricted, `blocks`/`trade_fills`/the sync-bookkeeping
  cluster are owner-SELECT-only, and `trades`/`arm_events`/`trade_captures`
  keep the 00-foundation §3.1 default) is in
  `docs/adr/0011-ingestion-rls-shape.md`, along with the `trade_fills.user_id`
  addition (the one table in this migration missing a `user_id` column,
  needed to avoid a join-based RLS policy per 00-foundation §3.1's own
  anti-join guidance) and the broker-confirmed-trade delete trigger's
  erasure escape hatch (a real gap found via this slice's own live-DB
  test: Postgres fires row triggers on FK-cascade deletes too, so the
  trigger would otherwise have silently blocked account erasure for any
  user with a broker-confirmed trade — 00-foundation §5.4 is explicit that
  immutability must never win against a hard-delete erasure request).

- 2026-08-21 — Closed out Module 01 stories 5.x's review findings.
  **Security (blocking):** `executeErasure`'s pending->processing
  transition was non-atomic (check-then-act), a real concurrent-
  double-execution race — fixed with `markDataRequestProcessing()`,
  a single atomic conditional `UPDATE`, proven with a live concurrency
  test. **QA (must-fix):** the delete-account screen's copy claimed
  credentials are destroyed "immediately when this is requested,"
  which is false — they're destroyed at execution, after the 7-day
  grace elapses; corrected the copy to match the actual (correct) code
  behavior. **QA (must-fix): story 5.3's restriction gap.**
  `data_requests.kind` included `'restriction'` in its schema from the
  original migration, but nothing created/read/canceled a row of that
  kind — an unwired enum value isn't a "code path" per the story's own
  acceptance criterion. Built `lib/privacy/restriction.ts`
  (`requestRestriction`/`getActiveRestriction`/`liftRestriction`),
  reusing the exact `data_requests` machinery erasure/export already
  use — no new schema or RLS needed, since RLS doesn't key on `kind`.
  **Objection — deliberately NOT built as a separate mechanism,** a
  judgment call, not an oversight: GDPR's "right to object" (Article
  21) applies to processing done on a legitimate-interest basis, and
  telemetry is the ONLY legitimate-interest-based processing this
  product currently does (Module 01 §13's own data policy: "legitimate
  interest for telemetry with opt-out" — every other lawful basis in
  that table is "contract"). Story 5.4's telemetry opt-out (already
  real, already tested) IS the objection mechanism for that processing
  — a trader can object to it and have that objection immediately
  respected, which is exactly what Article 21 requires. A second,
  parallel "submit an objection" flow with nothing distinct to object
  to would be inventing UI for a right with no current referent in
  this product, not a more complete implementation of story 5.3. This
  reasoning should be revisited if a future module (Module 05's
  analytics, e.g.) ever processes data on a legitimate-interest basis
  distinct from telemetry — at that point a real, separate objection
  target would exist and this decision should be reopened.

- 2026-08-21 — Module 01 stories 5.x (rights/privacy) built: `audit_log`/
  `data_requests`/`erasure_tombstones` (new migration), export (real JSON+CSV
  bundle by real Supabase Storage signed URL), erasure (real §4.6 flow,
  live-DB-tested end to end against a real disposable GoTrue user),
  telemetry opt-out. Two real, non-hypothetical bugs found and fixed via
  the mandatory screenshot self-check, both now regression-tested: (1)
  `createServiceRoleClient()` (`lib/supabase/service.ts`) has been broken
  for any REAL (non-mocked) call on this repo's pinned Node 20.11.0 since
  it was first introduced for `lib/auth/mfa-admin.ts` — `@supabase/supabase-js`
  unconditionally builds a `RealtimeClient` needing a native `WebSocket`
  constructor, unavailable before Node 21. Fixed with a harmless
  `realtime.transport` placeholder (this codebase never uses realtime
  channels). Silently masked until now because every prior test mocked
  this factory and no screenshot pass had exercised recovery-code
  redemption for real. (2) `pg`'s default parsers turn
  `timestamp`/`timestamptz` columns into `Date` objects, but every `Row`
  interface in this codebase types those columns `string` (matching
  PostgREST/`supabase-js`'s actual serialization) — silently dormant
  until `app/(app)/privacy/page.tsx` rendered a `data_requests.expires_at`
  value directly as JSX text, crashing React. Fixed once, globally
  (`lib/supabase/pg-type-parsers.ts`, imported for its side effect by
  every `pg.Pool`/`Client` owner in the repo), not per call site — the
  identical latent risk exists in `app/(app)/accounts/page.tsx`'s
  `last_sync_at` rendering, dormant only because no account has a
  non-null value yet. Two ADRs: `docs/adr/0009-data-requests-rls-shape.md`
  (owner SELECT + owner INSERT, no client UPDATE/DELETE — the client
  needs to create a request but must never self-write its own completion
  status) and `docs/adr/0010-erasure-explicit-delete-order.md` (explicit
  FK-safe delete list, not `on delete cascade` reliance, even though this
  schema's existing cascades WOULD reach the same end state — the real
  reasons are credential-destruction-first ordering, partial-failure
  inspectability, and needing the email address to survive through the
  tombstone/confirmation-email steps before the final purge; also
  explains why the tombstone needs its own table, decoupled from
  `data_requests`, which cascades away with the account by design).
  Confirmation email is honestly unconfigured (`lib/privacy/email-provider.ts`,
  new "Infra gaps" entry) — `executeErasure` proceeds with deletion
  regardless, per AGENTS.md's "never fake it, always flag it" and the
  product-level truth that a missing confirmation email is not a valid
  reason to retain a trader's data. Full detail in "Current task" above.
  **Not yet reviewed by retrospeq-tester/security-reviewer/qa** — flagged
  explicitly, security review mandatory (credential destruction, new RLS,
  real hard-delete erasure).

- 2026-08-21 — retrospeq-qa's pass on Module 01 stories 4.x found one
  real, if minor, correctness bug: `app/(app)/accounts/page.tsx`'s
  `StatusChip` fallback hardcoded `'Pending'` for any status it didn't
  specifically recognise. That fallback predates story 4.4's downgrade
  logic (`lib/entitlements/downgrade.ts`, committed earlier this session)
  writing a real `'plan_limited'` status — `StatusChip` was never updated
  to know about it, so a downgraded account would render as "Pending,"
  actively misleading (implies still-connecting, not downgraded).
  `downgrade.ts`'s own doc comment had claimed the fallback "degrades
  honestly," which was true when written but became false the moment a
  real caller of the unrecognised-status path existed — a reminder that
  a doc comment describing another file's behavior can go stale exactly
  when that behavior changes and nobody re-checks the comment that
  depended on it. Fixed with `humanizeStatus()`, deriving a readable
  label from the actual status string rather than a fixed guess.

- 2026-08-21 — Closed the two testing-bar gaps retrospeq-security-reviewer
  flagged on Module 01 stories 4.x (entitlements): built the missing
  `lib/supabase/__tests__/subscriptions.rls.test.ts` (18 live-DB tests,
  proving ADR 0008's RLS shape for real, including the core "cannot
  self-write plan=pro" property) and 11 new unit-test files under
  `lib/entitlements/__tests__/` (every plan × capability pair from §4.3,
  the `not_yet_checkable` fail-closed contract, `account.connect` with an
  injected fake counter, `downgrade.ts` proven both by mocked SQL-shape
  assertions and a real live-DB 3-account scenario). `lib/entitlements/`
  went from 0% to 100% line/branch/function coverage; full repo suite 424
  passing, 98.82% overall line coverage. One real finding along the way,
  not one of the two dispatched gaps: `npm run build`/`tsc --noEmit` were
  already broken on `main` (verified via `git stash` against the
  untouched tree) — `dev-tools-guard.test.ts` (from the earlier
  security-reviewer hardening fix) directly assigned `process.env.NODE_ENV`,
  which current `@types/node` types as readonly; `next build`'s
  type-check step runs `tsc` over test files too, so this was a genuine
  build break, not hypothetical. Fixed with `vi.stubEnv`/`vi.unstubAllEnvs`
  instead of direct assignment — same coverage, type-clean. Full detail in
  "Current task" above, under "Module 01 stories 4.x."

- 2026-08-21 — Module 01 stories 3.1-3.4 (account settings) built —
  editing `trading_accounts.label`/`day_rollover`/`account_kind` after
  connect, no new schema. Two things worth recording explicitly:
  (1) **Story 3.4's v1 scope boundary, spec-mandated, not an omission:**
  marking an account `account_kind = 'prop'` stores the label and shows
  "Firm rulebook features are coming soon" — no rulebook logic, no
  Module 09 code, exactly per the spec's own "in v1 this stores the label
  and surfaces 'coming soon' — it does not create a rulebook." Logged so
  a future reader doesn't mistake the absent rulebook for a gap in this
  slice.
  (2) `day_rollover` genuinely has two different literal formats already
  in live use across this repo (`'<IANA zone> HH:MM'` and
  `'HH:MM:SS UTC'` — confirmed by grepping `fixtures/golden/`,
  `lib/broker/platform-defaults.ts`, and the live-DB RLS tests before
  writing the validator), not one canonical shape as the migration
  comment's single worked example might suggest. `dayRolloverSchema`
  validates against both rather than normalizing to a third shape this
  slice would have invented on its own.
  Also: `ACCOUNT_KINDS`/`AccountKind` moved to `lib/broker/platform-defaults.ts`
  (a real `npm run build` failure, not a style choice — the settings
  form is a client component and `accounts-repository.ts` pulls in
  `import 'server-only'` + direct-`pg` at module scope, which cannot
  reach a client bundle); `accounts-repository.ts` re-exports both so no
  server call site needed to change. And a real bug caught by the
  mandatory screenshot self-check: uncontrolled `defaultValue` inputs on
  the settings form let a prior successful save's `revalidatePath` reset
  a *later, failed* submission's field back to the last-saved value,
  silently discarding what the trader had just typed alongside the
  validation error telling them to fix it — fixed with controlled state
  that only re-syncs on a confirmed successful save. Full detail on all
  of the above in "Current task" above.
  Coder pass only — retrospeq-tester/qa passes still needed; per
  AGENTS.md's security-review trigger list this slice doesn't touch
  auth/credentials/RLS/the rule engine (existing `trading_accounts` RLS
  already covers the new write path), so a full security-reviewer pass
  is likely not strictly required — flagged for the orchestrator to
  decide rather than skipped unilaterally.

- 2026-08-21 — Module 01 stories 1.4/1.5 (sessions, 2FA) built. Two
  spec-reconciliation findings, both verified directly against the
  actual `@supabase/auth-js` SDK shipped in this repo before writing any
  code, per AGENTS.md's "never fake it":
  (1) **Story 1.4's literal wording — "Device list with last-seen;
  revoke individually or all" — is only partially buildable against
  Supabase Auth's real client API, and this is now the honest, final
  shape, not a placeholder.** `GoTrueClient.d.ts`/`GoTrueAdminApi.d.ts`
  expose no method — for the current user's own sessions, not an admin
  enumerating someone else's — that returns per-device metadata (user
  agent, IP, last-seen). GoTrue's refresh-token model has no such
  surface at all; even the admin user-fetch response carries no session
  list. What IS real: `signOut({scope: 'others'})` (already used by
  `confirmPasswordReset`) and `signOut({scope: 'global'})`. Built
  exactly and only those two, presented plainly as "Sign out other
  devices" / "Sign out everywhere" — never a fabricated device list.
  This is the "device list" half of the acceptance criterion **not
  met**, and the "revoke individually or all" half **met** in the only
  form the phrase can literally take without individual devices to
  target. If a real device-list requirement matters later, it needs a
  bespoke session-tracking scheme this project would have to build and
  maintain itself (recording user-agent/IP per refresh-token issuance
  somewhere) — not something Supabase Auth will ever surface, tracked
  as a possible future addition, not a current gap to chase further.
  (2) **Story 1.5's "recovery codes issued once" is met, but by
  Retrospeq's own system, not a Supabase Auth feature** — `auth-js` has
  no recovery-code concept anywhere (confirmed via a full-package
  `grep -rn "recovery"`, turning up only unrelated password-recovery OTP
  types). Built a real one: `retrospeq.mfa_recovery_codes` +
  `lib/auth/mfa-recovery-codes.ts`/`mfa-recovery-repository.ts`, and
  since `mfa.unenroll()` itself requires an aal2 session (unreachable by
  definition for a trader who lost their authenticator), redemption uses
  the GoTrue ADMIN api's `auth.admin.mfa.deleteFactor` instead — full
  reasoning in `docs/adr/0007-mfa-recovery-codes-own-system.md`. The
  rest of story 1.5 (TOTP enroll/challenge/verify/unenroll, the sign-in
  step-up via `getAuthenticatorAssuranceLevel()`) is met against
  Supabase Auth's real, documented API, no gap.
  A third, smaller finding caught by the mandatory screenshot
  self-check, not a code read: `enroll()`'s own doc comment says to
  prepend `data:image/svg+xml;utf-8,` to `totp.qr_code`, but this
  project's actual Supabase Auth response already includes that prefix
  — trusting the doc comment literally produced a broken (blank)
  QR-code image. Fixed with a defensive normalizer
  (`toQrCodeDataUri()`) that never double-prefixes.
  Coder pass only — retrospeq-tester/retrospeq-security-reviewer/qa
  passes still needed (security review is mandatory here) before this
  slice can be marked done.

- 2026-08-20 — Module 01 stories 2.x UI/Server-Action layer built
  (connect screen, account list, `connectAccount`/`disconnectAccount`
  Server Actions) on top of the prior slice's backend foundation. Two
  real findings, both fixed same-session:
  (1) **Architectural, extends ADR 0005:** a live probe confirmed
  PostgREST's `retrospeq`-schema exposure gap (ADR 0002/0003) also blocks
  `trading_accounts`, not just `account_credentials` — `.from()` calls
  through *both* `lib/supabase/server.ts` and `lib/supabase/service.ts`
  would 404/406 against any table in this schema today. Resolved with
  `lib/supabase/direct.ts` (direct-`pg`, `SET LOCAL ROLE` role-switching
  mirroring what PostgREST does internally) — `docs/adr/0006-account-
  writes-direct-postgres.md` records the full reasoning. Satisfies ADR
  0005's security intent (service-role bypass only for credentials,
  application-layer ownership checks) without literally using the
  supabase-js service-role client, since that client can't reach this
  schema at all right now.
  (2) **Real bug, caught by the mandatory screenshot self-check, not a
  code read:** `createKmsMasterKeyProvider()` was called eagerly as a
  call argument to `connectTradingAccount(...)`, so its unconditional
  "no KMS yet" throw fired *before* the adapter's own auth/read-only
  check ever ran — masking the mandatory `CONNECT_CREDENTIAL_TOO_PERMISSIVE`
  rejection (and every other adapter-level outcome) behind a generic KMS
  error for every credentialed connect attempt. A screenshot of
  submitting a "...master-password" credential showed the wrong message,
  which is what surfaced it. Fixed with a lazy provider wrapper deferring
  the throw to first actual use (step 6, after steps 3-4 already
  succeeded); a regression test now asserts a master credential is
  rejected correctly even with an always-throwing KMS provider. This is
  exactly the kind of "wait, that's wrong" AGENTS.md's screenshot-check
  requirement exists to catch that a code read alone would have missed —
  the code looked correct on inspection; only watching the actual
  rendered rejection alert (or its absence) revealed the bug.
  Net effect, honestly stated: manual accounts connect end-to-end today;
  every credentialed platform correctly fails at the encryption step
  with a named, non-retryable error until a real external KMS exists
  (standing infra gap, `docs/runbook.md`'s new entry) — not a regression,
  the correct behavior for a missing dependency per AGENTS.md.
  Coder pass only — retrospeq-tester/security-reviewer/qa passes still
  needed before this slice (or Module 01 stories 2.x as a whole) can be
  marked done.

- 2026-08-20 — Module 01 stories 2.x backend foundation built
  (`trading_accounts`/`account_credentials` migration,
  `lib/broker/{adapter,fixture-adapter,envelope-encryption,connect}.ts`).
  One real architectural finding surfaced while writing the live-DB RLS
  tests, not a hypothetical: a table with INSERT+DELETE RLS policies but
  no SELECT policy (Module 01 §3.3's literal spec for
  `account_credentials`) cannot support a WHERE-qualified UPDATE/DELETE
  under `authenticated` at all — verified against the live project
  (Postgres 17.6) and reproduced on an isolated scratch table to rule out
  anything specific to this table. Resolution, recorded in
  `docs/adr/0005-account-credentials-writes-via-service-role.md`: keep
  the RLS policies exactly as spec'd (still a real backstop, and
  cross-user isolation is unaffected), but the actual connect/disconnect
  write path (next slice's Server Action) must use the service-role
  client with application-layer ownership checks, matching 00-foundation
  §3.2's existing service-role guidance rather than a new pattern.

  **Follow-up (same day, orchestrator):** retrospeq-security-reviewer
  reviewed this slice and returned one FAIL — `connectTradingAccountInputSchema`
  used plain `z.object()`, silently stripping unrecognised keys instead
  of rejecting them per 00-foundation §4.2's "reject unknown keys."
  Fixed with `z.strictObject()` + a regression test; re-reviewed PASS.
  retrospeq-qa then reviewed and also PASSed, with one forward-looking
  note (not a blocking fix): story 2.3's crypto-specific rejection
  reason isn't representable in the current broker-generic error
  taxonomy yet — tracked for whichever future slice builds a real
  crypto-exchange adapter, not a gap in this slice as scoped. Module 01
  stories 2.x backend foundation is now genuinely done (schema + `lib/broker/`
  only — no UI, no Server Action DB write yet, both are the next slice).

- 2026-08-20 — Removed `module-docs-github/` (the old superseded LuceEdge
  spec) from the repo, owner request ("confusing to have it sitting
  there"). Before removing, verified its actual provenance rather than
  assuming: it is a byte-for-byte match of `lucedge/module-docs`'
  `main` branch on GitHub. Also cloned that repo's `retrospeq-v1`
  branch and diffed it against `retrospeq-design-system/modules/`
  (the already-documented source of truth) — every module file,
  `analytics-registry.md`, both briefs, and the flow-diagram SVG are
  byte-identical; the only difference anywhere is the design-decisions
  doc's title line ("Decision OS" upstream vs. "Retrospeq" locally,
  the local copy already having the correct current product name).
  Net effect: confirms the build has been reading the correct spec all
  along — this was a cleanup of confusing dead weight, not a
  correction of a real misconfiguration. `AGENTS.md`'s "Source of
  truth" section updated to point at the GitHub repo/branch instead of
  a local folder for anyone who needs the old spec for historical
  reference.

- 2026-08-20 — Process correction, mid-session: the orchestrator had
  been dispatching retrospeq-tester/retrospeq-security-reviewer as
  background agents while reviewing one slice before starting the next
  — but with no tool to poll a background agent's status, this produced
  an "exit and wait to be resumed" loop that cost turns without
  advancing anything. **Fix, now the standing convention:** dispatch
  retrospeq-coder/tester/security-reviewer/qa/docs synchronously
  (foreground) when the very next step depends on their result, which
  it almost always does for a single slice being reviewed before the
  next one starts — background dispatch is only for genuine parallel
  work happening alongside something else in the same turn, which
  reviewing-before-proceeding never is. Applied for the rest of this
  session and going forward.

- 2026-08-20 — Module 01 slice 1 (auth: stories 1.1-1.3) finished and
  committed after resuming a previous run that was killed mid-slice.
  Reviewed the interrupted coder's uncommitted work on its merits
  (per orchestrator instructions: don't discard working code just
  because it was interrupted) and judged it sound — well-documented,
  spec-aligned, its `profiles` migration already verified applied to
  the live shared dev DB. Dispatched retrospeq-tester and
  retrospeq-security-reviewer to finish it properly rather than mark it
  done on the strength of a read-through alone. Two real findings came
  out of that, both fixed and re-verified this session:
  (1) **retrospeq-security-reviewer FAIL, blocking:** zero rate limiting
  existed on any auth endpoint, violating Module 01 §7.2's mandatory
  "throttle per user and per IP." Fixed with `lib/rate-limit/` — a
  direct-Postgres (not supabase-js — the `retrospeq` schema isn't yet
  in the project's "Exposed schemas" dashboard setting, so `.rpc()`
  would 404; ADR 0003) fixed-window counter, fails loudly on missing
  config, fails open on unexpected DB errors (ADR 0004's documented
  tradeoff — an auth outage from the limiter's own infra would be worse
  than a brief throttling gap, and Supabase Auth's own server-side
  limits remain as a backstop regardless). Re-reviewed: PASS.
  (2) **retrospeq-qa findings, non-blocking but fixed anyway:** two
  deliberate architectural deviations (direct-pg, fail-open) had no ADR
  — written (0003, 0004). `confirmPasswordReset`'s claim that "all
  sessions invalidated on reset" happens automatically via `updateUser`
  was an unverified assumption about vendor behavior — replaced with an
  explicit `signOut({ scope: 'others' })` call and a test proving it
  fires in the right order and doesn't block the redirect on its own
  failure.
  Separately (not a slice-blocking issue, logged in
  `NEEDS_YOUR_INPUT.md`): the shared dev Supabase project's
  transactional email sending is genuinely broken
  (`500 unexpected_failure`), confirmed independently twice hours apart
  — blocks 3 of 5 E2E tests from completing their "check your email"
  step, but not the underlying code (100%-covered by unit tests
  including that exact failure path) and not something an agent can fix
  (dashboard-only setting). Also fixed two pre-existing test bugs found
  along the way (a Playwright locator too broad, matching Next.js's own
  route-announcer div; a module-identity mismatch between a statically-
  and dynamically-imported error class after `vi.resetModules()`) and
  closed out Phase 0's one remaining loose end (`shadow_runs`'s RLS was
  "written but unverified" — the `profiles`-table forward dependency
  that blocked it is gone, so it now runs for real, un-skipped).
  Installed Playwright's Chromium to `E:\playwright-browsers` instead of
  the default C: path — this machine's C: drive has ~0 bytes free (same
  constraint as the existing npm cache/tmp redirect); gitignored, not
  committed. Moved `pg` from `devDependencies` to `dependencies` (it's
  now real runtime code via the rate limiter, not just test tooling).
  Widened `.gitignore`'s `tmp/dev-screenshots`-only entry to all of
  `/tmp/` (scratch verification scripts belong there too, never
  committed) and added `/playwright-browsers`.

- 2026-08-20 — Added a 6th subagent, `retrospeq-docs`, and a
  screenshot-based UI self-verification convention, both owner-directed
  in-session (not something an autonomous run decided on its own).
  **`retrospeq-docs`** maintains `docs/DEVELOPMENT.md`, a new
  human-readable "start here" developer reference — synthesized from
  `PROGRESS.md`/ADRs/runbook, not a duplicate of any of them — dispatched
  by the orchestrator at phase boundaries (step 5), same cadence as the
  `/code-review` pass. This explicitly reverses part of the 2026-08-19
  "5 roles, not more" decision (see that entry below); the reversal is
  fine on its own terms — that decision was scoped to "don't split one
  slice across layers," and a cross-repo synthesized reference is a
  different shape of work than a per-slice ADR, not a re-litigation of
  the original reasoning. Full updated rationale in `AGENTS.md` →
  "Subagents". Seeded `docs/DEVELOPMENT.md` with an initial skeleton
  reflecting actual repo state at time of writing (Phase 0 complete,
  Phase 1 not started) rather than leaving it empty for the agent's
  first real dispatch. **Screenshot-based UI verification**: this
  environment has no interactive browser tool, so `retrospeq-coder`
  (self-check before handoff), `retrospeq-tester` (E2E state capture),
  and `retrospeq-qa` (design-system appearance checks) now all use
  headless `npx playwright screenshot` (or an inline
  `page.screenshot()` for flows needing interaction first) against the
  local dev server, saved to gitignored `tmp/dev-screenshots/`, then
  `Read` back to actually view — this is a supplement to functional
  Playwright assertions, not a replacement. No module has shipped a UI
  yet, so this is process infrastructure ahead of need, same pattern as
  the Phase 0 shadow harness.
- 2026-08-20 — Widened `.claude/settings.json`'s permission allowlist
  (`Write`, `Edit`, `Agent`, project-scoped only) at the owner's
  explicit request, so autonomous slices don't stall on a permission
  prompt for every file write/subagent dispatch — extends the same
  intent as the existing git/npm allowlist and the autonomy policy
  above, not a new grant of authority beyond what was already approved
  for commits/pushes.

- 2026-08-20 — Adopted the existing LuceEdge Supabase project for Retrospeq dev/test use (owner offer), isolated via a dedicated `retrospeq` Postgres schema rather than `public` — a real `public.data_requests` name collision with LuceEdge's own table made schema separation necessary, not just cautious. Full reasoning in `docs/adr/0002-shared-dev-supabase-project.md`. The shadow-harness migration and its repository code were updated to be schema-qualified (`retrospeq.shadow_runs`, `db: { schema: 'retrospeq' }`); all 27 existing tests still pass. This does not close the standing need for a dedicated production Supabase project (00-foundation §1.1) — see reworded Infra gaps entry.
- 2026-08-20 — Documented a kill-switch convention in AGENTS.md ("Stopping everything") after a real instance where fully stopping the local loop + a background agent took several back-and-forth exchanges. New rule: any stop signal from the owner triggers stopping the loop, all in-flight background agents, and the cloud routine (if enabled) immediately, in that order, without asking first — clarifying questions come after, not before, stopping.
- 2026-08-20 — Copied LuceEdge's broker/MT5/cTrader code, Docker bridge, investigation docs, and existing DB schema into `reference/lucedge-broker-prior-art/` as a one-time snapshot, ahead of the owner moving to a retrospeq-app-only workspace where `E:\LuceEdge` won't be reachable anymore. Explicitly reference-only — see that folder's own README for why none of it meets Retrospeq's security bar as-is. LuceEdge's live app, `.env.local`, and DB migrations were left untouched (owner confirmed LuceEdge should keep working, not be retired).
- 2026-08-20 — Owner supplied `SUPABASE_DB_URL` (direct Postgres connection). Verified against the live project: connection succeeds; `20260819010000_init_schema.sql` (the `retrospeq` schema itself) applies cleanly, confirmed via `information_schema.tables`/`.routines`. `20260819020000_shadow_harness.sql` correctly fails with `42P01 relation "retrospeq.profiles" does not exist` — this is the migration's own documented forward dependency on Module 01 firing exactly as expected, not a bug. Confirmed the failure left no partial state (Postgres applies a multi-statement migration file as one atomic block via the simple query protocol — the `uuid_generate_v7()` function and `pgcrypto` extension, which precede the failing `create table` in the file, were rolled back along with it). `shadow_runs`'s RLS policy therefore still cannot be verified against a live table — that table doesn't exist in this database yet and won't until Module 01's `profiles` migration runs first. This is now a precise, verified blocker (not a hypothetical one) on real Phase 0 completion of the shadow harness's live-DB verification — tracked, not going to be worked around by inventing a stub `profiles` table, since that would mean starting Module 01 work, which is explicitly on hold.

- 2026-08-19 — New Next.js app scaffolded at `E:\LuceEdge\retrospeq-app` as its own git repo, separate from the existing `E:\LuceEdge` LuceEdge codebase — Retrospeq is a distinct product per its own spec (Strategy/Rulebook/Field-registry architecture), not a reskin of LuceEdge's trade-journal spec. Owner-confirmed.
- 2026-08-19 — Existing LuceEdge auth/broker code is not being copied wholesale. Auth pattern (Supabase Auth, RLS-owner-policy, `data_requests` erasure flow) is reusable groundwork; broker integration (cTrader OAuth + MT5/Wine bridge) needs to be rebuilt behind a `BrokerAdapter` interface with real envelope encryption (KMS-wrapped per-credential keys) and the mandatory benign-trade-operation read-only verification, none of which the old code has.
- 2026-08-19 — npm cache/tmp redirected to `E:/npm-cache` and `E:/npm-tmp` because the C: drive is at 0 bytes free. Do not revert this without confirming C: has space again — installs will fail with ENOSPC otherwise.
- 2026-08-19 — Considered expanding the agent roster to a 17-role pipeline (separate Requirements/Architecture/Frontend/Backend/Database/Integration/Code-Review/Performance/Bug-Fix/Documentation agents). Rejected: kept the 5-agent roster (orchestrator/coder/tester/security-reviewer/qa) and instead folded the real gaps into existing agents — a repo-reuse-check step in `retrospeq-coder`, a documentation checklist (ADRs + runbook, per 00-foundation §12) and a performance-budget checklist (00-foundation §8.1) in `retrospeq-qa`, and pointing the orchestrator at the built-in `/code-review`/`simplify` skills instead of a bespoke review agent. Owner-confirmed: optimize for bug-free/scalable outcomes over role-count, keep documentation non-optional. Full reasoning in `C:\Users\hp\.claude\plans\orchestrator-agent-requirements-agent-cheerful-pizza.md`.
- 2026-08-19 — Built the Phase 0 golden fixture library (8 fixtures, `fixtures/golden/`) per 00-foundation §9.3 / Module 02 §7.1. Fixtures-only per this task's scope — the Module 05 shadow harness and the grouping engine remain unbuilt; see "Current task" above. Repo-checked first: nothing under `fixtures/` or `docs/adr/` existed from any prior partial run. Modeling decisions made explicit in `fixtures/README.md` (not repeated here in full): `input.json` mirrors `BrokerAdapter.fetchHistory` output plus minimal account context, excluding write-time-only fields (`id`, `server_day`, `imported_at`) per Module 02 §2.1/§2.2/§3.1; `expected.json` uses stable symbolic refs (`block_ref`/`trade_ref`) instead of literal UUIDs since UUIDv7 is insertion-time-derived and non-deterministic; `contract_value = 1` money-math simplification (no lot/contract-size table, out of scope per Module 02 §10); `server_day` arithmetic stated explicitly as `date(filled_at)` for `00:00:00 UTC` rollover and `date(filled_at − 22h) + 1 day` for `22:00:00 UTC` rollover (00-foundation states the policy, not the arithmetic); `scale_out_count = count(trade_fills.role in ('trim','exit'))`, reproducing Module 02 §7.1's only worked example; `trades.server_day = server_day(opened_at)`, fixed at open (blocks table says this explicitly, trades table doesn't but consistency is the obvious read — demonstrated directly in `overnight_weekend` and `swing_with_intraday`). Every expected value (pnl, outcome, `server_day`, `hold_seconds`, `risk_pct`/`initial_risk_pct`/`r_multiple`, `scale_out_count`) was cross-checked by an independent verification script against the formulas in Module 02 §4.4 before commit, not just hand-computed once.
- 2026-08-19 — Resolved a genuine spec tension found while building `flip_no_flat`: Module 02 §4.2 says a zero-crossing fill is "split across both blocks proportionally," but §3.1's `trade_fills_fill_unique` index requires every fill map to exactly one trade — both can't be literally true of one physical fill. Resolution: the physical fill gets exactly one `trade_fills` row (on the closing trade, `role = 'exit'`); the opening trade gets a `trade_events` row of `kind = 'entry'` referencing the same `fill_id` with the split volume (`trade_events` has no fill-uniqueness constraint). Full reasoning, rejected alternatives, and consequences (including a documented gotcha for the eventual grouping-engine implementation: the "expandable fill list" must union `trade_fills` + `trade_events` for flip-originated trades) recorded in `docs/adr/0001-flip-fill-split-via-trade-events.md`, per AGENTS.md's "Documentation" section (deliberate deviation from a 00-foundation convention → ADR, not just a decision-log line).
- 2026-08-19 — Built the Module 05 shadow harness (see "Current task" above), scoped to the harness's own infrastructure only. **Scope boundary decision:** Module 05 §3.1 defines `shadow_runs` alongside `findings`/`detections`/`analytic_renders`/`finding_rule_links` in one code block, but the latter four belong to the edge engine and detection engine (§4.2/§4.4), which read confirmed trades from Module 02 — a module that doesn't exist in this repo (no grouping engine, no `trades` table; only the golden fixtures modeling its eventual output exist). Built only `shadow_runs` plus a generic `ShadowAnalytic<TFact>` runner/promotion-eligibility layer that is deliberately agnostic to *how* an analytic computes `would_render`/`gate_failures` — that's the analytic's own gating logic (statistical gates, detection gates, or a bespoke check), not the harness's job. Did **not** implement the statistical gates (§4.3), the edge engine, the detection engine, or the `spec.weekday` canary (§4.10) itself — all of them need real confirmed trades to be meaningful, and building them against nothing would mean inventing a fake grouping engine, which AGENTS.md explicitly forbids ("without inventing a fake grouping engine to unblock yourself"). The harness is tested with synthetic stand-in analytics (`lib/analytics/shadow-harness/__tests__/fixtures.ts`) instead — the same way a job-queue library is tested with dummy jobs, not real ones. `eligible-trade.ts` is the one exception: Module 05 §4.1's population filter (`status='confirmed' AND not_a_decision=false AND closed_at is not null`) is fully specified in prose over fields Module 02's spec already documents exactly, so encoding it as a pure predicate (not an engine) is safe and directly useful once real trades exist. Real shadow-analytic registrations, starting with `spec.weekday`, wait on Module 02 (Phase 1) and Module 05's own edge engine (Phase 3).
- 2026-08-19 — `shadow_runs` RLS uses 00-foundation §3.1's default owner-policy shape (`user_id = auth.uid()`, full access) rather than a service-role-only exception. Module 05 doesn't list `shadow_runs` in any RLS-exception table the way Module 01 §3.3 does for `account_credentials`/`analytic_config`, so the default applies as written; "never rendered" is a product/UI property (Module 05 §4.9), not a database-access restriction, and nothing in the spec asks for the latter. Noted in the migration as reconsiderable via a future ADR if "shadow" is later decided to mean invisible-even-via-API rather than just invisible-in-the-UI.
- 2026-08-19 — `uuid_generate_v7()` is referenced in every module's DDL (00-foundation §2.1) but never defined anywhere in the design system. Defined it in the shadow harness migration (the first migration in this repo that needs it) as a plpgsql function following RFC 9562 §5.7's UUIDv7 byte layout, using `create or replace` so a later Module 01/02 migration that also declares it is a no-op rather than a conflict. Not a foundation deviation — an implementation of an assumed-to-exist primitive — so documented inline in the migration rather than as a separate ADR, per AGENTS.md "non-obvious migration constraints get an inline comment, not a separate doc."
- 2026-08-19 — Hit a real hard incompatibility while wiring up this repo's first tests: `vitest@4.1.11` (already a devDependency from initial scaffolding) pulls in a rolldown-based Vite whose startup requires `node:util`'s `styleText` export, added in Node 20.12 — this repo runs Node 20.11.0 (see "Infra gaps"). This is exactly the "hard incompatibility" the existing infra-gap line said to revisit on. Fix: pinned `vitest` and `@vitest/coverage-v8` to `3.2.7` (last major before the rolldown-based Vite chain; depends on `vite@^5||^6||^7`, all classic esbuild-based). Chose a devDependency downgrade over a Node upgrade because the Node install is machine-wide and shared with unrelated projects (the parent `E:\LuceEdge` repo, `Pesa Hi Pesa`) — changing it is a bigger, riskier action than pinning one package in this repo, and isn't necessary to unblock this task. All 27 shadow-harness tests pass under `vitest@3.2.7`; `npm run build` and `npm run lint` both still pass.

## Autonomous continuation — cost/cadence policy (owner decision 2026-08-20)

**Local `/loop` only. No cloud routine.** The cloud scheduled routine
(`trig_01NV6fHZShY1bPQindEH7dc2`) stays paused — the owner explicitly
doesn't want to rely on it, since they'll check progress in person
rather than needing unattended cloud continuation.

**Policy: run hard until usage is exhausted, then stop; resume only
when the owner explicitly says so.** Concretely:

- While a local `/loop` session is open, self-pace wake-ups based on
  real work completed (not a fixed clock) and keep dispatching the
  next task in build order continuously.
- There is no way to detect "about to run out of usage" in advance —
  no API for it. The expected failure mode is simply: a cycle stops
  producing commits, and the loop goes quiet. That is normal, not a
  bug to engineer around.
- **Do not build any "graceful exhaustion detection" behavior.** It
  isn't achievable and isn't needed — the owner's own policy is to
  check in periodically and see whether it's still running.
- **Never auto-resume.** A stopped loop stays stopped until the owner
  says `/loop` again (or "continue") — this is a deliberate consequence
  of not using the cloud routine, not a gap to fix.
- This means real progress only happens while the owner is actively
  checking in and re-triggering it, not around the clock. That's the
  accepted tradeoff for not paying for/relying on the cloud routine.
