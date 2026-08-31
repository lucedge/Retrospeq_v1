import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import type { RuleOperator } from './operand-catalogue';
import type { GlobalRuleForOperand as TightenOnlyGlobalRule } from './validate-tighten-only';
import type { GlobalRuleForOperand as SatisfiabilityGlobalRule } from './validate-satisfiability';

/**
 * Module 04 (Rulebook & Evaluation) §5.1's authoring pipeline — the DB
 * access layer behind `app/(app)/rules/actions.ts`'s `createRule`/
 * `editRule`. Every table this file touches (`rules`, `rule_versions`)
 * already has real, working owner RLS from Slice 1
 * (`supabase/migrations/20260823020000_rulebook_schema.sql`) — `rules`
 * gets an owner "for all" policy, `rule_versions` gets owner SELECT +
 * INSERT + a narrowly-trigger-guarded UPDATE — so every function here
 * runs under `withUserConnection`, genuinely RLS-enforced against the
 * caller's own session, never `withServiceRoleConnection` (unlike
 * `rule_evaluations`, which Module 04 §13 explicitly reserves for Module
 * 02's own frozen-write transaction, per that migration's own header).
 *
 * `trading_accounts` also has real owner RLS (Module 01) — `fetchAccountSyncTiers`
 * uses the same connection role for the same reason.
 */

// ---------------------------------------------------------------------
// Reads used by the authoring validations
// ---------------------------------------------------------------------

interface ActiveGlobalRuleRow {
  rule_id: string;
  op: RuleOperator;
  value: unknown;
  rendered: string;
}

/**
 * Every ACTIVE global rule currently authored against `operandId`, most
 * recent (current) version only. Used by BOTH tighten-only (item 2) and
 * satisfiability (item 3) — the two validations share an identical query
 * shape, differing only in which `checkX` function consumes the result,
 * so this is the one read both call sites use (never two parallel
 * queries for the same fact).
 *
 * `excludeRuleId`: when editing an existing GLOBAL rule, that rule's own
 * (pre-edit) row would otherwise appear in its own comparison set —
 * comparing a rule's NEW value against its own OLD value through
 * `checkSatisfiability`'s pairwise `eq`-vs-`eq` (etc.) logic would
 * produce a false-positive "contradiction" for a plain threshold edit.
 * Excluded explicitly rather than relying on the comparison functions to
 * special-case self-comparison — the repository is the one place that
 * actually knows which row is "self."
 */
export async function fetchActiveGlobalRuleVersionsForOperand(
  userId: string,
  operandId: string,
  excludeRuleId?: string,
): Promise<Array<TightenOnlyGlobalRule & SatisfiabilityGlobalRule>> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<ActiveGlobalRuleRow>(
      `select r.id as rule_id, rv.op, rv.value, rv.rendered
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.user_id = $1
          and r.scope = 'global'
          and r.state = 'active'
          and rv.operand_id = $2
          and ($3::uuid is null or r.id <> $3::uuid)`,
      [userId, operandId, excludeRuleId ?? null],
    );
    return res.rows.map((row) => ({ ruleId: row.rule_id, op: row.op, value: row.value, rendered: row.rendered }));
  });
}

/**
 * Sync tiers of every currently-active trading account (same "occupies a
 * slot" filter `account-usage.ts`'s `countActiveTradingAccounts` already
 * established: excludes `disconnected` and `plan_limited`, the two
 * statuses that mean "not really connected right now"). Feeds
 * `validate-tier.ts`'s `hasSufficientTierAccount` — see that file's own
 * header for why authoring gates on "at least one qualifying account",
 * not a specific one.
 */
export async function fetchAccountSyncTiers(userId: string): Promise<string[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ sync_tier: string }>(
      `select sync_tier
         from retrospeq.trading_accounts
        where user_id = $1
          and status not in ('disconnected', 'plan_limited')`,
      [userId],
    );
    return res.rows.map((row) => row.sync_tier);
  });
}

