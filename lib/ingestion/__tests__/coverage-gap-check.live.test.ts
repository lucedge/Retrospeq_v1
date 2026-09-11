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
 * Module 06 (Review & Graduation) Slice 1, story 1.4 —
 * `listUnresolvedCoverageGapsForAccountDay` (`lib/ingestion/trades-repository.ts`)
 * is the PROACTIVE check `close-out/page.tsx` runs before the confirm form
 * ever renders, so the submit control can be genuinely `disabled` before a
 * wasted tap. Per this slice's own dispatch: construct a fixture where a
 * real gap exists and confirm it's correctly flagged, AND confirm a
 * genuinely complete day is correctly NOT flagged (false positives block a
 * trader from ever confirming a fine day; false negatives let story 1.4's
 * whole reason for existing slip through) — plus the cross-user-isolation
 * discipline this repo requires on every repository read, which this
 * function had zero prior test coverage of (confirmed by grep before
 * writing this file — `trades-repository.live.test.ts` never calls it).
 *
 * Uses the SAME half-open-interval semantics
 * (`gap_from < end AND gap_to > start`) `confirmDay`'s own transaction
 * runs (`lib/ingestion/confirm.ts`) — day_rollover fixed at local midnight
 * UTC throughout so the day boundary is exactly `[day 00:00Z, day+1 00:00Z)`.
 */
const env = readRlsTestEnv();
const DAY_ROLLOVER = '00:00:00 UTC';
const SERVER_DAY = '2026-07-05';

describe.skipIf(!env)('lib/ingestion/trades-repository.ts — listUnresolvedCoverageGapsForAccountDay (live DB)', () => {
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
      await db.query('delete from retrospeq.coverage_gaps where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Coverage Gap Check Live Test', 'mt5', 'USD', $2)
       returning id`,
      [userId, DAY_ROLLOVER],
    );
    return res.rows[0].id;
  }

  async function seedGap(
    userId: string,
    accountId: string,
    gapFrom: string,
    gapTo: string,
    resolved: boolean,
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to, resolved_at)
       values ($1, $2, $3::timestamptz, $4::timestamptz, $5)
       returning id`,
      [accountId, userId, gapFrom, gapTo, resolved ? new Date().toISOString() : null],
    );
    return res.rows[0].id;
  }

  it('flags a real, unresolved gap fully inside the day (true positive)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'coverage-gap-true-positive');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const gapId = await seedGap(user.id, accountId, '2026-07-05T10:00:00Z', '2026-07-05T14:00:00Z', false);

    const { listUnresolvedCoverageGapsForAccountDay } = await import('../trades-repository');
    const gaps = await listUnresolvedCoverageGapsForAccountDay(user.id, accountId, SERVER_DAY, DAY_ROLLOVER);

    expect(gaps.map((g) => g.id)).toEqual([gapId]);
  });

  it('flags a gap that only partially overlaps the day boundary (starts the prior day, ends mid-day)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'coverage-gap-partial-overlap');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const gapId = await seedGap(user.id, accountId, '2026-07-04T22:00:00Z', '2026-07-05T02:00:00Z', false);

    const { listUnresolvedCoverageGapsForAccountDay } = await import('../trades-repository');
    const gaps = await listUnresolvedCoverageGapsForAccountDay(user.id, accountId, SERVER_DAY, DAY_ROLLOVER);

    expect(gaps.map((g) => g.id)).toEqual([gapId]);
  });

  it('does NOT flag a genuinely complete day with zero coverage_gaps rows (true negative)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'coverage-gap-clean-day');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);

    const { listUnresolvedCoverageGapsForAccountDay } = await import('../trades-repository');
    const gaps = await listUnresolvedCoverageGapsForAccountDay(user.id, accountId, SERVER_DAY, DAY_ROLLOVER);

    expect(gaps).toEqual([]);
  });

  it('does NOT flag a gap that is entirely before the day (gap_to at exactly day start — half-open boundary)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'coverage-gap-before-day');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    await seedGap(user.id, accountId, '2026-07-04T10:00:00Z', '2026-07-05T00:00:00Z', false);

    const { listUnresolvedCoverageGapsForAccountDay } = await import('../trades-repository');
    const gaps = await listUnresolvedCoverageGapsForAccountDay(user.id, accountId, SERVER_DAY, DAY_ROLLOVER);

    expect(gaps).toEqual([]);
  });

  it('does NOT flag a gap that is entirely after the day (gap_from at exactly day end — half-open boundary)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'coverage-gap-after-day');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    await seedGap(user.id, accountId, '2026-07-06T00:00:00Z', '2026-07-06T05:00:00Z', false);

    const { listUnresolvedCoverageGapsForAccountDay } = await import('../trades-repository');
    const gaps = await listUnresolvedCoverageGapsForAccountDay(user.id, accountId, SERVER_DAY, DAY_ROLLOVER);

    expect(gaps).toEqual([]);
  });

  it('does NOT flag a gap that overlaps the day but has already been resolved', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'coverage-gap-resolved');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    await seedGap(user.id, accountId, '2026-07-05T10:00:00Z', '2026-07-05T14:00:00Z', true);

    const { listUnresolvedCoverageGapsForAccountDay } = await import('../trades-repository');
    const gaps = await listUnresolvedCoverageGapsForAccountDay(user.id, accountId, SERVER_DAY, DAY_ROLLOVER);

    expect(gaps).toEqual([]);
  });

  it("RLS cross-user isolation: a second user's own read sees none of the first user's coverage gaps", async () => {
    if (!env) return;
    const userA = await createTestAuthUser(env, 'coverage-gap-owner');
    const userB = await createTestAuthUser(env, 'coverage-gap-stranger');
    cleanupUserIds.push(userA.id, userB.id);
    const accountId = await seedAccount(userA.id);
    await seedGap(userA.id, accountId, '2026-07-05T10:00:00Z', '2026-07-05T14:00:00Z', false);

    const { listUnresolvedCoverageGapsForAccountDay } = await import('../trades-repository');
    // userB has no trading_accounts row at all matching accountId — RLS on
    // coverage_gaps (owner SELECT only) denies the read outright regardless.
    const gaps = await listUnresolvedCoverageGapsForAccountDay(userB.id, accountId, SERVER_DAY, DAY_ROLLOVER);

    expect(gaps).toEqual([]);
  });
});
