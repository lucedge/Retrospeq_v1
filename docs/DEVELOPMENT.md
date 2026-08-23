# Retrospeq — developer guide

The single human-readable "start here" reference for working on this
codebase. Maintained by the `retrospeq-docs` subagent, refreshed at
phase boundaries (see `PROGRESS.md` → Phase status) or on request.

This file is a **synthesis**, not a duplicate. It points at the
authoritative source for anything that already has one instead of
copying it:

| Question | Answer lives in |
|---|---|
| What's done, what's next, what's blocked right now | `PROGRESS.md` |
| Does anything need the owner right now | `NEEDS_YOUR_INPUT.md` |
| Why was a spec convention deviated from | `docs/adr/NNNN-*.md` |
| What alerting/error conditions exist and what to do about them | `docs/runbook.md` |
| Product spec / non-negotiables / design system | `AGENTS.md` + `retrospeq-design-system/modules/` |

This file is for everything else a developer (human or agent) needs
to get productive: how to run the thing, how the pieces fit together,
how to test it, and the non-obvious gotchas that aren't a deviation
worth an ADR but would waste your time to rediscover.

## Where the build actually is

As of Phase 1's close (2026-08-23): **Module 01 (Identity & Accounts)
and Module 02 (Trade Ingestion & Model) are both fully built** — coded,
tested, security-reviewed, QA-reviewed, and a phase-boundary `simplify`
pass has run over Module 02's code. Phase 0 (golden fixture library +
shadow harness) is also complete. Modules 03-10 have not been started.
This is prose for orientation only — `PROGRESS.md`'s "Phase status"
table is the actual source of truth and moves faster than this file
does; check it, don't assume this paragraph is current by the time you
read it.

## Architecture overview

### Module 01 — Identity & Accounts (`lib/auth/`, `lib/broker/`,
`lib/entitlements/`, `lib/privacy/`, `app/(auth)/`, `app/(app)/{accounts,security,plan,privacy}/`)

- **Auth**: email/password and Google OAuth sign-up/sign-in, password
  reset, session listing + revocation ("sign out everywhere"), 2FA via
  TOTP. Supabase Auth handles the credential/session mechanics;
  `lib/auth/errors.ts` maps its error surface to Retrospeq's own typed
  error codes so the UI never has to branch on a raw Supabase message.
- **Recovery codes are Retrospeq's own system, not Supabase's** —
  Supabase's MFA API has no concept of them at all. See
  `docs/adr/0007-mfa-recovery-codes-own-system.md`.
