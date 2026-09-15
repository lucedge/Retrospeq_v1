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
| Standing infra gaps and deferred follow-ups | `docs/infra-gaps.md` |
| Why was a spec convention deviated from | `docs/adr/NNNN-*.md` |
| What alerting/error conditions exist and what to do about them | `docs/runbook.md` |
| Product spec / non-negotiables / design system | `AGENTS.md` + `retrospeq-design-system/modules/` |
| How the agent pipeline works (tiers, scripts, skills) | `docs/process.md`, `.claude/skills/verify/SKILL.md` |

This file is for everything else a developer (human or agent) needs
to get productive: how to run the thing, how the pieces fit together,
how to test it, and the non-obvious gotchas that aren't a deviation
worth an ADR but would waste your time to rediscover.

## Where the build actually is

As of this refresh (2026-09-15): **Modules 01, 02, 04, 06, 07, 08 are
feature-complete for reachable scope; Module 03's backend and all §5.1
UI are done; Module 05's edge engine, detection engine, and decay/
suppression machinery are all real and computing.** The UI phase (app
shell restyle against the 76-state mockup) is next. Modules 09/10 are
deferred to v1.1. `PROGRESS.md`'s "Phase status" table and "Current
task" section are the actual source of truth and move faster than this
file does — check them, don't assume this paragraph is current by the
time you read it. In particular: **this file's own "Module 08" section
below corrects two claims in `PROGRESS.md`'s Phase-status table** (the
silent default strategy and the four-state dashboard are both real and
wired, confirmed by reading the code directly — the table's own dated
snapshot lagged the code at the time of this refresh). If you find a
similar mismatch later, trust the code and the ledger's dated entries
over an un-dated summary line.

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
  only implementation that exists today (deterministic, test-only). **No
  real MT4/MT5/cTrader/Binance/Bybit adapter exists yet** — vendor is
  undecided (00-foundation §10), and nothing downstream may see a
  vendor-specific type past this interface.
- **Credential encryption**: `lib/broker/envelope-encryption.ts` —
  per-credential AES-256-GCM data key, wrapped by an external KMS master
  key (never a static app-wide key). `createKmsMasterKeyProvider()`
  throws `KmsNotConfiguredError` unconditionally today — **no real KMS
  vendor is wired up**, so every credentialed connect/sync attempt fails
  loudly by design (see `docs/runbook.md`). Only `manual` (no-credential)
  accounts work end-to-end right now.
- **Entitlements**: `lib/entitlements/` resolves plan/subscription →
  capability. `subscriptions` is read-only to the owner at the RLS
  layer; every write goes through the service role
  (`docs/adr/0008-subscriptions-read-only-rls.md`).
- **Privacy/GDPR**: `lib/privacy/` — export, erasure, restriction.
  Erasure deletes explicitly, table by table, in FK-safe order rather
  than relying on `on delete cascade` (`docs/adr/0010`). **Export is
  now complete**: `lib/privacy/export-tables.ts`'s `EXPORT_TABLE_REGISTRY`
  covers all 40 real `retrospeq` tables carrying a `user_id` column
  (trades, rules, findings, strategies, engagement events, everything),
  each in/exclude decision written down; `export-csv.ts`'s
  `buildFullExportCsv` renders the same registry as a single
  RFC-4180-quoted `export.csv` with a formula-injection guard on every
  cell (only plain numbers exempt). A live `information_schema` scan
  test (`export-completeness.live.test.ts`) fails loudly if a future
  table with a `user_id` column is ever added without a matching
  decision. Transactional email is wired to Resend
  (`lib/privacy/email-provider.ts`, plain `fetch`, no SDK) —
  `getTransactionalEmailProvider()` still throws
  `EmailProviderNotConfiguredError` if `RESEND_API_KEY`/`EMAIL_FROM` is
  missing/invalid, never a fake send.

### Module 02 — Trade Ingestion & Model (`lib/ingestion/`, `app/(app)/trades/`)

The pipeline, in order, each stage its own file in `lib/ingestion/`:

1. **`blocks.ts`** — block derivation (§4.2): groups raw `fills` into
   contiguous same-instrument, same-account position spans using exact
   `decimal.js` arithmetic (never JS `number`).
2. **`grouping.ts`** — the grouping engine (§4.3): splits a block into
   trades using a weighted signal table and the resting-baseline
   excursion algorithm, with confidence bands. **Price proximity is
   architecturally banned, not just documented** —
   `GROUPING_SIGNAL_WEIGHTS.price_proximity` is hard-coded `0` and no
   scorer reads `.price` at all; property-tested directly
   (`lib/ingestion/__tests__/grouping.property.test.ts`).
3. **`trade-facts.ts`** — derived facts (§4.4): `r_multiple`,
   `risk_pct` (peak-not-initial), VWAP, hold time, outcome band.
4. **`sync.ts`** — the sync pipeline (§4.1): `BrokerAdapter` →
   `fills`/`blocks`/`trades` writes, a `sync_runs` row per attempt.
   There is **no "sync now" UI trigger yet** — the pipeline exists and
   is tested, but nothing in the UI calls it.
5. **`arm-matching.ts`** + **`trade-captures.ts`** — arm-event matching
   (§4.5) and the pre-entry capture lock, enforced by a real DB trigger.
6. **`confirm.ts`** — the confirm/freeze transaction (§4.6), including a
   7-day auto-confirm sweep (`autoConfirmStaleTrades`). Rule evaluations
   and grouping freeze here permanently — never recomputed retroactively
   (a project non-negotiable, see `AGENTS.md`).
