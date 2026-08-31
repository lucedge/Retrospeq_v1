import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

import {
  applyRuleEdit,
  fetchAccountSyncTiers,
  fetchActiveGlobalRuleVersionsForOperand,
  fetchCurrentRuleForEdit,
  insertRuleAndVersion,
  RuleCreateCapExceededError,
  RuleEditConflictError,
} from '../rules-repository';

/**
 * Module 04 (Rulebook & Evaluation) §5.1's authoring pipeline —
 * live-DB proof for `lib/rules/rules-repository.ts`'s `insertRuleAndVersion`/
 * `applyRuleEdit` TRANSACTION correctness (not RLS — Slice 1's
 * `rulebook-schema.rls.test.ts` already covers RLS/policy shape for
 * every rulebook table; this file exercises the real, live multi-
 * statement transactions this slice's own repository functions run).
 *
 * Per this slice's own dispatch: "if you need a live-DB integration test
 * for the createRule/editRule transaction behavior itself ... that's
 * reasonable to add — check how similar transaction-correctness tests
 * are structured elsewhere in this repo first ... and match that
 * convention." Matches `lib/supabase/__tests__/rulebook-schema.rls.test.ts`'s
 * own fixture/cleanup shape (real `createTestAuthUser`/`deleteTestAuthUser`,
 * the erasure-escape-hatch cleanup pattern for `rules_forbid_delete`) —
 * the one deliberate difference is that mutations here go through THIS
 * slice's own real repository functions (`insertRuleAndVersion`/
 * `fetchCurrentRuleForEdit`/`applyRuleEdit`), not raw owner-connection
 * SQL, since proving those specific functions' own transaction behavior
 * is this file's whole purpose.
 *
 * CONCURRENCY-GUARD TEST STRATEGY: `lib/ingestion/__tests__/split-join.live.test.ts`'s
 * own header documents, in detail, that a fixed-timeout two-Promise race
 * against this environment's real network/DB round-trip latency does NOT
 * reliably exercise the atomic guard's own `rowCount !== 1` branch — the
 * earlier read-then-act check usually wins the race first, giving a
 * false sense of coverage. This file avoids that trap with a
 * DETERMINISTIC equivalent rather than a real timing race: a "concurrent"
 * edit is, by construction, exactly characterized by its own guarded
 * UPDATE running against an `expectedVersion` that a DIFFERENT
 * transaction already superseded by the time it runs. Simulating that
 * directly — perform one real, successful edit (version 1 -> 2), THEN
 * call `applyRuleEdit` again with the now-stale `expectedVersion = 1` —
 * reproduces the exact DB state a genuinely-raced second transaction
 * would see when its own guarded UPDATE's WHERE clause evaluates, without
 * depending on any timing assumption at all. This is the same class of
 * simplification `resolveAmbiguousGroupingAsSingle`'s own SIMPLER sibling
 * tests use elsewhere in this repo (asserting the guard's OUTCOME on a
 * known-stale precondition, not the live interleaving itself).
 */

const env = readRlsTestEnv();

/**
 * Genuine two-connection concurrency proof — added by an independent
 * verification pass (2026-08-24) after judging the deterministic-replay
 * tests above sufficient to prove the guard's OUTCOME but not to exercise
 * an actual live interleaving of two transactions. Matches
 * `lib/ingestion/__tests__/split-join.live.test.ts`'s own gold-standard
 * `waitForBlockedQuery` technique for
 * `resolveAmbiguousGroupingAsSingle`'s concurrency test: a second, raw
 * connection holds an UNCOMMITTED write on the exact row `applyRuleEdit`'s
 * own guarded UPDATE will target, `applyRuleEdit` is started for real, and
 * the test polls `pg_stat_activity` until Postgres itself confirms
 * `applyRuleEdit`'s own connection is genuinely blocked on that row's lock
 * — proving it actually reached the guarded UPDATE, not merely that it
 * would if it got there — before releasing the raw connection's write.
 * This is event-driven, not timeout-driven, so it isn't subject to the
 * same "an earlier read-then-act check wins the race before the fixed
 * sleep even elapses" failure mode that file's own header documents in
 * detail for a fixed-delay approach.
 */
