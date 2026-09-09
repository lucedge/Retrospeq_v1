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

As of this refresh (2026-09-09): **Phase 0** (golden fixtures + shadow
harness) and **Phase 1** (Module 01 Identity & Accounts + Module 02
Trade Ingestion & Model) are both complete. **Phase 2** (Module 04
Rulebook + Module 08 Onboarding) is functionally closed out for
everything currently reachable — Module 04's whole spec is built except
discovery (§5.10c, blocked on Module 05) and strategy-scoped rule
stories 1.5-1.7 (blocked on Module 03's field registry, which now
exists but hasn't been wired back into rule scoping yet); Module 08's
onboarding router/Hook screen and the dashboard's currently-buildable
states ("Trades to close" / "Clear" / a minimal open-position
indicator) are done, with the rest (silent default-strategy creation,
field introduction, the "Review ready" dashboard state, the streak
stat) genuinely blocked on Modules 03/05/06/07, not an oversight.
**Phase 3** (Module 03 Field Registry & Strategy + Module 05 Analytics
& Findings) is in progress, started 2026-09-02. **Module 03's entire
backend is done** — schema through field creation, rename/archive,
promotion, and trigger-condition authoring (the module's one real
cross-module integration point with Module 04) — **but it has zero
UI**: no field picker, field editor, strategy builder, or strategy
screen exist anywhere in this repo yet, and the §4.8 field-cap warning
(also UI) is unbuilt too. **Module 05's foundational layer** (core
schema, the `canRender` kill-switch registry runtime, and the CI-
enforced Module 04/05 import-isolation boundary) is done; its real
edge/detection engine and any actual analytic computation do not exist
yet. **Another agent may be actively building that engine in this same
working directory as this paragraph is being written** — treat
`lib/analytics/` as a moving target and check `PROGRESS.md`'s own
"Phase status" / "Current task" section for what has actually landed,
not just this paragraph. Modules 06, 07, 09, 10 have not been started.

This is prose for orientation only — `PROGRESS.md`'s "Phase status"
table (and the much more detailed "Current task" section above it) is
the actual source of truth and moves faster than this file does; check
it, don't assume this paragraph is current by the time you read it.

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

### Module 04 — Rulebook & Evaluation (`lib/rules/`, `app/(app)/rules/`)