7. **`corrections.ts`** / **`split-join.ts`** — post-freeze corrections
   (§4.7): `not_a_decision`, manual split, manual join,
   `resolveAmbiguousGroupingAsSingle`.
8. **`manual-entry.ts`** — manual trade entry (§4.8) for accounts with
   no broker credential.

UI: `app/(app)/trades/page.tsx` (trade list), `close-out/page.tsx`, `manual-entry/page.tsx`, plus `SplitControl.tsx`/`JoinControl.tsx`/`NotADecisionToggle.tsx`.

**Schema**: 11 tables (`fills`, `blocks`, `trades`, `trade_fills`,
`trade_events`, `arm_events`, `trade_captures`, `sync_runs`,
`coverage_gaps`, `day_closeouts`, `position_snapshots`), **three
different RLS shapes** chosen per-table — see `docs/adr/0011`.

### Module 03 — Field Registry & Strategy (`lib/fields/`, `app/(app)/{fields,strategies}/`)

The substrate both Strategy and Rulebook are built on. **Backend and all
§5.1 UI are done**: field picker/editor (`app/(app)/fields/`), strategy
builder and detail screen (`app/(app)/strategies/`), the field-cap
warning.

- **`field-validation.ts`** — `checkPruningRule` (§4.1, curated
  reordering/pluralization denylist against the 9 seeded derived fields,
  deliberately not NLP/embedding similarity) + `validateFieldConfig`.
- **`fields-repository.ts`** — `createField` (`kind: 'account' |
  'strategy_var'` only — `'derived'` is blocked at the RLS layer
  itself), `renameField`/`archiveField` (guarded UPDATE closing a real
  TOCTOU on `field_usages`), `promoteField`/`findPromotionCandidates`.
  Field ids are `'acct.' || uuidv7()` / `'str.' || uuidv7()`, generated
  server-side. `fetchDefaultStrategySeedFieldIds` (added 2026-09-15,
  Module 08 wiring — see below) selects the permanent `drv.*` fields a
  fresh default strategy is seeded with.
- **`strategy-repository.ts`** — `createStrategy`/`editStrategy`,
  versioned like `rules-repository.ts`; rebuilds `field_usages` on every
  edit.
- **`strategy-validation.ts`** — §4.4 capture-moment validation, §9
  trigger-count soft warning, hedge-word detection (soft only).
- **`trigger-conditions-repository.ts`** — the AUTHORING half of §4.7's
  trigger conditions (free text, self-attested, not a `rules` row — see
  "Module 03 ↔ Module 04" below).

Schema: 5 tables (`fields`, `strategies`, `strategy_versions`,
`field_usages`, `trigger_conditions`), 100% RLS coverage. `fields.id` is
a composite primary key `(user_id, id)` (`docs/adr/0017`). Every user
gets 9 permanent `drv.*` derived fields seeded atomically at signup
(`retrospeq.seed_derived_fields_for_user`). **Known gap, tracked in
`docs/infra-gaps.md`**: a `strategy_var` field's `owner_strategy_id` is
never cross-checked against the strategy actually referencing it via
`field_usages` (same-user scope only, not a cross-user leak).

#### Module 03 ↔ Module 04 — the one real cross-module wiring point

A trigger condition is authored in `lib/fields/` (Module 03) but frozen
at confirm-time by `lib/rules/freeze-trigger-evaluations.ts` (Module 04)
into its own `trigger_evaluations` table — **not** `rules`/
`rule_versions`/`rule_evaluations`. Deliberate, spec-driven split
(`docs/adr/0022`), wired only via a foreign key, never a TypeScript
import.

### Module 04 — Rulebook & Evaluation (`lib/rules/`, `app/(app)/rules/`)

The trader's "how do I conduct myself" system — produces Adherence, not
Findings (*can it be violated? → Rulebook. A fact → Strategy.*).
**Feature-complete for reachable scope** (closed 2026-09-15 with the
`/rules/new` discovery slice).

- **`operand-catalogue.ts`** — the static, validated `operand_id`
  catalogue every rule expression is checked against; **`evaluate.ts`**
  is the pure `{operand_id, op, value}` evaluator — no compound rules,
  ever (`docs/adr/0014`). All 20 of the cross-trade operands built in
  `cross-trade-operand-values.ts` are now `computableToday: true` for
  real (flipped 2026-09-15 after re-verifying the freeze path
  end-to-end); the ~10 genuinely deferred ones stay `false`.
- **Authoring**: `rules-repository.ts` (`insertRuleAndVersion`,
  `applyRuleEdit` with optimistic-concurrency version checking) plus the
  `validate-*.ts` files (tighten-only, satisfiability, tier,
  entitlement). Every entitlement-capped write uses
  `pg_advisory_xact_lock(hashtext(user_id))` as the first statement of
  its own transaction — a TOCTOU class this build found and fixed
  several times, now the established pattern for any new capped
  counter. `create-rule-internal.ts` also verifies (`isStrategyOwnedByUser`)
  that a `scope='strategy'` write's `scopeId` actually belongs to the
  caller — a real P1 fixed 2026-09-15 (security-sweep, see decision log).
- **`preview.ts`** + **`distributions-repository.ts`** — §5.8's preview
  engine and `operand_distributions` (recomputed after every sync and on
  a nightly cadence — the nightly half has no real scheduler, see
  `docs/infra-gaps.md`).
- **`freeze-evaluations.ts`** — wires rule evaluation into
  `lib/ingestion/confirm.ts`'s freeze transaction; evaluations never
  recompute retroactively.
- **`adherence-repository.ts`** / **`adherence-display.ts`** — the
  materialized `adherence_weekly` two-fraction (hard/soft, never
  blended) report, with hard-priority attribution — earns no XP, ever.