/**
 * The CURRENT (most recent, non-superseded) version's rendered sentence for
 * a rule the caller owns — Module 04 §5.6 UI, Slice 10d part 2's own
 * attribution line ("Your risk cap accounts for 6 of the 14 soft breaks").
 * `adherence_weekly.top_break_rule_id` is deliberately NAME-AGNOSTIC
 * (`adherence-repository.ts`'s own header: "stores only the id — never the
 * rule's rendered sentence or name... resolving that id to display text is
 * a later read-side join") — this is that join, now that a screen actually
 * needs it.
 *
 * **Known, documented simplification**: this resolves to the rule's
 * CURRENT wording, not necessarily the wording that was actually in effect
 * during the week being displayed. `rule_evaluations` itself DOES retain
 * the exact `rule_version` live at each evaluation (the FK this table's own
 * migration comment describes), but `adherence_weekly` — the materialised
 * cache this screen reads, per its own "never compute from raw evaluations
 * at read time" contract — only stores `top_break_rule_id`, not a version.
 * Re-deriving the exact historical wording would mean joining back through
 * raw `rule_evaluations` at read time, which is exactly the performance/
 * trust posture `adherence_weekly` exists to avoid (§3.1, §12's "< 500ms
 * per week" budget is for the MATERIALISED read, not a live re-join). A
 * trader who edited a rule's threshold since the displayed week will see
 * the attribution line naming that rule by its CURRENT phrasing — a minor,
 * honest imprecision (the rule identity is exactly right; only the
 * rendered number in the sentence could be stale), not a fabricated fact.
 * Worth revisiting if Module 06's weekly review ever needs
 * historically-exact wording.
 *
 * `null` when the rule id no longer resolves for this user (should not
 * happen in practice — rules are never deleted, only retired, and
 * `rule_versions` rows are append-only/immutable — but a display-only read
 * degrades honestly rather than throwing if it somehow does).
 */
export async function fetchRuleRenderedText(userId: string, ruleId: string): Promise<string | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ rendered: string }>(
      `select rv.rendered
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.id = $1 and r.user_id = $2`,
      [ruleId, userId],
    );
    return res.rows[0]?.rendered ?? null;
  });
}

// ---------------------------------------------------------------------
// fetchRulesForUser — story 1.1's rule list/browsing view, Slice 10e
// ---------------------------------------------------------------------

export interface RuleListItem {
  ruleId: string;
  rendered: string;
  operandId: string;
  severity: 'soft' | 'hard';
  state: 'active' | 'retired' | 'deactivated_by_plan';
  scope: 'global' | 'strategy' | 'account';
  scopeId: string | null;
  createdAt: string;
  promotedAt: string | null;
  retiredAt: string | null;
}

interface RuleListItemRow {
  rule_id: string;
  rendered: string;
  operand_id: string;
  severity: 'soft' | 'hard';
  state: 'active' | 'retired' | 'deactivated_by_plan';
  scope: 'global' | 'strategy' | 'account';
  scope_id: string | null;
  created_at: string;
  promoted_at: string | null;
  retired_at: string | null;
}

/**
 * Story 1.1's "one sentence, one tappable number" rule list — Slice 10e.
 * NO repository function listed a trader's own rules before this one
 * (grep-confirmed at this slice's own dispatch time) — `fetchCurrentRuleForEdit`
 * above reads exactly ONE rule by id, and `fetchActiveGlobalRuleVersionsForOperand`
 * reads active GLOBAL rules for ONE operand at a time (an authoring-validation
 * helper, not a browsing view). This is the first "give me everything this
 * trader has ever authored" read.
 *
 * Returns EVERY rule regardless of `state` — `active` (both severities),
 * `retired`, and (defensively, though nothing in this codebase writes it yet
 * per `lib/entitlements/downgrade.ts`'s own header) `deactivated_by_plan` —
 * one query, one round trip, no N+1 (matching this file's own established
 * "one indexed join, not a per-rule fetch" posture). The CALLER (this
 * slice's `RuleList.tsx`) decides how to group/de-emphasise non-active rows;
 * this read stays a plain, complete list.
 *
 * Ordering: active rules first (a retired rule is a dead end per story 2.4,
 * not the trader's current concern), hard before soft within the active set
 * (the few, rare, meant-to-be-loud rules lead, matching `.adherence`'s own
 * "hard first" convention), oldest-authored-first as the final tiebreak —
 * a stable, meaningful default rather than insertion-order-by-accident.
 */
export async function fetchRulesForUser(userId: string): Promise<RuleListItem[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<RuleListItemRow>(
      `select r.id as rule_id, rv.rendered, rv.operand_id, r.severity, r.state, r.scope, r.scope_id,
              r.created_at::text as created_at, r.promoted_at::text as promoted_at, r.retired_at::text as retired_at
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.user_id = $1
        order by (r.state = 'active') desc, (r.severity = 'hard') desc, r.created_at asc`,
      [userId],
    );
    return res.rows.map((row) => ({
      ruleId: row.rule_id,
      rendered: row.rendered,
      operandId: row.operand_id,
      severity: row.severity,
      state: row.state,
      scope: row.scope,
      scopeId: row.scope_id,
      createdAt: row.created_at,
      promotedAt: row.promoted_at,
      retiredAt: row.retired_at,
    }));
  });
}

