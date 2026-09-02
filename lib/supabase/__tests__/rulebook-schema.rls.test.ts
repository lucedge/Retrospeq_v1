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
 * Module 04 (Rulebook & Evaluation) §3.1,
 * `supabase/migrations/20260823020000_rulebook_schema.sql` +
 * `20260823030000_rule_evaluations_immutability_trigger.sql` — RLS
 * coverage and shape for all 6 rulebook tables, plus the
 * `rule_versions`/`rule_evaluations`/`rules` mutation/delete triggers.
 * Runs against the real, live shared dev/test Supabase Postgres project —
 * skipped (never faked) if the required env vars aren't present, same
 * pattern as every other RLS test file in this repo
 * (`ingestion-schema.rls.test.ts` is the direct precedent this file
 * follows).
 *
 * `trigger_evaluations` (Module 04 §3.1's own final table) is
 * DELIBERATELY not covered here — it was not created by this slice's
 * migration at all (see that migration's own header: it depends on
 * Module 03's `trigger_conditions`, which does not exist yet).
 */
const env = readRlsTestEnv();

const ALL_TABLES = [
  'rules',
  'rule_versions',
  'rule_evaluations',
  'rule_overrides',
  'adherence_weekly',
  'operand_distributions',
] as const;

describe.skipIf(!env)('retrospeq rulebook schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every rulebook table has RLS enabled — 100% coverage, no exceptions (AGENTS.md)', async () => {
    const res = await db.query(
      `select relname, relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'retrospeq' and relname = any($1)`,
      [ALL_TABLES],
    );
    expect(res.rows).toHaveLength(ALL_TABLES.length);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname} should have RLS enabled`).toBe(true);
    }
  });

  it('matches the exact per-table policy shape this migration documents', async () => {
    const res = await db.query(
      `select tablename, policyname, cmd
         from pg_policies
        where schemaname = 'retrospeq' and tablename = any($1)
        order by tablename, cmd`,
      [ALL_TABLES],
    );
    const shape = new Map<string, string[]>();
    for (const row of res.rows) {
      const cmds = shape.get(row.tablename) ?? [];
      cmds.push(row.cmd);
      shape.set(row.tablename, cmds);
    }

    const expectedShape: Record<(typeof ALL_TABLES)[number], string[]> = {
      rules: ['ALL'],
      rule_versions: ['SELECT', 'INSERT', 'UPDATE'],
      rule_evaluations: ['SELECT'],
      rule_overrides: ['SELECT', 'INSERT'],
      adherence_weekly: ['SELECT'],
      operand_distributions: ['SELECT'],
    };

    for (const table of ALL_TABLES) {
      expect((shape.get(table) ?? []).sort(), `${table} policy command set`).toEqual(
        [...expectedShape[table]].sort(),
      );
    }
  });

  it('the three mutation/delete-forbidding triggers exist on the tables this migration documents', async () => {
    const res = await db.query(
      `select event_object_table, trigger_name, event_manipulation
         from information_schema.triggers
        where trigger_schema = 'retrospeq'
          and event_object_table in ('rule_versions', 'rule_evaluations', 'rules')
        order by event_object_table, trigger_name`,
    );
    const names = res.rows.map((r) => `${r.event_object_table}:${r.trigger_name}:${r.event_manipulation}`);
    expect(names).toContain('rule_versions:rule_versions_forbid_mutation:UPDATE');
    expect(names).toContain('rule_evaluations:rule_evaluations_forbid_update:UPDATE');
    expect(names).toContain('rule_evaluations:rule_evaluations_forbid_delete:DELETE');
    expect(names).toContain('rules:rules_forbid_delete:DELETE');
  });
});

describe.skipIf(!env)('retrospeq rulebook schema — cross-user isolation and trigger behaviour (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let accountA: string;
  let blockA: string;
  let tradeA: string;
  let ruleA: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'rulebook-a');
    userB = await createTestAuthUser(env, 'rulebook-b');

    const acctA = await db.query(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Rulebook RLS Test A', 'mt5', 'USD', '00:00:00 UTC') returning id`,
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

    const rule = await db.query(
      `insert into retrospeq.rules (user_id, origin, evaluation)
       values ($1, 'authored', 'pre_entry') returning id`,
      [userA.id],
    );
    ruleA = rule.rows[0].id;

    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'risk_pct', 'lte', '1.5', 'Never risk more than 1.5% per trade.')`,
      [ruleA, userA.id],
    );
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // Erasure escape hatch, transaction-local -- same pattern
    // ingestion-schema.rls.test.ts already established for cascade
    // deletes that would otherwise trip the trades delete trigger; here
    // it must also stand down rules_forbid_delete /
    // rule_evaluations_forbid_delete for the account-cascade cleanup
    // below. The final `delete from profiles` (added alongside the two
    // pre-existing per-table deletes, not replacing them) closes a
    // separate, newer gap: `20260902010000_field_registry_schema.sql`'s
    // `fields_forbid_derived_delete` trigger, tripped by
    // `deleteTestAuthUser`'s own auth.users cascade otherwise -- see
    // `erasureDeleteProfiles`'s own header in rls-test-helpers.ts for the
    // full account.
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.trades where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.rules where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.profiles where id = any($1)', [[userA.id, userB.id]]);
    await db.query('commit');
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  describe('rules — standard owner "for all"', () => {
    it('user A can select and update severity on their own rule', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.rules set severity = 'hard' where id = $1`, [ruleA]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user B cannot select or update user A's rule", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.rules where id = $1', [ruleA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);

      const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query(`update retrospeq.rules set severity = 'hard' where id = $1`, [ruleA]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('the scope/scope_id CHECK constraint rejects a global rule carrying a scope_id', async () => {
      await expect(
        db.query(
          `insert into retrospeq.rules (user_id, origin, evaluation, scope, scope_id)
           values ($1, 'authored', 'pre_entry', 'global', $2)`,
          [userA.id, tradeA],
        ),
      ).rejects.toThrow(/rules_scope_id_matches_scope/);
    });

    it('the scope/scope_id CHECK constraint rejects a non-global rule with a null scope_id', async () => {
      await expect(
        db.query(
          `insert into retrospeq.rules (user_id, origin, evaluation, scope, scope_id)
           values ($1, 'authored', 'pre_entry', 'strategy', null)`,
          [userA.id],
        ),
      ).rejects.toThrow(/rules_scope_id_matches_scope/);
    });
  });

  describe('rules — rules_forbid_delete trigger', () => {
    it('rejects deleting a rule outside of erasure, even for the service role', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query('delete from retrospeq.rules where id = $1', [ruleA]);
        }),
      ).rejects.toThrow(/cannot delete a rule/);
    });

    it('permits deleting a rule when the erasure escape hatch is set', async () => {
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        await c.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
        const res = await c.query('delete from retrospeq.rules where id = $1', [ruleA]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
      // asRole always rolls back -- ruleA and its rule_versions row are
      // untouched afterward for the next describe block.
    });
  });

  describe('rule_versions — owner SELECT + INSERT + narrowly-restricted UPDATE', () => {
    it('user A can select their own rule_version', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          'select operand_id from retrospeq.rule_versions where rule_id = $1 and version = 1',
          [ruleA],
        );
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].operand_id).toBe('risk_pct');
    });

    it("user B cannot select user A's rule_version", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select operand_id from retrospeq.rule_versions where rule_id = $1', [ruleA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A can insert a new version for their own rule (creates version 2), after superseding version 1', async () => {
      // rule_versions_current_unique (partial unique index on rule_id
      // where superseded_at is null) means version 1 must be superseded
      // FIRST, in the same transaction, before a second un-superseded
      // version can legally exist for the same rule -- this is the real
      // "edit creates a new version" flow §2.5 describes, not two
      // independent inserts.
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        await c.query(`update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 1`, [
          ruleA,
        ]);
        const res = await c.query(
          `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
           values ($1, 2, $2, 'risk_pct', 'lte', '1.0', 'Never risk more than 1.0% per trade.')`,
          [ruleA, userA.id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
      // Not committed beyond this transaction (asRole rolls back) --
      // version 1 remains the sole/current version for the trigger tests
      // below.
    });

    it('the unique partial index rejects a second un-superseded version for the same rule', async () => {
      await asRole(db, 'authenticated', userA.id, async (c) => {
        await expect(
          c.query(
            `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
             values ($1, 2, $2, 'risk_pct', 'lte', '1.0', 'Never risk more than 1.0% per trade.')`,
            [ruleA, userA.id],
          ),
        ).rejects.toThrow(/rule_versions_current_unique/);
      });
    });

    it('user A can set superseded_at from null to a timestamp (the one legitimate mutation)', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 1`,
          [ruleA],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('rule_versions_forbid_mutation rejects changing the body (operand_id/op/value/rendered)', async () => {
      await asRole(db, 'authenticated', userA.id, async (c) => {
        await expect(
          c.query(`update retrospeq.rule_versions set op = 'gte' where rule_id = $1 and version = 1`, [ruleA]),
        ).rejects.toThrow(/only superseded_at may change/);
      });
    });

    it('rule_versions_forbid_mutation rejects changing superseded_at once already set', async () => {
      await asRole(db, 'service_role', null, async (c) => {
        await c.query(`update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 1`, [
          ruleA,
        ]);
        // `clock_timestamp()`, not `now()`, for the second call -- `now()`
        // is STABLE within a transaction (returns the transaction's start
        // time on every call), so two `now()` calls in the same
        // transaction would produce the SAME value and the trigger's own
        // "is distinct from" check would (correctly) treat that as a
        // no-op, not a change -- this needs a genuinely different value to
        // prove the trigger rejects an actual attempted change.
        await expect(
          c.query(
            `update retrospeq.rule_versions set superseded_at = clock_timestamp() where rule_id = $1 and version = 1`,
            [ruleA],
          ),
        ).rejects.toThrow(/superseded_at cannot change once set/);
      });
    });
  });

  describe('rule_evaluations — owner SELECT only, no client write path at all', () => {
    let evaluationId: string;

    beforeAll(async () => {
      if (!env) return;
      const res = await db.query(
        `insert into retrospeq.rule_evaluations
           (user_id, trade_id, rule_id, rule_version, severity, result, server_day)
         values ($1, $2, $3, 1, 'soft', 'followed', current_date) returning id`,
        [userA.id, tradeA, ruleA],
      );
      evaluationId = res.rows[0].id;
    });

    afterAll(async () => {
      if (!env) return;
      // Explicit begin/commit, not two bare autocommit statements --
      // `set_config(..., true)`'s third argument (`is_local`) scopes the
      // setting to the CURRENT TRANSACTION only. Two separate `db.query()`
      // calls with no surrounding `begin`/`commit` each run in their own
      // implicit autocommit transaction, so the flag set in the first
      // statement would not survive to the second -- same explicit
      // begin/commit wrapping `ingestion-schema.rls.test.ts`'s own
      // erasure-escape-hatch cleanup already uses, for the same reason.
      await db.query('begin');
      await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
      await db.query('delete from retrospeq.rule_evaluations where id = $1', [evaluationId]);
      await db.query('commit');
    });

    it('user A can select their own frozen evaluation', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select result from retrospeq.rule_evaluations where id = $1', [evaluationId]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].result).toBe('followed');
    });

    it("user B cannot select user A's evaluation", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.rule_evaluations where id = $1', [evaluationId]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A cannot insert an evaluation directly -- no client INSERT policy at all (Module 02 owns the freeze trigger)', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.rule_evaluations
               (user_id, trade_id, rule_id, rule_version, severity, result, server_day)
             values ($1, $2, $3, 1, 'soft', 'followed', current_date)`,
            [userA.id, tradeA, ruleA],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it('rule_evaluations_forbid_update rejects ANY update, even for the service role', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(`update retrospeq.rule_evaluations set result = 'broken' where id = $1`, [evaluationId]);
        }),
      ).rejects.toThrow(/frozen at write, never updated/);
    });

    it('rule_evaluations_forbid_delete rejects deleting outside of erasure, even for the service role', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query('delete from retrospeq.rule_evaluations where id = $1', [evaluationId]);
        }),
      ).rejects.toThrow(/cannot delete a frozen evaluation/);
    });

    it('rule_evaluations_forbid_delete permits deleting when the erasure escape hatch is set', async () => {
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        await c.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
        const res = await c.query('delete from retrospeq.rule_evaluations where id = $1', [evaluationId]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
      // asRole rolls back -- evaluationId still exists for this
      // describe block's own afterAll cleanup above.
    });
  });

  describe('rule_overrides — owner SELECT + INSERT, append-only', () => {
    it('user A can insert an override for their own rule', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.rule_overrides (user_id, trade_id, rule_id, rule_version, observed)
           values ($1, $2, $3, 1, '2.1')`,
          [userA.id, tradeA, ruleA],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user B cannot see user A's overrides", async () => {
      await db.query(
        `insert into retrospeq.rule_overrides (user_id, trade_id, rule_id, rule_version, observed)
         values ($1, $2, $3, 1, '2.1')`,
        [userA.id, tradeA, ruleA],
      );
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.rule_overrides where rule_id = $1', [ruleA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A cannot update an override -- no UPDATE policy, append-only', async () => {
      const seeded = await db.query(
        `insert into retrospeq.rule_overrides (user_id, trade_id, rule_id, rule_version, observed)
         values ($1, $2, $3, 1, '2.1') returning id`,
        [userA.id, tradeA, ruleA],
      );
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.rule_overrides set observed = '9.9' where id = $1`, [
          seeded.rows[0].id,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });
  });

  describe('adherence_weekly / operand_distributions — owner SELECT only, no client write path', () => {
    beforeAll(async () => {
      if (!env) return;
      await db.query(
        `insert into retrospeq.adherence_weekly (user_id, week_start, hard_followed, hard_total)
         values ($1, date_trunc('week', current_date), 3, 3)`,
        [userA.id],
      );
      await db.query(
        `insert into retrospeq.operand_distributions (user_id, operand_id, buckets, n)
         values ($1, 'risk_pct', '[]', 0)`,
        [userA.id],
      );
    });

    it('user A can select their own materialised rows; user B sees none of them', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const adherence = await c.query('select week_start from retrospeq.adherence_weekly where user_id = $1', [
          userA.id,
        ]);
        const dist = await c.query('select operand_id from retrospeq.operand_distributions where user_id = $1', [
          userA.id,
        ]);
        return { adherence: adherence.rows, dist: dist.rows };
      });
      expect(ownRows.adherence.length).toBeGreaterThanOrEqual(1);
      expect(ownRows.dist).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const adherence = await c.query('select week_start from retrospeq.adherence_weekly where user_id = $1', [
          userA.id,
        ]);
        const dist = await c.query('select operand_id from retrospeq.operand_distributions where user_id = $1', [
          userA.id,
        ]);
        return { adherence: adherence.rows, dist: dist.rows };
      });
      expect(strangerRows.adherence).toHaveLength(0);
      expect(strangerRows.dist).toHaveLength(0);
    });

    it('user A cannot insert an adherence_weekly row directly -- materialised, service-role-only writes', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.adherence_weekly (user_id, week_start) values ($1, current_date + 7)`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it('user A cannot insert an operand_distributions row directly -- materialised, service-role-only writes', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.operand_distributions (user_id, operand_id, buckets, n)
             values ($1, 'hold_seconds', '[]', 0)`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    afterAll(async () => {
      if (!env) return;
      await db.query('delete from retrospeq.adherence_weekly where user_id = $1', [userA.id]);
      await db.query('delete from retrospeq.operand_distributions where user_id = $1', [userA.id]);
    });
  });

  describe('the service role bypasses RLS by design, not a leak', () => {
    it('can read rules across users', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('select user_id from retrospeq.rules where id = $1', [ruleA]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userA.id);
    });
  });
});

describe.skipIf(!!env)('retrospeq rulebook schema RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