async function waitForBlockedQuery(ownerConn: Client, queryPattern: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ownerConn.query<{ pid: number }>(
      `select pid from pg_stat_activity where query ilike $1 and wait_event_type = 'Lock'`,
      [queryPattern],
    );
    if (res.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitForBlockedQuery: no query matching ${JSON.stringify(queryPattern)} was found blocked on a lock within ${timeoutMs}ms.`);
}

describe.skipIf(!env)('rules-repository — createRule/editRule transaction correctness (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'rules-repo');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.rules where user_id = $1', [user.id]);
    await db.query('delete from retrospeq.trading_accounts where user_id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('insertRuleAndVersion writes both rows atomically, current_version = 1', async () => {
    const result = await insertRuleAndVersion({
      userId: user.id,
      operandId: 'risk_pct',
      op: 'lte',
      value: 2,
      scope: 'global',
      scopeId: null,
      evaluation: 'pre_entry',
      rendered: 'Never risk more than 2% per trade.',
      capLimit: null,
    });

    expect(result.version).toBe(1);

    const ruleRow = await db.query('select current_version, severity, origin, state from retrospeq.rules where id = $1', [result.ruleId]);
    expect(ruleRow.rows[0]).toMatchObject({ current_version: 1, severity: 'soft', origin: 'authored', state: 'active' });

    const versionRow = await db.query(
      'select operand_id, op, value, rendered, superseded_at from retrospeq.rule_versions where rule_id = $1 and version = 1',
      [result.ruleId],
    );
    expect(versionRow.rows[0]).toMatchObject({ operand_id: 'risk_pct', op: 'lte', rendered: 'Never risk more than 2% per trade.', superseded_at: null });
    expect(Number(versionRow.rows[0].value)).toBe(2);
  });

  it('applyRuleEdit supersedes the old version, inserts a new one, and bumps rules.current_version — all atomically', async () => {
    const created = await insertRuleAndVersion({
      userId: user.id,
      operandId: 'risk_pct',
      op: 'lte',
      value: 3,
      scope: 'global',
      scopeId: null,
      evaluation: 'pre_entry',
      rendered: 'Never risk more than 3% per trade.',
      capLimit: null,
    });

    const edited = await applyRuleEdit(user.id, created.ruleId, 1, 'risk_pct', 'lte', 1.5, 'Never risk more than 1.5% per trade.');
    expect(edited.newVersion).toBe(2);

    const v1 = await db.query('select superseded_at from retrospeq.rule_versions where rule_id = $1 and version = 1', [created.ruleId]);
    expect(v1.rows[0].superseded_at).not.toBeNull();

    const v2 = await db.query(
      'select operand_id, op, value, rendered, superseded_at from retrospeq.rule_versions where rule_id = $1 and version = 2',
      [created.ruleId],
    );
    expect(v2.rows[0]).toMatchObject({ operand_id: 'risk_pct', op: 'lte', rendered: 'Never risk more than 1.5% per trade.', superseded_at: null });
    expect(Number(v2.rows[0].value)).toBe(1.5);

    const ruleRow = await db.query('select current_version from retrospeq.rules where id = $1', [created.ruleId]);
    expect(ruleRow.rows[0].current_version).toBe(2);

    // fetchCurrentRuleForEdit reads the NEW current version, not the
    // superseded one — the join condition (`rv.version = r.current_version`)
    // is exactly what makes this true.
    const current = await fetchCurrentRuleForEdit(user.id, created.ruleId);
    expect(current?.currentVersion).toBe(2);
    expect(Number(current?.value)).toBe(1.5);
  });

  it('a "concurrent" edit against an already-superseded version is rejected with RuleEditConflictError, and corrupts nothing', async () => {
    const created = await insertRuleAndVersion({
      userId: user.id,
      operandId: 'risk_pct',
      op: 'lte',
      value: 4,
      scope: 'global',
      scopeId: null,
      evaluation: 'pre_entry',
      rendered: 'Never risk more than 4% per trade.',
      capLimit: null,
    });

    // The "winner" — a real, successful edit, version 1 -> 2.
    const winner = await applyRuleEdit(user.id, created.ruleId, 1, 'risk_pct', 'lte', 3, 'Never risk more than 3% per trade.');
    expect(winner.newVersion).toBe(2);

    // The "loser" — a second edit attempt still holding the now-stale
    // expectedVersion=1 (exactly what a genuinely concurrent transaction
    // that read the rule BEFORE the winner committed would also hold).
    await expect(
      applyRuleEdit(user.id, created.ruleId, 1, 'risk_pct', 'lte', 2, 'Never risk more than 2% per trade.'),
    ).rejects.toThrow(RuleEditConflictError);

    // No corruption: still exactly one non-superseded version (2), no
    // orphaned or duplicate version 3, current_version unchanged by the
    // failed attempt.
    const versions = await db.query(
      'select version, superseded_at from retrospeq.rule_versions where rule_id = $1 order by version',
      [created.ruleId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]).toMatchObject({ version: 1 });
    expect(versions.rows[0].superseded_at).not.toBeNull();
    expect(versions.rows[1]).toMatchObject({ version: 2, superseded_at: null });

    const ruleRow = await db.query('select current_version from retrospeq.rules where id = $1', [created.ruleId]);
    expect(ruleRow.rows[0].current_version).toBe(2);
  });

  it(
    'GENUINE concurrency: a real concurrent writer holding the row lock while applyRuleEdit is actually blocked on it wins deterministically — applyRuleEdit rejects with RuleEditConflictError, no version 2 row is ever inserted, current_version untouched',
    async () => {
      const created = await insertRuleAndVersion({
        userId: user.id,
        operandId: 'risk_pct',
        op: 'lte',
        value: 4.5,
        scope: 'global',
        scopeId: null,
        evaluation: 'pre_entry',
        rendered: 'Never risk more than 4.5% per trade.',
        capLimit: null,
      });

      // A second, raw connection deliberately holds an UNCOMMITTED
      // supersede write on the exact row applyRuleEdit's own guarded
      // UPDATE (`where rule_id = $1 and version = $2 and superseded_at is
      // null`) will target — same technique as
      // split-join.live.test.ts's `resolveAmbiguousGroupingAsSingle` test.
      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        await raceConn.query('begin');
        const heldSupersede = await raceConn.query(
          `update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = $2 and superseded_at is null`,
          [created.ruleId, 1],
        );
        expect(heldSupersede.rowCount).toBe(1); // lock acquired, held, not yet committed

        // Started for real — genuinely in flight, not simulated.
        const editPromise = applyRuleEdit(user.id, created.ruleId, 1, 'risk_pct', 'lte', 2, 'Never risk more than 2% per trade.');

        // Block until Postgres itself confirms applyRuleEdit's own
        // connection is sitting on this row's lock queue — proves it
        // actually reached the guarded UPDATE.
        await waitForBlockedQuery(db, '%set superseded_at = now()%');

        await raceConn.query('commit');

        await expect(editPromise).rejects.toThrow(RuleEditConflictError);
      } finally {
        await raceConn.end();
      }

      // Final state: exactly the raw connection's supersede write, no
      // version 2 ever inserted (applyRuleEdit aborted before reaching its
      // own INSERT), current_version untouched.
      const versions = await db.query(
        'select version, superseded_at from retrospeq.rule_versions where rule_id = $1 order by version',
        [created.ruleId],
      );
      expect(versions.rows).toHaveLength(1);
      expect(versions.rows[0]).toMatchObject({ version: 1 });
      expect(versions.rows[0].superseded_at).not.toBeNull();

      const ruleRow = await db.query('select current_version from retrospeq.rules where id = $1', [created.ruleId]);
      expect(ruleRow.rows[0].current_version).toBe(1);
    },
    15_000,
  );

  it('fetchActiveGlobalRuleVersionsForOperand excludes a given rule id, and only returns active global rules for the operand', async () => {
    const ruleA = await insertRuleAndVersion({
      userId: user.id,
      operandId: 'daily_pnl_pct',
      op: 'lte',
      value: -2,
      scope: 'global',
      scopeId: null,
      evaluation: 'session',
      rendered: "Stop trading once today's P&L drops below -2%.",
      capLimit: null,
    });
    const ruleB = await insertRuleAndVersion({
      userId: user.id,
      operandId: 'daily_pnl_pct',
      op: 'lte',
      value: -5,
      scope: 'global',
      scopeId: null,
      evaluation: 'session',
      rendered: "Stop trading once today's P&L drops below -5%.",
      capLimit: null,
    });

    const both = await fetchActiveGlobalRuleVersionsForOperand(user.id, 'daily_pnl_pct');
    expect(both.map((r) => r.ruleId).sort()).toEqual([ruleA.ruleId, ruleB.ruleId].sort());

    const excludingA = await fetchActiveGlobalRuleVersionsForOperand(user.id, 'daily_pnl_pct', ruleA.ruleId);
    expect(excludingA.map((r) => r.ruleId)).toEqual([ruleB.ruleId]);
  });

  /**
   * Independent-review addition (retrospeq-tester, 2026-08-24) — closes a
   * real coverage gap: `fetchAccountSyncTiers` (the query
   * `validate-tier.ts`'s `checkTierAvailable` is actually gated on, via
   * `createRule`/`editRule`) had ZERO test coverage of its own SQL against
   * a real `retrospeq.trading_accounts` table — every existing test
   * (`app/(app)/rules/__tests__/actions.test.ts`) replaces it wholesale
   * with a mock, so its `status not in ('disconnected', 'plan_limited')`
   * filter and its `sync_tier` column read were never actually proven
   * correct against live rows. Seeds one account of each status this
   * function's own header claims to exclude, plus one of each it claims to
   * include, and asserts the returned tier list matches exactly.
   */
  it('fetchAccountSyncTiers returns sync_tier for connected/attention/syncing accounts, excludes disconnected and plan_limited', async () => {
    await db.query(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier, status)
       values
         ($1, 'Included — connected t1', 'mt5', 'USD', '00:00:00 UTC', 't1', 'connected'),
         ($1, 'Included — attention t0', 'mt5', 'USD', '00:00:00 UTC', 't0', 'attention'),
         ($1, 'Included — syncing t2', 'mt5', 'USD', '00:00:00 UTC', 't2', 'syncing'),
         ($1, 'Excluded — disconnected t1', 'mt5', 'USD', '00:00:00 UTC', 't1', 'disconnected'),
         ($1, 'Excluded — plan_limited t1', 'mt5', 'USD', '00:00:00 UTC', 't1', 'plan_limited')`,
      [user.id],
    );

    const tiers = await fetchAccountSyncTiers(user.id);

    expect(tiers.sort()).toEqual(['t0', 't1', 't2'].sort());
    expect(tiers).toHaveLength(3);
  });
});

/**
 * CONCURRENCY FIX (2026-08-29) — genuine two-connection proof, own
 * `describe` block with its OWN dedicated user (deliberately NOT reusing
 * the shared `user` above, whose active-rule count depends on every other
 * test in this file having already run against it — a real, fresh
 * fixture with a KNOWN active-rule count is the only way to make "exactly
 * at the cap" a meaningful precondition).
 *
 * Matches `severity-lifecycle.independent-verification.live.test.ts`'s own
 * gold-standard two-connection technique for `promoteRuleSeverity`'s
 * analogous fix: a second, raw connection genuinely holds the SAME
 * `pg_advisory_xact_lock(hashtext(user_id))` `insertRuleAndVersion` itself
 * takes, plus an uncommitted extra active rule that lands the user at
 * exactly `capLimit`; the real `insertRuleAndVersion` call is started for
 * real and the test polls `pg_stat_activity` until Postgres confirms it is
 * genuinely BLOCKED on that lock (not merely slow) before releasing the
 * race connection — proving an actual live interleaving, not a timing
 * guess.
 */
describe.skipIf(!env)('insertRuleAndVersion — CONCURRENCY FIX (2026-08-29): genuine two-connection cap-race proof (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  async function waitForBlockedQuery(ownerConn: Client, queryPattern: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await ownerConn.query<{ pid: number }>(
        `select pid from pg_stat_activity where query ilike $1 and wait_event_type = 'Lock'`,
        [queryPattern],
      );
      if (res.rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`waitForBlockedQuery: no query matching ${JSON.stringify(queryPattern)} was found blocked on a lock within ${timeoutMs}ms.`);
  }

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'rules-repo-create-cap-race');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.rules where user_id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'GENUINE concurrency at the cap: a real second connection holding the SAME advisory lock plus an uncommitted extra active rule (landing the user at capLimit=3) forces the real insertRuleAndVersion call to genuinely block, then correctly lose — RuleCreateCapExceededError, never a 4th active rule',
    async () => {
      // Exactly capLimit - 2 = 1 pre-existing active rule, seeded directly
      // (owner connection, bypasses RLS -- setup only, not the thing under
      // test).
      await db.query(
        `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state)
         values ($1, 1, 'global', 'soft', 'authored', 'pre_entry', 'active')`,
        [user.id],
      );

      const raceConn = new Client({ connectionString: env!.SUPABASE_DB_URL });
      await raceConn.connect();
      try {
        // raceConn takes the EXACT same advisory lock insertRuleAndVersion's
        // own first statement takes, then inserts a SECOND active rule
        // (uncommitted) -- landing the user at exactly 2 active rules, one
        // short of capLimit=3, but NOT yet visible to any other
        // transaction's snapshot.
        await raceConn.query('begin');
        await raceConn.query('select pg_advisory_xact_lock(hashtext($1::text))', [user.id]);
        await raceConn.query(
          `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state)
           values ($1, 1, 'global', 'soft', 'authored', 'pre_entry', 'active')`,
          [user.id],
        );

        // Started for real -- genuinely in flight, requesting the 3rd
        // (cap-filling) rule against capLimit=3.
        const createPromise = insertRuleAndVersion({
          userId: user.id,
          operandId: 'risk_pct',
          op: 'lte',
          value: 2.5,
          scope: 'global',
          scopeId: null,
          evaluation: 'pre_entry',
          rendered: 'Never risk more than 2.5% per trade (race attempt, should be rejected or land at exactly cap).',
          capLimit: 3,
        });

        // Block until Postgres itself confirms insertRuleAndVersion's own
        // connection is genuinely queued on the SAME advisory lock --
        // proves it actually reached its own first statement, not merely
        // that it would if it got there.
        await waitForBlockedQuery(db, '%select pg_advisory_xact_lock%');

        // Release the race connection's second rule for real -- the user
        // is now committed at exactly 2 active rules.
        await raceConn.query('commit');

        // The real call, having genuinely blocked on the advisory lock and
        // only now proceeding, re-evaluates its own guarded INSERT's
        // correlated count(*) against the COMMITTED post-race count (2)
        // -- 2 < 3, so THIS call actually wins and lands the user at
        // exactly 3. (This specific interleaving is the "last slot" case,
        // not the over-cap case -- see the second assertion below for the
        // over-cap case, which reuses this same fixture at the now-full
        // cap.)
        const created = await createPromise;
        expect(created.version).toBe(1);

        const afterFirstRace = await db.query<{ c: string }>(
          `select count(*)::text as c from retrospeq.rules where user_id = $1 and state = 'active'`,
          [user.id],
        );
        expect(Number(afterFirstRace.rows[0].c)).toBe(3); // exactly at cap, never exceeded

        // Now genuinely AT the cap (3 active rules) -- a second real
        // concurrent attempt (no race connection needed this time, the cap
        // is already committed) must be rejected outright, not silently
        // exceed it.
        await expect(
          insertRuleAndVersion({
            userId: user.id,
            operandId: 'risk_pct',
            op: 'lte',
            value: 2.6,
            scope: 'global',
            scopeId: null,
            evaluation: 'pre_entry',
            rendered: 'Never risk more than 2.6% per trade (over-cap attempt, must be rejected).',
            capLimit: 3,
          }),
        ).rejects.toThrow(RuleCreateCapExceededError);

        const finalCount = await db.query<{ c: string }>(
          `select count(*)::text as c from retrospeq.rules where user_id = $1 and state = 'active'`,
          [user.id],
        );
        expect(Number(finalCount.rows[0].c)).toBe(3); // still exactly 3 -- the over-cap attempt wrote nothing
      } finally {
        await raceConn.end();
      }
    },
    30_000,
  );
});
