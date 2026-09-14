import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Regression (security review, Module 07 slice 2): `engagement_events` has a
 * forbid-delete trigger, so erasure failed with "Database error deleting user"
 * for any user holding one ledger row until `executeErasure` deleted it
 * explicitly (`deleteAllEngagementEventsForUser`). Same class as
 * `erasure.trigger-evaluations.independent-verify.live.test.ts`.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('executeErasure with engagement_events + milestones rows (live DB)', () => {
  let db: Client;
  let originalDevFlag: string | undefined;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  beforeEach(() => {
    originalDevFlag = process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS;
    process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS = 'true';
  });

  afterAll(async () => {
    if (!env) return;
    if (originalDevFlag === undefined) delete process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS;
    else process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS = originalDevFlag;
    await db.end();
  });

  it(
    'erases a user with ledger and milestone rows, and both are gone afterward',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure } = await import('../erasure');
      const user = await createTestAuthUser(env, 'erasure-engagement');

      const eventRes = await db.query(
        `insert into retrospeq.engagement_events (user_id, kind, verification_source, subject_type, subject_id, xp)
         values ($1, 'review_completed', 'system_observed', 'review', gen_random_uuid(), 25) returning id`,
        [user.id],
      );
      const eventId = eventRes.rows[0].id;
      await db.query(`insert into retrospeq.milestones (user_id, milestone_id) values ($1, 'first_review')`, [
        user.id,
      ]);

      // Prove the hazard is real: the trigger blocks a plain delete.
      await expect(db.query('delete from retrospeq.engagement_events where id = $1', [eventId])).rejects.toThrow();

      const request = await requestErasure(user.id);
      await executeErasure(request.id, { bypassGracePeriod: true });

      const events = await db.query('select 1 from retrospeq.engagement_events where user_id = $1', [user.id]);
      expect(events.rows).toHaveLength(0);
      const milestones = await db.query('select 1 from retrospeq.milestones where user_id = $1', [user.id]);
      expect(milestones.rows).toHaveLength(0);
      const profile = await db.query('select 1 from retrospeq.profiles where id = $1', [user.id]);
      expect(profile.rows).toHaveLength(0);

      await db
        .query(
          "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
          [user.id],
        )
        .catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    30_000,
  );
});