- **Broker accounts**: `lib/broker/adapter.ts` defines the
  `BrokerAdapter` interface (00-foundation §10.1) that every vendor
  integration must implement — `connect()`, the mandatory read-only
  verification, `capabilities()`. `lib/broker/fixture-adapter.ts` is the
  only implementation that exists today (deterministic, test-only,
  `behavior` is a required config field so a caller must explicitly
  choose which scenario — auth failure, credential-too-permissive,
  vendor unavailable, etc. — it's exercising). **No real MT4/MT5/
  cTrader/Binance/Bybit adapter exists yet** — vendor is undecided
  (00-foundation §10), and nothing downstream may see a vendor-specific
  type past this interface.
- **Credential encryption**: `lib/broker/envelope-encryption.ts` —
  per-credential AES-256-GCM data key, wrapped by an external KMS master
  key (never a static app-wide key). `createKmsMasterKeyProvider()`
  throws `KmsNotConfiguredError` unconditionally today — **no real KMS
  vendor is wired up**, so every credentialed connect/sync attempt fails
  loudly by design rather than faking success (see
  `docs/runbook.md` → "Every credentialed connect attempt fails because
  KMS isn't configured"). Only `manual` (no-credential) accounts work
  end-to-end right now.
- **Entitlements**: `lib/entitlements/` resolves plan/subscription →
  capability. `subscriptions` is read-only to the owner at the RLS
  layer; every write goes through the service role
  (`docs/adr/0008-subscriptions-read-only-rls.md`).
- **Privacy/GDPR**: `lib/privacy/` — export, erasure, restriction.
  Erasure deletes explicitly, table by table, in FK-safe order rather
  than relying on `on delete cascade`
  (`docs/adr/0010-erasure-explicit-delete-order.md`). No transactional
  email provider is configured — `lib/privacy/email-provider.ts` throws
  `EmailProviderNotConfiguredError` rather than faking a send; erasure's
  confirmation email is best-effort and never gates the actual deletion.

### Module 02 — Trade Ingestion & Model (`lib/ingestion/`, `app/(app)/trades/`)

The pipeline, in order, each stage its own file in `lib/ingestion/`:

1. **`blocks.ts`** — block derivation (§4.2): groups raw `fills` into
   contiguous same-instrument, same-account position spans using exact
   `decimal.js` arithmetic (never JS `number`) for the running-volume
   comparison to zero.
2. **`grouping.ts`** — the grouping engine (§4.3): splits a block into
   trades using a weighted signal table and the resting-baseline
   excursion algorithm, with confidence bands (`confident_single` /
   `confident_split` / `ambiguous`). **Price proximity is architecturally
   banned, not just documented** — `GROUPING_SIGNAL_WEIGHTS.price_proximity`
   is hard-coded `0` and no scorer reads `.price` at all; this is
   property-tested directly (`lib/ingestion/__tests__/grouping.property.test.ts`).
3. **`trade-facts.ts`** — derived facts (§4.4): `r_multiple`,
   `risk_pct` (peak-not-initial convention), VWAP, hold time, outcome
   band.
4. **`sync.ts`** — the sync pipeline (§4.1): orchestrates
   `BrokerAdapter` → `fills`/`blocks`/`trades` writes, records a
   `sync_runs` row per attempt (`status: 'ok' | 'partial' | 'failed'`,
   a named `SyncErrorCode`). There is **no "sync now" UI trigger yet** —
   the pipeline exists and is tested, but nothing in the UI calls it.
5. **`arm-matching.ts`** + **`trade-captures.ts`** — arm-event matching
   (§4.5) and the pre-entry capture lock (§4.7's "never editable after
   lock" rule, enforced by a real DB trigger — RLS alone can't express
   "forbid write after a related timestamp is set").
6. **`confirm.ts`** — the confirm/freeze transaction (§4.6), the
   "critical transaction" per the module spec: freezes a day's trades
   atomically, including a 7-day auto-confirm sweep
   (`autoConfirmStaleTrades`). Rule evaluations and grouping freeze here
   permanently — never recomputed retroactively (a project
   non-negotiable, see `AGENTS.md`).
7. **`corrections.ts`** / **`split-join.ts`** — post-freeze corrections
   (§4.7): the `not_a_decision` toggle, manual split, manual join, and
   `resolveAmbiguousGroupingAsSingle` (a third correction operation
   added specifically to fix a design-ethics finding — see "Known
   gotchas" below).
8. **`manual-entry.ts`** — manual trade entry (§4.8) for accounts with
   no broker credential.

UI: `app/(app)/trades/page.tsx` (trade list), `close-out/page.tsx` (the
close-out/confirm-day screen), `manual-entry/page.tsx`, plus
`SplitControl.tsx`/`JoinControl.tsx`/`NotADecisionToggle.tsx` for the
corrections flow.

**Schema**: 11 tables (`fills`, `blocks`, `trades`, `trade_fills`,
`trade_events`, `arm_events`, `trade_captures`, `sync_runs`,
`coverage_gaps`, `day_closeouts`, `position_snapshots`), **three
different RLS shapes** chosen per-table by re-reading each table's own
spec DDL comment rather than applying one default uniformly — see
`docs/adr/0011-ingestion-rls-shape.md` for the full reasoning
(append-only vs. derived/never-user-editable vs. genuinely
user-driven).

### Direct Postgres access — why `.from()`/`.rpc()` don't work here

Every `retrospeq`-schema table (both modules) is written and read via a
**direct Postgres connection** (`lib/supabase/direct.ts`,
`SUPABASE_DB_URL`), not `@supabase/supabase-js`'s `.from()`/`.rpc()`
calls. Reason, live-probed and confirmed (not assumed): PostgREST — the
layer every supabase-js client call goes through, RLS-scoped or
service-role alike — only serves schemas listed in the project's
"Exposed schemas" dashboard setting, and `retrospeq` is not currently in
that list. `retrospeq.<table>` queries 404/406 through supabase-js
regardless of which client or role you use.

Two entry points reproduce the exact role PostgREST would otherwise
switch into:

- `withUserConnection(userId, fn)` — `SET LOCAL ROLE authenticated` +
  `request.jwt.claims`, so real RLS policies actually apply (not an
  application-trusted `WHERE user_id = $1`).
- `withServiceRoleConnection(fn)` — `SET LOCAL ROLE service_role`,
  bypasses RLS; callers must filter explicitly on ownership.

Full reasoning: `docs/adr/0006-account-writes-direct-postgres.md`
(builds on `docs/adr/0005-account-credentials-writes-via-service-role.md`
and `docs/adr/0003-rate-limiter-direct-postgres.md`, which hit the same
wall independently for `account_credentials` and the rate limiter,
respectively). If "Exposed schemas" is ever updated to include
`retrospeq`, this pattern remains valid on its own merits — migrating
back to supabase-js becomes optional, not required.

### Golden fixtures + the grouping engine

`fixtures/golden/` holds 8 fixtures (`simple_daytrades`, `scaled_in_out`,
`swing_with_intraday`, `flip_no_flat`, `partial_fills_subsecond`,
`overnight_weekend`, `multi_currency`, `gapped_history`), each with
`input.json`/`expected.json`/`README.md`. **Any change touching the
grouping engine must replay all 8** — `lib/ingestion/__tests__/golden-fixtures.test.ts`
does this today, asserting `fills[].server_day`, `blocks[]`, and full
`trades[]` output (not just blocks/fills) against `expected.json` for
every fixture (00-foundation §9.3). `flip_no_flat` in particular encodes
a real spec tension — see "Known gotchas" below.

## Running locally

```bash
npm install
npm run dev        # Next.js dev server, http://localhost:3000
```

Environment: copy `.env.local.example` to `.env.local` and fill in
Supabase URL/keys. As of 2026-08-20 these point at a **shared dev/test
Postgres schema** (`retrospeq` schema on the existing LuceEdge Supabase
project), not a dedicated project — see
[`docs/adr/0002-shared-dev-supabase-project.md`](adr/0002-shared-dev-supabase-project.md).
`SUPABASE_DB_URL` (direct Postgres connection, separate from the API
keys) is **required** — both to apply migrations/run RLS verification
and for ordinary app code, per "Direct Postgres access" above.

There is no KMS account wired up yet (`RETROSPEQ_KMS_KEY_ID` in the
example env is a placeholder) — credential-encryption code fails loudly
(`KmsNotConfiguredError`) rather than falling back to a hardcoded key.
See `AGENTS.md` → "Security bar." Every credentialed broker
connect/sync will fail until this exists; only `manual` accounts work
end-to-end.

`RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS` is an opt-in flag
(`lib/entitlements/dev-tools-guard.ts`) for a dev-only tool that flips a
test user's plan without a real billing provider — deliberately off by
default, and deliberately not gated by `NODE_ENV` alone since it writes
through the service role; leave unset unless you're actively exercising
entitlements locally.

## Repo layout

```
app/
  (auth)/                  Public auth screens: login, signup, reset-password, mfa-challenge
  (app)/                   Authenticated app shell (layout.tsx) + feature routes:
    accounts/              Connect/disconnect a broker account, per-account settings
    security/              Session list/revocation, 2FA enrollment
    plan/                  Plan/entitlements screen
    privacy/               GDPR export/erasure/restriction requests
    trades/                Trade list, close-out screen, manual entry, split/join controls
  auth/callback/           Supabase OAuth (Google) callback route
  brand-tokens/            Synced copy of the design system's CSS tokens
lib/
  auth/                    Auth Server Action support: error mapping, Zod schemas, MFA/recovery codes
  broker/                  BrokerAdapter interface + fixture adapter, envelope encryption, connect flow
  entitlements/            Plan/subscription/capability resolution (Module 01 §4.x)
  ingestion/               Module 02: blocks, grouping engine, trade facts, sync pipeline,
                            arm-event matching, pre-entry capture lock, confirm/freeze, corrections
  privacy/                 GDPR export/erasure/restriction (Module 01 §5.x)
  rate-limit/              Direct-pg fixed-window throttle, every auth/security-sensitive endpoint
  supabase/                Client factories: RLS-scoped, service-role, and direct-pg
  analytics/shadow-harness/  Phase 0's shadow-analytics infrastructure (Module 05's harness),
                            built ahead of any real analytic existing
fixtures/golden/            8 golden fixtures for the trade-grouping engine (see above)
supabase/migrations/         SQL migrations, applied in filename (timestamp) order — 16 as of
                            Phase 1's close
docs/adr/                    13 ADRs as of Phase 1 — one per deliberate deviation from a
                            00-foundation convention
docs/runbook.md               One entry per alerting condition a module's spec calls out
e2e/                          Playwright E2E specs (auth, trades)
retrospeq-design-system/      Vendored spec + design system (plain copy, no submodule -
                            re-sync manually if the upstream source changes, see AGENTS.md)
reference/lucedge-broker-prior-art/
                            Frozen snapshot of LuceEdge's broker code - reference only,
                            does not meet this project's security bar as-is, do not copy-paste
.claude/agents/               The six subagent definitions that build this repo
```

`module-docs-github/` (the old superseded LuceEdge trade-journal spec)
was removed from the repo 2026-08-20 as confusing dead weight once its
provenance was confirmed — if you need it for historical comparison,
clone `main` from `lucedge/module-docs` on GitHub rather than expecting
a local copy (`retrospeq-v1` branch of that same repo is what's vendored
at `retrospeq-design-system/`).

## The build pipeline (who does what)

Six Claude Code subagents, defined in `.claude/agents/`:

- **`retrospeq-orchestrator`** — reads `PROGRESS.md`, decides the next task, dispatches the rest, updates the ledger, commits.
- **`retrospeq-coder`** — implements one slice (schema + server logic + UI), including a screenshot-based visual self-check for any UI surface.
- **`retrospeq-tester`** — unit/property/RLS/integration/E2E/golden-fixture tests, plus screenshot capture for UI E2E flows.
- **`retrospeq-security-reviewer`** — blocking authority on credentials/RLS/injection surfaces.
- **`retrospeq-qa`** — catches product-intent drift (non-negotiables, design-system rules) that passes tests but is still wrong; screenshot-verifies rendered appearance.
- **`retrospeq-docs`** — keeps this file current, dispatched at phase boundaries.

Full role definitions and what each one checks: `.claude/agents/*.md`.
Why six and not more (or the originally-considered seventeen), and why
six and not the five the project started with: `AGENTS.md` →
"Subagents", decision log in `PROGRESS.md` (2026-08-19 and 2026-08-20
entries respectively).

## Testing

```bash
npm run test              # vitest run (unit + property-based, via fast-check)
npm run test:coverage     # same, with coverage report
npx playwright test       # E2E, headless
npm run lint               # eslint
npx tsc --noEmit           # typechecking (also covered by `npm run build`)
npm run build               # must stay green before any slice is handed off
```

Coverage bar (00-foundation §9): 90% line coverage on the grouping /
rule-evaluation / statistics engines specifically, 70% overall. RLS
cross-user isolation is asserted on 100% of tables, not sampled — live
against the real shared dev Postgres database (a genuine `SET LOCAL
ROLE` + `request.jwt.claims` role switch, not a mock), not just a
`pg_policies` metadata check.

As of Phase 1's close: **951 tests passing, 12 skip-guard fallbacks
(env-gated live-DB suites — the env is present in this repo, so these
run for real, not silently skipped), 0 failed.** `lib/` overall line
coverage was last measured at 98.48% (individual engine files run
higher — e.g. `blocks.ts` 100%, `grouping.ts` 98.61%, `trade-facts.ts`
100%). `npm run build`/`lint`/`tsc --noEmit` all clean.

**`vitest.config.ts`'s coverage `include` is `lib/**/*.ts` only** —
`app/` Server Actions/pages have real unit and E2E test coverage but
produce no percentage in the coverage report at all. Don't read a 0%/
missing figure for an `app/` file as untested; check for a
corresponding `__tests__` file or `e2e/*.spec.ts` case instead.

**Note on `vitest`**: pinned to `3.2.7` (not latest) — `vitest@4.x`
pulls in a rolldown-based Vite that needs a Node API only available
from Node 20.12, and this machine runs 20.11.0. See `PROGRESS.md`
decision log, 2026-08-19, if that pin ever needs revisiting.

### UI self-verification (screenshots)

There's no interactive browser tool available to the agents in this
environment — verification of rendered UI happens via headless
Playwright screenshots instead of live clicking:

```bash
npx playwright screenshot http://localhost:3000/<route> tmp/dev-screenshots/<name>.png
```

`tmp/dev-screenshots/` is gitignored — these are throwaway visual
checks, not build artifacts. Any agent (or you) can then view the PNG
directly to sanity-check layout, spacing, and the design-system rules
that are about rendered appearance rather than code (no red/green
color use, exactly one primary `.rq-btn` per view, ambient/gauge
indicators always visible, etc. — see `AGENTS.md` → "Non-negotiables").
For flows behind auth or with multi-step interaction, a short
Playwright script (`page.goto` → interact → `page.screenshot()`)
replaces the one-line CLI form. This does not replace Playwright E2E
*assertions* — it's a visual supplement to catch things assertions
don't, like a color, spacing, or empty-state regression that still
passes every functional check.

## What's explicitly not built yet

Don't assume any of the following exist just because their interfaces
or stubs do — they don't, and code that depends on them fails loudly
rather than faking success (per `AGENTS.md` → "never fake it"):

- **A real `BrokerAdapter` implementation.** Only the fixture/test
  adapter exists (`lib/broker/fixture-adapter.ts`). No MT4/MT5/
  cTrader/Binance/Bybit vendor has been chosen.
- **A real external KMS.** `createKmsMasterKeyProvider()` always
  throws. Every credentialed connect and sync currently fails at that
  step, by design — see `docs/runbook.md`.
- **In-place block extension across a resync boundary**
  (`BLOCK_EXTENSION_DEFERRED`) — a known, tracked, non-blocking gap. A
  trade whose block gains a late fill after derivation can still sit
  unconfirmed indefinitely; manual split/join don't reach this specific
  case (they operate on a trade's existing fill membership, not a fill
  the block-derivation pass hasn't assigned yet). See `docs/runbook.md`
  → "Trades stuck unable to confirm."
- **A "sync now" UI trigger.** `lib/ingestion/sync.ts`'s pipeline is
  built and tested; nothing in the UI calls it yet.
- **Module 03 (Field Registry & Strategy).** Several Module 02 pieces
  (the pre-entry capture chips, the trim-reason field) explicitly
  stubbed around this — expect real integration points once Module 03
  lands.
- **`coverage_gaps` resolution.** Rows are written but nothing in this
  repo ever sets `resolved_at` — a gap is currently permanent once
  recorded. Tracked in `docs/runbook.md`, not silently dropped.
- **A transactional email provider.** `lib/privacy/email-provider.ts`
  throws unconditionally; erasure's confirmation email is best-effort
  only and never gates deletion.

Standing infra gaps beyond these (Vercel project, dedicated production
Supabase project, Node version) are tracked in `PROGRESS.md` →
"Infra gaps" — check there before assuming something is a code bug.

## Known gotchas worth not rediscovering

- **The `retrospeq` schema is not PostgREST-exposed, so `.from()`/
  `.rpc()` don't work against it.** Use `lib/supabase/direct.ts`'s
  `withUserConnection`/`withServiceRoleConnection`, not
  `lib/supabase/server.ts`/`service.ts`, for any `retrospeq`-schema
  table. See "Direct Postgres access" above and
  `docs/adr/0006-account-writes-direct-postgres.md`.
- **`account_credentials` cannot support a WHERE-qualified UPDATE/DELETE
  under RLS at all**, even a syntactically-correct one matching its own
  DELETE policy — Postgres 17.6 folds the query to "One-Time Filter:
  false" for a table with INSERT+DELETE policies but no SELECT policy.
  Writes to it go through the service role, ownership checked at the
  application layer. `docs/adr/0005-account-credentials-writes-via-service-role.md`.
- **Three separate concurrency-race bugs, same root cause, found and
  fixed this phase** in `erasure.ts`, `confirm.ts`, and `split-join.ts`
  — a non-atomic check-then-act on a mutable status/timestamp column
  (read the row, check a condition in application code, then write).
  All three fixed with the same pattern: an atomic conditional `UPDATE
  ... WHERE <condition> RETURNING ...`, checking the returned row count
  rather than a separately-read value. If you're writing a new
  status-transition path, use this pattern from the start rather than
  rediscovering the race.
- **`trade_captures`' "never editable after lock" rule needed a real DB
  trigger** — RLS's row-level `USING`/`WITH CHECK` model can't express
  "forbid write after a related timestamp elsewhere is set." Same shape
  as `trades`' `forbid_broker_confirmed_trade_delete` trigger (§4.7's
  delete rules) — see `docs/adr/0011-ingestion-rls-shape.md`.
- **Price proximity is banned from the grouping engine at the
  implementation level, not just documented** —
  `GROUPING_SIGNAL_WEIGHTS.price_proximity` is hard-coded `0` in
  `lib/ingestion/grouping.ts` and no scorer reads `.price`, property-
  tested directly. Don't "fix" this if you see it — it's the
  non-negotiable working as intended.
- **A design-ethics finding drove a real third correction operation.**
  `retrospeq-qa` flagged that an equal-weight `.rq-btn--equal` pair
  ("this is one trade" / "these are separate trades") for an ambiguous
  grouping implied a recommendation by only wiring one side — fixed by
  building `resolveAmbiguousGroupingAsSingle` in
  `lib/ingestion/corrections.ts` so both sides of the pair have a real,
  equally-weighted backing operation. See the design-system rule this
  enforces: "`.rq-btn--equal` pairs have no primary/secondary
  distinction" (`AGENTS.md` → "Design system").
- **`uuid_generate_v7()`** is referenced in every module's DDL but never
  defined in the design system itself — it's defined once, in
  `supabase/migrations/20260819020000_shadow_harness.sql`, via `create
  or replace` so later migrations declaring it again are a no-op, not
  a conflict.
- **The `flip_no_flat` golden fixture encodes a real spec tension**
  between Module 02 §4.2 ("split fill proportionally across both
  blocks") and §3.1's fill-uniqueness index (one fill, one trade). See
  `docs/adr/0001-flip-fill-split-via-trade-events.md` before touching
  flip-handling logic — the resolution has a documented gotcha for the
  eventual grouping-engine implementation (the "expandable fill list"
  must union `trade_fills` + `trade_events` for flip-originated trades).
- **Some numeric conventions deliberately deviate from 00-foundation
  §2.3's decimal-fraction rule.** `risk_pct`/`initial_risk_pct` are
  stored as percentage numbers (`1.4`, not `0.014`) —
  `docs/adr/0012-risk-pct-stored-as-percentage-number.md`, because
  every golden fixture's `expected.json` already encodes them that way.
  `trading_accounts.starting_equity` is nullable with no fabricated
  default — `docs/adr/0013-trading-accounts-starting-equity-nullable.md`.
- **`C:` drive is at 0 bytes free on this dev machine.** `npx vitest
  run` and `npx playwright install` fail with `ENOSPC` on their default
  `TEMP`/`TMP`. Workaround: `TEMP="E:\tmp_vitest" TMP="E:\tmp_vitest"
  TMPDIR="E:/tmp_vitest" npx vitest run ...` (create/clean the dir per
  invocation); for Playwright, check for an already-installed
  `chromium-*` (non-`headless_shell`) directory under
  `C:\Users\...\ms-playwright` before trying to download anything new.
  See `NEEDS_YOUR_INPUT.md` and the 2026-08-21/2026-08-23 `PROGRESS.md`
  infra-gap entries — this is a machine-level constraint, not fixable
  from inside the repo.
- **`module-docs-github/` no longer exists in this repo** — removed
  2026-08-20. If a stale reference to it turns up anywhere, it's dead;
  see "Repo layout" above for where the current spec actually lives.
- **Repo-wide, not yet fixed: some RLS INSERT/"for all" policies check
  `user_id = auth.uid()` but not that a referenced foreign key
  (`account_id`, `trade_id`, etc.) actually belongs to that same user.**
  Found by `retrospeq-security-reviewer` on Module 02's `fills`/
  `trade_events` policies, confirmed to also exist on Module 01's
  `trading_accounts_owner`/`account_credentials_owner_insert`. Not
  currently exploitable to read another user's data (the row still
  isn't selectable afterward), but worth a dedicated repo-wide pass
  rather than patching table-by-table as each is touched — see
  `PROGRESS.md` → "Infra gaps" for the full note.

---
*Last refreshed: 2026-08-23, Phase 1 complete (Module 01 + Module 02
fully built, tested, security- and QA-reviewed, phase-boundary
`simplify` pass done). Brought fully current against the actual repo
state (source tree, migrations, ADRs, test counts) rather than just
appended to — the previous version predated all of Module 02 and most
of Module 01. If you find this stale, that's a signal `retrospeq-docs`
wasn't dispatched at the last phase boundary, not that the convention
is wrong.*
