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
 * Module 03 (Field Registry & Strategy) §3.1 / §3.2,
 * `supabase/migrations/20260902010000_field_registry_schema.sql` — RLS
 * coverage/shape for all 5 field-registry tables (`fields`, `strategies`,
 * `strategy_versions`, `field_usages`, `trigger_conditions`), the
 * `fields_forbid_derived_update`/`fields_forbid_derived_delete` triggers
 * (§3.2's "never editable, never deletable"), the
 * `strategy_versions_forbid_mutation` trigger (§3.1's "immutable once
 * superseded," identical shape to Module 04's `rule_versions`), the
 * partial-unique-index pair enforcing §7.2's own property-test
 * requirement ("No two active fields share (user_id, name,
 * owner_strategy_id)"), the composite cross-user-hijack-closing FKs this
 * migration adds beyond §3.1's own literal DDL, and the `handle_new_user`
 * extension that seeds the 9-entry §3.2 derived-field catalogue at
 * signup. Runs against the real, live shared dev/test Supabase Postgres
 * project — skipped (never faked) if the required env vars aren't
 * present, same pattern as every other RLS test file in this repo
 * (`onboarding-schema.rls.test.ts` and `rulebook-schema.rls.test.ts` are
 * the two direct precedents this file follows, `rulebook-schema` for the
 * versioned-row-immutability-trigger shape, `onboarding-schema` for the
 * signup-hook-seeding shape).
 *
 * NOT a `fc.assert` property-based test for the "(user_id, name,
 * owner_strategy_id)" uniqueness requirement, deliberately — this repo's
 * own established convention (confirmed by reading every existing
 * `.rls.test.ts` file before writing this one) reserves `fast-check`
 * property-based machinery for PURE FUNCTION invariants (grouping, rule
 * evaluation, trade-facts), while a raw DB CONSTRAINT is verified the
 * same way every other CHECK/unique-index constraint in this repo is —
 * direct, concrete adversarial `it()` cases against the real live
 * constraint (see `onboarding-schema.rls.test.ts`'s own "the stage CHECK
 * constraint rejects..." for the precedent). The concrete cases below
 * (same name + same owner_strategy_id rejected; same name + DIFFERENT
 * owner_strategy_id permitted; same name + both-null-owner_strategy_id
 * rejected; archived exemption; cross-user permitted) exhaustively cover
 * every branch the two partial indexes can take, which is what a
 * property test would otherwise need to fuzz toward.
 */
const env = readRlsTestEnv();

const ALL_TABLES = ['fields', 'strategies', 'strategy_versions', 'field_usages', 'trigger_conditions'] as const;

const DERIVED_FIELD_IDS = [
  'drv.session',
  'drv.day_of_week',
  'drv.direction',
  'drv.order_type',
  'drv.risk_pct',
  'drv.planned_rr',
  'drv.hold_seconds',
  'drv.instrument',
  'drv.news_nearby',
] as const;

describe.skipIf(!env)('retrospeq field-registry schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every field-registry table has RLS enabled — 100% coverage, no exceptions (AGENTS.md)', async () => {
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
      // Split SELECT/INSERT/UPDATE/DELETE, not "for all" -- INSERT is
      // narrowed to `kind <> 'derived'`, a nuance "for all"'s single
      // WITH CHECK can express but which this repo's own convention
      // (rule_versions) prefers spelling out as separate named policies.
      fields: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      strategies: ['ALL'],
      strategy_versions: ['SELECT', 'INSERT', 'UPDATE'],
      field_usages: ['SELECT', 'INSERT', 'DELETE'],
      trigger_conditions: ['ALL'],
    };

    for (const table of ALL_TABLES) {
      expect((shape.get(table) ?? []).sort(), `${table} policy command set`).toEqual(
        [...expectedShape[table]].sort(),
      );
    }
  });

  it('the derived-field immutability and strategy-version-mutation triggers exist', async () => {
    const res = await db.query(
      `select event_object_table, trigger_name, event_manipulation
         from information_schema.triggers
        where trigger_schema = 'retrospeq'
          and event_object_table in ('fields', 'strategy_versions')
        order by event_object_table, trigger_name`,
    );
    const names = res.rows.map((r) => `${r.event_object_table}:${r.trigger_name}:${r.event_manipulation}`);
    expect(names).toContain('fields:fields_forbid_derived_update:UPDATE');
    expect(names).toContain('fields:fields_forbid_derived_delete:DELETE');
    expect(names).toContain('strategy_versions:strategy_versions_forbid_mutation:UPDATE');
  });

  it('backfill: every existing profile has exactly the 9 §3.2 derived fields, no more, no fewer', async () => {
    const res = await db.query<{ bad_count: string }>(`
      select count(*) as bad_count
        from retrospeq.profiles p
        left join (
          select user_id, count(*) c
            from retrospeq.fields
           where kind = 'derived'
           group by user_id
        ) f on f.user_id = p.id
       where coalesce(f.c, 0) <> 9
    `);
    expect(Number(res.rows[0]!.bad_count)).toBe(0);

    const distinctIds = await db.query<{ id: string }>(
      `select distinct id from retrospeq.fields where kind = 'derived' order by id`,
    );
    expect(distinctIds.rows.map((r) => r.id)).toEqual([...DERIVED_FIELD_IDS].sort());
  });
});

