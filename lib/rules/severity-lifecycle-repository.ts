import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 04 (Rulebook & Evaluation) §5.7 / §2.4 — Slice 7: the DB access
 * layer behind `app/(app)/rules/actions.ts`'s `promoteRule`/`demoteRule`/
 * `retireRule`. `rules` already has real owner "for all" RLS (Slice 1,
 * `20260823020000_rulebook_schema.sql`) and NO DB trigger restricting
 * which columns an owner UPDATE may touch (unlike `rule_versions`) — so
 * every write here runs under `withUserConnection`, genuinely RLS-enforced,
 * matching `rules-repository.ts`'s established convention rather than
 * `withServiceRoleConnection` (reserved elsewhere in this module for
 * `rule_evaluations`, which Module 02's own confirm transaction owns).
 *
 * Deletion of `rules` is separately, permanently blocked at the DB layer
 * (`rules_forbid_delete`, `20260823030000_rule_evaluations_immutability_
 * trigger.sql`) — nothing in this file attempts a DELETE, and nothing
 * here builds a "reactivate a retired rule" path (story 2.4: "Retire
 * only ... No pause anywhere in the UI or API" — there is deliberately no
 * `reactivateRule`/`unretireRule` function in this file, and no UPDATE
 * anywhere touches `state` back from `'retired'` to `'active'`).
 *
 * CONCURRENCY: every write below is the SAME atomic-conditional-UPDATE
 * pattern this repo uses everywhere for a state transition
 * (`rules-repository.ts`'s `applyRuleEdit`, `lib/ingestion/confirm.ts`,
 * `lib/ingestion/split-join.ts`) — the UPDATE's own WHERE clause encodes
 * the expected PRIOR state, `rowCount` is checked, and a lost race throws
 * a named, typed error rather than silently no-op'ing. `promoteRuleSeverity`
 * additionally folds the 6-active-hard-rule cap into the SAME guarded
 * UPDATE (a correlated subquery in the WHERE clause) rather than checking
 * it in a separate read-then-write step — see that function's own header
 * for why a two-step check would leave a genuine race window open for
 * Module 04 §8.2's own property test ("Hard rule count never exceeds 6").
 *
 * CONCURRENCY FIX (2026-08-25, `retrospeq-tester` independent verification
 * pass, `lib/rules/__tests__/severity-lifecycle.independent-verification.
 * live.test.ts`): the correlated `count(*) < $3` subquery described above
 * is NOT by itself race-safe. Postgres only locks the row an UPDATE
 * actually writes (`id = $1`), never the rows a correlated subquery
 * scans — under READ COMMITTED (this pool's isolation level, unchanged),
 * two concurrent `promoteRuleSeverity` calls for two DIFFERENT soft rules
 * belonging to the SAME user, both starting from "5 active hard rules,"
 * can each independently read "5, room for one" (neither sees the
 * other's still-uncommitted write) and both commit, landing at 7 —
 * exactly the invariant §8.2 names. Fixed by taking
 * `pg_advisory_xact_lock(hashtext(user_id))` as the FIRST statement in
 * this function's transaction, before the guarded UPDATE runs. This is a
 * session-level (here, transaction-scoped) advisory lock keyed on the
 * user, held for the lifetime of the surrounding transaction and released
 * automatically at COMMIT/ROLLBACK (no matching unlock call needed, and
 * none would be safe to add manually since `withUserConnection` owns the
 * COMMIT). A second concurrent promotion for the SAME user now genuinely
 * blocks on this lock until the first transaction commits or rolls back
 * — at which point its own correlated subquery runs against the
 * already-committed post-promotion state and correctly counts 6, failing
 * the `< $3` guard. Two concurrent promotions for TWO DIFFERENT users
 * hash to (almost certainly) different lock keys and never contend with
 * each other, so this adds no cross-user serialization cost.
 * `demoteRuleSeverity`/`retireRuleState` do NOT need this lock — both are
 * single-row guarded UPDATEs with no cross-row correlated subquery, so
 * Postgres's own row lock on the single target row already serializes two
 * concurrent callers correctly (independently proven live by the same
 * tester pass, via `waitForBlockedQuery`).
 */

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export interface RuleForLifecycle {
  ruleId: string;
  severity: 'soft' | 'hard';
  state: string;
  createdAt: string;
}

interface RuleForLifecycleRow {
  rule_id: string;
  severity: 'soft' | 'hard';
  state: string;
  created_at: string;
}

/** Ownership + current severity/state, for `demoteRule`/`retireRule`'s own
 *  pre-checks (`promoteRule` gets the same facts from
 *  `checkPromotionEligibilityForUser`'s result instead, to avoid a second
 *  redundant fetch of the same row). `null` when the rule doesn't exist or
 *  isn't owned by `userId` -- matching `rules-repository.ts`'s
 *  `fetchCurrentRuleForEdit` null-return convention, not a thrown error,
 *  since a "not found" caller here (a Server Action) already has its own
 *  established `RULE_NOT_FOUND` handling shape for that case. */
export async function fetchRuleForLifecycle(userId: string, ruleId: string): Promise<RuleForLifecycle | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<RuleForLifecycleRow>(
      `select id as rule_id, severity, state, created_at::text as created_at
         from retrospeq.rules
        where id = $1 and user_id = $2`,
      [ruleId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ruleId: row.rule_id, severity: row.severity, state: row.state, createdAt: row.created_at };
  });
}

export interface ActiveHardRule {
  ruleId: string;
  rendered: string;
  promotedAt: string | null;
}

interface ActiveHardRuleRow {
  rule_id: string;
  rendered: string;
  promoted_at: string | null;
}

/**
 * Every currently active hard rule, most recent version's rendered
 * sentence -- exactly the list §6.1's reference markup ("Hard cap: a
 * trade-off, not an error") needs to populate its demote-chooser radio
 * list. Ordered oldest-promoted-first (ties broken by `created_at`) so a
 * future UI has a stable, meaningful default ordering rather than
 * whatever order Postgres happens to return rows in.
 */
export async function fetchActiveHardRules(userId: string): Promise<ActiveHardRule[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<ActiveHardRuleRow>(
      `select r.id as rule_id, rv.rendered, r.promoted_at::text as promoted_at
         from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.user_id = $1
          and r.state = 'active'
          and r.severity = 'hard'
        order by r.promoted_at asc nulls last, r.created_at asc`,
      [userId],
    );
    return res.rows.map((row) => ({ ruleId: row.rule_id, rendered: row.rendered, promotedAt: row.promoted_at }));
  });
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export type SeverityLifecycleOperation = 'promote' | 'demote' | 'retire';
export type SeverityLifecycleConflictCode = 'RULE_PROMOTION_CONFLICT' | 'RULE_DEMOTE_CONFLICT' | 'RULE_RETIRE_CONFLICT';