// ---------------------------------------------------------------------
// createRule's write
// ---------------------------------------------------------------------

export interface InsertRuleInput {
  userId: string;
  operandId: string;
  op: RuleOperator;
  value: unknown;
  scope: 'global' | 'strategy';
  scopeId: string | null;
  evaluation: 'pre_entry' | 'at_close' | 'session';
  rendered: string;
  /**
   * The caller's OWN `rules.create` entitlement cap (Module 01 §4.3: free
   * 3, pro unlimited), sourced from `canForUser(userId, 'rules.create')`'s
   * `entitlement.limit` — never re-derived or hardcoded here, matching
   * `promoteRuleSeverity`'s own `hardCapLimit` parameter convention (this
   * file stays free of any entitlement-table knowledge, same separation
   * `severity-lifecycle-repository.ts`'s own header establishes). `null`
   * means unlimited (Pro) — the guarded insert below skips the count check
   * entirely in that case, exactly like `resolveQuantityCapability`'s own
   * `limit === null` short-circuit.
   */
  capLimit: number | null;
}

export interface InsertedRule {
  ruleId: string;
  version: number;
}

/**
 * Thrown when `insertRuleAndVersion`'s own guarded INSERT (see that
 * function's header, "CONCURRENCY FIX") returns zero rows — the caller's
 * active-rule count reached `capLimit` between `createRule`'s own earlier,
 * non-atomic `canForUser` pre-check and this guarded write actually
 * running (the exact race a concurrent/cross-tab double-submit produces).
 * The Server Action layer (`app/(app)/rules/actions.ts`) maps this to the
 * SAME `ENTITLEMENT_LIMIT` user-facing shape the early pre-check already
 * returns — a trader who loses this race sees the same honest "you've
 * reached your rule limit" message, not an internal error, matching
 * `RuleLifecycleConflictError`'s own "lost race -> named, typed error, not
 * a silent no-op or a generic 500" convention.
 */
export class RuleCreateCapExceededError extends Error {
  readonly code = 'RULE_CREATE_CAP_EXCEEDED' as const;
  constructor(
    readonly userId: string,
    readonly capLimit: number | null,
  ) {
    super(
      `User ${userId} already has ${capLimit ?? 'unlimited'} (or more) active rules -- insertRuleAndVersion's own guarded INSERT rejected this new rule rather than exceeding the cap.`,
    );
    this.name = 'RuleCreateCapExceededError';
  }
}

/**
 * §5.1's "save as rule + rule_version 1, severity = soft" — one
 * transaction (`withUserConnection` wraps a single BEGIN/COMMIT/ROLLBACK
 * per call, `lib/supabase/direct.ts`), so a failure on either INSERT
 * leaves neither row behind. `severity` is always `'soft'` and `origin`
 * is always `'authored'` — Module 04 §2.1: "Every rule created soft,
 * regardless of origin" — this pipeline only ever produces the
 * `'authored'` origin (§2.1's other origins — graduated/detected/ai/firm
 * — belong to modules that don't exist yet, per the schema migration's
 * own comment), never a caller-supplied value for either column.
 *
 * CONCURRENCY FIX (2026-08-29, `retrospeq-tester` independent verification
 * pass over Slice 10b, `e2e/rules-general-editor.independent-verify.spec.ts`'s
 * cross-tab race test): `createRule`'s entitlement check
 * (`canForUser(user.id, 'rules.create')`, backed by `rules-usage.ts`'s
 * `countActiveRules`) and this function's write used to be two SEPARATE,
 * unguarded round trips with no atomic guard spanning both — the exact
 * same bug CLASS Slice 7's own `promoteRuleSeverity` fix (see that
 * function's header, "CONCURRENCY FIX (2026-08-25...)") already closed for
 * the `rules.hard` cap. Two concurrent `createRule` calls for the same
 * user, each starting from "2 active rules, cap 3," could each
 * independently read "room for one more" (neither sees the other's still-
 * uncommitted insert under READ COMMITTED) and both commit, landing at 4
 * against a cap of 3 — reproduced 3/3 independent runs, including a
 * genuine two-browser-context cross-tab race with no shared client state.
 *
 * Fixed the same way: `pg_advisory_xact_lock(hashtext(user_id))` as the
 * FIRST statement in this function's transaction, before the guarded
 * INSERT runs. Transaction-scoped, released automatically at this
 * transaction's own COMMIT/ROLLBACK (`withUserConnection` owns both), no
 * manual unlock. A second concurrent `insertRuleAndVersion` call for the
 * SAME user now genuinely blocks on this lock until the first transaction
 * commits or rolls back — at which point its own correlated `count(*)`
 * subquery (the `insert ... select ... where $5::int is null or (select
 * count(*) ...) < $5` guard below, same "fold the cap into the write's own
 * WHERE clause, not a separate read-then-write step" reasoning
 * `promoteRuleSeverity`'s header documents) runs against the already-
 * committed post-insert state and correctly counts 3, failing the `< $5`
 * guard and returning zero rows. Two concurrent creates for TWO DIFFERENT
 * users hash to (almost certainly) different lock keys and never contend.
 *
 * `createRule`'s existing EARLY `canForUser` pre-check in
 * `app/(app)/rules/actions.ts` stays exactly as-is — per
 * `promoteRuleSeverity`'s own precedent, it still performs an earlier,
 * non-atomic pre-check for a fast, friendly `ENTITLEMENT_LIMIT` message in
 * the common (non-racing) case; THIS guarded INSERT is the actual
 * invariant-enforcing backstop, not merely a formality.
 */