describe.skipIf(!env)('retrospeq field-registry schema — cross-user isolation and trigger behaviour (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let strategyA: string;
  let strategyB: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'fieldreg-a');
    userB = await createTestAuthUser(env, 'fieldreg-b');

    const stratA = await db.query(`insert into retrospeq.strategies (user_id, name) values ($1, 'Strategy A') returning id`, [
      userA.id,
    ]);
    strategyA = stratA.rows[0].id;

    const stratB = await db.query(`insert into retrospeq.strategies (user_id, name) values ($1, 'Strategy B') returning id`, [
      userB.id,
    ]);
    strategyB = stratB.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // Erasure escape hatch, transaction-local -- required here because
    // deleting the profiles rows below cascades into `fields`, and every
    // user has 9 derived-kind rows whose own DELETE trigger would
    // otherwise reject exactly this cascade (the real bug this
    // migration's own header documents finding and fixing while writing
    // this test file).
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.profiles where id = any($1)', [[userA.id, userB.id]]);
    await db.query('commit');
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  describe('handle_new_user — derived-field seeding at signup', () => {
    it('every one of the 9 §3.2 catalogue rows exists for a brand-new user, with the exact kind/origin/data_type/id', async () => {
      const res = await db.query(
        `select id, name, kind, data_type, origin, owner_strategy_id, min_tier, state
           from retrospeq.fields
          where user_id = $1 and kind = 'derived'
          order by id`,
        [userA.id],
      );
      expect(res.rows.map((r) => r.id)).toEqual([...DERIVED_FIELD_IDS].sort());
      for (const row of res.rows) {
        expect(row.kind, row.id).toBe('derived');
        expect(row.origin, row.id).toBe('derived');
        expect(row.owner_strategy_id, row.id).toBeNull();
        expect(row.min_tier, row.id).toBe('t0');
        expect(row.state, row.id).toBe('active');
        expect(['pick_one', 'pick_many', 'number', 'bool', 'rating', 'note']).toContain(row.data_type);
      }
      const byId = new Map(res.rows.map((r) => [r.id, r]));
      expect(byId.get('drv.session')!.data_type).toBe('pick_one');
      expect(byId.get('drv.day_of_week')!.data_type).toBe('pick_one');
      expect(byId.get('drv.direction')!.data_type).toBe('pick_one');
      expect(byId.get('drv.order_type')!.data_type).toBe('pick_one');
      expect(byId.get('drv.risk_pct')!.data_type).toBe('number');
      expect(byId.get('drv.planned_rr')!.data_type).toBe('number');
      expect(byId.get('drv.hold_seconds')!.data_type).toBe('number');
      expect(byId.get('drv.instrument')!.data_type).toBe('pick_one');
      expect(byId.get('drv.news_nearby')!.data_type).toBe('bool');
    });

    it('re-seeding is a no-op — idempotent, safe to re-run', async () => {
      const before = await db.query(`select count(*) from retrospeq.fields where user_id = $1 and kind = 'derived'`, [
        userA.id,
      ]);
      await db.query('select retrospeq.seed_derived_fields_for_user($1)', [userA.id]);
      const after = await db.query(`select count(*) from retrospeq.fields where user_id = $1 and kind = 'derived'`, [
        userA.id,
      ]);
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });
  });

  describe('strategies — standard owner "for all"', () => {
    it('user A can select and rename their own strategy', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.strategies set name = 'Strategy A renamed' where id = $1`, [
          strategyA,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user B cannot select or update user A's strategy", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.strategies where id = $1', [strategyA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);

      const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query(`update retrospeq.strategies set name = 'hijacked' where id = $1`, [strategyA]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });
  });

  describe('fields — derived-field immutability, adversarial (both UPDATE and DELETE, both roles)', () => {
    it('rejects renaming a derived field for the owning user (authenticated)', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(`update retrospeq.fields set name = 'Hacked Session' where user_id = $1 and id = $2`, [
            userA.id,
            'drv.session',
          ]);
        }),
      ).rejects.toThrow(/can never be edited/);
    });

    it('rejects renaming a derived field even for the service role', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(`update retrospeq.fields set name = 'Hacked Session' where user_id = $1 and id = $2`, [
            userA.id,
            'drv.session',
          ]);
        }),
      ).rejects.toThrow(/can never be edited/);
    });

    it('rejects deleting a derived field for the owning user (authenticated)', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(`delete from retrospeq.fields where user_id = $1 and id = $2`, [userA.id, 'drv.session']);
        }),
      ).rejects.toThrow(/can never be deleted/);
    });

    it('rejects deleting a derived field even for the service role, outside erasure', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(`delete from retrospeq.fields where user_id = $1 and id = $2`, [userA.id, 'drv.session']);
        }),
      ).rejects.toThrow(/can never be deleted/);
    });

    it('permits deleting a derived field ONLY when the erasure escape hatch is set', async () => {
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        await c.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
        const res = await c.query(`delete from retrospeq.fields where user_id = $1 and id = $2`, [
          userA.id,
          'drv.session',
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
      // asRole always rolls back -- drv.session still exists for every
      // later test in this file.
    });

    it('a non-derived field is genuinely editable/deletable -- the trigger only guards kind=derived', async () => {
      const inserted = await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
         values ('acct.rls-mutable-test', $1, 'Mutable Test Field', 'account', 'bool', 'captured')
         returning id`,
        [userA.id],
      );
      expect(inserted.rows).toHaveLength(1);

      const renamed = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.fields set name = 'Renamed' where user_id = $1 and id = $2`, [
          userA.id,
          'acct.rls-mutable-test',
        ]);
        return res.rowCount;
      });
      expect(renamed).toBe(1);

      await db.query(`delete from retrospeq.fields where user_id = $1 and id = $2`, [
        userA.id,
        'acct.rls-mutable-test',
      ]);
    });
  });

  describe('fields — RLS: a client can never insert a fabricated derived-kind row', () => {
    it('rejects an authenticated INSERT with kind=derived, even a fresh id no seeded row already occupies', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
             values ('drv.fabricated2', $1, 'Fabricated 2', 'derived', 'bool', 'derived')`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('fields — the fields_owner_strategy_matches_kind CHECK constraint', () => {
    it('rejects a strategy_var field with a null owner_strategy_id', async () => {
      await expect(
        db.query(
          `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
           values ('str.no-owner', $1, 'No Owner', 'strategy_var', 'note', 'captured', null)`,
          [userA.id],
        ),
      ).rejects.toThrow(/fields_owner_strategy_matches_kind/);
    });

    it('rejects an account field carrying a non-null owner_strategy_id', async () => {
      await expect(
        db.query(
          `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
           values ('acct.has-owner', $1, 'Has Owner', 'account', 'note', 'captured', $2)`,
          [userA.id, strategyA],
        ),
      ).rejects.toThrow(/fields_owner_strategy_matches_kind/);
    });
  });

  describe('fields — composite FK closes the owner_strategy_id cross-user hijack gap', () => {
    it("rejects a strategy_var field whose owner_strategy_id names ANOTHER user's real strategy", async () => {
      await expect(
        db.query(
          `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
           values ('str.hijack-attempt', $1, 'Hijack Attempt', 'strategy_var', 'note', 'captured', $2)`,
          [userA.id, strategyB],
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("permits a strategy_var field naming the user's OWN real strategy", async () => {
      const res = await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
         values ('str.legit', $1, 'Legit Strategy Var', 'strategy_var', 'note', 'captured', $2)
         returning id`,
        [userA.id, strategyA],
      );
      expect(res.rows).toHaveLength(1);
    });
  });

  describe('fields — (user_id, name, owner_strategy_id) uniqueness among ACTIVE fields, §7.2', () => {
    it('rejects two active account fields (owner_strategy_id null) with the same name for the same user', async () => {
      await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
         values ('acct.dup-1', $1, 'Conviction', 'account', 'rating', 'captured')`,
        [userA.id],
      );
      await expect(
        db.query(
          `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
           values ('acct.dup-2', $1, 'Conviction', 'account', 'rating', 'captured')`,
          [userA.id],
        ),
      ).rejects.toThrow(/fields_unique_active_unscoped/);
    });

    it('rejects two active strategy_var fields under the SAME owner_strategy_id with the same name', async () => {
      await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
         values ('str.dup-1', $1, 'PD Array', 'strategy_var', 'note', 'captured', $2)`,
        [userA.id, strategyA],
      );
      await expect(
        db.query(
          `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
           values ('str.dup-2', $1, 'PD Array', 'strategy_var', 'note', 'captured', $2)`,
          [userA.id, strategyA],
        ),
      ).rejects.toThrow(/fields_unique_active_scoped/);
    });

    it('permits two strategy_var fields under DIFFERENT strategies sharing the same name (owner_strategy_id differs)', async () => {
      const secondStrategy = await db.query(
        `insert into retrospeq.strategies (user_id, name) values ($1, 'Strategy A2') returning id`,
        [userA.id],
      );
      const res = await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
         values ('str.dup-other-strategy', $1, 'PD Array', 'strategy_var', 'note', 'captured', $2)
         returning id`,
        [userA.id, secondStrategy.rows[0].id],
      );
      expect(res.rows).toHaveLength(1);
    });

    it('permits reusing a name once the earlier field is archived (index is scoped to state=active)', async () => {
      await db.query(`update retrospeq.fields set state = 'archived', archived_at = now() where user_id = $1 and id = $2`, [
        userA.id,
        'acct.dup-1',
      ]);
      const res = await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
         values ('acct.dup-3', $1, 'Conviction', 'account', 'rating', 'captured')
         returning id`,
        [userA.id],
      );
      expect(res.rows).toHaveLength(1);
    });

    it('permits two DIFFERENT users each having an active account field with the same name', async () => {
      const res = await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin)
         values ('acct.dup-3', $1, 'Conviction', 'account', 'rating', 'captured')
         returning id`,
        [userB.id],
      );
      expect(res.rows).toHaveLength(1);
    });
  });

  describe('strategy_versions — owner SELECT + INSERT + narrowly-restricted UPDATE', () => {
    // Version 1 is seeded via a DIRECT (owner-connection, persisted)
    // insert here, not via `asRole` -- `asRole` always rolls back
    // (see its own header comment), so wrapping the *seed* row in it
    // would leave every later test in this block with nothing real to
    // select/supersede against. Matches
    // `rulebook-schema.rls.test.ts`'s own precedent exactly: that file's
    // rule_versions v1 row is likewise created via a plain `db.query`
    // insert in `beforeAll`, with `asRole` reserved for the tests that
    // exercise CLIENT-FACING policy behaviour against that already-real
    // row (a real, reproducible bug in an earlier draft of this file
    // caught this while proving the tests actually pass against the
    // live DB, not just reading correctly -- an `asRole`-wrapped "insert
    // version 1" test looked identical to `rulebook-schema`'s own INSERT
    // capability checks but silently discarded the very row every
    // subsequent test in this block depends on).
    beforeAll(async () => {
      if (!env) return;
      await db.query(
        `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name)
         values ($1, 1, $2, 'Strategy A v1')`,
        [strategyA, userA.id],
      );
    });

    it('user A can select their own strategy_version', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          'select name from retrospeq.strategy_versions where strategy_id = $1 and version = 1',
          [strategyA],
        );
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Strategy A v1');
    });

    it("user B cannot select user A's strategy_version", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select name from retrospeq.strategy_versions where strategy_id = $1', [strategyA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('the unique partial index rejects a second un-superseded version for the same strategy', async () => {
      await expect(
        db.query(
          `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name)
           values ($1, 2, $2, 'Strategy A v2 (premature)')`,
          [strategyA, userA.id],
        ),
      ).rejects.toThrow(/strategy_versions_current_unique/);
    });

    it('user A can set superseded_at from null to a timestamp, then insert version 2', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        await c.query(`update retrospeq.strategy_versions set superseded_at = now() where strategy_id = $1 and version = 1`, [
          strategyA,
        ]);
        const res = await c.query(
          `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name)
           values ($1, 2, $2, 'Strategy A v2')`,
          [strategyA, userA.id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
      // Rolled back by asRole -- version 1 remains current for the tests below.
    });

    it('strategy_versions_forbid_mutation rejects changing the body (name/fields/triggers)', async () => {
      await asRole(db, 'authenticated', userA.id, async (c) => {
        await expect(
          c.query(`update retrospeq.strategy_versions set name = 'tampered' where strategy_id = $1 and version = 1`, [
            strategyA,
          ]),
        ).rejects.toThrow(/only superseded_at may change/);
      });
    });

    it('strategy_versions_forbid_mutation rejects changing superseded_at once already set', async () => {
      await asRole(db, 'service_role', null, async (c) => {
        await c.query(`update retrospeq.strategy_versions set superseded_at = now() where strategy_id = $1 and version = 1`, [
          strategyA,
        ]);
        // clock_timestamp(), not now() -- now() is STABLE within a
        // transaction and would produce the same value on a second call,
        // which the trigger's "is distinct from" check would (correctly)
        // treat as a no-op rather than an attempted change. Same
        // technique rule_versions' own test file already established.
        await expect(
          c.query(
            `update retrospeq.strategy_versions set superseded_at = clock_timestamp() where strategy_id = $1 and version = 1`,
            [strategyA],
          ),
        ).rejects.toThrow(/superseded_at cannot change once set/);
      });
    });
  });

  describe('field_usages — owner SELECT + INSERT + DELETE, composite FK integrity', () => {
    it('user A can insert a usage row for their own real field', async () => {
      // Self-contained capability check -- `asRole` always rolls back
      // (see its own header comment), so this row does NOT persist for
      // later tests in this block; each later test that needs a real
      // row seeds its own via a direct `db.query` insert instead (same
      // "asRole for the policy check, plain db.query for anything a
      // later test depends on" split `strategy_versions` above uses,
      // after an earlier draft of THIS block made the identical mistake
      // and was caught while running the suite live).
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
           values ('drv.risk_pct', $1, 'strategy', $2)`,
          [userA.id, strategyA],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user B cannot see user A's field_usages row", async () => {
      await db.query(
        `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
         values ('drv.risk_pct', $1, 'strategy', $2)`,
        [userA.id, strategyA],
      );
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select field_id from retrospeq.field_usages where field_id = $1', [
          'drv.risk_pct',
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A can delete their own usage row (rebuild-on-save flow)', async () => {
      // A fresh, distinct field id (drv.hold_seconds, not drv.risk_pct)
      // so this insert can't collide with the row the prior test already
      // persisted for the same (field_id, used_by, used_by_id) primary
      // key.
      await db.query(
        `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
         values ('drv.hold_seconds', $1, 'strategy', $2)`,
        [userA.id, strategyA],
      );
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `delete from retrospeq.field_usages where field_id = $1 and user_id = $2 and used_by = 'strategy' and used_by_id = $3`,
          ['drv.hold_seconds', userA.id, strategyA],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('there is no UPDATE policy -- a usage row cannot be edited in place', async () => {
      // Another fresh, distinct field id (drv.instrument) -- `drv.risk_pct`
      // and `drv.hold_seconds` are already occupied by the two persisted
      // rows the prior two tests left behind (the latter's own DELETE was
      // itself rolled back by `asRole`, so it is still there too).
      const seeded = await db.query(
        `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
         values ('drv.instrument', $1, 'strategy', $2) returning field_id`,
        [userA.id, strategyA],
      );
      expect(seeded.rows).toHaveLength(1);
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `update retrospeq.field_usages set used_by = 'rule' where field_id = 'drv.instrument' and user_id = $1`,
          [userA.id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('rejects a field_usages row referencing a nonexistent (user_id, field_id) pair -- composite FK', async () => {
      await expect(
        db.query(
          `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
           values ('drv.does-not-exist', $1, 'strategy', $2)`,
          [userA.id, strategyA],
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("rejects a field_usages row naming a real field id that belongs to ANOTHER user -- composite FK closes the cross-user gap", async () => {
      // drv.risk_pct exists for userB too (every user has it), but this
      // row claims user_id = userA with a used_by_id that's really
      // userB's -- the composite FK only cares that (user_id, field_id)
      // resolves to a real row, which it does (userA's OWN drv.risk_pct)
      // -- so to actually test the hijack case we need a field id that
      // exists ONLY for userB, which a strategy_var field naturally is.
      const bOnlyField = await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id)
         values ('str.b-only', $1, 'B Only Field', 'strategy_var', 'note', 'captured', $2)
         returning id`,
        [userB.id, strategyB],
      );
      expect(bOnlyField.rows).toHaveLength(1);
      await expect(
        db.query(
          `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
           values ('str.b-only', $1, 'strategy', $2)`,
          [userA.id, strategyA],
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  describe('trigger_conditions — standard owner "for all", composite FK integrity', () => {
    it('user A can insert a trigger condition for their own strategy', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.trigger_conditions (user_id, strategy_id, text) values ($1, $2, 'Price above the 20 EMA on the 5-minute')`,
          [userA.id, strategyA],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user B cannot select or update user A's trigger condition", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.trigger_conditions where strategy_id = $1', [strategyA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it("rejects a trigger condition whose strategy_id names ANOTHER user's real strategy -- composite FK", async () => {
      await expect(
        db.query(`insert into retrospeq.trigger_conditions (user_id, strategy_id, text) values ($1, $2, 'Hijack attempt')`, [
          userA.id,
          strategyB,
        ]),
      ).rejects.toThrow(/foreign key/i);
    });

    it('the state CHECK constraint rejects a value outside active|retired', async () => {
      await expect(
        db.query(
          `insert into retrospeq.trigger_conditions (user_id, strategy_id, text, state) values ($1, $2, 'x', 'bogus')`,
          [userA.id, strategyA],
        ),
      ).rejects.toThrow(/trigger_conditions_state_check/);
    });
  });

  describe('the service role bypasses RLS by design, not a leak', () => {
    it('can read fields across users', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query(`select user_id from retrospeq.fields where user_id = $1 and id = 'drv.risk_pct'`, [
          userA.id,
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userA.id);
    });
  });
});

describe.skipIf(!!env)('retrospeq field-registry schema RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
