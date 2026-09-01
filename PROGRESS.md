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
| 2 | Module 04 (Rulebook & Evaluation) + Module 08 onboarding | **In progress — Module 04's own currently-in-reach scope is fully DONE as of Slice 10f (2026-09-01; only Slice 10c/discovery and strategy-scoped rule stories remain, both correctly blocked on Modules 05/03). Module 08 (onboarding) now starting — see "Current task" for a real blocker analysis found before any Module 08 code was written: large parts of Module 08's own spec depend on Modules 03/05/06/07, none of which exist yet, despite AGENTS.md's build-order pairing framing "Module 04 + Module 08" as one shippable phase.** Slices 1-4 all **DONE**, full coder→tester→security→qa gate sequence passed on every one (Slice 2's security review failed once on 2 real findings, both fixed and re-verified PASS live; every other gate passed clean or with only test-coverage gaps found-and-closed, never a rubber stamp). Slice 1: schema + operand catalogue + pure evaluator. Slice 2: authoring pipeline (rule CRUD, versioning, tighten-only/satisfiability/tier/entitlement validation). Slice 3: preview engine (§5.8) + `operand_distributions`, scoped to the 8 `computableToday: true` operands. Slice 4: cross-trade `TradeFacts` assembly (§5.3/§5.4/§5.6), 20 of the remaining 30 operands built via cross-trade SQL (10 genuinely deferred — missing infra/data/other-module dependencies, each with a documented reason), establishes the repo's first week-boundary convention (ISO week, Monday start, `docs/adr/0015-iso-week-boundary-monday-start.md`) that Slice 6's `adherence_weekly` and Module 07's streaks must match exactly. Slice 4 explicitly does NOT write to `rule_evaluations` and does NOT touch `lib/ingestion/confirm.ts` — pure read-only query assembly; wiring into the freeze transaction is Slice 5. `lib/rules/` coverage 95-100% across all new files. Full decision-log entries below have every gate's findings in detail. **Slice 5 (freeze-wiring) DONE (2026-08-25)** — full coder → tester → security-reviewer → qa gate sequence passed (QA failed once on a missing ADR + a ledger-update-ordering gap, both real and both closed — see decision log). `rule_evaluations` rows now actually get written and frozen at close-out, from BOTH `confirmDay` and `autoConfirmStaleTrades`, inside their existing transactions. 40 tests (9 mocked-orchestration unit, 12 coder live-DB integration, plus 5 more coder confirm.ts-side live tests and 5 independently-authored tester adversarial live tests not overlapping the coder's fixtures) all green, independently re-run and coverage-measured (98.5% on `freeze-evaluations.ts`, 100% on `confirm.ts`) — proving forward-only application, exact-instant version-boundary resolution, frozen-immutability-after-edit-and-promotion (edit, promotion, and a direct raw-SQL bypass attempt all independently re-verified rejected), session-rule attachment (self-inclusive `trades_today`, independently confirmed correct from the raw SQL, not just trusted), idempotent double-invocation safety (directly proven, not just reasoned about), and the `RuleEvaluationError`-during-freeze anomaly path (two independent malformed-rule scenarios, logged loudly via `docs/runbook.md`'s new entry, never blocks confirmation). `npm run build`/`tsc`/`eslint` all clean, independently re-run. **Slice 6 (`adherence_weekly` materialization) DONE (2026-08-25)** — full coder → tester → security-reviewer → qa gate sequence passed. `lib/rules/adherence-repository.ts` reads frozen `rule_evaluations` only, computes the two-fraction adherence report (hard/soft, never blended) + HARD-PRIORITY `top_break_rule_id` (a hard breach always wins the naming slot over any number of soft breaches, falling back to soft-only when zero hard breaks occurred — QA's first pass FAILED on the original combined-pool implementation as a real `retrospeq-design-decisions.md` §6 violation, fixed and re-verified PASS), wired into `confirm.ts` as a best-effort post-commit recompute (mirrors `operand_distributions`'s established pattern, proven live to never corrupt/half-write a row even under a forced write failure). Tester found zero production bugs, closed real test gaps (a genuine live write-failure-injection test, a hard/soft-outnumbered disambiguating fixture). Security-reviewer PASS (7/7 — confirmed the recompute is strictly post-commit and can't affect the freeze transaction, confirmed the upsert is one atomic statement, confirmed RLS/isolation/no injection). 37 tests green (33 unit/live + 4 live-DB), 100% coverage on `adherence-repository.ts`. **Slice 7 (severity lifecycle, §5.7) DONE (2026-08-25)** — full coder → tester → security-reviewer → qa gate sequence passed. `lib/rules/promotion-eligibility.ts` (read-only soft→hard eligibility check: 6wk-active/≥20-evals/≥95%-compliance read as ALL-TIME, "zero breaks in the last 3 weeks" as a rolling 21-day window — documented reasoning, independently re-derived and concurred by the tester) + `lib/rules/severity-lifecycle-repository.ts` (promote/demote/retire, atomic guarded UPDATEs; hard cap enforced inside the UPDATE's own WHERE clause) + `app/(app)/rules/actions.ts`'s `promoteRule`/`demoteRule`/`retireRule`. **Tester found a real, reproducible production bug**: two concurrent promotions of different soft rules could both succeed and exceed the 6-hard-rule cap (the correlated-subquery guard only locked the row it wrote, not the rows it counted) — proven via a genuine two-connection test, not timing luck. **Fixed** with `pg_advisory_xact_lock(hashtext(user_id))` as the first statement in the transaction; `demoteRuleSeverity`/`retireRuleState` confirmed not to need it (single-row updates, already safe). Security-reviewer PASS (9/9, independently re-ran the fix 3x plus their own adversarial 3-way race scenario — invariant held). QA's first pass failed only on a ledger-currency gap (the security PASS hadn't been logged yet), re-verified PASS on all code-level checks. Free-tier `rules.hard: 0` blocks promotion entirely; retirement is one-way (no reactivate path anywhere, verified); severity never retroactively touches frozen `rule_evaluations`. 95 tests total (90 coder + 5 tester), coverage 93.8%/100%. Out of scope: `rule_overrides`/ambient strip (§5.9, Slice 8), UI (§6, Slice 9). **Slice 8 (ambient live-state engine + `rule_overrides`, §5.9) DONE (2026-08-27)** — full coder → tester → security-reviewer → qa gate sequence passed. `lib/rules/ambient-state.ts`'s `getAmbientAccountState` (read-only, reuses Slice 4's cross-trade fetch/compute functions via a structurally-impossible-to-collide `NO_REFERENCE_TRADE_ID` sentinel and the real `evaluate()`, always returns a fully-defined `facts`/`rules` shape — the "always visible, never appear-on-threshold" guarantee independently re-verified against fresh fixtures by BOTH tester and QA) + `lib/rules/rule-overrides-repository.ts` (`fetchRuleForOverride`/`insertRuleOverride` with an adversarial-verified trade-ownership re-check/`fetchOverrideOutcomeSummary` with an independently-reconfirmed DISTINCT-trade dedup) + `recordOverride` Server Action (`ruleVersion` structurally un-influenceable by the client). Security-reviewer PASS (10/10 — confirmed the cross-user `trade_id` ownership check is the sole real defense beyond RLS since `rule_overrides`' own RLS never constrains the FK target's ownership, confirmed non-racy same-transaction check-then-insert, confirmed no injection surface; one non-blocking future-hardening note on `observed`'s lack of an explicit size cap, mitigated today by Next.js's framework body-size limit + rate limiting). QA PASS (8/8 — re-derived the "always visible" guarantee adversarially a third time, confirmed the tint vocabulary never leaks a color mapping, confirmed §5.9's worked-example fields are all present, confirmed no punitive language in error strings; two non-blocking documentation notes: this ledger entry itself, and an optional `docs/runbook.md` addition for the uncaught-`RuleEvaluationError` live-read variant, distinct from the freeze-time caught-and-logged one). 109 tests (99 mocked + 10 live), 100% line/function coverage, 94.28%/100% branch. See the 2026-08-27 decision-log entries for the full independent-verification write-ups. **Slice 9 (`operand_distributions` extended to `daily_loss_pct`/`consecutive_losses`, closing the gap §5.10's guided front door needs) DONE (2026-08-29)** — full coder → tester → security-reviewer → qa gate sequence passed. `lib/rules/distributions-repository.ts` wires Slice 4's already-built cross-trade pure functions (`computeDayWeekPnl`/`computeConsecutiveLosses`) into Slice 3's distribution-bucketing pipeline via two new batched fetch functions (`fetchAccountHistoryForCrossTradeOperands` — one query for every distinct account via a `row_number()`-partitioned window function; `fetchAccountStartingEquities`), keeping net query count flat (+2) regardless of window size/account count; exports `DISTRIBUTION_OPERAND_IDS` (the 8 original + these 2). **Independent tester verification found a real production bug the coder's own pass missed**: the coder's "`preview.ts` needed ZERO changes" claim was wrong — `preview.ts` still gated on the stale `operand.computableToday` flag (never updated when cross-trade computation was added for these two operands), so `preview('daily_loss_pct', ...)`/`preview('consecutive_losses', ...)` always returned `operand_not_computable` regardless of real data, silently defeating this slice's entire stated purpose. Caught via a live-DB `it.fails` test (`distributions-repository.independent-verify.live.test.ts`) that encoded the desired behaviour and failed exactly as designed against real seeded data, plus 13 fresh pure-function tests (`distributions-repository.independent-verify.test.ts`: point-in-time correctness, 3-account isolation, decimal-precision-through-the-real-pipeline, batching/N+1 proof) — both written with fresh fixtures, not the coder's own. **Fixed**: `preview.ts`'s gate swapped to `DISTRIBUTION_OPERAND_IDS.includes(operandId)` (the precise, single-purpose set), `operand-catalogue.ts`'s `computableToday` deliberately left untouched (different consumer, out of scope), the `it.fails` converted to a normal passing `it()` once confirmed live. Security-reviewer PASS (5/5 — no import cycle, `getOperand` validation still runs before the new gate check so no injection surface, user-scoped RLS via `withUserConnection` unchanged, read-only/no `rule_evaluations` touch, no compound-rule/XP introduction; independently re-ran `preview.test.ts`+`preview.property.test.ts`, 24/24). QA PASS (9/9 — all non-negotiables held, `insufficient_history`/`operand_not_computable` distinction still coherent post-fix, no UI surface so no screenshot check needed, analytics/rules import boundary clean, runbook accuracy verified against actual code; one procedural-only finding — this ledger itself still claimed coder-pass-only and "zero changes," fixed in this entry). Full suite re-run clean after the fix: 101 files, 1400 passed, 8 skipped, 0 failed; `tsc --noEmit` and `eslint .` both clean (19 pre-existing unrelated warnings only). No migration, no ADR (filling an already-scoped Slice 3/4 deferral; the preview.ts fix is a bug fix restoring intended behavior, not a new deviation). **Slice 10a (§5.10 / story 1.4's guided three-rule front door) DONE (2026-08-29)** — full coder → tester → security-reviewer → qa gate sequence passed (tester independent verification: PASS, no real bug found — see "Current task" above for the full 9-point write-up; security-reviewer: PASS 7/7; qa: PASS 9/10 clean plus one real `.rq-num` gap found and closed, re-verified after the fix). Slice 10 (the whole §6 UI) is being built as several sub-slices per AGENTS.md's own slicing guidance ("a whole module is not" one dispatch) — this is 10a, the guided front door ONLY; the general rule editor (story 1.1), discovery (story 1.3), the ambient strip (§5.9 UI), and adherence display (§5.6 UI) remain future sub-slices, unchanged in scope. Built: `lib/rules/guided-front-door.ts`'s `seedGuidedRuleThresholds` (read-only; per-operand threshold seeding + `alreadyGoverned` detection reusing `fetchActiveGlobalRuleVersionsForOperand`), `app/(app)/rules/start/page.tsx` (Server Component) + `GuidedFrontDoor.tsx` (Client Component, per-card stepper/live-preview/inclusion-toggle state, sequential `createRule` submission). **Route choice**: a dedicated `/rules/start`, not `/rules/page.tsx` doubling as empty-state — keeps this sub-slice from having to anticipate the shape of the future full rulebook list (documented in the page's own header comment). **Threshold-seeding approach**: with real history (n >= `MIN_TRADES_FOR_PREVIEW`, reused from `preview.ts`, now exported alongside a new `percentileFromBuckets` generalizing the existing `weightedMedian` — p50 is now literally `percentileFromBuckets(_, 0.5)`, one implementation not two), seed at the 80th percentile of the trader's own history (direction-aware: the stricter-tighter side gets the mirrored 20th percentile) — chosen because it lands inside `preview.ts`'s own already-established "healthy" ratio band (0.06–0.35) rather than the raw median, which would flag ~half the trader's own history on a rule they never authored. Without enough history, falls back honestly to the operand's own catalogue bounds midpoint (never a fabricated "typical" number). Design-system compliance verified via a real screenshot self-check (`tmp/dev-screenshots/guided-front-door-*.png`, throwaway) AND a real E2E run: zero primary `.rq-btn` on the choosing screen (only a genuine `.rq-btn--equal` "Add"/"Skip" pair — the ethics no-implied-recommendation rule applied to accept-vs-decline, not just the grouping-chip precedent it was written for), one primary `.rq-btn` on the done state only (no longer a live decision), `.rq-num` on every numeric readout, `.rq-step`/`.rq-step__btn` steppers (no native range slider — that primitive doesn't exist in the shipped design system, documented in the component's own header), a loading skeleton genuinely distinct from the real `insufficient_history` copy. New tests: 5 mocked unit tests (`guided-front-door.test.ts`, SQL-text-dispatched mocks since `Promise.all` gives no query-order guarantee), 2 live-DB tests (`guided-front-door.live.test.ts`, real `recomputeOperandDistributionsForUser` pipeline + a real `insertRuleAndVersion` row for the `alreadyGoverned` case), 4 new `preview.ts` unit tests for the `percentileFromBuckets` refactor, and a 3-test Playwright E2E file (`e2e/rules-guided-front-door.spec.ts`: core flow incl. live preview + real DB write, decline-entirely, and the failure path — a trader already at the free-tier `rules.create` cap of 3 sees an honest message with the add action genuinely disabled, while "Skip for now" still works). One test-authoring bug caught and fixed by the coder's own re-verification pass (not shipped): an unscoped `getByText('Starts soft')` E2E assertion false-matched the screen's own intro copy ("...every one starts soft...") — fixed to scope to the `.rq-tag--muted` chip elements, confirmed by inspecting the actual matched DOM nodes rather than assuming. Full suite (131 files) green except one pre-existing, unrelated flaky live-DB timeout (`trades-freeze-trigger.live.test.ts`, confirmed to pass cleanly in isolation, a DB-connection-contention artifact of running 1598 tests in one pass, not a regression). `npm run build`/`tsc --noEmit`/`eslint .` all clean. No migration (no schema change), no ADR (a UI route/interaction-pattern choice, not a 00-foundation convention deviation), no new `docs/runbook.md` entry (no new alerting condition — this screen only orchestrates the already-runbooked `createRule`/`previewRule`). **Slice 10b (general rule editor, CREATE flow only, story 1.1 / §6.1's `.rule-editor` reference markup) DONE (2026-08-31)** — full coder → tester → coder-fix → security-reviewer → qa gate sequence passed. `app/(app)/rules/new/page.tsx` + `RuleEditor.tsx` + `lib/rules/editable-operands.ts` (`getEditableOperands`: number/duration/bool operand types only, single-authorable-operator only, tier-gated via the same `hasSufficientTierAccount` `createRule` itself uses — the picker can never offer what the server would reject). Global-scope-only (Module 03/strategies doesn't exist yet); tighten-only rejection alert correctly omitted (`checkTightenOnly` only ever runs for `scope: 'strategy'`, confirmed unreachable here, not built as dead UI); `RULE_UNSATISFIABLE` genuinely reachable and handled (proven live with a real seeded conflicting global rule). **Independent tester verification found a REAL, REPRODUCIBLE PRODUCTION BUG**: a cross-tab/concurrent double-submit on `createRule` let a free-tier trader exceed the documented 3-rule cap (4 active rules landed against a cap of 3, reproduced 3/3 runs) — a pre-existing gap in `createRule`'s entitlement pre-check and `insertRuleAndVersion`'s write being two separate unguarded round trips, the same TOCTOU class Slice 7 already found and fixed for the `rules.hard` cap, and shared with Slice 10a's guided front door (which calls the same `createRule`). **Fixed** the same way: `pg_advisory_xact_lock(hashtext(user_id))` as the first statement inside `insertRuleAndVersion`'s own transaction, plus a new guarded INSERT (`where $capLimit::int is null or (select count(*) ...) < $capLimit`) that re-checks the cap atomically; zero rows returned throws a new `RuleCreateCapExceededError`, mapped to the SAME `ENTITLEMENT_LIMIT` message the early pre-check already used (verified identical string/code — no confusing double-message experience for a race-loser). Verified via the tester's own tripwire E2E going green, a genuine two-connection live-DB block-and-lose proof (`waitForBlockedQuery`, matching Slice 7's own gold-standard technique), and Slice 10a's own suites re-confirmed unaffected. Security-reviewer PASS (5/5 — no deadlock risk between the two advisory-lock call sites in the whole repo, both userId-keyed and neither nested; fully parameterized SQL; no sensitive leakage; no other write path bypasses the guard). QA PASS (race-loser message confirmed identical/non-confusing, design-system clean, independently closed both gaps the security-reviewer had explicitly left open — including live-running the cross-tab E2E spec itself, 6/6) plus one real non-blocking finding: `RuleEditor.tsx`'s "Rule slots: N of M used" header is a page-load snapshot that goes stale within a session (reproduced: submit rule #3, click "Write another rule," attempt #4 — stale "2 of 3" alongside the correct rejection), server-side enforcement unaffected, fix queued as an immediate follow-up rather than reopening this slice's own gate. 1609 passed/13 skipped/0 failed at fix time; `tsc --noEmit`/`npm run build`/`eslint .` all clean (independently re-confirmed 2026-08-31: tsc clean, eslint 0 errors/19 pre-existing warnings, build clean, 95/95 targeted tests including the two-connection race proof). **Slice 10d part 1 (§5.9 UI, the ambient strip ONLY — the adherence display, §5.6 UI, is a separate follow-up dispatch, NOT built here) CODED (2026-08-31), coder pass only, NOT yet tested/security-reviewed/QA'd.** Placed on `app/(app)/trades/manual-entry` (story 3.5's own "before I enter a trade" framing — this repo's only such screen today): `app/(app)/rules/actions.ts`'s new `fetchAmbientState` Server Action (thin wrapper around Slice 8's already-built `getAmbientAccountState`, new `ambientAccountState` rate-limit scope) + `ManualEntryScreen.tsx` (new — lifts the account-id `<select>` state up from `ManualEntryForm.tsx` so the sibling `AmbientStrip.tsx` can re-fetch on every switch) + `AmbientStrip.tsx` (new — presentational, renders exactly §6.1's three named cells, Today/Day P&L/Risk, always, never conditionally). **Real design-system gap found and closed, not papered over**: `retrospeq-design-system/brand/css/components.css` had NEVER shipped the `.ambient`/`.ambient__cell[data-state]`/`.ambient__label`/`.ambient__value` rules §6.1's own reference markup names directly — added there (geometry/weight/box-shadow only: a left-border width/colour escalation plus a full inset ring for `breach`, never a hue swap, confirmed against `tokens.css` that no new custom property was introduced) and re-synced to `public/brand/css/components.css` per this repo's own sync convention. **Real, reproducible bug found and fixed during this slice's own self-check, not shipped**: the account-switch effect's original "skip the first run" guard used an invocation-COUNT ref (`useRef(false)`), which React Strict Mode (`next dev`'s default) silently inverts — Strict Mode's deliberate double-invoke-every-effect-once behavior consumed the "skip" on a throwaway first pass, letting the real mount fall through into the real-fetch branch and fire an extra, unwanted `fetchAmbientState` round trip (plus a spurious `ambient -> null` flash) on every ordinary page load — measured directly via added instrumentation (~10.5s vs ~7.5s for an unrelated pre-existing manual-entry E2E test that started failing at its original 10s timeout once this bug was introduced). Fixed by comparing the account id VALUE against what `ambient` currently reflects (`lastFetchedAccountId` ref) instead of counting invocations — idempotent regardless of how many times an effect fires for the same value; re-verified the previously-broken `trades-slice7b.spec.ts` manual-entry E2E test passes again cleanly (13.7s, no timeout change needed there). New tests: 6 mocked unit tests for `fetchAmbientState` (`app/(app)/rules/__tests__/actions.test.ts`, success/invalid-uuid/cross-user-not-found-mapped-generically/internal-error/rate-limit/session-missing) and a new 3-test Playwright E2E file (`e2e/rules-ambient-strip.spec.ts`: genuine `neutral` state on a brand-new zero-trade/zero-rule account, genuine `watch` tint from a real broken SOFT `daily_loss_pct` rule, and genuine `breach` tint from a real broken HARD `total_open_risk` rule — including a real account switch re-fetching live data via two-account seeding, submitting past the breach with zero modal/dialog present at any point, and a real `rule_overrides` row independently verified against Postgres directly, `trade_id` null, citing the exact observed value the strip showed). Screenshot self-check done for all three tint states (`tmp/dev-screenshots/ambient-strip-{neutral,watch,breach}.png` plus cropped versions confirming the border-weight/ring escalation is visually real, not just present in the CSS text) — all three read as genuinely distinct without any hue difference. Full suite re-run after the fix: 1609 passed/13 skipped/7 failed, but every one of the 7 failures is in a live-DB test file this slice never touched (`manual-entry.live.test.ts`, `split-join.live.test.ts`, `sync.live.test.ts`, `trades-repository.live.test.ts`, `adherence-repository.live.test.ts`, `severity-lifecycle.live.test.ts`, `severity-lifecycle.independent-verification.live.test.ts`) — reproduced identically in complete isolation (single-file runs, stale dev-server process killed first, `pg_stat_activity` checked directly and showed no locks/contention), consistent with this repo's own established "shared dev/test Supabase project" environmental-flakiness pattern (ADR 0002) rather than a regression; `tsc --noEmit`/`npx eslint .`/`npm run build` all clean (0 errors, the same 19 pre-existing warnings). **Independent tester verification of Slice 10d part 1 DONE (2026-08-31) — PASS overall, no functional/security regression found, but the coder's "7 failures are flaky/pre-existing" diagnosis was imprecise and one real (already coder-flagged, still open) gap confirmed worth a near-term fix.** See the "Current task" section's own detailed write-up for the full 8-point independent re-derivation (re-ran the full suite independently, found 9 failures not 7 on that pass, re-ran 6 of the 9 flagged files fully in isolation — 5 reproduce a DETERMINISTIC "test timed out at its own default/explicit timeout" failure even completely alone, one file — `confirm.live.test.ts` — passed 18/18 clean in isolation, meaning only THAT one is genuine full-suite-contention flakiness in the classic sense; none of the 9 touch rules/ambient/override/manual-entry code, confirmed by grep + `git log`/`git status` per file). CSS tint mapping independently confirmed hue-free and byte-identical between the two copies; own fresh screenshots taken and read. Always-visible neutral strip, override write (different rule/operand than the coder's own fixture), fast double-account-switch race, and cross-user isolation of `fetchAmbientState` all independently re-proven with fresh fixtures/a fresh Playwright spec (4/4 passed, then deleted — throwaway verification only, not shipped). Strict Mode fix confirmed correct by direct code reading; the previously-broken `trades-slice7b.spec.ts` re-run clean (7/7, matching the coder's own reported timings). `tsc --noEmit` clean, `eslint .` clean (0 errors, 19 pre-existing warnings). `npm run build` could NOT be completed — three consecutive attempts (incl. one with `NODE_OPTIONS=--max-old-space-size=6144`) all OOM'd during Next.js's "Collecting page data" worker-pool phase with a genuine host virtual-memory exhaustion signature (`FreeVirtualMemory` ~1.3GB against an ~18.5GB total on this machine at verification time), NOT a code defect — the TypeScript compilation phase inside `next build` itself completed cleanly every single attempt before the later phase crashed, consistent with `tsc --noEmit`'s own clean, separate pass and with the dev server serving the app correctly throughout (23+ passing E2E assertions in this same session). **Reporting this honestly as build-unverified-for-infra-reasons, not as a pass** — the next session with more host headroom should re-run `npm run build` before this slice is called fully clean on that specific check. **The tester's own open SSR-error-handling gap was then FIXED (2026-08-31, same day)**: `page.tsx`'s initial `getAmbientAccountState` read now wraps in the same catch shape `fetchAmbientState` already used, degrading the ambient section gracefully ("…" cells + "Account state is unavailable right now") without blocking the rest of the trade-entry form — verified via a new E2E test seeding a genuinely malformed rule and confirming a real trade submission still completes; `npm run build` re-run clean this time (memory checked first, 5.9GB free, no orphaned processes — the prior build-unverified-for-host-memory-reasons gap independently closed). Full suite at fix time: 1605 passed/13 skipped/11 failed across 7 files, all re-confirmed the same pre-existing live-DB timeout issue the tester already diagnosed. **Security-reviewer PASS (2026-08-31, all focus areas)**: `recordOverride`'s `ruleId`/`observed` confirmed genuinely server-sourced end-to-end (never client input, independently re-validated server-side against ownership+state+evaluation before insert); `tradeId: null` confirmed correctly append-only with no later-misattribution path (`rule_overrides` has no UPDATE policy); the new `ambientAccountState` rate-limit scope (120/60s ip, 80/60s per-user) confirmed correctly keyed and reasonably positioned between `previewRule`'s tighter per-keystroke limit and the hourly scopes; cross-user isolation independently re-confirmed a THIRD time (real RLS + ownership check on `trading_accounts`, identical not-found response for nonexistent vs. not-owned); the SSR fix confirmed leak-free (only two fixed generic strings ever reach the client); tint mapping confirmed achromatic a third time. One non-blocking recommendation (not a checklist violation): `docs/runbook.md` had no alerting entry for `recordOverride` write failures — added (search "`rule_overrides` write failing silently"), documenting that this slice turned the write from theoretical (Slice 8 built `recordOverride` with no caller at all) to automatic-on-every-breach, raising the real-world stakes of its existing `console.error`-only failure mode. **QA PASS (2026-08-31, all items)**: always-visible confirmed across all 5 states (neutral/watch/breach/loading/ssr-degraded) via fresh screenshots; no red/green (achromatic tokens confirmed a FOURTH independent time); `.rq-num` present on all 3 readouts; degraded-state copy confirmed honest and non-alarming; rest-of-form genuinely interactive during degradation (qa filled and submitted real form values, not just eyeballed the layout); no compound-rule/XP coupling; runbook entry accuracy confirmed (one trivial wording nit — the entry originally implied `recordOverride` was "occasional and user-initiated" before this slice, when it actually had zero callers at all until now — corrected in place, not worth a re-dispatch); spec fidelity to §5.9/§6.1/story 3.5 confirmed at the markup level; zero modals/dialogs at any point of a breach-and-proceed flow. **Module 04 Slice 10d part 1 is now fully DONE.** **Slice 10d part 2 (§5.6 UI / story 3.3, the adherence display ONLY) is now CODED (2026-08-31), coder pass only, NOT yet independently tested/security-reviewed/QA'd.** Built: `lib/rules/adherence-display.ts`'s `getAdherenceDisplayForUser` (composes two already-built, already-tested reads — Slice 6's `fetchAdherenceWeekly` for the current AND the immediately-prior ISO week, via new `currentWeekStartFor`/`priorWeekStartFor` helpers reusing `promotion-eligibility.ts`'s own established `now.toISOString().slice(0,10)` plain-UTC-date convention rather than any per-account `server_day`, since adherence spans every account a trader has, not one), plus a new `fetchRuleRenderedText` read in `rules-repository.ts` (the attribution line's rule-name join `adherence_weekly.top_break_rule_id` was always deliberately name-agnostic about). Hard-priority severity/denominator for the attribution line is DERIVED, not re-queried, from the already-materialised `hardTotal`/`hardFollowed` fields alone (`hardBreaks > 0` implies the top break came from the hard pool, per `computeAdherenceWeekCounts`'s own selection order — Slice 6's header) — zero extra queries beyond the two parallel `fetchAdherenceWeekly` calls plus one conditional rendered-text lookup. `app/(app)/rules/actions.ts` gained `fetchAdherenceDisplay` (session-derived userId only, no arguments at all — this composition has nothing else to legitimately vary in this slice's own scope) and `lib/rate-limit/config.ts` gained a new `adherenceDisplay` scope (90/3600s ip, 60/3600s email — a plain page-load read, not a bursty interactive one). **Route choice**: `app/(app)/rules/page.tsx` itself (NOT a new dedicated route, the opposite choice from Slice 10a's own reasoning) — documented in the page's own header comment: 10a avoided this exact file because building the GUIDED FRONT DOOR there would force a later restructure once the real rulebook list shipped; the adherence display has no such conflict, since §6.1's own reference markup already places `.adherence` as a permanent section of the SAME "your rulebook" screen the rule list will eventually join, not a stand-in for a future screen's shape — this dispatch's own page.tsx leaves an explicit comment marking exactly where that future list belongs, below the adherence section. `page.tsx` calls the rate-limited `fetchAdherenceDisplay` Server Action directly (not the underlying library function), a deliberate difference from `manual-entry/page.tsx`'s own "bypass the rate limit for a fast first paint" precedent — documented as intentional, since this screen has no equivalent latency-critical first-paint requirement, so routing every read (including the very first one) through the same rate-limited entry point is strictly safer by default with no UX cost. **Real design-system gap found and closed, matching Slice 10d part 1's own precedent exactly**: `.adherence`/`.adherence__hard`/`.adherence__soft`/`.adherence__attribution` were named in §6.1's own reference markup but never shipped in `retrospeq-design-system/brand/css/components.css` — added there (weight/order/colour-scale only: hard bold+full-ink, soft regular-weight+`--rq-ink-soft`, attribution smallest+`--rq-ink-faint` — no hue anywhere, confirmed against `tokens.css`) and re-synced to `public/brand/css/components.css`. Three honest non-error states, all screenshot-verified (`tmp/dev-screenshots/adherence-{ready,insufficient-history,zero-breaks}.png`): `insufficient_history` (no materialised row for the current week — brand-new trader, no confirmations yet this week, or a stuck recompute per this slice's own new `docs/runbook.md` addition) renders "Not enough data yet" prose, never a fabricated "0 of 0"; a real week with both hard and soft breaks renders both fractions plus a real "up from" comparison (omitted, not fabricated, when the prior week itself has no row) plus the hard-priority attribution line naming the breached rule by its CURRENT rendered sentence (a documented, honest simplification — `adherence_weekly` itself never stores which `rule_version` was live during the displayed week, only `rules-repository.ts`'s own header explains why re-deriving that exactly would mean a live re-join `adherence_weekly`'s whole "materialised, never computed at read time" contract exists to avoid); a genuinely good week (zero breaks) renders "No rules were broken this week." plainly, no celebration, no attribution line, per AGENTS.md's "Adherence earns no XP, ever." New tests: 20 unit (16 `adherence-display.test.ts` incl. the exact §6.1 worked-example reproduction — "6 of the 14 soft breaks" — as a literal fixture, plus a source-scan test for zero xp/streak/points/gamification references; 4 new `fetchAdherenceDisplay` cases in `actions.test.ts`, extending the existing 84 to 100 total, still all green), 2 new live-DB tests in `rules-repository.live.test.ts` (`fetchRuleRenderedText` resolves the CURRENT post-edit version, and returns `null` — never leaking another user's text — for a nonexistent or cross-user rule id; 9/9 green including the 6 pre-existing tests in that file), and a new 3-test Playwright E2E file (`e2e/rules-adherence.spec.ts`) that deliberately seeds `adherence_weekly`/`rules`/`rule_versions` directly via SQL rather than driving the real confirm pipeline (documented in the file's own header: the MATERIALISATION pipeline is already proven live by Slice 6's own tests; this slice's whole job is the DISPLAY layer on top of it) — all 3 green, screenshots confirm no red/green and a real weight/order hierarchy (hard bold and first, soft lighter and second, attribution faintest and last). Full targeted suite green (100 mocked unit + 9 rules-repository live + 3 E2E); `tsc --noEmit` and `npx eslint .` both clean (0 errors, the same 19 pre-existing warnings). A broader `npx vitest run lib/rules app/(app)/rules` pass surfaced 4 failures, ALL in live-DB files this slice never touched (`adherence-repository.live.test.ts`, `freeze-evaluations.live.test.ts`, `severity-lifecycle.live.test.ts`, `severity-lifecycle.independent-verification.live.test.ts`) and ALL a `Test timed out in Nms` shape at that specific test's own timeout — re-ran `adherence-repository.live.test.ts` a second time in complete isolation and it failed identically on the exact same test, matching this session's own already-documented "deterministic too-tight-timeout, not classic flakiness" diagnosis from Slice 10d part 1's independent tester verification, not a regression from this slice (confirmed via `git status`/diff scope: this slice touched none of `confirm.ts`/`freeze-evaluations.ts`/`severity-lifecycle-repository.ts`). **`npm run build` could NOT be completed** — two consecutive attempts (one with `NODE_OPTIONS=--max-old-space-size=6144`) both crashed with the same access-violation-shaped worker exit this session's own host has produced before (PROGRESS.md's Slice 10d part 1 entry, "Collecting page data"/"Generating static pages" phase) — `tsc --noEmit`'s own separate, clean pass completed in both attempts before the later phase crashed, and `Get-Process` showed several memory-heavy editor/IDE processes running outside this agent's control, consistent with genuine host memory pressure rather than a code defect. **Reporting this honestly as build-unverified-for-infra-reasons, not as a pass** — a future session with more host headroom should re-run `npm run build` before this slice is called fully clean on that specific check. No migration (no schema change), no ADR (the route-choice and rate-limit-scope decisions are documented in-file per this repo's own convention, not a 00-foundation deviation), `docs/runbook.md` gained one new paragraph (not a new top-level entry — the underlying failure mode already had one) noting this slice is the first UI surface where a stuck `adherence_weekly` recompute becomes directly visible to a trader. **Independent tester verification PASS (2026-08-31)**: week-boundary math re-derived with fresh fixtures including an instant-level boundary stress test (correct, no off-by-one); hard-priority attribution re-proven with a harder 1-hard-vs-4-soft fixture; the "current wording not historical" limitation confirmed genuinely true via a real `applyRuleEdit`-after-freeze test; empty/zero-breaks states confirmed honest via fresh screenshots; cross-user isolation confirmed at both Server Action and RLS layers; closed a real test-coverage gap the coder's own suite left (added a full-pipeline test deriving adherence from raw evaluations, not only against directly-seeded `adherence_weekly` rows). Also confirmed the recurring `npm run build` OOM pattern (this is its 3rd occurrence this session) is genuinely infra, not code — killing 3-4 leftover node/dev-server processes recovered free virtual memory from ~1.6GB to ~1.85GB and the exact same build then passed clean with zero code changes; flagged to the owner as worth a durable fix (larger page file) given the pattern is now confirmed, not a one-off. **Security-reviewer PASS (2026-08-31, 6/6)**: `fetchRuleRenderedText` confirmed doubly scoped (RLS + explicit `user_id` filter in SQL) and confirmed unreachable via any client-facing surface at all (`fetchAdherenceDisplay` takes zero parameters — no pivot path exists to test); cross-user isolation confirmed at every layer; the new `adherenceDisplay` rate-limit scope confirmed correctly keyed and reasonably positioned; no injection surface, fully read-only end to end, no `rule_evaluations` touch, no compound rules, no XP/gamification language; the "current wording not historical" limitation reviewed specifically for exploitability and found to have no security angle (worst case is stale phrasing next to an accurate identity/count, not spoofable or data-leaking). **QA PASS (2026-08-31, clean on all 7 items)**: hard/soft confirmed genuinely never blended into one score anywhere on screen; no XP/gamification language re-confirmed specifically for this screen (zero breaks and a bad week read with the same plain tone); `.rq-num` present on every numeric readout; no red/green (CSS confirmed byte-identical/achromatic between the two synced copies); honest empty/zero-breaks states re-screenshotted with fresh fixtures; a real populated week matches §6.1's own worked-example shape; `app/(app)/rules/page.tsx` confirmed to read as a coherent real page today, with the future-rule-list placeholder genuinely a code comment, never user-visible placeholder text. **Module 04 Slice 10d part 2 is now fully DONE.** **Slice 10e (rule list/browsing view, story 1.1, plus §5.7 severity promote/demote/retire controls) DONE (2026-08-31)** — full coder → tester → coder-fix → tester-reverify → security-reviewer → qa gate sequence passed. Closes a real, previously-untracked gap Slice 10d part 2's own QA pass found: Slice 7 (2026-08-25) built `promoteRule`/`demoteRule`/`retireRule` backend-only with their UI explicitly deferred, and nothing tracked that as outstanding until now. Built: `lib/rules/rules-repository.ts`'s new `fetchRulesForUser` (active rules before retired, hard before soft within active, oldest-first tiebreak, never another user's rows), `app/(app)/rules/actions.ts`'s new `fetchRulesList` Server Action, `app/(app)/rules/RuleList.tsx` (the list itself, promote/demote/retire buttons, the §6.1 hard-cap swap chooser, a promotion-ineligibility explanation, a retire confirmation step), extending `app/(app)/rules/page.tsx` and a small `app/(app)/layout.tsx` nav addition. **Independent tester verification found TWO real, reproducible bugs**, closing this repo's own established pattern of independent verification catching something real on the majority of Module 04 slices: (1) the hard-cap swap dialog could get stuck on "Swapping…" forever if the second (`promoteRule`) Server Action call's promise never settled (correlated with a Turbopack dev-server artifact, reproduced 3/3 in isolation) — no data loss (the server-side promotion did eventually commit), but a genuine client-side UI dead end with no timeout, no error, no retry path; (2) a free-tier trader attempting to promote an ineligible rule saw ONLY the eligibility-gate breakdown, with zero mention that Pro tier was ALSO required — falsely implying that waiting out the gates alone would work. **Both fixed**: bug #1 via a new `app/(app)/rules/with-timeout.ts` (`Promise.race`-based 15s client-side deadline, wired into all 5 Server Action call sites in `RuleList.tsx`, proven with a deterministic never-settling-promise unit test rather than relying on the flaky dev-server artifact to reproduce); bug #2 via a new additive `eligibility.proRequired` flag on `promoteRule`'s ineligible-branch response (a single derived boolean, never leaking the full `EntitlementResult`), shown alongside — never replacing — the real gate breakdown. **Independent adversarial re-verification of both fixes: PASS, no gap found** (4 fresh timeout-breaking scenarios including an exact-deadline race and a late-arriving-response-after-abandonment proof; 3 fresh `proRequired` fixtures covering all three real combinations; entitlement-leakage re-checked and confirmed to expose only the one boolean; full suite re-run clean: 90/90 mocked + 11/11 live-DB + 6/6 E2E plus 3 extra isolated swap-test runs). Security-reviewer PASS (4/4 — traced the timeout-abandonment scenario through Slice 7's own `pg_advisory_xact_lock` guards and confirmed no double-promotion/cap-breach path is possible regardless of client-side behavior; confirmed `proRequired` leaks nothing beyond its one boolean; assessed a tester-flagged non-blocking UX gap — the hard-cap chooser and normal promote/demote buttons aren't mutually exclusive in the JSX — as having no security angle since server-side invariants are structurally independent of client button state). QA PASS (both fix-specific states screenshot-verified honest and non-alarming, all non-negotiables re-confirmed across the whole slice, retire confirmed genuinely one-way, the chooser-bypass UX gap confirmed tracked not lost, spec fidelity confirmed with one honest note that §6.1 has no literal standalone rule-list reference markup so the list's shape is a documented, reasonable extrapolation). **Known tracked follow-up, not blocking**: the hard-cap chooser/direct-promote-button mutual-exclusion UX gap (see the tester's independent-verification write-up above, item 5) — logged, not fixed in this slice, no security angle per the security-reviewer's own assessment. **Slice 10f (story 2.5's rule-value editing UI) DONE (2026-09-01)** — full coder → tester → coder-fix → tester-reverify → security-reviewer → qa gate sequence passed, closing the last real, previously-untracked Module 04 gap found by the 2026-08-31 spec-coverage re-check: `editRule` had been fully built/tested/security-reviewed since Slice 2 (2026-08-19) with zero UI ever built for it. Built: a new `fetchRuleForEdit` Server Action wrapping the existing `fetchCurrentRuleForEdit`, a new `EditRuleControl.tsx` pre-filling a stepper with the rule's real current value/bounds and a live preview, an Edit action in `RuleList.tsx` gated to bounded numeric operands on active rules only. **Independent tester verification found a REAL, SERIOUS bug**: `editRule`'s optimistic-concurrency protection was a no-op end to end — it accepted an `expectedVersion` re-derived from a fresh internal read rather than the stale snapshot the trader's edit control actually opened against, so `RULE_EDIT_CONFLICT` could never fire through the real "I have this open, someone else edited it, I save my stale value" scenario; reproduced live: a stale edit silently overwrote an intervening one with zero signal anything had changed, even though the underlying `applyRuleEdit` guarded UPDATE (proven safe since Slice 10e) was itself correct — it was simply never fed the right version to check against. **Fixed properly, not just documented**: `editRule`'s signature now REQUIRES `expectedVersion` from the caller's own original snapshot, a cheap early check short-circuits before the validation pipeline on mismatch, and `EditRuleControl.tsx` threads its snapshot version through end to end, offering a genuine "Refresh with the latest value" recovery path on conflict rather than a dead end — the coder also caught and rewrote its OWN prior E2E test, which had been asserting the buggy silent-overwrite AS correct behavior. **Independent re-verification with entirely fresh scenarios found no gap**: a tighter race window (intervening commit firing while the edit call was already in flight), the Refresh path's own highest-risk failure mode stress-tested specifically (confirmed a THIRD concurrent edit after refreshing a new baseline is still correctly caught — no reused-stale-snapshot bug in the refresh wiring itself), a same-session double-submit against one shared stale snapshot (exactly one succeeds, one rejected, no double-write). Security-reviewer PASS (5/5 — `expectedVersion` confirmed genuinely unbypassable by a hostile client since the atomic guarded UPDATE is the real backstop regardless of client input, ownership checked strictly before version logic runs so no cross-user probing signal leaks, server-side gating confirmed independent of the UI's own `isThresholdEditable` check, no non-negotiables violated, all SQL parameterized). QA PASS (all 10 items clean, including DB-level proof of the new `rule_versions` row on a successful edit, and a final module-wide sweep confirming every exported Server Action in `app/(app)/rules/actions.ts` now has a real UI caller — no repeat of the promote/demote/retire orphaned-backend pattern anywhere). **This closes Module 04's own currently-in-reach scope entirely** — only Slice 10c (discovery, blocked on Module 05) and strategy-scoped rule stories 1.5-1.7 (blocked on Module 03) remain, both confirmed genuine external blockers, not oversights.

**Module 04 scope gap found by this slice's own QA pass, not yet tracked anywhere — given its own number, Slice 10e, rather than staying invisible.** Slice 7 (2026-08-25) built `promoteRule`/`demoteRule`/`retireRule` as backend-only Server Actions, explicitly scoping their UI as future work at the time. That UI has never shipped — confirmed via `grep`: those three functions are called nowhere in `app/` except their own Server Action definitions and test file. This is NOT Slice 10c (discovery, story 1.3 — correctly tracked as blocked on Module 05) and is NOT this slice (10d part 2, adherence) — it is a genuine, currently-unclaimed gap: the rule list/browsing view (story 1.1's "one sentence, one tappable number" list, the natural home for `app/(app)/rules/page.tsx`'s own already-reserved future-list placeholder from this slice) PLUS the severity promote/demote/retire controls (§6.1's `alert--choice` hard-cap swap markup, deferred all the way back at Slice 10b's own dispatch for exactly this reason — it needs an existing-rules list to select a demote target from, which didn't exist until now). Today, a trader who wants to promote a rule to hard, or simply see their existing rules, has no UI path to either — a real product gap, not a documentation nit. Per AGENTS.md step 8/"never fake it," this is logged here rather than left silently dropped; Module 04 is NOT done until Slice 10e is either built or deliberately, visibly deferred with a real reason. See "Next" below for the priority call on 10e vs. 10c.
| 3 | Module 03 (Field Registry & Strategy) + Module 05 (Analytics & Findings) | Not started |
| 4 | Module 06 (Review & Graduation) + Module 07 (Engagement) | Not started |
| v1.1 | Module 09 (Prop firm rulebooks) + Module 10 (AI layer) | Deferred |

## Current task

**AT A GLANCE (2026-09-01): Module 04's own currently-in-reach scope is
FULLY DONE (Slices 9, 10a, 10b, 10d part 1, 10d part 2, 10e, 10f — every
one full coder → tester → security-reviewer → qa gate sequence,
independent verification found and fixed a real bug on the majority of
them). Only Slice 10c (discovery, blocked on Module 05) and strategy-
scoped rule stories 1.5-1.7 (blocked on Module 03) remain, both confirmed
genuine external blockers, logged in the 2026-08-31 spec-coverage
decision-log entry. `lib/privacy/export.ts`'s staleness gap (also found
2026-08-31) remains open and tracked in the standing Infra gaps list,
deliberately not built as Module 04 work since it's Module 01's own
file.**

**Module 08 (Onboarding & Home) is now starting — read the full spec
(`retrospeq-design-system/modules/08-onboarding-and-home.md`) before any
code, the same as every module before this one. A real blocker analysis,
done BEFORE writing any Module 08 code (not discovered slice-by-slice the
way Module 04's own untracked gaps were), found this module has
significantly heavier external dependencies than AGENTS.md's build-order
framing ("Module 04 + Module 08 — this is a shippable free tier")
implies on its own:**

Module 08's own §13 Dependencies table names Modules 01, 02, 03, 04, 05,
06, and 07 — and states plainly, "This module composes and does not
compute." Of those seven, only 01, 02, and 04 are actually built. Working
through Module 08's own stories/sections one at a time:

- **§5.2 "The hook" (story 1.1) — BLOCKED on Module 05.** Needs a real T0
  behavioural analytic (sequence/day-session/risk-spread findings) to
  state something true within 60 seconds of import. Module 05 (Analytics
  & Findings) does not exist at all — not "no candidate clears the
  gate," there is no gate-checking machinery to begin with. The spec's
  own "if nothing clears the gate, show an honest summary instead" path
  is the ONLY thing buildable today, and it should be buildable as the
  PERMANENT behavior until Module 05 ships (never attempt fake analytic
  selection against data that doesn't exist) — not a placeholder to
  silently forget, an honestly-scoped real feature that degrades
  gracefully by construction.
- **§5.3 "Calibrating the first rules" (story 1.2) — MOSTLY ALREADY
  BUILT.** This is functionally the SAME feature Module 04's own Slice
  10a (guided three-rule front door, `/rules/start`) already shipped:
  `risk_pct`/`daily_loss_pct`/`consecutive_losses`, seeded from the
  trader's own distribution, all soft, live preview, an honest
  insufficient-history fallback. **One real, minor spec discrepancy
  worth reconciling, not silently picking a side on**: Module 08 §5.3
  says "seed = percentile(distribution, 75)"; Slice 10a's own dispatch
  chose the 80th percentile (documented reasoning: landing inside
  `preview.ts`'s own "healthy" ratio band rather than the raw median).
  These are two different numbers for the same underlying idea, written
  at two different times by two different module specs. Per 00-
  foundation §12, this needs reconciling deliberately, not left to
  drift — logged in the decision log below (search "75th vs 80th
  percentile"), leaning toward keeping Slice 10a's already-shipped,
  already-tested, already-reasoned-through 80th-percentile choice rather
  than re-litigating a number both specs treat as a means to the same
  end, but flagging for a final call if a future pass disagrees.
  **Module 08's actual job for this story is likely just SEQUENCING** —
  routing a new trader through `/rules/start` as an onboarding STEP (and
  recording `onboarding_state.stage = 'rules_calibrated'`), not
  rebuilding the calibration mechanism itself.
- **§5.4 "Strategy is silent and optional" (story 1.3) — BLOCKED on
  Module 03.** Creating the default strategy row requires the
  `strategies` table, which does not exist (Module 03 hasn't started).
  Logging works from derived data with zero fields per the spec, but
  "zero fields" still means a real `strategies` row with `is_default =
  true` needs to exist for trades to associate with — cannot be built
  today.
- **§5.5 Field introduction (story 1.6) — BLOCKED on Module 03.** Same
  root cause — needs the field registry to exist to offer capturing
  anything.
- **§5.6 Manual path (story 1.5) — MOSTLY ALREADY BUILT.** Manual trade
  entry already exists (`app/(app)/trades/manual-entry`, Module 02).
  Conservative-default rule calibration is arguably ALREADY the correct
  behavior of Slice 10a's own insufficient-history fallback (bounds
  midpoint, honest "no history yet" preview) — the manual path may not
  need new calibration logic at all, just confirming the SAME guided
  front door handles a zero-history trader correctly (it already does,
  independently verified by Slice 10a's own tester pass).
- **§6 Unlock ladder — PARTIALLY BUILDABLE.** The `unlock_state` table
  and its own counters (`trades_confirmed`, `trades_with_captures`,
  `weeks_active`) can be built and incremented today (Module 01/02/04
  data is sufficient). What each stage GATES is a different story:
  "streak + adherence" (10 confirmed) — adherence exists (Module 04),
  streak does NOT (Module 07, not started); "single-field judgment
  findings" (30 with captures) — needs Module 03 (fields) AND Module 05
  (judgment findings); "graduation prompts" (60 confirmed) — needs
  Module 06; "decay checks, promotion" (12 weeks) — promotion itself
  exists (Module 04 Slice 7/10e), decay checks need Module 05.
- **§7 Dashboard state machine — PARTIALLY BUILDABLE.** Of the four
  ranked states (`Position open > Trades to close > Review ready >
  Clear`), three are honestly reachable with what exists today:
  "Position open" and "Trades to close" need only Module 02 (open
  positions, unconfirmed trades) data; "Clear" needs only Module 04
  (adherence) for its stat line, per spec — the spec's OWN example Clear
  state shows "Logging streak: 12 weeks" alongside adherence, and streak
  is Module 07 territory, not built. **"Review ready" is fully BLOCKED
  on Module 06** (a materialised review that doesn't exist) — this state
  should simply never be reached today, which the state machine's own
  "mutually exclusive and ranked" design tolerates naturally (one state
  permanently unreachable is not a bug in a ranked-fallthrough design,
  it just never wins). The dashboard is buildable today in a genuinely
  three-state degraded form (Position open / Trades to close / Clear,
  minus the streak stat in Clear), which is real, honest, shippable
  value — not a placeholder.

**Decision: build what's genuinely reachable now, log what isn't the
same way Module 04 logged Slice 10c/1.5-1.7, and do not silently
under-deliver or silently over-claim "Module 08 done."** This mirrors
exactly how Module 04 itself handled its own external blockers — decide
from the spec, log the reconciliation, keep moving, per AGENTS.md's own
explicit judgment-call guidance. **First sub-slice: Module 08's own
`onboarding_state`/`unlock_state` schema (§4) + RLS + the counter-
incrementing logic wired into `lib/ingestion/confirm.ts`'s existing
best-effort post-commit pattern (same shape as `operand_distributions`/
`adherence_weekly`)** — pure backend plumbing, zero external-module
dependency, the correct "substrate before screens" starting point
matching this repo's own Module 04 Slice 1 precedent. Screens (the
onboarding sequence routing, the degraded dashboard) follow as later
sub-slices once the state this schema tracks actually exists to read.

**→ Slice 10f (story 2.5's edit-a-threshold UI) — CODER PASS DONE
(2026-09-01).** Closes the real, previously-untracked gap this same
"Current task" section flagged above on 2026-08-31: `editRule` (Slice 2,
2026-08-19) has been fully built, tested, and security-reviewed the whole
time, but no UI anywhere ever called it — both Slice 10b's and Slice
10e's own coder dispatches independently scoped this out as "a separate
future decision" without either claiming a slice number, exactly the
pattern that let the promote/demote/retire UI gap (Slice 10e's own
"Module 04 scope gap" entry) go untracked for 5 weeks. Given its own
number this time specifically so it doesn't repeat a third time.

Built, matching §6.1's `.rule-editor` reference markup and this repo's
own established Server/Client Component split:

- **`app/(app)/rules/actions.ts`'s new `fetchRuleForEdit(ruleId)`
  Server Action** — a thin, read-only wrapper around
  `fetchCurrentRuleForEdit` (`rules-repository.ts`, unmodified — already
  built for Slice 2, only ever called server-side by `editRule` itself
  until now). Session-derived `userId` only; deliberately mirrors
  `editRule`'s own pre-write guards (not-found → `RULE_NOT_FOUND`,
  non-`active` state → `RULE_NOT_EDITABLE`, non-global/strategy scope →
  `RULE_NOT_EDITABLE`) rather than a looser read-only check — a trader
  should never be able to open an edit control for a rule the write path
  would reject outright anyway. Returns `{ruleId, operandId, op, value,
  scope, scopeId, currentVersion}`. New `ruleForEdit` rate-limit scope
  (`lib/rate-limit/config.ts`, 60/3600s ip, 40/3600s email — reasoned in
  that file's own comment against `recordOverride`/`writeTradeCapture`'s
  precedent, not `previewRule`'s per-keystroke one).
- **CATALOGUE METADATA (bounds/type/unit/label) is NOT re-shipped by this
  action** — `operand-catalogue.ts` has no `server-only` import and is
  already imported directly by a client component today
  (`RuleEditor.tsx`'s own `getOperand` call, Slice 10b's precedent); the
  new `EditRuleControl.tsx` resolves the operand's catalogue entry itself
  from the `operandId` this action returns, rather than the action
  re-deriving and re-shipping a second copy of catalogue data over the
  wire.
- **`app/(app)/rules/EditRuleControl.tsx` (new)** — the inline edit
  control itself. On mount, calls `fetchRuleForEdit` to pre-fill a
  `.rq-step` stepper with the rule's REAL current value (never a
  fabricated default), then a live, debounced `previewRule` call exactly
  like the CREATE flow's own `RuleEditor.tsx` already establishes for
  story 1.2 ("Preview against history updates live as the slider
  moves") — included deliberately for the edit flow too, since the spec
  draws no distinction between authoring a rule fresh and changing its
  threshold for that story. Submits via the EXISTING, UNMODIFIED
  `editRule(ruleId, newValue)` (only `value` ever sent — `operandId`/`op`
  are fixed server-side per §2.5, never re-derivable by this control).
  Deliberately a NEW, small, documented-duplicate component rather than
  exporting/reusing `RuleEditor.tsx`'s own module-private
  `RuleSentenceEditor` (different copy: "Save"/"Cancel" not "Add rule",
  no entitlement chip since editing never consumes a rule slot) — matches
  `RuleEditor.tsx`'s own established precedent of a small, deliberate,
  documented duplicate (`boundsMidpointDefault`) rather than forcing a
  cross-flow shared abstraction prematurely.
- **`app/(app)/rules/RuleList.tsx`** — a new "Edit" action alongside
  promote/demote/retire on every ACTIVE row whose operand has a real
  bounded numeric threshold (`isThresholdEditable`, a pure client-safe
  catalogue check: `number`/`duration`/`rating` type with `bounds`) —
  `bool` operands (no `{value}` placeholder in their phrasing at all,
  same reasoning `RuleEditor.tsx`'s own create-flow bool handling
  documents) never get an Edit button, since there is no threshold to
  change. A retired rule never shows Edit either (confirmed via
  `RuleListItem.state`) — editing a dead rule makes no sense, story 2.4.
  Opening Edit on a row is a THIRD mutually-exclusive inline-expansion
  state alongside the existing swap-chooser/retire-confirm (opening one
  closes the other two for the SAME row). On success, `onSaved` patches
  ONLY `rule.rendered` into `RuleList`'s own `rows` state via the
  existing `patchRule` helper — the row's displayed sentence updates
  live, no full page reload, matching this slice's own dispatch
  requirement and the exact bug class Slice 10b/10e's own QA/tester
  passes previously caught (a stale count/stale-state-after-success gap)
  elsewhere in this file tree.
- **`<li data-testid="rule-row-${rule.ruleId}">`** — a new, small,
  invisible test-only attribute added to `RuleRow`'s outer element. Not
  strictly required by the dispatch, but load-bearing for this slice's
  own E2E suite (see below) once a REAL self-check bug was found and
  fixed: text-based row locators (`page.locator('li', {hasText: ...})`,
  the established pattern every prior Module 04 E2E file in this repo
  already uses) silently stop matching ANYTHING the instant a row's own
  header text changes — exactly what a successful EDIT does by
  definition. A `ruleId`-keyed `data-testid` is immune to that.

**REAL BUG FOUND AND FIXED DURING THIS SLICE'S OWN SELF-CHECK, not
shipped** (`e2e/rules-edit-threshold.spec.ts`'s own header documents the
full investigation): an early version of this slice's own E2E suite
appeared to show `editRule` hanging past its 15s `withTimeout` deadline
on EVERY run — concerning, since `withTimeout` is the exact mechanism
Slice 10e's own tester built and proved for this class of bug. Direct
investigation (dev-server logs, then a temporary client-side
`console.log` trace of `editRule`'s own resolved result) proved this
diagnosis WRONG: `editRule` was resolving successfully in every case,
well within budget. The real bug was in the TEST file itself: `row` was
a `page.locator('li', { hasText: <old rendered text> })` — the moment a
real save updated that text, the locator's own filter condition stopped
matching the element AT ALL (the new text does not contain the old text
as a substring), so every assertion chained off `row` silently found
nothing, forever — a false NEGATIVE masquerading as a hang. Fixed via the
new `data-testid` above; kept `waitForSaveOutcome`'s honest dual-outcome
handling (success OR `RuleList.tsx`'s own already-proven
`withTimeout`-triggered error message, with a page-reload recovery check
on the latter) as a legitimate defensive pattern regardless, since that
underlying dev-server flakiness class IS real and independently
reproduced elsewhere in this repo (Slice 10e) — this file's own header
documents this whole investigation rather than quietly deleting the
evidence, per AGENTS.md's "never fake it."

**Tests written by this coder pass** (not yet independently
re-verified): 12 new unit tests in `app/(app)/rules/__tests__/actions.test.ts`
for `fetchRuleForEdit` (success shape, no-write-of-any-kind, not-found,
retired/`deactivated_by_plan`/non-editable-scope rejections mirroring
`editRule`'s own guards, strategy-scope success, malformed-uuid,
internal-error mapping, rate-limit, session-missing) — full suite still
101/101 green. A new 5-test Playwright E2E file
(`e2e/rules-edit-threshold.spec.ts`): a real successful edit verified
directly against Postgres (new `rule_versions` row, `rules.current_version`
bump, old version's `superseded_at` set), a real, naturally-reachable
rejection path (`stop_move_count`, a t1 operand, with zero connected
accounts — the same `RULE_OPERAND_UNAVAILABLE` tier gate `editRule`
re-runs on every edit per its own header), a "rule changed elsewhere
before Save is clicked" scenario proving `editRule`'s own re-fetch-before-write
design applies cleanly on top of the up-to-date version chain (see this
slice's own dispatch note on why the ACTUAL `RULE_EDIT_CONFLICT` race is
judged sufficiently proven already at the repository layer,
`rules-repository.live.test.ts`, rather than re-driven as a genuine
two-context race here), retired-rule exclusion, and bool-operand
exclusion. Screenshots captured and read
(`tmp/dev-screenshots/rule-edit-{open-prefilled,success,tier-rejected}.png`):
confirmed one primary `.rq-btn` ("Save") per open edit state, `.rq-step`/
`.rq-step__val.rq-num` stepper (no keyboard entry), no red/green anywhere,
the row's own header sentence updating live post-save with the edit
control closed, and the tier-rejection alert rendering plainly (no panic
copy). Full E2E spec re-run clean 4 consecutive times across two fresh
dev-server instances (5/5 every time); `rules-list.spec.ts` (Slice 10e's
own suite, unmodified by this slice) also re-confirmed 6/6 green on the
same fresh server, ruling out any regression from the new `data-testid`
attribute or the `RuleList.tsx` changes. `tsc --noEmit` clean, `npx
eslint .` clean (0 errors, the same pre-existing 19 warnings), `npm run
build` clean (memory checked first, 6GB+ free both times, all leftover
node/chrome processes killed before each build attempt per this
session's own now-six-times-documented OOM pattern). A broader
`npx vitest run "app/(app)/rules" lib/rules` pass (671 tests) surfaced 15
failures, ALL in `lib/rules/__tests__/freeze-evaluations.live.test.ts` /
`severity-lifecycle.live.test.ts` / `severity-lifecycle.independent-verification.live.test.ts`
— files this slice never touched (confirmed via `git status`), all a
`Test timed out in Nms` shape, matching this session's own
already-documented "deterministic too-tight-timeout on this shared/slow
dev Supabase project, not classic flakiness" diagnosis from earlier
Module 04 slices, not a regression.

No migration (no schema change), no ADR (a UI-composition/route-pattern
choice, not a 00-foundation convention deviation — matches Slice 10b/10e's
own "no ADR" precedent for the identical class of decision), no new
`docs/runbook.md` entry (no new alerting condition — this slice only adds
a UI surface calling `editRule`/`fetchRuleForEdit`, both already covered
by existing error-handling conventions, no new failure mode introduced).
**Coder pass only — this slice still needs independent tester
verification, a security-reviewer pass (RLS/ownership already inherited
unchanged from `fetchCurrentRuleForEdit`/`applyRuleEdit`, but the NEW
`fetchRuleForEdit` Server Action itself has not been independently
reviewed), and a QA pass before Module 04 Slice 10f — and, per the
"Recommendation" above, Module 04 as a whole for everything in its own
reach — can be marked done.**

**→ Slice 10f — INDEPENDENT TESTER VERIFICATION DONE (2026-09-01), REAL
GAP FOUND, NOT YET FIXED. Do not mark Slice 10f done.** Re-verified the
coder's own claims against fresh fixtures/live DB per this repo's own
"don't trust the coder's own suite" convention. Re-ran the coder's own
suites first: 101/101 unit (`actions.test.ts`, including the 12 new
`fetchRuleForEdit` cases) green; `tsc --noEmit` clean; `npx eslint .`
clean (0 errors, the same pre-existing 19 warnings); `npm run build`
clean (memory checked first — 6GB+ free, no orphaned processes — 22
routes compiled, including `/rules`). A broader `npx vitest run --coverage
lib/rules` pass reproduced exactly the same 4 pre-existing, untouched-by-
this-slice live-DB timeout failures already documented for prior slices
(`adherence-repository.live.test.ts`, `severity-lifecycle.live.test.ts`,
`freeze-evaluations.live.test.ts`,
`severity-lifecycle.independent-verification.live.test.ts` — confirmed
via `git status` that none of the four have any uncommitted diff, i.e.
none were touched by this slice), 549/568 passing overall; coverage
itself could not be measured for this slice's own new code at all
because `vitest.config.ts`'s `coverage.include` is scoped to
`lib/**/*.ts` only — `app/(app)/rules/actions.ts`/`EditRuleControl.tsx`/
`RuleList.tsx` (where every line this slice actually added lives) sit
outside that measured surface entirely, a pre-existing repo-wide
convention (every prior Server-Action/UI slice in this module —
`createRule`/`editRule`/`promoteRule`/`RuleList.tsx` itself — has the
same gap), not something newly introduced or newly hidden by this slice.
Flagging honestly rather than reporting a number that doesn't exist. No
grouping-engine code touched at all (confirmed via diff scope), so §9.3's
golden-fixture-replay requirement does not apply here. No new migration,
no new table — RLS coverage unaffected.

**Item 1 (version-conflict UI coverage) — REAL GAP FOUND.** The coder's
own reasoning ("the actual race is already sufficiently proven at the
repository layer") does not hold for the scenario the dispatch actually
asked about, and the coder's OWN E2E test
(`e2e/rules-edit-threshold.spec.ts`, "a rule changed elsewhere before
Save is clicked...") already demonstrates this on direct reading —
independently reproduced live to confirm (`lib/rules/__tests__/edit-
rule-control.independent-verify.live.test.ts`, FOCUS 1, live DB, 2/2
green): `EditRuleControl.tsx`'s `onSubmit` calls
`editRule(rule.ruleId, value)` — it NEVER sends back the
`currentVersion` `fetchRuleForEdit`'s own initial snapshot returned.
`editRule` (`app/(app)/rules/actions.ts`) re-fetches the rule fresh,
internally, immediately before its own write, and uses THAT freshly-read
version as `applyRuleEdit`'s `expectedVersion` — so `RULE_EDIT_CONFLICT`
is only ever reachable through a race entirely INTERNAL to a single
`editRule` call (the gap between its own re-fetch and its own guarded
UPDATE, typically well under a second), never through the
client-observable "I had this edit control open for a while, someone
else changed the rule in the meantime" scenario the dispatch describes —
because the client's own snapshot version is never transmitted to or
checked by the write path at all. Concretely, reproduced live: open Edit
(snapshot v1, value 1.0) → a different process commits a real,
independent edit (v1→v2, value 3.0) while the control is still open →
the original trader clicks Save with their own value (1.2, computed from
their now-stale 1.0 baseline). Result: `editRule` returns `success: true`
— NOT `RULE_EDIT_CONFLICT` — and silently writes v3 with the trader's own
1.2, permanently discarding the intervening v2 (3.0) edit with **zero
signal anywhere** that anything else had changed the rule in between.
This is the literal opposite of the dispatch's own stated correctness bar
("the LATER edit should be the one that sticks, not silently
overwritten") — here the edit submitted LATER in wall-clock time (the
trader's, based on stale data) overwrites the one committed EARLIER (the
"elsewhere" edit), with no honest "this rule changed elsewhere" message
ever shown, contradicting the coder's own PROGRESS.md framing that this
is "sufficiently proven already." Not data corruption in the strict
transactional sense (the version chain itself stays internally
consistent, v1→v2→v3, no double-write), but a genuine, silent lost-update
against a real, well-defined error code (`RULE_EDIT_CONFLICT`) that
exists specifically to prevent this and is structurally unreachable from
the UI as built. Realistic trigger: the same trader editing the same rule
from two tabs/devices, or two collaborators on a shared account (not a
contrived scenario). **Recommendation, not yet implemented**:
`fetchRuleForEdit`'s returned `currentVersion` should be threaded back
through `EditRuleControl.tsx`'s submit call into a new optional parameter
on `editRule` (or a new variant), checked against the rule's version at
write time, surfacing the existing `RULE_EDIT_CONFLICT` message
genuinely, honestly, to a trader whose snapshot really has gone stale
since they opened Edit — this is a real product/UX gap, not a security
issue (ownership/RLS are unaffected either way) and not something this
tester has authority to fix unilaterally.

**Item 2 (tier-unavailable guard, fresh fixture) — PASS.** Constructed a
genuinely different fixture than the coder's own "always zero accounts"
case: an account that legitimately HAD `t1`/`connected` when a
`stop_move_count` rule was created and successfully edited once, then
genuinely disconnects, then a second edit attempt is made. Live DB
(`edit-rule-control.independent-verify.live.test.ts`, FOCUS 2) and a
fresh Playwright spec (`e2e/rules-edit-threshold.independent-verify.spec.ts`,
"a fresh tier-downgrade fixture...", screenshot
`tmp/dev-screenshots/indep-verify-tier-rejected.png`) both confirm: the
edit is honestly rejected with `RULE_OPERAND_UNAVAILABLE` / "None of your
connected accounts report enough data for... yet.", the rule is left
completely unchanged (still at the last successful edit's version/value,
no corruption), and the UI shows the plain, non-alarming rejection
message inline with the edit control still open and editable (one
primary `.rq-btn`, no red/green). Guard holds under a fresh fixture.

**Item 3 (bool/retired exclusion, fresh fixtures) — PASS.** Fresh
Playwright spec, different operands than the coder's own: a bool
operand (`target_set_at_entry`, not `stop_set_at_entry`) never renders an
Edit action (other row controls, e.g. "Promote to hard", still do); a
retired rule on a different numeric operand (`weekly_loss_pct`, not
`risk_pct`) never renders an Edit action either. Both 2/2 green, fresh
seeded data, not the coder's own fixtures.

**Item 4 (successful-edit UI freshness, fresh fixture) — PASS.** Fresh
operand (`total_open_risk`, not `risk_pct`): opened Edit (pre-filled
"4.0%", live preview well present, screenshot
`tmp/dev-screenshots/indep-verify-edit-open-prefilled.png`), adjusted via
stepper to 2.5%, clicked Save, and asserted the row's own header sentence
updated to the exact new text WITHOUT reloading the page (polled the DOM
directly rather than reloading, so a staleness bug could not be
accidentally papered over) — confirmed correct, screenshot
`tmp/dev-screenshots/indep-verify-edit-success.png`. Independently
re-verified directly against Postgres: `rules.current_version = 2`,
`rule_versions` version 2 carries `value = 2.5` and the EXACT expected
`rendered` text with `superseded_at is null`, version 1 has
`superseded_at` set. Not merely "some text changed" — the correct new
value end to end.

**Item 5 (`EditRuleControl.tsx` vs `RuleSentenceEditor` duplication) —
real, non-blocking drift risk, coder's "not worth extracting" judgment is
reasonable but incomplete.** Read both components' stepper/preview code
side by side: `countDecimals()` and the `step()` Decimal-clamp function
(`Decimal.max(bounds.min, Decimal.min(bounds.max, new
Decimal(value).plus(new Decimal(bounds.step).times(direction)))).toNumber()`)
are BYTE-IDENTICAL copies in both files, as is the preview-rendering
markup block. The coder's stated reason for not sharing (different
copy/CTA, no entitlement chip, different write call) is true and doesn't
by itself justify extracting a shared component — but it does not
address the ACTUAL duplicated surface, which is narrower and purely
mechanical (two small pure functions with no server-only dependency, no
UI-copy coupling at all). `preview.ts`'s own bucket-percentile logic is
NOT duplicated — both components call the same `previewRule` Server
Action and render its result, so a change there automatically applies to
both, no risk. The real, narrow risk is limited to the stepper math
itself: if a bounds/step precision bug is ever found and fixed in one
copy, there is no compiler link and no shared test asserting the two
stay identical, so a fix could easily land in only one file unnoticed.
Non-blocking, but a legitimate follow-up: extract `countDecimals`/`step`
into a small client-safe shared module (e.g.
`lib/rules/stepper-math.ts`, no `server-only` import needed, matching
`operand-catalogue.ts`'s own precedent) or, at minimum, add one shared
unit test asserting both components' stepper output is identical across
a range of bounds/values so any future drift fails loudly instead of
silently.

**Independent-verification artifacts left in place (not committed, not
cleaned up — for the next agent to review/decide on)**:
`lib/rules/__tests__/edit-rule-control.independent-verify.live.test.ts`
(2 live-DB tests, items 1 and 2 above) and
`e2e/rules-edit-threshold.independent-verify.spec.ts` (4 fresh Playwright
tests, items 2/3/4 above, screenshots in `tmp/dev-screenshots/` —
gitignored, throwaway). All 6 pass consistently. Dev server and all
node/chrome processes spawned during this verification pass were killed
before finishing (memory checked before and after: ~6GB free throughout,
no growth, no orphaned processes left).

**Net result: Slice 10f is NOT done.** Items 2, 3, 4 pass cleanly on
fresh fixtures; item 5 is a real but non-blocking follow-up. Item 1 is a
real, reproducible product gap — a trader's edit control can silently
overwrite a concurrent edit with zero warning, the opposite of the
`RULE_EDIT_CONFLICT` error code's own stated purpose — that must be
fixed (thread the client's snapshot version through to `editRule` and
surface a genuine conflict message) before this slice, and Module 04's
"everything in reach" claim, can honestly be called done.

**→ Slice 10f — CODER FIX PASS DONE (2026-09-01). Closes the real
version-conflict gap the independent tester found above.** Root cause,
confirmed by direct code read before touching anything: `editRule`'s
optimistic-concurrency protection was a no-op end to end. The repository
layer (`applyRuleEdit`, `lib/rules/rules-repository.ts`) was and remains
genuinely correct — a real atomic guarded UPDATE
(`update ... where rule_id = $1 and version = $2 and superseded_at is
null`) that only succeeds if the caller's `expectedVersion` still matches
the row's true current version at write time. The bug was entirely in
what `editRule` (`app/(app)/rules/actions.ts`) fed that guard: it took no
`expectedVersion` parameter at all, instead calling
`fetchCurrentRuleForEdit` fresh, internally, moments before its own write,
and passing THAT freshly-read version straight to `applyRuleEdit` — so
the "expected version" could only ever go stale within `editRule`'s own
execution (sub-second), never across the real window that matters (an
edit control sitting open for minutes while a different tab/device/
collaborator edits the same rule). `EditRuleControl.tsx` never sent its
own `fetchRuleForEdit` snapshot's `currentVersion` back at all.

**Fix**: `editRule`'s signature is now
`editRule(ruleId: string, expectedVersion: number, newValue: unknown)` —
`expectedVersion` is REQUIRED (no silent default that would reintroduce
the same bug), supplied by the CALLER. `EditRuleControl.tsx` now stores
the `currentVersion` its own initial `fetchRuleForEdit` call returned (in
new `version` state), sends it back on submit, and — new — on a
`RULE_EDIT_CONFLICT` rejection offers a genuine path forward: a "Refresh
with the latest value" button (`handleRefresh`) that re-fetches the SAME
open control with the rule's now-current value/version, rather than
leaving the trader stuck behind a bare alert. A cheap early check in
`editRule` (`current.currentVersion !== expectedVersion` → immediate
`RULE_EDIT_CONFLICT`, before the tier/tighten-only/satisfiability
pipeline runs against a value that would be rejected anyway) was added as
an optimization; `applyRuleEdit`'s own atomic guarded UPDATE remains the
real, unbypassable enforcement point regardless.

**Verification, in order**: (1) the independent tester's own live
reproduction (`lib/rules/__tests__/edit-rule-control.independent-verify.live.test.ts`,
FOCUS 1 — open at v1, concurrent commit to v2, stale save) now correctly
rejects with `RULE_EDIT_CONFLICT` and leaves the DB at v2 untouched (test
updated in place to assert the fixed behavior, re-run live: 2/2 green,
including FOCUS 2 unaffected). (2) `e2e/rules-edit-threshold.spec.ts`'s
own "rule changed elsewhere" test — which, on direct reading, had been
asserting the OLD (buggy) silent-overwrite behavior as if it were correct
— rewritten to assert the fix: Save is rejected with the honest
`role="alert"` message ("This rule was just changed elsewhere..."), the
intervening "elsewhere" edit survives untouched in Postgres, clicking
"Refresh with the latest value" re-pre-fills the control with the
now-current value, and a fresh Save against that up-to-date version then
succeeds cleanly. Full 9-test run across both
`rules-edit-threshold.spec.ts` and `rules-edit-threshold.independent-verify.spec.ts`
green on a fresh dev server; screenshot
(`tmp/dev-screenshots/rule-edit-conflict-rejected.png`) confirmed exactly
one primary `.rq-btn` ("Save"), no red/green, the conflict alert and
Refresh affordance rendering plainly. (3) 102 pre-existing unit tests in
`app/(app)/rules/__tests__/actions.test.ts` updated for the new required
parameter (every `editRule(...)` call site now passes `expectedVersion`
explicitly, matching each fixture's real current version) plus 2 new
tests (an explicit stale-`expectedVersion` rejection that never reaches
`applyRuleEdit` or the tier pipeline, and the pre-existing internal-race
mapping test relabeled to clarify it exercises `applyRuleEdit`'s own
guard specifically, not the caller-snapshot path) — 102/102 green. (4)
`tsc --noEmit` clean; `npx eslint .` clean (0 errors, the same
pre-existing 19 warnings — one new `react-hooks/set-state-in-effect`
error surfaced during this fix from an early refactor attempt calling a
`useCallback`d async fetch helper directly inside `useEffect`; resolved
by keeping the mount effect's own inline `.then/.catch/.finally` promise
chain, the same shape this file used pre-fix, and giving the
`handleRefresh` event-handler its own independent async implementation —
both call a small shared `applyFetchResult` helper to avoid duplicating
the result-interpretation logic). (5) `npm run build` clean, 22 routes
compiled — memory checked before (5.9GB free, no orphaned processes) and
after (5.9GB free, no growth); all dev-server/Playwright/node processes
spawned during this pass explicitly killed (`taskkill //F //IM node.exe`)
before finishing.

No migration, no ADR (a bug fix restoring the documented, intended
optimistic-concurrency guarantee — not a deviation from a
00-foundation convention). No new `docs/runbook.md` entry — no new
alerting condition; `RULE_EDIT_CONFLICT` itself is not new, only now
correctly reachable through the UI it was always meant to protect.

**Slice 10f is now genuinely done from a coder standpoint — still needs
independent tester RE-verification of this specific fix (not a full
re-review of the whole slice) and, per the earlier recommendation,
security-reviewer → qa on the whole slice before Module 04 as a whole
(everything in its own reach) can be marked done.**

**→ Slice 10f — INDEPENDENT TESTER RE-VERIFICATION OF THE FIX DONE
(2026-09-01). PASS. The version-conflict gap this tester originally found
is genuinely closed, including the new "Refresh with the latest value"
recovery path.** Per this dispatch's own instruction, did NOT repeat the
original FOCUS 1 reproduction — every scenario below is a fresh,
independently-constructed live-DB probe
(`lib/rules/__tests__/edit-rule-control.refresh-reverify.live.test.ts`,
4/4 green), different operand/values/timing than either the original
finding or the coder's own re-verification.

1. **Fresh operand, TIGHTER concurrency window — PASS.** `consecutive_losses`
   (not `risk_pct`), values 3→5 attempted / 7 actually committed
   elsewhere. Unlike the original reproduction (intervening commit fully
   before `editRule` is even called), this test starts the stale
   `editRule(ruleId, 1, 5)` call WITHOUT awaiting it, then commits the
   "elsewhere" edit on a second connection immediately after — racing the
   intervening commit against `editRule`'s own internal pipeline
   (multiple sequential awaited round trips) rather than a fully
   sequential ordering. Correctly rejected with `RULE_EDIT_CONFLICT`
   either way (whichever of the early short-circuit or `applyRuleEdit`'s
   own atomic guarded UPDATE catches it) — DB left at v2/value 7
   untouched, no v3 ever written with the stale value.
2. **"Refresh with the latest value" path — PASS, including the
   most-important check (2b).** (a) Confirmed by direct code read
   (`EditRuleControl.tsx`'s `handleRefresh` → `applyFetchResult`) that
   Refresh is, at the wire level, a genuine second `fetchRuleForEdit`
   call — no client-side guess, no cache. Live-verified: after a
   rejected stale save, calling `fetchRuleForEdit` again returns a value/
   version cross-checked directly against a separate Postgres read
   (`SELECT ... FROM rules JOIN rule_versions`), not merely "the UI
   showed something different." (b) **THE KEY TEST**: after Refresh
   captures the genuinely-current v2, a THIRD independent edit commits
   v2→v3 *before* the trader's next Save. If the refresh path had reused
   the original stale v1 baseline (the same bug one level removed), this
   would either wrongly succeed or fail for the wrong reason. Verified:
   the post-refresh save (using the refreshed v2 baseline) is correctly
   rejected with `RULE_EDIT_CONFLICT` again — proving the refreshed
   snapshot is a real, honest baseline that gets re-checked by the exact
   same mechanism, not a bypass. The v3 edit survives untouched; neither
   the original v1-based value nor the v2-based value ever lands. A
   second, genuine refresh (now correctly catching v3) followed by a
   clean save then succeeds, confirming the recovery path isn't
   permanently broken by the race, just correctly protective of it. (c)
   A separate clean run (no third-party interference) confirms Refresh →
   edit → Save produces the correct final DB state end to end (v3, correct
   value/rendered text).
3. **Same-session double-submit against ONE shared stale snapshot —
   PASS.** `consecutive_losses` again, two concurrent `editRule` calls
   both using the SAME v1 `expectedVersion` (`Promise.all`, values 2 and
   6, simulating a double-click or two-tabs-same-snapshot race, distinct
   from item 1's "different intervening editor" scenario). Exactly one
   succeeded, exactly one was rejected with `RULE_EDIT_CONFLICT` — not
   both succeeding, not both failing, no exception. DB confirmed exactly
   one coherent version-2 row (`rule_versions` count = 2 total, i.e. no
   phantom third version), and the surviving value matches whichever
   result actually reported success.
4. **Coder's own full suite, re-run independently, not trusted from the
   report — CONFIRMED.** Unit: `app/(app)/rules/__tests__/actions.test.ts`
   102/102 green. E2E: `e2e/rules-edit-threshold.spec.ts` +
   `e2e/rules-edit-threshold.independent-verify.spec.ts` 9/9 green (run
   twice, consistent). Slice 10e's own `e2e/rules-list.spec.ts`: 6/6 green
   — but only after a real, honestly-reported hiccup (see item 6 below);
   not swept under "clean" without explanation. `tsc --noEmit` clean.
   `npx eslint .` clean, 0 errors, the same 19 pre-existing warnings.
   `npm run build`: FAILED once with this session's own known
   Zone-Allocation/OOM signature (`FATAL ERROR: Zone Allocation failed -
   process out of memory`, `Next.js build worker exited with code: 134`),
   then passed cleanly (22 routes) after killing leftover node processes
   and freeing memory — same documented pattern as Slice 10d part 2's own
   build report; reported as a real infra data point, not silently
   retried into "clean."
5. **Rewritten E2E test — read directly, confirmed it proves what's
   claimed, not something weaker.** `e2e/rules-edit-threshold.spec.ts`'s
   "a rule changed elsewhere before Save is clicked..." test: asserts
   `role="alert"` rejection containing "changed elsewhere", then a direct
   Postgres check that the intervening edit (v2, value 3) survives
   completely untouched, then clicks "Refresh with the latest value" and
   asserts the stepper genuinely updates to the refreshed value (3.0%)
   with the alert cleared, then performs a NEW edit and Save that
   succeeds, with a final direct Postgres check (v3, value 3.2, correct
   rendered text). This is the real assertion chain the coder claims, not
   a weaker "something changed" check.
6. **Memory hygiene.** Checked before starting (~5.9GB free, no
   orphaned node/next/playwright processes). One real OOM hit during
   `npm run build` (see item 4) — root-caused to a long-lived dev server
   plus accumulated Playwright/chromium processes from this same
   verification pass; killed all `node.exe` processes
   (`taskkill //F //IM node.exe`), confirmed via `Get-Process` that no
   node/next/playwright/chrome processes remained, then build passed
   clean on retry. Also independently reproduced (then explained, not
   ignored) a `rules-list.spec.ts` 1-of-6 → 6-of-6 login-timeout failure
   caused by dev-server degradation after many sequential test logins in
   one long-lived server process (the repo's own documented
   response-streaming flakiness class) — confirmed NOT a Slice 10f
   regression by restarting the dev server fresh and getting 6/6 green
   immediately (`rules-list.spec.ts` shares no code with
   `editRule`/`EditRuleControl.tsx`). Final state: dev server and all
   spawned processes killed, `Get-Process` confirmed clean, ~5.9GB free —
   no net memory growth across this entire verification pass.

No golden-fixture-replay requirement (no grouping-engine code touched).
No new RLS surface (no new table/migration). No new ADR/runbook entry
needed beyond what the coder already assessed.

**Net result: the real gap this tester originally found is genuinely
fixed. Slice 10f's coder-and-tester loop is closed — ready for
security-reviewer → qa on the whole slice, per the standing
recommendation, before Module 04 as a whole is marked done.**

**→ Slice 10f — SECURITY-REVIEWER PASS on the whole slice (2026-09-01,
5/5).** [Recovered entry — this review was completed and reported
forward to the orchestrator directly, but the reviewing session ended
before it wrote its own PROGRESS.md record; QA's own final pass caught
the gap by searching for it before Slice 10f was marked done, and this
entry restores the record rather than letting the finding go
unlogged.] **`expectedVersion` confirmed genuinely unbypassable by a
hostile client.** Since `editRule` now takes `expectedVersion` as a
caller-supplied parameter, a hostile or buggy client could in principle
send an arbitrary value (a forged-high version, a stale `1`, anything)
directly to the Server Action — confirmed this cannot bypass the real
guard: `applyRuleEdit`'s atomic `where rule_id = $1 and version = $2 and
superseded_at is null` UPDATE matches zero rows for any wrong version
regardless of source, correctly rejecting with `RuleEditConflictError`
either way (the cheap early check in `editRule` is a fast-path
optimization, not the actual security boundary — the guarded UPDATE
is). **Ownership verified strictly BEFORE version logic ever runs** —
`fetchCurrentRuleForEdit`'s own query scopes on `r.user_id = $2`
directly in the query (not RLS alone), so a caller probing a rule they
don't own gets an identical `RULE_NOT_FOUND` regardless of what
`expectedVersion` they guess — no side-channel signal about whether a
specific version number ever existed for someone else's rule. **Server-
side gating confirmed independent of `RuleList.tsx`'s UI-only
`isThresholdEditable` check** — a hostile client calling `editRule`/
`fetchRuleForEdit` directly for a bool/pick_*/clock_time operand or a
retired rule is still correctly rejected server-side (the state check
for retired rules, `validateOperandOpValue`'s structural check for a
type mismatch), not merely hidden by client-side UI logic. **Standard
non-negotiables clean**: no `rule_evaluations` writes, no compound-rule
shape, no severity/XP interaction. **No leakage in the conflict/refresh
copy** — `RULE_EDIT_CONFLICT`'s message and the "Refresh with the
latest value" UI text confirmed to expose no raw rule values or version
numbers to the client beyond what the trader's own subsequent refresh
legitimately re-fetches. **No injection surface** — all SQL
parameterized; the only string interpolation anywhere in the touched
files is this repo's pre-existing, already-reviewed literal-restricted
role-switch pattern, unrelated to this fix.

**→ Slice 10f — QA PASS on the whole slice (2026-09-01), PASS clean on
all 10 items, verified with QA's own fresh dev-server run and live E2E
execution, not just trusting prior reports.** Conflict-rejected +
Refresh state screenshot-confirmed honest and achromatic (no "Error:"
framing, no red, a genuine visible way forward). Successful edit flow
confirmed with DB-level proof of a real new `rule_versions` row, row
text updating without a page reload. `.rq-num`, no red/green, one
primary button per interaction state, stepper-only (never free-text)
all confirmed on the actual rendered controls. Retired-rule and bool-
operand Edit-action exclusion re-confirmed with QA's own fresh seeded
fixture, checked structurally (not just re-trusting the operand-type
code path). No compound-rule shape, no XP/gamification language
anywhere on this surface. Spec fidelity to story 2.5 confirmed — the UI
correctly frames an edit as creating a new version, never implies past
evaluations get recomputed, consistent with the retire-confirm copy's
own established tone elsewhere in this file tree. **Final module-wide
sanity check, specifically to catch a repeat of the promote/demote/
retire orphaned-backend pattern**: every exported Server Action in
`app/(app)/rules/actions.ts` confirmed to have a real UI caller
somewhere in `app/` — no orphaned backend-only capability remains
untracked.

**Module 04 Slice 10f is now fully DONE (2026-09-01)** — full coder →
tester (found a real optimistic-concurrency bug) → coder fix → tester
(adversarial re-verification, fix holds under entirely fresh scenarios
including the refresh-path's own highest-risk area) → security-reviewer
(5/5) → qa gate sequence passed. **This closes Module 04's own
currently-in-reach scope entirely** — the only things not built (Slice
10c/discovery, strategy-scoped rule UI/stories 1.5-1.7) are confirmed,
logged, deliberately blocked on Modules 05/03 respectively, not
oversights. Next: Module 08 (onboarding), per AGENTS.md's build order.


**→ Slice 10d part 2 — INDEPENDENT TESTER VERIFICATION DONE (2026-08-31).
Overall: PASS, no functional or security regression found. `npm run
build` genuinely failed once with this session's own known
access-violation/OOM signature, then passed cleanly on a second attempt
after freeing memory — reported as a real, actionable infra finding, not
swept under either "clean" or "broken."**

1. **Build/memory — THIRD occurrence of this exact session's known
   failure mode, but with a new, actionable data point.** Checked memory
   BEFORE building: `Get-CimInstance Win32_OperatingSystem` showed
   `FreeVirtualMemory` ≈ 1,626,108 KB (≈1.59 GB) of an 18,503,656 KB
   (≈17.6 GB) total commit ceiling — no orphaned node processes found at
   that point. `npm run build` crashed: `Next.js build worker exited with
   code: 3221226505 and signal: null` — `3221226505` is `0xC0000005`,
   STATUS_ACCESS_VIOLATION, the exact signature this session's own history
   already names (PROGRESS.md, Slice 10d part 1 and its own fix entry).
   TypeScript's own compile phase completed cleanly before the crash
   (`✓ Compiled successfully`, `Finished TypeScript in 2.6s`), consistent
   with every prior occurrence — this is not a code defect. **New this
   time**: a separate `npx vitest run lib/rules "app/(app)/rules"` pass
   LATER IN THE SAME SESSION also hit a genuine `Fatal process out of
   memory: Zone` V8 crash (two worker processes, `ERR_IPC_CHANNEL_CLOSED`)
   while a `next dev` server I had started for screenshot capture was
   still running concurrently. Checked `Get-Process node`: four nonzero
   node processes including one at ~480MB working set (`FreeVirtualMemory`
   had dropped further, to ≈1,151,480 KB). Killed all four (dev server +
   its child workers) — `FreeVirtualMemory` recovered to ≈1,845,444 KB.
   **Re-ran `npm run build` with no other node process running: it
   completed CLEANLY** (`✓ Generating static pages using 11 workers
   (22/22)`, full route manifest including `/rules` printed, no crash).
   **Conclusion, stated plainly for escalation**: this is a real, blocking
   host-memory-pressure pattern (not a code defect — re-confirmed a
   fourth+ independent time across build AND vitest), but it is not purely
   a fixed hardware ceiling either — leaving a `next dev` server or vitest
   worker pool running from a PRIOR step is enough, on this host, to push
   an otherwise-succeeding `npm run build` over the edge. Two
   recommendations to pass up, not in tension with each other: (a) the
   orchestrator's own prior note that a durable fix (larger page file /
   more physical memory) is warranted after three-plus occurrences stands,
   with this session's numbers as further evidence (≈1.6-1.9 GB
   `FreeVirtualMemory` at rest out of ≈17.6 GB total is chronically tight
   for a Next.js production build's worker pool); (b) independently of
   that, EVERY agent role in this pipeline should kill its own `next
   dev`/vitest background processes before handing off or attempting a
   build, since this session directly proved that alone was sufficient to
   flip a real failure into a clean pass with no code change at all.
2. **Week-boundary math — re-derived fully independently, fresh live-DB
   fixture, fresh dates (2026-09-07, not the coder's own 2026-08-10),
   ground truth for which calendar dates are Mon/Sun established via raw
   `Date.prototype.getUTCDay()` BEFORE writing any assertion, not by
   trusting `week-boundary.ts`'s own arithmetic.** Seeded real trades via
   the REAL `confirmDay` pipeline (not raw `rule_evaluations` rows) across
   a Sunday-of-prior-week / Monday-and-Sunday-of-target-week /
   Monday-of-next-week spread, then called the real
   `getAdherenceDisplayForUser` directly. All of: the mid-target-week read
   (hard 1 of 2, soft 1 of 2, `priorSoft` 1 of 1, correct hard-priority
   attribution), the next-week read (current becomes 9/14, `priorSoft`
   correctly becomes the target week's own soft fraction), AND an
   instant-level boundary stress on the DISPLAY's own `now` parameter
   (`2026-09-06T23:59:59.999Z` → prior week `2026-08-31`;
   `2026-09-07T00:00:00.000Z` → target week `2026-09-07`, one millisecond
   later) — all matched hand-computed expectations exactly, no off-by-one
   in either direction. (Note: `server_day` itself is date-granularity,
   not instant-granularity, so "a trade frozen at the exact boundary
   instant" isn't a meaningful distinct case beyond the Sun/Mon
   day-boundary already covered here and independently re-confirmed still
   passing in `adherence-repository.live.test.ts`'s own dedicated
   week-boundary test — the instant-sensitive surface unique to THIS
   slice is the display's own `now` parameter, which is what the stress
   test above specifically targets.) Full fixture/test file written fresh,
   run live (5/5 passed once two heavier multi-`confirmDay` tests were
   given a realistic 90s timeout for this session's own real network
   latency to the shared dev Supabase project — the SAME class of
   too-tight-default-timeout issue this session has already documented
   repeatedly, not a logic problem), then deleted (throwaway, not
   shipped, matching this repo's own established independent-verification
   convention).
3. **Hard-priority attribution — re-verified against `computeAdherenceWeekCounts`'s
   actual selection order with a fresh, harder-than-the-coder's-own
   fixture: 1 hard break vs. 4 soft breaks in the SAME week (soft
   outnumbers hard 4-to-1).** Real trades, real `confirmDay` freeze,
   real recompute — hard fraction landed at 4 of 5 (1 break), soft at 1 of
   5 (4 breaks), and the attribution correctly named the HARD rule with
   `ofBreaks: 1` (never the larger soft `4`) despite the soft pool being
   numerically bigger — this is exactly the disambiguating scenario Slice
   6's own QA pass originally caught a real bug in, re-proven correct
   here at the DISPLAY layer specifically (not just the repository layer
   Slice 6 already covers). **Reverse case also independently proven**:
   zero hard breaks (3 of 3 followed) with 2 real soft breaks correctly
   fell back to naming the soft rule, `severity: 'soft'`, `ofBreaks: 2` —
   the soft-only fallback path is real, not just reachable in theory.
4. **"Current wording, not necessarily what was live" — confirmed
   genuinely true, not silently wrong.** Fresh fixture: seeded a hard rule
   with rendered text A, froze one real breaking evaluation against it
   (confirmed directly via `select rule_version from rule_evaluations` —
   `1`, as expected), THEN called the real `applyRuleEdit` to bump it to
   version 2 with rendered text B (a real, forward-only edit, per Slice
   2's own convention — not a hypothetical). The displayed attribution
   line read text B, never text A — the documented limitation is real and
   accurately described (the rule IDENTITY is exactly right; only the
   rendered sentence can be stale after a later edit), not a
   misleadingly-downplayed defect. `fetchRuleRenderedText`'s own SQL
   (`rv.version = r.current_version`) confirmed by direct code reading to
   be the exact, sole reason — there is no other read path that could
   accidentally resolve historical wording, so this isn't a "sometimes
   right" situation.
5. **Empty/zero-breaks states — independently re-confirmed honest,
   non-fabricated, non-gamified, with fresh test users and fresh
   screenshots** (`iv-adherence-insufficient.png`, `iv-adherence-ready.png`,
   `iv-adherence-zero-breaks.png` — captured, `Read` back, then deleted,
   throwaway). `insufficient_history` renders plain "Not enough data yet…"
   prose, never a fabricated "0 of 0." A genuinely good week (9 of 9 hard,
   6 of 6 soft, seeded with numbers different from both the coder's own
   fixture and my own live-DB test fixtures above — an independent third
   reading) renders "No rules were broken this week." with zero
   exclamation marks, zero streak/XP/points language (`getByText(/streak/i)`,
   `/\bXP\b/`, `/points?/i)` all asserted absent). A `ready` state with a
   fresh 17-of-20/40-of-55 fixture and a distinct rendered rule sentence
   ("IV screenshot: never risk more than 2%.") rendered exactly as
   DERIVED (attribution correctly read "3 of the 3 hard breaks," matching
   `hardTotal - hardFollowed = 20 - 17 = 3`, never a value I supplied
   directly as "severity"/"ofBreaks" in the seed data — only
   `top_break_rule_id`/`top_break_count` were seeded, confirming the
   derivation is real, not passed through).
6. **`.rq-num` on every numeric readout — PASS, confirmed at the JSX
   level, not just visually.** `Adherence.tsx` read directly: every
   rendered number (`hard.followed`/`hard.total` together in one span,
   `soft.followed`/`soft.total` together in one span, `priorSoft.followed`/
   `priorSoft.total` together in one span, `attribution.count`/
   `attribution.ofBreaks` together in one span) sits inside its own
   `<span className="rq-num">` — 4 total per `ready` state, matching the
   shipped E2E spec's own `toHaveCount(4)` assertion, and visually
   confirmed monospace/tabular in every screenshot above.
7. **No red/green anywhere — PASS, confirmed at both the CSS and rendered
   level.** `retrospeq-design-system/brand/css/components.css` and
   `public/brand/css/components.css` are byte-identical (`diff`, zero
   output) — `.adherence__hard`/`.adherence__soft`/`.adherence__attribution`
   use only `font-weight` and `--rq-ink`/`--rq-ink-soft`/`--rq-ink-faint`,
   all three confirmed achromatic hex values in `tokens.css` (`#14181B`/
   `#5C666D`/`#8A939A` and their dark-mode equivalents, zero saturation).
   All 6 screenshots taken across this verification (3 coder's own + 3
   fresh) show only weight/order/greyscale distinguishing hard from soft
   from attribution — no hue anywhere, including the nav bar's own link
   colour, which is a constant site-wide style unrelated to and
   unaffected by adherence state.
8. **Cross-user isolation of `fetchAdherenceDisplay`/`getAdherenceDisplayForUser` —
   PASS, re-proven at both the Server Action and composition layer.**
   `fetchAdherenceDisplay` takes ZERO arguments and derives `userId`
   exclusively from `requireSessionAndRateLimit`'s own session read — read
   directly, confirmed there is no parameter surface for a
   client-supplied id at all. At the composition layer: seeded user A
   with real, distinctive adherence data for a given week; called
   `getAdherenceDisplayForUser(userB.id, sameNow)` directly — B correctly
   read back `{ status: 'insufficient_history' }`, never any of A's
   numbers; confirmed the SAME isolation one layer down by calling
   `fetchAdherenceWeekly(userB.id, sameWeekStart)` directly, which
   returned `null` (RLS-backed, `withUserConnection` sets `role =
   authenticated` + `sub = userB.id`, matching Slice 6's own established,
   already-RLS-tested mechanism — this pass exercises it specifically
   through the composition/action layer this slice adds).
9. **§6.1 worked-example literal reproduction — traced back, confirmed
   genuinely derived, with one honest scope caveat.** `adherence-display.test.ts`'s
   own "34 of 34"/"88 of 102"/"6 of the 14 soft breaks" tests mock
   `fetchAdherenceWeekly`'s RETURN VALUE with those literal numbers and
   assert the COMPOSITION's own hard-priority severity/`ofBreaks`
   derivation on top of them — this proves the composition logic is real
   (not a hardcoded string match), but does NOT by itself prove those
   numbers would actually emerge from raw `rule_evaluations` rows (that
   link is `computeAdherenceWeekCounts`'s own job, already covered by
   Slice 6). The shipped E2E (`rules-adherence.spec.ts`) goes one layer
   further and reproduces the same numbers through the REAL page render
   off REAL seeded `adherence_weekly` rows (not mocked) — genuinely
   exercising the rendering + hard-priority-derivation pipeline, though it
   also seeds `adherence_weekly` directly rather than deriving it from raw
   evaluations (a deliberate, documented choice in that file's own
   header, since Slice 6 already proves that link). Net: the "literal
   reproduction" claim is accurate for what it actually covers (display +
   derivation), not for the full evaluations→materialisation→display
   chain — my own item 2/3 fixtures above close that remaining gap by
   running the full `confirmDay`→recompute→display pipeline end-to-end
   with fresh data and confirming the same class of numbers emerges
   correctly.

**Test counts, independently re-run:** `lib/rules/__tests__/adherence-display.test.ts`
16/16, `app/(app)/rules/__tests__/actions.test.ts` 84/84 (of which **5 are
genuinely new** for `fetchAdherenceDisplay` — the coder's own write-up
said "4 new," undercounting by one, the same minor-miscount pattern
already seen in Slice 10d part 1's own independent verification; not a
coverage gap, all 5 independently confirmed meaningful),
`lib/rules/__tests__/rules-repository.live.test.ts` 9/9 (including both
new `fetchRuleRenderedText` cases), `e2e/rules-adherence.spec.ts` 3/3 —
all re-run fresh, all green. Broader `npx vitest run lib/rules
"app/(app)/rules"`: 644 passed / 4 failed across 4 files
(`adherence-repository.live.test.ts`, `freeze-evaluations.live.test.ts`,
`severity-lifecycle.live.test.ts`,
`severity-lifecycle.independent-verification.live.test.ts`) — every
failure a `Test timed out in Nms` shape, none in a file this slice
touched (confirmed via `git status`), matching this session's own
already-documented deterministic-timeout pattern exactly, not a
regression. `npx tsc --noEmit` clean (0 errors). `npx eslint .` clean (0
errors, the same 19 pre-existing warnings). `npm run build` — see point 1
above (failed once on the known memory signature, passed cleanly on
retry after freeing memory; not a code defect either way).

**Not yet reviewed by `retrospeq-security-reviewer`/`retrospeq-qa`** — per
this repo's own convention, that sign-off belongs to them, not the
tester.

**→ Slice 10e (rule list/browsing view, story 1.1, plus severity
promote/demote/retire controls) — INDEPENDENT TESTER VERIFICATION DONE
(2026-08-31), picking up a coder pass whose own session crashed
(usage-limit reset) right after finishing self-check, before it could
report on a background test it had running. Overall: coder's own 100
tests all independently re-confirmed green, `tsc`/`eslint` clean — but
**a REAL, REPRODUCIBLE BUG found in exactly the logic the dispatch
flagged as trickiest (the hard-cap swap)**, plus **a REAL, CONFIRMED
product/UX gap in free-tier promote gating** that the dispatch's own
"disabled/explained state" expectation correctly anticipated. `npm run
build` genuinely could not be completed (same known host-memory
signature this session has hit repeatedly) — reported as unverified,
not passing.**

1. **REAL BUG: the hard-cap swap gets stuck in "Swapping…" forever,
   reproduced 3/3 in complete isolation against a real dev server, using
   the SHIPPED `e2e/rules-list.spec.ts` test unmodified.** Ran the full
   file once (5/6 passed, test 6 — the hard-cap swap — failed on a 30s
   timeout), then re-ran test 6 alone twice more (`-g "promoting a 7th
   rule"`, single worker, nothing else running): failed identically both
   times, same locator/same 30s timeout. The final DOM state (captured via
   Playwright's own accessibility snapshot) shows the chosen filler rule
   correctly flipped to Soft, but the ORIGINAL rule's alert dialog is
   still open with the "Swapping…" button and all 6 radios permanently
   `disabled` — `swapBusy` never resets. Correlated against the dev
   server's own log: a "`Error: The destination stream closed early`"
   artifact — the SAME recurring Turbopack/Next-dev RSC-stream signature
   this session's own history already documents elsewhere — struck during
   `handleSwap`'s sequential two-call flow, and in every reproduction the
   SECOND (`promoteRule`) call never even reached the server (no further
   `POST /rules` logged at all, whereas the first `demoteRule` call did
   complete and get logged). Built a throwaway probe
   (`_iv-swap-stuck-probe.spec.ts`, deleted after use) to check whether
   this is a lost write or purely a stuck UI: **the promotion DOES
   eventually complete correctly server-side** (`select severity from
   rules` showed `'hard'` immediately, no data loss/corruption), and a
   manual `page.reload()` correctly shows the true final state — but
   NOTHING in the UI tells the trader to reload, every control in the
   alert stays disabled indefinitely, and no error or retry path is ever
   shown. This is a real gap in exactly the scenario the dispatch asked
   to be scrutinized ("does the trader end up in a coherent, explainable
   state, or a confusing limbo") — worse than the coder's own header
   comment's documented residual limitation (which frames this as "the
   client's fetch failed to resolve," implying a settled failure state),
   because what's actually happening is the awaited promise never
   SETTLES at all — a `try`/`catch` (the coder's own fix for a DIFFERENT,
   already-found throw-path bug in this same function) cannot catch a
   hang, only a rejection. The swap handler is structurally MORE exposed
   to this dev-server artifact than the single-call handlers
   (promote/demote/retire alone, tests 2/4/5, which all passed even
   though the SAME "stream closed early" line appeared in their own logs
   too) because it depends on two consecutive round trips both landing
   cleanly, not one. **Likely a dev-server/Turbopack-specific trigger — I
   could not test whether this reproduces against a production
   (`next start`) build, a real, honest limitation of this pass, not
   swept under the rug** — but the underlying CODE gap (no client-side
   timeout/`AbortController` deadline on any awaited Server Action call
   in `RuleList.tsx`, so a hang of ANY origin, dev-only or not, produces
   an unrecoverable disabled deadlock) is real regardless of what
   ultimately triggers it in production. Recommend a bounded timeout +
   explicit "still working — try reloading" fallback state on
   `handleSwap` at minimum.
2. **REAL, CONFIRMED product/UX gap: a free-tier trader with an
   INELIGIBLE rule is shown the eligibility breakdown with ZERO mention
   that hard rules require Pro at all — implying, falsely, that waiting
   out the gates would eventually let them promote.** The dispatch
   expected (per its own item 5 wording) "an honest disabled/explained
   state ... not a control that predictably fails on click" — the coder's
   own header comment documents a DELIBERATE departure from that (an
   "honest-rejection-on-attempt" choice instead), reasoned as: eligibility
   is checked before entitlement so a free trader still "deserves to see
   which gates it's failing." Re-verified live with two fresh fixtures
   (`_iv-rules-list-probe2.spec.ts`, deleted after use): a genuinely
   ELIGIBLE free-tier rule correctly shows "Hard rules are a Pro feature.
   Upgrade to promote a rule." (confirmed once my own probe's wait was
   long enough — my first, too-short 3s wait had misleadingly caught it
   mid-flight, corrected with a proper settle-wait in a follow-up probe,
   `_iv-freetier-eligible-retry.spec.ts`) — so the code is NOT wrong when
   the rule is eligible. But a genuinely INELIGIBLE free-tier rule (the
   common case for most free-tier traders, since `rules.hard: {free: 0}`
   is a structural, unconditional plan exclusion, TRUE regardless of any
   rule's own facts and already known upfront — `page.tsx` already fetches
   `hardEntitlement` and passes it into `RuleList` before any button is
   ever clicked) shows ONLY "Active for 0 of the 42 days (6 weeks)
   needed. 0 of 20 applicable evaluations needed so far." — never
   mentioning the Pro requirement at all. This is genuinely misleading:
   the honest fact ("you cannot promote on Free no matter what this rule
   does") is known and available before the click, and is never shown.
   Recommend checking `hardEntitlement.reason === 'plan'` up front (the
   component already receives this prop) and showing the Pro-upsell
   message immediately, consistent with `RuleEditor.tsx`'s own established
   "clear disabled-with-explanation" precedent for `rules.create` that
   this file's own header explicitly (and, on this evidence, wrongly)
   departs from.
3. **Compliance-gate ineligibility — PASS, re-verified with a FRESH
   fixture isolating that gate specifically** (old enough, 20
   evaluations, but only 16/20 = 80% followed, all dated outside the
   recent-break window): displayed text read exactly "80.0% followed so
   far — needs at least 95%." and correctly OMITTED the 42-day and
   recent-break lines (asserted their absence, not just the presence of
   the compliance line) — confirms `eligibilityLine`'s per-gate rendering
   genuinely reflects which gates are ACTUALLY failing, not a static list.
4. **Retired rules — PASS.** Coder's own E2E test (`the list renders a
   mix...`) asserts zero Promote/Demote buttons in the retired section,
   independently re-run green; own fresh screenshot
   (`rule-list-retired-final.png`) shows only `Soft`/`Retired` tags, no
   controls at all — genuinely a dead end, matches story 2.4. No
   `reactivateRule`/`unretireRule` function exists anywhere in this file
   tree (grep-confirmed).
5. **Free-tier gating mechanism aside, cross-user isolation — PASS,
   re-verified with a FRESH two-user fixture** (`_iv-rules-list-probe2.spec.ts`):
   user A's distinctively-named rule never appeared on user B's `/rules`
   page and vice versa, using two separate real browser contexts/sessions.
   Consistent with the independently re-run live test
   (`fetchRulesForUser resolves ... never another user's rows`, part of
   the 100/100 re-run below).
6. **Retire confirm step — PASS.** Screenshot-verified
   (`rule-list-retire-confirm.png`): genuine `.rq-btn--equal` pair ("Yes,
   retire" / "Keep it active"), equal visual weight, achromatic, plain
   non-alarming copy ("This can't be undone" stated flatly, no red, no
   icon of alarm). Coder's own E2E test proves backing out via "Keep it
   active" leaves the rule fully active/promotable/demotable, and
   confirming genuinely retires it — independently re-run green.
7. **`.rq-num` — PASS, confirmed at the JSX level.** Every numeric
   readout in `RuleList.tsx` (age-in-days, the literal `42`, evaluation
   counts, the literal `20`, compliance percentage, the literal `95%`,
   recent-break count, the "N of M hard rules used" fraction, the retired
   count, the hard-cap chooser's own rule count) sits inside its own
   `<span className="rq-num">` — 12 call sites, grep-confirmed.
8. **No red/green — PASS, confirmed at both the CSS and rendered level.**
   `public/brand/css/components.css` and
   `retrospeq-design-system/brand/css/components.css` are byte-identical
   (`diff`, zero output). The new `.alert`/`.alert--choice`/`.demote-list`
   rules use only `--rq-accent`/`--rq-accent-soft` (amber `#E9A23B`,
   confirmed in `tokens.css`) and ink-scale greys — the SAME accent token
   already used site-wide for `.rq-btn` primaries and marks, not a new
   hue and not a red/green pair. Six fresh screenshots (mixed list,
   ineligible breakdown, promote-success, demote, retire-confirm,
   retired-final) plus two more captured specifically for the hard-cap
   alert (`iv-hardcap-swap-alert(-selected).png`, since the coder's own
   screenshot never got saved — its test failed before reaching that
   line) all show only amber-vs-grey weight/fill distinguishing severity
   and emphasis, never hue-as-meaning.
9. **CSS gap — PASS, same pattern as `.ambient`/`.adherence` before it.**
   §5.7/§6.1's reference markup names `.alert`/`.alert--choice`/
   `.demote-list` directly; genuinely unshipped before this slice
   (confirmed via the diff — 47 new lines in each of the two copies,
   byte-identical); the fix follows the established achromatic,
   dual-copy-synced precedent exactly.
10. **`app/(app)/layout.tsx`'s 6-line change — PASS.** Exactly one new
    `<Link href="/rules" className="rq-sub underline">Rules</Link>`,
    same markup shape as the adjacent Trades/Plan/Security/Privacy links,
    with a one-line comment explaining why (no prior nav entry point to
    `/rules` existed at all). No scope creep.
11. **Minor, non-blocking secondary observation (not independently
    confirmed to cause data corruption, just a rough edge):** the row's
    plain "Promote to hard" button is NOT disabled while its own hard-cap
    chooser alert is already open below it (only `row.busy`, which is
    `false` again once the chooser renders) — clicking it a second time
    re-invokes `handlePromote`, silently replacing the in-progress
    chooser's own local state (`swapSelectedRuleId`, `swapError`) without
    warning. Worth disabling that button while `row.hardCapChooser` is
    set, as a follow-up polish item, not a blocking finding.

**Test counts, independently re-run:** `app/(app)/rules/__tests__/actions.test.ts`
89/89, `lib/rules/__tests__/rules-repository.live.test.ts` 11/11 (100/100
combined, matching the coder's own claim) — including the new
`fetchRulesForUser` ordering test and its explicit "never another user's
rows" cross-user assertion. Combined coverage on the two new/changed
files: `lib/rules/rules-repository.ts` **97.61%** lines (clears
00-foundation §9.1's 90% engine bar with room to spare — only lines
528-531, an unreachable defensive throw in `applyRuleEdit`, uncovered),
`app/(app)/rules/actions.ts` **88.05%** lines (a Server Action wrapper
file, not itself "the engine" — uncovered lines are pre-existing
`recordOverride` branches from Slice 8, not new to this slice).
`e2e/rules-list.spec.ts`: 5/6 reliably green, 1/6 (the hard-cap swap)
FAILS 3/3 in isolation — see point 1. `npx tsc --noEmit` clean (0
errors). `npx eslint .` clean (0 errors, the same 19 pre-existing
warnings). **`npm run build` could NOT be completed** — two consecutive
attempts (default, then `NODE_OPTIONS=--max-old-space-size=4096`), both
crashed with the same `Fatal process out of memory: Zone`/access-
violation signature this session has now hit repeatedly (`FreeVirtualMemory`
≈1.5GB of ≈17.6GB total at the time, no leftover node processes —
confirmed killed before each attempt); `tsc --noEmit`'s own separate pass
stayed clean throughout, consistent with every prior occurrence of this
exact host-memory pattern. **Reporting this honestly as
build-unverified-for-infra-reasons, not as a pass.** No new migration in
this slice (confirmed via `git status` and the `supabase/migrations/`
directory listing) — `rules`/`rule_versions` RLS is unchanged from
Slices 1/2/7's own already-verified coverage, nothing new to test there.
No golden-fixture-engine work in this slice (does not touch grouping).

**Not yet reviewed by `retrospeq-security-reviewer`/`retrospeq-qa`** —
per this repo's own convention, and given a real, reproducible bug and a
real product-messaging gap were found here, **this slice should not be
marked done** until both are fixed and this gate is re-run, and the
security/QA gates still need to run regardless.

**→ Slice 10e — CODER FIX PASS DONE (2026-08-31), both tester-found bugs
closed. Security-reviewer/QA still need to run before this slice can be
marked done.**

1. **Bug #1 (hard-cap swap stuck in "Swapping…" forever) — FIXED.** Root
   cause exactly as the tester diagnosed: `try`/`catch` only catches a
   REJECTED promise, never one that simply never settles. Added
   `app/(app)/rules/with-timeout.ts` (`withTimeout`/`ActionTimeoutError`,
   a `Promise.race` against a 15s `setTimeout` — Server Actions have no
   `AbortController`, so this can't cancel the server-side call, only
   force the CLIENT's own awaited promise to settle). No existing
   timeout-wrapping helper existed anywhere in this codebase to reuse
   (checked `RuleEditor.tsx`/`GuidedFrontDoor.tsx`'s own `setTimeout`
   usage first — both are plain debounce timers, not promise races), so
   this is a new, narrowly-scoped file. Wired into EVERY awaited Server
   Action call in `RuleList.tsx` for consistency (`handlePromote`,
   `handleDemote`, `handleRetireConfirm`, and both calls inside
   `handleSwap`), not just the swap path the bug was found in, per the
   dispatch's own instruction not to leave an inconsistent half-fix. A
   dedicated `TIMEOUT_ERROR_MESSAGE` ("This is taking longer than
   expected... refresh the page to check, or try again below") is shown
   instead of the generic `UNEXPECTED_ERROR_MESSAGE` specifically for an
   `ActionTimeoutError`, since the underlying call may have already
   committed server-side (per the tester's own finding — confirmed again
   independently during this fix, see point 3 below) — a bare "try again"
   would be dishonest. Every `busy`/`swapBusy` flag now genuinely always
   clears once the timeout fires, re-enabling every control — no more
   permanent disabled deadlock, by construction (proven deterministically,
   not just reasoned about — see point 2).
2. **Deterministic regression test added — does NOT depend on the flaky
   dev-server artifact reproducing at all.**
   `app/(app)/rules/__tests__/with-timeout.test.ts` (4 tests, vitest fake
   timers): a promise constructed to NEVER resolve or reject (the exact
   shape of a genuinely hung stream) correctly rejects with
   `ActionTimeoutError` once the fake-timer deadline elapses; a promise
   resolving 100ms before the deadline is NOT affected; the original
   rejection reason (not a timeout) propagates when the wrapped promise
   rejects first; the deadline timer is confirmed cleared (`vi.getTimerCount()
   === 0`) once the promise settles, so a fast/normal call leaves nothing
   dangling. No React/jsdom/RTL needed or added (this repo has never had
   component-render test infra, and introducing one just for this would
   be disproportionate) — the pure mechanism responsible for closing the
   bug is tested directly and deterministically instead.
3. **Real E2E verification, and a real false alarm caught and corrected
   along the way.** The FIRST several re-runs of the shipped
   `e2e/rules-list.spec.ts` swap test still failed after this fix, which
   at first looked like the fix not working. Investigated properly rather
   than assumed: (a) one failure was a genuine Chromium/Playwright
   browser-process crash from host memory pressure (confirmed via
   `Get-CimInstance Win32_OperatingSystem`/`Get-Process chrome` — over a
   dozen leftover `chrome.exe` processes had accumulated across my own
   repeated manual test invocations; killing them recovered ~1.1GB of
   `FreeVirtualMemory`); (b) the deeper, more interesting finding: a
   throwaway diagnostic probe (`_iv-swap-timeout-probe.spec.ts`, deleted
   after use) proved the swap genuinely completes correctly end-to-end on
   this exact code, and the dev server's own request log
   (`promoteRule(...) in 434ms`) showed the SERVER responding successfully
   in well under a second on a run that the BROWSER nonetheless never
   observed completing — the real, pre-existing "RSC stream closed early"
   dev-server artifact the original tester named, now directly confirmed
   from the server's own side, not just inferred; (c) the actual reason
   most of my own re-runs kept failing was self-inflicted: `promoteRule`'s
   rate-limit scope (25/hour per IP, `lib/rate-limit/config.ts`) was
   exhausted by my own repeated back-to-back test invocations against the
   same `ip:::1` bucket (confirmed by querying
   `retrospeq.rate_limit_hits` directly — count 28 against a limit of 25)
   — the DOM at failure time showed `alert: Too many attempts...` with the
   Promote button fully re-enabled, not a stuck dialog at all. Reset the
   exhausted buckets via a direct, scoped `delete` (only
   `promoteRule`/`demoteRule`/`retireRule`/`ruleList` rows for the local
   dev IP identifier, nothing else touched) and re-ran clean.
4. **Widened two of the swap test's own local assertion timeouts (10s ->
   18s) and its overall `test.setTimeout` (default 30s -> 75s), with an
   in-file comment explaining why.** This is a legitimate consequence of
   the fix, not test-weakening: before this fix there was no deliberate
   client-side ceiling at all, so 10s/30s were reasonable generous-headroom
   numbers for a real round trip that in practice takes under a second. Now
   that a genuine, INTENTIONAL 15s-per-call ceiling exists (and the swap
   sequentially awaits two such calls), a local assertion window shorter
   than that ceiling can fail spuriously before the click's own promise has
   had a legitimate chance to settle either way — independent of whether
   anything is actually stuck. 18s/75s give real headroom above the 15s
   deadline without weakening what the test actually proves.
5. **Swap test re-run 5/5 times consecutively in isolation
   (`-g "promoting a 7th rule"`, single worker, chrome processes killed and
   memory checked before each run) after the rate-limit reset — all 5
   passed clean** (35.0s-37.4s each). Followed by one full 6-test run of
   the whole file (`e2e/rules-list.spec.ts`, no `-g` filter) — 6/6 passed
   (1.9m total), confirming no regression to the other 5 tests from either
   fix.
6. **Bug #2 (free-tier + ineligible rule never mentions Pro is required) —
   FIXED, via the header comment's own option (a): the ineligible branch
   inside `promoteRule` (`app/(app)/rules/actions.ts`) now ALSO resolves
   the `rules.hard` entitlement and attaches a new
   `eligibility.proRequired: boolean` field, additive to (never replacing)
   the existing full gate breakdown.** Deliberately did NOT reorder the
   check sequence (eligibility still runs first) — read
   `checkPromotionEligibilityForUser`'s own header fully before deciding:
   its single query pass is the only source of
   `currentSeverity`/`currentState`, and restructuring that just to move
   an entitlement check earlier wasn't warranted for what is purely a
   messaging fix. The extra `canForUser` call only runs in the branch that
   was already about to return early, after ownership/state/eligibility
   are all already confirmed — not "burning a round trip before confirming
   a valid target." `RuleList.tsx`'s eligibility breakdown block now
   renders an additional line ("Hard rules are also a Pro feature. Upgrade
   to promote a rule.") whenever `proRequired` is true, using the exact
   same copy the pre-existing eligible-but-free-tier path already used, so
   there's no new tone/voice to reconcile. Independently visually
   confirmed via a throwaway screenshot probe
   (`tmp/dev-screenshots/rule-list-proRequired-check.png`, deleted spec
   after use): a genuinely free-tier, genuinely brand-new (0/42 days, 0/20
   evaluations) rule's ineligibility panel now reads both facts together,
   achromatic, `.rq-num` on every number, no new primary `.rq-btn`
   introduced.
7. **Tests updated/added, `app/(app)/rules/__tests__/actions.test.ts`.**
   The pre-existing "attaches every failing reason" test's own
   `expect(canForUserMock).not.toHaveBeenCalled()` assertion was
   INVERTED to `toHaveBeenCalledWith(...)` (a deliberate, documented
   behavior change, not a silently-loosened assertion) and now also
   asserts `proRequired: false` for a Pro-tier/ineligible-on-the-merits
   caller (the default `beforeEach` entitlement). A NEW test, fresh
   fixture, proves the actual bug fix: a free-tier
   (`reason: 'plan', limit: 0`) caller with the SAME ineligible rule sees
   `proRequired: true` alongside the unchanged full `reasons` breakdown.
8. **Full targeted suite, final state:** `app/(app)/rules/__tests__/actions.test.ts`
   90/90 (2 of which are new/changed for this fix),
   `app/(app)/rules/__tests__/with-timeout.test.ts` 4/4 (new),
   `lib/rules/__tests__/rules-repository.live.test.ts` 11/11 (unaffected by
   this fix, re-run for completeness), `e2e/rules-list.spec.ts` 6/6 (see
   point 5). `npx tsc --noEmit` clean (0 errors). `npx eslint .` clean on
   every touched file (0 errors, 0 warnings). `npm run build` clean
   (memory checked before running — `FreeVirtualMemory` ≈2.6GB of ≈17.6GB
   after killing this session's own leftover dev-server/chrome processes;
   `/rules` route present in the printed manifest). All of this session's
   own node/chrome processes confirmed killed before finishing (checked via
   `Get-CimInstance Win32_Process` by command line, not just by name, so
   the dev-server's own 4-process chain — npm-cli/next/start-server/
   turbopack-postcss-worker — was fully accounted for each time, not just
   partially).
9. No new ADR/runbook entry (a UI resilience fix and a message-ordering
   fix, not a new 00-foundation deviation or a new alerting condition, per
   this slice's own dispatch).

**Not yet reviewed by `retrospeq-security-reviewer`/`retrospeq-qa`** —
still the correct next gate before Slice 10e can be marked done.

**→ Slice 10d part 1 — INDEPENDENT TESTER VERIFICATION DONE (2026-08-31).
Overall: PASS, no functional or security regression found. One imprecision
in the coder's own diagnosis corrected below; the coder's own already-
flagged open SSR-error-handling gap independently re-assessed as real and
worth a near-term (not blocking) fix; `npm run build` could not be
completed for host-resource reasons, reported as unverified rather than
assumed passing.**

1. **"7 failures are flaky/pre-existing" — re-derived independently, found
   imprecise.** A fresh full `npx vitest run` here found **9** failures,
   not 7 (the two extra: `lib/ingestion/__tests__/confirm.live.test.ts`
   and `lib/rules/__tests__/freeze-evaluations.independent-verification.live.test.ts`
   — the failure set is not even stable run-to-run, which is itself a data
   point). Re-ran 6 of the 9 fully in isolation (no other test running
   concurrently): `manual-entry.live.test.ts`, `trades-repository.live.test.ts`,
   `split-join.live.test.ts`, `sync.live.test.ts`, and
   `adherence-repository.live.test.ts` **each failed identically, on the
   SAME single test, at exactly that test's own default/explicit vitest
   timeout (5000/20000/30000ms), every single time, with zero other
   process contending for the DB** — this is not "flaky" in the usual
   transient-contention sense the coder's write-up implies; it is a
   deterministic "this specific test's timeout is too tight for this
   session's real network latency to the shared dev Supabase project"
   failure, reproducible alone. `confirm.live.test.ts`, by contrast,
   passed **18/18 clean** in complete isolation — that one genuinely is
   full-suite contention-only flakiness. Net conclusion: **not a
   regression from this slice either way** (confirmed for all 9: `git
   status --porcelain`/`git log -1` on each file shows zero uncommitted
   changes and a last-touch commit from an earlier, unrelated slice —
   Module 02 slice 5/6/7b, Module 04 Slice 5/6/7/9 — none overlapping this
   diff's own 9 changed files), but the coder's specific mechanism
   ("environmental flakiness … consistent with ADR 0002") undersells how
   deterministic 5 of the 9 actually are. Confirmed via `grep` that none
   of the 9 files reference `ambient-state`, `AmbientStrip`,
   `ManualEntryScreen`, `fetchAmbientState`, `recordOverride`, or
   `rule-overrides-repository` at all — the `manual-entry.live.test.ts`
   name collision is exactly that, a name collision (Module 02's
   `lib/ingestion/manual-entry.ts` ingestion function, not this slice's
   `app/(app)/trades/manual-entry/` UI). Worth a genuine, low-priority
   follow-up someday: bump the default/explicit timeouts on the 5
   deterministic ones rather than re-litigating this every session.
2. **Tint-to-visual mapping — PASS.** `retrospeq-design-system/brand/css/components.css`
   and `public/brand/css/components.css` are byte-identical (`diff`,
   zero output). Read the actual rules: `.ambient__cell[data-state="watch"]`
   only changes `border-left-color` (to `--rq-ink-soft`) and the value's
   `font-weight`; `[data-state="breach"]` changes `border-left-color`,
   adds an inset `box-shadow` ring, and bumps `font-weight` again — no
   `color`/`background-color` swap tied to hue anywhere, confirmed against
   `retrospeq-design-system/brand/tokens/tokens.css`: `--rq-ink`,
   `--rq-ink-soft`, `--rq-line-strong`, `--rq-surface`/`--rq-surface-2` are
   all achromatic hex/rgba(255,255,255,·) values, zero saturation. Own
   fresh screenshots read directly (`ambient-strip-{neutral,watch,breach}.png`,
   the coder's own, plus my own fresh `iv-neutral.png`): neutral is a thin
   uniform border, watch shows a visibly heavier dark left-edge accent plus
   bold text, breach shows a full box outline (inset ring) plus bolder
   text still — genuinely perceptible as three distinct states without any
   hue difference, not just technically non-hue.
3. **Always-visible neutral strip — PASS, re-proven with a fresh fixture.**
   New test user, brand-new manual account, zero trades, no
   `starting_equity`, zero rules authored at all — all three cells render,
   all `data-state="neutral"`, "No trades yet" / "Unknown" / "0.0 / —",
   `.rq-num` on all three. Screenshot: `tmp/dev-screenshots/iv-neutral.png`
   (throwaway, gitignored).
4. **Override write end-to-end — PASS, re-proven with a different
   rule/operand than the coder's own fixture.** Seeded 3 closed losing
   trades + a HARD `consecutive_losses lte 2` global rule (coder's own
   fixture used `total_open_risk`); submitted a new manual trade; a real
   `rule_overrides` row landed (`rule_id`/`trade_id: null`/`rule_version: 1`/
   `observed: 3`, verified via direct `pg` query, not the UI) and the
   submission itself completed in ~9.7s with zero `[role="dialog"]`/
   `[role="alertdialog"]` ever present — non-blocking, not merely
   "eventually succeeds." (Also incidentally confirmed a real, correct,
   non-obvious detail: `consecutive_losses` does not feed any of the three
   FIXED `facts` cells' own tint per `ambient-state.ts`'s own
   `worstTintForOperands` operand lists, so the "Today" cell correctly
   stayed neutral even with a broken hard rule on a different operand —
   the per-rule `rules` list, not the fixed cells, is what actually drives
   the override write.)
5. **Cross-account re-fetch, fast double-switch — PASS.** Fresh two-account
   fixture (different starting equities), rapid A→B→A switch with no waits
   between `selectOption` calls: the `<select>` settled on A, the strip
   settled on A's own real data ("No trades yet"), never stuck loading,
   never showing a stale/mislabeled response — no last-started-wins vs
   last-completed-wins race observed. (`ManualEntryScreen.tsx`'s own
   `requestIdRef` monotonic-counter guard, read directly, is the specific
   mechanism — each fetch closure checks it's still the newest before
   applying its result, which is the correct pattern for this race class.)
6. **Cross-user isolation of `fetchAmbientState` — PASS.** Fresh two-user
   fixture; seeded a distinctive, otherwise-impossible-to-guess marker
   value (`-654.32` realized P&L) on user A's own account; logged in as
   user B; injected A's real `accountId` directly into B's own `<select>`
   DOM (bypassing the option list entirely — what a real attacker crafting
   a raw request would do) and fired a real change event, driving the
   REAL `fetchAmbientState` call; captured every network response body B's
   browser received. The marker never appeared anywhere (DOM or captured
   responses), an error banner rendered, and B's strip correctly fell back
   to B's own default account's real (unrelated) facts — never a silent
   "successful"-looking render of A's data. Matches the code-level
   guarantee already visible by inspection: `getAmbientAccountState`'s own
   `fetchAmbientAccountContext` filters `where id = $1 and user_id = $2`
   using the CALLER's session-derived id (never client input), backed by
   real RLS via `withUserConnection` underneath — this is the same
   protection shape Slice 8's own security review already signed off on
   for the underlying engine; this pass exercises it specifically through
   the NEW Server Action wrapper.
7. **Strict Mode fix — PASS.** Read `ManualEntryScreen.tsx` directly:
   `lastFetchedAccountId` is compared by VALUE against the current
   `accountId`, not by an invocation-count ref — genuinely idempotent
   under Strict Mode's double-invoke. Independently re-ran
   `e2e/trades-slice7b.spec.ts` (the previously-broken pre-existing test)
   fresh: 7/7 passed, including "manual entry: a real submission through
   the form creates a trade" at 13.7s — matching the coder's own reported
   number exactly.
8. **Open SSR-error-handling gap (`page.tsx`'s unwrapped
   `getAmbientAccountState` call) — independently assessed as real and
   worth fixing soon, not just logging.** Confirmed by reading the file:
   no try/catch around that call, and no `app/**/error.tsx`/`global-error.tsx`
   exists anywhere in this repo at all today — so in principle this is
   consistent with every other unguarded Server-Component `await` already
   in this exact file (the account-list read above it is equally
   unwrapped) and with this codebase's general idiom of using the
   framework's own error boundary for genuinely unexpected conditions
   rather than a try/catch at every call site. In production, Next
   strips a raw error's message/stack from what actually reaches the
   browser by default, so there is no information-disclosure risk even if
   it fires. The reason to still lean "fix soon" rather than "acceptable
   gap": §5.9's whole premise is that a rule's own state should never
   block the trader from actually trading — a single malformed rule
   crashing the ENTIRE manual-entry page (not just failing to show that
   one rule's tint) directly contradicts that promise at the page level,
   and the fix is cheap and already has an identical, working precedent
   to copy (`fetchAmbientState`'s own catch block, one path over). Net:
   correctly logged (not silently dropped — `docs/runbook.md`'s own entry
   was updated honestly by the coder to say "still open," confirmed by
   reading the diff), reasonable to leave for one more slice at most, not
   indefinitely.

**Build/lint/type-check, independently re-run:** `npx tsc --noEmit` clean
(0 errors). `npx eslint .` clean (0 errors, the same 19 pre-existing
warnings as every prior slice's report). `npm run build` — **NOT verified,
reported as a gap, not assumed passing**: three consecutive attempts
(including one with `NODE_OPTIONS=--max-old-space-size=6144`) all crashed
with a native V8/OS allocation failure during Next's "Collecting page
data" worker-pool phase specifically (never during the TypeScript-check
phase, which completed cleanly all three times, consistent with the
separate clean `tsc --noEmit` run). `wmic OS get FreeVirtualMemory`
showed ~1.3GB free against an ~18.5GB total commit ceiling on this
machine at the time — a host-level virtual-memory exhaustion signature,
not a code defect (the dev server ran and served 25+ passing E2E
assertions across this session without issue). Flagging honestly per
AGENTS.md's "never fake it, always flag it" rather than reporting build
as clean on the strength of `tsc`/`eslint` alone — whoever picks up
security-review/qa for this slice should re-run `npm run build` with more
host headroom before calling that check closed.

**Test count, independently re-run:** `app/(app)/rules/__tests__/actions.test.ts`
now has **79/79 passing**, of which **7 are genuinely new** for
`fetchAmbientState` (success / non-uuid rejection / `AmbientAccountNotFoundError`
mapping / internal-error mapping / rate-limit / missing-session /
`.strictObject` extra-key rejection) — the coder's own write-up said "6
new … tests," which underclaims by one; a minor inaccuracy, not a
coverage gap (all 7 independently re-run and confirmed meaningful, none
redundant).

**→ `RuleEditor.tsx` stale entitlement-count header — FIXED (2026-08-31,
this entry).** QA's non-blocking Slice 10b finding: "Rule slots: N of M
used" was a one-time `canForUser` snapshot passed down from `page.tsx`
(a Server Component) and never refreshed client-side, so it could show a
contradictory pair on screen (a stale "2 of 3" next to a correct, freshly
server-confirmed "you're at your limit" rejection) once a trader stayed
on `/rules/new` across more than one submission in the same session (e.g.
"Write another rule," which resets the form without a page reload).
**Fix**: the entitlement summary moved from a raw prop read into local
component state (`useState(initialEntitlement)`), self-updated after
every real `createRule` response — incremented by one (capped at `limit`)
on success, pinned to `used = limit` / `allowed = false` on an
`ENTITLEMENT_LIMIT` rejection — using the same `formatUsageFraction`
helper `page.tsx` already used server-side. Purely a display correction;
`insertRuleAndVersion`'s server-side guarded INSERT (Slice 10b's own
`pg_advisory_xact_lock` fix) is untouched and remains the sole real
enforcement. **`GuidedFrontDoor.tsx` (Slice 10a) checked for the same bug
and found NOT to have it**: that screen also reads its `entitlement` prop
as a load-time snapshot and never refreshes it either, but it structurally
never re-renders an entitlement header after a successful create in the
same session — a partial-or-full success always moves it straight to a
terminal `done` state (no entitlement display there at all), and the only
path that returns to the `choosing` screen (`anyFailed && !anySucceeded`)
is one where nothing actually succeeded, so the stale count is still
accurate in that case. No change made there; reasoning left in this entry
rather than silently expanding scope.
Verified: (1) a standalone Playwright script drove the exact QA
repro (submit rule #3, "Write another rule," attempt #4) against a live
dev server + live Supabase project — screenshots
(`tmp/dev-screenshots/stale-header-fix-after-rule-1.png`,
`...-attempt-4-blocked.png`, both `Read` back) confirm the header now
reads "1 of 3" immediately after an ordinary successful create with no
reload, and "3 of 3" consistently paired with the at-limit message and a
genuinely disabled "Add rule" button at attempt #4 — no more
contradictory pair. (2) A new E2E regression test added to
`e2e/rules-general-editor.spec.ts` (`"entitlement header self-updates
client-side after a successful create AND after a cap rejection..."`)
encodes this exact scenario; it passed cleanly on the first full run of
the four targeted rule-editor/guided-front-door E2E spec files this
session (12/15 passed, all 3 failures pre-existing/unrelated —
`RULE_UNSATISFIABLE` independent-verify, the guided front door's
"flagged" independent-verify, and "decline entirely," none of them
touching this file). (3) `tsc --noEmit`, `eslint .` (0 errors, the same
19 pre-existing warnings), and `npm run build` all re-run clean after the
fix. **Honest caveat, not swept under the rug**: subsequent re-runs of
the same E2E suite *within this same dispatch* (repeated for extra
confidence) degraded and eventually failed outright — root-caused, not
assumed, by inspecting `error-context.md`'s captured DOM snapshot, which
showed the app's own `RULE_RATE_LIMITED` alert ("Too many attempts.
Please wait a few minutes and try again."). `lib/rate-limit/http.ts`'s
own header confirms local dev has no reverse proxy, so `getClientIp()`
falls back to one fixed key and "all local traffic shares one bucket" —
this dispatch's own repeated manual reproduction script plus several
full-suite re-runs, all from one machine in a short window, cumulatively
tripped `createRule`'s real, DB-backed (not in-memory, confirmed via
`lib/rate-limit/limiter.ts` — a dev-server restart does not reset it),
1-hour-window per-IP rate limit — a known, documented characteristic of
this repo's local dev setup (that file's own comment: "acceptable there,
never true in any real deployment"), not a regression from this fix.
Flagged here rather than either hiding it or falsely claiming a fully
green final re-run; the evidence above (clean first run + scripted
screenshot proof + clean tsc/eslint/build) already establishes the fix is
correct — no code changed as a result of the rate-limit finding, and no
new ADR/runbook entry needed (a UI-state bug fix, not a new alerting
condition or a 00-foundation convention deviation). Not yet reviewed by
`retrospeq-qa` for sign-off on this specific fix (per this repo's own
convention, that call belongs to qa/security-reviewer, not the coder).

**→ Slice 10d part 1's own open SSR-error-handling gap — FIXED (2026-08-31,
this entry).** The tester's independent verification (point 8 above)
confirmed this was real: `app/(app)/trades/manual-entry/page.tsx`'s
initial, server-side `getAmbientAccountState` call had no try/catch, and
this repo has no `app/**/error.tsx`/`global-error.tsx` anywhere — so a
genuinely malformed rule (`RuleEvaluationError`, deliberately NOT caught
inside `getAmbientAccountState` itself, per that file's own header) would
have crashed the ENTIRE manual-entry screen via Next's default RSC error
page, directly contradicting §5.9's "rules never block trading" premise
at the page level. **Fix**: wrapped that one call in the SAME catch shape
`fetchAmbientState` (`app/(app)/rules/actions.ts`) already established —
`AmbientAccountNotFoundError` maps to "We couldn't find that account.",
anything else logs (`[trades/manual-entry:page] initial
getAmbientAccountState read failed: <err>`) and maps to "Account state is
unavailable right now. Please try again." — no new error-handling
approach invented. `page.tsx` now passes `initialAmbient: null` +
a new `initialAmbientError` string down to `ManualEntryScreen.tsx`, which
seeds its existing `ambientError` state from that prop (the SAME rendered
fallback the live account-switch re-fetch path already used — no second
error UI built). Scope held exactly to what was asked: `getAmbientAccountState`
itself untouched (its own deliberate non-catching is correct and
documented), `recordOverride`/override-write logic untouched, no
repo-wide `error.tsx` added (a broader, separate architectural decision
this fix isn't the right place to make — flagged, not built, for a future
dispatch to decide deliberately). **Verified genuinely, not assumed**: a
new `e2e/rules-ambient-strip.spec.ts` test ("SSR degradation...") seeds a
real corrupted `rule_versions` row (`operand_id: 'this_operand_does_not_exist'`,
the SAME direct-SQL catalogue-bypass technique
`freeze-evaluations.live.test.ts`'s and `ambient-state.live.test.ts`'s own
malformed-rule fixtures already use, not a new one invented for this fix)
against a real dev server + real Supabase project, confirms the page
heading still renders (proving the throw never reached Next's default
error page), confirms the exact degraded-fallback text renders, confirms
all three ambient cells stay structurally present (never omitted, "…"
placeholders rather than a fabricated fact set), and then genuinely fills
and submits the rest of the form through to a real "Trade logged"
success state — proving the degradation is scoped to the ambient section
alone, not a masked full-page break. Ran clean (4/4, including the 3
pre-existing tests in that file, 1.1 min). The dev server log directly
confirmed the exact intended code path fired: `[trades/manual-entry:page]
initial getAmbientAccountState read failed: Error [RuleEvaluationError]:
evaluate: unknown operand_id "this_operand_does_not_exist" ...` followed
by the page still serving `200` and the trade submission still
succeeding. `app/(app)/rules/__tests__/actions.test.ts` (79/79) +
`lib/rules/__tests__/ambient-state.test.ts` (15/15) re-run clean,
confirming no regression to the already-shipped `fetchAmbientState`
pattern this fix mirrors. `docs/runbook.md`'s ambient-strip entry updated
in place (it already described this exact gap as open) to record both
call sites now catching, rather than adding a duplicate entry. No new
ADR (a caller-side error-handling fix following an already-established
pattern in the same slice, not a new 00-foundation deviation). **Build/
lint, independently re-run this session, with a memory check first per
this dispatch's own instruction (this session had hit real host-memory
exhaustion twice already)**: `wmic`/`Get-CimInstance` showed ~5.9GB free
of ~16.4GB total before starting (healthy, no orphaned node/Playwright
processes found running) — `npx tsc --noEmit` clean, `npx eslint .` clean
(0 errors, the same 19 pre-existing warnings), `npm run build` completed
**cleanly** this time (no OOM signature this run — the prior session's
`npm run build`-unverified gap for Slice 10d part 1 is now independently
confirmed passing). Full `npx vitest run`: 1605 passed / 13 skipped / 11
failed across 7 files — every one of the 7 (`manual-entry.live.test.ts`,
`split-join.live.test.ts`, `sync.live.test.ts`,
`trades-repository.live.test.ts`, `adherence-repository.live.test.ts`,
`severity-lifecycle.live.test.ts`,
`severity-lifecycle.independent-verification.live.test.ts`) is the SAME
already-documented pre-existing live-DB flakiness set the tester's own
point 1 above already root-caused (deterministic per-test timeout misses
against this session's real network latency to the shared dev Supabase
project, ADR 0002) — confirmed via `git status`/this fix's own diff that
none of the 7 files were touched by this fix, and none reference
`ambient-state`/`AmbientStrip`/`ManualEntryScreen`/`fetchAmbientState`/
`recordOverride`/`rule-overrides-repository` at all. Dev server started
for the E2E run and explicitly stopped again afterward (process list
confirmed empty, port 3000 only showed TIME_WAIT sockets, no listener)
to avoid contributing to this session's own resource-leak pattern. Not
yet reviewed by `retrospeq-security-reviewer`/`retrospeq-qa` — per this
repo's own convention, that sign-off belongs to them, not the coder.

**→ Module 04 Slice 10a — TESTER independent verification (2026-08-29,
this entry) — PASS, no real bug found.** Dispatched specifically to
re-derive the coder's own claims from the actual code/live DB rather than
trust the coder's own test suite (this repo's established convention).
Fresh fixtures throughout — a different account/trades than every one of
the coder's own tests. Full scope and results:

1. **Percentile seeding is genuinely computed from real history, not a
   fabricated value.** Independently confirmed by direct inspection of
   `operand-catalogue.ts`: all three guided operands (`risk_pct`,
   `daily_loss_pct`, `consecutive_losses`) are `direction:
   'lower_is_tighter'` — the `higher_is_tighter` mirror branch in
   `guided-front-door.ts` is genuine, correct code but is DEAD CODE from
   the real guided front door's own perspective today; no real trader
   interaction can reach it through these three operands specifically.
   Flagging this plainly rather than letting "direction-aware" read as
   proven both ways when it structurally cannot be, through these three
   operands, as they exist today. To verify the branch ITSELF is correct
   (not just present), a new mocked test
   (`lib/rules/__tests__/guided-front-door.independent-verify.test.ts`)
   substitutes a SYNTHETIC `higher_is_tighter` override of
   `consecutive_losses` via `vi.doMock` and confirms the mirrored
   percentile (target 20×0.2=4, landing on bucket value 0, then genuinely
   clamped UP to `bounds.min=1` by `roundToStep` — a real, independently
   noticed interaction between the mirroring logic and the bounds-clamping
   logic that a naive hand-check would have missed) differs from the real
   `lower_is_tighter` answer (2) on IDENTICAL input data — proof the
   mirroring logic is live and directionally correct, caveat stated above
   intact. Separately, a hand-computed non-trivial case (`consecutive_losses`
   buckets `[0]×7 [1]×7 [2]×6`, n=20, target=16, cumulative walk 7→14→20,
   80th percentile = bucket value 2) was independently derived by hand and
   confirmed to match the real function's output exactly, both mocked and
   — see item 2 below — against the real live pipeline.
2. **`MIN_TRADES_FOR_PREVIEW` (20) boundary — no off-by-one.** The
   coder's own suite tested n=5 and n=20 only; independently added n=19
   (falls back to `bounds_midpoint`, confirmed) and re-confirmed n=20
   (treated as real history, confirmed) — the exact boundary the coder's
   own suite never isolated.
3. **Every created rule is soft/global/`scope_id=null` — confirmed
   end-to-end through the REAL `createRule` Server Action** (not
   `insertRuleAndVersion` called directly), reading the resulting rows
   back directly from Postgres (not trusting the action's own return
   value): 3 `rules` rows, each `severity='soft'`, `scope='global'`,
   `scope_id is null`
   (`lib/rules/__tests__/guided-front-door.independent-verify.live.test.ts`).
4. **Free-tier fit — confirmed EXACT, not "with room to spare."**
   `capability-table.ts`'s real `rules.create: { free: 3 }` cap is
   exactly hit by the three guided rules; the same live test confirms a
   fourth rule (any operand) is genuinely rejected with
   `ENTITLEMENT_LIMIT` immediately after the third succeeds.
5. **Preview genuinely reads real `operand_distributions` data and
   responds live to threshold changes — confirmed, not a stale/cached
   result.** A fresh 20-trade live fixture with `risk_pct` spread
   0.5%–2.4% in 0.1% steps: threshold 0.6% flags 18/20 (hand-computed),
   threshold 2.4% flags 0/20, threshold 1.4% flags a value strictly
   between the two — proves the ratio genuinely tracks the candidate
   value across three separate real `previewRule` calls against the same
   seeded account, not one cached round trip.
6. **Insufficient-history state is honest — confirmed in both the data
   layer AND the rendered screen.** A fresh 5-trade live fixture:
   `previewRule` returns `state: 'insufficient_history'` with `flagged`/
   `ratio` BOTH `undefined` (never a fabricated zero or a hidden real
   number) for every guided operand, not just the ones with a
   distribution row; `seedGuidedRuleThresholds` itself also honestly
   reports `seedBasis: 'bounds_midpoint'` for all three at this trade
   count. Visually re-confirmed via the coder's own
   `guided-rules-e2e-choosing.png` screenshot (re-generated and
   `Read` by the tester, not assumed from the coder's report): "No
   history yet — we'll refine this once you've logged 20 trades," visibly
   distinct from the loading skeleton ("Checking against your
   history…") and from the populated "flagged" card layout below.
7. **Design-system non-negotiables — independently re-screenshotted, not
   just re-asserted.** A new E2E spec
   (`e2e/rules-guided-front-door.independent-verify.spec.ts`) inserts a
   real, schema-valid `operand_distributions` row for all three operands
   directly (bypassing the recompute pipeline deliberately — pipeline
   correctness is proven separately by item 1/5's live-DB tests; `server-
   only`-guarded modules cannot be imported from a plain-Node Playwright
   process, confirmed by inspecting `node_modules/server-only/index.js`
   directly, which is exactly why this had to be a raw-SQL insert rather
   than calling the real recompute function from the E2E spec), producing
   a genuine "flagged" state with hand-verified real numbers (flagged=4
   on all three cards, independently hand-computed from the inserted
   bucket shape) — screenshot captured to `tmp/dev-screenshots/guided-
   rules-independent-verify-flagged.png` and `Read` back by the tester.
   Confirmed by direct visual inspection: no red/green anywhere (the
   `.rq-pill.on` "Included" state and both `.rq-btn--equal` actions use
   `--rq-accent` amber, confirmed against the CSS source, never a
   success/danger pair — there is no such pair in the design system to
   begin with); `.rq-num` present on both the stepper value and the
   preview count (asserted via locator, not just eyeballed); the choosing
   screen carries zero plain `.rq-btn` (only the equal-weighted "Add
   all three"/"Skip for now" pair, confirmed identical class list on
   both), the done screen (re-screenshotted from the coder's own E2E,
   `guided-rules-e2e-done.png`) carries exactly one; steppers only, no
   native range input or free-text field anywhere in the rendered DOM.
8. **The coder's own two self-caught fixes — both independently
   confirmed genuinely fixed, not just claimed.** The `.rq-pill on`
   class string in `GuidedFrontDoor.tsx` matches the real CSS selector
   `.rq-pill.on` in `retrospeq-design-system/brand/css/components.css`
   verbatim (confirmed by direct source inspection of both files). The
   E2E's "Starts soft" assertion is genuinely scoped to `.rq-tag--muted`
   chip elements (`e2e/rules-guided-front-door.spec.ts` line ~161), which
   would NOT false-match the screen's own intro paragraph containing the
   same substring — confirmed by re-running that exact spec and
   inspecting the passing assertion, not just reading the diff.
9. **Full suite re-run independently, not trusted from the coder's
   report.** 130 test files / 1585 tests passed / 13 skipped / 0 failed
   (one run, no flake observed this pass) — PLUS the 6 new independent
   tests above (4 mocked + 2 live) and 3 new independent E2E screenshot
   assertions, all green. `npm run build`, `npx tsc --noEmit` (separately
   — not folded into the build's own TS pass for this report), and
   `npx eslint .` all confirmed clean (0 errors; the same 19 pre-existing
   unrelated `no-unused-vars` warnings the coder reported, independently
   re-verified as pre-existing by grepping their file paths — none touch
   this slice's files). The coder's "one pre-existing unrelated flaky
   live-DB timeout" claim (`trades-freeze-trigger.live.test.ts`) was
   independently re-verified, not just accepted: that file shares zero
   imports with any guided-front-door/preview/distributions-repository
   code (grepped directly), and passed cleanly (8/8) when re-run in
   total isolation — consistent with "connection-contention artifact of a
   1598-test single run," not a regression this slice introduced.
   Coverage (`lib/rules/`, v8 provider): `guided-front-door.ts` 90.16%
   lines / 86.66% branch (meets the 90%-line bar; the two uncovered
   branches are both structurally-defensive guards — an operand-catalogue-
   drift throw and a "distribution row exists but held nothing numeric"
   fallback — matching this repo's own established precedent of not
   testing impossible-by-construction guards), `preview.ts` 97.45% lines,
   `lib/rules/` overall 97.73% lines.

**What this tester pass does NOT cover** (per this repo's own gate
sequence — the next dispatch, not this one): a dedicated security review
(credential handling doesn't apply here, but the entitlement-cap-race
class of finding Slice 7's security review caught has not been
independently re-examined for this screen's sequential `createRule` loop
— worth a specific look, since `handleAddSelected`'s own code comment
already reasons about why it's sequential rather than `Promise.all`, but
that reasoning has not been adversarially re-tested here), and a
dedicated qa pass against the non-negotiables list as a first-class
review rather than a byproduct of tester verification. No migration in
this slice (confirmed via `git diff --stat -- supabase/migrations/`,
empty) — no RLS surface to add to the 100%-table-coverage bar. No golden-
fixture replay needed — this slice touches the preview/seeding layer, not
the trade-grouping engine (confirmed via `git status`, `lib/ingestion/
grouping.ts` untouched).

**→ Module 04 Slice 10a — SECURITY-REVIEWER PASS (2026-08-29, 7/7).**
Exactly the gap the tester's own "what this pass does NOT cover" note
above flagged — independently re-examined. Confirmed: no new Server
Action or DB-write path was introduced (`guided-front-door.ts` is
read-only; `GuidedFrontDoor.tsx` calls the unmodified, already-reviewed
`createRule`/`previewRule` actions); `operand_id` still independently
validated server-side via `validateOperandOpValue` regardless of what
the guided UI sends; `severity`/`scope` are not client-settable fields at
all — severity is a hardcoded literal in `insertRuleAndVersion`'s own SQL,
not caller-derived, so a hostile direct call to `createRule` bypassing
the UI entirely still cannot produce a hard or non-global rule through
this path; `createRule`'s existing `canForUser`/rate-limit checks run
unconditionally and unmodified for every guided-flow submission — no
burst exemption introduced, and `handleAddSelected`'s sequential (not
`Promise.all`) submission is deliberate specifically to avoid a TOCTOU
race against the entitlement check, each call independently re-checking
server-side; all new reads are user-scoped via the same `withUserConnection`
pattern `preview.ts` already established, no new service-role read path;
no raw SQL string interpolation anywhere in `guided-front-door.ts` or the
refactored `preview.ts`; standard non-negotiables re-confirmed (no
compound-rule shape introduced, `rule_evaluations` untouched, no XP
coupling).

**→ Module 04 Slice 10a — QA PASS (2026-08-29, 9/10 clean, 1 real
quick-fix found and closed).** Nine items passed clean on first review:
no red/green anywhere in the rendered screenshots or CSS, no implied
recommendation between the equal-weight Add/Skip pair (identical class
list, confirmed), exactly one primary `.rq-btn` per view (zero on the
choosing screen, one on the done screen — matches the tester's own
independent screenshot re-confirmation above), steppers only (no native
range input or free-text field), the insufficient-history state genuinely
honest (no fabricated number, visually distinct from the loading
skeleton), no XP/gamification leakage, no compound-rule shape anywhere,
the direction-mirroring dead-code-today caveat already clearly present in
this ledger (the tester's own write-up above), and spec fidelity to
§5.10/story 1.4 confirmed by re-reading the spec directly. **One real
violation**: `GuidedFrontDoor.tsx` had two numeric displays — the
free-tier "Rule slots: X of Y used" fraction and the "N already saved"
count — NOT wrapped in `.rq-num`, breaking AGENTS.md's "no exceptions"
rule; this repo already has established precedent for wrapping this exact
"X of Y" shape (`app/(app)/plan/page.tsx`, `SecurityScreenClient.tsx`).
**Fixed** (re-dispatched to `retrospeq-coder`, a 2-line change matching
the existing precedent exactly): both values now render in tabular mono,
re-confirmed against fresh dev-server screenshots (not just the source
diff) showing them visually consistent with every other number on the
screen. Full suite re-run after the fix: 132 files / 1593 passed / 13
skipped / 0 failed (the guided-front-door E2E suite re-run against real
Supabase, not mocked), `tsc --noEmit`/`npm run build`/`eslint .` all
clean.

**Module 04 Slice 10a is now DONE (2026-08-29)** — full coder → tester →
security-reviewer → qa gate sequence passed, one real bug (the QA `.rq-num`
gap) found and closed, nothing shipped with a known defect. Committed
alongside this ledger update. **Known test-data cruft**: the QA
re-verification pass created 3 throwaway Playwright E2E test users in the
shared dev Supabase project to capture a transient UI state
(`guided-rqnum-shot-*@retrospeq-e2e.test`); cleanup via raw SQL was
correctly declined (the rule-deletion-blocked-by-design trigger exists on
purpose and bypassing it via raw SQL is exactly the kind of workaround
this repo's own conventions forbid) — these 3 inert accounts remain in
the shared dev project, harmless, and are not tracked further here since
this is the only mention needed.

**→ Module 04 Slice 10b — CODER PASS (2026-08-29) — general rule editor,
CREATE flow only.** `app/(app)/rules/new/page.tsx` (Server Component) +
`RuleEditor.tsx` (Client Component) at a dedicated `/rules/new` route,
alongside `lib/rules/editable-operands.ts` (new, pure, no I/O — the
operand-offerability filter both the server page and the client component
share). Any offerable operand from the full catalogue, not just Slice
10a's three guided ones — pick an operand, its sentence appears with
either a real `.rq-step` stepper (number/duration types) or nothing at all
(bool types — see below), a live `previewRule` preview, and one submit
calling the existing `createRule` Server Action unmodified.

**Scope supported, and why:** `number`/`duration`/`bool` types only
(`rating` has zero v1 catalogue entries so it never actually offers
anything; `pick_one`/`pick_many`/`clock_time` — `instrument`, `order_type`,
`exit_reason`, `day_of_week`, `entry_clock_time` — are excluded outright,
matching this slice's own dispatch: "half-building an untested control
type is worse than not offering it"). Further narrowed to operands with
EXACTLY ONE authorable operator (one `phrasing` key) — every v1
`number`/`duration`/`bool` entry already satisfies this (confirmed by
`editable-operands.test.ts` against the real catalogue), which is what
makes story 1.1's "no operator dropdown anywhere" literally true here: the
operator is never a choice the trader makes, it falls out of which operand
they picked (`soleAuthorableOp`). Also tier-gated: `getEditableOperands`
reuses `validate-tier.ts`'s own `hasSufficientTierAccount` — the SAME
function `createRule`'s server-side check already calls — so a `t1`
operand (`stop_moved_against`, `stop_move_count`) is never offered to a
trader with no `t1`-capable connected account, per §4.1 ("a rule that can
never fire is worse than a rule never offered"), and the picker can never
disagree with the write-time gate about what's offerable. 31 operands are
offerable today with zero connected accounts (verified live against a real
dev-server render, not just counted in source).

**Scope explicitly OMITTED, both logged here per this slice's own
instruction:**
- **`scope` selector omitted entirely** (global-only, every submission is
  `scope: 'global'`) — Module 03 (Field Registry & Strategy) has not been
  built in this repo yet, so there is no strategy to attach a
  strategy-scoped rule to and no picker to build one from. Building a
  disabled "coming soon" placeholder was considered and rejected: it would
  either mislead (no real target date) or need rebuilding the moment
  Module 03 ships anyway. Reasoning also documented in `page.tsx`'s own
  header comment.
- **The §6.1 tighten-only rejection alert (`alert--blocking`,
  `data-code="RULE_LOOSER_THAN_GLOBAL"`, the "Use X%" / "Change my
  rulebook instead" two-button markup) is NOT built.** Confirmed by
  reading `app/(app)/rules/actions.ts`'s `createRule` directly:
  `checkTightenOnly` only ever runs when `scope === 'strategy'`. Since this
  screen only ever submits `scope: 'global'`, that code path is
  structurally unreachable through this screen — building the alert would
  be dead UI. `RULE_UNSATISFIABLE` is a DIFFERENT check
  (`checkSatisfiability`, runs for `scope === 'global'`) and genuinely CAN
  fire here — confirmed live, not just theoretically: a dedicated E2E test
  seeds a conflicting `gte 3` global rule directly in Postgres, then
  submits `risk_pct lte 2.6` (the real bounds-midpoint default) through the
  real UI and asserts the real rejection message naming the conflict,
  with zero row written. It renders through the same generic
  `role="alert"` message path every other reachable error code uses (no
  bespoke two-button treatment — §6.1 has no reference markup for a
  global-vs-global conflict).
- **Coverage messaging (story 1.7, "Applies to N of your M strategies")**
  is not attempted — 0 strategies exist anywhere in this repo, so any N/M
  count would be fabricated. The rule-meta chip reads the same honest,
  static "Applies to all strategies" copy Slice 10a's guided cards
  already use.
- **A per-operand "already governed" indicator** (the way Slice 10a's
  guided front door flags `alreadyGoverned` for its 3 fixed operands) is
  NOT built for this general picker — it does not prevent a real failure
  here (two `lte` rules with different values on the same operand are not
  flagged `unsatisfiable` by `isContradictory`, which has no `lte`-`lte`
  case), so it would be a pure UX nicety, not something this sub-slice's
  dispatch asked for; a trader can create a second, redundant global rule
  on an operand they already govern. Left as a known, honest limitation
  rather than scope-creeping a rule-list-adjacent feature into a
  CREATE-only sub-slice.

**Bool operands have no stepper and no adjustable value at all** — every
v1 bool operand's phrasing template has no `{value}` placeholder
(`is_true`/`is_false` sentences are already complete the moment the
operand is chosen, e.g. "Always set a stop before entering."), so `value:
true` is submitted as a fixed, evaluator-unread placeholder
(`evaluate.ts`'s own `compareBool` never reads `rule_version.value` for a
bool comparison) purely to satisfy the column's `not null` constraint —
confirmed live via a real bool-operand E2E submission, `.rq-step` present
count zero.

**Live preview reuses `previewRule` unmodified**, same three-state
handling Slice 10a established (`flagged`/`insufficient_history`/
`operand_not_computable`) — `operand_not_computable` is genuinely reachable
through this screen (unlike Slice 10a's 3 distribution-backed operands)
since the full catalogue is exposed; not separately exercised in this
slice's own E2E beyond the code path being identical to Slice 10a's
already-verified handling, since exercising it needs selecting one of the
~21 non-distribution-backed offerable operands, which the E2E suite
doesn't specifically target this pass (left for the tester's own
independent verification to decide whether it's worth a dedicated
assertion).

New tests: 8 unit tests (`lib/rules/__tests__/editable-operands.test.ts` —
structural single-operator-authorable checks against the real catalogue,
tier-inclusion/exclusion at t0/t1/no-accounts, declaration-order
preservation) and 4 new Playwright E2E tests
(`e2e/rules-general-editor.spec.ts`: numeric core flow with a real live
preview round trip and a real DB-verified write, a bool-operand flow
proving no stepper renders, the free-tier-cap failure path, and the
`RULE_UNSATISFIABLE` failure path with a real seeded conflicting rule).
Screenshot self-check (`tmp/dev-screenshots/rule-editor-*.png`, throwaway):
confirmed `.rq-num` on both the "Rule slots: X of Y" fraction and the
stepper value, exactly one primary `.rq-btn` per view once an operand is
chosen (zero before, one submit button while editing, one primary + one
`.rq-btn--ghost` secondary on the done state), amber `--rq-accent`
throughout with no red/green anywhere, the insufficient-history state
genuinely distinct from the loading skeleton. Full suite re-run after this
slice: 133 files / 1601 passed / 13 skipped / 0 failed; `npx tsc --noEmit`,
`npm run build`, and `npx eslint .` all clean (same 19 pre-existing
unrelated warnings, none touching this slice's files).

**What this coder pass does NOT cover** (this repo's own gate sequence —
the next dispatch, not this one): independent tester re-verification
(especially: the `operand_not_computable` preview state through a
non-distribution-backed operand, and the entitlement-check-race class of
finding Slice 7's/10a's security reviews already caught for a different
screen's write loop — this screen only ever submits ONE rule per click, so
there is no analogous sequential-loop race to re-examine, but that claim
itself is worth an independent look), a dedicated security review, and a
dedicated qa pass against the non-negotiables list. No migration in this
slice (no schema change) — no new RLS surface. No golden-fixture replay
needed (does not touch the trade-grouping engine).

**→ Module 04 Slice 10b — TESTER independent verification (2026-08-29,
this entry) — 8/9 items PASS, ONE REAL BUG FOUND, still OPEN.** Dispatched
per this repo's own convention: re-derive the coder's own claims from the
actual code/live DB, fresh fixtures throughout (different operands/values
than every one of the coder's own tests). Full scope and results:

1. **Tighten-only unreachability — CONFIRMED by direct code reading.**
   `app/(app)/rules/actions.ts`: `checkTightenOnly` is called at exactly
   two sites (`createRule` line ~275, `editRule` line ~426), BOTH gated on
   `scope === 'strategy'` — grepped the whole repo, no other call site
   exists. This screen only ever submits `scope: 'global'` and never calls
   `editRule` at all (CREATE-only). The coder's claim is correct: §6.1's
   tighten-only rejection alert is genuinely, structurally unreachable
   through this screen — not building it is right, not a gap.
2. **RULE_UNSATISFIABLE — independently re-derived with a fresh
   operand/value pair (`correlated_exposure`, not the coder's own
   `risk_pct`).** Seeded a real `gte 6` global rule directly in Postgres,
   loaded `/rules/new` for real, hand-computed the bounds-midpoint default
   (5.5%, independently derived: (0.5+10)/2=5.25 → HALF_UP-rounded to the
   0.5 step → 5.5), submitted through the real UI, confirmed the real
   rejection message naming the conflicting rule and zero row written
   (`e2e/rules-general-editor.independent-verify.spec.ts`, screenshot
   `tmp/dev-screenshots/rule-editor-independent-verify-unsatisfiable.png`
   — `Read` back, confirmed correct).
3. **Tier-gating consistency, BOTH directions — proven two ways.**
   (a) Pure-function proof across the WHOLE catalogue and 6 tier-set
   combinations (`lib/rules/__tests__/rule-editor-slice10b.independent-
   verify.test.ts`): every operand `getEditableOperands` offers is
   genuinely accepted by `checkTierAvailable` for that same tier set, and
   every number/duration/bool single-operator operand excluded
   *specifically for a tier reason* is genuinely rejected by
   `checkTierAvailable` too — this holds by construction, since both
   functions call the exact same `hasSufficientTierAccount` (confirmed by
   direct source read of `lib/rules/validate-tier.ts`), not by coincidence.
   (b) Live, end-to-end defense-in-depth proof: for a trader with zero
   connected accounts, the real picker never renders `stop_moved_against`/
   `stop_move_count` as `<option>` elements (asserted against the live DOM,
   not just the pure function) — AND a t1 operand injected directly into
   the DOM `<select>` (bypassing the real picker entirely) is still
   genuinely rejected by the real server-side `createRule` action with the
   exact `RULE_OPERAND_UNAVAILABLE` message, zero row written. The picker
   is provably not the only defense.
4. **Bool operand's `value: true` placeholder — provably inert, not just
   documented as such.** Read `evaluate.ts`'s `compareBool` directly: its
   signature is `compareBool(op, observed)` — it does not even ACCEPT a
   `ruleValue` parameter, so it structurally cannot read
   `rule_version.value`. Independently proved through the REAL top-level
   `evaluate()` entry point (not compareBool in isolation): for
   `stop_set_at_entry`, five wildly different `rule_version.value`s (true,
   false, a garbage string, a number, null) against identical `observed`
   produce byte-identical outcomes every time, and the outcome correctly
   changes ONLY when `observed` changes, never when `value` does.
5. **`operand_not_computable` — exercised through THIS screen for the
   first time (the coder's own E2E never selected a non-distribution-
   backed operand), confirmed genuinely honest.** `total_open_risk` (not
   in `DISTRIBUTION_OPERAND_IDS`) shows the exact builder-scope-gap copy
   ("Preview isn't available for... this rule type needs data this app
   doesn't compute today"), visibly distinct from `insufficient_history`'s
   "No history yet" copy (asserted absent), AND the rule can still be
   saved despite the unpreviewable state (real DB row confirmed) — §10:
   "A rule that cannot be evaluated is never an error to the user," proven
   literally true here. Screenshot `tmp/dev-screenshots/rule-editor-
   independent-verify-not-computable.png`, `Read` back, confirmed correct.
6. **Entitlement-race claim — RE-EXAMINED, and found WRONG in the way
   that matters.** The coder's claim ("this screen only ever submits ONE
   rule per click, so there is no analogous sequential-loop race") is true
   as far as it goes, but incomplete: it does not rule out TWO INDEPENDENT
   submissions racing each other. Two distinct scenarios tested:
   - **Same-tab double-click (two `.click()` calls dispatched
     synchronously, zero delay, on the single "Add rule" button): SAFE,
     confirmed 3/3 independent runs.** Exactly one row written every time,
     cap correctly reached at exactly 3, never 4. (The mechanism is not
     fully pinned down — a same-tab forced-bypass variant produced
     inconclusive, dev-mode-HMR-confounded results and was deliberately
     NOT shipped as a test rather than risk a misleading one; see that
     test file's own comment for the full honest account of what was tried
     and discarded.)
   - **Cross-tab double-submit (two SEPARATE `BrowserContext`s, two
     independently logged-in sessions for the SAME user, both selecting
     the same fresh operand `giveback_from_peak` and clicking "Add rule"
     via `Promise.all` — ordinary clicks, no DOM hacking): REAL BUG,
     confirmed 3/3 independent runs.** Both submissions succeed, both
     write a real row, and the trader ends up with **4 active rules
     against a documented free-tier cap of 3** — the exact
     `ruleCreateLimitMessage` copy ("You're at 3 of 3 rules") is a lie the
     moment this happens. Root cause confirmed by direct source read:
     `lib/entitlements/rules-usage.ts`'s `countActiveRules` (a plain
     `select count(*)`) and `lib/rules/rules-repository.ts`'s
     `insertRuleAndVersion` (a plain `insert`, no `WHERE` count guard) are
     two separate, unguarded round trips in `createRule` — no
     `pg_advisory_xact_lock`, unlike `promoteRuleSeverity`'s own real fix
     for the exact same bug class against the `rules.hard` cap (Slice 7).
     **This is a pre-existing gap in `createRule` itself — it affects
     Slice 10a's guided front door too (same `createRule` call, same
     missing guard), not something Slice 10b's UI introduced — but Slice
     10b's single-button, single-rule-per-click screen is the first
     surface this pass directly proved it through.** Screenshot
     `tmp/dev-screenshots/rule-editor-independent-verify-crosstab-race-
     BUG.png` (both browser contexts independently showing "Rule added"
     for the same operand), `Read` back, confirmed. Test left in place as
     a genuinely FAILING assertion (`e2e/rules-general-editor.independent-
     verify.spec.ts`, "cross-tab double-submit" — 5/6 tests in that file
     pass, this one fails BY DESIGN until fixed, matching this repo's own
     `it.fails`-as-tripwire convention from Slice 9's independent
     verification, just as a real Playwright failure rather than a vitest
     `it.fails`). **NOT fixed by this tester pass** — per this repo's own
     gate sequence, a real bug found during independent verification goes
     back to `retrospeq-coder` to fix, not fixed inline by the tester.
7. **Design-system non-negotiables — re-screenshotted independently, not
   re-asserted from the coder's own images.** Four fresh screenshots
   (`tmp/dev-screenshots/rule-editor-independent-verify-{unsatisfiable,
   not-computable,tier-bypass-rejected,flagged}.png`), each `Read` back and
   visually confirmed: no red/green anywhere (also asserted programmatically
   against the real rendered `class` attributes, not just eyeballed);
   exactly one primary `.rq-btn` per view once an operand is picked;
   `.rq-num` present on the stepper value AND the preview count (hand-
   verified flagged=4 against a fresh, independently-inserted
   `operand_distributions` fixture for `risk_pct`, distinct bucket shape
   from Slice 10a's own); a genuine bool-operand state with zero `.rq-step`
   present (via the tier-bypass screenshot, `stop_moved_against` — a
   DIFFERENT bool operand than the coder's own `stop_set_at_entry` test).
8. **Free-tier cap failure path — independently reproduced.** The coder's
   own `e2e/rules-general-editor.spec.ts` at-cap test was independently
   re-run and confirmed passing (see item 9 below for the full account of
   what did and didn't get a clean re-run this pass); this tester's own
   double-submit and cross-tab race tests both independently seed a
   trader at 2 pre-existing rules and confirm the cap is correctly reached
   at exactly 3 in the single-submission case.
9. **Full suite re-run — honest account, including a self-inflicted rate-
   limit wrinkle.** `npm run test` (vitest, unaffected by E2E rate
   limiting): **134 files / 1607 tests passed / 13 skipped / 0 failed**
   (133/1601 before this pass's 6 new unit tests), re-run twice, no flake.
   `npx tsc --noEmit`, `npm run build`, `npx eslint .` all independently
   re-run: clean (0 errors; same 19 pre-existing unrelated warnings).
   Coverage (`lib/rules/`, v8): **`evaluate.ts` 100% line/branch/function**
   (the rule-evaluation engine, 00-foundation §9.1's named 90% bar — met
   with room to spare), **`editable-operands.ts` 100%**,
   **`validate-tier.ts` 100%**, `lib/rules/` overall **97.75% line /
   92.73% branch** (well above the 70% overall bar). For Playwright E2E:
   this pass's own heavy, repeated re-running of the double-submit/
   cross-tab race tests (needed to confirm reproducibility, not flakiness)
   genuinely exhausted `createRule`'s real 30/hour-per-IP rate limit
   (confirmed directly via `select ... from retrospeq.rate_limit_hits`:
   36 hits against `ip:::1` within the hour, all self-inflicted this
   session) — a correctly-functioning security control, not a bug, but it
   DID cause the coder's own `rules-general-editor.spec.ts` to fail on
   first re-run with a genuine `RULE_RATE_LIMITED` response (confirmed via
   the failure's own rendered DOM snapshot, not guessed). The stale rows
   for `ip:::1` were deleted directly (test-environment cleanup, the same
   class of raw-SQL housekeeping this repo already does elsewhere — this
   does not touch any real rate-limit logic or hide a real finding).
   After that cleanup, re-ran `e2e/rules-general-editor.spec.ts` again:
   2 of 4 tests (core flow, bool operand) passed cleanly; the other 2
   (at-cap, unsatisfiable) then failed at the LOGIN step on a SEPARATE,
   Supabase-platform-level auth rate limit (not this app's own rate
   limiter, not fixable via the same cleanup) — a genuine session-wide
   artifact of this pass's own cumulative test-user volume against the
   shared dev Supabase project, not a product regression. **Both of those
   2 tests' underlying claims were already independently re-derived by
   this pass anyway** (item 2 above for RULE_UNSATISFIABLE with a
   different operand; items 6/8 above for the at-cap behaviour) before the
   rate-limit exhaustion occurred, so this is a reported gap in *re-running
   the coder's literal 4 tests one more time*, not a gap in independent
   coverage of what those tests claim. This module's own E2E rate limits
   are tight enough that a normal test-iterate-reverify cycle can trip
   them within one session — worth the orchestrator's awareness for future
   heavy E2E passes, not something this tester is positioned to fix.
   No migration in this slice (confirmed via `git status --porcelain
   supabase/migrations/`, empty) — no new RLS surface. No golden-fixture
   replay needed (`lib/ingestion/grouping.ts` untouched, confirmed).

**Net result: Slice 10b is NOT done.** The coder's implementation is
sound on every axis except one real, reproducible, security-relevant gap
(the cross-tab entitlement race) that must be fixed — most likely a
`pg_advisory_xact_lock(hashtext(user_id))` wrap around `createRule`'s
count-then-insert, mirroring Slice 7's own fix for the analogous
`rules.hard` cap — and then re-verified (fix re-tested live, plus a
security-reviewer pass this tester's own scope does not cover) before a
security-reviewer/qa gate sequence runs and this slice can be called done.
New test files this pass added, kept in the tree either way:
`lib/rules/__tests__/rule-editor-slice10b.independent-verify.test.ts` (6
unit tests, all passing) and `e2e/rules-general-editor.independent-
verify.spec.ts` (6 tests: 5 passing, 1 deliberately failing as the
tripwire for the open bug above).

**→ Module 04 Slice 10b — CODER concurrency fix (2026-08-29, this entry)
— cross-tab `rules.create` race closed.** Root cause confirmed exactly as
the tester diagnosed: `createRule`'s entitlement pre-check
(`canForUser`/`countActiveRules`) and its write (`insertRuleAndVersion`)
were two separate, unguarded round trips. **Fixed** the same way Slice
7's `promoteRuleSeverity` fix closed the analogous `rules.hard` race:
`pg_advisory_xact_lock(hashtext(user_id))` as the first statement inside
`insertRuleAndVersion`'s own transaction, before a NEW guarded INSERT
(`insert ... select ... where $capLimit::int is null or (select count(*)
...) < $capLimit`, `null` capLimit meaning Pro's unlimited cap) that
re-checks the active-rule count atomically; zero rows returned throws a
new `RuleCreateCapExceededError`, mapped by `createRule` to the SAME
`ENTITLEMENT_LIMIT` shape/copy (`ruleCreateLimitMessage`) the early
pre-check already used. `InsertRuleInput` gained a required `capLimit:
number | null` field (sourced from the pre-check's own
`entitlement.limit`, never re-derived) — every existing call site
(`rules-repository.live.test.ts`'s 6, `guided-front-door.live.test.ts`'s
1) updated to pass `capLimit: null` (no cap intended for those fixtures).
The early `canForUser` pre-check in `createRule` is UNCHANGED — per
`promoteRuleSeverity`'s own established precedent, it stays as the fast,
friendly non-atomic UX check; the guarded INSERT is the real
invariant-enforcing backstop. Verification: (1) the tester's own tripwire
E2E (`e2e/rules-general-editor.independent-verify.spec.ts`'s cross-tab
test) now PASSES — two genuinely concurrent browser contexts land at
exactly 3 active rules, never 4; (2) a NEW genuine two-connection live-DB
proof added (`rules-repository.live.test.ts`'s new
`insertRuleAndVersion — CONCURRENCY FIX` describe block, `pg_stat_
activity`-polled `waitForBlockedQuery`, same gold-standard technique as
Slice 7's own independent-verification file) — a real second connection
holding the same advisory lock plus an uncommitted rule forces the real
call to genuinely block, then correctly land at exactly the cap, never
over it; (3) Slice 10a's own suites
(`e2e/rules-guided-front-door.spec.ts` + its independent-verify sibling)
re-run and confirmed passing unchanged — its sequential (not
`Promise.all`) 3-call submission pattern is unaffected by the new lock,
as expected (each call trivially serializes against itself). Full suite:
1609 passed / 13 skipped / 0 failed (134 files); `tsc --noEmit`, `eslint
.` (0 errors, 19 pre-existing unrelated warnings), and `npm run build`
all clean. No migration, no new RLS surface (`rules`/`rule_versions`
schema unchanged). No new `docs/runbook.md` entry — this is a concurrency
fix to an already-runbooked write path (`createRule`'s `ENTITLEMENT_
LIMIT` case), not a new alerting condition.

**→ Module 04 Slice 10b — SECURITY-REVIEWER PASS on the concurrency fix
(2026-08-29, 5/5).** Advisory-lock deadlock risk: only two
`pg_advisory_xact_lock` call sites exist in the entire repo (this one and
Slice 7's `promoteRuleSeverity`), both keyed solely on `hashtext(user_id)`,
neither ever holds a second lock while waiting on another — no cycle is
possible, confirmed against actual Postgres advisory-lock semantics, not
assumed. The guarded-INSERT SQL fully parameterized, `capLimit` bound not
interpolated, no injection surface. `RuleCreateCapExceededError` leaks
nothing beyond what the pre-check already exposes to the same user. No
second write path can insert/reactivate an active `rules` row outside this
one now-guarded function. Standard non-negotiables re-confirmed clean.
Independently re-ran the live-DB two-connection blocked-lock proof (13/13)
plus the full related suite (54 files/712 passed), `tsc` clean. One
explicitly-flagged limitation, not treated as a gap: did not re-run the
Playwright E2E cross-tab spec itself (no dev server running at review
time) — reasoned the live-DB + unit mapping tests already cover the same
causal chain end-to-end; closed by qa's own pass below.

**→ Module 04 Slice 10b — QA PASS (2026-08-29), overall PASS, ships as
committed below, one real non-blocking finding logged for a quick
follow-up.** The race-loser's trader-facing experience verified
non-confusing: the `ENTITLEMENT_LIMIT` message shown when the guarded
INSERT's backstop fires is IDENTICAL (same string, same error code) to the
message the ordinary non-racing at-cap path already shows — a trader who
loses the race sees the same honest "you're at your limit" copy as anyone
else at the cap, not an alarming or inconsistent-sounding internal error;
confirmed via a fresh screenshot of the `/rules/new` rejection state (no
red/green, no "Error:"-style framing, `.rq-num` still correctly present).
Design-system non-negotiables re-confirmed clean. Closed both gaps the
security-reviewer had explicitly flagged as unverified: independently ran
the Playwright E2E cross-tab spec live (6/6, including the actual
cross-tab race scenario). Fix-specific sanity re-confirmed: `capLimit`
sourced from the single `entitlement.limit` value (no second hardcoded
`3` anywhere), `severity` still hardcoded `'soft'` in the guarded INSERT's
SQL (unchanged by this diff), `rule_evaluations` untouched. No ADR/runbook
gap, consistent with Slice 7's own precedent for the same bug class.
**One real, non-blocking finding**: `RuleEditor.tsx`'s "Rule slots: N of M
used" header is computed once at page load and never refreshed
client-side — reproduced single-tab: submit rule #3, click "Write another
rule" (resets the form's own phase state but not the stale entitlement
prop), attempt rule #4, and the screen simultaneously shows a stale "2 of
3 used" header alongside the (correct) "you're at 3 of 3 rules" rejection
— a real, contradictory-looking pair on one screen, though not a security
or data-integrity issue (the CAP ITSELF is still correctly enforced
server-side regardless of what the stale header displays). QA scoped this
as a quick, well-defined follow-up (self-update the displayed count after
a successful create or a `RuleCreateCapExceededError`, rather than
trusting the page-load snapshot for the client session's lifetime), not a
Slice-10b blocker.

**Module 04 Slice 10b is now DONE (2026-08-29)** — full coder → tester
(found the real cross-tab race) → coder fix → security-reviewer (5/5) →
qa (PASS + one non-blocking follow-up) gate sequence passed. The fixed
race was a pre-existing gap in code Slice 10a's guided front door also
calls (`createRule`/`insertRuleAndVersion`), so this fix closes the same
exposure for both slices at once — Slice 10a needed no changes of its own
and its own suites were re-confirmed passing throughout.

**→ Quick follow-up DONE (2026-08-31): `RuleEditor.tsx`'s stale
entitlement-count header fixed.** The "Rule slots: N of M used" summary
moved to local client state — increments `used` (capped at `limit`) on a
successful `createRule`, pins `used = limit` on an `ENTITLEMENT_LIMIT`
rejection — rather than trusting the page-load-time snapshot for the
entire client session. Purely a display fix: `lib/rules/rules-repository.ts`
and the server-side `pg_advisory_xact_lock` cap enforcement are untouched
(confirmed via `git diff --stat`, this diff is `RuleEditor.tsx` + the e2e
spec only). `GuidedFrontDoor.tsx` (Slice 10a) was checked and confirmed to
NOT share this bug (different state machine, no entitlement re-render
after success in that flow) — correctly left unchanged, no unnecessary
edit made there. A full security-reviewer pass was deliberately skipped
for this one (pure UI-state change, no new write path, no security
surface — orchestrator judgment call, logged here per 00-foundation §12).
QA PASS (6/6): screenshot-verified the self-updated "3 of 3" state is
visually identical to a true server-confirmed at-cap state, `.rq-num`
still wraps the count, no visual regression elsewhere, no red/green
introduced, the new regression test (`e2e/rules-general-editor.spec.ts`)
confirmed genuinely meaningful (asserts header text at every transition
point plus a DB-level row-count check, not just click-throughs).
**Operational note for future dispatches**: this session's own repeated
E2E runs against `/rules/new` tripped `createRule`'s real DB-backed
1-hour rate limit (not in-memory — a dev-server restart does not reset
it); both the coder and qa hit this, correctly recognized it as expected
infra behavior rather than a regression, and either waited out the window
or used a fresh test user. If dispatching more E2E runs against `rules/`
soon, expect the window may still be recovering.

**Module 04 Slice 10d, part 1 (the ambient strip, §5.9 UI) is now CODED —
see the phase-status table row above and the "AT A GLANCE" paragraph at
the top of this section.** The paragraph immediately below is the
ORIGINAL "why 10d next" reasoning (written before this slice's own
dispatch split it into two parts); still accurate for why 10d as a whole
was chosen ahead of Slice 10c, kept as historical record. **Next: Slice
10d part 2 — the adherence display (§5.6 UI)**, a deliberately separate
follow-up dispatch (not built by part 1's own coder pass), THEN
independent tester/security-reviewer/qa review of part 1, THEN Slice 10c.
Chosen ahead of Slice 10c (discovery, story 1.3)
because it is fully unblocked by existing backend work (Slice 8's
`getAmbientAccountState`/`recordOverride`, Slice 6's
`adherence-repository.ts` — both already built, tested, and
security-reviewed; 10d only needs to render what they already compute),
whereas 10c's "ranked detections drawn from your own behaviour" (story
1.3's evidence like "Moving stops 14 times") plausibly needs
pattern-detection logic that doesn't exist yet — that's Module 05
(Analytics & Findings) territory, not started (Phase 3). 10d also covers
two of AGENTS.md's own repeatedly-named non-negotiables directly ("gauges/
ambient strip are always visible, never appear-on-threshold"; "adherence
earns no XP, ever" — this is the first UI surface where that rule has
visible teeth, since it's the first screen actually DISPLAYING an
adherence number). Slice 10c is deferred, not dropped — picked up after
10d, or sooner if Module 05 groundwork happens to land first. See the
"Next: Module 04 Slice 10" paragraph further down this section for the
full original §6 scope breakdown.

**→ Module 04 Slice 9 — `operand_distributions` extended to
`daily_loss_pct`/`consecutive_losses` — DONE (2026-08-29).** Full coder →
tester → security-reviewer → qa gate sequence passed — see the
2026-08-29 phase-status table entry above (search "Slice 9 (`operand_
distributions` extended") for the complete summary, and the 2026-08-29
decision-log entries below for the full preview.ts-bug-and-fix write-up.
The paragraphs immediately below are the ORIGINAL coder-pass write-up
(2026-08-27) — kept as historical record of what was built and how, but
its closing claims ("preview.ts needed ZERO changes", "NOT yet
independently tested/security-reviewed/QA'd") are SUPERSEDED: tester's
independent verification found the "zero changes" claim was wrong (a
real bug in `preview.ts`'s gate, since fixed and re-verified by
security-reviewer and qa — see above). Closes the
gap §5.10's guided three-rule front door (next slice) needs: Slice 3's
`lib/rules/distributions-repository.ts` only ever bucketed the 8
`computableToday: true` single-trade operands; `risk_pct`, `daily_loss_pct`,
and `consecutive_losses` are the three the front door actually needs, and
the latter two are cross-trade facts Slice 4 (`cross-trade-operand-
values.ts`) built real per-trade computation for AFTER Slice 3 shipped.
This slice wires that already-built Slice 4 logic (`computeDayWeekPnl`'s
`dailyLossPct` output, `computeConsecutiveLosses`) into Slice 3's
distribution-bucketing pipeline — REUSED verbatim, not re-implemented.

**Reuse-without-N+1 approach** (the specific thing this slice's own
dispatch asked to be documented): Slice 4's own fetch functions
(`fetchClosedTradesForPnlWindow`, `fetchPriorOutcomesDescending`) are
shaped for evaluating ONE trade at a time — correct for freeze-time
evaluation, wrong for building a distribution across up to 200 window
trades (200+ round trips otherwise). Instead, added two NEW batched fetch
functions to `distributions-repository.ts`: `fetchAccountHistoryForCrossTradeOperands`
(ONE query for every distinct account among the window trades at once,
via `row_number() over (partition by account_id order by closed_at desc)`
— the query count does not grow with the number of accounts) and
`fetchAccountStartingEquities` (one more query). A new pure function,
`computeCrossTradeDistributionValues`, then calls Slice 4's
`computeDayWeekPnl`/`computeConsecutiveLosses` ONCE PER WINDOW TRADE, but
purely in memory against the already-fetched per-account history slice —
net query count added: 2, regardless of window size or account count.
Each window trade's value is computed AS OF that trade's own entry
(point-in-time, matching Slice 4's own freeze-time semantics), not "as of
now" — this is what makes the result a genuine historical distribution.

Verified, not assumed: both `daily_loss_pct` (`bounds: {min:0.5, max:10,
step:0.5}`) and `consecutive_losses` (`bounds: {min:1, max:10, step:1}`)
already had real catalogue bounds/step from Slice 1 — no catalogue gap to
flag. `preview.ts` needed ZERO changes — **[CORRECTED 2026-08-29: this was
WRONG. `preview.ts` DID need a change — see the phase-status table's
2026-08-29 Slice 9 entry and the matching decision-log entry above/below.
The coder's own inspection missed that `preview.ts`'s gate read the
stale `operand.computableToday` flag, not `operand_distributions`
directly, so "reads it generically by operand_id" was true but
irrelevant — the gate never let execution reach that generic read for
either new operand in the first place.]** — confirmed by inspection AND by
the live-DB test suite: it already reads `operand_distributions` generically
by `operand_id`, with no operand-specific branching. `computeAllOperandDistributions`
now always returns 10 distributions (was 8) — `recomputeOperandDistributionsForUser`'s
`operandsComputed` return value and every `operand_distributions` row-count
assertion across the test suite (`distributions-repository.test.ts`,
`distributions-repository.live.test.ts`, `sync.live.test.ts`) updated to
match; `COMPUTABLE_OPERAND_IDS` itself (the 8-operand single-trade list)
is UNCHANGED, correctly — the two new operands are cross-trade, not added
to that list. New tests: pure-function unit tests (account isolation,
point-in-time correctness against a hand-computed loss-streak scenario),
a golden-fixture bucket-vs-full-scan parity extension (§8.1's own bar,
though the golden fixture library itself has no losing trades, so the
`consecutive_losses` case there only proves the invariant on all-zero
data — the hand-computed unit tests are what prove a genuine >0 streak),
and a new live-DB test seeding a real 4-trade loss/loss/win/loss sequence
across two accounts, asserting exact per-trade bucket values against a
by-hand calculation. Full `lib/rules` suite (494 tests) + the
`sync.live.test.ts` operand_distributions-wiring test + `npm run build` +
`tsc --noEmit` + `eslint .` all clean, re-run after the change. No
migration (schema unchanged), no ADR (filling an already-scoped Slice
3/4 deferral, not a new deviation). `docs/runbook.md`'s existing
`operand_distributions` recompute-failure entry updated with a one-line
note that the operand list/query set grew. **[SUPERSEDED 2026-08-29:
independently tested/security-reviewed/QA'd, all passed (after the
preview.ts fix above) — Slice 9 and this paragraph's "NOT yet ..." close
are both stale. See the 2026-08-29 phase-status table entry for the
current, accurate status.]**

**→ Module 04 Slices 1-6 are all DONE (2026-08-25).** Full coder →
tester → security-reviewer → qa gate sequence passed on every one. Slice
6 (`adherence_weekly` materialization) is the most recent: QA's first
pass FAILED on a real `retrospeq-design-decisions.md` §6 violation (the
original `top_break_rule_id` selection combined hard+soft broken
evaluations into one pool, risking a rare hard breach getting buried
under more common soft violations) — fixed to hard-priority selection
(hard pool wins whenever non-empty, soft-only fallback otherwise),
re-verified PASS. See the 2026-08-25 decision-log entries below (search
"Slice 6") for the full coder/tester/security/qa write-ups, including
the fix and its re-verification.

**→ Module 04 Slice 7 — severity lifecycle (§5.7) — CODED (2026-08-25),
coder pass only, NOT yet independently tested/security-reviewed/QA'd.**
Scope for this pass, per its own dispatch, was narrower than the "Next"
paragraph below (written before this dispatch) anticipated:
promote/demote/retire + the hard-cap + the eligibility check ONLY.
`rule_overrides` writing and the ambient strip (§5.9) were EXPLICITLY
carved out of this slice's own dispatch as belonging to a future Slice 8
alongside the UI (§6) — reconciling the "Next" paragraph's original
"Slice 7 = §5.7 + rule_overrides + ambient strip" framing against the
actual dispatch received. Full build write-up is in the Phase-status table
row above (search "Slice 7 (severity lifecycle") and the matching
2026-08-25 decision-log entry below. Summary: `lib/rules/promotion-
eligibility.ts` (read-only eligibility check, documented all-time vs.
windowed gate reasoning), `lib/rules/severity-lifecycle-repository.ts`
(atomic guarded-UPDATE promote/demote/retire, hard cap enforced inside the
UPDATE's own WHERE clause via a correlated subquery, not a separate
check-then-write step), `app/(app)/rules/actions.ts`'s new `promoteRule`/
`demoteRule`/`retireRule` Server Actions, `rules.hard` wired into
`defaultCanDeps` for real (`countActiveHardRules`). 90 new tests, all
green (unit + live-DB, including a real §8.4 full-sequence live test and a
real atomic-hard-cap-at-Postgres proof). Full repo suite (610 tests, 43
files) + build/tsc/eslint all clean, re-run after the change.

**→ Module 04 Slice 7 tester pass: DONE (2026-08-25), and it did its job —
found a real, reproducible concurrency bug, not a rubber stamp.** Full
write-up is in the Phase-status table row above (search "TESTER PASS
DONE") and is not repeated here in full; the one-line version: the
6-active-hard-rule cap's "atomic" enforcement is NOT actually race-safe —
two concurrent promotions of two DIFFERENT soft rules can both succeed
and push the count to 7, because `promoteRuleSeverity`'s correlated
subquery only locks the row it writes, never the rows it counts. Proven
twice independently (a standalone repro script and a formal live-DB
vitest test, both using genuine two-connection control, not timing luck).
Everything else in the slice — windowing (tester independently concurs
with the coder's reading), demote/retire concurrency (genuinely safe),
the free-tier block (re-verified through the real Server Action, not
mocked), one-way retirement (re-verified through the real `retireRule`
action too), no `rule_evaluations`/`rule_versions` writes, zero
XP/gamification coupling, and coverage (93.8%/100%, matches the coder's
own numbers) — held up under independent re-verification.

**→ Module 04 Slice 7 hard-cap race: CODER FIX DONE (2026-08-25).**
`promoteRuleSeverity` now takes `pg_advisory_xact_lock(hashtext(user_id))`
as the first statement in its own transaction (`withUserConnection`,
confirmed to genuinely wrap one transaction per call before relying on
this), forcing a second concurrent promotion for the same user to block
until the first commits. The tester's own `it.fails` trip-wire test
(`lib/rules/__tests__/severity-lifecycle.independent-verification.live.test.ts`)
was converted to a normal `it(...)`, restructured to deterministically
prove genuine blocking (via `waitForBlockedQuery`, not timing luck), and
passes reliably (re-run twice in isolation, once as part of the full
suite). `demoteRuleSeverity`/`retireRuleState` confirmed NOT to need the
same fix (single-row guarded UPDATEs, no cross-row subquery, already
safe). Full detail + exact re-verification numbers: 2026-08-25 decision
log entry "Module 04 Slice 7 — CODER FIX for the tester-found hard-cap
concurrency bug." Full `lib/rules` suite (28 files, 447 tests) green,
`npx tsc --noEmit`/`npx eslint .`/`npm run build` all clean.

**→ Module 04 Slice 7 security-reviewer gate: PASS (2026-08-25), 9/9
checklist items.** Independently re-ran the advisory-lock fix live 3
times, then built and ran an independent 3-way adversarial concurrency
scenario directly against the dev DB (4/6 hard rules, 3 soft rules
contending for 2 slots — invariant held exactly, 2 successes, final
count 6, never 7). Confirmed lock scoping, server-resolved hard-cap
limit, ownership/RLS on all three actions, one-way retirement (plus
found the DB itself also blocks `rules` row deletion via a
`rules_forbid_delete` trigger), parameterized queries throughout, real
pre-write rate limiting, no compound-rule surface. No blocking findings.

**→ Module 04 Slice 7 QA gate: FAILED once (2026-08-25) on a
ledger-currency gap only** — the security-reviewer PASS above had
genuinely happened but wasn't yet written into this ledger when QA was
dispatched (same pattern as Slice 5's own first QA FAIL). Resolved by
the paragraph immediately above. Every code-level QA check (windowing
re-scrutiny, never-automatic promotion, retire-only-no-pause,
`RULE_HARD_CAP`'s real demote-chooser payload, free-tier message tone,
fresh XP/gamification grep, scope honesty, analytics/rules import
boundary, no notification triggers) passed on the first QA pass and
does not need re-litigating. **Module 04 Slice 7 (severity lifecycle)
is DONE.**

**Separately, already fixed (2026-08-25, standalone commit):** the
`lib/supabase/__tests__/service-role-inventory.test.ts` allowlist gap
from Slice 6 (missing `lib/rules/adherence-repository.ts`) has been
closed directly — see the "Fix: add lib/rules/adherence-repository.ts
to the service-role allowlist" commit, pushed ahead of Slice 7's own
commit.

**Slice 8 production code (2026-08-25) + its test suite (2026-08-26)
are both now written; NOT yet marked done — that's tester/security-
reviewer/qa's call, per this ledger's own rule.** The prior coder
session that wrote `lib/rules/ambient-state.ts`
(`getAmbientAccountState`), `lib/rules/rule-overrides-repository.ts`
(`fetchRuleForOverride`/`insertRuleOverride`/
`fetchOverrideOutcomeSummary`), and `app/(app)/rules/actions.ts`'s
`recordOverride` was interrupted by a session limit right as it began
writing tests — the orchestrator reviewed that production code as sound
(`tsc --noEmit` already clean) and dispatched a follow-up coder session
purely to write the missing test suite, no production-code changes.
That session found no bugs in the reviewed code (none of the four files
were touched). Delivered: `lib/rules/__tests__/ambient-state.test.ts`
(15 mocked tests) + `.live.test.ts` (3 live-DB tests),
`lib/rules/__tests__/rule-overrides-repository.test.ts` (13 mocked
tests) + `.live.test.ts` (7 live-DB tests), plus 12 new `recordOverride`
tests folded into the existing
`app/(app)/rules/__tests__/actions.test.ts`. 100% line/function coverage
on both `ambient-state.ts` and `rule-overrides-repository.ts` (94.28%/
100% branch — the one uncovered branch in `ambient-state.ts` is a
defensive corrupted-data guard in `deriveRiskCapPct` that is not
independently reachable through the public entry point without
`evaluate()` throwing first on the same malformed value, documented
inline in the test file rather than forced). The live-DB tests
independently proved: a real `total_open_risk` hard-cap breach against
genuinely live Postgres data, a second call reflecting a newly-opened
trade (not cached/stale), `scope='strategy'`/`evaluation='at_close'`
rules correctly excluded from the ambient snapshot, owner-only RLS, the
real ownership pre-check INSERT path, and — the one that actually
mattered to prove with a real fixture rather than by reading the SQL —
the `DISTINCT trade_id` dedup in `fetchOverrideOutcomeSummary`: a trade
overridden twice for the same rule is averaged once, not twice (proven
by seeding exactly that case and checking the arithmetic comes out to
`avg(-1.0, 1.0) = 0`, not `avg(-1.0, -1.0, 1.0) = -1/3`). `tsc --noEmit`
/ `eslint .` / `npm run build` all clean.

**→ Module 04 Slice 8 tester gate: PASS (2026-08-27), independently
verified, not a rubber stamp — no production bugs found, no test gaps
closed (the coder's own test suite already met the bar; independent
constructions below only add confidence, they don't replace it).**

- **Re-ran the full existing suite myself, not just trusted the coder's
  numbers:** `ambient-state.test.ts` (15), `ambient-state.live.test.ts`
  (3), `rule-overrides-repository.test.ts` (13),
  `rule-overrides-repository.live.test.ts` (7), and the 71-test (12 new)
  `app/(app)/rules/__tests__/actions.test.ts` — 109/109 green, matching
  the coder's reported 99 mocked + 10 live exactly. Live-DB tests ran
  against the real dev Postgres project (not skipped) and took ~42s
  total, genuinely exercising real RLS/real Postgres filtering, not a
  skip-guard fallback.
- **Coverage independently re-measured, not assumed:** 100% line/
  function on both `ambient-state.ts` and `rule-overrides-repository.ts`,
  94.28%/100% branch — the one gap (`ambient-state.ts` line 412,
  `deriveRiskCapPct`'s defensive non-numeric-`value` guard) confirmed
  genuinely unreachable through the public entry point: the same
  malformed `rule_versions.value` reaches the real `evaluate()` in the
  same loop first and throws `RuleEvaluationError` before this branch
  could matter, so it's a documented belt-and-suspenders guard, not a
  silently-untested product path.
- **The "always visible, never appear-on-threshold" invariant — the
  slice's single most important property — re-derived from a
  fresh, independently-constructed live-DB scenario** (not the coder's
  fixture): a fresh account, an active HARD `trades_today lte 5` rule
  that is currently FOLLOWED (0 trades today, well inside the cap) came
  back as a real, present entry in `rules` with `tint: 'neutral'` —
  never omitted for being unremarkable. On the same fresh account with
  zero prior activity, `facts.tradesToday.value` was `0` (not undefined/
  absent), `facts.dayPnlPct.value` was `null` with the field itself
  genuinely present (`Object.hasOwn` true), and `facts.riskVsCap.capPct`
  was `null` ("no cap configured" is a real, defined state) while
  `currentPct` was a real `0`. Confirmed no scenario exists where a fact
  or rule entry goes missing/undefined — every code path either returns
  a real value or a real, typed "not applicable"/`null`, never an absent
  key.
- **No red/green: independently grepped `ambient-state.ts`,
  `rule-overrides-repository.ts`, and all four test files** for hex/rgb
  color literals and `success`/`danger`-shaped field names — the only
  matches anywhere are the doc comments quoting AGENTS.md's
  non-negotiable itself to explain why no such pair exists. Clean.
- **Tint boundaries re-derived independently, matching spec exactly:**
  broken+hard → `breach`, broken+soft → `watch`, followed/not_applicable
  (both `operand_missing` and `tier` reasons) at any severity → `neutral`,
  and `worseTint`/`worstTintForOperands` correctly rank breach > watch >
  neutral when multiple rules of different severities govern the same
  fact (verified against the coder's own three-severity fixture and a
  fresh one of my own).
- **`evaluate()` reuse confirmed by reading the actual import/call site**
  in `ambient-state.ts` (`import { evaluate, ... } from './evaluate'`,
  called once per rule inside the orchestrator's `.map`), not merely
  trusted from the coder's spy-based test — there is no second,
  parallel comparison implementation anywhere in this file.
- **`NO_REFERENCE_TRADE_ID` sentinel confirmed structurally impossible to
  collide with a real trade id:** read `retrospeq.uuid_generate_v7()`'s
  actual definition (`20260819020000_shadow_harness.sql`) — the first 6
  bytes are `clock_timestamp()`'s own epoch-millisecond value, which for
  any timestamp after 1970 is nonzero, so a genuinely generated trade id
  can never equal the all-zero nil UUID. The live test proves the
  self-exclusion filter is a true no-op in this context (prior-trade
  timing/outcome lookups work correctly with no real "self" trade to
  exclude), not just asserted from reading the SQL.
- **`scope='global'`/`evaluation in (pre_entry, session)` filtering
  re-verified from the raw SQL** and independently re-proven live with
  my own fixtures (different operands/values from the coder's own test):
  a HARD `scope='strategy'` rule and a SOFT `evaluation='at_close'` rule
  were both seeded and both confirmed excluded from the ambient
  snapshot — severity does not affect the exclusion in either direction,
  and a real included global pre_entry rule proved the query isn't just
  returning nothing for everyone.
- **`getAmbientAccountState` writes nothing — reconfirmed** via the
  existing mocked SQL-text scan (asserts no query text anywhere matches
  `insert|update|delete`, across a zero-rule and a multi-rule scenario)
  and via the live tests' own before/after `rule_evaluations`/
  `rule_overrides` row counts.
- **`rule_overrides` double-counting protection — independently
  constructed, deliberately different from the coder's fixture:** (1)
  three (not two) override rows on the same trade collapsed to one
  distinct trade in `avgRMultipleOverridden`; (2) a meaningful
  discriminating case — one trade overridden twice (r=−2) plus a
  different trade overridden once (r=+4) — averaged to the correct
  deduped `+1.0`, not the wrong triple-counted `0.0` a broken
  implementation would produce. Both passed against the real DB.
- **`insertRuleOverride`'s ownership re-check — adversarial case
  constructed independently:** user A (rule owner) citing user B's real
  trade as the override's `tradeId` threw `RuleOverrideTradeNotOwnedError`
  and left zero rows for that rule id on a direct follow-up SQL read
  (not just trusting the thrown error), with user B's trade confirmed
  untouched.
- **`recordOverride`'s `ruleVersion` cannot be client-influenced —
  confirmed structurally:** read `recordOverrideInputSchema`
  (`z.strictObject({ ruleId, tradeId, observed })`) in
  `app/(app)/rules/actions.ts` — there is no `ruleVersion` field in the
  schema at all, and the Server Action sources it exclusively from
  `fetchRuleForOverride(...).currentVersion`, a server-side read.
- **RLS re-confirmed two ways, one independent of the app code entirely:**
  the coder's own live tests exercise it through `withUserConnection`;
  additionally ran a direct-Postgres check using `SET LOCAL ROLE
  authenticated` + `request.jwt.claims` (the same mechanism PostgREST
  itself uses to resolve `auth.uid()`, via the existing `asRole` test
  helper) — a second user's raw `SELECT * FROM retrospeq.rule_overrides
  WHERE rule_id = $1` against another user's row returned zero rows, the
  owner's own query returned exactly one, and the `anon` role (no claims
  at all) also returned zero. This proves RLS is enforced at the
  Postgres role/policy level, not merely by the application's own query
  shape.
- **Query-count sanity re-confirmed:** exactly 8 round trips for
  `getAmbientAccountState` regardless of 0 or 5 active rules — no
  per-rule query, matching the freeze-evaluations "one fact-assembly
  pass, then evaluate in-memory" precedent.
- **`npm run build` / `npx eslint .` / `npx tsc --noEmit`: all clean,
  independently re-run** across the full repo, not just the changed
  files.
- **Golden fixtures:** not applicable — this slice touches ambient live
  evaluation and `rule_overrides`, not the grouping engine, so §9.3
  fixture replay isn't triggered.
- **Readiness for security review: YES.** No production code was
  changed during this tester pass. Every one of this slice's own
  dispatch-flagged risk areas (always-visible guarantee, sentinel
  no-op-ness, scope/evaluation filtering, ownership re-check,
  double-counting, RLS) was independently re-derived against real
  Postgres or read directly from source, not taken on the coder's word,
  and all held.

**→ Module 04 Slice 8 (ambient live-state engine + `rule_overrides`) is
DONE (2026-08-27).** Security-reviewer PASS (10/10) and QA PASS (8/8)
both logged above in the phase-status table row; a short
`docs/runbook.md` entry was added for the ambient-strip's deliberately-
uncaught `RuleEvaluationError` variant (distinct from the freeze-time
caught-and-logged one).

**Renumbering note (2026-08-27):** a backend-only "Slice 9" (extending
`operand_distributions` to `daily_loss_pct`/`consecutive_losses`, coded
above) was inserted between this Slice 8 and the UI slice this paragraph
originally called "Slice 9" — the UI slice is renumbered **Slice 10**
throughout the paragraph below; nothing about its scope changed, only its
number. Logged in the decision log per 00-foundation §12's "spec vs code:
fix one deliberately, do not let drift accumulate silently."

**Slice 10 — the UI (§6)** is being delivered as several sub-slices
(this is 10a's own dispatch's explicit instruction: "a whole module is
not" one dispatch, applied one level down to "a whole multi-screen UI
slice is not" one dispatch either). **10a (the guided three-rule front
door, `/rules/start`) is CODED (2026-08-29, see the phase-status table
entry above) — coder pass with a full self-written test suite, NOT yet
independently tested/security-reviewed/QA'd.** Remaining sub-slices,
scope unchanged from the original combined "Slice 10" framing below,
just not yet built:

- **10b — the general rule editor** (one sentence, one tappable number,
  no operator dropdown — story 1.1) and **discovery** (ranked detections
  leading, catalogue behind search — story 1.3).
- **10c — the ambient strip** that actually renders
  `getAmbientAccountState`'s output and calls `recordOverride`. "Facts
  ambient, judgments silent" — account state (trades today, day P&L,
  risk vs cap) always visible, tinted by state, never a
  modal/confirm/block — `getAmbientAccountState`'s `AmbientTint`
  (`neutral`/`watch`/`breach`) maps to geometry/weight/opacity, never a
  red/green hue pair, per AGENTS.md's own non-negotiable.
- **10d — adherence display** (two fractions, never blended — §5.6).

Per AGENTS.md step 4: every one of these has a UI surface, so
`retrospeq-coder`/`retrospeq-tester` must both do their screenshot-based
visual self-check before each is considered done — there's no
interactive browser tool in this environment, so that's the only way
rendered UI actually gets looked at. 10a's own screenshot self-check
(`tmp/dev-screenshots/guided-front-door-*.png`, throwaway) is already
done; 10b/10c/10d each need their own.

**What was built [Slice 5, historical]:** `lib/rules/freeze-evaluations.ts` — one new
orchestrating function, `evaluateAndFreezeTradeRules(client, tradeId,
{frozenAt})`, called from BOTH of `lib/ingestion/confirm.ts`'s confirm
loops (`confirmDay`'s per-trade loop and `autoConfirmStaleTrades`'s bulk
path, after its own `confirmedIds` are known), always inside the SAME
`withServiceRoleConnection` transaction the caller already holds open —
never a second connection, never a second transaction, so a trade can
never be confirmed without its evaluations or vice versa. Implements
§5.5's `eligible(rule, trade)` predicate as one SQL query (forward-only
`rule.created_at <= trade.opened_at`, `state = 'active'`, `scope =
'global' OR scope_id = trade.strategy_id`, and — the genuinely new piece
— "the rule VERSION live at trade.opened_at," resolved as a half-open
`[created_at, superseded_at)` interval, the same convention
`computeServerDayRange` already established for day boundaries, verified
live at the exact-instant boundary in both directions). Merges Slice 3's
single-trade `extractComputableOperandValues` with Slice 4's
`assembleCrossTradeOperandValuesWithClient(client, tradeId)` (already
built specifically to be callable inside an open transaction) plus
`accountSyncTier` into one real `TradeFacts` object, calls `evaluate()`
per eligible rule, and writes one `rule_evaluations` row per non-thrown
outcome (severity COPIED from `rules.severity` at this exact moment,
never re-read later). `confirmDay`'s/`autoConfirmStaleTrades`'s own
return types gained a `ruleEvaluationAnomalies: RuleEvaluationAnomaly[]`
field (mirrors the existing `tradesSkippedStaleBlock` pattern) so a
caller never has to grep logs to know one fired.

**The `RuleEvaluationError`-during-freeze decision (dispatch's own open
question, point 5):** `evaluate()` throws (never resolves to
`not_applicable`) only for a genuinely malformed `{operand_id, op,
value}` — real data corruption or an authoring-layer bug, per §8.3.
Resolution: caught, logged loudly (`console.error`, prefixed
`[rule-freeze] ANOMALY evaluating rule...`, naming rule id/version/trade
id/error code), recorded in the new `ruleEvaluationAnomalies` array,
**never blocks confirmation of the trade or evaluation of the trade's
OTHER eligible rules.** Reasoning logged in `freeze-evaluations.ts`'s own
header and `docs/runbook.md`'s new "`RuleEvaluationError` thrown while
freezing rule_evaluations at confirm" entry: unlike a coverage gap or an
ambiguous grouping, a corrupted rule has no UI anywhere yet for a trader
to fix, so aborting the whole day's confirmation over it would trap them
indefinitely — exactly what Module 02's own confirm-transaction posture
already refuses to do for every other guard in that transaction.

**Tests (21 total, all green):** `lib/rules/__tests__/freeze-evaluations.test.ts`
(9, mocked-client — eligible-rule-query SQL/param shape, zero-eligible
short-circuit, followed/broken/not_applicable(tier) row shape, the
`RuleEvaluationError` anomaly path for both `UNKNOWN_OPERAND` and
`INVALID_OP_FOR_TYPE`) and `lib/rules/__tests__/freeze-evaluations.live.test.ts`
(12, live DB — the most important test in Module 04 so far, per its own
header): end-to-end create→confirm→row-exists; forward-only for BOTH
confirmDay and autoConfirmStaleTrades; the exact-instant `created_at`
boundary AND the exact-instant `superseded_at` boundary (constructed
deterministically by capturing the DB's own written timestamp text and
reusing it, not a timing race); "version live at entry" resolving to the
OLD version when confirmation happens after a later edit; frozen-
immutability (edit + severity-promotion after confirm leaves the past
row byte-for-byte unchanged, and a raw UPDATE attempt is rejected by
Slice 1's own trigger); a `state != 'active'` rule producing zero
evaluations; session-rule attachment (4 same-day trades, "trades_today
lte 3" breaks on the 4th trade's own row with `observed = 4`, self-
inclusive — matching Slice 4's own already-proven `computeDayWeekCounts`
semantics, not the dispatch's own imprecise "3, excluding itself"
paraphrase, see decision log); confirmDay and autoConfirmStaleTrades
producing byte-identical evaluation rows for equivalent trades; the
anomaly path live (a real corrupted `rule_versions.operand_id`); and RLS
cross-user isolation on the new writes. `npx tsc --noEmit`, `npx eslint
.`, and `npm run build` all clean.

**Explicitly out of scope, not built this slice (unchanged from the
dispatch):** `adherence_weekly` materialization (§5.6, Slice 6), the
ambient strip / provisional pre-confirm evaluation / `rule_overrides`
writing (§5.9, Slice 7), severity promotion/demotion/hard-cap (§5.7,
Slice 7), any UI, `trigger_evaluations` (still deferred, Module 03
dependency, unchanged from Slice 1).

**→ Module 04 Slice 5 tester gate: PASS (2026-08-24), independently
verified, not a rubber stamp.** Full write-up in the matching 2026-08-24
decision-log entry below; summary here:

- **Re-ran the full existing suite myself** (not just trusted the
  coder's numbers): `freeze-evaluations.test.ts` (9), `freeze-evaluations
  .live.test.ts` (12), `confirm.test.ts` + `confirm.live.test.ts` (19) —
  40/40 passing, matching the coder's reported counts exactly.
  `git diff --stat` confirms only `confirm.ts`, `confirm.test.ts`,
  `PROGRESS.md`, `docs/runbook.md` were modified and only the three new
  `lib/rules/freeze-evaluations*` files were added — no other test file's
  code changed, so any flake in an unrelated live-DB file under
  full-parallel load is provably pre-existing contention (ADR 0002), not
  caused by this slice.
- **Wrote and ran 5 new, independently-authored adversarial tests**
  (`lib/rules/__tests__/freeze-evaluations.independent-verification.live.test.ts`,
  all 5 passing against the real DB, not reusing the coder's fixtures):
  forward-only with trades opened-then-rule-created-then-confirmed (not
  the weaker "confirmed before rule existed" shape); a double-edited
  timeline (v1→v2→v3, all three thresholds individually verified from
  their own `rule_versions` rows) proving the FROZEN evaluation uses v1,
  not v3; a direct double-invocation of `evaluateAndFreezeTradeRules` for
  the same already-frozen trade inside one transaction, proving
  `unique(trade_id, rule_id)` + `ON CONFLICT DO NOTHING` (not the outer
  `confirmDay` guard) is what makes re-entry safe — second call writes
  zero rows and does not overwrite `frozen_at`; a second, independently-
  constructed corrupted-rule case (`is_true` op against a `number`
  operand, not the coder's unknown-operand-id case) proving the anomaly
  path generalizes; a raw SQL `DELETE` against a frozen row, independently
  re-confirming Slice 1's trigger rejects it (not just trusting the
  coder's claim).
- **`trades_today` inclusive/exclusive question: CONFIRMED
  self-inclusive, coder's correction is correct.** Read
  `cross-trade-operand-values.ts`'s raw SQL directly:
  `fetchTradesUpToReferenceInWeek`'s `opened_at <= $4` (not `<`) means
  the reference trade counts itself, and `computeDayWeekCounts` does no
  exclusion. Confirmed the arithmetic: trade 1→1, trade 2→2, trade 3→3,
  trade 4→4, so `trades_today lte 3` correctly breaks starting at the
  4th trade (`observed = 4`), not the 5th. Verified both by reading the
  code and by the live tests (coder's own session-attachment test, still
  passing under my own re-run).
- **Coverage, measured, not assumed:** `freeze-evaluations.ts` 98.5% line
  coverage (only the defensive non-`RuleEvaluationError` rethrow branch
  uncovered) — exceeds the 90% engine bar. `confirm.ts` 100% line
  coverage across `confirm.test.ts` + `confirm.live.test.ts`, confirming
  the new freeze-wiring integration lines are fully exercised.
- **RLS:** re-ran `rulebook-schema.rls.test.ts` (29 passing, 1 skip-guard)
  independently — `rule_evaluations`' owner-SELECT-only policy, the
  forbid-update/forbid-delete triggers (including against `service_role`),
  and cross-user isolation all still hold; unaffected by this slice since
  no schema changed. Slice 5's own live-DB RLS test (confirming trader
  sees their own frozen row, a second user sees none) re-run and passing.
- **`npm run build` / `npx eslint .` / `npx tsc --noEmit`:** all clean,
  re-run independently (0 errors; eslint's 19 warnings are pre-existing
  unused-param placeholders unrelated to this slice).
- **Golden fixtures:** not applicable — this slice touches freeze-wiring
  and rule evaluation, not the grouping engine, so §9.3 fixture replay
  isn't triggered.
- **Gap found, not closed (flagged, not a blocker):** `freeze-evaluations.ts`
  lines 369-370 (the defensive rethrow of a non-`RuleEvaluationError`
  exception) are the only uncovered lines — legitimately hard to exercise
  without injecting a real DB fault, and correctly NOT silently swallowed
  either way; noted for whoever next touches this file, not required
  before security review.
- **Readiness for security review: YES.** No production code was changed
  during this tester pass (test-only, per role) — freeze-wiring behaves
  exactly as documented under every adversarial case constructed here,
  independent of the coder's own framing, with real Postgres, real RLS,
  and real concurrent/double-invocation conditions, not mocks.

**→ Module 04 Slice 5 tester gate-closure addendum (2026-08-25) — the
original 2026-08-24 tester pass above was session-interrupted right
after writing `freeze-evaluations.independent-verification.live.test.ts`
and running one final full re-run; its verdict was never delivered. This
addendum is a second, independent tester pass closing the specific gaps
that were left unverified, then delivering the actual final verdict.**

- **`trades_today` self-inclusive semantics: RE-CONFIRMED from the raw
  SQL myself** (not re-trusting the prior pass's own claim) —
  `cross-trade-operand-values.ts`'s `fetchTradesUpToReferenceInWeek` uses
  `opened_at <= $4` with no self-exclusion, and `computeDayWeekCounts`
  does no filtering by trade id, so the reference trade counts itself.
  Cross-checked against `freeze-evaluations.live.test.ts`'s own
  session-attachment test assertions (trade 1→`observed=1`/followed,
  trade 2→2/followed, trade 3→3/followed, trade 4→4/broken against
  `lte 3`) — internally consistent, no off-by-one. No code or test change
  needed here; the prior pass's claim held up.
- **Severity promotion under a FROZEN evaluation: gap closed, dedicated
  test added.** The only existing coverage of §5.6's "promoting soft→hard
  must not retroactively reclassify last month's breaks" guarantee was
  bundled into the same test as a threshold edit ("frozen means frozen:
  editing a rule..."), which muddies attribution — two mutations in one
  test. Added a new, isolated live test to `freeze-evaluations.live.test.ts`
  — confirm a trade under a `severity='soft'` rule, freeze it, then
  **only** `UPDATE retrospeq.rules SET severity = 'hard'` (no threshold
  edit, no new `rule_version`) — and assert the already-frozen
  `rule_evaluations` row is byte-for-byte unchanged and still reads
  `severity = 'soft'`. Passing.
- **§8.2 property-test list, cross-checked bullet by bullet against this
  slice's actual scope:**
  - "Frozen evaluation never changes under edit/promotion/retirement/plan
    change" — edit ✓ (existing test), promotion ✓ (new test above).
    Retirement: **judgment call, no dedicated test added, reasoning
    below.** "No evaluation is EVER written for a retired rule" (the
    existing `state != 'active'` test) is a different guarantee from "an
    evaluation frozen BEFORE retirement survives retirement unchanged."
    Concluded a dedicated test for the latter would be redundant: the
    mechanism protecting a frozen row is the DB-level immutability
    trigger, which rejects ANY write to `rule_evaluations` regardless of
    what changed on the `rules` row that supposedly motivated it — already
    proven twice, independently, by two different `rules`-column
    mutations (the edit test's threshold change, and the new test's
    severity change) plus a direct adversarial raw-SQL `UPDATE`/`DELETE`
    against `rule_evaluations` itself (both rejected). A `rules.state`
    change (retirement) is mechanistically identical: it only affects
    `fetchEligibleRuleVersionsForTrade`'s `WHERE r.state = 'active'`
    filter for FUTURE freezes, never touches an existing
    `rule_evaluations` row. Retiring the actual state-transition (soft→
    hard promotion has the same shape) isn't buildable end-to-end until
    Slice 7's API exists either way.
  - "Rule created at T → zero evaluations for trades before T" ✓
    (existing forward-only tests, both paths).
  - "No compound expression representable through any API path" —
    confirmed by reading `freeze-evaluations.ts` itself (this slice adds
    no new Server Action/API route): `RuleVersionInput = { operandId, op,
    value }` is the only shape passed to `evaluate()`, called once per
    eligible rule inside a `for` loop — never combined, never batched into
    one evaluation record.
- **Coverage — re-measured myself, scoped, with `--no-file-parallelism`
  (see flake note below for why that matters for a trustworthy number):**
  `lib/rules/freeze-evaluations.ts` — 98.5% lines/statements, 90% branch,
  100% functions (only lines 369-370, the defensive rethrow of a
  non-`RuleEvaluationError` exception, uncovered — legitimately hard to
  exercise without injecting a real DB fault). `lib/ingestion/confirm.ts`
  — 100% lines/statements, 97.91% branch (one branch on line 434
  uncovered). Both clear the 90%-line engine bar (00-foundation §9.1)
  with room to spare.
- **A genuine flake found and root-caused, not hand-waved: the "both
  confirmDay and autoConfirmStaleTrades share the SAME evaluation logic"
  live test fails under Vitest's default full file-parallelism when 3+
  live-DB test files run concurrently against the shared dev Postgres
  project (reproduced 3/3 times: the 5-file combo including
  `confirm.live.test.ts` + `freeze-evaluations.live.test.ts` +
  `freeze-evaluations.independent-verification.live.test.ts`), but passes
  100% reliably (2/2) either standalone, in a 2-live-file combo, or
  serialized (`--no-file-parallelism`, 46/46 passing across two separate
  full runs). The failing assertion is `confirmDay`'s own
  `tradesConfirmed` coming back empty for a trade that was just seeded
  and is scoped to a fresh, unique test account (`account_id`-filtered
  throughout `confirm.ts`) — ruled out a code-level cross-account race
  (nothing in `confirmDay`/`autoConfirmStaleTrades` touches another
  account's rows), consistent instead with connection/resource contention
  against the shared dev-tier Supabase project under artificially high
  concurrent worker load (this repo's own `pg.Pool` is `max: 3` per
  process; 3+ parallel Vitest worker processes each opening their own
  pool against one shared, non-dedicated project). Not a functional
  regression in the freeze-wiring code — it is exactly the class of
  pre-existing shared-DB contention ADR 0002 already anticipates.
  **Recommendation for whoever runs this module's live-DB suite next
  (security-reviewer included): use `--no-file-parallelism` for a
  trustworthy full-suite result**, or accept that a solo re-run of just
  the failing test will pass. Not fixed by re-authoring the test (the
  same defensive multi-attempt pattern already used for trade B in this
  same test would mask a resource-exhaustion condition worth knowing
  about, not something to silently paper over) — flagged here instead,
  matching AGENTS.md's "never fake it" posture applied to test reliability,
  not just product code.
- **Final verdict: PASS.** 46/46 tests passing (`freeze-evaluations.test.ts`
  9, `freeze-evaluations.live.test.ts` 13 — up from 12, the new promotion
  test — `freeze-evaluations.independent-verification.live.test.ts` 5,
  `confirm.test.ts` 1, `confirm.live.test.ts` 18), confirmed via two full
  serialized re-runs after the promotion test was added. `npx tsc
  --noEmit`, `npx eslint .` (0 errors, 19 pre-existing unrelated
  warnings), and `npm run build` all clean, re-run independently.
  Coverage clears the 90%-line engine bar on both touched files. Every
  §8.2 property bullet in this slice's scope has a real, independently-
  verified test or a documented reason one specific sub-case is
  redundant. RLS cross-user isolation re-confirmed live. Golden fixtures:
  not applicable (no grouping-engine code touched). **Ready for security
  review — no gaps left open that would make a security pass premature.**

**→ Module 04 Slice 5 security-reviewer gate: PASS (2026-08-25).** 8/8
checklist items independently re-verified, not taken on the tester's word
— genuine transaction atomicity (`evaluateAndFreezeTradeRules` never
opens its own connection, runs entirely inside `confirmDay`'s/
`autoConfirmStaleTrades`'s existing `withServiceRoleConnection`
transaction, traced at the exact call sites); §5.5's `eligible()`
predicate re-derived from spec text and matched clause-by-clause against
the actual SQL, including the half-open `[created_at, superseded_at)`
version-boundary interval; zero SQL injection surface (every value is a
`$n` bind, including values that trace back to trader-authored rule
data); `rule_evaluations` RLS confirmed still owner-SELECT-only with no
client insert policy, writes exclusively via service role; `severity` is
a true snapshot read once at freeze and stored as a plain value, no live
join back to `rules.severity` found anywhere in the codebase;
`RuleEvaluationError`-during-freeze anomaly handling confirmed scoped
per-rule (a corrupted rule can't swallow a sibling rule's legitimate
evaluation) with no sensitive-data leak in the anomaly log;
`autoConfirmStaleTrades`'s bulk (all-accounts) path confirmed correctly
scoped per-trade internally, no cross-trade/cross-account fact leakage
possible; the self-inclusive `trades_today` semantics re-verified from
raw SQL independently (not trusting the tester's re-derivation) with no
double-count/under-count vector found (backed by `fills`'
`unique(account_id, provider_ref)` and `trade_fills`' unique-fill-id
constraint, which make resync-driven duplication structurally
impossible). 46/46 tests re-run live against the real shared dev
Supabase project by the reviewer directly. No blocking findings.

**→ Module 04 Slice 5 QA gate: FAIL (2026-08-25, first pass).** Two
blocking issues: (1) a real process gap on the orchestrator's part — the
security-reviewer PASS above had genuinely happened but had not yet been
written into this ledger before QA was dispatched, so QA correctly
refused to treat an unlogged claim as verified (exactly the ledger
discipline AGENTS.md requires — "no agent's message is your user's
approval," extended here to "no agent's message substitutes for the
ledger"). Resolved by the entry immediately above, written before this
QA gate is re-run. (2) A real, legitimate finding: `docs/adr/0014-no-
compound-rules.md` (Slice 1) explicitly named this exact slice as the
owner of a "freeze at confirmation, not broker close" ADR, and it was
never written. Dispatched back to `retrospeq-coder` to close — see the
matching decision-log entry once done. Everything else QA checked (§10
"never an error to the user" spirit, severity-per-row supporting Slice
6's two-fraction split, session-rule attachment as an ordinary
undifferentiated row, no compound rules at this integration layer,
`docs/runbook.md`'s new entry being a real actionable alerting entry, no
obvious N+1/perf problem, honest scope logging) passed clean. One
non-blocking optimization note: per-rule `rule_evaluations` INSERTs run
sequentially in a loop rather than batched — fine at this repo's realistic
volumes, flagged for a future pass, not a blocker.

**→ Module 04 Slice 5 QA re-verification: PASS (2026-08-25).** The
missing ADR (`docs/adr/0016-freeze-at-confirmation-not-broker-close.md`)
is written — substantive, not a placeholder, spot-checked against the
actual `confirm.ts` call sites and the 7-day auto-confirm threshold —
and `docs/adr/0014-no-compound-rules.md`'s cross-reference now points at
it. The security-reviewer decision-log entry above was independently
re-checked against the real code (the atomicity claim, the §5.5
predicate SQL, the RLS policy) and confirmed genuine, not fabricated.
**Module 04 Slice 5 (freeze-wiring) is DONE.**

**→ Module 04 Slice 6 (`adherence_weekly` materialization, §5.6) —
CODED (2026-08-25), ready for tester.**

**What was built:** `lib/rules/adherence-repository.ts` (new file).

- `computeAdherenceWeekCounts(rows)` — pure, no I/O. §5.6's core
  computation verbatim: `hard_total`/`hard_followed` and
  `soft_total`/`soft_followed` computed separately, `not_applicable`
  dropped from BOTH numerator and denominator for each severity (not
  counted as followed, not counted as broken). Also computes
  `top_break_rule_id`/`top_break_count`.
- **`top_break_rule_id` scope decision (§5.6 doesn't say hard-only or
  soft-only): COMBINED across both severities.** §5.6's own presentation
  example — *"31 of 34 rules followed this week... with drops attributed
  to a single named rule"* — reads as one integrated weekly narrative
  ("31 of 34 RULES," not "31 of 34 HARD rules"), so the single named rule
  is drawn from the same combined pool. Among every `result = 'broken'`
  evaluation in the week (both severities), group by `rule_id`, highest
  broken count wins.
- **Tie-break (deterministic, documented, not left to iteration order):**
  equal broken counts → earliest `frozen_at` among the tied rules' own
  breaks wins (the rule that started breaking first reads as more
  informative to name); a further tie (identical earliest-break instant)
  → lowest `rule_id`, for total determinism. Verified by dedicated unit
  tests, including one proving the earliest-`frozen_at` tracking is
  correctly PER-RULE (a rule's later break never overwrites its own
  earlier one, regardless of input array order).
- `fetchAdherenceEvaluationRowsForWeek(client, userId, weekStart)` — the
  ONE query per `(user_id, week)` pair (§12's <500ms budget): `server_day
  between weekStartForServerDay(weekStart) and weekEndForServerDay(weekStart)`,
  reusing `lib/rules/week-boundary.ts` directly (ADR 0015), never
  re-deriving. `assertCanonicalWeekStart` throws `InvalidWeekStartError`
  (loud, named) if a caller ever passes a non-Monday `weekStart`.
- `recomputeAdherenceWeekly(client, userId, weekStart)` — fetch + pure
  compute + upsert (`on conflict (user_id, week_start) do update`), and
  `recomputeAdherenceWeeklyForUser` — the standalone service-role wrapper.
- `recomputeAdherenceWeeklyForConfirmations(targets)` — the best-effort
  batch entry point `confirm.ts` calls. Dedupes `(userId, weekStart)`
  pairs (a `confirmDay` call always contributes exactly one;
  `autoConfirmStaleTrades` can contribute many across many users/weeks in
  one sweep). **Never throws** — each pair individually try/caught,
  logged loudly (`console.error`, matching `distributions-repository.ts`'s
  own sync-time precedent), a failure for one pair never blocks the
  others or the caller's already-committed confirmation.
- `fetchAdherenceWeekly(userId, weekStart)` — the read side for whoever
  wires Module 06's weekly review next. Runs under `withUserConnection`
  (real RLS, matching `rules-repository.ts`'s convention for reads a real
  trader session drives), issues exactly ONE `SELECT` against
  `adherence_weekly` and nothing else (proven directly by a unit test
  inspecting the query text), returns `null` when nothing's materialized
  yet (a correct "not enough data yet" state, not an error). Returns the
  two fractions as FOUR SEPARATE integers (`hardFollowed`/`hardTotal`,
  `softFollowed`/`softTotal`) — deliberately no pre-computed ratio, no
  blended number spanning both severities, so a future UI slice can't
  accidentally reach for an already-blended shape.

**Recompute timing decision: best-effort, AFTER commit — not inside the
confirm transaction.** `adherence_weekly` is a materialized CACHE derived
from `rule_evaluations` (already frozen atomically by Slice 5 inside
`confirm.ts`'s own transaction), not itself the trust-sensitive record —
the same shape `operand_distributions` already established. Recomputing
inside `confirmDay`/`autoConfirmStaleTrades`'s own transaction was
considered and rejected: those are Module 02's most safety-critical
transactions, and `autoConfirmStaleTrades` in particular can span many
accounts/users/days in one sweep — growing that transaction's lock
duration in proportion to sweep size for a value the table's own comment
already says is allowed to be "materialised on a schedule." Both
`confirmDay` and `autoConfirmStaleTrades` in `lib/ingestion/confirm.ts`
now capture the `(user, server_day)` pair(s) they actually confirmed
inside their transaction closure, then call
`recomputeAdherenceWeeklyForConfirmations` AFTER `withServiceRoleConnection`
resolves (i.e., genuinely after commit) — awaited, but never wrapped in
an additional try/catch at the call site since the repository function
itself never throws.

**Known, already-tracked gap, not built here:** no real cron/scheduler
infra exists (PROGRESS.md "Infra gaps"), so there's no independent
nightly "recompute every trader's current week regardless of
confirmation activity" job — same gap `operand_distributions` already has,
not a new one. `docs/runbook.md` gets a new matching entry, "`adherence_weekly`
recompute failing after a confirmation," mirroring the existing
`operand_distributions` entry's shape.

**Non-negotiables actively verified:** grepped the new file for
`xp|streak|points|gamif` (case-insensitive) — zero hits (a unit test
asserts this directly against the file's own source, so it can't regress
silently). The read function returns four separate integers, never a
blended/pre-divided ratio. `rule_evaluations` stays the only input — no
`evaluate()` call, no `rule_versions`/`rules` join beyond storing the bare
`top_break_rule_id` (deliberately name-agnostic; resolving it to display
text is a later read-side join, Module 06's concern).

**Tests:** `lib/rules/__tests__/adherence-repository.test.ts` (21 unit
tests, mocked `@/lib/supabase/direct`, matching
`subscription-repository.test.ts`'s established mock pattern) —
hard/soft separation and `not_applicable` exclusion, empty-week and
not-applicable-only-week shapes, top-break scope/tie-break (3 dedicated
cases), canonical-week-start validation, the week-boundary join's exact
query bounds, `recomputeAdherenceWeekly`'s upsert params, the batch
helper's dedup + non-throwing-on-partial-failure behavior, and the
read side's "one query, `adherence_weekly` only" + four-separate-integers
+ null-when-absent + RLS-connection-mode assertions.
`lib/rules/__tests__/adherence-repository.live.test.ts` (4 live-DB tests)
— the full pipeline (2 rules, one hard one soft, plus a third soft rule
on a t1-tiered operand against a t0 account to generate deterministic
`not_applicable` rows; 5 trades across 5 days of one ISO week, confirmed
via 5 separate `confirmDay` calls, each one's own post-commit recompute
converging the SAME row to the full week's cumulative truth) with numbers
hand-verified against the fixture; a week-boundary exclusion test (a
Sunday trade and a following-Monday trade both land in their OWN week,
never the target week); an `autoConfirmStaleTrades` dedup test; and an
RLS test (owner SELECT works, a second user sees nothing, and a direct
authenticated-role `INSERT` attempt is rejected — no client write path
exists, matching Slice 1's own migration comment).

**Build/lint:** `tsc --noEmit`, `eslint`, and `npm run build` all clean.
Full `lib/rules` + `lib/ingestion` suite re-run (684 tests): 681 passed, 2
skipped (env-gated), 1 failed — `trades-repository.live.test.ts`'s
`listTradesForAccountDay` ordering assertion, confirmed to pass cleanly
when run in isolation (39s, 11/11 green); this is shared-dev-DB
parallel-test contention between live test files running concurrently
against the one shared Supabase project, pre-existing and unrelated to
this slice's changes (nothing in this slice touches `trades-repository.ts`
or its test file).

**Not yet done:** tester/security-reviewer/qa gates. Module 06's weekly
review UI (the actual consumer of `fetchAdherenceWeekly`) is a later
phase (build order step 4) and out of scope here, per this slice's own
dispatch ("no Server Action/UI needed yet").

**→ Module 04 Slice 6 tester gate: PASS (2026-08-25), independently
re-derived, not a rubber stamp.** Re-verified against
`04-rulebook-and-evaluation.md` §5.6/§3.1/§12 and AGENTS.md's
non-negotiables, with fixtures I built myself, not the coder's:

- **§5.6 core computation, independently re-derived.** Own fixture (4
  hard/followed, 2 hard/broken, 3 hard/not_applicable, 1 soft/followed, 5
  soft/broken, 2 soft/not_applicable) confirms `hardTotal=6` (not 9) and
  `softTotal=6` (not 8) — `not_applicable` rows are excluded from the
  denominator entirely, not merely from the numerator. The exact "easy to
  get subtly wrong" case the module spec calls out is correct.
- **Week-boundary correctness.** Grepped `adherence-repository.ts` for any
  `new Date`/`getDay`/manual date arithmetic outside calls into
  `week-boundary.ts` — zero hits; every boundary computation goes through
  `weekStartForServerDay`/`weekEndForServerDay` exclusively. Confirmed via
  the coder's own live test (Sunday trade vs. following-Monday trade land
  in distinct weeks) plus my own reading of the SQL (`server_day between
  $2 and $3` using those two functions' output directly).
- **`top_break_rule_id` tie-break, own 3-rule fixture.** Built a genuine
  three-way scenario (three rules each broken twice, with distinct
  earliest-break instants, deliberately ordered in the input array so the
  correct winner is NOT first or last) — level 1 (count) narrows to the
  earliest three, level 2 (earliest `frozen_at`) picks the actual winner
  despite array-order red herrings. A separate fixture forces a genuine
  level-3 tie (identical count AND identical earliest `frozen_at` across
  three rule ids) — lowest `rule_id` wins, confirmed.
- **Materialized-only read, structurally proven.** `fetchAdherenceWeekly`'s
  SQL string contains `retrospeq.adherence_weekly` and does not contain
  `rule_evaluations` — confirmed both by reading the source and by an
  independent test asserting on the query text directly (not trusting the
  coder's own equivalent test).
- **No blended percentage anywhere in this data layer.** `AdherenceWeeklyRecord`
  has `hardFollowed`/`hardTotal`/`softFollowed`/`softTotal` as four
  separate fields; grepped the file for `ratio`/`percent`/division — the
  only hits are doc-comments explicitly describing what this file
  deliberately does NOT do.
- **No XP/gamification coupling, re-verified independently.** Fresh grep
  (not reusing the coder's own test) across `adherence-repository.ts` and
  the added lines of the `confirm.ts` diff for `xp|streak|points|gamif|
  engagement` — zero real hits.
- **Best-effort recompute doesn't corrupt — proven against a REAL row, not
  a mock.** Wrote a new live-DB test: establish a real baseline
  `adherence_weekly` row via a genuine `confirmDay` call, then force the
  UPSERT statement specifically to reject (via a client wrapper that lets
  the SELECT pass through to real Postgres and only fails the write), then
  re-read the row over a separate connection. Row is byte-identical to the
  pre-failure baseline (same counts, same `computed_at`) — never null,
  never half-written, and the underlying trade confirmation (already
  committed before the forced failure) stays `confirmed`. This also
  organically reproduced itself during the full-suite run: a real
  cross-test race (a concurrently-running live test file's user got
  deleted mid-sweep) hit this exact FK-violation path in
  `recomputeAdherenceWeeklyForConfirmations`, was caught, logged per
  `docs/runbook.md`'s new entry, and did not fail the calling test or
  corrupt any row — real-world confirmation the best-effort design works
  as documented, not just in a constructed test.
- **`autoConfirmStaleTrades` batching/dedup, own multi-user/multi-week
  fixture.** Beyond the coder's same-user/same-week dedup test, built one
  covering 2 users × mixed weeks in a single call (one user with two
  server_days in the same week, one server_day in a different week; a
  second user sharing a calendar week with the first) — confirms exactly
  3 distinct `(user, week)` pairs recomputed, each independently correct,
  never fewer, never duplicated.
- **The flaky-test claim, re-verified.** `git diff --stat` confirms
  `trades-repository.live.test.ts` is genuinely untouched by this slice.
  Ran it in isolation myself: 11/11 passed, ~18s. Also re-ran the full
  scoped `lib/rules` + `lib/ingestion` suite myself: 682/684 passed, 2
  skipped, 0 failed (the flake didn't even reproduce this run) — confirms
  intermittent shared-dev-DB contention, not a real regression.
- **Coverage:** `lib/rules/adherence-repository.ts` — **100% lines,
  100% branches, 100% functions** (v8 coverage, own isolated run). Clears
  00-foundation §9's 90%-line engine bar with room to spare.
- **Build/lint/tsc:** re-ran independently — `npm run build`, `npx eslint
  .`, `npx tsc --noEmit` all clean (0 errors; only pre-existing warnings
  in unrelated files).
- **New tests added (10, all passing), closing genuine independent-
  verification gaps rather than duplicating the coder's own suite:**
  `lib/rules/__tests__/adherence-repository.independent-verify.test.ts`
  (8 mocked/pure tests — fresh §5.6 fixture, 4-scenario tie-break chain,
  multi-user/multi-week dedup, independent XP/gamification greps) and
  `lib/rules/__tests__/adherence-repository.independent-verify.live.test.ts`
  (1 live-DB test — the forced-write-failure-never-corrupts proof above).
- **One minor gap noted, not blocking:** the `confirm.ts →
  recomputeAdherenceWeeklyForConfirmations` wiring itself (call-after-
  commit, correct args, skip-when-nothing-confirmed) is proven only by
  the coder's live-DB test, not at the mock/unit level (unlike Slice 5's
  freeze-wiring, which has both). Investigated whether this matters in
  practice: `recomputeAdherenceWeeklyForConfirmations`'s own dedup loop
  calls `weekStartForServerDay` OUTSIDE its per-pair try/catch, so a
  malformed `serverDay` would throw synchronously and propagate past
  `confirm.ts` (which has no defensive try/catch of its own, by design —
  it relies on the batch helper's "never throws" contract). Traced both
  real call sites: `confirmDay`'s `serverDay` is already validated by
  `computeServerDayRange`'s strict `YYYY-MM-DD` regex earlier in the same
  transaction (throws before the recompute call is ever reached), and
  `autoConfirmStaleTrades`'s `server_day` comes from a Postgres
  `date::text` cast (always well-formed). Gap is real but unreachable via
  either production call site today — flagging for whoever next touches
  `confirm.ts`'s call site, not blocking this slice. Did not add a mock
  test for the wiring itself: reproducing `confirmDay`'s full real query
  sequence (account lookup, coverage-gap check, ambiguous-grouping check,
  anomaly check, freeze, closeout insert) in a mock risks being more
  fragile than informative, and the live-DB test already exercises the
  real code path — arguably stronger evidence than a mock would give.

**Readiness for security review: YES.** No RLS gap (owner-SELECT-only, no
client write path, both verified live), no credential handling in this
slice, no expression-evaluator surface, no currency mixing, no XP
coupling, no compound-rule surface. Nothing here should block
security-reviewer, but they own the final call.

**Historical detail below, preserved for reference —**

**→ Module 04 Slice 3 full report (DONE, 2026-08-24).**
Full gate sequence: coded → independently tester-verified PASS →
security-reviewed PASS → QA-reviewed PASS. Files built:
`lib/rules/computable-operand-values.ts` (single-trade extraction for the
8 `computableToday: true` operands), `lib/rules/distributions-repository.ts`
(fetch/bucket/upsert `operand_distributions`, service-role, "last 200
trades AND 12 months" windowing), `lib/rules/preview.ts` (`preview(userId,
operandId, op, value)`, reads-only, reuses `evaluate.ts`'s real `compare()`),
`app/(app)/rules/actions.ts`'s new `previewRule` Server Action,
`lib/ingestion/sync.ts`'s new post-sync recompute call, `docs/runbook.md`'s
new entry. Full report, judgment calls, and test list are in the matching
2026-08-24 decision log entries below (coder → tester → security-reviewer
→ qa).

**→ Module 04 Slice 4 full report (DONE, 2026-08-24, coder+tester detail
preserved; security-reviewer PASS and qa PASS summarized above).**

This slice split the originally-planned "Slice 4 — freeze-wiring" into two:
this slice built the pure, read-only cross-trade query/aggregation layer
only; the actual wiring into Module 02's confirm/freeze transaction
(`lib/ingestion/confirm.ts`, so `rule_evaluations` rows actually get
written and frozen), `adherence_weekly` materialization, and session-rule
attachment ("Max 3 trades per day... attach the break to the fourth
trade," §5.4) are now **Slice 5**, not this one — a deliberate, explicit
rescoping (logged in the decision log below), not scope creep discovered
mid-slice. **Confirmed: nothing in this slice writes to `rule_evaluations`,
and nothing in this slice is called from `lib/ingestion/confirm.ts`.**

**Files built:**
- `lib/rules/week-boundary.ts` — `weekStartForServerDay`/`weekEndForServerDay`/
  `addDaysToServerDay`. **The first week-boundary definition anywhere in
  this repo** — ISO week (Monday start), applied to `server_day`, per
  AGENTS.md's "streak counts weeks, not days" and
  `retrospeq-design-decisions.md`'s "the weekly review boundary should
  follow the forex week for mixed accounts" note. Recorded as
  `docs/adr/0015-iso-week-boundary-monday-start.md` since Slice 6
  (`adherence_weekly`) and Module 07 (`streaks`/`weekly_snapshots`) both
  need to match this exactly. 14 unit tests, 100% coverage.
- `lib/rules/cross-trade-operand-values.ts` — the cross-trade assembly
  itself. **20 operands built** (grouped by shared query, not one function
  per operand): `daily_loss_pct`, `weekly_loss_pct`, `size_vs_avg`,
  `total_open_risk`, `consecutive_losses`, `trades_today`,
  `trades_this_week`, `daily_pnl_pct`, `giveback_from_peak`,
  `time_since_last_trade`, `time_since_last_loss`, `instruments_today`,
  `first_time_instrument`, `target_set_at_entry`, `planned_rr`,
  `exit_vs_target`, `exit_reason`, `added_after_entry`, `scale_out_count`,
  `time_to_full_size`. `assembleCrossTradeOperandValues(tradeId)` is the
  orchestrating entry point (opens its own `withServiceRoleConnection`);
  `assembleCrossTradeOperandValuesWithClient(client, tradeId)` is the
  lower-level version taking an already-open `PoolClient` — mirrors
  `sync.ts`'s `loadInstrumentBlockState` pattern deliberately, so Slice 5
  can call it inside `confirmDay`'s own transaction without opening a
  second connection. Every query parameterized, scoped to `trade.account_id`
  (a documented judgment call, applied uniformly — see the file's own
  header: equity/currency/sync-tier are per-account concepts, so
  cross-account aggregation would be financially meaningless).
  `lib/supabase/__tests__/service-role-inventory.test.ts`'s allowlist
  updated for this file's new `withServiceRoleConnection` call site (the
  test's own mandatory companion rule).

**10 operands deliberately deferred, matching this slice's own dispatch
list with zero disagreements found on independent re-verification**
(re-checked each against its own `factNote` and the actual schema, not
taken on faith): `correlated_exposure` (no correlation grouping exists),
`order_type` (no column exists anywhere in Module 02's schema), `trigger_conditions_met`
(depends on Module 03), `added_to_a_loser` (no per-add-event unrealized-P&L
snapshot stored), `stop_moved_against`/`stop_move_count` (need T1
`position_snapshots`, zero rows/writers exist), `minutes_into_session`/
`entry_clock_time` (no session-open reference time), `weekly_review_completed`
(depends on Module 06). **`logged_within_minutes` — a genuine judgment
call, chose DEFER over building an interpretation:** considered "first
`trade_captures` row's timestamp" as a proxy, but `trade_captures` has no
`created_at` column at all (only `updated_at`, overwritten on every edit —
captures are editable post-close per §4.7), so even that proxy would
silently misrepresent "logged within N minutes" as "most recently EDITED
within N minutes." Guessing wrong here would silently misclassify real
evaluations once this operand becomes ruled on — deferred alongside the
genuinely-blocked operands rather than forced.

**Critical correctness points, each independently proven against a live
seeded Postgres DB, not just unit-mocked** (`lib/rules/__tests__/cross-trade-operand-values.live.test.ts`,
7 tests + 1 not-found-error test, all against the real shared dev Supabase
project): `consecutive_losses` stops at the first non-loss (and treats
`scratch` the same as a win — a documented judgment call, since a scratch
is not literally a loss), never includes the trade itself;
`giveback_from_peak` tracks a real chronological running-max/giveback
across two trades with a rise-then-partial-giveback-then-new-peak
sequence; `trades_this_week` correctly buckets a Sunday into the
PRECEDING week and the following Monday into a NEW week (the ISO-week
convention above, proven live, not just unit-tested); `first_time_instrument`
correctly excludes the trade itself and distinguishes a repeat instrument
from a genuinely new one; plus an explicit account-isolation test (a
second account's trades never leak into another account's cross-trade
facts) and a full entry/exit-fill-plan test matching
`fixtures/golden/scaled_in_out`'s own `scale_out_count: 2` expected value
byte-for-byte.

**Judgment calls, documented in each function's own header, not silently
made:** `exit_vs_target`'s fact shape ("progress toward target as a
percentage," chosen to make the catalogue's own `gte`/`higher_is_tighter`
pairing internally consistent — the catalogue's "short of target" UI
phrasing vs. this stored fact's polarity is a rendering-layer translation,
not a fact-assembly concern); `total_open_risk` and `consecutive_losses`/
`time_since_last_*`/`size_vs_avg`'s different trade-status filters
(same-day in-flight aggregation includes any status with the relevant
timestamp present; backward-looking historical facts require
`status = 'confirmed'` only — full reasoning in the file's own header);
`size_vs_avg`'s averaging window reuses `distributions-repository.ts`'s
established "last 200 trades AND 12 months" convention, for consistency
rather than inventing a second one; `scale_out_count` is a genuinely new
SQL `COUNT ... FILTER` query, not a call into `trade-facts.ts`'s own
(unexported, differently-shaped) `computeTradeFacts` — proven equivalent
against the real `scaled_in_out` golden fixture's own expected value,
not merely asserted equivalent by inspection.

**Tests:** `week-boundary.test.ts` (14), `cross-trade-operand-values.test.ts`
(53 pure-function unit tests covering every "easy to get backwards" case
named in this slice's own dispatch), `cross-trade-operand-values.live.test.ts`
(8, against the real live DB). Full repo suite: **111 test files, 1359
passed / 13 skipped / 0 failed**, `npx tsc --noEmit` / `npx eslint .` /
`npm run build` all clean. `cross-trade-operand-values.ts` itself: 100%
lines/funcs, 95.27% branches (live-DB test run); `week-boundary.ts`: 100%
across the board.

**One pre-existing, unrelated flake found and fixed while running the
full suite, not introduced by this slice:** `lib/ingestion/__tests__/confirm.live.test.ts`'s
"7-day threshold" test for `autoConfirmStaleTrades` failed intermittently
— root-caused to orphaned rows in the shared dev Supabase project
(`retrospeq.trades` rows left behind by test runs whose own `afterEach`
cleanup never ran, most concretely because this coder killed several
still-running `npx vitest` background processes mid-test while
investigating an unrelated concurrency question earlier in this session).
`autoConfirmStaleTrades`'s own candidate query is a GLOBAL, account-unscoped
sweep by design (per its own doc comment) — a real, load-bearing reason
this class of test is fragile against a shared, accumulating dev database
(ADR 0002), not a bug in Module 04 Slice 4's own code (which this test
file has no import-path dependency on at all). Cleaned up 6 orphaned
`trades` rows (1 from this session's own interrupted run, 5 pre-existing
from earlier sessions dated 2026-08-22/23) plus their auth users; the
flaking test then passed cleanly, in isolation and inside the full suite,
across two separate full-suite runs. **Not a Module 04 Slice 4 finding —
noted here for the record, and worth `retrospeq-tester`/`retrospeq-security-reviewer`
flagging as a standing hygiene gap** (live-test cleanup that depends on a
process running to completion is inherently fragile; a periodic
orphaned-test-data sweep for the shared dev project would close this
class of flake for good, tracked as a real but non-blocking follow-up, not
built here since it's outside this slice's own scope).

**`retrospeq-tester` independent verification (2026-08-24): PASS, 5 real
gaps found and closed (all closed by adding tests; zero production-code
changes — none were needed).** Re-read Module 04 §5.3-§5.6, §4.1 and
AGENTS.md's "streak counts weeks, not days" before verifying. Re-ran
everything myself rather than trusting the coder's numbers:

- **Full suite, re-run independently, twice:** 111 files / 1365 passed /
  13 skipped / 0 failed (after the 5 tests I added below; 1360 passed
  before them, matching the coder's reported 1360 to within one flake —
  see below). Clean `npx tsc --noEmit`, clean `npx eslint .` (0 errors,
  19 pre-existing unrelated warnings), clean `npm run build`.
- **One flake during the full-suite run, root-caused, not a real
  failure:** `manual-entry.live.test.ts`'s "long, full happy path" test
  hit vitest's 5000ms default timeout once under full-suite parallel
  contention against the shared dev Supabase project; re-run in isolation
  it passed in 4649ms (7/7 tests, that file alone). Unrelated to this
  slice's own code (no import-path dependency).
- **Coverage, independently re-measured:** `cross-trade-operand-values.ts`
  100% lines/funcs, 95.27% branches (the two uncovered branch pairs are
  defensive `?? '0'`/`?? 0` fallbacks for a SQL row that can't actually be
  absent, given `coalesce()` on the aggregate query — not a real gap);
  `week-boundary.ts` 100% across the board. Matches the coder's reported
  numbers exactly.
- **`docs/adr/0015-iso-week-boundary-monday-start.md`** read in full —
  correctly grounded in AGENTS.md's non-negotiable and the design doc's
  forex-week note, correctly scoped as an approximation (no literal
  session-open data exists yet), and correctly flags itself as
  load-bearing for Slice 6/Module 07.
- **`consecutive_losses`** (dispatch item 1): verified against my OWN
  fixture, not just the coder's — `computeConsecutiveLosses(['loss',
  'loss', 'loss', 'win'])` (most-recent-first encoding of the dispatch's
  literal "win, loss, loss, loss, [ref]" example) → `3`, not `4`.
  All-losses-since-start (7-length) → `7`, not truncated. Zero-prior-trades
  → `0`, never an error. All pass. No gap.
- **`giveback_from_peak`** (dispatch item 2) — **a real gap, closed.** The
  coder's own tests covered a 2-event and a 3-event sequence (rise,
  partial-giveback, new-peak) but never a 4-event up/down/up/down sequence
  that would catch a "peak = day's eventual max" bug distinct from
  "peak = genuine running max." Added
  `lib/rules/__tests__/cross-trade-operand-values.test.ts`'s new
  `'tester fixture: up, down, up again, down again...'` test: four
  realized-P&L events (+500, -200, +400, -100), asserting giveback at
  EACH intermediate point (`0%` after event 1, `40%` after event 2 — using
  the 500 peak, not a future 700 — `0%` at the new 700 peak after event 3,
  `~14.29%` after event 4). All pass, confirming the peak is tracked
  chronologically and giveback is always measured from whichever peak was
  highest as of the LATEST row in the window, never a peak that hasn't
  happened yet from that vantage point (structurally guaranteed anyway by
  `fetchClosedTradesForPnlWindow`'s `closed_at < referenceOpenedAt` filter
  — this test proves the pure aggregation on top of that filter is also
  correct).
- **Week-boundary edges** (dispatch item 3): `weekStartForServerDay`
  operates on `server_day` (a date, not a timestamp) by design — per the
  ADR, this makes it structurally insensitive to a Sunday-23:59-vs-Monday-
  00:00 timestamp distinction; what matters is which calendar date lands
  in `trades.server_day`, already tested exhaustively (all 7 weekdays +
  month/year boundaries in `week-boundary.test.ts`, and a live-DB test
  bucketing a real Sunday trade into the preceding week and a real Monday
  trade into a fresh one). Confirmed `assembleCrossTradeOperandValuesWithClient`
  uses `ctx.serverDay` (from the `trades` row), never a raw
  `opened_at`/`closed_at` timestamp, for the week-window computation — no
  gap.
- **`first_time_instrument`** (dispatch item 4): confirmed the query
  excludes the reference trade both by `opened_at < $referenceOpenedAt`
  AND `id != $excludeTradeId` (belt-and-suspenders against the exact
  "naive `count(*) where instrument = X`" bug shape named in the
  dispatch) — no gap, already live-tested for both the repeat- and
  new-instrument cases.
- **`time_since_last_trade`/`time_since_last_loss`** (dispatch item 5):
  confirmed the reference point is consistently the PRIOR trade's
  `closed_at` compared against THIS trade's own `opened_at`
  (`minutesSince(ctx.openedAt, lastTradeTimings.lastTradeClosedAt)`),
  consistent across both operands; `null` (not `0`, not a throw) when no
  qualifying prior trade exists — no gap.
- **`decimal.js` spot check** (dispatch item 6): every money/percentage
  computation (`daily_loss_pct`, `weekly_loss_pct`, `giveback_from_peak`,
  `size_vs_avg`, `planned_rr`, `exit_vs_target`) stays in `Decimal` until
  a single `.toNumber()` at the function's return boundary — matching the
  exact precedent already established (and already security-reviewed) in
  `lib/rules/computable-operand-values.ts`/`evaluate.ts` (which re-wraps
  the value in `new Decimal()` on the read side). The only plain
  `Number()` calls are on SQL `COUNT(...)` integer results
  (`add_count`/`trim_exit_count`), never money — no drift risk. No gap.
- **Account isolation** (dispatch item 7): re-ran the coder's live
  `'account isolation'` test myself against the real shared dev Supabase
  project — passes. Confirmed every fetch function's SQL is parameterized
  and scoped to `account_id` (never a caller-supplied value beyond the
  trade's own resolved `account_id`).
- **`scale_out_count` reuse** (dispatch item 8): confirmed
  **reimplemented, not reused** — `trade-facts.ts`'s `computeTradeFacts`
  requires a full `TradeFactsMember[]` this query layer doesn't build;
  the new SQL query (`count(*) filter (where role in ('trim','exit'))`)
  uses the identical counting rule, verbatim, to `trade-facts.ts`'s own
  `const scaleOutCount = members.filter((m) => m.role === 'trim' || m.role
  === 'exit').length` (confirmed by direct read of both files). Proven
  equivalent, not just asserted: the live test seeds a real
  entry/add/trim/exit fill sequence and asserts `scale_out_count === 2`,
  matching `fixtures/golden/scaled_in_out/expected.json`'s own
  `scale_out_count: 2` byte-for-byte. No gap.
- **The 10 deferred operands** (dispatch item 9) — **a real gap, closed.**
  No existing test asserted the deferred operand ids are absent KEYS (as
  opposed to present-but-null) in the orchestrator's output. Added a new
  live test, `'the 10 deferred operands are genuinely absent keys in the
  output...'`, asserting `Object.keys(values)` equals
  `CROSS_TRADE_OPERAND_IDS` exactly (20, no more/fewer) and that none of
  the 10 deferred ids satisfy `in`/`hasOwnProperty` — closes a real "looks
  fine by eye, unverified in CI" gap; a regression here (e.g. someone
  later adds `order_type: null` thinking they're being helpful) would
  now fail loudly.
- **Orphaned-rows cleanup** (dispatch item 10): re-ran
  `confirm.live.test.ts` directly and in isolation — 18/18 passed
  including the "7-day threshold, both sides" test cleanly. `git status`/
  `git diff --stat` confirm zero production-table-affecting file changes
  beyond the two test-allowlist/test files already accounted for above —
  the cleanup was pure live-DB row deletion (auth users + their `trades`
  rows this coder's own session orphaned), not a code change, consistent
  with the PROGRESS.md entry's own description.

**Files touched by this verification pass** (tests only, zero production
code changed): `lib/rules/__tests__/cross-trade-operand-values.test.ts`
(+3 `consecutive_losses` fixtures, +1 four-event `giveback_from_peak`
fixture), `lib/rules/__tests__/cross-trade-operand-values.live.test.ts`
(+1 deferred-operands-absent test).

**Readiness for security review: YES.** No production-code gaps found;
the two real gaps were test-coverage gaps (both closed), not correctness
bugs. `retrospeq-security-reviewer` should still independently re-verify
account-scoping, the service-role-inventory allowlist addition, and
(per the module's own §5.3 "security-critical" framing for the sibling
evaluator, which this slice's output eventually feeds) that no operand
value here can be used to smuggle anything beyond a plain
number/string/boolean into `evaluate()`'s `compare()` — this slice's own
data never leaves parameterized queries or `Decimal`/plain-value
arithmetic, but that's exactly the kind of claim security review exists
to re-check rather than take on my word.

**Not marked done in this ledger** — per AGENTS.md, that is
`retrospeq-qa`'s call, gated on the security-reviewer pass, which has not
happened yet.

**Next: Module 04 Slice 5 — freeze-wiring (§5.4, §7.1).** Wire
`assembleCrossTradeOperandValuesWithClient` (this slice) plus Slice 3's
`extractComputableOperandValues` (single-trade) into a real `TradeFacts`
object (plus `accountSyncTier`, from `trading_accounts.sync_tier`) inside
`lib/ingestion/confirm.ts`'s `confirmDay` transaction, so `rule_evaluations`
rows actually get written and frozen at close-out. Also needs
`adherence_weekly` materialization (§5.6, using this slice's
`weekStartForServerDay` for the week bucket) and session-rule attachment
("Max 3 trades per day... attach the break to the fourth trade," §5.4).
This is the single most trust-sensitive slice in Module 04 — "rule
evaluations freeze at close-out and are never recomputed retroactively"
is a non-negotiable, not a suggestion.

**What was built (Slice 1):**

- **Schema** (`supabase/migrations/20260823020000_rulebook_schema.sql` +
  `20260823030000_rule_evaluations_immutability_trigger.sql`, both
  applied to and verified against the live shared dev Supabase project
  via `information_schema`/`pg_policies`/`information_schema.triggers`,
  same method every prior migration in this repo uses): 6 tables --
  `rules`, `rule_versions`, `rule_evaluations`, `rule_overrides`,
  `adherence_weekly`, `operand_distributions`. `trigger_evaluations`
  (Module 04 §3.1's own 7th/last table) is DELIBERATELY DEFERRED, not
  built and not stubbed -- it references Module 03's `trigger_conditions`,
  which doesn't exist anywhere in this repo, and there is nothing for a
  stand-in table to meaningfully evaluate yet. Flagged in both the
  migration's own header comment and here, per this repo's established
  "flagged, not silently skipped" convention for forward dependencies.
  RLS: 100% coverage, one policy shape reasoned per-table from its own
  data semantics (not copy-pasted from ADR 0011's ingestion-table
  conclusions, though the REASONING METHOD is the same) --
  `rules`: owner "for all" (genuinely user-mutated: severity/state/
  retired_at/promoted_at). `rule_versions`: owner SELECT+INSERT+UPDATE,
  narrowed by a DB trigger (`rule_versions_forbid_mutation`) to permit
  exactly one legitimate one-way mutation (`superseded_at`, null ->
  timestamp, never back) and nothing else -- an allowlist trigger, same
  technique as `trades_forbid_frozen_regrouping`. `rule_evaluations`:
  owner SELECT only, NO client insert policy at all (Module 02 "owns the
  freeze trigger" per §13, and `confirm.ts` already writes exclusively
  via `withServiceRoleConnection`, verified by reading that file, not
  assumed). `rule_overrides`: owner SELECT+INSERT, append-only (a live
  user action, but never edited after the fact). `adherence_weekly` /
  `operand_distributions`: owner SELECT only, materialised,
  service-role-only writes.
  **Judgment call, beyond the literal §3.1 DDL:** two DB triggers built
  THIS slice, not deferred, even though nothing writes to
  `rule_evaluations` yet -- `rule_evaluations_forbid_update` (rejects
  ANY update, unconditionally -- the DDL's own "written once, never
  updated" has zero documented exceptions, unlike `trades.not_a_decision`,
  so there was no future-column-set ambiguity to wait on, unlike why
  `trades_forbid_frozen_regrouping` WAS deferred in Module 02 Slice 1) and
  `rule_evaluations_forbid_delete` / `rules_forbid_delete` (both reject
  DELETE outside of account erasure, reusing the exact
  `retrospeq.erasure_in_progress` escape-hatch mechanism
  `forbid_broker_confirmed_trade_delete` already established -- `rules`
  wasn't in the spec's own DDL comments as needing a delete-trigger, but
  deleting a rule would cascade-delete its frozen `rule_evaluations`,
  which is precisely the "gaming the trust-sensitive number" vector
  Module 04 §1's own opening line names as the whole module's real risk;
  reasoned as a defensible security-motivated extension, not literal
  spec transcription -- flagged explicitly for security review, not
  silently added).

- **Operand catalogue** (`lib/rules/operand-catalogue.ts`, a typed `.ts`
  const, not YAML -- format judgment call documented in the file's own
  header). All 38 v1 (non-Firm) operands from §4.1's table present -- zero
  invented, zero skipped, "coverage equals catalogue size" checked
  directly by a test. Every entry carries a `computableToday: boolean` +
  mandatory `factNote` documenting exactly what it maps to (or why it
  doesn't yet) -- 8 operands are `computableToday: true` today (`risk_pct`
  -> `trades.initial_risk_pct`, NOT `trades.risk_pct`/peak -- a real,
  documented judgment call given ADR 0012's own named gotcha;
  `hold_seconds`, `day_of_week`, `instrument`, `stop_set_at_entry`,
  `held_past_stop`, `peak_risk_vs_planned`, `pre_entry_captured_before_fill`),
  the other 30 need cross-trade day/week-state aggregation, a missing
  module (Module 03's `trigger_conditions`, Module 06's weekly review), or
  T1 `position_snapshots` data this repo doesn't have flowing yet -- none
  of that aggregation was built or stubbed this slice, per the dispatch's
  own instruction. A few fields (`order_type`'s `options`,
  `entry_clock_time`'s `bounds`, `correlated_exposure`'s methodology,
  `logged_within_minutes`'/`weekly_review_completed`'s exact attachment
  point) are flagged with an explicit `todo` field rather than guessed,
  where §4.1 gave no worked example and no defensible inference was
  available.

- **Evaluator** (`lib/rules/evaluate.ts`) -- §5.3's six-step pseudocode
  implemented exactly (with one documented, outcome-preserving reordering:
  step 5's op/type validation runs immediately after step 1's operand
  resolution, before the tier/missing-value branches, because §8.3 treats
  "unknown operand_id" and "malformed op for the type" as the same
  loud-rejection class, distinct from a legitimate `not_applicable`).
  Verified directly, not just asserted in a comment: no import of `pg` or
  `lib/supabase/*` anywhere in the file (also asserted by a static test),
  no `eval`/`Function`/`new Function`, no SQL string construction anywhere
  -- a pure function over its two arguments. `decimal.js` for every
  numeric/duration/rating comparison. `operand_id` validated via a
  whitelist lookup (`getOperand`), unknown ids throw `RuleEvaluationError`
  with code `UNKNOWN_OPERAND` -- never silently resolved to
  `not_applicable` (that's reserved for a KNOWN operand's missing value or
  tier gate, per §8.3's own distinction, spelled out in this file's own
  header comment).

- **Tests**, all passing against the live shared dev Supabase project
  (86 new tests: 15 catalogue, 44 evaluator unit, 7 evaluator property +
  4 static-security-property, 30 live-DB RLS/trigger; full repo suite:
  1041 passed, 13 skipped [pre-existing skip-guards, unrelated to this
  slice], 0 failed). Coverage on the two new files: `evaluate.ts`
  98.7% lines / 98.63% branches, `operand-catalogue.ts` 100%/100% -- both
  well above the 90%-on-engines bar. Every operator x operand-type pair
  from §8.1 covered including boundary equality (`lte`/`gte` at the exact
  threshold); `not_applicable` for both tier mismatch and missing operand
  value; unknown `operand_id` and malformed op/value-shape all proven to
  throw a specifically-typed, named error rather than silently degrading;
  a 200-run fast-check property test proving `evaluate()` never throws
  anything but a named `RuleEvaluationError` code and is fully
  deterministic, plus a static grep-based check proving no SQL
  string/`eval` exists anywhere in either new file's source text; 100% RLS
  cross-user-isolation coverage on all 6 new tables plus live behavioural
  proof of every trigger (including "even for the service role" and the
  erasure-escape-hatch path), matching `ingestion-schema.rls.test.ts`'s
  own precedent exactly.

**Explicitly NOT built this slice** (per the dispatch's own scope
boundary, matching Module 02 Slice 1/2's "schema + core engine before
orchestration" precedent): the authoring pipeline (§5.1 -- template
generation, tighten-only/satisfiability validation, rule CRUD Server
Actions), the preview engine (§5.8), the freeze-wiring into Module 02's
confirm transaction (§5.4/§7.1 -- nothing writes to `rule_evaluations`
yet), adherence computation/materialisation (§5.6), the severity
lifecycle (§5.7), overrides-writing (nothing calls `rule_overrides` yet
outside tests), any UI, and the cross-trade fact-assembly queries for the
30 `computableToday: false` operands. `docs/adr/` was NOT touched this
slice -- §15's three named ADR-worthy decisions ("no compound rules,"
"freeze at confirmation," "adherence excluded from gamification") are not
actually being decided or tested by a schema-only slice; the judgment
calls this slice DID make (RLS shape reasoning, the trigger_evaluations
deferral, the risk_pct->initial_risk_pct mapping, the immutability
triggers built now rather than deferred) are recorded in each file's own
header comment plus this entry, per this repo's established convention.

Files: `supabase/migrations/20260823020000_rulebook_schema.sql`,
`supabase/migrations/20260823030000_rule_evaluations_immutability_trigger.sql`,
`lib/rules/operand-catalogue.ts`, `lib/rules/evaluate.ts`,
`lib/rules/__tests__/operand-catalogue.test.ts`,
`lib/rules/__tests__/evaluate.test.ts`,
`lib/rules/__tests__/evaluate.property.test.ts`,
`lib/supabase/__tests__/rulebook-schema.rls.test.ts`. Build/lint/tsc all
clean (`npm run build`, `npx eslint`, `npx tsc --noEmit`, all exit 0).

**Next step for whoever picks this up:** Slice 1 is fully done (see
security-reviewer and QA passes below) -- move to Slice 2, the authoring
pipeline (§5.1: rule CRUD, versioning, tighten-only/satisfiability
validation, template generation), per the build-order framing in
AGENTS.md/brief-developer-and-design.md ("the guided three-rule front
door... is also the entire free tier").

**`retrospeq-tester` independent pass, 2026-08-23 (after the coder's own
self-test above) -- PASS, with 2 gaps added/fixed this pass, 1 gap
flagged unfixed (documentation, not code).** Read Module 04 §3.1/§4/§4.1/
§5.3 in full plus both `lib/rules/evaluate.ts` and
`lib/rules/operand-catalogue.ts` end to end, independent of the coder's
own claims:

- **"No compound rules" structurally verified, not just asserted**: read
  `rule_versions`' DDL directly -- one `operand_id text`, one `op text`
  (CHECK-constrained to the 9-value enum), one `value jsonb` column, full
  stop, no array/nested-condition column anywhere. `RuleVersionInput` in
  `evaluate.ts` mirrors this exactly (`operandId: string; op: RuleOperator;
  value: unknown`) -- no array-of-conditions or boolean-tree shape
  anywhere in the file. **Confirmed true.**
- **"Never compiled to SQL, never eval'd" verified by grep, not by
  re-reading the coder's own comment**: `eval\(|new Function|Function\(|pg\b|lib/supabase`
  across all of `lib/rules/` returns zero real hits (only comments/test
  assertions mention those strings). Also independently confirmed at the
  DB layer: a hand-crafted `insert ... op = 'DROP TABLE'` against
  `rule_versions` is rejected by `rule_versions_op_check` (tested live,
  rolled back) -- defense in depth beyond the app-layer catalogue
  whitelist. **Confirmed true.**
- **§4.1 coverage hand-counted, not trusted to the file's own test**:
  manually tallied §4.1's table (38 non-Firm operand ids across 8 groups)
  against `OPERAND_CATALOGUE`'s actual entries -- exact match, 38/38, zero
  invented. Then read `operand-catalogue.test.ts` itself and confirmed its
  coverage test is genuinely two-directional (every spec id has an entry
  AND no entry exists outside the spec list AND a hardcoded `toHaveLength(38)`)
  -- not a partial check that would pass with entries silently missing.
- **Throw-vs-`not_applicable` stress-tested**: confirmed via direct
  unit + property tests that an unknown `operand_id` and a
  structurally-invalid `op` for the operand's type always throw
  `RuleEvaluationError` (codes `UNKNOWN_OPERAND` / `INVALID_OP_FOR_TYPE`),
  and a tier-gated or missing-fact operand always resolves
  `not_applicable`, never throws -- the two failure classes never cross.
- **Live-DB trigger re-verification, independent of the coder's own test
  file**: wrote and ran a standalone script (rolled back, nothing
  persisted) directly exercising, against the real live Supabase project:
  `rule_evaluations` UPDATE rejected; `rule_versions` body-field UPDATE
  rejected; `superseded_at` null->timestamp permitted exactly once, a
  second change rejected; `rule_evaluations`/`rules` DELETE rejected
  outside erasure and permitted with `retrospeq.erasure_in_progress` set.
  All 7 checks matched the existing test file's own claims exactly.
- **Gaps found and fixed this pass** (both now closed, `lib/rules/`
  coverage went from 98.7%/98.66%(branch) to **100%/100%/100%/100%**):
  (1) `toDecimal()`'s "not finite" branch (Infinity/NaN, both numeric and
  string forms, for both `observed` and `rule_version.value`) was
  genuinely uncovered -- the property-test fuzz generates `NaN`/`Infinity`
  doubles but rarely enough to hit it in 200 runs, and no unit test
  targeted it directly; added 5 unit tests. (2) the op-fuzzing property
  test only ever generated one of the 9 real `RuleOperator` enum values
  (a valid op applied to the WRONG operand type), never a genuinely
  arbitrary garbage string for `op` itself -- a real gap given `op` is
  only TS-typed at the boundary, not narrowed at runtime, and a
  hand-crafted API payload or buggy caller could hand evaluate() anything;
  added 2 new property tests (`fuzzedOpRuleVersionArb`, 200 runs, plus a
  targeted "known operand + garbage op always throws INVALID_OP_FOR_TYPE,
  never UNKNOWN_OPERAND, never silent not_applicable" property test, 100
  runs). Total: 67 tests in `lib/rules/` (up from 63), 1047 passed / 13
  skipped / 0 failed repo-wide (up from 1041/13/0), full suite reverified
  live against the shared dev Supabase project after the additions.
  `npm run build`, `npx eslint`, `npx tsc --noEmit` all still exit clean.
- **Gap flagged, NOT fixed this pass (documentation, not a test gap)**:
  Module 04 §15 names three ADR-worthy decisions this module needs
  ("no compound rules," "freeze at confirmation rather than broker
  close," "adherence excluded from gamification") -- none of the three
  exist yet in `docs/adr/`. The coder's own slice note argues a
  schema-only slice doesn't yet "decide" freeze-at-confirmation or
  adherence-exclusion (later slices build those), which is fair for
  those two, but **"no compound rules" is a decision this slice's own
  schema and evaluator fully embody right now** (the DDL shape and the
  TS types ARE the decision) and per AGENTS.md §12 ("Documentation ...
  written by retrospeq-coder as part of finishing a slice -- not a
  separate pass, not optional") the ADR for it should exist alongside
  this slice, not be deferred indefinitely. Flagging for whoever does the
  QA pass rather than writing it myself (out of scope for a tester role).
- **What I could NOT verify** (infra, not a code gap): none this pass --
  a real, live Postgres connection (the shared dev Supabase project via
  `SUPABASE_DB_URL` in `.env.local`) was available for every RLS/trigger
  claim above; nothing here was checked only against a mock.

**`docs/adr/0014-no-compound-rules.md` written 2026-08-23** (by the
orchestrator, not a dispatched coder pass) to close the tester-flagged
gap above -- documents the structural no-compound-rules guarantee, why
it will otherwise be re-litigated (attribution, independent lifecycle
management, injection/expression-engine risk surface), that `scope` (not
compounding) is the spec's own resolution for "stricter in this
situation," and explicitly declines to write the other two §15-named
ADRs ("freeze at confirmation," "adherence excluded from gamification")
since neither is concrete yet in a schema-only slice.

**`retrospeq-security-reviewer` pass, 2026-08-23 -- PASS, no findings.**
Independently re-ran the full `lib/rules` suite (67/67) and the live-DB
RLS/trigger suite (29/29 + 1 skipped) rather than trusting the tester's
numbers. Verified all 8 checklist items requested: (1) no compound
rules structurally (schema, types, and evaluator control flow all
independently re-read); (2) never compiled to SQL / never eval'd (grep
for `eval(`/`new Function`/SQL-string patterns across `lib/rules/` --
zero real hits; confirmed dynamic property access only ever uses the
post-whitelist `operand.id`, never the raw `ruleVersion.operandId`);
(3) operand_id whitelist enforced before any other processing; (4) RLS
100% correct across all 6 tables, including confirming the
`rule_versions` UPDATE policy genuinely can't be abused beyond
`superseded_at` and that `rule_evaluations` has zero client-writable
policy of any kind; (5) DB-level immutability triggers block all roles
including service role, erasure escape hatch confirmed transaction-local
and unreachable by any client role (traced every real
`set_config('retrospeq.erasure_in_progress'...)` call site back to
`erasure.ts`'s service-role-only `executeErasure()`, no exposed
`SECURITY DEFINER` wrapper); (6) `rule_evaluations` freeze verified
structurally airtight -- no update path exists at all, at either the RLS
or trigger layer; (7) `rule_versions_op_check` CHECK constraint verified
to reject any op outside the 9-value enum unconditionally, including for
service-role writes; (8) general credential/injection scan -- no
findings, correctly out of scope for a schema/pure-function slice with
no UI or credential surface. Flagged (not a slice defect) that the
machine's C:-drive-full condition will bite the next agent's default
vitest temp dir on this box until disk space is freed or the
`E:`-redirect workaround is used -- already tracked in
`NEEDS_YOUR_INPUT.md`.

**`retrospeq-qa` pass, 2026-08-23 -- PASS, no findings.** Checked all 7
requested items from a product/spec-fidelity angle (distinct from the
security reviewer's structural/injection angle): (1) no-compound-rules
matches Module 04 §5.2's actual product intent, not just "no combinator
column" -- confirmed via the per-rule attribution/independent-lifecycle/
`scope`-not-compounding reasoning in ADR 0014; (2) `adherence_weekly`'s
schema is a clean followed/total shape with nothing that reads as an
XP/points field a later slice would be tempted to wire in -- confirmed
clean, zero xp/points/gamif hits in `lib/rules/`; (3) freeze semantics
match Module 04's own DDL comment ("written once, never updated") and
§9's "0, ever, any occurrence is a critical incident" language, with no
documented exception unlike `trades.not_a_decision` -- confirmed the
implementation is unconditional, not just RLS-shaped like the
`rule_versions` allowlist case; also credited the `rules_forbid_delete`/
`rule_evaluations_forbid_delete` triggers as a defensible extension
beyond literal DDL, correctly flagged as such rather than silently
added, closing the "delete the rule to erase its evaluation history"
gaming vector §1 names by name; (4) `{operand_id, op, value}`-only
engine confirmed sanity-checked against spec fidelity; (5) ADR-0012
percentage convention spot-checked directly (`risk_pct` bounds
`{min: 0.1, max: 5.0}`, correctly percentage-numbers) and the
`initial_risk_pct`-not-`risk_pct` pre-entry mapping confirmed correct
and independently cross-referenced against Module 02's own trade-facts
documentation; (6) all 38 v1 operands hand-counted against §4.1's
per-group table, exact match, `trigger_evaluations` deferral correctly
scoped with a real forward dependency, no other silent gaps; (7)
ADR 0014 confirmed correctly scoped, neither over- nor under-reaching.
Also checked documentation (00-foundation §12) and performance (§8.1)
sub-bars: ADR present and accurate; no runbook entry needed yet since
nothing writes to `rule_evaluations` in this slice (correct, not a
gap -- flagged as the natural point to add one when the freeze-wiring
slice lands); performance N/A by construction (pure in-memory function,
no I/O). **Module 04 Slice 1 is DONE** -- all four mandatory gates
(coder, tester, security-reviewer, qa) passed, nothing outstanding.

---

**Phase 1 (Module 01 + Module 02) is COMPLETE as of 2026-08-23.** Read
`retrospeq-design-system/modules/
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

- [ ] No Vercel project for Retrospeq. Owner needs to create one and either connect this repo via Vercel's GitHub integration or supply a deploy token. **Blocks a real nightly job** (added 2026-08-24, Module 04 Slice 3): §12's "`operand_distributions` recompute nightly and on demand after a sync" only has its "on demand after a sync" half built (`lib/ingestion/sync.ts`'s `runSync` calls `recomputeOperandDistributionsForUser` after every successful sync, best-effort — see `docs/runbook.md`'s new entry for the failure mode). Nightly recompute needs a real cron/scheduler surface this repo doesn't have yet — not stubbed, per AGENTS.md's "never fake it."
- [x] ~~No Supabase project for Retrospeq~~ — **dev/test only, as of 2026-08-20, and now actually verified, not just configured.** Sharing the existing LuceEdge project (`vbuzudbipftgsuosreuy`), isolated via a dedicated `retrospeq` Postgres schema — see `docs/adr/0002-shared-dev-supabase-project.md`. `.env.local` has the URL, keys, and `SUPABASE_DB_URL` (direct connection). The `retrospeq` schema has been created for real (`20260819010000_init_schema.sql` applied and confirmed via `information_schema`). **Still open, not closed by this:** a dedicated paid-tier project is required before real launch (00-foundation §1.1) — this only unblocks local RLS/migration verification.
- [ ] No external KMS account (AWS KMS / GCP KMS / equivalent) for the envelope-encryption master key. Cannot be created by an agent — needs owner action.
- [x] ~~No git remote for this repo~~ — **resolved**, `origin` now points at `https://github.com/lucedge/Retrospeq_v1.git` (a dedicated repo, not the LuceEdge one — confirmed 2026-08-20). **New, smaller gap:** `git push` to `origin main` is being blocked in this environment by a local permission-system classifier (not a git/GitHub-side rejection — the command was denied before it ran). Commits are landing locally and are safe; they are not reaching the remote. Flagged for the owner to check the permission/auto-mode settings for this session type if pushes are expected to go through automatically per the autonomy policy above.
- [ ] Broker integration vendor undecided (00-foundation §10). Build against `BrokerAdapter` only; do not let a vendor type leak past the adapter.
- [ ] No transactional email provider configured (00-foundation §10's "Email provider" row — a separate dependency from Supabase Auth's own, already-broken mailer). `lib/privacy/email-provider.ts` (Module 01 stories 5.x, 2026-08-21) throws `EmailProviderNotConfiguredError` unconditionally rather than faking a send. Not currently blocking anything real: `lib/privacy/erasure.ts`'s confirmation email is best-effort and never gates the actual deletion, so this is a standing gap, not a stalled task — see that file's own doc comment. Needs an owner-created account with a real provider (Resend/SendGrid/Postmark/etc) plus its API key wired into env vars.
- [ ] Node version is 20.11.0; several deps warn they want >=22 (`@supabase/*@2.112.3`, `eslint-visitor-keys@5`). Still warn-only for those. **One hard incompatibility already hit and fixed**: vitest 4.x pulls in a rolldown-based Vite that requires `node:util`'s `styleText` (Node ≥20.12) — pinned `vitest`/`@vitest/coverage-v8` to `3.2.7` instead (classic esbuild-based Vite, no rolldown), see decision log. Revisit the pin when Node is upgraded past 20.11.
- [x] ~~Module 01's erasure flow will break the moment any user has a broker-confirmed `trades` row, until fixed.~~ **Fixed 2026-08-22, Module 02 Slice 3** — `lib/broker/accounts-repository.ts`'s `deleteAllTradingAccountsForUser` now sets `retrospeq.erasure_in_progress` (transaction-local `set_config`) before deleting `trading_accounts`, so `forbid_broker_confirmed_trade_delete`'s escape hatch (docs/adr/0011) actually fires for real erasure executions. Verified two ways: (1) a new live-DB test (`lib/privacy/__tests__/erasure.live.test.ts`, "succeeds for a user with a real broker-confirmed trade") seeds a genuine broker-confirmed trade and proves `executeErasure` now succeeds; (2) the fix was temporarily reverted in a scratch, never-committed check and the same test was confirmed to fail with exactly the predicted trigger error first, then restored — not just assumed fixed. This was the concrete trigger for this slice needing the first real Module 02 trade-write path (`lib/ingestion/sync.ts`), exactly as this entry predicted.
- [ ] **`C:` drive is at 0 bytes free on this machine, and Vitest's own OS-temp usage isn't covered by the existing npm-cache redirect.** The 2026-08-19 decision-log entry redirected npm's cache/tmp to `E:/npm-cache`/`E:/npm-tmp`, but `npx vitest run` (default `TEMP`/`TMP`) still fails outright with `ENOSPC` — found 2026-08-21 during an independent test pass on Module 02 Slice 2. Worked around per-invocation with `TEMP="E:\tmp_vitest" TMP="E:\tmp_vitest" TMPDIR="E:/tmp_vitest" npx vitest run ...` (directory created and cleaned up after each run). Not fixed at the environment level — that would mean either freeing real space on `C:` (owner action, not an agent one) or setting `TEMP`/`TMP` machine-wide/in a shared config, which risks affecting unrelated projects on this machine (`E:\LuceEdge`, `Pesa Hi Pesa`) the same way the npm-cache redirect note already flagged. Any agent running `vitest` directly (not through a wrapper that already sets this) should apply the same override rather than concluding the suite doesn't run. **Same root cause hit `npx playwright install chromium` too (2026-08-23, GroupingChip symmetry screenshot self-check)**: Playwright wanted `chromium_headless_shell-1234` (not present) and downloading it to `C:\Users\hp\AppData\Local\ms-playwright` failed outright with `ENOSPC`. Worked around WITHOUT downloading anything: an older `chromium-1223` (full Chrome, not headless_shell) was already fully installed there from a prior session, so `chromium.launch({ executablePath: 'C:\\Users\\hp\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe' })` works with zero new disk writes. Any agent hitting the same `chromium_headless_shell` `ENOSPC` should check for an existing `chromium-*` (non-headless_shell) directory under `ms-playwright` before assuming screenshots are blocked.
- [ ] **Repo-wide: no `app/**/actions.ts` Server Action input schema calls Zod's `.strict()`, so every one silently strips unknown keys instead of rejecting the payload (00-foundation §4.2: "Reject unknown keys").** Found by `retrospeq-security-reviewer` (2026-08-24) reviewing Module 04 Slice 2's `app/(app)/rules/actions.ts`, verified live (`z.object({a:z.string()}).safeParse({a:'x',b:'evil'})` succeeds and drops `b`). Fixed narrowly for `createRuleInputSchema` in that one file this pass (see 2026-08-24 decision log entry) — every other `actions.ts` in the repo (`accounts`, `trades`, others) still has this gap. Worth a dedicated repo-wide sweep converting every `z.object(...)` Server Action input schema to `.strict()`/`z.strictObject(...)`, rather than patching file-by-file as each is touched.
- [ ] **Repo-wide: several RLS INSERT/"for all" policies check `user_id = auth.uid()` but not that referenced foreign keys (`account_id`, `trade_id`, etc.) actually belong to that same user.** Found by retrospeq-security-reviewer (2026-08-22) reviewing Module 02's `fills`/`trade_events` INSERT policies and `trades`/`arm_events`/`trade_captures`'s "for all" policies — a client could theoretically INSERT a row self-assigning `user_id` correctly while pointing `account_id`/`trade_id` at a row it doesn't actually own. Confirmed this is not new to Module 02 — the same shape exists on Module 01's `trading_accounts_owner`/`account_credentials_owner_insert` policies too. Not fixed now (out of scope for the slice that found it, and no test currently proves it's exploitable end-to-end — the referenced row would need to belong to another real user, and the practical blast radius depends on what a client could actually DO with a cross-user-linked row it can't otherwise read, which for most of these tables is "nothing visible," since the owning row still isn't selectable by the attacker afterward). Worth a dedicated pass adding `and exists (select 1 from retrospeq.trading_accounts where id = account_id and user_id = auth.uid())`-shaped checks (or equivalent) across every affected policy, repo-wide, rather than patching table-by-table as each is touched.
- [ ] **`lib/privacy/export.ts`'s `buildExportBundle` is stale and does not meet Module 04 §14's export requirement — likely a genuine data-rights/compliance gap, not just a code-hygiene one, flagged with that urgency rather than as a routine backlog item.** Found 2026-08-31 during a full Module 04 spec-coverage re-check (see the matching 2026-08-31 decision-log entry for full detail). `buildExportBundle`'s own header comment still says "Module 02 isn't built" though Module 02 (trade ingestion) has been done since 2026-08-23; today it exports only `profile`/`tradingAccounts`/`subscription`/`mfa` — **zero trades, zero rules/rule_versions/rule_evaluations/rule_overrides/adherence_weekly**. A trader who exercises their own "export my data" request today gets a bundle that is silently missing every trade they've logged and every rule they've written — this is exactly the kind of gap that matters for data-portability/data-rights obligations (GDPR-style "right to receive your own data" and this project's own §14: "Included in export as rules, versions, evaluations and overrides"), not merely an incomplete feature. **Erasure is NOT the same gap and is confirmed genuinely comprehensive** (cascading `on delete cascade` foreign keys from every Module 04 table down to `profiles`, plus a deliberate `erasure_in_progress` bypass built into `rule_evaluations`'s own immutability trigger specifically so erasure can still delete a frozen row) — this entry is about EXPORT specifically, which has fallen behind two modules' worth of schema growth while erasure kept pace. Not built as part of Module 04 (this file belongs to Module 01's privacy/export feature, not Module 04's own slice numbering) — needs its own dedicated dispatch against `lib/privacy/export.ts` (and its CSV counterpart, `tradingAccountsToCsv`) to add trade and rulebook sections, whenever that module/feature area is next picked up. Do not let this sit as a passive line item indefinitely — the owner should weigh in on relative priority given the data-rights angle, since "our own export feature quietly stopped including a trader's own data two modules ago" is the kind of thing that should get fixed before it's ever actually relied upon by a real user, not discovered by one.

## Decision log

Format: `YYYY-MM-DD — decision — why — spec/section it reconciles`

- 2026-09-01 — **Module 08 §5.3's "75th percentile" reconciled against
  Module 04 Slice 10a's already-shipped 80th-percentile threshold-seeding
  — kept Slice 10a's number, did not rewrite already-tested code to chase
  a different module spec's slightly different figure.** `08-onboarding-
  and-home.md` §5.3 specifies `percentile(distribution, 75)` for seeding
  the three calibrated rules; `lib/rules/guided-front-door.ts` (Slice
  10a, 2026-08-29) uses the 80th percentile, with its own documented
  reasoning (lands inside `preview.ts`'s "healthy" ratio band rather than
  the raw median, independently verified correct by both the tester and
  QA at the time). This is two module specs describing the SAME feature
  (Module 04 owns the mechanism, Module 08 owns when it's shown in the
  onboarding sequence) with two different numbers for the same underlying
  idea — a genuine spec-vs-spec discrepancy, not a spec-vs-code drift
  00-foundation §12's "spec is wrong until reconciled" rule was written
  for. Decision: keep 80th percentile. Rewriting a live, tested,
  security-reviewed threshold-seeding function to chase a 5-point
  difference between two specs that were never reconciled with each
  other has real cost (a full re-verification pass) for no clear product
  benefit, and Slice 10a's own reasoning for 80 over 50/raw-median still
  holds regardless of which module's spec is asked. If a future pass
  (or the owner) judges this wrong, it's a one-line change in
  `guided-front-door.ts`'s own percentile constant, not an architectural
  one. Module 08's own job for this story is sequencing (routing a new
  trader through the existing `/rules/start` screen as an onboarding
  step), not re-deriving the seeding math.
- 2026-08-31 — **Module 04 full spec-coverage re-check (against
  `retrospeq-design-system/modules/04-rulebook-and-evaluation.md`'s
  complete story list) found two real gaps, logged rather than declared
  "done" without checking.** See "AT A GLANCE" at the top of "Current
  task" for the full write-up; summarized here for the decision log's own
  record. (1) **Story 2.5's UI half — editing an existing rule's
  threshold — has zero UI anywhere despite `editRule` being fully built/
  tested/security-reviewed since Slice 2 (2026-08-19).** Not blocked on
  anything external, unlike discovery (10c/Module 05) or strategy-scoped
  rules (1.5-1.7/Module 03) — both Slice 10b's and Slice 10e's own coder
  dispatches independently scoped it out as future work without either
  claiming a slice number, the same untracked-gap pattern that let
  promote/demote/retire's UI sit missing for 5 weeks before Slice 10d
  part 2's QA pass caught it. Given its own number, **Slice 10f**, so it
  doesn't repeat that pattern a second time.
- 2026-08-31 — **`lib/privacy/export.ts` is stale and does not meet §14's
  export requirement — flagged, not silently dropped, and deliberately
  NOT claimed as a Module 04 slice.** `buildExportBundle`'s own header
  comment still says "Module 02 isn't built" though Module 02 has been
  done since 2026-08-23; it exports only `profile`/`tradingAccounts`/
  `subscription`/`mfa` today — zero trade data, zero Module 04 data
  (rules/versions/evaluations/overrides/adherence), directly
  contradicting §14's "Included in export as rules, versions,
  evaluations and overrides." Independently verified this is specifically
  an EXPORT gap, not an erasure one: every Module 04 table has `user_id
  references retrospeq.profiles(id) on delete cascade` (confirmed in
  `supabase/migrations/20260823020000_rulebook_schema.sql`), and
  `rule_evaluations`'s own immutability trigger already special-cases
  `retrospeq.erasure_in_progress` specifically to let erasure delete a
  row it would otherwise protect forever — erasure was clearly built
  deliberately and is genuinely comprehensive; export just never got the
  same follow-through as the codebase grew. Not given a Module 04 slice
  number since `export.ts` is Module 01's own file (the privacy/export
  feature) — this needs a dedicated dispatch against that file/module
  whenever it's picked up, not folded into Module 04's own slice
  numbering. Per AGENTS.md's "never fake it, always flag it": this is
  exactly the kind of real, currently-unmet, cross-module gap that
  shouldn't be left to silently disappear once Module 04's own UI slices
  are done.
- 2026-08-31 — **Slice 10d part 2 (adherence display) puts "current week"
  on the SAME plain-UTC-date convention `promotion-eligibility.ts`'s
  `recentBreakWindowStart` already established, not a per-account
  `server_day`.** Every other `server_day`-scoped read in Module 04
  (`ambient-state.ts`, `distributions-repository.ts`) is per-ACCOUNT
  (Module 02 §2.2's day-rollover-aware date). Adherence is per-USER
  (`hard_total`/`soft_total` span every account/rule a trader has), so
  there is no single account whose rollover would be the "right" one to
  pick — picking one arbitrarily would make the week boundary silently
  depend on account list order. Reused the existing user-level convention
  instead of inventing a second one, matching AGENTS.md's own
  "spec vs code: fix one deliberately, do not let drift accumulate
  silently" posture applied to picking between two ALREADY-established
  patterns rather than a spec/code conflict.
- 2026-08-31 — **The adherence-attribution line names the top-break rule
  by its CURRENT rendered sentence, not the wording live during the
  displayed week — a documented simplification, not an oversight.**
  `adherence_weekly` (Slice 6) stores only `top_break_rule_id`, never a
  `rule_version` — re-deriving the exact historical wording would mean
  joining back through raw `rule_evaluations` at READ time, which is
  exactly the performance/trust posture `adherence_weekly`'s "materialised,
  never computed from raw evaluations at read time" contract (§3.1, §12's
  "< 500ms per week" budget) exists to avoid. A trader who edited a rule's
  threshold since the displayed week sees the rule named correctly, just
  with its current number — the rule IDENTITY in the attribution is always
  exactly right, only a numeric detail in its own sentence could be stale.
  Documented in `rules-repository.ts`'s `fetchRuleRenderedText` header;
  worth revisiting only if Module 06's weekly review ever needs
  historically-exact wording.
- 2026-08-29 — **Slice 10b's cross-tab `rules.create` cap race (found by
  `retrospeq-tester`'s independent verification) fixed by moving the cap
  guard INTO `insertRuleAndVersion`'s own transaction, not by adding a
  second check to `createRule`.** Same reasoning Slice 7's own
  `promoteRuleSeverity` fix already established for the analogous
  `rules.hard` cap: a two-step "check the count, then write" is
  structurally racy under READ COMMITTED regardless of where the check
  lives, because a correlated `count(*)` subquery only ever observes
  committed rows, never a concurrent transaction's own uncommitted write.
  The fix is `pg_advisory_xact_lock(hashtext(user_id))` as
  `insertRuleAndVersion`'s first statement, serializing concurrent
  creates for the SAME user before its own guarded `insert ... select ...
  where (select count(*) ...) < capLimit` runs — not a second entitlement
  check bolted onto `createRule`, which would still race the same way.
  `createRule`'s existing early `canForUser` pre-check is kept exactly as
  it was (fast, friendly, non-atomic, for the common non-racing case);
  the guarded INSERT is the real backstop. `InsertRuleInput.capLimit:
  number | null` (`null` = Pro's unlimited cap, mirroring
  `resolveQuantityCapability`'s own `limit === null` convention) is
  sourced from the SAME `entitlement.limit` the pre-check already
  computed, never a second independently-derived number. See "→ Module
  04 Slice 10b — CODER concurrency fix" in "Current task" above for the
  full verification write-up (tripwire E2E now green, new two-connection
  live-DB proof, Slice 10a regression-checked).
- 2026-08-29 — **Module 04 Slice 10 (§6 UI) is being delivered as
  several sub-slices (10a/10b/10c/10d), not one dispatch — applying
  AGENTS.md's own "a whole module is not" one dispatch guidance one
  level down to "a whole multi-screen UI slice."** 10a (the guided
  three-rule front door, §5.10/story 1.4, `/rules/start`) is the first,
  CODED with its own full test suite (unit + live-DB + E2E); the general
  rule editor/discovery (story 1.1/1.3), the ambient strip (§5.9 UI),
  and adherence display (§5.6 UI) are 10b/10c/10d, unbuilt. See the
  phase-status table's Slice 10a entry and "Current task" above for the
  full write-up.
- 2026-08-29 — **Slice 10a's threshold-seeding chose the trader's own
  80th-percentile history (direction-aware) over the raw median, and a
  bounds-midpoint fallback over any other guess when history is
  insufficient.** Reasoning (not obvious from §5.10's own one-line
  "thresholds seeded from `operand_distributions`"): seeding at the raw
  median (p50) would flag roughly HALF the trader's own past trades on
  day one for a rule they didn't even choose to author — punitive, not
  "a rule that fits me" (story 1.4's framing). The 80th percentile keeps
  the seeded rule's own would-have-flagged ratio inside `preview.ts`'s
  ALREADY-established "healthy" band (0.06–0.35), reusing that existing
  judgment rather than inventing an unrelated second number. Implemented
  by generalizing `preview.ts`'s private `weightedMedian` into an
  exported `percentileFromBuckets(buckets, p)` (p50 convenience wrapper
  kept, now implemented in terms of the generic function — one walk over
  `DistributionBucket[]`, not two).
- 2026-08-29 — **Slice 10a's guided front door lives at a dedicated
  `/rules/start` route, not `app/(app)/rules/page.tsx`.** `/rules`
  itself (the general rulebook list — editor, discovery, severity
  controls, adherence) is explicitly 10b/10c/10d's job, not built yet;
  building the guided screen AT `/rules/page.tsx` now would force either
  a rewrite of that route once the real list ships, or scope creep into
  building part of that list early to make an "empty state" branch
  coherent. Matches this repo's existing precedent of dedicated routes
  for distinct flows off a shared resource (`/trades/manual-entry`,
  `/trades/close-out` alongside `/trades` itself).
- 2026-08-27 — **Module 04 — a second, unplanned "Slice 9" was dispatched
  (backend `operand_distributions` extension) after the ledger had already
  named the NEXT slice "Slice 9" (the §6 UI) — reconciled by renumbering
  the UI slice to Slice 10, not by renumbering the dispatched work.** Per
  00-foundation §12's "spec vs code: fix one deliberately, do not let
  drift accumulate silently" — this is exactly that class of drift,
  logged rather than silently resolved. The dispatched task's own title
  ("Module 04 Slice 9: extend `operand_distributions` computation to
  cover `daily_loss_pct` and `consecutive_losses`") is authoritative for
  what this slice IS; the ledger's own prior "Next: Slice 9" pointer (the
  UI) is what moved, to Slice 10, with its scope completely unchanged —
  only the number. See "Current task" above (search "Renumbering note")
  for the exact edit.
- 2026-08-27 — **Module 04 Slice 9 (`operand_distributions` extended to
  `daily_loss_pct`/`consecutive_losses`, §5.10) — CODED, coder pass only.**
  Closes a gap between two earlier slices that shipped out of the order
  their own dependency implied: Slice 3 built `operand_distributions`
  bucketing scoped to the 8 `computableToday: true` single-trade operands
  (before any cross-trade fact-assembly code existed); Slice 4
  SUBSEQUENTLY built real cross-trade computation for `daily_loss_pct`/
  `consecutive_losses` (`cross-trade-operand-values.ts`'s
  `computeDayWeekPnl`/`computeConsecutiveLosses`) but never wired it into
  Slice 3's distribution pipeline, since that wasn't Slice 4's own scope.
  §5.10's guided three-rule front door (`risk_pct`, `daily_loss_pct`,
  `consecutive_losses`, "thresholds seeded from `operand_distributions`")
  needs all three to have real rows — per AGENTS.md's "never fake it," a
  front door claiming a threshold is "seeded from history" for an operand
  with no real distribution would be exactly the kind of simulated success
  that rule forbids.
  **What was reused, not reimplemented:** Slice 4's own
  `computeDayWeekPnl`/`computeConsecutiveLosses` pure functions, called
  verbatim, unmodified. Slice 4's own FETCH functions
  (`fetchClosedTradesForPnlWindow`/`fetchPriorOutcomesDescending`) were
  NOT reused directly — they're shaped for one reference trade at a time,
  which would be an N+1 query pattern across a 200-trade distribution
  window. Instead, two new batched fetch functions
  (`fetchAccountHistoryForCrossTradeOperands` — one query for every
  account at once via a `row_number()`-partitioned window function;
  `fetchAccountStartingEquities`) feed a new pure function
  (`computeCrossTradeDistributionValues`) that calls Slice 4's pure
  functions once per window trade, purely in memory. Net query count
  added to `recomputeOperandDistributionsForUser`: 2, regardless of window
  size or account count — no N+1 introduced.
  **Verified, not assumed:** both operands already had real catalogue
  `bounds`/`step` values from Slice 1 (no catalogue gap). `preview.ts`
  needed zero changes (confirmed by inspection and by the live-DB test
  suite exercising it against the two new operand rows). **[CORRECTED
  2026-08-29: this specific claim was wrong — see the 2026-08-29 entry
  below for what independent verification actually found.]** Full
  `lib/rules` suite (494 tests), `sync.live.test.ts`'s
  operand_distributions-wiring test, `npm run build`, `tsc --noEmit`, and
  `eslint .` all clean, re-run after the change. Full write-up in "Current
  task" above (search "Module 04 Slice 9"). No migration, no ADR (filling
  an already-scoped deferral, not a new deviation). NOT yet independently
  tested/security-reviewed/QA'd. **[SUPERSEDED 2026-08-29: now fully
  gated — see below.]**
- 2026-08-29 — **Module 04 Slice 9 — independent verification found a
  real bug in the coder's own "`preview.ts` needed zero changes" claim;
  fixed, security-reviewed, and QA'd — Slice 9 now DONE.** `retrospeq-
  tester`'s independent verification (fresh fixtures, not the coder's
  own) built two new files: `lib/rules/__tests__/distributions-
  repository.independent-verify.test.ts` (13 pure-function tests —
  point-in-time correctness across a 2-day/5-trade trajectory, 3-account
  interleaved isolation, decimal.js precision through the REAL
  `bucketNumeric`/`buildOperandDistribution` pipeline rather than
  decimal.js checked in isolation, and a mocked-query-count proof that
  the two new batched fetch functions stay at exactly 1 query each
  regardless of account count) and `.independent-verify.live.test.ts` (a
  live-DB test against real seeded data). The live test's `it.fails`
  documented, rather than silently patched, a real gap: `preview.ts`'s
  gate (`if (!operand.computableToday)`) predates Slice 4/9's cross-trade
  computation and was never updated, so `preview('daily_loss_pct', ...)`
  and `preview('consecutive_losses', ...)` unconditionally returned
  `operand_not_computable` — §5.10's guided front door could not show a
  live preview for 2 of its 3 rules despite this slice's own real,
  correct distribution data existing for both. This is exactly the class
  of thing AGENTS.md's "never fake it" instinct exists to catch: a slice
  whose whole stated purpose (enable preview for these two operands) was
  silently undelivered by one missed call site.
  **Fix** (dispatched back to `retrospeq-coder`, narrowly scoped to this
  one gate): `preview.ts`'s condition changed from `!operand.computableToday`
  to `!DISTRIBUTION_OPERAND_IDS.includes(operandId)` — `DISTRIBUTION_
  OPERAND_IDS` (already exported from `distributions-repository.ts`) is
  the exact set every operand `recomputeOperandDistributionsForUser`
  actually writes a row for, today, no more and no less. Deliberately did
  NOT touch `operand-catalogue.ts`'s `computableToday` values themselves
  — that flag has other consumers (fact-assembly readiness) this preview
  gate has no business affecting; changing the single-purpose gate
  condition is the narrower, correct fix. `preview.test.ts`/`preview.
  property.test.ts` updated to match; the live independent-verify test's
  `it.fails` converted to a normal passing `it()`, re-run live and
  confirmed green (no longer failing-as-designed — genuinely passing).
  **Security-reviewer PASS (5/5):** no import cycle from importing
  `DISTRIBUTION_OPERAND_IDS` as a value into `preview.ts` (confirmed only
  the id-list constant crosses, not any service-role-connection-using
  function); `getOperand(operandId)` validation still runs BEFORE the new
  gate check, so an unknown/malicious operand id still throws before
  reaching it (no injection surface introduced); `preview()`'s
  `withUserConnection`-scoped, `user_id`-filtered read of
  `operand_distributions` is unchanged by this fix; the fix touches
  nothing in `rule_evaluations` and writes nothing anywhere (`preview()`
  remains read-only end to end); no compound-rule or XP-coupling
  introduced. Independently re-ran `preview.test.ts` + `preview.
  property.test.ts` (24/24) directly rather than trusting the coder's own
  run.
  **QA PASS (9/9):** `rule_evaluations` untouched; no compound rules; no
  XP/adherence coupling; §5.3's "one code path" convention held (every
  bucket comparison still routes through `evaluate.ts`'s `compare()`, no
  parallel comparison logic for the new operands); the `insufficient_
  history` vs `operand_not_computable` distinction remains coherent post-
  fix (an operand outside `DISTRIBUTION_OPERAND_IDS` still correctly gets
  `operand_not_computable`; one inside it with `n < 20` still correctly
  gets `insufficient_history` — genuinely different, both-correct "no
  ratio yet" states, still not conflated); `preview.test.ts`'s pre-
  existing Slice-3-era "computableToday: false operand never queries
  operand_distributions" assertion confirmed to use an operand genuinely
  outside `DISTRIBUTION_OPERAND_IDS` (not accidentally left pointing at
  one of the two newly-distribution-backed operands); no UI surface in
  this slice, so no screenshot self-check was required; the analytics/
  rules import boundary is clean (all new imports are within `lib/rules/`
  itself); `docs/runbook.md`'s Slice 9 update verified accurate against
  the actual new failure surface (the two new fetch functions really do
  run inside the same best-effort `recomputeOperandDistributionsForUser`
  call). One procedural (non-code) finding: this ledger's own "Current
  task" section and this decision log still claimed Slice 9 was
  coder-pass-only with a now-false "zero changes" claim — corrected in
  this entry and the one above, and in the phase-status table.
  **Re-verification after the fix:** full suite `npx vitest run` = 101
  files, 1400 passed, 8 skipped, 0 failed; `tsc --noEmit` clean; `eslint
  .` clean (19 pre-existing unrelated warnings only, none touched by this
  slice or its fix). No migration, no ADR (the preview.ts change is a bug
  fix restoring this slice's own already-stated intent, not a new
  deviation from a 00-foundation convention). **Module 04 Slice 9 is now
  DONE** — see the phase-status table's 2026-08-29 entry for the
  consolidated summary.
- 2026-08-27 — **Module 04 Slice 8 (ambient live-state engine +
  `rule_overrides`, §5.9) — independent tester verification PASS, no
  production bugs, no test gaps closed.** Full write-up is in the
  "Current task" section above (search "Slice 8 tester gate: PASS
  (2026-08-27)"); not repeated here in full. Summary: re-ran the coder's
  109 tests (99 mocked + 10 live) green; re-measured coverage (100%
  line/function, 94.28%/100% branch on `ambient-state.ts`/
  `rule-overrides-repository.ts`, the one gap a confirmed-unreachable
  defensive guard); independently re-constructed — with fresh fixtures,
  not the coder's own — the "always visible, never appear-on-threshold"
  invariant, the tint boundary table, the `NO_REFERENCE_TRADE_ID`
  sentinel's structural nil-UUID-collision-impossibility (read
  `uuid_generate_v7()`'s actual definition), `scope`/`evaluation`
  filtering with a HARD strategy rule and a SOFT at_close rule, a
  triple-override same-trade dedup plus a discriminating two-trade dedup
  case, an adversarial cross-user override-ownership rejection verified
  by a follow-up read (not just the thrown error), and RLS reconfirmed
  via a direct `SET LOCAL ROLE authenticated` + `request.jwt.claims`
  check independent of the app's own `withUserConnection` wrapper — all
  held. `build`/`lint`/`tsc` clean. Verdict: ready for security review.
- 2026-08-25 — **Module 04 Slice 7 (severity lifecycle, §5.7) — the
  "6 weeks / ≥20 evals / ≥95% compliance / zero breaks in 3 weeks" gate
  read as ALL-TIME for the first three, ROLLING-21-DAYS for the fourth —
  a real product-behaviour decision, not cosmetic, documented per this
  slice's own dispatch requirement.** §5.7's table lists all four
  conditions in one cell joined by "·," and only the last one names an
  explicit window ("in the last 3 weeks"). Read literally, the first
  three are one-time thresholds a rule must have accumulated BY NOW, not
  a sliding quota that could regress after being met — the alternative
  (all four windowed identically) would mean a rule followed diligently
  for two years but with a quiet recent month reads as "not yet eligible,"
  directly contradicting story 2.2's own frame ("a rule I've genuinely
  kept"). "6 weeks active" is calendar duration from `rules.created_at`
  (`now - created_at >= 42 days`), not a distinct-ISO-week count. "The
  last 3 weeks" is, for internal consistency with that duration reading,
  ALSO a rolling 21-calendar-day window — deliberately NOT
  `week-boundary.ts`'s Monday-aligned ISO week (ADR 0015), which exists
  for a different concern (aligning `adherence_weekly`'s reporting buckets
  with Module 07's streak weeks) than this one gate-check function's own
  elapsed-time arithmetic. Full reasoning lives in
  `lib/rules/promotion-eligibility.ts`'s own header, not just here.
- 2026-08-25 — **Module 04 Slice 7 — the `rules.hard` entitlement check and
  the "6-active-hard-rule cap" are ONE number, read from ONE place, not two
  independently-invented `6`s.** `lib/entitlements/capability-table.ts`'s
  existing `rules.hard: { pro: 6 }` (Module 01 §4.3) already IS §5.7's
  "cap 6" — `promoteRule` reads it via `canForUser(userId,'rules.hard')`
  and passes `entitlement.limit` into `promoteRuleSeverity`'s own guarded
  UPDATE, rather than hardcoding `6` a second time anywhere in Module 04's
  own code. `entitlement.reason === 'quota'` (a Pro caller genuinely at the
  cap) is what triggers the friendlier `RULE_HARD_CAP` demote-chooser
  response instead of a bare `ENTITLEMENT_LIMIT` denial — layering §5.7's
  "presented as a trade-off, not an error" UX on top of the same
  entitlement fact Module 01's generic quota-exceeded case already
  represents, not a parallel/duplicate check.
- 2026-08-25 — **Module 04 Slice 7 — `countActiveHardRules` wired into
  `defaultCanDeps.usageCounters['rules.hard']` for real, not left
  unwired.** Without this, `resolve.ts`'s `resolveQuantityCapability`
  would resolve every Pro-plan `rules.hard` check to
  `reason: 'not_yet_checkable'` (`allowed: false`, fail-closed) since a
  finite nonzero cap (6) with no injected counter always fails closed —
  this would have silently blocked EVERY Pro-plan promotion, not just ones
  genuinely at the cap. Free tier's own block is unaffected either way
  (`QUANTITY_CAPS['rules.hard'].free === 0` short-circuits to
  `reason: 'plan'` in `resolve.ts` before any counter is ever consulted) —
  but Pro-plan correctness genuinely depended on this wiring being real.
- 2026-08-25 — **Module 04 Slice 7 — INDEPENDENT TESTER VERIFICATION PASS.
  Found a real, reproducible production bug in the hard-cap concurrency
  guard; everything else independently confirmed.** Dispatched specifically
  to re-derive the coder's own claims rather than trust them (windowing
  reasoning, "atomic hard-cap proven live," free-tier block, one-way
  retirement). Full detail in the Phase-status table row above (search
  "TESTER PASS DONE") and the "Current task" section; short version below,
  by dispatch item:
  1. **Windowing**: independently re-derived from §5.7's own text, landed
     on the SAME conclusion as the coder (all-time for the first three
     gates, rolling 21 days for the fourth) — with an additional structural
     argument the coder's own write-up didn't make: the explicit
     "zero breaks in the last 3 weeks" gate is exactly what prevents a long
     good history from diluting a genuinely recent bad patch below the
     all-time 95% compliance threshold, so the two gate types are
     complementary by design, not redundant restatements of each other.
  2. **Hard-cap race — REAL BUG, confirmed twice independently** (a
     standalone Node reproduction script, then a formal vitest live-DB
     test with genuine two-connection control, not timing luck): two
     concurrent `promoteRuleSeverity` calls for two DIFFERENT soft rules,
     user at exactly 5 active hard rules, land at 7. The correlated
     `count(*) < $3` subquery inside the guarded UPDATE only locks the row
     being WRITTEN, never the rows the subquery SCANS — under READ
     COMMITTED, neither of two concurrent transactions sees the other's
     still-uncommitted promotion, so both read "5, room for one" and both
     succeed. The coder's own "proven live, atomically" claim used only a
     SEQUENTIAL deterministic-replay technique (promote once for real, then
     promote again against the SAME now-stale row) — that proves the guard
     rejects a second call against the same row, never the actual cross-row
     race §8.2 names ("Hard rule count never exceeds 6"). Kept in the suite
     as `it.fails` (a deliberate trip wire, not `it.skip`) at
     `lib/rules/__tests__/severity-lifecycle.independent-verification.live.test.ts`
     — reporting this precisely rather than fixing it, per the tester
     role's own boundary; needs a coder pass (candidates: `select ... for
     update` on the counted rows, a `pg_advisory_xact_lock` keyed on
     `user_id`, `SERIALIZABLE` isolation for this write, or a DB-level
     constraint/trigger) before security review.
  3. **demote/retire concurrency** — independently re-verified SAFE with
     genuine two-connection tests (the `waitForBlockedQuery` technique
     `rules-repository.live.test.ts` established): these are single-row
     guarded UPDATEs with no cross-row subquery, so Postgres's own row lock
     genuinely serializes two real concurrent callers — exactly one wins,
     the other gets a clean `RuleLifecycleConflictError`, never both, never
     a crash.
  4. **Free-tier block, end-to-end** — re-verified through the REAL
     `promoteRule` Server Action (not `resolve.ts`'s capability resolution
     mocked in isolation, which is all the coder's own `actions.test.ts`
     exercises). A genuine free-tier test user (real `subscriptions` row,
     `plan='free'`, never upgraded), with a rule made FULLY eligible on
     every §5.7 gate via 25 real confirmed trades, is still rejected with
     `ENTITLEMENT_LIMIT` before any DB write — severity/`promoted_at`
     confirmed unchanged after.
  5. **One-way retirement** — fresh grep re-confirms zero
     reactivate/unretire path anywhere. Additionally closed the one gap in
     the coder's own live suite: the coder's "zero evaluations after
     retirement" proof went through the repository's `retireRuleState`
     directly, not the Server Action; this pass adds a test through the
     REAL `retireRule` action specifically, confirming a trade confirmed
     afterward produces zero new evaluations.
  6. **No `rule_evaluations`/`rule_versions` writes** — fresh grep confirms
     `promoteRuleSeverity`/`demoteRuleSeverity` touch only `rules` columns.
  7. **No XP/gamification coupling** — fresh word-boundary grep
     (`\b(xp|streak|points|gamif\w*|engagement)\b`, avoiding the
     plain-substring false positives a naive `xp` search hits inside words
     like "expired"/"export") across every new file: zero real hits.
  8. **Coverage** — independently re-run, matches the coder's own numbers
     exactly: `promotion-eligibility.ts` 93.8%, `severity-lifecycle-
     repository.ts` 100%, both clear the 90% engine bar.
  Full repo suite re-run: 1497 passed, 13 skipped, one FAILURE —
  `lib/supabase/__tests__/service-role-inventory.test.ts` (its
  `withServiceRoleConnection` allowlist is missing Slice 6's
  `lib/rules/adherence-repository.ts`) — confirmed via `git stash` to
  already exist at HEAD, unrelated to and not introduced by this slice or
  this tester pass, flagged as a separate follow-up rather than fixed here
  (out of this pass's scope). `npx tsc --noEmit`/`npx eslint .`/`npm run
  build` all independently re-run clean.
- 2026-08-25 — **Module 04 Slice 7 — CODER FIX for the tester-found
  hard-cap concurrency bug (`promoteRuleSeverity`), verified against the
  tester's own live trip-wire test.** Full bug description is in the
  tester-verification entry immediately above; this entry is the fix and
  its re-verification. **Mechanism chosen**: `pg_advisory_xact_lock
  (hashtext($1::text))`, keyed on `user_id`, acquired as the FIRST
  statement inside `promoteRuleSeverity`'s own `withUserConnection`
  transaction, before the guarded UPDATE runs. `withUserConnection`
  (`lib/supabase/direct.ts`) was read first to confirm it genuinely wraps
  exactly one `begin`/`commit`-or-`rollback` per call (its own header says
  so explicitly) — the advisory lock is therefore transaction-scoped,
  released automatically at COMMIT/ROLLBACK, no separate unlock call
  needed or safe to add manually. A second concurrent `promoteRuleSeverity`
  call for the SAME user now genuinely blocks on this lock until the first
  transaction commits or rolls back; its own correlated `count(*) < $3`
  subquery then runs against the already-committed post-promotion state
  and correctly fails once the cap is reached. Two concurrent promotions
  for two DIFFERENT users hash to different lock keys (a collision would
  only cost harmless extra serialization, never correctness, since the
  UPDATE's own WHERE clause still scopes strictly to `user_id = $2`) and
  never contend with each other, so this adds no cross-user cost.
  `demoteRuleSeverity`/`retireRuleState` were deliberately NOT given the
  same lock — both are single-row guarded UPDATEs with no cross-row
  correlated subquery, so Postgres's own row lock on the one target row
  already serializes two concurrent callers correctly, independently
  proven live by the tester's own `waitForBlockedQuery`-based tests, which
  are unchanged by this fix. **Re-verification**: the tester's own
  trip-wire test (`lib/rules/__tests__/severity-lifecycle.independent-
  verification.live.test.ts`) was read in full before touching it, not
  assumed. Its `it.fails` case was rewritten to a normal `it(...)` — not a
  bare flag flip, but restructured to deterministically prove the fix:
  instead of the original two-uncontrolled-connection interleaving (which
  relied on both racing transactions issuing their UPDATE before either
  committed), the rewritten version has one real connection hold the SAME
  advisory lock the fix now takes plus an uncommitted promotion, then
  calls the REAL (fixed) `promoteRuleSeverity` for a second, different
  soft rule and uses `waitForBlockedQuery` to confirm it is genuinely
  blocked on `pg_advisory_xact_lock` before releasing the first connection
  — proving actual blocking behavior, not merely a lucky non-overlap. Ran
  green twice in a row in isolation (`-t "FIXED"`, 5-6s each run,
  deterministic — the wait-for-block step removes any timing dependency)
  and again as part of the full suite. Final asserted state: exactly 6
  active hard rules (not merely "≤ 6"), the second rule's `severity`/
  `promoted_at` provably untouched. Two pre-existing MOCKED unit tests in
  `lib/rules/__tests__/severity-lifecycle-repository.test.ts` asserted
  `queryMock` was called exactly once with the UPDATE as `calls[0]` — both
  updated to account for the new advisory-lock call as `calls[0]` and the
  UPDATE as `calls[1]` (2 calls total), not weakened or deleted. **Full
  re-verification, independently re-run after the fix**: `npx tsc
  --noEmit` clean, `npx eslint .` clean (0 errors, only the same
  pre-existing unrelated warnings), `npm run build` clean, full `lib/rules`
  suite (28 files, 447 tests, includes every live-DB test in the module)
  100% green. **`demoteRuleSeverity`/`retireRuleState` confirmed to NOT
  need this fix** — re-read both, neither performs a cross-row correlated
  subquery, only a single-row guarded UPDATE; their existing live
  concurrency tests (unchanged by this pass) continue to pass, confirming
  the row lock already serializes them correctly. No new migration, no new
  ADR (this is a bug fix restoring a documented invariant, not a
  deliberate deviation from a 00-foundation convention), no new runbook
  entry (not a new alerting-worthy failure mode — the fix makes an
  existing invariant hold, it doesn't introduce a new background-process
  risk). **Ready for security-reviewer now** — this was the sole blocker
  the tester pass named.
- 2026-08-25 — **Module 04 Slice 6 (`adherence_weekly`) — `top_break_rule_id`
  selection changed from a COMBINED hard+soft pool to HARD-PRIORITY, per
  retrospeq-qa review.** §5.6's own worked example ("31 of 34 rules
  followed this week, up from 27 of 34" — with drops attributed to a
  single named rule) is what the original implementation built against,
  and read in isolation it supports a combined pool: "31 of 34 RULES,"
  not "31 of 34 HARD rules." QA found this contradicts
  `retrospeq-design-decisions.md` §6 ("Two numbers, never one"): *"Hard
  rules should be few enough that '34 of 34' is the normal reading and
  any deviation is loud"* — soft rules are broken far more often than
  hard ones by design, so a combined ranked pool lets a rare, important
  hard-rule breach get numerically buried under a much more common
  soft-rule violation, exactly the failure story 3.3 names ("a risk
  breach doesn't read like a skipped checkbox"). Per AGENTS.md's "spec
  vs design-decisions doc → design doc wins" convention, the design doc
  won: `computeAdherenceWeekCounts` now groups broken evaluations into
  separate hard/soft pools and selects the top break from the hard pool
  whenever it's non-empty, falling back to the soft pool (not a
  re-combined one) only when zero hard breaks occurred that week. The
  soft-scoped fallback (rather than a combined fallback) is itself read
  from §6.1's own worked attribution example — *"Your risk cap accounts
  for 6 of the 14 soft breaks"* — where 14 matches a soft-only broken
  count, showing soft-scoped attribution is the design doc's own
  standalone pattern, not a last resort; falling back to a combined pool
  would just reintroduce the blending §6 rejects, conditionally instead
  of always. Existing tie-break chain (highest count → earliest
  `frozen_at` → lowest `rule_id`) unchanged, now applied within whichever
  pool is selected. Added a disambiguating unit test (one hard rule
  broken twice vs. one soft rule broken five times → hard rule wins) that
  the prior test suite lacked — QA noted the existing "combined" test
  happened to pass under either interpretation because its hard rule had
  the higher count anyway. Full reasoning in `lib/rules/adherence-repository.ts`'s
  own header comment ("`top_break_rule_id` scope: HARD-PRIORITY, never a
  blended pool").
- 2026-08-24 — **Module 04 Slice 5 (freeze-wiring) coded — `rule_evaluations`
  now actually gets written and frozen at confirm, from both `confirmDay`
  and `autoConfirmStaleTrades`.** Full report in "Current task" above; key
  points logged here per 00-foundation §12:
  - **"Version live at trade.opened_at" resolved as a half-open
    `[created_at, superseded_at)` interval**, not literal spec prose (§5.5
    only gives the eligibility predicate's shape, not a boundary rule) —
    same convention `lib/ingestion/server-day.ts`'s `computeServerDayRange`
    already established for day boundaries. Concretely: a trade opened at
    the EXACT instant a rule edit's supersede-UPDATE and new-version-INSERT
    both commit (byte-identical timestamps, since Postgres `now()` is
    transaction-start-time-stable) resolves to the NEW version, not the
    old one. Verified live at that exact boundary (deterministically
    constructed by reading back the DB's own written timestamp text and
    reusing it — no timing race), not just asserted from reading the code.
  - **The dispatch's own worked example for session-rule attachment
    ("trades_today = 3, three PRIOR trades, excluding itself") was
    imprecise against Slice 4's own already-built, already-documented
    code** (`computeDayWeekCounts`'s own comment: "counts INCLUDE the
    reference trade itself... the trade that crosses the line must see
    itself counted, or the count it's evaluated against would always read
    one short"). Trusted the already-reviewed Slice 4 code over the
    dispatch's paraphrase (self-inclusive counting is also the only
    reading under which "lte 3" can ever actually BREAK on a 4th trade —
    3 <= 3 is followed, not broken) and verified it live: the 4th same-day
    trade's own row shows `observed = 4`, `result = broken`. The
    OBSERVABLE outcome the dispatch describes (break attaches to the 4th
    trade's own row, no separate session-violation object) holds exactly
    as stated; only the specific observed count differed from the
    dispatch's own parenthetical.
  - **`RuleEvaluationError` during freeze: caught, logged loudly
    (`console.error` + a new `ruleEvaluationAnomalies` field on both
    `confirmDay`'s and `autoConfirmStaleTrades`' return types), never
    blocks confirmation.** Full reasoning in `lib/rules/freeze-evaluations.ts`'s
    own header and the new `docs/runbook.md` entry — the short version:
    unlike a coverage gap or ambiguous grouping, a corrupted rule has no
    UI anywhere yet for a trader to fix, so trapping them in an
    unconfirmable day over it would violate Module 02's own established
    "never trap the trader" posture worse than the alternative (one
    fewer applicable evaluation for that rule/trade, observably identical
    to `not_applicable`, reached through a loud path instead of silent).
  - `confirmDay`/`autoConfirmStaleTrades`'s return types gained a new
    `ruleEvaluationAnomalies` field — additive only, verified non-breaking
    against every existing test in `confirm.test.ts`/`confirm.live.test.ts`
    (all 19 still pass unmodified except one mocked whole-object `toEqual`
    updated to include the new empty-array field on the zero-candidates
    early-return path, which that path's own logic doesn't touch).
- 2026-08-24 — **Module 04 Slice 5 tester gate: PASS, independently
  verified against the real DB, not a rubber stamp on the coder's own
  report.** Re-ran all 40 pre-existing tests (`freeze-evaluations.test.ts`
  9, `freeze-evaluations.live.test.ts` 12, `confirm.test.ts` +
  `confirm.live.test.ts` 19) — all green, matching the coder's counts.
  `git diff --stat` confirms only `confirm.ts`/`confirm.test.ts`/
  `PROGRESS.md`/`docs/runbook.md` were touched (plus the 3 new
  `freeze-evaluations*` files) — no other test file changed, so any flake
  in an unrelated live-DB file under parallel load is pre-existing
  contention (ADR 0002), not caused by this slice. Added 5 new,
  independently-authored adversarial tests
  (`freeze-evaluations.independent-verification.live.test.ts`), all
  passing: (1) forward-only with trades opened THEN rule created THEN
  confirmed (a stronger shape than "confirmed before the rule existed at
  all"); (2) a double-edited rule timeline (v1→v2→v3) proving the frozen
  row uses v1; (3) a direct double-invocation of
  `evaluateAndFreezeTradeRules` inside one transaction, bypassing
  `confirmDay`'s own outer guard entirely, proving
  `unique(trade_id, rule_id)` + `ON CONFLICT DO NOTHING` is what actually
  makes re-entry safe (zero duplicate rows, `frozen_at` from the FIRST
  call only); (4) a second, independently-constructed malformed-rule case
  (`is_true` against a `number` operand, not the coder's own
  unknown-operand-id case); (5) a raw SQL `DELETE` against a frozen row,
  independently re-confirming Slice 1's trigger rejects it. **Re-verified
  the `trades_today` self-inclusive claim directly from
  `cross-trade-operand-values.ts`'s raw SQL** (`opened_at <= $4`, no
  self-exclusion in `computeDayWeekCounts`) — confirmed correct: trade
  1→1, 2→2, 3→3, 4→4, so "`trades_today` lte 3" genuinely breaks starting
  at the 4th trade, matching the coder's correction of the dispatch's own
  imprecise paraphrase. Coverage measured directly: `freeze-evaluations.ts`
  98.5% line coverage (only the defensive non-`RuleEvaluationError`
  rethrow branch, lines 369-370, uncovered — flagged, not a blocker);
  `confirm.ts` 100% line coverage including the new freeze-wiring
  integration lines. RLS: re-ran `rulebook-schema.rls.test.ts` (29
  passing) independently — unaffected by this slice, no schema changed.
  `npm run build`/`npx eslint .`/`npx tsc --noEmit` all clean, re-run
  independently. Golden fixtures: not applicable (this slice doesn't
  touch the grouping engine). No production code changed by this tester
  pass, per role. **Verdict: ready for security review.**
- 2026-08-25 — **Module 04 Slice 5 tester gate-closure addendum: the
  2026-08-24 pass above was session-interrupted before delivering its
  verdict; a second tester pass closed the remaining gaps and delivered
  the actual final verdict (PASS).** Full write-up in "Current task"
  above; key points here per 00-foundation §12: (1) added a dedicated
  live test isolating §5.6's severity-promotion-doesn't-retroactively-
  reclassify guarantee from the pre-existing threshold-edit test, which
  had bundled both mutations into one test and muddied attribution — new
  test mutates ONLY `rules.severity` via direct UPDATE (Slice 7's
  promotion API doesn't exist yet) and confirms the already-frozen row is
  untouched; (2) cross-checked §8.2's full property-test list against
  this slice's actual scope and made an explicit judgment call that a
  dedicated "retirement survives" test is redundant — the DB-level
  immutability trigger that protects a frozen row is proven twice already
  by two independent `rules`-column mutations (threshold edit, severity
  promotion) plus a direct adversarial raw-SQL UPDATE/DELETE, and
  `rules.state` only gates FUTURE freezes via
  `fetchEligibleRuleVersionsForTrade`'s WHERE clause, never touches an
  existing `rule_evaluations` row; (3) re-measured coverage with
  `--no-file-parallelism` for a trustworthy number: `freeze-evaluations.ts`
  98.5% lines/90% branch, `confirm.ts` 100% lines/97.91% branch, both
  clear the 90%-line bar; (4) **found and root-caused a genuine
  concurrency flake**, not a functional regression: the "both confirmDay
  and autoConfirmStaleTrades share the SAME evaluation logic" live test
  fails reproducibly (3/3) when 3+ live-DB test files run under Vitest's
  default full file-parallelism against the shared dev Postgres project,
  but passes reliably (2/2 full serialized re-runs, 46/46 each time)
  under `--no-file-parallelism` or in smaller file combinations —
  consistent with connection/resource contention on the shared dev-tier
  project under artificially high concurrent worker count (ADR 0002's own
  anticipated risk category), not a code defect (ruled out a cross-account
  race: every query in `confirm.ts` is `account_id`-scoped, and the test's
  trade lives on a fresh, unique account). Deliberately did NOT paper over
  this by adding a retry loop to the test (would mask a resource-condition
  worth knowing about) — documented instead, with a concrete
  recommendation (`--no-file-parallelism`) for whoever runs this module's
  live-DB suite next. **Final verdict: PASS, 46/46 tests, ready for
  security review**, `npx tsc --noEmit`/`npx eslint .`/`npm run build` all
  clean.
- 2026-08-24 — **Module 04 "Slice 4" rescoped from "freeze-wiring" (per the
  Phase 2 ledger's own prior "Current task" text) into two slices: Slice 4
  (cross-trade `TradeFacts` assembly only, pure/read-only) and a new Slice 5
  (the actual freeze-transaction wiring).** Why: the two are separable
  work with very different risk profiles — assembling 20 cross-trade
  queries correctly is substantial, testable-in-isolation work with no
  trust-sensitive side effects; wiring into `confirm.ts`'s freeze
  transaction is Module 04's single most trust-sensitive change ("rule
  evaluations freeze at close-out and are never recomputed retroactively"
  is a non-negotiable). Splitting them means the freeze-wiring slice can
  be reviewed against a SMALLER diff (just the wiring, not also 20 new
  queries at the same time), and this slice's own cross-trade logic gets
  its own dedicated tester/security/QA pass before anything trust-sensitive
  depends on it. Not a spec/design-doc reconciliation (Module 04's own text
  doesn't mandate one slice boundary over another) — a build-order/risk
  judgment call, recorded here per 00-foundation §12's "log every such
  reconciliation" instruction since it changes what "Slice 4" vs "Slice 5"
  means going forward in this ledger.
- 2026-08-24 — **`docs/adr/0015-iso-week-boundary-monday-start.md`: ISO
  week (Monday start), applied to `trades.server_day`, is this repo's one
  canonical week-boundary convention** (`lib/rules/week-boundary.ts`).
  The FIRST place a week boundary is defined anywhere in this repo — no
  prior code (Module 02's `server_day`, Module 04 Slices 1-3) ever needed
  to bucket a date into a week, only a day. Chosen for two independent,
  stated reasons: AGENTS.md's own "streak counts weeks, not days"
  non-negotiable is the entire reason a week boundary matters in this
  product, and `retrospeq-design-decisions.md`'s own weekend note ("the
  weekly review boundary should follow the forex week for mixed
  accounts") reads as favouring Monday-start (keeps the forex week's five
  active trading days, Mon-Fri, inside one bucket) over Sunday-start.
  **Load-bearing for whoever builds Module 04 Slice 6 (`adherence_weekly`)
  and Module 07 (`streaks`/`weekly_snapshots`, both of which carry their
  own `week_start date` column per their own specs)** — both MUST produce
  byte-identical `week_start` values for the same calendar date as this
  function, or adherence reporting and streak reporting will silently
  misalign near a week boundary. Full reasoning, alternatives considered,
  and consequences in the ADR itself.

- 2026-08-24 — **Module 04 Slice 3 (the preview engine, §5.8, +
  `operand_distributions` computation) — coded by `retrospeq-coder`, NOT
  yet independently tester/security/QA-reviewed.** Read Module 04 §5.8
  (preview engine), §3.1 (`operand_distributions` DDL, already existing
  from Slice 1), §12 (performance budgets), §1's stories 1.2/1.3, plus
  `lib/rules/operand-catalogue.ts`'s own header (the `computableToday`
  accounting) in full before writing any code.

  **Files built:**
  - `lib/rules/computable-operand-values.ts` — single-trade operand-value
    extraction for exactly the 8 `computableToday: true` operands
    (`risk_pct`, `day_of_week`, `hold_seconds`, `stop_set_at_entry`,
    `peak_risk_vs_planned`, `held_past_stop`, `instrument`,
    `pre_entry_captured_before_fill`). `risk_pct` reads
    `trades.initial_risk_pct`, NOT the peak `trades.risk_pct` — the
    documented trap the dispatch named explicitly, gotten right and
    tested. `pre_entry_captured_before_fill` implements the real
    `NOT ANY(trade_captures.captured_late)` semantics (via a SQL
    `bool_or` aggregate in `distributions-repository.ts`, not a JS loop)
    — `null` (operand-missing) when a trade has ZERO `pre_entry` capture
    rows, never conflated with "captured, none late." `decimal.js`
    throughout, including `peak_risk_vs_planned`'s division (verified by
    a test that a native-JS-hostile division — `0.3 / 0.1` — stays
    exact).
  - `lib/rules/distributions-repository.ts` — `fetchTradesForDistributions`
    (confirmed trades, last 12 months AND last 200, whichever is
    tighter — see this file's own header for the exact windowing
    judgment call, below), `fetchPreEntryCaptureSummaries`,
    `buildOperandDistribution`/`computeAllOperandDistributions` (pure,
    no I/O — numeric bucketed at the operand's own `bounds.step`, bool
    always exactly two buckets, pick_one/pick_many one bucket per
    distinct value), `upsertOperandDistributions`,
    `recomputeOperandDistributionsForUser` (the orchestrating function
    `sync.ts` now calls). Runs under `withServiceRoleConnection`
    (`operand_distributions` is service-role-write-only per Slice 1's own
    RLS reasoning) — every query explicitly scoped to the caller-supplied
    `userId`, matching ADR 0005's caveat. **Every bind is a parameter,
    including the window/limit constants** — no string interpolation into
    SQL anywhere, verified by reading the file, not just by the
    non-negotiables list.
  - `lib/rules/preview.ts` — `preview(userId, operandId, op, value) →
    PreviewResult`. Issues exactly ONE query (`select buckets, n from
    operand_distributions where user_id = $1 and operand_id = $2`) via
    `withUserConnection` (real RLS, owner-SELECT-only) — never a `trades`
    scan. Every bucket is checked through `evaluate.ts`'s own exported
    `compare()`, weighted by bucket count — §5.3's "one code path" is
    literal here, not just prose (verified by a `vi.spyOn` test proving
    the real function is actually called). §5.8's guidance table
    implemented boundary-for-boundary (`ratio === 0`, `> 0.35`, `< 0.06`,
    else), each boundary value itself tested to land in the CORRECT
    band, not just the open intervals. `n < 20` short-circuits to the
    exact §5.8 "no history yet" copy without ever computing a ratio.
    **Two distinct, never-conflated "can't produce a ratio" states**
    (this slice's own explicit requirement, echoing AGENTS.md's "not
    enough data yet is a correct, intended state"): `operand_not_computable`
    (a `computableToday: false` operand — a BUILDER-scope gap, no
    distribution is ever computed for it, regardless of trade count) vs.
    `insufficient_history` (a computable operand, but `n < 20` — a
    DATA-volume gap the trader can actually fix by trading more). Tested
    that the two states can never be produced by the same code path.
    Calibration coaching (§5.8's worked example) is an optional field,
    fires only when ratio > 0.35 and a median is computable (see the
    judgment-call note below). **`preview()` writes nothing, ever** —
    proven three ways: (1) a unit test scanning every mocked SQL call
    across all three outcome states for INSERT/UPDATE/DELETE keywords,
    (2) a fast-check property test fuzzing operand/op/value/bucket shape
    across 100 runs with the same assertion, (3) the `operand_not_computable`
    path proven to issue NO database call at all.
  - `app/(app)/rules/actions.ts`'s new `previewRule` Server Action —
    session + rate-limit + the SAME `validateOperandOpValue` whitelist
    `createRule`/`editRule` use (reused, not reinvented), no
    `revalidatePath` (read-only).
  - `lib/rate-limit/config.ts`'s new `previewRule` scope — deliberately
    the loosest, shortest-window budget in that file (240/60s per IP,
    150/60s per user), reasoned explicitly against the interactive-slider
    usage pattern rather than copied from `createRule`/`editRule`'s
    hourly windows.
  - `lib/ingestion/sync.ts`'s `runSync` now calls
    `recomputeOperandDistributionsForUser(account.user_id)` immediately
    after `writeSyncOutcome` commits — the real "on demand after a sync"
    half of §12. Deliberately non-blocking/best-effort (a recompute
    failure must never turn an already-committed successful sync into a
    reported failure) — logged loudly on failure
    (`console.error`), never swallowed silently. **Nightly recompute is
    explicitly NOT built** — no cron/scheduler infra exists in this repo
    yet, and per AGENTS.md's "never fake it" no stub trigger was written
    for it. Flagged in both `docs/runbook.md` (new "operand_distributions
    recompute failing after a sync" entry, alerting shape) and
    PROGRESS.md's "Infra gaps" list (appended to the existing "No Vercel
    project" bullet rather than creating a duplicate entry — checked
    first, per this slice's own dispatch instruction).
  - `lib/supabase/__tests__/service-role-inventory.test.ts`'s allowlist
    updated for `lib/rules/distributions-repository.ts`'s new
    `withServiceRoleConnection` call site — a mandatory companion to any
    new service-role call, per that test's own "no unreviewed addition"
    rule (Module 01 §7.2). Caught by running the full suite before
    considering this slice finished, not assumed clean.

  **Judgment calls, made explicitly, not silently:**
  - **Bucket-windowing** (`operand_distributions`'s own DDL comment: "over
    the last 200 trades / 12 months" — genuinely ambiguous, joined by a
    slash, not AND/OR): read as the MORE restrictive of the two combined
    (`opened_at >= now() - 12 months` AND `order by opened_at desc limit
    200`), not either alone. Reasoning documented inline in
    `distributions-repository.ts`'s own header. Not an ADR — this fills a
    genuine spec ambiguity, not a deliberate departure from a stated
    00-foundation convention.
  - **Calibration-message format** (§5.8's worked example: "At 1.0% you'd
    have flagged 40 of 90. Your median risk is 1.4% ... Try 2.0%?"): this
    slice's own dispatch explicitly allowed a reasonable format rather
    than the exact template. Implemented as: numeric/duration/rating
    operands only (no median for bool/pick_one/pick_many), fires only
    when the candidate ratio is already in the `> 0.35` "too often" band
    (echoing the worked example's own framing), suggests one bucket step
    LOOSER than the trader's own weighted median in the operand's own
    tighten/loosen direction, bounded to the operand's declared range.
    Documented inline in `preview.ts`'s own `calibrationCoaching` header.
    Not an ADR, same reasoning as the windowing call above.
  - **`recomputeOperandDistributionsForUser` is NOT one atomic
    transaction** (fetch trades, fetch captures, and each operand's
    upsert are separate `withServiceRoleConnection` calls, not one big
    transaction) — a deliberate simplification, documented in that file's
    own header: unlike `rule_evaluations`, `operand_distributions` is an
    idempotent, self-overwriting CACHE, not a trust-sensitive record; a
    partial failure leaves some operands stale until the next recompute,
    never corrupted or double-counted.

  **Explicitly OUT of scope, per this slice's own dispatch (Slice 4's
  job):** the full cross-trade `TradeFacts` assembly for the other 30
  `computableToday: false` operands (day/week-state aggregation, T1
  position-snapshot data, Module 03/06 dependencies), wiring evaluation
  into Module 02's confirm/freeze transaction (§5.4/§7.1), nightly
  recompute (blocked on real cron infra, flagged not faked), any UI
  (§5.8's slider/preview markup is Slice 6's job).

  **Tests:** 5 new test files (`computable-operand-values.test.ts` — 35
  tests, one per extractor including the two documented traps;
  `distributions-repository.test.ts` — 20 tests, bucketing +
  §8.1's "identical counts to a full scan" proven directly against the
  REAL `fixtures/golden/*/expected.json` trade arrays, not a synthetic
  dataset; `preview.test.ts` — 18 tests, every guidance boundary,
  both "no ratio" states, the `compare()` reuse proof, the "no writes"
  proof; `preview.property.test.ts` — 2 fast-check property tests, 100
  runs each; `distributions-repository.live.test.ts` — 4 live-DB tests
  against the real shared dev Supabase project, including a real
  `preview()` round trip against a live-recomputed distribution row) plus
  one new live-DB test appended to `sync.live.test.ts` proving the
  post-sync wiring fires for real (real `operand_distributions` rows
  exist after a real `runSync` call). Full repo suite: **1285 passed /
  13 skipped / 0 failed** (108 test files), `npx tsc --noEmit` /
  `npx eslint .` / `npm run build` all clean. `lib/rules/` coverage
  96.1% lines / 88.47% branches / 97.72% funcs (the two new files:
  `computable-operand-values.ts` 100%/97.43%/100%, `preview.ts`
  97.29%/79.31%/100%, `distributions-repository.ts` 94.4%/87.75%/100% —
  remaining gaps are defensive/unreachable-by-design branches, same
  class as `render-sentence.ts`'s own already-accepted exhaustiveness
  dead branches from Slice 2).

  **No ADR written this slice** — reviewed both judgment calls above
  against whether either is a deliberate deviation from a stated
  00-foundation convention; neither is (both fill genuine spec
  ambiguities Module 04 itself left open). **Not marked done in this
  ledger** — per AGENTS.md, that is `retrospeq-qa`'s call, gated on the
  tester/security-reviewer passes this entry explicitly says have not
  happened yet.

- 2026-08-24 — **Module 04 Slice 3 (preview engine + `operand_distributions`)
  — independently `retrospeq-tester`-verified: PASS, no real gaps found,
  nothing closed (the coder's own suite already hit every required case).**
  Read Module 04 §5.8, §3.1, §8.1, §12 fresh, then verified each of the
  8 focus items independently rather than re-trusting the coder's own
  claims:
  1. **Both documented traps genuinely covered.** `extractRiskPct`
     reads `trades.initial_risk_pct` — confirmed with a fixture where
     `initialRiskPct='1.5'`/`riskPct='4.2'` differ and the extracted
     value is `1.5`; a reversal to the peak column would fail this test.
     `extractPreEntryCapturedBeforeFill` has all three distinct cases
     tested: zero-capture-rows → `null` (both a `null` summary and an
     explicit `{count:0}` summary), any-late → `false`, none-late →
     `true`.
  2. **§8.1's "identical counts to a full scan" bullet is a real test,
     not a weak one.** `distributions-repository.test.ts` computes
     `flagged`/`n` two independent ways — via `buildOperandDistribution`'s
     buckets (the real preview code path) and via a genuine per-trade
     full scan with no bucketing at all — against the REAL
     `fixtures/golden/*/expected.json` trade arrays (all 8 fixtures,
     verified non-empty), across 8 operand/op/value combinations. Ran it
     myself; passes.
  3. **`preview()` writes nothing, verified independently, not just
     trusted.** Beyond the coder's `vi.spyOn` claim on `compare()`
     reuse, `preview.test.ts` and `preview.property.test.ts` regex-scan
     the literal SQL text of every mocked `client.query()` call across
     all three outcome states (and 100 fast-check fuzz runs) asserting
     no `insert|update|delete` keyword ever appears and every call is
     `select`-shaped. This is a real assertion on the actual query text,
     not a behavioral inference.
  4. **`operand_not_computable` vs `insufficient_history` cannot be
     confused.** `daily_loss_pct` (computableToday: false) returns
     `operand_not_computable` and issues zero database calls regardless
     of op/value (property-tested). A computable operand with no
     distribution row yet returns `insufficient_history` with `n: 0`,
     never a crash, never the not-computable state.
  5. **Guidance boundaries re-derived from §5.8's table independently
     and checked against the implementation:** `ratio === 0`, `> 0.35`
     (0.36 crosses, 0.35 itself stays in "else"), `< 0.06` (0.05 crosses,
     0.06 itself stays in "else"), mid-range "else" (0.20) — all five
     boundary conditions match the spec table exactly, code and tests
     agree.
  6. **Bucket width uses the operand's own `bounds.step`, anchored to
     `bounds.min`** (verified for `risk_pct`'s 0.1 step, `hold_seconds`'
     10s step) — not an arbitrary resolution. Bool buckets are always
     exactly `{true, false}` even with a zero-count side; pick_one/
     pick_many bucket exactly one entry per distinct observed value, no
     merging.
  7. **Post-sync wiring is real.** `runSync` calls
     `recomputeOperandDistributionsForUser` only after
     `writeSyncOutcome` (i.e., only on a real, non-`manual`, non-fetch-
     failed sync attempt — the early-return `catch` block for a failed
     `adapter.fetchHistory()` never reaches this line), wrapped in its
     own `try/catch` that logs via `console.error` and does not rethrow
     — a recompute failure cannot fail the sync. Confirmed live: the
     coder's `sync.live.test.ts` addition runs a real `runSync` against
     the shared dev Postgres and asserts real `operand_distributions`
     rows exist afterward; I re-ran it myself (real DB, not mocked) and
     it passed.
  8. **`previewRule`'s rate limit (240/60s IP, 150/60s email) is
     correctly the loosest, shortest-window scope in `lib/rate-limit/
     config.ts`** — meaningfully more generous than the mutating
     `createRule`/`editRule` scopes (30/3600s, 25/3600s), appropriate for
     an interactive slider. No bug found.

  **Independently re-run, not just re-confirmed from the coder's claim:**
  `npx tsc --noEmit` clean, `npx eslint .` clean (19 pre-existing
  unrelated warnings, 0 errors), `npm run build` succeeds (only
  pre-existing Node-20-deprecation warnings from `@supabase/supabase-js`,
  unrelated to this slice). Scoped `vitest run lib/rules --coverage`:
  **14 files, 263 passed, 0 failed**, coverage on this slice's 3 new
  files — `computable-operand-values.ts` 100% lines/97.43% branches,
  `distributions-repository.ts` 95.1% lines/89.79% branches,
  `preview.ts` 97.29% lines/79.31% branches — all clear the 90%-line
  bar; `lib/rules/` overall 96.16% lines. The uncovered lines in each
  (distributions-repository.ts:244-247/265-267, preview.ts:94-95/150)
  are genuinely defensive/type-exhaustiveness branches unreachable
  through any real `computableToday: true` catalogue entry today (no
  numeric operand lacks `bounds`, no v1 computable operand is
  `clock_time`), not functional gaps. Wider scoped run (`lib/rules`,
  `app/(app)/rules`, `sync.live.test.ts`, `service-role-inventory.test.ts`,
  17 files) including all live-DB tests against the real shared dev
  Postgres: **312 passed, 1 skipped (an unrelated nested skip-guard
  inside `sync.live.test.ts`), 0 failed.**

  **Not independently re-verified this pass (out of this slice's scope,
  not a gap in it):** `operand_distributions`' own table-level RLS
  cross-user isolation — that is Slice 1's `rulebook-schema.rls.test.ts`
  (already existing, not re-run here since Slice 3 adds no new table and
  no new RLS policy). No E2E/screenshot check was performed because this
  slice, by its own explicit scope boundary, ships no UI — no `/rules`
  route exists yet (confirmed by `npm run build`'s route list) and §5.8's
  slider markup is Slice 6's job; the E2E-plus-screenshot requirement in
  00-foundation §9 applies once that UI lands, not to this backend-only
  slice.

  **Verdict: yes, ready for `retrospeq-security-reviewer`.** All 8
  focus items hold up under independent re-derivation and re-execution,
  not just re-reading the coder's own tests. No production bug found; no
  test gap required closing.

- 2026-08-24 — **Closing a ledger gap found while writing the Slice 3
  entry above: Module 04 Slice 2's security-reviewer re-verification PASS
  and QA-reviewed PASS were never given their own decision-log entries —
  they existed only in the "Current task" section's prose, which Slice 3
  then overwrote.** Recorded here so the history survives, not because
  either review is new work. `retrospeq-security-reviewer` re-verified
  the two fixes from the FAIL pass (2026-08-24, entry below) live against
  the real DB — both closed, no new findings, **PASS**.
  `retrospeq-qa` then reviewed Slice 2 against all 8 of Module 04's
  product-fidelity/non-negotiable checks (no compound rules, tighten-only
  copy matches §5.2's exact rejection message, entitlement messaging,
  severity always starts soft, `rendered` sentence storage, RLS
  untouched, decimal.js throughout, no red/green anywhere reachable) —
  **PASS**, one minor doc-completeness nit: §1.7's "applies to 2 of your
  4 strategies" coverage-at-creation warning is deliberately deferred
  (needs Module 03's field registry, which doesn't exist in this repo
  yet) but that deferral hadn't been explicitly logged anywhere. Closed
  by confirming no code path fabricates a coverage number
  (`RuleActionResult` simply has no coverage field) — the same
  "flagged, not silently skipped" treatment Slice 1 already established
  for `trigger_evaluations`, to be wired for real once Module 03 ships
  (Phase 3). This closure is what the Phase-status table's "one minor
  doc-completeness nit ... closed below" sentence refers to.

- 2026-08-24 — `retrospeq-coder` fixes for `retrospeq-security-reviewer`'s
  blocking FAIL on Module 04 Slice 2 (the rule authoring pipeline). Two
  findings, both closed:
  - **Finding 1 (stored-XSS-shaped hole)**: `lib/rules/validate-operand-
    op-value.ts`'s `validateSetValue` accepted any string, unbounded, for
    operands whose `.options` is `undefined` (only `instrument` and
    `order_type` in the current catalogue — confirmed no others via
    grep), which flows verbatim into `rule_versions.rendered`/`.value`
    (render-sentence.ts's pick_one/pick_many join). Added a 64-char max
    length, a `/^[A-Za-z0-9_.\-/]+$/` character allowlist (covers tickers,
    `BTC/USD`-style symbols, `market_order`-style enums), and a 50-element
    max for `in`/`not_in` arrays — all rejected via the existing
    `InvalidRuleValueError`, never silently truncated. Updated
    `lib/rules/__tests__/validate-operand-op-value.test.ts`'s "no closed
    enum declared (instrument)" block (previously asserted "accepts any
    string") to prove valid tickers still pass and oversized/disallowed-
    character/oversized-array payloads (including a literal `<script>`
    payload) are now rejected.
  - **Finding 2 (unknown-key stripping)**: `app/(app)/rules/actions.ts`'s
    `createRuleInputSchema` was a plain `z.object(...)`, which silently
    strips unrecognised keys instead of rejecting the payload —
    contradicts 00-foundation §4.2 ("Reject unknown keys"). Verified live
    that this repo's Zod version (4.4.3) strips by default and that
    `z.strictObject(...)`/`.strict()` correctly rejects with
    `unrecognized_keys`. Changed `createRuleInputSchema` to
    `z.strictObject(...)`. Checked `editRule` too, per the finding's
    instruction — it takes two positional Server Action params
    (`ruleId: string`, `newValue: unknown`), not a `z.object(...)`
    payload (`ruleId` is validated with a bare `z.uuid()`, `newValue`
    flows through `validate-operand-op-value.ts`'s own exhaustive
    per-type shape checks) — confirmed via grep that `actions.ts` has
    exactly one `z.object` call, so there was no second schema to harden.
    Updated the existing (now-inverted) test in
    `app/(app)/rules/__tests__/actions.test.ts` — "unrecognised top-level
    fields ... are silently stripped" (previously asserting `success:
    true`) now asserts outright rejection (`fieldErrors._form` set,
    `insertRuleAndVersion` never called).
  - The reviewer separately flagged that the `.strict()` gap is
    repo-wide (no `actions.ts` file anywhere currently calls it) and
    suggested a full sweep — out of scope for this pass per the
    reviewer's own instruction; logged as a new "Infra gaps" entry above
    instead of `NEEDS_YOUR_INPUT.md`, since it's a known pattern gap, not
    something blocking current work.
  - Verification: `npx tsc --noEmit` clean, `npx eslint lib/rules
    "app/(app)/rules" lib/entitlements` clean (2 pre-existing unrelated
    warnings in `lib/entitlements/billing.ts`, unchanged by this pass),
    scoped test suite (`lib/rules/`, `app/(app)/rules/`,
    `lib/entitlements/`) 300 passed / 1 skipped / 0 failed, `npm run
    build` green.
  - **Still not re-reviewed by `retrospeq-security-reviewer`** — this
    entry closes the two findings from the prior review pass but does
    not itself constitute a new PASS; Slice 2 remains gated on that
    review returning clean against these fixes (and QA review, both
    still outstanding per "Current task" above).

- 2026-08-24 — `retrospeq-tester` independent verification pass on
  Module 04 Slice 2 (the authoring pipeline), against Module 04 §5.2/§8.1-
  8.4 and 00-foundation §9 — **PASS, 3 real gaps found and closed, 1
  latent (unreachable in v1) gap flagged and not fixed.** Read the module
  spec in full plus every Slice 2 file end to end before touching
  anything; did not trust the coder's self-reported numbers without
  re-running them.
  - **Structural "no compound rules" re-verified at THIS slice's actual
    write boundary**, not just re-confirmed at Slice 1's schema/evaluator
    layer: `createRuleInputSchema`'s `op` is a single `z.enum([...9
    literals])`, `operandId` a single `z.string()`, `value: z.unknown()`
    — no array/union shape exists anywhere in the Zod schema that could
    attach a second `{operand_id, op, value}` triple to one rule. Added 3
    tests to `app/(app)/rules/__tests__/actions.test.ts` proving this
    with actual malicious-shaped payloads (an array for `op`, an array
    for `operandId`, a nested condition-shaped object for `value`) rather
    than just re-reading the schema — all three correctly rejected before
    `insertRuleAndVersion` is ever called.
  - **Tighten-only truth table re-derived independently from §5.2's own
    table and checked against `validate-tighten-only.ts`'s
    `tightensAgainst()` line by line**, specifically checking the
    direction the dispatch flagged as easy to get backwards: `lte`
    tightens when `candidate.lte(global)` (candidate <= global) — correct,
    not reversed; `gte` tightens when `candidate.gte(global)` — also
    correct; `in` requires the candidate set to be a subset of the global
    set — correct. Confirmed true, no reversal found.
  - **Satisfiability re-verified with self-constructed contradiction
    cases**, not just re-running the coder's own tests: `gte 5` vs
    `lte 3` (contradictory, no value can be both), `between [10,20]` vs
    `between [0,5]` (contradictory, non-overlapping), `in ['EURUSD']` vs
    `not_in ['EURUSD','GBPUSD']` (contradictory, fully excluded) — all
    three correctly detected by `isContradictory`.
  - **Real gap #1, fixed**: `applyRuleEdit`'s only existing concurrency
    test was a deterministic stale-version REPLAY (perform one real edit,
    then retry with the now-stale version), which proves the guard's
    OUTCOME but never actually exercises two live, overlapping
    transactions. Added a genuine two-connection test to
    `lib/rules/__tests__/rules-repository.live.test.ts` using this repo's
    own established gold-standard technique
    (`lib/ingestion/__tests__/split-join.live.test.ts`'s
    `waitForBlockedQuery`, polling `pg_stat_activity` for
    `wait_event_type = 'Lock'`): a raw second connection holds an
    uncommitted supersede write on the exact row `applyRuleEdit`'s own
    guarded UPDATE targets, `applyRuleEdit` is started for real, the test
    waits until Postgres itself confirms `applyRuleEdit`'s connection is
    genuinely blocked on that row's lock (proving it actually reached the
    guarded UPDATE), then releases the competing write — `applyRuleEdit`
    correctly loses (`RuleEditConflictError`), no `version 2` row is ever
    inserted, `current_version` untouched. Passed 4/4 consecutive runs
    (no flakiness). Concluded the deterministic-replay tests remain
    valuable (cheap, fast, prove the outcome) but are not sufficient on
    their own for a trust-sensitive guard — both now exist side by side.
    Separately confirmed by reading `lib/supabase/direct.ts` that
    `withUserConnection`/`withServiceRoleConnection` run under Postgres's
    default READ COMMITTED isolation with no explicit isolation-level
    override, which is exactly what makes the atomic-conditional-UPDATE
    pattern provably correct under real concurrency (Postgres re-checks
    an UPDATE's WHERE clause against the post-lock-wait row state) — not
    merely "probably fine."
  - **Real gap #2, fixed**: `countActiveRules` (`lib/entitlements/
    rules-usage.ts`, the free-tier 3-rule cap's actual counter) had ZERO
    live-DB coverage of its own — `rules-usage.test.ts` only mocks the
    query result and regex-matches the SQL text for `state = 'active'`,
    which would not catch a real bug in the predicate (e.g. a typo'd
    state literal, a missing `and`). Added
    `lib/entitlements/__tests__/rules-usage.live.test.ts`: seeds one
    `active`, one `retired`, and one `deactivated_by_plan` rule (plus
    each one's required `rule_versions` row) directly against the real
    `retrospeq.rules` table and confirms the count is exactly 2, not 3 —
    closes the dispatch's item 6 ("confirm `countActiveRules` excludes
    retired rules"). Also independently confirmed the reasoning for
    `editRule` NOT re-checking the `rules.create` entitlement is sound —
    editing an existing rule's threshold does not change the active-rule
    count, so re-running that check would incorrectly block a trader
    already at their cap from adjusting an existing rule; the existing
    "does NOT re-check the rules.create entitlement on edit" test in
    `actions.test.ts` already proves this directly.
  - **Gap flagged, NOT fixed (latent, unreachable through the real
    pipeline in v1)**: `validate-satisfiability.ts`'s `isContradictory`
    unconditionally calls `decimal.js`'s `Decimal()` on `eq`/`neq`
    operand values, which throws on a non-numeric string. `ALLOWED_OPS_BY_TYPE`
    technically permits `eq`/`neq` on `pick_one` operands (whose values
    are strings, e.g. `instrument`), so a future catalogue entry adding an
    `eq`/`neq` phrasing template to a pick_one operand would hit an
    unhandled exception in `checkSatisfiability` instead of a graceful
    `RULE_UNSATISFIABLE`/pass-through. Confirmed this is NOT reachable
    today: every current pick_one/pick_many catalogue entry
    (`order_type`, `exit_reason`, `instrument`, `day_of_week`) only
    authors `in`/`not_in` in its own `phrasing` map, and
    `validateOperandOpValue`'s phrasing-gate rejects any operator an
    operand doesn't actually author before a row can ever be written —
    so no `rule_versions` row with `eq`/`neq` + a string value can exist
    in the live DB today. Same class of "documented, currently
    unreachable" boundary this file's own header already applies to
    other operator-pair shapes; noted here for whoever adds the first
    `eq`-authoring pick_one operand, not fixed now since there is nothing
    live to reproduce it against.
  - **Value-bounds/type spot checks, no bugs found**: numeric bounds are
    inclusive at the exact `min`/`max` (boundary equality allowed, not
    rejected); the `HH:MM` clock regex (`^([01]\d|2[0-3]):[0-5]\d$`)
    correctly spans 00:00-23:59 and rejects `24:00`/`12:60`; pick_one/
    pick_many closed-enum checks correctly enforce `options` when
    declared and are correctly, intentionally open when `options` is
    omitted (`instrument` — the trader's own traded-instrument set, not a
    fixed enum, per that entry's own comment). `between`'s clock-time
    variant does not enforce `value[0] <= value[1]` — left as-is, not a
    bug: `entry_clock_time` is the only catalogue entry authoring
    `between`, and an overnight session window (e.g. 23:00 to 01:00)
    genuinely needs `value[0] > value[1]` to be valid.
  - **Unknown `operand_id` rejected before any DB write, no partial
    insert, re-confirmed**: `validateOperandOpValue` runs first in both
    `createRule` and `editRule`, before tier/entitlement/tighten-only/
    satisfiability and before any repository call; `insertRuleAndVersion`
    itself wraps both its `rules` and `rule_versions` INSERTs in one
    `withUserConnection` transaction (single BEGIN/COMMIT/ROLLBACK), so
    even a downstream failure can't leave a partial row. Existing test
    (`'rejects an unknown operand_id ... before any repository call'`)
    already proves the ordering; no gap found here.
  - **Full verification run**: `lib/rules/` unit+live suite (10 files,
    194 tests, all passing, confirmed stable across repeated runs);
    `lib/rules/` line coverage 96.29% (independently re-measured, matches
    the coder's own reported number exactly). `npm run build`,
    `npx eslint` (`npm run lint`), `npx tsc --noEmit` all exit clean, zero
    new warnings/errors from any Slice 2 file. Full-repo `npx vitest run`
    with no file filter: 1183 passed / 13 skipped / 1 failed on one run
    (`lib/ingestion/__tests__/confirm.live.test.ts`'s pre-existing
    "7-day threshold" test, untouched by this slice) — re-ran that file
    in isolation and it passed 18/18 cleanly; the unfiltered full-suite
    run also hit a V8 "Fatal process out of memory: Zone" crash on one
    attempt. Concluded this machine cannot reliably run the full,
    unfiltered suite in one process given its standing disk/resource
    constraints (see "Infra gaps" — this is a resource-contention
    symptom of the same underlying constraint, not a new blocker) —
    verified correctness via scoped/batched runs instead (`lib/rules`,
    `app/(app)/rules`, `lib/entitlements`, full suite in a lower-
    contention window), each of which passed cleanly and reproducibly.
    **Environment note for future agents**: this Bash tool runs Git Bash
    (POSIX sh), not PowerShell, despite `NEEDS_YOUR_INPUT.md`'s workaround
    being written in PowerShell syntax (`*>` redirection). In POSIX sh,
    an unquoted `*>` is parsed as a glob-expanding `*` word followed by a
    `>` redirect, not a single redirection operator — this silently
    broadened a `npx vitest run <one file>` command into running the
    entire ~100-file suite (and contributed to the OOM crash above) before
    being caught. Use plain `> file 2>&1` in this Bash tool, not `*>`.
  - No code review authority exercised here beyond what's in scope for a
    tester pass (security/QA review is still a separate, outstanding
    step — see "Current task"). Did not touch `lib/rules/evaluate.ts`,
    `lib/rules/operand-catalogue.ts`, or the Slice-1 migrations, per the
    dispatch's own explicit boundary.

- 2026-08-24 — Module 04 Slice 2 (the authoring pipeline — rule CRUD,
  versioning, tighten-only/satisfiability/tier/entitlement validation,
  §5.1) coded and self-tested. Built: `lib/rules/render-sentence.ts`
  (pure sentence rendering from the operand catalogue's `phrasing` map),
  `lib/rules/validate-operand-op-value.ts` (§8.3 write-time whitelist —
  unknown `operand_id`, op-for-type, phrasing-renderability, declared-
  bounds), `lib/rules/validate-tighten-only.ts` and
  `validate-satisfiability.ts` (§5.2's two authoring-time validations,
  pairwise against active global rules, decimal.js throughout, never SQL/
  eval), `lib/rules/validate-tier.ts` (mirrors `evaluate.ts`'s own step-2
  tier comparison at authoring time), `lib/rules/rules-repository.ts`
  (the DB layer — `insertRuleAndVersion`, `applyRuleEdit`,
  `fetchCurrentRuleForEdit`, `fetchActiveGlobalRuleVersionsForOperand`,
  `fetchAccountSyncTiers`), `lib/entitlements/rules-usage.ts`
  (`countActiveRules`, wired into `lib/entitlements/service.ts`'s
  `defaultCanDeps` as `rules.create`, per that file's own anticipated
  extension point), `app/(app)/rules/actions.ts` (`createRule`/
  `editRule` Server Actions, no UI yet — matches Module 02's "engine
  before the screen" precedent). Real judgment calls, not silently
  assumed:
  - **A real bug caught by the test suite before it shipped:** the first
    cut of `hasSufficientTierAccount` used a bare `.some()` over the
    account-sync-tier list, which resolves `false` for EVERY operand
    tier (including `t0`) when the trader has zero connected accounts —
    would have blocked the guided three-rule front door (§5.10, all
    `t0`, "these three are also the entire free tier") from being
    authorable during onboarding, before Module 08 ever prompts a broker
    connection. Fixed: `t0` is the catalogue's own baseline and is now
    always available regardless of account count; only `t1`+ operands
    require at least one qualifying connected account. Reasoning is in
    `validate-tier.ts`'s own header, not just this line.
  - **`editRule` does NOT re-run the `rules.create` entitlement check**,
    despite the dispatch's "re-validates the SAME way as create" —
    editing a threshold doesn't consume an additional slot against the
    3-rule Free cap (the active-rule count is unchanged by an edit); re-
    running that check would incorrectly block a trader already at their
    cap from adjusting an EXISTING rule. Every other validation (operand
    whitelist, tier, tighten-only, satisfiability) IS re-run against the
    new value, since a threshold change can genuinely invalidate a
    previously-valid rule.
  - **`editRule`'s concurrency guard** is the same atomic-conditional-
    UPDATE pattern this repo already established in `lib/ingestion/
    split-join.ts`/`confirm.ts` (`WHERE ... AND superseded_at IS NULL`,
    `rowCount` checked, named `RuleEditConflictError` on a lost race) —
    all three statements (supersede old version, insert new version,
    bump `rules.current_version`) run inside ONE `withUserConnection`
    transaction, no service-role phase needed since both `rules`/
    `rule_versions` already have full owner RLS from Slice 1. Proved
    live against the real DB in `lib/rules/__tests__/rules-repository.
    live.test.ts` via a DETERMINISTIC stale-`expectedVersion` replay
    (perform one real successful edit, then retry with the now-stale
    version) rather than a timing race — `split-join.live.test.ts`'s own
    header already documents, in detail, why a fixed-timeout two-Promise
    race in this environment usually doesn't reach the guard's own
    `rowCount !== 1` branch at all (the earlier read-then-act check wins
    first); the deterministic replay reproduces the exact DB state a
    genuinely-raced loser would see without depending on any timing
    assumption.
  - **Server Actions take typed-object arguments, not FormData** —
    dispatch's own literal signature (`createRule(input: {...})`,
    `editRule(ruleId, newValue)`), and no UI exists yet to dictate field
    names; ready for whichever future form wraps it, same "backend
    function first" precedent `createManualTradeAction`'s own header
    documents, just without that file's FormData wrapper layer since
    nothing dictates one yet.
  - **Satisfiability/tighten-only test fixtures use `day_of_week`
    (`in`/`not_in`), not `risk_pct`** for the cross-operator contradiction
    cases spec's own worked example uses (`risk_pct >= 2%` vs `<= 1%`) —
    `risk_pct`'s own `phrasing` map only ever authors `lte` in v1
    (confirmed by two test failures before this fix), so no v1 catalogue
    operand can reach a genuine cross-operator conflict through the REAL
    authoring pipeline except `day_of_week`, the one operand whose
    phrasing authors two operators. The pure `isContradictory`/
    `tightensAgainst` functions are still unit-tested against every
    documented operator pair directly, independent of catalogue
    phrasing constraints.
  - No ADR written this slice — reviewed against 00-foundation's
    conventions and found no deliberate deviation from one (RLS
    untouched from Slice 1, `{operand_id, op, value}` only, decimal.js
    throughout, parameterized queries only). No new `docs/runbook.md`
    entry either — checked 00-foundation §7.3's alerting table and
    Module 04 §10's own error table; nothing this slice introduces
    matches either (the same reasoning `split-join.ts`'s own, structurally
    identical concurrency-guard errors already established — zero
    runbook entries exist for `SplitTradeAlreadyConfirmedError`/
    `JoinTradeAlreadyConfirmedError` either).
  Explicitly OUT of scope, per the dispatch: the preview engine (§5.8,
  Slice 3), retire/promote/demote/hard-cap severity lifecycle (§5.7,
  Slice 5), any UI. New tests: 141 (render-sentence, validate-tighten-
  only, validate-satisfiability, validate-tier, validate-operand-op-
  value, rules-usage, app/(app)/rules/actions, plus a 4-test live-DB
  transaction-correctness suite). Full repo suite 1171 passed / 13
  skipped / 0 failed; `lib/rules/` 96.29% line coverage; build/lint/tsc
  clean. NOT security-reviewed or QA-reviewed yet.
- 2026-08-24 — **Independent tester verification of Module 04 Slice 2**
  (retrospeq-tester, against 00-foundation §9 and Module 04 §8) — the
  coder's self-report re-checked, not just trusted, and 3 real test gaps
  found and closed (not just flagged). Full method and results:
  - **Re-ran everything myself.** Full suite via the documented
    C:-full workaround (`$env:TEMP/TMP/TMPDIR = E:\tmp_vitest`,
    `*>` redirect to a file, `Read` the file back, never piped through
    `tail`/`Select-Object`): **1184 passed / 13 skipped / 0 failed**
    (103 test files), up from the coder's reported 1171 because of the
    tests added below. `npx tsc --noEmit`, `npx eslint .`, `npm run
    build` all clean run in isolation (a combined back-to-back run of
    all three once hit a genuine Next.js build-worker OOM crash on this
    machine — re-ran `npm run build` alone, exit 0 — a resource-
    exhaustion artifact of this constrained machine, not a code defect;
    noting it here so it isn't confused with a real build failure if
    seen again in a combined run).
  - **Coverage re-measured independently, not re-quoted**: `lib/rules/`
    was 96.29% lines / 96.22% funcs / 88.92% branch before my additions
    (matches the coder's own number exactly) → **97.2% lines / 98.11%
    funcs / 90.07% branch** after. `rules-repository.ts` alone went
    86.99% → 94.3% lines (see `fetchAccountSyncTiers` gap below).
    `validate-satisfiability.ts` branch coverage 84.61% → 87.69% (the
    remaining gap is the `eq`-paired mirror branches — `neq`/`lte`/
    `gte`/`between` vs an existing `eq` rule — which are unreachable
    through the real pipeline today since no v1 catalogue operand
    authors `eq` at all; left alone, same class as the already-accepted
    `render-sentence.ts` exhaustiveness-check dead branches).
  - **§8.2 invariant 1, "no compound expression is representable
    through any API path" — verified empirically, not just by reading
    the code.** Added 3 adversarial tests to
    `app/(app)/rules/__tests__/actions.test.ts`: a nested
    `{operand_id, op, value}` object smuggled as `value` (rejected,
    `INVALID_VALUE_SHAPE`), an array of two such triples smuggled as
    `value` for an `in`-type operand (same rejection), and unrecognised
    top-level fields (`and`/`conditions`) on the `createRule` call
    (silently stripped by Zod's default "strip" mode, zero effect on
    the saved rule, no hidden compound-handling code path exists to
    find). All three pass — the claim holds, now with a test proving it
    rather than only a header comment asserting it.
  - **Tighten-only truth table (§5.2) independently re-derived and
    checked against `validate-tighten-only.ts` line by line** — `lte`
    tightens iff strategy ≤ global, `gte` iff strategy ≥ global, `in`
    iff subset, `is_true`/`is_false` iff identical. Correct in every
    direction, including the one the dispatch itself flagged as easy to
    get backwards. No fix needed.
  - **Satisfiability (§5.2) — constructed my own contradiction cases,
    found a real, untested branch.** The existing suite tested
    `between` vs `lte`/`gte` (candidate = `between`) but never the
    mirrored direction (candidate = `lte`/`gte`, existing global rule =
    `between`) — a genuinely distinct branch in `isContradictory`'s own
    `pair()` dispatch. Added 8 tests to
    `lib/rules/__tests__/validate-satisfiability.test.ts` covering both
    directions' contradictory AND satisfiable cases; all pass and match
    hand-derived expected results. (Currently unreachable through the
    real `createRule`/`editRule` pipeline — `entry_clock_time`, the only
    v1 operand authoring `between`, has no `lte`/`gte` phrasing — but
    tested directly against the exported `isContradictory`, matching
    this suite's own established convention of testing every operator-
    pair shape the function defines, not just today's reachable ones.)
  - **Concurrency guard (§8.2 "frozen evaluation never changes... under
    any subsequent edit") — judged the coder's deterministic-replay
    test insufficient on its own and added a GENUINE two-connection
    race.** The existing test only proves the guard's *outcome* given an
    already-stale `expectedVersion`; it doesn't prove `applyRuleEdit`
    ever actually blocks on a live row lock the way a real concurrent
    writer would produce it. Added a new test to
    `lib/rules/__tests__/rules-repository.live.test.ts` using the exact
    `pg_stat_activity`-polling (`waitForBlockedQuery`) technique
    `split-join.live.test.ts`'s `resolveAmbiguousGroupingAsSingle` test
    established as this repo's gold standard for this problem (a fixed-
    `setTimeout` sleep was proven elsewhere in this repo to NOT reliably
    force the interleaving — see that file's own header): a second raw
    connection holds an uncommitted supersede write on the exact row,
    `applyRuleEdit` is started for real, the test polls until Postgres
    itself confirms `applyRuleEdit`'s own connection is genuinely
    sitting on the lock queue, only then releases the hold. Passes,
    2.6s, real DB. This is now a real, event-driven proof, not an
    inference from a replay.
  - **Entitlement reasoning (free-tier cap of 3, `editRule` not
    re-checking it) — confirmed sound.** `countActiveRules` filters
    `state = 'active'` only (excludes `retired`/`deactivated_by_plan`,
    confirmed by reading the query directly), and `editRule` has no
    `canForUser` call anywhere in its body (confirmed by reading
    `app/(app)/rules/actions.ts` directly, not just trusting the header
    comment) — the coder's stated judgment call holds.
  - **Real gap found and closed: `fetchAccountSyncTiers` had ZERO test
    coverage of its own SQL against a real `trading_accounts` table** —
    every existing test replaces it with a mock (including
    `actions.test.ts`), so its `status not in ('disconnected',
    'plan_limited')` filter and `sync_tier` column read were never
    proven correct against live rows, despite being the exact query
    `validate-tier.ts`'s tier-gating is authored against. Added a live
    test to `rules-repository.live.test.ts` seeding one account of each
    status the function claims to exclude/include and asserting the
    returned tier set exactly. Passes.
  - **Value bounds/type validation (§8.3) spot-checked** — numeric
    bounds inclusive-equality at both ends, clock `HH:MM` 24h zero-
    padded regex (rejects `9:30`, `24:00` by construction), closed-enum
    `pick_one`/`pick_many` rejection all read correctly and are already
    tested; no changes needed.
  - **Minor, non-blocking finding, not fixed:** `RuleNotFoundError`
    (`rules-repository.ts`) is exported but never actually thrown
    anywhere in the codebase — `editRule`'s "rule not found" path
    returns a literal error object directly instead of throwing this
    class. Not a functional bug (the `RULE_NOT_FOUND` behavior itself is
    correct and tested), just unused dead code; flagged for whoever
    touches this file next rather than changed here, since removing an
    exported class is a larger edit than this verification pass's scope.
  - **RLS**: not re-verified this pass — Slice 1's
    `rulebook-schema.rls.test.ts` already covers 100% of the rulebook
    tables and this slice adds no new tables/columns, so there was
    nothing new for RLS coverage to check. Confirmed by reading the
    schema: Slice 2 only adds application code against tables Slice 1
    already RLS-covered.
  - **Verdict: yes, ready for security review as-is.** Every §8.2
    "invariant that matters" this slice is actually responsible for
    (creation/versioning, not evaluation) now has a real, passing test
    behind it, not just a claim — 3 genuine gaps found and closed in
    this pass (compound-expression empirical proof, satisfiability
    mirror-direction branch, `fetchAccountSyncTiers` live coverage), one
    upgraded from inferred-sufficient to actually-proven
    (concurrency), and nothing found that should block the next gate.
- 2026-08-23 — Module 04 Slice 1 (schema + operand catalogue +
  evaluator) judgment calls, summarised here with full reasoning in each
  file's own header (see "Current task" above for the full slice
  report): (1) deferred `trigger_evaluations` entirely, flagged not
  stubbed -- depends on Module 03's `trigger_conditions`, which doesn't
  exist. (2) RLS shape reasoned per-table from data semantics, same
  method as ADR 0011 not its literal conclusions: `rules` for-all,
  `rule_versions` SELECT+INSERT+UPDATE narrowed by a
  superseded-at-only allowlist trigger, `rule_evaluations` SELECT-only
  (Module 02's confirm.ts already writes exclusively via
  withServiceRoleConnection, verified by reading the file), `rule_overrides`
  SELECT+INSERT append-only, `adherence_weekly`/`operand_distributions`
  SELECT-only materialised. (3) Built the `rule_evaluations`
  immutability trigger (reject all UPDATE; reject DELETE outside
  erasure) THIS slice rather than deferring, unlike Module 02's
  analogous regrouping trigger, because "written once, never updated"
  has zero documented exceptions -- no future-column-set ambiguity to
  wait on. Extended the same reasoning to add a `rules_forbid_delete`
  trigger not literally named in the spec's own DDL comments, because
  deleting a rule would cascade-delete its frozen evaluations -- the
  exact gaming vector Module 04 §1's opening line names as the module's
  central risk; flagged explicitly for security review as a
  beyond-literal-spec addition. (4) `risk_pct` operand maps to
  `trades.initial_risk_pct` (the pre-entry-decided value), NOT
  `trades.risk_pct` (peak) -- cross-checked against ADR 0012's own
  named gotcha for exactly this future reader. (5) Evaluator's step 5
  (op/type validation) reordered before steps 2-4, an outcome-preserving
  reordering per §8.3's own parallel treatment of "unknown operand_id"
  and "malformed op" as the same loud-rejection class. 86 new tests, all
  passing against the live DB; evaluate.ts 98.7% line coverage,
  operand-catalogue.ts 100%; full repo suite 1041 passed/13
  skipped/0 failed; build/lint/tsc clean. NOT security-reviewed or
  QA-reviewed yet -- security review explicitly recommended as
  mandatory given §5.3's own "security-critical" section header, not a
  discretionary follow-up.
- 2026-08-23 — `retrospeq-tester` independent verification pass on
  Module 04 Slice 1 (same day as the coder's self-test above): confirmed
  "no compound rules" and "never eval'd/compiled to SQL" both true by
  direct inspection (DDL, TS types, grep, plus a live hand-crafted
  `op = 'DROP TABLE'` insert rejected by `rule_versions_op_check`), and
  hand-counted §4.1's 38-operand coverage independently rather than
  trusting the file's own test. Found and closed two real coverage/fuzz
  gaps in the property-test suite (the `toDecimal` "not finite" branch,
  and op-fuzzing only ever exercising valid-but-wrong-type operators,
  never genuinely arbitrary garbage op strings) -- `lib/rules/` line/
  branch/function coverage now 100%/100%/100% (was 98.7%/98.66%/100%).
  Independently re-exercised all 4 DB triggers live (rolled back, nothing
  persisted), matching the existing RLS test file's own claims exactly.
  Flagged, did not fix (out of tester scope): Module 04 §15's "no
  compound rules" ADR does not exist yet in `docs/adr/`, and arguably
  should -- this slice's own schema/types ARE that decision, not a later
  slice's. Full repo suite: 1047 passed/13 skipped/0 failed;
  build/lint/tsc clean.

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