- **`rule-change-annotations.ts`** — §4.7's "annotates the adherence
  timeline": renders up to 3 recent rule-value changes as plain-English
  sentences on `/review` Part 1 and `/rules` adherence (added
  2026-09-15).
- **`severity-lifecycle-repository.ts`** / **`promotion-eligibility.ts`**
  — soft→hard promotion, demote, retire (one-way, no reactivate).
- **`ambient-state.ts`** / **`rule-overrides-repository.ts`** — §5.9's
  always-visible ambient live-state and the "acknowledge and proceed"
  override write.
- **`guided-front-door.ts`** — the three-rule guided calibration
  (`/rules/start`), seeded from the trader's own historical numbers.
  **This is also Module 08's onboarding "calibration screen"** — see
  "Module 08" below; there is no second, separate calibration UI.
- **`freeze-trigger-evaluations.ts`** — the EVALUATION half of Module
  03's trigger conditions (see "Module 03 ↔ Module 04" above).

UI: `app/(app)/rules/page.tsx` (rule list + adherence + promote/demote/
retire), `rules/new/` (rule editor — now with a discovery panel ranking
the trader's own detections above a searchable operand catalogue behind
`<details>`, `lib/review/discovery.ts`), `rules/start/` (guided
front door), plus `EditRuleControl.tsx`/`Adherence.tsx`/`RuleList.tsx`.

Schema: 6 tables (`rules`, `rule_versions`, `rule_evaluations`,
`rule_overrides`, `adherence_weekly`, `operand_distributions`), plus
`trigger_evaluations`.

### Module 05 — Analytics & Findings (`lib/analytics/`)

Findings, not Adherence — "was this ever wrong" independent of the
rules a trader wrote for themselves (`lib/analytics/**` cannot import
`lib/rules/**`, ESLint + dependency-cruiser enforced). **The foundational
layer, edge engine, and detection engine are all real and computing.**

- **`registry-runtime.ts`** / **`registry-runtime-service.ts`** — the
  `canRender` kill-switch (`config.enabled AND plan_at_least AND cohort
  AND NOT suppressed AND account_tier_supports`), never throws — any
  dependency failure resolves to `{canRender: false, reason:
  'config_unavailable'}`.
- **`config-repository.ts`** + **`config-cache.ts`** — a real 60s
  in-process TTL cache on `analytic_config` reads.
- **`edge-engine/`** — `edge-engine.ts` (single-field segmentation per
  §4, `resolveAnalyticId` mapping a field to its analytic id — 8 of the
  9 seeded `drv.*` fields resolve to a Pro-gated id, `drv.session` to a
  Free one with no data source yet, see gap below), `segmentation.ts`,
  `stats.ts` (Holm-corrected significance, `docs/adr/0025`),
  `monotonicity.ts`, `asset-class-suppression.ts`, `gates.ts` (the
  `insufficient`/`confident`/`provisional`/`null_result` tiers),
  `field-values.ts` (per-field value extraction — `drv.session` has no
  extractor, see gap below).
- **`detection-engine/`** — `detection-engine.ts` + `occurrence-detectors.ts`
  (the 5 v1 behavioural detections), `gates.ts` (`rule_proposable`,
  `docs/adr/0031`), `repository.ts` (supersession key, `docs/adr/0029`).