/**
 * Thrown when a guarded UPDATE's own `rowCount !== 1` -- the rule's
 * severity/state (or, for promotion, the hard-rule count) changed
 * concurrently between this call's own precondition read and its guarded
 * write. The caller (a Server Action) should re-fetch and let the trader
 * retry, the same way `RuleEditConflictError`'s own doc comment describes
 * for `applyRuleEdit`'s lost-race case.
 */
export class RuleLifecycleConflictError extends Error {
  readonly code: SeverityLifecycleConflictCode;
  constructor(
    readonly ruleId: string,
    readonly operation: SeverityLifecycleOperation,
  ) {
    super(
      `Rule ${ruleId}'s severity/state changed concurrently before this ${operation}'s own guarded UPDATE ran.`,
    );
    this.name = 'RuleLifecycleConflictError';
    this.code =
      operation === 'promote' ? 'RULE_PROMOTION_CONFLICT' : operation === 'demote' ? 'RULE_DEMOTE_CONFLICT' : 'RULE_RETIRE_CONFLICT';
  }
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

export interface PromoteRuleSeverityResult {
  promotedAt: string;
}

/**
 * §5.7's soft -> hard transition. `severity` lives on `rules`, not
 * `rule_versions` (confirmed directly against the schema, per this
 * slice's own dispatch instruction not to assume) — this UPDATE never
 * touches `rule_versions`, never creates a new version, and never touches
 * `rule_evaluations` (§5.6: "Promoting a rule from soft to hard must not
 * retroactively reclassify last month's breaks" — Slice 5/6 already
 * guarantee this on the READ side via the frozen `severity` column copied
 * at freeze; this function's whole job on the WRITE side is to do nothing
 * that could violate it, which an UPDATE scoped to exactly the `rules`
 * table by its own SQL text structurally cannot).
 *
 * `hardCapLimit`: the caller-supplied cap (sourced from
 * `lib/entitlements/capability-table.ts`'s `rules.hard` Pro value via
 * `canForUser`, never hardcoded here — this file stays free of any
 * entitlement-table knowledge, the same "repository doesn't import the
 * capability table" separation `can.ts`'s own header establishes for the
 * inverse direction). Folded into the SAME guarded UPDATE's WHERE clause
 * as a correlated subquery (`(select count(*) ... ) < $3`), not checked in
 * a separate read-then-write step beforehand: a two-step check (read the
 * count, decide, then write) would leave a real race window where two
 * concurrent `promoteRule` calls near the cap could both read "5 hard
 * rules, room for one more" and both then write, landing at 7 — exactly
 * the invariant §8.2's own property test names directly ("Hard rule count
 * never exceeds 6"). The action layer (`app/(app)/rules/actions.ts`) still
 * performs an earlier, non-atomic pre-check for a fast, friendly
 * `RULE_HARD_CAP` message in the common (non-racing) case — this UPDATE is
 * the actual invariant-enforcing backstop, not merely a formality.
 */
export async function promoteRuleSeverity(
  userId: string,
  ruleId: string,
  hardCapLimit: number,
): Promise<PromoteRuleSeverityResult> {
  return withUserConnection(userId, async (client) => {
    // Serializes concurrent promotions for the SAME user before the
    // count-guarded UPDATE below runs — see this function's own header
    // ("CONCURRENCY FIX") for why the correlated subquery alone is not
    // race-safe. `pg_advisory_xact_lock` is transaction-scoped: acquired
    // here, automatically released at this transaction's own COMMIT or
    // ROLLBACK (`withUserConnection` owns both), no unlock call needed or
    // safe to add manually. `hashtext($1::text)` (this call's own sole
    // parameter — a separate statement from the UPDATE below, so it is
    // NOT the same $1 as that query's `ruleId`) hashes the user's UUID
    // (cast explicit and defensive, not load-bearing — `userId` is always
    // a string already) into the `int4` key `pg_advisory_xact_lock`
    // expects; a hash collision between two different users' locks would
    // only ever cause harmless extra serialization, never a correctness
    // problem, since the guarded UPDATE's own WHERE clause still scopes
    // strictly to `user_id = $2`.
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [userId]);
    const res = await client.query<{ promoted_at: string }>(
      `update retrospeq.rules
          set severity = 'hard', promoted_at = now()
        where id = $1
          and user_id = $2
          and severity = 'soft'
          and state = 'active'
          and (
            select count(*)
              from retrospeq.rules r2
             where r2.user_id = $2
               and r2.state = 'active'
               and r2.severity = 'hard'
          ) < $3
        returning promoted_at::text as promoted_at`,
      [ruleId, userId, hardCapLimit],
    );
    if ((res.rowCount ?? 0) !== 1) {
      throw new RuleLifecycleConflictError(ruleId, 'promote');
    }
    return { promotedAt: res.rows[0]!.promoted_at };
  });
}

