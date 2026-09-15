import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Module 08 (Onboarding & Home) §5.5 — live-DB proof for
 * `field-introduction-repository.ts` and the two new
 * `onboarding-state-repository.ts` writes (`recordFieldsOffered`,
 * `recordFieldsDeclined`) against the real, already-shipped
 * `onboarding_state`/`unlock_state`/`findings`/`fields`/`analytic_renders`
 * schema (no migration added by this slice — every table already exists).
 *
 * Every new user gets 9 real `kind = 'derived'` `fields` rows for free
 * (`seed_derived_fields_for_user`, Module 03's own migration) — this file
 * seeds a real `findings` row + a matching `analytic_renders` row on top of
 * one of those (`drv.day_of_week`), the exact shape the edge engine itself
 * would have written had a strategy actually included that field (see
 * `field-introduction-repository.ts`'s own header for why a stock,
 * zero-field default strategy never reaches this path today).
 */
const env = readRlsTestEnv();

async function setTradesConfirmed(db: Client, userId: string, n: number) {
  await db.query('update retrospeq.unlock_state set trades_confirmed = $2 where user_id = $1', [userId, n]);
}

async function seedQualifyingFinding(db: Client, userId: string) {
  await db.query(
    `insert into retrospeq.findings
       (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
        baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r, confidence, state)
     values ($1, 'find.pickone', null, 'drv.day_of_week', $2::jsonb, 12, 0.70, 0.9, 40, 0.45, 0.2, 0.25, 0.7, 'confident', 'active')`,
    [userId, JSON.stringify({ op: 'eq', value: 'fri' })],
  );
  await db.query(
    `insert into retrospeq.analytic_renders (user_id, analytic_id, surface, payload)
     values ($1, 'find.pickone', 'strategy', $2::jsonb)`,
    [userId, JSON.stringify({ analytic_id: 'find.pickone', confidence: 'confident', statement: 'test render' })],
  );
}

describe.skipIf(!env)('field-introduction-repository (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  afterEach(async () => {
    if (!env) return;
    for (const userId of cleanupUserIds.splice(0)) {
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it(
    'returns null below 30 confirmed trades, even with a real qualifying finding already shown',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'field-offer-below-floor');
      cleanupUserIds.push(user.id);
      await setTradesConfirmed(db, user.id, 29);
      await seedQualifyingFinding(db, user.id);

      const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');
      const result = await fetchFieldIntroductionOfferForUser(user.id, new Date());

      expect(result).toBeNull();
    },
    30_000,
  );

  it(
    'a real derived finding + a confirmed render + 30 trades: returns a real statement AND stamps fields_offered_at exactly once',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'field-offer-eligible');
      cleanupUserIds.push(user.id);
      await setTradesConfirmed(db, user.id, 30);
      await seedQualifyingFinding(db, user.id);

      const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');
      const now = new Date();
      const result = await fetchFieldIntroductionOfferForUser(user.id, now);

      expect(result).not.toBeNull();
      expect(result?.fieldId).toBe('drv.day_of_week');
      expect(result?.statement).toContain('Day of week');

      const row = await db.query('select fields_offered_at from retrospeq.onboarding_state where user_id = $1', [user.id]);
      expect(row.rows[0].fields_offered_at).not.toBeNull();

      // Same episode, immediately again: the cooldown just started, so the
      // offer must NOT re-show (this file's own "not sticky" design —
      // field-introduction-repository.ts's header).
      const second = await fetchFieldIntroductionOfferForUser(user.id, now);
      expect(second).toBeNull();
    },
    30_000,
  );

  it(
    'a finding on a strategy_var (captured) field is EXCLUDED — the offer never frames itself with the thing it exists to introduce',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'field-offer-excludes-captured');
      cleanupUserIds.push(user.id);
      await setTradesConfirmed(db, user.id, 30);

      // A real strategy + a real strategy_var field, matching the
      // fields/strategies schema's own composite-FK shape.
      const strategyRes = await db.query(
        `insert into retrospeq.strategies (user_id, name) values ($1, 'Test strategy') returning id`,
        [user.id],
      );
      const strategyId = strategyRes.rows[0].id;
      const capturedFieldId = 'test.conviction';
      await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
         values ($1, $2, 'Conviction', 'strategy_var', 'rating', 'captured', $3, '{}'::jsonb)`,
        [capturedFieldId, user.id, strategyId],
      );

      await db.query(
        `insert into retrospeq.findings
           (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
            baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r, confidence, state)
         values ($1, 'find.rating', $2, $3, $4::jsonb, 12, 0.71, 0.9, 40, 0.42, 0.2, 0.29, 0.7, 'confident', 'active')`,
        [user.id, strategyId, capturedFieldId, JSON.stringify({ op: 'eq', value: 4 })],
      );
      await db.query(
        `insert into retrospeq.analytic_renders (user_id, analytic_id, surface, payload)
         values ($1, 'find.rating', 'strategy', $2::jsonb)`,
        [user.id, JSON.stringify({ analytic_id: 'find.rating', confidence: 'confident', statement: 'test render' })],
      );

      const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');
      const result = await fetchFieldIntroductionOfferForUser(user.id, new Date());

      expect(result).toBeNull();
    },
    30_000,
  );

  it(
    'recordFieldsOffered/recordFieldsDeclined write the real columns, atomically, without touching stage',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'field-offer-state-writes');
      cleanupUserIds.push(user.id);

      const { recordFieldsOffered, recordFieldsDeclined, fetchOnboardingState } = await import(
        '../onboarding-state-repository'
      );

      const beforeStage = (await fetchOnboardingState(user.id))?.stage;
      expect(beforeStage).toBe('created');

      const offered = await recordFieldsOffered(user.id);
      expect(offered.fieldsOfferedAt).not.toBeNull();
      expect(offered.stage).toBe('created'); // untouched

      const declinedOnce = await recordFieldsDeclined(user.id);
      expect(declinedOnce.fieldsDeclinedCount).toBe(1);
      const declinedTwice = await recordFieldsDeclined(user.id);
      expect(declinedTwice.fieldsDeclinedCount).toBe(2);
      expect(declinedTwice.stage).toBe('created'); // still untouched
    },
    30_000,
  );
});