export async function insertRuleAndVersion(input: InsertRuleInput): Promise<InsertedRule> {
  return withUserConnection(input.userId, async (client) => {
    // Serializes concurrent creates for the SAME user before the
    // count-guarded INSERT below runs — see this function's own header
    // ("CONCURRENCY FIX") for why the correlated subquery alone is not
    // race-safe without it. Not the same `$1` as the INSERT below (a
    // separate statement, its own parameter list).
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [input.userId]);

    const ruleRes = await client.query<{ id: string }>(
      `insert into retrospeq.rules
         (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       select $1, 1, $2, $3, 'soft', 'authored', $4, 'active'
        where $5::int is null or (
          select count(*)
            from retrospeq.rules r2
           where r2.user_id = $1
             and r2.state = 'active'
        ) < $5
       returning id`,
      [input.userId, input.scope, input.scopeId, input.evaluation, input.capLimit],
    );
    if ((ruleRes.rowCount ?? 0) !== 1) {
      throw new RuleCreateCapExceededError(input.userId, input.capLimit);
    }
    const ruleId = ruleRes.rows[0].id;

    await client.query(
      `insert into retrospeq.rule_versions
         (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
      [ruleId, input.userId, input.operandId, input.op, JSON.stringify(input.value), input.rendered],
    );

    return { ruleId, version: 1 };
  });
}

// ---------------------------------------------------------------------
// editRule
// ---------------------------------------------------------------------

export class RuleNotFoundError extends Error {
  readonly code = 'RULE_NOT_FOUND' as const;
  constructor(readonly ruleId: string) {
    super(`No rule ${ruleId} owned by the calling user.`);
    this.name = 'RuleNotFoundError';
  }
}

export class RuleNotEditableError extends Error {
  readonly code = 'RULE_NOT_EDITABLE' as const;
  constructor(
    readonly ruleId: string,
    readonly state: string,
  ) {
    super(
      `Rule ${ruleId} has state "${state}" — only an 'active' rule may be edited. Module 04 §2.4: retire is lifecycle-final, no pause/resume anywhere.`,
    );
    this.name = 'RuleNotEditableError';
  }
}

/**
 * Lost the concurrency race — see `applyRuleEdit`'s own header for the
 * exact guard. The caller (a future UI slice) should re-fetch the rule's
 * current state and retry with fresh data, the same way a lost optimistic-
 * concurrency check is handled anywhere else in this codebase.
 */
export class RuleEditConflictError extends Error {
  readonly code = 'RULE_EDIT_CONFLICT' as const;
  constructor(
    readonly ruleId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Rule ${ruleId}'s version ${expectedVersion} was already superseded by a concurrent edit before this edit's own guarded UPDATE ran.`,
    );
    this.name = 'RuleEditConflictError';
  }
}

export interface CurrentRuleForEdit {
  ruleId: string;
  scope: 'global' | 'strategy' | 'account';
  scopeId: string | null;
  state: string;
  currentVersion: number;
  operandId: string;
  op: RuleOperator;
  value: unknown;
}

