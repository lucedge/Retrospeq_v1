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
| 1 | Module 01 (Identity & Accounts) + Module 02 (Trade Ingestion & Model) | **In progress.** Module 01 slice 1 done (stories 1.1-1.3: email/Google signup, sign-in, sign-out, password reset, `profiles` table + trigger, mandatory per-endpoint rate limiting). Module 01 stories 1.4-1.5 (sessions, 2FA), 2.x (account connection/`BrokerAdapter`), 3.x (settings), 4.x (entitlements), 5.x (rights/privacy) and all of Module 02 remain — see "Current task" |
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

**Not done yet, not blocked, straightforward continuation:** Module 01
stories 1.4 (session list/revoke) and 1.5 (2FA/TOTP), stories 2.x
(trading-account connection, `BrokerAdapter` interface, envelope
encryption, `account_credentials`), 3.x (account settings), 4.x
(entitlements/`subscriptions`/`analytic_config`), 5.x (rights/privacy —
export/erasure/`audit_log`/`data_requests`) — then all of Module 02
(Trade Ingestion & Model, the largest/highest-risk module in v1: fills,
blocks, the grouping engine, trade events, confirmation freeze).

**Next slice:** Module 01 stories 2.x — `trading_accounts` +
`account_credentials` schema/RLS, the `BrokerAdapter` TS interface
(00-foundation §10.1, vendor-agnostic, no real vendor selected — build
against the interface + a test/fixture adapter, not a real broker), and
the connect flow including the mandatory read-only verification step.
Envelope encryption (AES-256-GCM per-credential key wrapped by an
external KMS master key) is buildable in interface/logic form now but
has no real KMS account yet (infra gap) — build it to fail loudly
without one, don't stub a fake master key.

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
- [ ] No git remote for this repo. Parent repo's remote (`origin` → `lucedge_v1.git`) is a different product; do not push this project there. Owner needs to create a new GitHub repo and add it as `origin` here.
- [ ] Broker integration vendor undecided (00-foundation §10). Build against `BrokerAdapter` only; do not let a vendor type leak past the adapter.
- [ ] Node version is 20.11.0; several deps warn they want >=22 (`@supabase/*@2.112.3`, `eslint-visitor-keys@5`). Still warn-only for those. **One hard incompatibility already hit and fixed**: vitest 4.x pulls in a rolldown-based Vite that requires `node:util`'s `styleText` (Node ≥20.12) — pinned `vitest`/`@vitest/coverage-v8` to `3.2.7` instead (classic esbuild-based Vite, no rolldown), see decision log. Revisit the pin when Node is upgraded past 20.11.

## Decision log

Format: `YYYY-MM-DD — decision — why — spec/section it reconciles`

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