- **`decay-engine`** (via `lib/review/monthly-edge-stability.ts` and
  `finding_rule_links`'s decay-check columns) — a graduated rule's edge
  can be re-checked and flagged as decayed (`docs/adr/0032`).
- **`spec-weekday/`** — the permanent weekday canary shadow analytic
  (`docs/adr/0034`).
- **`shadow-harness/`** — Phase 0 infrastructure, now used by the
  weekday canary.
- **`findings-service.ts`** / **`findings-payload.ts`** — the read path
  for `/strategies/[id]`; **omits** (never shows as "not enough data
  yet") a finding whose `canRender` reason is `'plan'` — a real bug
  fixed 2026-09-15, `docs/adr/0035`'s addendum.

Schema: `analytic_config`, `analytic_user_suppression`, `user_cohorts`,
`findings`, `detections`, `analytic_renders`, `finding_rule_links`, all
100% RLS.

**Known, disclosed gap** (`NEEDS_YOUR_INPUT.md`, needs an owner product
decision): no session-boundary vocabulary is defined anywhere in the
spec or code, so `find.session`/`find.daysession` — the *only* two
Free-tier derived findings in the whole registry — are unreachable by
any user at any trade count. Don't invent UTC session boundaries to
"fix" this; it's flagged, not stalled on an agent.

**The Module 04/05 ESLint isolation boundary** is enforced by
`no-restricted-imports` (static imports) + two `no-restricted-syntax`
selectors (dynamic `import()`, literal and template-literal specifiers),
scoped to `lib/analytics/**/*.{ts,tsx}`, backed by `dependency-cruiser`
(`.dependency-cruiser.cjs`, `npm run check:import-boundaries`) which
closes the one bypass (re-export indirection through a file outside
`lib/analytics/**`) a syntactic ESLint rule alone can't catch. Full
reasoning: `docs/adr/0021`.

### Module 06 — Weekly & Monthly Review (`lib/review/`, `app/(app)/review/`)

"Was this a good week?" — surfaces Adherence + Findings together and
turns eligible patterns into decisions a trader can accept, defer, or
decline. **Feature-complete for reachable scope.**

- **`current-period.ts`** / **`reviews-repository.ts`** — there is no
  scheduler (`docs/infra-gaps.md`), so a review is materialised
  **compute-on-view**: the first time a trader opens `/review` for an
  unclosed period, in that same request (`docs/adr/0039`).
- **`weekly-read-payload.ts`** — Part 1's assembled read (adherence +
  findings + rule-change annotations), frozen once written; old payloads
  missing a later field (e.g. annotations) fall back to `[]`, never a
  crash (`docs/adr/0036`).
- **`prompt-candidates/`** + **`review-prompts.ts`** / **`review-prompts-repository.ts`**
  — Part 2's decision candidates: graduation, promotion, retirement,
  relaxation, detection — eligibility (`docs/adr/0037`), ranking + a
  3-slot cap gated on `canRender` (`docs/adr/0038`).
- **`decisions/`** — one `*-operand-map.ts` + `*-evidence-detail.ts` +
  `*-evidence-schema.ts` trio per decision kind, plus
  `backlog-subject.ts`. `app/(app)/review/decisions/actions.ts` writes
  the actual domain change (rule created/promoted/retired/relaxed) and
  the prompt-state transition. **Known gap** (`docs/infra-gaps.md`): the
  domain write and the guarded prompt-state UPDATE are two transactions
  — a same-user double-submit race, not a cross-user one.
- **`prompt-expiry.ts`** — §4.8's silent 4-week backlog expiry, run
  inside the same materialisation lock as prompt-writing.
- **`monthly-period.ts`** / **`monthly-adherence.ts`** /
  **`monthly-edge-stability.ts`** / **`monthly-strategy-weight.ts`** —
  the `/review/month` trend view (frame 4.13). Edge-stability reuses
  Module 05's own graduation-vs-current decay tracking rather than a
  true calendar-month snapshot, since no `findings` history table exists
  yet — disclosed in the file header and `docs/adr/0043`, not silently
  substituted.
- **`weekly-job.ts`** / **`weekly-notification-content.ts`** /
  **`review-notifications-repository.ts`** — the one weekly
  notification (Module 06 §4.10 step 6 / Module 07 §5.6): exactly-once
  via a unique `(user_id, period_start)` claim, email only (no push
  infra exists), opt-out on `/privacy`. `scripts/run-weekly-review-job.mjs`
  deliberately refuses to run rather than faking a cron trigger — there
  is still no scheduler to call it (`docs/infra-gaps.md`).

UI: `app/(app)/review/page.tsx` (Part 1 + Part 3 close),
`review/decisions/` (Part 2, including the deferred backlog), `review/month/`.

Schema: `reviews`, `review_prompts`, `review_notifications`, plus
`profiles.weekly_review_email_opt_out`.

### Module 07 — Engagement (`lib/engagement/`)

XP/streaks/milestones — deliberately inert relative to the product's
non-negotiables: **adherence and field-completeness earn no XP, ever**
(`docs/adr/0044`), and this module can never send a notification of its
own (`no-notifications.test.ts` statically forbids `lib/engagement/`
from importing the email provider — the one weekly notification is
Module 06's, not this module's).

- **`events-repository.ts`** — append-only `engagement_events` (4 kinds:
  `day_closed`, `review_completed`, `pre_entry_verified`, plus the
  streak mechanism), idempotent per-subject inserts, a forbid-
  update/delete DB trigger with the standard erasure escape hatch.
  Emitted best-effort, post-commit, from `confirm.ts` (day closed, never
  from the auto-confirm sweep), `sync.ts` (pre-entry verified, strict
  `armedAt < filledAt`), and `review/actions.ts` (review completed).
- **`streak-repository.ts`** — streaks count **weeks**, not days (a
  project non-negotiable).
- **`milestone-copy.ts`** — five milestones, XP = 0 for all of them
  (the spec names no numbers; inventing one risks fabrication for zero
  product benefit since XP is never rendered — see `milestones` schema
  comment). Rendered as one quiet `role="status"` line on Home's Clear
  state, never a modal/confetti.

Schema: `engagement_events`, `milestones`.

### Module 08 — Onboarding & Home (`lib/onboarding/`, `lib/dashboard/`,
`app/(app)/onboarding/`, `app/(app)/dashboard/`)

**More complete than `PROGRESS.md`'s dated Phase-status table currently
states — confirmed by reading the code, not carried forward from an
older summary.** Two items that table lists as "left" are real:

- **The silent default strategy (§5.4) is built and backfilled.**
  `lib/onboarding/default-strategy.ts`'s `ensureDefaultStrategyForUser`
  seeds a brand-new default strategy's field list with the user's
  permanent `drv.*` fields (`fields-repository.ts`'s
  `fetchDefaultStrategySeedFieldIds`, `kind <> 'strategy_var' and
  origin <> 'captured'`) so it produces real derived findings without
  ever including a captured field. A one-time migration
  (`20260915030000_default_strategy_seed_fields_backfill.sql`)
  backfilled every pre-existing empty-fields default strategy.
- **The four-state dashboard (§7.1) is real, all four states**:
  `lib/dashboard/dashboard-state.ts`'s `resolveDashboardKind` is total
  over `open > closeout > review > clear`; "Review ready" is derived
  honestly at read time from Module 06's own compute-on-view primitives
  (no second copy of that logic). The "Position open" card still
  omits live current-R (no price feed exists) and conviction dots
  (resolving "the" conviction field for an arbitrary open position needs
  a trade→strategy→field-registry join this repo has no precedent for)
  — both documented omissions, not placeholders.
- **The onboarding "calibration screen" IS Module 04's guided front
  door** (`/rules/start`, `lib/rules/guided-front-door.ts`) — there is
  no separate Module 08 calibration UI; completing or skipping it calls
  `completeGuidedRuleCalibration` (`app/(app)/onboarding/actions.ts`),
  which advances `onboarding_state` to `rules_calibrated`.