/**
 * The rule's current (non-superseded) version, scoped to the caller's own
 * session via `withUserConnection` — real RLS, not merely an
 * application-layer `WHERE user_id = $1` (which this query still also
 * carries, defense-in-depth, same "two independent redundant checks"
 * posture `lib/ingestion/split-join.ts`'s own header documents).
 */
export async function fetchCurrentRuleForEdit(userId: string, ruleId: string): Promise<CurrentRuleForEdit | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{
      rule_id: string;
      scope: 'global' | 'strategy' | 'account';
      scope_id: string | null;
      state: string;
      current_version: number;
      operand_id: string;
      op: RuleOperator;
      value: unknown;
    }>(
      `select r.id as rule_id, r.scope, r.scope_id, r.state, r.current_version, rv.operand_id, rv.op, rv.value
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.id = $1 and r.user_id = $2`,
      [ruleId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      ruleId: row.rule_id,
      scope: row.scope,
      scopeId: row.scope_id,
      state: row.state,
      currentVersion: row.current_version,
      operandId: row.operand_id,
      op: row.op,
      value: row.value,
    };
  });
}

/**
 * Module 04 §2.5's edit-a-threshold write, one transaction:
 *
 *   (a) UPDATE the current `rule_versions` row's `superseded_at` — the
 *       ONE mutation `rule_versions_forbid_mutation`
 *       (20260823020000_rulebook_schema.sql) permits, null -> now(),
 *       never back. GUARDED (`where rule_id = $1 and version = $2 and
 *       superseded_at is null`) — the exact "atomic conditional UPDATE,
 *       rowCount checked, named error on a lost race" pattern already
 *       established by `lib/ingestion/split-join.ts`'s
 *       `splitTrade`/`joinTrades`/`resolveAmbiguousGroupingAsSingle`
 *       (each guards `and confirmed_at is null`; this guards `and
 *       superseded_at is null` — same shape, different column) and
 *       `lib/ingestion/confirm.ts`. A concurrent `editRule` call that
 *       already superseded THIS version before this UPDATE's own row
 *       lock is acquired makes `rowCount !== 1` here, and this function
 *       aborts the whole transaction (ROLLBACK, via `withUserConnection`'s
 *       own catch — nothing from (b)/(c) below is ever committed) rather
 *       than silently proceeding against a stale precondition — see this
 *       file's own `RuleEditConflictError` doc comment for what a caller
 *       does next.
 *   (b) INSERT the new `rule_versions` row, `version = expectedVersion + 1`.
 *       `rule_versions_current_unique` (the partial unique index on
 *       `(rule_id) where superseded_at is null`) guarantees this is the
 *       only non-superseded row for this rule the instant it commits.
 *   (c) UPDATE `rules.current_version` to match — guarded the same way
 *       (`and current_version = $2`) as an extra, defensive check; given
 *       (a)'s guard already serialises concurrent editors on the SAME
 *       row via Postgres's own row lock, this should never itself lose a
 *       race that (a) didn't already catch — kept as belt-and-suspenders
 *       consistent with this repo's "should be structurally impossible"
 *       throw convention elsewhere (`split-join.ts`), not because a real
 *       gap is expected here.
 */
export async function applyRuleEdit(
  userId: string,
  ruleId: string,
  expectedVersion: number,
  operandId: string,
  op: RuleOperator,
  newValue: unknown,
  rendered: string,
): Promise<{ newVersion: number }> {
  return withUserConnection(userId, async (client) => {
    const supersedeRes = await client.query(
      `update retrospeq.rule_versions
          set superseded_at = now()
        where rule_id = $1 and version = $2 and superseded_at is null`,
      [ruleId, expectedVersion],
    );
    if ((supersedeRes.rowCount ?? 0) !== 1) {
      throw new RuleEditConflictError(ruleId, expectedVersion);
    }

    const newVersion = expectedVersion + 1;
    await client.query(
      `insert into retrospeq.rule_versions
         (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [ruleId, newVersion, userId, operandId, op, JSON.stringify(newValue), rendered],
    );

    const rulesUpdateRes = await client.query(
      `update retrospeq.rules
          set current_version = $2
        where id = $1 and current_version = $3`,
      [ruleId, newVersion, expectedVersion],
    );
    if ((rulesUpdateRes.rowCount ?? 0) !== 1) {
      throw new Error(
        `applyRuleEdit: expected exactly one retrospeq.rules row for id ${ruleId} at current_version ${expectedVersion}, affected ${rulesUpdateRes.rowCount} -- should be structurally impossible given the guarded supersede UPDATE above already succeeded.`,
      );
    }

    return { newVersion };
  });
}