/**
 * §5.7's hard -> soft transition. "User demotes, freely" — no eligibility
 * gate, no entitlement check (demoting never consumes MORE of anything),
 * just the ownership + prior-state guard every write in this file carries.
 */
export async function demoteRuleSeverity(userId: string, ruleId: string): Promise<void> {
  await withUserConnection(userId, async (client) => {
    const res = await client.query(
      `update retrospeq.rules
          set severity = 'soft'
        where id = $1
          and user_id = $2
          and severity = 'hard'
          and state = 'active'`,
      [ruleId, userId],
    );
    if ((res.rowCount ?? 0) !== 1) {
      throw new RuleLifecycleConflictError(ruleId, 'demote');
    }
  });
}

export interface RetireRuleStateResult {
  retiredAt: string;
}

/**
 * Story 2.4's "retire only, timestamped" transition — the ONLY function in
 * this file that ever sets `state`, and it only ever sets it to
 * `'retired'`. There is no sibling function anywhere in this file (or
 * called from `app/(app)/rules/actions.ts`) that sets `state` back to
 * `'active'` from `'retired'` — a one-way transition, deliberately, per
 * the story's own emphasis ("No pause anywhere in the UI or API").
 */
export async function retireRuleState(userId: string, ruleId: string): Promise<RetireRuleStateResult> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ retired_at: string }>(
      `update retrospeq.rules
          set state = 'retired', retired_at = now()
        where id = $1
          and user_id = $2
          and state = 'active'
        returning retired_at::text as retired_at`,
      [ruleId, userId],
    );
    if ((res.rowCount ?? 0) !== 1) {
      throw new RuleLifecycleConflictError(ruleId, 'retire');
    }
    return { retiredAt: res.rows[0]!.retired_at };
  });
}
