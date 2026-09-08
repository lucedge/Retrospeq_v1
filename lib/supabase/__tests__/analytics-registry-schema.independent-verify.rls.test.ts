import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from './rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * INDEPENDENT VERIFICATION — Module 05 (Analytics & Findings) Slice 05a.
 * Written by retrospeq-tester, NOT the coder who built this slice, per
 * this repo's own "independent verification" convention
 * (`lib/rules/__tests__/distributions-repository.independent-verify.*.test.ts`
 * is the direct precedent for this file's naming/shape). Deliberately
 * exercises scenarios the coder's own `analytics-registry-schema.rls.test.ts`
 * / `registry-runtime.live.test.ts` did NOT cover, against the real, live
 * shared dev/test Supabase Postgres project — skipped, never faked, if the
 * required env vars aren't present.
 *
 * Covers:
 *  1. A genuinely MALFORMED analytic_config row (CHECK constraint
 *     temporarily dropped, a bad min_plan/min_account_tier value inserted,
 *     confirming the REAL wired canRender — not just the pure formula —
 *     resolves fail-closed against a real bad row on the wire, not just a
 *     mocked one).
 *  1b. A forced analytic_user_suppression READ failure (SELECT privilege
 *     revoked from `authenticated` for the duration of one assertion) —
 *     confirms canRender fails closed on a suppression-read failure
 *     specifically, not just the config-read failure path the coder's own
 *     tests exercise.
 *  1c. A concurrent config-flip race — confirms every result canRender
 *     produces during a live race is internally coherent (never a torn/
 *     mismatched canRender+reason pair), across many concurrent trials.
 *  2. A fresh user_cohorts self-insert adversarial attempt.
 *  4b. The composite-FK `on delete set null` fix, re-verified for
 *     `field_id` specifically (the coder's own live test only exercised
 *     `strategy_id` — this is the other half of the identical fix).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 05 Slice 05a — independent adversarial verification (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;
  const ANALYTIC_ID = 'iv.independent.verify.analytic';

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'analytics-iv');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [ANALYTIC_ID]);
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.profiles where id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  }, 30_000);

  describe('1a. malformed analytic_config row — CHECK constraint bypassed, real bad row on the wire', () => {
    it('a row with an out-of-vocabulary min_plan (CHECK dropped to allow it) resolves canRender to false, never throws, never a guessed plan', async () => {
      const { canRender } = await import('../../analytics/registry-runtime-service');

      await db.query('alter table retrospeq.analytic_config drop constraint analytic_config_min_plan_check');
      try {
        await db.query(
          `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
           values ($1, true, 'literally_not_a_plan', false, 't0')`,
          [ANALYTIC_ID],
        );

        const result = await canRender(ANALYTIC_ID, user.id, 'weekly');
        expect(result.canRender).toBe(false);
        // Must be treated as unavailable (a row it cannot make sense of),
        // never silently coerced to `disabled`/`plan`/anything that implies
        // the row WAS understood.
        expect(result.reason).toBe('config_unavailable');
      } finally {
        await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [ANALYTIC_ID]);
        await db.query(
          `alter table retrospeq.analytic_config
             add constraint analytic_config_min_plan_check check (min_plan in ('free', 'pro'))`,
        );
      }

      // Constraint genuinely restored — a real bad value is rejected again.
      await expect(
        db.query(
          `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
           values ($1, true, 'still_not_a_plan', false, 't0')`,
          [ANALYTIC_ID],
        ),
      ).rejects.toThrow(/analytic_config_min_plan_check/);
    });

    it('a row with an out-of-vocabulary min_account_tier (CHECK dropped) resolves canRender to false, never throws', async () => {
      const { canRender } = await import('../../analytics/registry-runtime-service');

      await db.query('alter table retrospeq.analytic_config drop constraint analytic_config_min_account_tier_check');
      try {
        await db.query(
          `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
           values ($1, true, 'free', false, 't47')`,
          [ANALYTIC_ID],
        );

        const result = await canRender(ANALYTIC_ID, user.id, 'weekly');
        expect(result).toEqual({ canRender: false, reason: 'config_unavailable' });
      } finally {
        await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [ANALYTIC_ID]);
        await db.query(
          `alter table retrospeq.analytic_config
             add constraint analytic_config_min_account_tier_check check (min_account_tier in ('t0', 't1', 't2'))`,
        );
      }
    });
  });

  describe('1b. a suppression-read failure (not the config-read path) also fails closed', () => {
    it('SELECT revoked from authenticated on analytic_user_suppression -> canRender still resolves false, never throws to the caller', async () => {
      await db.query(
        `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
         values ($1, true, 'free', false, 't0')`,
        [ANALYTIC_ID],
      );

      const { canRender } = await import('../../analytics/registry-runtime-service');

      // Sanity check first: with privileges intact, this analytic renders.
      const before = await canRender(ANALYTIC_ID, user.id, 'weekly');
      expect(before).toEqual({ canRender: true, reason: 'ok' });

      await db.query('revoke select on retrospeq.analytic_user_suppression from authenticated');
      try {
        // The real wired code path — a genuine Postgres permission-denied
        // error on the suppression read, not a mock.
        await expect(canRender(ANALYTIC_ID, user.id, 'weekly')).resolves.toEqual({
          canRender: false,
          reason: 'config_unavailable',
        });
      } finally {
        await db.query('grant select on retrospeq.analytic_user_suppression to authenticated');
      }

      // Privilege genuinely restored — behaviour returns to normal.
      const after = await canRender(ANALYTIC_ID, user.id, 'weekly');
      expect(after).toEqual({ canRender: true, reason: 'ok' });

      await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [ANALYTIC_ID]);
    }, 20_000);
  });

  describe('1c. concurrent config-flip race — every result must be internally coherent', () => {
    it('racing canRender against a concurrent enabled flip never produces a torn/mismatched result, across many trials', async () => {
      await db.query(
        `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
         values ($1, true, 'free', false, 't0')`,
        [ANALYTIC_ID],
      );

      const { canRender } = await import('../../analytics/registry-runtime-service');
      const VALID_REASONS = new Set(['ok', 'config_unavailable', 'not_configured', 'disabled', 'plan', 'cohort', 'suppressed', 'tier']);

      try {
        for (let i = 0; i < 12; i++) {
          const flip = db.query(`update retrospeq.analytic_config set enabled = $2 where analytic_id = $1`, [
            ANALYTIC_ID,
            i % 2 === 0,
          ]);
          const [result] = await Promise.all([canRender(ANALYTIC_ID, user.id, 'weekly'), flip]);

          // Internally coherent: canRender=true implies reason='ok' and
          // nothing else; canRender=false implies a real, known reason.
          // A torn read would show up as canRender true with a
          // non-'ok' reason, or vice versa.
          expect(VALID_REASONS.has(result.reason)).toBe(true);
          if (result.canRender) {
            expect(result.reason).toBe('ok');
          } else {
            expect(result.reason).not.toBe('ok');
          }
        }
      } finally {
        await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [ANALYTIC_ID]);
      }
    }, 30_000);
  });

  describe('2. user_cohorts — fresh self-insert adversarial attempt (docs/adr/0020 re-derived independently)', () => {
    it('the SAME user attempting to self-insert into a DIFFERENT cohort id is still rejected by RLS, not just "beta_traders"', async () => {
      await expect(
        asRole(db, 'authenticated', user.id, async (c) => {
          await c.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'admin_override')`, [user.id]);
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it('a raw UPDATE attempting to self-assign an existing row to a different user_id is also rejected (no UPDATE policy at all)', async () => {
      await db.query(`insert into retrospeq.user_cohorts (user_id, cohort) values ($1, 'beta_traders') on conflict do nothing`, [
        user.id,
      ]);
      const otherUserId = '00000000-0000-0000-0000-000000000099';
      await expect(
        asRole(db, 'authenticated', user.id, async (c) => {
          await c.query(`update retrospeq.user_cohorts set user_id = $1 where cohort = 'beta_traders'`, [otherUserId]);
        }),
      ).resolves.not.toThrow(); // no policy means zero rows affected, not a thrown error
      const check = await db.query(`select user_id from retrospeq.user_cohorts where cohort = 'beta_traders' and user_id = $1`, [
        user.id,
      ]);
      expect(check.rows).toHaveLength(1); // unchanged — the UPDATE affected zero rows
      await db.query(`delete from retrospeq.user_cohorts where user_id = $1`, [user.id]);
    });
  });

  describe('4b. composite FK on delete set null — field_id side, fresh data (the coder\'s own live test only covered strategy_id)', () => {
    it('deleting a field nulls ONLY findings.field_id, leaving user_id and every other column intact', async () => {
      const fieldId = `iv-field-${Date.now()}`;
      await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, config, min_tier, state)
         values ($1, $2, 'IV Test Field', 'account', 'note', 'captured', '{}'::jsonb, 't0', 'active')`,
        [fieldId, user.id],
      );

      const finding = await db.query(
        `insert into retrospeq.findings (user_id, analytic_id, field_id, segment, n, baseline_n, confidence)
         values ($1, 'iv.field.fk.test', $2, '{}'::jsonb, 12, 50, 'provisional') returning id`,
        [user.id, fieldId],
      );
      const findingId = finding.rows[0].id;

      await db.query('delete from retrospeq.fields where user_id = $1 and id = $2', [user.id, fieldId]);

      const after = await db.query('select user_id, field_id, analytic_id from retrospeq.findings where id = $1', [findingId]);
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].field_id).toBeNull();
      // The load-bearing assertion: user_id must survive, not be nulled
      // alongside field_id the way the original bug would have done.
      expect(after.rows[0].user_id).toBe(user.id);
      expect(after.rows[0].analytic_id).toBe('iv.field.fk.test');

      await db.query('delete from retrospeq.findings where id = $1', [findingId]);
    });
  });
});

describe.skipIf(!!env)('Module 05 Slice 05a — independent verification — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
