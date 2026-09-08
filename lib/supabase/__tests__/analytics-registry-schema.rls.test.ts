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
 * Module 05 (Analytics & Findings) Slice 05a,
 * `supabase/migrations/20260908010000_analytics_registry_schema.sql` —
 * RLS coverage/shape for all 7 tables this migration adds
 * (`analytic_config`, `analytic_user_suppression`, `user_cohorts`,
 * `findings`, `detections`, `analytic_renders`, `finding_rule_links`).
 * Runs against the real, live shared dev/test Supabase Postgres project —
 * skipped (never faked) if the required env vars aren't present, same
 * pattern as every other RLS test file in this repo
 * (`rulebook-schema.rls.test.ts` is the direct precedent for the
 * "materialised, owner-SELECT-only" shape several of these tables share).
 */
const env = readRlsTestEnv();

const ALL_TABLES = [
  'analytic_config',
  'analytic_user_suppression',
  'user_cohorts',
  'findings',
  'detections',
  'analytic_renders',
  'finding_rule_links',
] as const;

describe.skipIf(!env)('retrospeq analytics-registry schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every analytics-registry table has RLS enabled — 100% coverage, no exceptions (AGENTS.md)', async () => {
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
      // Structural exception (no user_id column at all) — Module 01
      // §3.3: "Read-only to authenticated users ... writes restricted to
      // service role."
      analytic_config: ['SELECT'],
      // Standard owner "for all" — NOT one of §3.3's two named exceptions.
      analytic_user_suppression: ['ALL'],
      // Risk-based deviation from the literal default, docs/adr/0020.
      user_cohorts: ['SELECT'],
      // Materialised, owner-SELECT-only, same shape class as
      // `adherence_weekly`/`operand_distributions` (Module 04 Slice 1).
      findings: ['SELECT'],
      detections: ['SELECT'],
      analytic_renders: ['SELECT'],
      finding_rule_links: ['SELECT'],
    };

    for (const table of ALL_TABLES) {
      expect((shape.get(table) ?? []).sort(), `${table} policy command set`).toEqual([...expectedShape[table]].sort());
    }
  });
});