The trader's "how do I conduct myself" system — produces Adherence, not
Findings (AGENTS.md's test: *can it be violated? A violation is
Rulebook; a fact is Strategy*). Built across 10+ sub-slices; everything
currently in reach is done (strategy-scoped rules are blocked on Module
03's field registry — see "Module 03 ↔ Module 04" below).

- **`operand-catalogue.ts`** — the static, validated `operand_id`
  catalogue (§5.2/§5.3) every rule expression is checked against;
  **`evaluate.ts`** is the pure `{operand_id, op, value}` evaluator — no
  compound rules, ever (`docs/adr/0014-no-compound-rules.md`).
- **Authoring**: `rules-repository.ts` (`insertRuleAndVersion`,
  `applyRuleEdit` with real optimistic-concurrency version checking —
  see "Known gotchas" for the bug this shipped with once) plus the
  `validate-*.ts` files (tighten-only, satisfiability, tier,
  entitlement). Every entitlement-capped write (the free-tier rule-
  create cap, the `rules.hard` promotion cap) uses
  `pg_advisory_xact_lock(hashtext(user_id))` as the first statement of
  its own transaction — a TOCTOU class this build found and fixed three
  separate times, now the established pattern for any new capped
  counter.
- **`preview.ts`** + **`distributions-repository.ts`** — §5.8's preview
  engine and `operand_distributions` (a materialized, batched
  cross-trade distribution table, recomputed after every sync and on
  a nightly cadence §12 calls for — the nightly half has no real
  scheduler yet, see Infra gaps in `PROGRESS.md`).
- **`cross-trade-operand-values.ts`** / **`computable-operand-values.ts`**
  — `TradeFacts` assembly (§5.3/§5.4/§5.6), the repo's first
  week-boundary convention (`week-boundary.ts`, ISO week, Monday start,
  `docs/adr/0015`).
- **`freeze-evaluations.ts`** — wires rule evaluation into
  `lib/ingestion/confirm.ts`'s freeze transaction; evaluations never
  recompute retroactively (a project non-negotiable).
- **`adherence-repository.ts`** / **`adherence-display.ts`** — the
  materialized `adherence_weekly` two-fraction (hard/soft, never
  blended) report, with hard-priority attribution (a hard breach always
  wins the naming slot over any number of soft breaches) — earns no XP,
  ever.
- **`severity-lifecycle-repository.ts`** / **`promotion-eligibility.ts`**
  — soft→hard promotion (6wk-active/≥20-evals/≥95%-compliance all-time
  + zero breaks in a rolling 21-day window), demote, retire (one-way, no
  reactivate path anywhere).
- **`ambient-state.ts`** / **`rule-overrides-repository.ts`** — §5.9's
  always-visible ambient live-state (never appear-on-threshold — that
  would itself be an alarm) and the "acknowledge and proceed" override
  write.
- **`freeze-trigger-evaluations.ts`** — the EVALUATION half of Module
  03's trigger conditions (see "Module 03 ↔ Module 04" below): a
  self-attested, free-text checklist item freezes into its own
  `trigger_evaluations` table at confirm-time, never the `rules`/
  `rule_evaluations` tables.

UI: `app/(app)/rules/page.tsx` (rule list + adherence display +
promote/demote/retire controls), `rules/new/` (rule editor, create
flow), `rules/start/` (the guided three-rule front door, story 1.4),
plus `EditRuleControl.tsx`/`Adherence.tsx`/`RuleList.tsx`. The ambient
strip itself (§5.9 UI, `AmbientStrip.tsx`) lives on
`app/(app)/trades/manual-entry` since that's this repo's only "before I
enter a trade" screen today.

Schema (`20260823020000_rulebook_schema.sql`): 6 tables (`rules`,
`rule_versions`, `rule_evaluations`, `rule_overrides`,
`adherence_weekly`, `operand_distributions`), plus
`trigger_evaluations` (`20260909010000_trigger_evaluations_schema.sql`
— technically Module 04-side schema per `docs/adr/0022` even though it
freezes Module 03-authored content).

### Module 08 — Onboarding & Home (`lib/onboarding/`, `lib/dashboard/`,
`app/(app)/onboarding/`, `app/(app)/dashboard/`)

