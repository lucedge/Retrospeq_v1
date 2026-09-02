import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * INDEPENDENT RE-VERIFICATION (fresh dispatch), not written by the coder
 * who fixed either `deleteAllFieldsForUser` or `deleteAllRulesForUser`.
 *
 * Both existing regression tests in `erasure.live.test.ts` prove their
 * own fix in relative isolation — one test seeds ONLY derived fields,
 * the other seeds ONLY an authored rule + a frozen `rule_evaluations`
 * row. Neither proves the two fixes co-exist correctly on a single user
 * who has BOTH, plus a real trading account, plus a strategy_var field,
 * plus an account-kind field, plus `field_usages` rows pointing at both
 * a strategy and a rule — the realistic shape of an actual long-time
 * user's data. This file exists specifically to close that gap: it is
 * the scenario most likely to reveal an ordering interaction between
 * `deleteAllRulesForUser` and `deleteAllFieldsForUser`, or a third table
 * with a similar trigger that only manifests when combined with the
 * other two.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('executeErasure — compound fixture, independent re-verification (live DB)', () => {
  let db: Client;
  let originalDevFlag: string | undefined;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    originalDevFlag = process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS;
    process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS = 'true';
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    if (originalDevFlag === undefined) delete process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS;
    else process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS = originalDevFlag;
    await db.end();
  });

  it(
    'a single real user with derived fields + an account field + a strategy_var field + a strategy + ' +
      'field_usages rows + a real confirmed trade + an authored rule + a genuinely-frozen rule_evaluations ' +
      'row — executeErasure completes and every row type is genuinely gone, and auth.admin.deleteUser succeeds',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure } = await import('../erasure');

      const user = await createTestAuthUser(env, 'erasure-compound-verify');

      // --- 1. Derived fields: automatic, 9 rows, asserted not assumed ---
      const derivedBefore = await db.query(
        "select id from retrospeq.fields where user_id = $1 and kind = 'derived'",
        [user.id],
      );
      expect(derivedBefore.rows).toHaveLength(9);

      // --- 2. A real strategy, plus a strategy_var field owned by it ---
      const stratRes = await db.query(
        `insert into retrospeq.strategies (user_id, name) values ($1, 'Compound Verify Strategy') returning id`,
        [user.id],
      );
      const strategyId = stratRes.rows[0].id;

      await db.query(
        `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name)
         values ($1, 1, $2, 'Compound Verify Strategy v1')`,
        [strategyId, user.id],
      );

      await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
         values ('str.compound-verify', $1, 'Compound Verify Strategy Var', 'strategy_var', 'note', 'captured', $2)`,
        [user.id, strategyId],
      );

      // --- 3. An account-kind field ---
      await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
         values ('acct.compound-verify', $1, 'Compound Verify Account Field', 'account', 'rating', 'captured')`,
        [user.id],
      );

      // --- 4. A real trading account + a real broker-confirmed trade ---
      const accountRes = await db.query(
        `insert into retrospeq.trading_accounts
           (user_id, label, platform, base_currency, day_rollover)
         values ($1, 'Compound Verify Account', 'mt5', 'USD', '00:00:00 UTC')
         returning id`,
        [user.id],
      );
      const accountId = accountRes.rows[0].id;

      const blockRes = await db.query(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', now() - interval '2 hours', now() - interval '1 hour', current_date)
         returning id`,
        [user.id, accountId],
      );
      const blockId = blockRes.rows[0].id;

      const fillRes = await db.query(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
         values ($1, $2, 'compound-verify-fill-1', 'EURUSD', 'buy', 100000, 1.1, now() - interval '2 hours', current_date, 'USD')
         returning id`,
        [user.id, accountId],
      );
      const fillId = fillRes.rows[0].id;

      const tradeRes = await db.query(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            currency, grouping_confidence, confirmed_at, confirmed_by)
         values ($1, $2, $3, 'EURUSD', 'long', now() - interval '2 hours', now() - interval '1 hour',
                 current_date, 'confirmed', 'USD', 'confident_single', now(), 'user')
         returning id`,
        [user.id, accountId, blockId],
      );
      const tradeId = tradeRes.rows[0].id;

      await db.query(
        `insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`,
        [tradeId, fillId, user.id],
      );

      // --- 5. An authored rule + a genuinely-frozen rule_evaluations row ---
      const ruleRes = await db.query<{ id: string }>(
        `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state)
         values ($1, 1, 'global', 'soft', 'authored', 'at_close', 'active')
         returning id`,
        [user.id],
      );
      const ruleId = ruleRes.rows[0].id;
      await db.query(
        `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
         values ($1, 1, $2, 'total_open_risk', 'lte', '1'::jsonb, 'Compound erasure verification rule')`,
        [ruleId, user.id],
      );
      await db.query(
        `insert into retrospeq.rule_evaluations
           (user_id, trade_id, rule_id, rule_version, severity, result, observed, server_day)
         values ($1, $2, $3, 1, 'soft', 'broken', '{"total_open_risk": 1.5}'::jsonb, current_date)`,
        [user.id, tradeId, ruleId],
      );

      // --- 6. field_usages rows pointing at BOTH a strategy and a rule ---
      await db.query(
        `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
         values ('str.compound-verify', $1, 'strategy', $2)`,
        [user.id, strategyId],
      );
      await db.query(
        `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
         values ('drv.risk_pct', $1, 'rule', $2)`,
        [user.id, ruleId],
      );

      // --- Sanity checks on the seed itself: every trigger this compound
      // scenario touches genuinely blocks a direct delete outside the
      // erasure escape hatch, so this test proves the fix against real,
      // reproducing hazards, not scenarios that were never actually
      // blocked. ---
      await expect(
        db.query('delete from retrospeq.fields where user_id = $1 and id = $2', [user.id, 'drv.risk_pct']),
      ).rejects.toThrow(/can never be deleted outside of account erasure/);
      await expect(
        db.query('delete from retrospeq.rule_evaluations where rule_id = $1', [ruleId]),
      ).rejects.toThrow(/cannot delete a frozen evaluation/);
      await expect(db.query('delete from retrospeq.rules where id = $1', [ruleId])).rejects.toThrow(
        /rules: cannot delete a rule/,
      );
      await expect(
        db.query('delete from retrospeq.trades where id = $1', [tradeId]),
      ).rejects.toThrow(/cannot delete a broker-confirmed trade/);

      // Full row-count snapshot before erasure, so the "everything gone"
      // assertions below are proven against real counted starting state.
      const before = {
        fields: (await db.query('select 1 from retrospeq.fields where user_id = $1', [user.id])).rows.length,
        strategies: (await db.query('select 1 from retrospeq.strategies where user_id = $1', [user.id])).rows
          .length,
        strategyVersions: (
          await db.query('select 1 from retrospeq.strategy_versions where user_id = $1', [user.id])
        ).rows.length,
        fieldUsages: (await db.query('select 1 from retrospeq.field_usages where user_id = $1', [user.id])).rows
          .length,
        rules: (await db.query('select 1 from retrospeq.rules where user_id = $1', [user.id])).rows.length,
        ruleVersions: (await db.query('select 1 from retrospeq.rule_versions where user_id = $1', [user.id]))
          .rows.length,
        ruleEvaluations: (
          await db.query('select 1 from retrospeq.rule_evaluations where user_id = $1', [user.id])
        ).rows.length,
        tradingAccounts: (
          await db.query('select 1 from retrospeq.trading_accounts where user_id = $1', [user.id])
        ).rows.length,
        trades: (await db.query('select 1 from retrospeq.trades where user_id = $1', [user.id])).rows.length,
      };
      expect(before.fields).toBe(11); // 9 derived + 1 strategy_var + 1 account
      expect(before.strategies).toBe(1);
      expect(before.strategyVersions).toBe(1);
      expect(before.fieldUsages).toBe(2);
      expect(before.rules).toBe(1);
      expect(before.ruleVersions).toBe(1);
      expect(before.ruleEvaluations).toBe(1);
      expect(before.tradingAccounts).toBe(1);
      expect(before.trades).toBe(1);

      // --- THE ACTUAL SUBJECT OF THIS TEST ---
      const request = await requestErasure(user.id);
      await executeErasure(request.id, { bypassGracePeriod: true });

      // --- Every row type genuinely gone, all at once ---
      const after = {
        fields: (await db.query('select 1 from retrospeq.fields where user_id = $1', [user.id])).rows.length,
        strategies: (await db.query('select 1 from retrospeq.strategies where user_id = $1', [user.id])).rows
          .length,
        strategyVersions: (
          await db.query('select 1 from retrospeq.strategy_versions where user_id = $1', [user.id])
        ).rows.length,
        fieldUsages: (await db.query('select 1 from retrospeq.field_usages where user_id = $1', [user.id])).rows
          .length,
        rules: (await db.query('select 1 from retrospeq.rules where user_id = $1', [user.id])).rows.length,
        ruleVersions: (await db.query('select 1 from retrospeq.rule_versions where user_id = $1', [user.id]))
          .rows.length,
        ruleEvaluations: (
          await db.query('select 1 from retrospeq.rule_evaluations where user_id = $1', [user.id])
        ).rows.length,
        tradingAccounts: (
          await db.query('select 1 from retrospeq.trading_accounts where user_id = $1', [user.id])
        ).rows.length,
        trades: (await db.query('select 1 from retrospeq.trades where user_id = $1', [user.id])).rows.length,
      };
      expect(after.fields).toBe(0);
      expect(after.strategies).toBe(0);
      expect(after.strategyVersions).toBe(0);
      expect(after.fieldUsages).toBe(0);
      expect(after.rules).toBe(0);
      expect(after.ruleVersions).toBe(0);
      expect(after.ruleEvaluations).toBe(0);
      expect(after.tradingAccounts).toBe(0);
      expect(after.trades).toBe(0);

      const profileAfter = await db.query('select 1 from retrospeq.profiles where id = $1', [user.id]);
      expect(profileAfter.rows).toHaveLength(0);

      // auth.admin.deleteUser genuinely succeeded — the exact call both
      // isolated bugs independently broke.
      const { createServiceRoleClient } = await import('@/lib/supabase/service');
      const supabase = createServiceRoleClient();
      const { data, error } = await supabase.auth.admin.getUserById(user.id);
      expect(data.user).toBeNull();
      expect(error).not.toBeNull();

      await db
        .query(
          "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
          [user.id],
        )
        .catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    45_000,
  );
});

/**
 * Item 2 — the PK-collision fix (`(user_id, id)` composite primary key,
 * docs/adr/0017), re-verified with a fresh two-user scenario independent
 * of `field-registry-schema.rls.test.ts`'s own fixtures.
 */
describe.skipIf(!env)('fields composite (user_id, id) primary key — fresh re-verification (live DB)', () => {
  let db: Client;
  let userX: TestAuthUser;
  let userY: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userX = await createTestAuthUser(env, 'pk-verify-x');
    userY = await createTestAuthUser(env, 'pk-verify-y');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.profiles where id = any($1)', [[userX.id, userY.id]]);
    await db.query('commit');
    await deleteTestAuthUser(env, userX.id).catch(() => {});
    await deleteTestAuthUser(env, userY.id).catch(() => {});
    await db.end();
  });

  it('both users independently get correctly-scoped drv.risk_pct rows under the SAME literal id', async () => {
    const rows = await db.query(
      `select user_id, id from retrospeq.fields where id = 'drv.risk_pct' and user_id = any($1) order by user_id`,
      [[userX.id, userY.id]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.user_id).sort()).toEqual([userX.id, userY.id].sort());
  });

  it('a direct duplicate (user_id, id) insert for the SAME user is rejected by the composite PK', async () => {
    await expect(
      db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
         values ('drv.risk_pct', $1, 'Duplicate Attempt', 'account', 'number', 'captured')`,
        [userX.id],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "fields_pkey"/);
  });

  it('a non-derived field with the SAME id string is permitted for a DIFFERENT user (id is not globally unique)', async () => {
    // If `fields.id` were still a bare global PK (the bug ADR 0017 fixed),
    // this insert would collide with userX's real 'drv.risk_pct' row even
    // though it belongs to an entirely different user.
    const res = await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
       values ('pk-verify-shared-id', $1, 'User X Field', 'account', 'note', 'captured') returning id`,
      [userX.id],
    );
    expect(res.rows).toHaveLength(1);
    const res2 = await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
       values ('pk-verify-shared-id', $1, 'User Y Field', 'account', 'note', 'captured') returning id`,
      [userY.id],
    );
    expect(res2.rows).toHaveLength(1);
  });
});

