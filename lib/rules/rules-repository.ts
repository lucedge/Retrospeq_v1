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
}

export interface InsertedRule {
  ruleId: string;
  version: number;
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
 */
export async function insertRuleAndVersion(input: InsertRuleInput): Promise<InsertedRule> {
  return withUserConnection(input.userId, async (client) => {
    const ruleRes = await client.query<{ id: string }>(
      `insert into retrospeq.rules
         (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, $2, $3, 'soft', 'authored', $4, 'active')
       returning id`,
      [input.userId, input.scope, input.scopeId, input.evaluation],
    );
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