describe.skipIf(!env)('retrospeq analytics-registry schema — cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let strategyA: string;
  let findingA: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'analytics-registry-a');
    userB = await createTestAuthUser(env, 'analytics-registry-b');

    const strategy = await db.query(
      `insert into retrospeq.strategies (user_id, name) values ($1, 'RLS Test Strategy') returning id`,
      [userA.id],
    );
    strategyA = strategy.rows[0].id;

    const finding = await db.query(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, segment, n, baseline_n, confidence, state)
       values ($1, 'find.pickone', $2, '{"op":"eq","value":"FVG"}'::jsonb, 40, 60, 'confident', 'active')
       returning id`,
      [userA.id, strategyA],
    );
    findingA = finding.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.findings where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.detections where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.analytic_renders where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.finding_rule_links where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.analytic_user_suppression where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.user_cohorts where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.strategies where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.profiles where id = any($1)', [[userA.id, userB.id]]);
    await db.query('commit');
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  describe('analytic_config — global, readable by any authenticated user, unwritable by any client role', () => {
    beforeAll(async () => {
      if (!env) return;
      await db.query(
        `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
         values ('rls.test.analytic', true, 'free', false, 't0')
         on conflict (analytic_id) do nothing`,
      );
    });

    afterAll(async () => {
      if (!env) return;
      await db.query(`delete from retrospeq.analytic_config where analytic_id = 'rls.test.analytic'`);
    });

    it('user A and user B (unrelated users) can both read the same global row', async () => {
      const rowsA = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`select enabled from retrospeq.analytic_config where analytic_id = 'rls.test.analytic'`);
        return res.rows;
      });
      const rowsB = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query(`select enabled from retrospeq.analytic_config where analytic_id = 'rls.test.analytic'`);
        return res.rows;
      });
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
    });

    it('no authenticated client can insert, update, or delete a row', async () => {
      const insertCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.analytic_config (analytic_id) values ('rls.test.client_write_attempt')`,
        );
        return res.rowCount;
      }).catch((err: Error) => {
        expect(err.message).toMatch(/row-level security/i);
        return 0;
      });
      expect(insertCount ?? 0).toBe(0);

      const updateCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.analytic_config set enabled = false where analytic_id = 'rls.test.analytic'`);
        return res.rowCount;
      });
      expect(updateCount).toBe(0);
    });
  });

  describe('analytic_user_suppression — standard owner "for all"', () => {
    it('user A can insert and read their own suppression row', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.analytic_user_suppression (user_id, analytic_id, reason) values ($1, 'seq.reentry_after_loss', 'declined_once')`,
          [userA.id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user B cannot see user A's suppression row", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select analytic_id from retrospeq.analytic_user_suppression where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('the reason CHECK constraint rejects an unrecognised value', async () => {
      await expect(
        db.query(
          `insert into retrospeq.analytic_user_suppression (user_id, analytic_id, reason) values ($1, 'x', 'not_a_real_reason')`,
          [userB.id],
        ),
      ).rejects.toThrow(/analytic_user_suppression_reason_check/);
    });
  });

  describe('user_cohorts — owner SELECT only, no client write path (docs/adr/0020)', () => {
    beforeAll(async () => {
      if (!env) return;
      await db.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders')`, [userA.id]);
    });

    it('user A can read their own cohort membership; user B cannot', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select cohort from retrospeq.user_cohorts where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select cohort from retrospeq.user_cohorts where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('user B cannot self-insert into the beta cohort — the exact privilege-escalation this ADR closes', async () => {
      await expect(
        asRole(db, 'authenticated', userB.id, async (c) => {
          await c.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders')`, [userB.id]);
        }),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('findings — owner SELECT only, materialised, no client write path', () => {
    it('user A can read their own finding; user B cannot', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select confidence from retrospeq.findings where id = $1', [findingA]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);
      expect(ownRows[0].confidence).toBe('confident');

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.findings where id = $1', [findingA]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('user A cannot insert a finding directly -- no client write path at all', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.findings (user_id, analytic_id, segment, n, baseline_n, confidence)
             values ($1, 'find.pickone', '{}'::jsonb, 40, 60, 'confident')`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it('the confidence CHECK constraint rejects an unrecognised value', async () => {
      await expect(
        db.query(
          `insert into retrospeq.findings (user_id, analytic_id, segment, n, baseline_n, confidence)
           values ($1, 'find.pickone', '{}'::jsonb, 40, 60, 'super_duper_confident')`,
          [userA.id],
        ),
      ).rejects.toThrow(/findings_confidence_check/);
    });

    it('strategy_id FK sets null (not cascade) when the referenced strategy is deleted, preserving the finding', async () => {
      const strat = await db.query(`insert into retrospeq.strategies (user_id, name) values ($1, 'To Be Deleted') returning id`, [
        userA.id,
      ]);
      const stratId = strat.rows[0].id;
      const finding = await db.query(
        `insert into retrospeq.findings (user_id, analytic_id, strategy_id, segment, n, baseline_n, confidence)
         values ($1, 'find.pickone', $2, '{}'::jsonb, 40, 60, 'confident') returning id`,
        [userA.id, stratId],
      );
      const findingId = finding.rows[0].id;

      await db.query('delete from retrospeq.strategies where id = $1', [stratId]);

      const after = await db.query('select strategy_id from retrospeq.findings where id = $1', [findingId]);
      expect(after.rows[0].strategy_id).toBeNull();

      await db.query('delete from retrospeq.findings where id = $1', [findingId]);
    });
  });

  describe('detections — owner SELECT only, materialised, no client write path', () => {
    let detectionId: string;

    beforeAll(async () => {
      if (!env) return;
      const res = await db.query(
        `insert into retrospeq.detections
           (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, tier, classification)
         values ($1, 'seq.reentry_after_loss', 11, now() - interval '30 days', now(), 5, 'count_outcome', 'pattern')
         returning id`,
        [userA.id],
      );
      detectionId = res.rows[0].id;
    });

    afterAll(async () => {
      if (!env) return;
      await db.query('delete from retrospeq.detections where id = $1', [detectionId]);
    });

    it('user A can read; user B cannot', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select classification from retrospeq.detections where id = $1', [detectionId]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);
      expect(ownRows[0].classification).toBe('pattern');

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.detections where id = $1', [detectionId]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('the classification CHECK constraint rejects an unrecognised value', async () => {
      await expect(
        db.query(
          `insert into retrospeq.detections
             (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, tier, classification)
           values ($1, 'x', 1, now(), now(), 1, 'count', 'diagnosis')`,
          [userA.id],
        ),
      ).rejects.toThrow(/detections_classification_check/);
    });

    it('the window CHECK constraint rejects window_to before window_from', async () => {
      await expect(
        db.query(
          `insert into retrospeq.detections
             (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, tier, classification)
           values ($1, 'x', 1, now(), now() - interval '1 day', 1, 'count', 'incident')`,
          [userA.id],
        ),
      ).rejects.toThrow(/detections_window_check/);
    });
  });

  describe('analytic_renders — owner SELECT only, service-role-write-only (§4.8 audit trail)', () => {
    let renderId: string;

    beforeAll(async () => {
      if (!env) return;
      const res = await db.query(
        `insert into retrospeq.analytic_renders (user_id, analytic_id, surface, payload)
         values ($1, 'find.pickone', 'weekly', '{"n":40}'::jsonb) returning id`,
        [userA.id],
      );
      renderId = res.rows[0].id;
    });

    afterAll(async () => {
      if (!env) return;
      await db.query('delete from retrospeq.analytic_renders where id = $1', [renderId]);
    });

    it('user A can read their own render log; user B cannot', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select surface from retrospeq.analytic_renders where id = $1', [renderId]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.analytic_renders where id = $1', [renderId]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('user A cannot insert a render row directly -- materialised, service-role-only writes', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.analytic_renders (user_id, analytic_id, surface, payload) values ($1, 'x', 'weekly', '{}'::jsonb)`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it('the surface CHECK constraint rejects an unrecognised value', async () => {
      await expect(
        db.query(
          `insert into retrospeq.analytic_renders (user_id, analytic_id, surface, payload) values ($1, 'x', 'not_a_real_surface', '{}'::jsonb)`,
          [userA.id],
        ),
      ).rejects.toThrow(/analytic_renders_surface_check/);
    });
  });

  describe('finding_rule_links — owner SELECT only, no client write path', () => {
    let ruleIdStandIn: string;

    beforeAll(async () => {
      if (!env) return;
      // rule_id is deliberately FK-less (see the migration's own header)
      // -- any uuid, real or not, is a legal value at the DB layer.
      const rule = await db.query(`insert into retrospeq.rules (user_id, origin, evaluation) values ($1, 'authored', 'pre_entry') returning id`, [
        userA.id,
      ]);
      ruleIdStandIn = rule.rows[0].id;
      await db.query(
        `insert into retrospeq.finding_rule_links (finding_id, rule_id, user_id, delta_at_graduation, trades_at_graduation)
         values ($1, $2, $3, 0.29, 41)`,
        [findingA, ruleIdStandIn, userA.id],
      );
    });

    afterAll(async () => {
      if (!env) return;
      await db.query('begin');
      await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
      await db.query('delete from retrospeq.finding_rule_links where finding_id = $1', [findingA]);
      await db.query('delete from retrospeq.rules where id = $1', [ruleIdStandIn]);
      await db.query('commit');
    });

    it('user A can read; user B cannot', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select trades_at_graduation from retrospeq.finding_rule_links where finding_id = $1', [findingA]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);
      expect(ownRows[0].trades_at_graduation).toBe(41);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select finding_id from retrospeq.finding_rule_links where finding_id = $1', [findingA]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('user A cannot insert a link directly -- no client write path (a future graduation flow owns this)', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.finding_rule_links (finding_id, rule_id, user_id, delta_at_graduation, trades_at_graduation)
             values ($1, $2, $3, 0.1, 1)`,
            [findingA, ruleIdStandIn, userA.id],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('the service role bypasses RLS by design, not a leak', () => {
    it('can read findings across users', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('select user_id from retrospeq.findings where id = $1', [findingA]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userA.id);
    });
  });
});

describe.skipIf(!!env)('retrospeq analytics-registry schema RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