/**
 * Item 3 — the two partial unique indexes (`fields_unique_active_scoped`
 * / `fields_unique_active_unscoped`), re-verified with a fresh scenario.
 */
describe.skipIf(!env)('fields partial unique indexes — fresh re-verification (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;
  let strategyOne: string;
  let strategyTwo: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'uniq-verify');
    const s1 = await db.query(`insert into retrospeq.strategies (user_id, name) values ($1, 'Uniq Verify S1') returning id`, [
      user.id,
    ]);
    strategyOne = s1.rows[0].id;
    const s2 = await db.query(`insert into retrospeq.strategies (user_id, name) values ($1, 'Uniq Verify S2') returning id`, [
      user.id,
    ]);
    strategyTwo = s2.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.profiles where id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('two account-kind fields with the same name for the same user are rejected', async () => {
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
       values ('acct.uniq-verify-1', $1, 'Discipline', 'account', 'rating', 'captured')`,
      [user.id],
    );
    await expect(
      db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
         values ('acct.uniq-verify-2', $1, 'Discipline', 'account', 'rating', 'captured')`,
        [user.id],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "fields_unique_active_unscoped"/);
  });

  it('two strategy_var fields with the same name under DIFFERENT strategies are allowed', async () => {
    const r1 = await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
       values ('str.uniq-verify-1', $1, 'Setup Grade', 'strategy_var', 'note', 'captured', $2) returning id`,
      [user.id, strategyOne],
    );
    expect(r1.rows).toHaveLength(1);
    const r2 = await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
       values ('str.uniq-verify-2', $1, 'Setup Grade', 'strategy_var', 'note', 'captured', $2) returning id`,
      [user.id, strategyTwo],
    );
    expect(r2.rows).toHaveLength(1);
  });

  it('two strategy_var fields identical on (name, owner_strategy_id) — same strategy — are rejected', async () => {
    await expect(
      db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
         values ('str.uniq-verify-3', $1, 'Setup Grade', 'strategy_var', 'note', 'captured', $2)`,
        [user.id, strategyOne],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "fields_unique_active_scoped"/);
  });
});

/**
 * Item 4 — the derived-field immutability trigger, re-verified
 * adversarially with a fresh user: rejects the owning user's UPDATE/
 * DELETE, AND rejects a direct service_role attempt OUTSIDE the erasure
 * escape hatch (the critical distinction — the escape hatch must be the
 * ONLY path that can ever remove a derived field).
 */
describe.skipIf(!env)('fields derived-field immutability trigger — fresh adversarial re-verification (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'immut-verify');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.profiles where id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('owning user cannot UPDATE a derived field', async () => {
    await expect(
      asRole(db, 'authenticated', user.id, async (c) => {
        await c.query(`update retrospeq.fields set name = 'tampered' where user_id = $1 and id = 'drv.instrument'`, [
          user.id,
        ]);
      }),
    ).rejects.toThrow(/can never be edited/);
  });

  it('owning user cannot DELETE a derived field', async () => {
    await expect(
      asRole(db, 'authenticated', user.id, async (c) => {
        await c.query(`delete from retrospeq.fields where user_id = $1 and id = 'drv.instrument'`, [user.id]);
      }),
    ).rejects.toThrow(/can never be deleted/);
  });

  it('a direct raw-SQL service_role DELETE, WITHOUT erasure_in_progress set, is still rejected', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        // Deliberately NOT calling set_config here — this is the critical
        // negative case: service_role alone must not be sufficient.
        await c.query(`delete from retrospeq.fields where user_id = $1 and id = 'drv.instrument'`, [user.id]);
      }),
    ).rejects.toThrow(/can never be deleted outside of account erasure/);
  });

  it('a direct raw-SQL service_role UPDATE is also rejected, with no escape hatch at all for UPDATE', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
        await c.query(`update retrospeq.fields set name = 'tampered' where user_id = $1 and id = 'drv.instrument'`, [
          user.id,
        ]);
      }),
    ).rejects.toThrow(/can never be edited/);
  });

  it('WITH erasure_in_progress set, a direct service_role DELETE succeeds — the escape hatch is real and exact', async () => {
    const rowCount = await asRole(db, 'service_role', null, async (c) => {
      await c.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
      const res = await c.query(`delete from retrospeq.fields where user_id = $1 and id = 'drv.instrument'`, [
        user.id,
      ]);
      return res.rowCount;
    });
    expect(rowCount).toBe(1);
    // asRole always rolls back — drv.instrument still exists afterward.
  });
});

describe.skipIf(!!env)('erasure independent-verify compound suite — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