- **The field-introduction offer (§5.5, frame 1.19)** is real
  (`lib/onboarding/field-introduction.ts` + `-repository.ts`, 30
  trades/30-day cooldown/2 declines/≥1 real derived finding already
  shown) — genuinely reachable now that the default strategy has fields.
- **The Hook screen (§5.2) is a permanent, honest fallback**, not a
  temporary placeholder: it can never show a real finding, because doing
  so would need a T0 behavioural analytic clearing a real statistical
  gate against a specific trader — no `selectHook()` function exists on
  purpose (see `app/(app)/onboarding/hook/page.tsx`'s own header). The
  real trade count is shown; nothing else is invented.
- **What's genuinely not built**: a "sync now" trigger for the
  account-connected → hook transition (Module 02 gap, not Module 08's),
  and any live current-R/conviction display on the open-position card.

Schema: `onboarding_state`/`unlock_state` (`20260901010000_onboarding_schema.sql`).

## Direct Postgres access — why `.from()`/`.rpc()` don't work here

Every `retrospeq`-schema table, in every module, is written and read via
a **direct Postgres connection** (`lib/supabase/direct.ts`,
`SUPABASE_DB_URL`), not `@supabase/supabase-js`'s `.from()`/`.rpc()`.
Reason, live-probed: PostgREST only serves schemas listed in the
project's "Exposed schemas" dashboard setting, and `retrospeq` is not in
that list (`docs/infra-gaps.md` has the one-line fix if that's ever
changed — this pattern remains valid either way).

Two entry points reproduce the exact role PostgREST would otherwise
switch into:

- `withUserConnection(userId, fn)` — `SET LOCAL ROLE authenticated` +
  `request.jwt.claims`, so real RLS policies actually apply.
- `withServiceRoleConnection(fn)` — `SET LOCAL ROLE service_role`,
  bypasses RLS; callers must filter explicitly on ownership. Every call
  site is enumerated in `service-role-inventory.test.ts` with a written
  reason — adding a new one without a matching allowlist entry fails
  the test.

Full reasoning: `docs/adr/0006` (builds on `docs/adr/0005` and
`docs/adr/0003`, which hit the same wall independently for
`account_credentials` and the rate limiter).

## Golden fixtures + the grouping engine

`fixtures/golden/` holds 8 fixtures (`simple_daytrades`, `scaled_in_out`,
`swing_with_intraday`, `flip_no_flat`, `partial_fills_subsecond`,
`overnight_weekend`, `multi_currency`, `gapped_history`), each with
`input.json`/`expected.json`/`README.md`. **Any change touching the
grouping engine must replay all 8** —
`lib/ingestion/__tests__/golden-fixtures.test.ts` asserts `fills[].server_day`,
`blocks[]`, and full `trades[]` output for every fixture. `flip_no_flat`
encodes a real spec tension — see "Known gotchas" below.

## Running locally

```bash
npm install
npm run dev        # Next.js dev server, http://localhost:3000
```

Environment: copy `.env.local.example` to `.env.local` and fill in
Supabase URL/keys. As of 2026-08-20 these point at a **shared dev/test
Postgres schema** (`retrospeq` schema on the existing LuceEdge Supabase
project), not a dedicated project — see `docs/adr/0002`.
`SUPABASE_DB_URL` (direct Postgres connection, separate from the API
keys) is **required**, per "Direct Postgres access" above.

There is no KMS account wired up yet (`RETROSPEQ_KMS_KEY_ID` in the
example env is a placeholder) — credential-encryption code fails loudly
(`KmsNotConfiguredError`) rather than falling back to a hardcoded key.
Every credentialed broker connect/sync will fail until this exists;
only `manual` accounts work end-to-end. `RESEND_API_KEY`/`EMAIL_FROM`
are required for real transactional email (Auth emails via Resend SMTP
work independently of these — see `docs/infra-gaps.md`).

`RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS` is an opt-in flag
(`lib/entitlements/dev-tools-guard.ts`) for a dev-only tool that flips a
test user's plan without a real billing provider — off by default, not
gated by `NODE_ENV` alone since it writes through the service role.

`RETROSPEQ_E2E_RATE_LIMIT_BYPASS` is a fail-closed, dev/test-only
rate-limit bypass (`docs/adr/0042`) set by `playwright.config.ts`'s
`webServer` for the server it starts; export it yourself in the same
shell if you run `next dev` separately and then the E2E suite against
it. Ignored when `NODE_ENV=production`.

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
    fields/                Module 03: field picker/editor
    strategies/            Module 03: strategy builder + detail screen
    onboarding/             Module 08: the Hook screen
    dashboard/              Module 08: home screen (open/closeout/review/clear, all 4 states)
    review/                 Module 06: weekly review (Parts 1-3), decisions, monthly trend
    settings/                App-shell settings screen
    performance/             Placeholder pending the UI phase
    __tests__/               Shell-level tests (e.g. nav)
  auth/callback/           Supabase OAuth (Google) callback route
  brand-tokens/            Synced copy of the design system's CSS tokens
lib/
  auth/                    Auth Server Action support: error mapping, Zod schemas, MFA/recovery codes
  broker/                  BrokerAdapter interface + fixture adapter, envelope encryption, connect flow
  entitlements/            Plan/subscription/capability resolution
  ingestion/               Module 02: blocks, grouping, trade facts, sync, arm-matching,
                            capture lock, confirm/freeze, corrections
  rules/                   Module 04: catalogue, evaluator, authoring, preview/distributions,
                            adherence, severity lifecycle, ambient state, guided front door,
                            discovery hookup, trigger-evaluation freeze
  fields/                  Module 03: field validation/creation/lifecycle/promotion,
                            strategy CRUD/versioning, trigger-condition authoring
  analytics/                Module 05: canRender registry, edge engine, detection engine,
                            decay tracking, weekday canary, shadow harness
  review/                  Module 06: current/monthly period logic, read payload, prompt
                            candidates + decisions, expiry, weekly notification job
  engagement/              Module 07: engagement_events/milestones/streaks
  onboarding/               Module 08: onboarding_state/unlock_state, stage router, Hook
                            screen read, default-strategy seeding, field-introduction offer
  dashboard/                Module 08: dashboard state resolution (open/closeout/review/clear)
  privacy/                 GDPR export (JSON + CSV)/erasure/restriction
  rate-limit/              Direct-pg fixed-window throttle, every auth/security-sensitive endpoint
  supabase/                Client factories: RLS-scoped, service-role, and direct-pg
fixtures/golden/            8 golden fixtures for the trade-grouping engine (see above)
supabase/migrations/         SQL migrations, applied in filename (timestamp) order — 33 as of
                            this refresh
docs/adr/                    One ADR per deliberate deviation from a 00-foundation convention
docs/runbook.md               One entry per alerting condition a module's spec calls out
docs/infra-gaps.md            Standing gaps and deferred follow-ups (not blocking current work)
e2e/                          Playwright E2E specs (auth, trades, rules, onboarding, dashboard,
                            review decisions/month, fields, strategies)
retrospeq-design-system/      Vendored spec + design system (plain copy, no submodule -
                            re-sync manually if the upstream source changes, see AGENTS.md)
reference/lucedge-broker-prior-art/
                            Frozen snapshot of LuceEdge's broker code - reference only,
                            does not meet this project's security bar as-is, do not copy-paste
.claude/agents/               The six subagent definitions that build this repo
.claude/skills/                slice, verify, ledger, design-build, design-audit, design-explore
```

## The build pipeline (who does what)

Six Claude Code subagents, defined in `.claude/agents/`:
`retrospeq-orchestrator`, `retrospeq-coder`, `retrospeq-tester`,
`retrospeq-security-reviewer`, `retrospeq-qa`, `retrospeq-docs`. Full
role definitions and what each one checks: `.claude/agents/*.md`. How
work is tiered and routed between them, and why six roles (not more,
not fewer): `docs/process.md`.

## Testing

```bash
npm run classify            # risk tier for the current diff, and why
npm run verify              # runs that tier's checks (scoped to touched dirs)
npm run check                # tier-1 bundle: ledger-check + tsc + eslint + unit (non-live), ~45s
npm run check:live           # live-DB unit tests (needs .env.local)
npm run check:security       # RLS suites + service-role allowlist + import-boundary + security-grep
npm run check:import-boundaries  # dependency-cruiser, lib/analytics only
npm run e2e:changed          # 1-3 E2E spec files for the routes touched; `-- --all` for the full suite
npx playwright test          # E2E directly
npm run test:user -- create <label> | delete <id> | cleanup
npm run lint                 # eslint
npx tsc --noEmit             # typechecking
npm run build                 # must stay green before any slice is handed off
```

**Tiers, gates, and what runs when** are the `.claude/skills/verify/SKILL.md`
table, not restated here: tier 0 (docs/ledger/config) commits with no
checks; tier 1 (markup/CSS/tests) gets a scoped `check`; tier 2 (`lib`/
`app` logic) adds `retrospeq-tester` and, on a non-negotiable surface,
`retrospeq-qa`; tier 3 (schema/auth/credentials/rule engine/
entitlements/rate-limit/privacy/any `actions.ts`) adds
`retrospeq-security-reviewer` (blocking) and `retrospeq-qa` in parallel.
Phase end runs the full `check`/`check:live`/`check:security` bundle plus
`e2e:changed -- --all`. Nothing runs the whole unit/E2E suite per
ordinary change — that's the proportionality fix `docs/process.md`
describes.

Coverage bar (00-foundation §9): 90% line coverage on the grouping/
rule-evaluation/statistics engines specifically, 70% overall. RLS
cross-user isolation is asserted on 100% of tables, not sampled — live
against the real shared dev Postgres database (a genuine `SET LOCAL
ROLE` + `request.jwt.claims` switch, not a mock). This bar has held
across every module's engines added since (`adherence-repository.ts`,
`fields-repository.ts`, the edge/detection engines, `events-repository.ts`,
`review-prompts-repository.ts`, all measured in the 93-100% range at
their own slice's close).

**Don't trust a specific total-test-count figure in this file** — it
moves every slice. Check `PROGRESS.md`'s own per-slice ledger entries
for the number as of any given point; `npm run build`/`lint`/
`tsc --noEmit` are expected clean on every slice.

**`vitest.config.ts`'s coverage `include` is `lib/**/*.ts` only** —
`app/` Server Actions/pages have real unit and E2E test coverage but
produce no percentage in the coverage report. Don't read a 0%/missing
figure for an `app/` file as untested; check for a corresponding
`__tests__` file or `e2e/*.spec.ts` case instead.

**`vitest` is pinned to `3.2.7`** (`package.json`), not latest — the
original reason (Node 20.11 too old for `vitest@4.x`'s rolldown-based
Vite) predates this host's move to Node 24 (`docs/process.md` → Host);
if you're touching test tooling and want to revisit the pin, check
`node -v` first and search the decision log for "vitest" before
assuming the constraint still holds.

### UI self-verification (screenshots)

There's no interactive browser tool available to the agents in this
environment — verification of rendered UI happens via headless
Playwright screenshots instead of live clicking:

```bash
npx playwright screenshot http://localhost:3000/<route> tmp/dev-screenshots/<name>.png
```

`tmp/dev-screenshots/` is gitignored — throwaway visual checks, not
build artifacts. Any agent (or you) can then `Read` the PNG directly to
sanity-check layout, spacing, and the design-system rules that are about
rendered appearance rather than code (no red/green color use, exactly
one primary `.rq-btn` per view, ambient/gauge indicators always visible,
etc. — see `AGENTS.md` → "Non-negotiables"). For flows behind auth or
with multi-step interaction, a short Playwright script (`page.goto` →
interact → `page.screenshot()`) replaces the one-line CLI form. This
does not replace Playwright E2E *assertions* — it's a visual supplement
to catch a color/spacing/empty-state regression that still passes every
functional check.

## Design system

Wired twice, don't fight it: `<link href="/brand/css/index.css">` in
`app/layout.tsx` (`.rq-btn`, `.rq-h1`, `.rq-num`, `.rq-row`, marks, tab
bar) and `app/brand-tokens/tailwind.css` (`bg-bg`, `text-ink`,
`border-line`, …). `public/brand/` and `app/brand-tokens/` are **copies**
of `retrospeq-design-system/brand/` — edit the source, re-sync all
three. Rules that look like bugs: one `.rq-btn` per view; `.rq-btn--equal`
pairs have no primary; gauges/ambient strip always visible; ratings are
dots, values are steppers, nothing on a fast-capture screen takes a
keyboard; `.rq-num` on every number. Every screen lives inside the app
shell (`app/(app)/AppShellNav.tsx`, four tabs — Home/Trades/Rulebook/
Performance, Strategy lives inside Rulebook — phone-width column, no
`.rq-btn`/`<form>` in persistent chrome) and is built against its frame
in `brand/docs/screens/<batch>.html#<inventory row>`. **UI work goes
through the skills**: `/design-build`, `/design-audit`, `/design-explore`
(owner-invoked only) — see `AGENTS.md` → "Design system" for the full
authority chain (`brand/` over `modules/09-design-system.md`).

## What's explicitly not built yet

Don't assume any of the following exist just because their interfaces
or stubs do — code that depends on them fails loudly rather than faking
success (per `AGENTS.md` → "never fake it"). Full detail and any newer
gap found since this refresh: `docs/infra-gaps.md`.

- **A real `BrokerAdapter` implementation.** Only the fixture/test
  adapter exists. No MT4/MT5/cTrader/Binance/Bybit vendor has been chosen.
- **A real external KMS.** `createKmsMasterKeyProvider()` always throws.
  Every credentialed connect and sync currently fails at that step.
- **A "sync now" UI trigger.** `lib/ingestion/sync.ts`'s pipeline is
  built and tested; nothing in the UI calls it yet.
- **In-place block extension across a resync boundary**
  (`BLOCK_EXTENSION_DEFERRED`) — see `docs/runbook.md`.
- **Any real production scheduler.** Nightly `operand_distributions`
  recompute, Module 06's weekly-review materialisation/expiry, and the
  one weekly notification are all real, tested, callable functions with
  no cron/Vercel-project surface to call them on yet — every one runs
  compute-on-view or on-demand-after-sync instead, deliberately never a
  fake trigger. See `docs/infra-gaps.md`.
- **Session-boundary vocabulary** — blocks the only two Free-tier
  derived findings (`find.session`/`find.daysession`) from ever
  resolving. A real product decision, tracked in `NEEDS_YOUR_INPUT.md`.
- **A rule authored against a trader's own custom field.** Module 04's
  operand catalogue is static; only a handful of `drv.*` fields map to
  an existing operand today (`lib/review/decisions/graduation-operand-map.ts`).
  A custom `strategy_var`/`captured` field (the spec's own "conviction"
  example) correctly, honestly rejects graduation into a rule rather
  than guessing at an operand. Tracked in `NEEDS_YOUR_INPUT.md`.
- **Push notifications.** Only email exists for the one weekly
  notification; no service-worker/APNs/FCM wiring.
- **Detection decline/mute.** "Not yet" on a detection prompt is a
  defer, not a decline — §4.5's "declined twice → muted" table doesn't
  apply to `kind = 'detection'` yet. See `docs/infra-gaps.md`.
- **`coverage_gaps` resolution.** Rows are written but nothing ever sets
  `resolved_at` — permanent once recorded, tracked not silently dropped.

Standing infra gaps beyond these (no Vercel project, no dedicated
production Supabase project, broker vendor undecided, a repo-wide RLS
FK-ownership sweep, a repo-wide Server Action `.strict()` sweep) are all
in `docs/infra-gaps.md` — check there before assuming something is a
code bug.

## Known gotchas worth not rediscovering

- **The `retrospeq` schema is not PostgREST-exposed, so `.from()`/
  `.rpc()` don't work against it.** Use `lib/supabase/direct.ts`'s
  `withUserConnection`/`withServiceRoleConnection`. See "Direct Postgres
  access" above and `docs/adr/0006`.
- **`account_credentials` cannot support a WHERE-qualified UPDATE/DELETE
  under RLS at all** — Postgres folds the query to "One-Time Filter:
  false" for a table with INSERT+DELETE policies but no SELECT policy.
  Writes go through the service role, ownership checked at the
  application layer. `docs/adr/0005`.
- **A non-atomic check-then-act on a mutable status/timestamp column is
  a recurring race-bug shape in this codebase** — found and fixed
  independently in `erasure.ts`, `confirm.ts`, `split-join.ts`, and (via
  a different lock-mode gotcha, see next item) `fields-repository.ts`'s
  `archiveField`/`promoteField`. Use an atomic conditional `UPDATE ...
  WHERE <condition> RETURNING ...` (check the returned row count) or
  `pg_advisory_xact_lock(hashtext(<key>))` from the start on any new
  status-transition or capped-counter path, rather than trusting a
  guarded UPDATE's own atomicity alone.
- **Postgres's `FOR KEY SHARE`/`FOR NO KEY UPDATE` row-lock modes do not
  conflict with each other** — a guarded `UPDATE ... WHERE NOT EXISTS
  (...)` can still race with a concurrent INSERT the `WHERE NOT EXISTS`
  checks. Hit in `archiveField`/`promoteField`; fixed with
  `pg_advisory_xact_lock`, not a fancier `WHERE` clause.
- **`trade_captures`' "never editable after lock" rule needed a real DB
  trigger** — RLS's row-level model can't express "forbid write after a
  related timestamp elsewhere is set." Same shape as `trades`'
  `forbid_broker_confirmed_trade_delete` trigger. `docs/adr/0011`.
- **Price proximity is banned from the grouping engine at the
  implementation level, not just documented** — don't "fix" this if you
  see it; it's the non-negotiable working as intended.
- **Every new frozen/immutable/materialized table needs its own explicit
  pre-delete function wired into `executeErasure`, or erasure breaks for
  every user with a row in it.** Hit repeatedly (`fields`, `rules`/
  `rule_evaluations`, `engagement_events`/`milestones`) — check against
  this pattern for any new such table, don't assume a cascade covers it.
- **`uuid_generate_v7()`** is defined once, in
  `supabase/migrations/20260820015000_shadow_harness.sql` (`create or
  replace`) — every other migration's own declaration is a no-op.
- **The `flip_no_flat` golden fixture encodes a real spec tension**
  between Module 02 §4.2 and §3.1's fill-uniqueness index — see
  `docs/adr/0001` before touching flip-handling logic.
- **Some numeric conventions deliberately deviate from 00-foundation
  §2.3's decimal-fraction rule.** `risk_pct`/`initial_risk_pct` are
  stored as percentage numbers, not fractions (`docs/adr/0012`).
  `trading_accounts.starting_equity` is nullable, no fabricated default
  (`docs/adr/0013`).
- **Repo-wide, not yet fixed: some RLS INSERT/"for all" policies check
  `user_id = auth.uid()` but not that a referenced foreign key
  (`account_id`, `trade_id`, `used_by_id`, etc.) actually belongs to that
  same user.** Not currently exploitable to read another user's data
  (the row still isn't selectable afterward) — a repo-wide sweep is
  tracked in `docs/infra-gaps.md`, not fixed table-by-table.
- **Repo-wide, not yet fixed: no `app/**/actions.ts` Server Action input
  schema calls Zod's `.strict()`**, so unknown keys are silently
  stripped rather than rejected. Tracked as a repo-wide sweep in
  `docs/infra-gaps.md`.
- **The shared dev/test Supabase project accumulates a real stale-trade
  backlog** that makes `autoConfirmStaleTrades()` genuinely slow
  (multiple minutes, sometimes exceeding Postgres's 2-minute
  `statement_timeout`). If a live-DB test touching it times out and the
  diagnosis doesn't obviously implicate your own change, re-run that one
  test file in isolation before assuming a regression. See
  `docs/runbook.md` and `docs/infra-gaps.md`.
- **The host moved from Windows to macOS / Node 24 on 2026-09-13** —
  every `C:`/`E:` drive, `TEMP`-redirect, or `chromium-1223`-substitute
  note you find in `docs/ledger/` is archived history, not a current
  workaround. `next.config.ts`'s `experimental.cpus: 2` and its
  accompanying comment predate this move; if you're touching build
  performance, verify the OOM pattern still reproduces on this host
  before assuming the cap is still needed.
- **`npm run build` was reliably OOM-crashing during Next.js's
  "Collecting page data" phase on the old host** (too many parallel
  workers for available RAM) — fixed via `next.config.ts`'s
  `experimental.cpus: 2`. If a build still OOMs with the cap in place on
  the current host, check for leftover `node`/dev-server processes
  before assuming a regression.

---
*Last refreshed: 2026-09-15, phase-end docs pass (Modules 01-08 now
feature-complete for reachable scope; Module 06 close/promotion/
retirement/detection decisions + monthly review, Module 07's engagement
XP ledger, the one weekly notification, Module 08's default-strategy
seed + field-introduction offer, plan-gated-findings honesty fix,
privacy export completeness (JSON + CSV, 40-table registry), and Module
04's discovery-ranked rule editor all landed since the last refresh).
Rewritten against the actual repo tree (`lib/review/`, `lib/engagement/`,
`lib/analytics/{edge-engine,detection-engine}/`, `app/(app)/{review,
strategies,fields}/` all new or substantially grown since the last
refresh), `supabase/migrations/` (33), `docs/adr/` (43 files, numbered
0001-0044 with 0028 never used), and
`docs/infra-gaps.md`/`NEEDS_YOUR_INPUT.md` rather than appended to.
Two claims in `PROGRESS.md`'s own dated Phase-status table were found
stale against the code during this pass (the silent default strategy
and the four-state dashboard are both real, not "left") — corrected in
this file's Module 08 section with the reasoning shown, since this file
is the one place a reader is told to trust the code over a summary line
that's fallen behind it. If you find this file itself stale in some
other way, that's a signal `retrospeq-docs` wasn't dispatched at the
next phase boundary, not that the convention is wrong.*