Started 2026-09-01 after a real blocker analysis (done up front, not
discovered slice-by-slice) found large parts of Module 08's own spec
depend on Modules 03/05/06/07 — none of which existed at the time —
despite AGENTS.md's build-order framing "Module 04 + Module 08" as one
shippable phase. **Everything currently buildable is done**; the rest
(silent default-strategy creation, field introduction, the "Review
ready" dashboard state, the streak stat) is a confirmed external
blocker, not an oversight.

- **`onboarding-state-repository.ts`** — the `onboarding_state`/
  `unlock_state` schema, stage-advancement with real regression
  protection (`OnboardingStageRegressionError` — a trader can't be
  silently walked backward through the sequence).
- **`router.ts`** — `resolveOnboardingDestination(stage, path)`, pure
  sequencing logic for the Hook screen flow.
- **`hook.ts`** — the honest-fallback Hook screen's own read
  (`countImportedTradesForUser`).
- **`unlock-state-repository.ts`** — computes/materializes unlock
  counters off confirmed trades, wired into the confirm pipeline as a
  best-effort recompute (matching `operand_distributions`'s and
  `adherence_weekly`'s established pattern — see `docs/runbook.md` →
  "`unlock_state` recompute failing after a confirmation").
- **`lib/dashboard/`** — `dashboard-state.ts`'s `resolveDashboardKind`
  (`open` / `closeout` / `clear` — deliberately narrower than §7/§8's
  full spec, since "Review ready" needs Module 06) +
  `dashboard-repository.ts`'s `getDashboardStateForUser`.

UI: `app/(app)/onboarding/hook/page.tsx`, `app/(app)/dashboard/page.tsx`.
Schema: `20260901010000_onboarding_schema.sql`.

### Module 03 — Field Registry & Strategy (`lib/fields/`)

The substrate both Strategy and Rulebook are built on. Started
2026-09-02, built in sub-slices 03a–03e plus trigger-condition
authoring; **the entire backend is done, but there is zero UI** — no
field picker, field editor, strategy builder, or strategy screen exist
anywhere in this repo yet, and the §4.8 field-cap warning (also UI) is
unbuilt too.

- **`field-validation.ts`** — `checkPruningRule` (§4.1: rejects a new
  field name that's a known reordering/pluralization variant of one of
  the 9 seeded derived fields or an existing active field — a curated,
  hand-reviewable list, deliberately not NLP/embedding similarity) +
  `validateFieldConfig` (§4.3's per-`data_type` config shape).
- **`fields-repository.ts`** — `createField` (`kind: 'account' |
  'strategy_var'` only — `kind = 'derived'` is blocked at the RLS layer
  itself, `fields_owner_insert`), `renameField`/`archiveField` (§4.5
  lifecycle — archive is blocked by a real `field_usages` dependency,
  closed with a guarded UPDATE that re-checks `not exists (...
  field_usages ...)` atomically to close a TOCTOU window — see "Known
  gotchas" for a real Postgres lock-mode gotcha this slice hit),
  `promoteField`/`findPromotionCandidates` (§4.5/§6.1). Field ids are
  `'acct.' || uuidv7()` / `'str.' || uuidv7()`, generated server-side —
  deliberately NOT slugified from the trader's own name (a rename would
  leave the id stale) and NOT embedding the owning strategy's id (a
  later promotion to `account` would leave a stale artifact).
- **`strategy-repository.ts`** — `createStrategy`/`editStrategy`,
  mirroring `rules-repository.ts`'s guarded-UPDATE versioning shape;
  rebuilds `field_usages` on every edit.
- **`strategy-validation.ts`** — §4.4 capture-moment validation, §9
  trigger-count soft warning, hedge-word detection (§2.4 — soft warning
  only, never a block).
- **`trigger-conditions-repository.ts`** — the AUTHORING half of §4.7's
  trigger conditions (free text, self-attested, no operand/operator/
  threshold at all — genuinely not a `rules`/`rule_versions` row,
  despite §4.7's own opening sentence reading like an instruction to
  reuse Module 04's rule pipeline; Module 04 §5.2 explicitly
  contradicts that reading — see "Module 03 ↔ Module 04" below).

Schema (`20260902010000_field_registry_schema.sql` +
`20260902020000_strategy_default_uniqueness.sql`): 5 tables (`fields`,
`strategies`, `strategy_versions`, `field_usages`,
`trigger_conditions`), 100% RLS coverage. `fields.id` is a composite
primary key `(user_id, id)` — the spec's literal DDL would have
collided globally on a second signup (`docs/adr/0017`). Every user gets
9 permanent `drv.*` derived fields seeded atomically at signup by
`retrospeq.seed_derived_fields_for_user` (called from `handle_new_user`)
— `drv.session`, `drv.day_of_week`, `drv.direction`, `drv.order_type`,
`drv.risk_pct`, `drv.planned_rr`, `drv.hold_seconds`, `drv.instrument`,
`drv.news_nearby`. **A naming overlap is flagged, not resolved**:
several of these overlap in meaning with Module 04's own operand
catalogue (`risk_pct`/`hold_seconds`/`day_of_week`/`order_type`/
`instrument`) — documented in the migration's own header, not silently
picked a side on.

#### Module 03 ↔ Module 04 — the one real cross-module wiring point

A trigger condition is authored in `lib/fields/` (Module 03) but frozen
at confirm-time by `lib/rules/freeze-trigger-evaluations.ts` (Module
04) into its own dedicated `trigger_evaluations` table — **not** the
`rules`/`rule_versions`/`rule_evaluations` tables. This is a deliberate,
spec-driven split (`docs/adr/0022`), and it is **not** the same shape
as the Module 04/05 `lib/analytics` → `lib/rules` isolation boundary —
no ESLint rule blocks `lib/fields` from referencing Module 04 concepts,
and this is the one place in the repo today where that actually
happens. `trigger-conditions-repository.ts` imports nothing from
`lib/rules`; the two files live as siblings
(`lib/fields/trigger-conditions-repository.ts` and
`lib/rules/freeze-trigger-evaluations.ts`), wired together only via the
`trigger_conditions.id` → `trigger_evaluations.condition_id` foreign
key, never a TypeScript import.

### Module 05 — Analytics & Findings (`lib/analytics/`) — foundational layer only

Findings, not Adherence — "was this ever wrong" independent of the
rules a trader wrote for themselves (AGENTS.md: *analytics code cannot
import rule code*). As of this refresh, only Slice 05a (core schema +
the `canRender` kill-switch registry runtime + the CI-enforced Module
04/05 isolation boundary) is done — **no real edge engine, detection
engine, or actual analytic computation exists yet**. Treat this section
as describing the foundation only.

- **`registry-runtime.ts`** — the PURE half of §4.8's `canRender`
  formula (`config.enabled AND plan_at_least AND cohort AND NOT
  suppressed AND account_tier_supports`) — no I/O, cannot throw for a
  data reason.
- **`registry-runtime-service.ts`** — the I/O orchestration half;
  **never throws** — any dependency failure resolves to `{ canRender:
  false, reason: 'config_unavailable' }`, per §4.8's own "if config
  cannot be read, nothing renders. Silence is always the safe failure"
  and §9's `ANALYTIC_CONFIG_UNAVAILABLE` row.
- **`config-repository.ts`** + **`config-cache.ts`** — the real
  `analytic_config` read, with a genuine 60s in-process TTL cache
  (§4.8's own "config is cached 60s" — this didn't exist for one day
  after the slice first shipped; an independent tester dispatch caught
  the gap same-day).
- **`cohort-repository.ts`** / **`suppression-repository.ts`** /
  **`account-tier-repository.ts`** — the other three `canRender`
  inputs. `account-tier-repository.ts` is a **deliberate second copy**
  of a query `lib/rules/rules-repository.ts` already has — querying
  `trading_accounts` directly is fine (a Module 01 table), but
  importing the Module 04 *function* that runs the same query would
  violate the isolation boundary, so it's duplicated rather than
  imported.
- **`render-repository.ts`** — writes `analytic_renders` (§4.8's "every
  successful render writes a row with the exact payload shown") — each
  concrete analytic's own responsibility, not `canRender`'s.
- **`shadow-harness/`** — Phase 0 infrastructure (built ahead of any
  real analytic, per the build order's own item 0), still unused by any
  registered analytic today.

Schema (`20260908010000_analytics_registry_schema.sql`): 7 tables
(`analytic_config`, `analytic_user_suppression`, `user_cohorts`,
`findings`, `detections`, `analytic_renders`, `finding_rule_links`),
100% RLS coverage.

**The Module 04/05 isolation boundary is enforced by two separate
ESLint mechanisms** in `eslint.config.mjs`, scoped to
`lib/analytics/**/*.{ts,tsx}`: `no-restricted-imports` (catches static
`import`/`export ... from` statements) and two `no-restricted-syntax`
selectors that catch a dynamic `import('@/lib/rules/...')` call — one
for a plain string literal, a second, separately necessary one for a
zero-substitution template-literal specifier, since a `TemplateLiteral`
AST node has no `.value` property the first selector can match against.
**One bypass is known and deliberately deferred, not silently
accepted**: re-export indirection through a file outside
`lib/analytics/**` — nothing in this repo closes that today (would need
`dependency-cruiser` or equivalent import-graph analysis, not a
single-file syntactic check). `retrospeq-security-reviewer`'s PASS on
this slice is **conditional**: this gap must be closed before Module
05's edge/detection-engine slices land real analytic computation — see
Infra gaps in `PROGRESS.md` and the canary test
(`lib/analytics/__tests__/eslint-boundary.test.ts`, "KNOWN RESIDUAL
RISK (b)") that fails loudly if the gap silently closes or widens
unnoticed. Full reasoning: `docs/adr/0021`.

### Direct Postgres access — why `.from()`/`.rpc()` don't work here

Every `retrospeq`-schema table (every module, including 03/04/05's
newer ones — `lib/fields/`, `lib/rules/`, `lib/analytics/` all follow
this same pattern) is written and read via a **direct Postgres
connection** (`lib/supabase/direct.ts`, `SUPABASE_DB_URL`), not
`@supabase/supabase-js`'s `.from()`/`.rpc()` calls. Reason, live-probed
and confirmed (not assumed): PostgREST — the
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
    rules/                 Module 04: rule list/editor/guided front door, adherence display
    onboarding/             Module 08: the Hook screen (onboarding router UI)
    dashboard/              Module 08: home screen (open/closeout/clear states)
    __tests__/               Shell-level tests (e.g. nav)
  auth/callback/           Supabase OAuth (Google) callback route
  brand-tokens/            Synced copy of the design system's CSS tokens
lib/
  auth/                    Auth Server Action support: error mapping, Zod schemas, MFA/recovery codes
  broker/                  BrokerAdapter interface + fixture adapter, envelope encryption, connect flow
  entitlements/            Plan/subscription/capability resolution (Module 01 §4.x)
  ingestion/               Module 02: blocks, grouping engine, trade facts, sync pipeline,
                            arm-event matching, pre-entry capture lock, confirm/freeze, corrections
  rules/                   Module 04: operand catalogue, evaluator, authoring, preview/
                            distributions, adherence, severity lifecycle, ambient state,
                            trigger-evaluation freeze (see "Module 04" above)
  fields/                  Module 03: field validation/creation/lifecycle/promotion,
                            strategy CRUD/versioning, trigger-condition authoring
                            (backend only, no UI yet — see "Module 03" above)
  analytics/                Module 05: canRender registry runtime + config/cohort/
                            suppression/account-tier/render repositories (foundational
                            layer only, no real analytics yet — see "Module 05" above)
  analytics/shadow-harness/  Phase 0's shadow-analytics infrastructure (Module 05's harness),
                            built ahead of any real analytic existing
  onboarding/               Module 08: onboarding_state/unlock_state, stage router, Hook screen read
  dashboard/                Module 08: dashboard state resolution (open/closeout/clear)
  privacy/                 GDPR export/erasure/restriction (Module 01 §5.x) — export.ts is
                            stale as of Module 02+; see "What's explicitly not built yet"
  rate-limit/              Direct-pg fixed-window throttle, every auth/security-sensitive endpoint
  supabase/                Client factories: RLS-scoped, service-role, and direct-pg
fixtures/golden/            8 golden fixtures for the trade-grouping engine (see above)
supabase/migrations/         SQL migrations, applied in filename (timestamp) order — 23 as of
                            this refresh
docs/adr/                    22 ADRs as of this refresh — one per deliberate deviation from a
                            00-foundation convention
docs/runbook.md               One entry per alerting condition a module's spec calls out
e2e/                          Playwright E2E specs (auth, trades, rules, onboarding, dashboard)
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
npx playwright test       # E2E, headless (npm run test:e2e is the same command)
npm run lint               # eslint
npx tsc --noEmit           # typechecking (also covered by `npm run build`)
npm run build               # must stay green before any slice is handed off
```

Coverage bar (00-foundation §9): 90% line coverage on the grouping /
rule-evaluation / statistics engines specifically, 70% overall. RLS
cross-user isolation is asserted on 100% of tables, not sampled — live
against the real shared dev Postgres database (a genuine `SET LOCAL
ROLE` + `request.jwt.claims` role switch, not a mock), not just a
`pg_policies` metadata check. This bar has held for Module 04/03/05's
own new engines too — e.g. `adherence-repository.ts` measured at 100%,
`fields-repository.ts`'s new work in the 93-100% range per slice.

As of Phase 1's close (2026-08-23): **951 tests passing, 12 skip-guard
fallbacks (env-gated live-DB suites — the env is present in this repo,
so these run for real, not silently skipped), 0 failed.** `lib/`
overall line coverage was last measured at 98.48% at that point
(individual engine files run higher — e.g. `blocks.ts` 100%,
`grouping.ts` 98.61%, `trade-facts.ts` 100%). The suite has grown a
great deal since — Module 04's 10+ sub-slices, Module 08, and Module
03's five-plus sub-slices each added their own unit + live-DB suites;
by Slice 10b (2026-08-31) the full count was already 1609 passed/13
skipped. **Don't trust a specific total-test-count figure in this
file** — it moves every slice; check `PROGRESS.md`'s own per-slice
entries (search "Full suite" or the latest "AT A GLANCE" note at the
top of "Current task") for the number as of any given point. `npm run
build`/`lint`/`tsc --noEmit` are expected clean on every slice; when
`npm run build` failed this session it was consistently the host-memory
OOM pattern described in "Known gotchas" below, now fixed at the config
level (`next.config.ts`'s `experimental.cpus: 2`), not a code defect.

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
- **Any Module 03 UI.** The backend (schema through field creation,
  rename/archive, promotion, trigger-condition authoring) is fully
  built (see "Module 03" above), but there is no field picker, field
  editor, strategy builder, or strategy screen anywhere in this repo,
  and the §4.8 field-cap warning (also UI) is unbuilt. Module 02's
  pre-entry capture chips and trim-reason field, stubbed pending Module
  03, still have no real integration point wired up.
- **Module 05's real analytic computation.** Only the foundational
  layer exists (schema, the `canRender` registry, the isolation
  boundary — see "Module 05" above). No edge engine, no detection
  engine, no analytic has ever actually been registered or computed —
  don't assume `findings`/`detections` ever get a real row today.
- **`coverage_gaps` resolution.** Rows are written but nothing in this
  repo ever sets `resolved_at` — a gap is currently permanent once
  recorded. Tracked in `docs/runbook.md`, not silently dropped.
- **A transactional email provider.** `lib/privacy/email-provider.ts`
  throws unconditionally; erasure's confirmation email is best-effort
  only and never gates deletion.
- **`lib/privacy/export.ts`'s export bundle is stale — flagged as a
  likely data-rights gap, not just tech debt.** It still only exports
  `profile`/`tradingAccounts`/`subscription`/`mfa`: zero trades and
  zero Module 03/04 data (`rules`, `rule_versions`, `rule_evaluations`,
  `rule_overrides`, `adherence_weekly`, `trigger_conditions`,
  `trigger_evaluations`) are included, even though Module 02 has
  existed since 2026-08-23. **Erasure is not the same gap and is
  confirmed comprehensive** — this is export specifically. A trader who
  exercises "export my data" today gets a bundle silently missing
  everything they've logged and written. Tracked with real urgency in
  `PROGRESS.md` → "Infra gaps"; needs a dedicated dispatch against this
  file (and its CSV counterpart) whenever picked up.

Standing infra gaps beyond these (Vercel project, dedicated production
Supabase project, Node version, a nightly-recompute scheduler for
`operand_distributions`) are tracked in `PROGRESS.md` → "Infra gaps" —
check there before assuming something is a code bug.

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
  `trading_accounts_owner`/`account_credentials_owner_insert`, and now
  also on Module 03's `field_usages_owner_insert` (`used_by_id`
  ownership unverified at the RLS layer). Not currently exploitable to
  read another user's data (the row still isn't selectable afterward),
  but worth a dedicated repo-wide pass rather than patching
  table-by-table as each is touched — see `PROGRESS.md` → "Infra gaps"
  for the full note, including a related-but-distinct **same-user**
  scope gap found in Module 03 (a `strategy_var` field's
  `owner_strategy_id` is never checked against the strategy that
  actually references it via `field_usages`).
- **Postgres's `FOR KEY SHARE`/`FOR NO KEY UPDATE` row-lock modes do not
  conflict with each other** — a guarded `UPDATE ... WHERE NOT EXISTS
  (...)` can still race with a concurrent INSERT into the table the
  `WHERE NOT EXISTS` checks, because Postgres's default locking doesn't
  serialize that combination the way it looks like it should at a
  glance. Hit for real in Module 03 Slice 03d's `archiveField` (a
  `field_usages` TOCTOU), confirmed the same root cause as
  `promoteField`'s documented-but-harmless race in Slice 03e. Fixed
  with `pg_advisory_xact_lock(hashtext(fieldId))`, not a fancier
  `WHERE` clause. If you're writing a new "block this write if a
  dependent row exists elsewhere" guard, reach for an advisory lock
  from the start rather than trusting the guarded UPDATE's own
  atomicity alone — this is the same underlying lesson as the
  `pg_advisory_xact_lock(hashtext(user_id))` pattern Module 04's
  entitlement-cap races (Slice 7, Slice 10b) already established, just
  a different trigger.
- **Every new frozen/immutable/materialized table needs its own
  explicit pre-delete function wired into `executeErasure`, or erasure
  breaks for every user with a row in it.** Hit twice for real this
  phase — once for `fields` (Slice 03a) and independently for `rules`/
  `rule_evaluations` (found while fixing the first one) — both fixed
  with a `deleteAllXForUser` function following
  `deleteAllTradingAccountsForUser`'s own `erasure_in_progress`
  escape-hatch pattern (`docs/adr/0010`'s addendum). `trigger_evaluations`
  was deliberately checked against this exact pattern and confirmed
  safe (already reached transitively via `trades -> trading_accounts`'s
  own cascade) rather than assumed either way — do the same check, not
  a reflexive new pre-delete function, for the next new frozen table.
- **`npm run build` was reliably OOM-crashing during Next.js's
  "Collecting page data" phase on this dev machine** (12 cores but only
  ~5-6GB free RAM under typical load — the default worker count of
  `os.cpus().length - 1` is too many for that headroom). Fixed
  permanently in `next.config.ts` (`experimental.cpus: 2`) after the
  same OOM pattern was independently reproduced 4+ times across
  separate coder/tester/security-reviewer/qa dispatches on 2026-09-08/
  09 — every single crash happened only in the later bundling phase,
  never during `tsc`'s own compile step, confirming it's host memory
  pressure, not a code defect. Don't change this value without a real
  reason. If a build still OOMs with the cap in place, check for
  leftover `node`/dev-server processes eating host memory before
  assuming it's a regression.
- **The shared dev/test Supabase project has accumulated a large stale-
  trade backlog that makes `autoConfirmStaleTrades()` genuinely slow**
  (multiple minutes, sometimes exceeding Postgres's own 2-minute
  `statement_timeout`) against real data. Hit repeatedly across
  unrelated live-DB test files (`confirm.live.test.ts`,
  `adherence-repository.live.test.ts`, `severity-lifecycle.live.test.ts`,
  others) — if a live-DB test times out and the diagnosis doesn't
  obviously implicate your own change, re-run that one test file in
  complete isolation before assuming a regression. See
  `docs/runbook.md` → "`autoConfirmStaleTrades` sweep duration scales
  with the pending stale-trade backlog" and the matching `PROGRESS.md`
  → "Infra gaps" entry.
- **The Module 04/05 ESLint isolation boundary needs two separate rule
  mechanisms, not one** (`no-restricted-imports` for static imports,
  two `no-restricted-syntax` selectors for dynamic `import()` — a
  `Literal` argument and a separate, non-obvious `TemplateLiteral`
  selector, since a template-literal AST node has no `.value` property
  the first selector can match against). One bypass (re-export
  indirection through a file outside `lib/analytics/**`) is still open
  and is a **binding condition** on Module 05's next real slice — see
  "Module 05" above and `docs/adr/0021` before assuming the boundary is
  airtight.

---
*Last refreshed: 2026-09-09 (Module 03's entire backend closed out —
schema through field creation, rename/archive, promotion, and
trigger-condition authoring — and Module 05's foundational layer
(core schema, `canRender` registry runtime, Module 04/05 isolation
boundary) landed). Brought fully current against the actual repo state
(source tree — `lib/fields/`, `lib/analytics/`, `lib/onboarding/`,
`lib/dashboard/` all new since the last refresh — migrations, ADRs,
`PROGRESS.md`'s Phase status and Current task sections) rather than
just appended to. Another agent may be actively building Module 05's
real edge/detection engine in this same working directory as this
refresh lands — if `lib/analytics/` looks bigger than this file
describes, that's expected, not staleness; check `PROGRESS.md` first.
If you find this stale in some other way, that's a signal
`retrospeq-docs` wasn't dispatched at the last phase boundary, not that
the convention is wrong.*
