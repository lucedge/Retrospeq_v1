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
| 1 | Module 01 (Identity & Accounts) + Module 02 (Trade Ingestion & Model) | **In progress.** Module 01 slice 1 done (stories 1.1-1.3). Stories 2.x (account connection) fully built — schema, `lib/broker/`, and now the connect/account-list UI + Server Actions — coder pass complete, tester/security-reviewer/qa passes pending. Module 01 stories 1.4-1.5 (sessions, 2FA), 3.x (settings), 4.x (entitlements), 5.x (rights/privacy) and all of Module 02 remain — see "Current task" |
| 2 | Module 04 (Rulebook & Evaluation) + Module 08 onboarding | Not started |
| 3 | Module 03 (Field Registry & Strategy) + Module 05 (Analytics & Findings) | Not started |
| 4 | Module 06 (Review & Graduation) + Module 07 (Engagement) | Not started |
| v1.1 | Module 09 (Prop firm rulebooks) + Module 10 (AI layer) | Deferred |

## Current task

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

**Still not done, not blocked, straightforward continuation:** Module 01
stories 4.x (entitlements/`subscriptions`/`analytic_config`), 5.x
(rights/privacy — export/erasure/`audit_log`/`data_requests`) — then all
of Module 02 (Trade Ingestion & Model, the largest/highest-risk module in
v1: fills, blocks, the grouping engine, trade events, confirmation
freeze).

**Next slice:** Module 01 stories 4.x (plan/entitlement resolution —
`subscriptions`, `analytic_config`, the `can(user, capability)` check
per §4.3's table), then 5.x (rights/privacy — export, erasure,
`audit_log`, `data_requests`), then all of Module 02.

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
- [ ] Node version is 20.11.0; several deps warn they want >=22 (`@supabase/*@2.112.3`, `eslint-visitor-keys@5`). Still warn-only for those. **One hard incompatibility already hit and fixed**: vitest 4.x pulls in a rolldown-based Vite that requires `node:util`'s `styleText` (Node ≥20.12) — pinned `vitest`/`@vitest/coverage-v8` to `3.2.7` instead (classic esbuild-based Vite, no rolldown), see decision log. Revisit the pin when Node is upgraded past 20.11.

## Decision log

Format: `YYYY-MM-DD — decision — why — spec/section it reconciles`

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
