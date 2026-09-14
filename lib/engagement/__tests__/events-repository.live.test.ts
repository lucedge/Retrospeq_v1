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
 * Module 07 (Engagement) Slice 2 — independent live-DB verification of
 * `lib/engagement/events-repository.ts` against the real shared dev
 * Supabase Postgres project. Covers §8.2's "replaying a job awards
 * nothing twice" / "XP is monotonically non-decreasing" and §5.5's
 * "insert once" for milestones, plus the append-only trigger's own
 * UPDATE/DELETE refusal (with the erasure escape hatch proven to permit
 * it) — the DB-level half of §4's "append-only ledger" claim, since
 * `rule_evaluations_forbid_update`'s own precedent shows this needs a
 * real live probe, not just a migration-file read.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 07 Slice 2 — events-repository (live DB, independent verification)', () => {
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
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.engagement_events where user_id = $1', [userId]);
      await db.query('delete from retrospeq.milestones where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('emitReviewCompletedEvent is idempotent — replaying the same reviewId awards no extra XP and inserts no second row', async () => {
    const user = await createTestAuthUser(env!, 'engagement-events-review');
    cleanupUserIds.push(user.id);
    const { emitReviewCompletedEvent } = await import('../events-repository');
    const reviewId = '00000000-0000-4000-8000-000000000001';
    const now = new Date('2026-09-15T12:00:00.000Z');

    await emitReviewCompletedEvent({ userId: user.id, reviewId, now });
    await emitReviewCompletedEvent({ userId: user.id, reviewId, now }); // replay

    const events = await db.query(
      `select xp from retrospeq.engagement_events where user_id = $1 and kind = 'review_completed'`,
      [user.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].xp).toBe(25);

    const state = await db.query(`select total_xp from retrospeq.engagement_state where user_id = $1`, [user.id]);
    expect(state.rows[0].total_xp).toBe(25);
  });

  it('total_xp equals the real sum of the ledger across multiple different emission kinds', async () => {
    const user = await createTestAuthUser(env!, 'engagement-events-sum');
    cleanupUserIds.push(user.id);
    const { emitReviewCompletedEvent, emitDayClosedEvent, emitPreEntryVerifiedEvent } = await import(
      '../events-repository'
    );
    const now = new Date('2026-09-15T12:00:00.000Z');

    await emitReviewCompletedEvent({ userId: user.id, reviewId: '00000000-0000-4000-8000-000000000002', now });
    await emitDayClosedEvent({
      userId: user.id,
      accountId: '00000000-0000-4000-8000-000000000003',
      serverDay: '2026-09-14',
      platform: 'manual',
      now,
    });
    await emitPreEntryVerifiedEvent({ userId: user.id, tradeId: '00000000-0000-4000-8000-000000000004', now });

    const sumRes = await db.query(
      `select coalesce(sum(xp), 0)::int as total from retrospeq.engagement_events where user_id = $1`,
      [user.id],
    );
    const stateRes = await db.query(`select total_xp from retrospeq.engagement_state where user_id = $1`, [user.id]);
    expect(stateRes.rows[0].total_xp).toBe(sumRes.rows[0].total);
    expect(stateRes.rows[0].total_xp).toBe(10 + 25 + 5);
  });

  it('day_closed uses manual_entry for a manual-platform account and broker_feed otherwise', async () => {
    const user = await createTestAuthUser(env!, 'engagement-events-platform');
    cleanupUserIds.push(user.id);
    const { emitDayClosedEvent } = await import('../events-repository');
    const now = new Date('2026-09-15T12:00:00.000Z');

    await emitDayClosedEvent({
      userId: user.id,
      accountId: '00000000-0000-4000-8000-0000000000a1',
      serverDay: '2026-09-13',
      platform: 'manual',
      now,
    });
    await emitDayClosedEvent({
      userId: user.id,
      accountId: '00000000-0000-4000-8000-0000000000a2',
      serverDay: '2026-09-13',
      platform: 'mt4',
      now,
    });

    const rows = await db.query(
      `select verification_source from retrospeq.engagement_events where user_id = $1 and kind = 'day_closed' order by verification_source`,
      [user.id],
    );
    expect(rows.rows.map((r) => r.verification_source)).toEqual(['broker_feed', 'manual_entry']);
  });

  it('milestone insert-once: first_closeout fires exactly one milestones row and one milestone_reached event, never twice', async () => {
    const user = await createTestAuthUser(env!, 'engagement-events-milestone');
    cleanupUserIds.push(user.id);
    const { emitDayClosedEvent } = await import('../events-repository');
    const now = new Date('2026-09-15T12:00:00.000Z');

    // Two DIFFERENT day_closed events (different accounts/days) both
    // satisfy "first_closeout" (>= 1 day_closed event) -- the milestone
    // must still only ever be recorded once.
    await emitDayClosedEvent({
      userId: user.id,
      accountId: '00000000-0000-4000-8000-0000000000b1',
      serverDay: '2026-09-10',
      platform: 'manual',
      now,
    });
    await emitDayClosedEvent({
      userId: user.id,
      accountId: '00000000-0000-4000-8000-0000000000b2',
      serverDay: '2026-09-11',
      platform: 'manual',
      now,
    });

    const milestoneRows = await db.query(
      `select milestone_id from retrospeq.milestones where user_id = $1 and milestone_id = 'first_closeout'`,
      [user.id],
    );
    expect(milestoneRows.rows).toHaveLength(1);

    const eventRows = await db.query(
      `select xp from retrospeq.engagement_events where user_id = $1 and kind = 'milestone_reached'`,
      [user.id],
    );
    expect(eventRows.rows).toHaveLength(1);
  });

  it('append-only trigger refuses UPDATE and DELETE on engagement_events outside erasure, even for service_role', async () => {
    const user = await createTestAuthUser(env!, 'engagement-events-immutable');
    cleanupUserIds.push(user.id);
    const { emitDayClosedEvent } = await import('../events-repository');
    const now = new Date('2026-09-15T12:00:00.000Z');
    await emitDayClosedEvent({
      userId: user.id,
      accountId: '00000000-0000-4000-8000-0000000000c1',
      serverDay: '2026-09-09',
      platform: 'manual',
      now,
    });
    const row = await db.query(`select id from retrospeq.engagement_events where user_id = $1`, [user.id]);
    const eventId = row.rows[0].id;

    await expect(
      db.query(`update retrospeq.engagement_events set xp = 999 where id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/);

    await expect(db.query(`delete from retrospeq.engagement_events where id = $1`, [eventId])).rejects.toThrow(
      /append-only/,
    );

    // Erasure escape hatch permits it -- transaction-local, rolled back
    // immediately after so the row still exists for this test's own
    // cleanup step in afterEach.
    await db.query('begin');
    await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
    const delRes = await db.query(`delete from retrospeq.engagement_events where id = $1`, [eventId]);
    expect(delRes.rowCount).toBe(1);
    await db.query('rollback');
  });
});

describe.skipIf(!!env)('events-repository live tests — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
