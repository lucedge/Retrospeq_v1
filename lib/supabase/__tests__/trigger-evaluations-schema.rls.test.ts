import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from './rls-test-helpers';

/**
 * Module 04 (Rulebook & Evaluation) §3.1's own LAST table,
 * `trigger_evaluations` — `20260909010000_trigger_evaluations_schema.sql`
 * (this slice, Module 03 §4.7's own trigger-condition AUTHORING build).
 * Deliberately a SEPARATE file from `rulebook-schema.rls.test.ts` rather
 * than an edit to that file's own `ALL_TABLES`/`expectedShape` constants —
 * see that file's own updated header for why. Same RLS-shape-audit +
 * cross-user-isolation + immutability-trigger coverage pattern that file
 * already establishes for `rule_evaluations`, applied here.
 *
 * Runs against the real, live shared dev/test Supabase Postgres project —
 * skipped (never faked) if the required env vars aren't present.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq trigger_evaluations schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('trigger_evaluations has RLS enabled (AGENTS.md: 100% coverage, no exceptions)', async () => {
    const res = await db.query(
      `select relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'retrospeq' and relname = 'trigger_evaluations'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('matches the exact policy shape this migration documents — owner SELECT only, no client write path', async () => {
    const res = await db.query(
      `select policyname, cmd
         from pg_policies
        where schemaname = 'retrospeq' and tablename = 'trigger_evaluations'`,
    );
    expect(res.rows.map((r) => r.cmd)).toEqual(['SELECT']);
    expect(res.rows[0].policyname).toBe('trigger_evaluations_owner_select');
  });

  it('the two immutability-backstop triggers exist', async () => {
    const res = await db.query(
      `select trigger_name, event_manipulation
         from information_schema.triggers
        where trigger_schema = 'retrospeq' and event_object_table = 'trigger_evaluations'
        order by trigger_name`,
    );
    const names = res.rows.map((r) => `${r.trigger_name}:${r.event_manipulation}`);
    expect(names).toContain('trigger_evaluations_forbid_update:UPDATE');
    expect(names).toContain('trigger_evaluations_forbid_delete:DELETE');
  });

  it('the result CHECK constraint rejects a value outside met | unmet | unrecorded', async () => {
    // No real trade/condition needed -- the CHECK constraint fires before
    // any FK is even resolved, matching Postgres's own constraint-check
    // ordering (this mirrors field-registry-schema.rls.test.ts's own
    // "state check fires first" precedent for trigger_conditions).
    await expect(
      db.query(
        `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result)
         values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'bogus')`,
      ),
    ).rejects.toThrow(/trigger_evaluations_result_check/);
  });
});

describe.skipIf(!env)('retrospeq trigger_evaluations — cross-user isolation and trigger behaviour (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let accountA: string;
  let blockA: string;
  let tradeA: string;
  let strategyA: string;
  let conditionA: string;
  let evaluationId: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'trigger-eval-a');
    userB = await createTestAuthUser(env, 'trigger-eval-b');

    const acctA = await db.query(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Trigger Eval RLS Test A', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userA.id],
    );
    accountA = acctA.rows[0].id;

    const block = await db.query(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, server_day)
       values ($1, $2, 'EURUSD', now(), current_date) returning id`,
      [userA.id, accountA],
    );
    blockA = block.rows[0].id;

    const trade = await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, server_day, currency, grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', now(), current_date, 'USD', 'confident_single') returning id`,
      [userA.id, accountA, blockA],
    );
    tradeA = trade.rows[0].id;

    const strategy = await db.query(
      `insert into retrospeq.strategies (user_id, name) values ($1, 'Trigger Eval RLS Test Strategy') returning id`,
      [userA.id],
    );
    strategyA = strategy.rows[0].id;

    const condition = await db.query(
      `insert into retrospeq.trigger_conditions (user_id, strategy_id, text)
       values ($1, $2, 'Price above the 20 EMA on the 5-minute') returning id`,
      [userA.id, strategyA],
    );
    conditionA = condition.rows[0].id;

    const evaluation = await db.query(
      `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result)
       values ($1, $2, $3, 'met') returning id`,
      [userA.id, tradeA, conditionA],
    );
    evaluationId = evaluation.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // Explicit begin/commit, erasure escape hatch, same pattern
    // rulebook-schema.rls.test.ts's own cleanup already establishes.
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.trigger_evaluations where id = $1', [evaluationId]);
    await db.query('delete from retrospeq.trigger_conditions where id = $1', [conditionA]);
    await db.query('delete from retrospeq.strategies where id = $1', [strategyA]);
    await db.query('delete from retrospeq.trades where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.profiles where id = any($1)', [[userA.id, userB.id]]);
    await db.query('commit');
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  it('user A can select their own frozen trigger evaluation', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select result from retrospeq.trigger_evaluations where id = $1', [evaluationId]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('met');
  });

  it("user B cannot select user A's trigger evaluation", async () => {
    const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select id from retrospeq.trigger_evaluations where id = $1', [evaluationId]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('user A cannot insert a trigger evaluation directly -- no client INSERT policy at all', async () => {
    await expect(
      asRole(db, 'authenticated', userA.id, async (c) => {
        await c.query(
          `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result)
           values ($1, $2, $3, 'unmet')`,
          [userA.id, tradeA, conditionA],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('trigger_evaluations_forbid_update rejects ANY update, even for the service role', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query(`update retrospeq.trigger_evaluations set result = 'unmet' where id = $1`, [evaluationId]);
      }),
    ).rejects.toThrow(/frozen at write, never updated/);
  });

  it('trigger_evaluations_forbid_delete rejects deleting outside of erasure, even for the service role', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query('delete from retrospeq.trigger_evaluations where id = $1', [evaluationId]);
      }),
    ).rejects.toThrow(/cannot delete a frozen trigger evaluation/);
  });

  it('trigger_evaluations_forbid_delete permits deleting when the erasure escape hatch is set', async () => {
    const rowCount = await asRole(db, 'service_role', null, async (c) => {
      await c.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
      const res = await c.query('delete from retrospeq.trigger_evaluations where id = $1', [evaluationId]);
      return res.rowCount;
    });
    expect(rowCount).toBe(1);
    // asRole rolls back -- evaluationId still exists for this describe
    // block's own afterAll cleanup above.
  });

  it('the unique (trade_id, condition_id) constraint rejects a duplicate evaluation for the same pair', async () => {
    await expect(
      db.query(
        `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result)
         values ($1, $2, $3, 'unmet')`,
        [userA.id, tradeA, conditionA],
      ),
    ).rejects.toThrow(/trigger_evaluations_trade_id_condition_id_key|duplicate key/i);
  });
});
