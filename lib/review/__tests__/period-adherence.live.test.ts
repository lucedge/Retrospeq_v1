import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { fetchPeriodAdherence } from '../period-adherence';
import { weekStartForServerDay, addDaysToServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 06 Slice 2, §4.2 Part 1's "Adherence" panel — live-DB proof of
 * `fetchPeriodAdherence`'s multi-week summation and attribution
 * (docs/adr/0036 decision #5), and honest degrade for a user with no
 * adherence history at all. Dispatch item 2 (multi-week summation,
 * adversarially) and item 5 ("not enough data yet" honesty).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/period-adherence.ts (live DB)', () => {
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
      await db.query('delete from retrospeq.adherence_weekly where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  const week1Start = weekStartForServerDay('2026-06-03');
  const week2Start = addDaysToServerDay(week1Start, 7);
  const periodEnd = addDaysToServerDay(week2Start, 6);
  const priorWeek1Start = addDaysToServerDay(week1Start, -14);
  const priorWeek2Start = addDaysToServerDay(week1Start, -7);

  async function makeRule(userId: string, rendered: string): Promise<string> {
    const rule = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, origin, evaluation) values ($1, 'authored', 'pre_entry') returning id`,
      [userId],
    );
    const ruleId = rule.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'risk_pct', 'lte', '1.0', $3)`,
      [ruleId, userId, rendered],
    );
    return ruleId;
  }

  async function seedWeek(
    userId: string,
    weekStart: string,
    counts: {
      hardFollowed: number;
      hardTotal: number;
      softFollowed: number;
      softTotal: number;
      topBreakRuleId?: string | null;
      topBreakCount?: number | null;
    },
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.adherence_weekly
         (user_id, week_start, hard_followed, hard_total, soft_followed, soft_total, top_break_rule_id, top_break_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        weekStart,
        counts.hardFollowed,
        counts.hardTotal,
        counts.softFollowed,
        counts.softTotal,
        counts.topBreakRuleId ?? null,
        counts.topBreakCount ?? null,
      ],
    );
  }

  it('a user with zero adherence_weekly history gets status: insufficient_history, never a fabricated fraction', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-adherence-empty');
    cleanupUserIds.push(user.id);

    const result = await fetchPeriodAdherence(user.id, week1Start, periodEnd);
    expect(result).toEqual({ status: 'insufficient_history' });
  }, 30_000);

  it('a genuine 2-week period SUMS hard/soft fractions across both weeks, not just the second week relabeled', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-adherence-2week-sum');
    cleanupUserIds.push(user.id);
    const ruleId = await makeRule(user.id, 'Never risk more than 1.0% per trade.');

    await seedWeek(user.id, week1Start, {
      hardFollowed: 17,
      hardTotal: 17,
      softFollowed: 40,
      softTotal: 50,
      topBreakRuleId: ruleId,
      topBreakCount: 6,
    });
    await seedWeek(user.id, week2Start, {
      hardFollowed: 17,
      hardTotal: 17,
      softFollowed: 48,
      softTotal: 52,
      topBreakRuleId: ruleId,
      topBreakCount: 3,
    });

    const result = await fetchPeriodAdherence(user.id, week1Start, periodEnd);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.hard).toEqual({ followed: 34, total: 34 }); // 17+17, genuine sum
    expect(result.soft).toEqual({ followed: 88, total: 102 }); // 40+48 of 50+52

    // Adversarial: not just week 2 relabeled.
    expect(result.soft).not.toEqual({ followed: 48, total: 52 });
  }, 30_000);

  it('attribution: hard always outranks soft in the AGGREGATE, matching per-week behaviour generalised across the period', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-adherence-hard-outranks');
    cleanupUserIds.push(user.id);
    const hardRule = await makeRule(user.id, 'Never trade outside the London session.');
    const softRule = await makeRule(user.id, 'Risk cap 1%.');

    // Week 1: one hard break, several soft breaks (soft has the bigger count).
    await seedWeek(user.id, week1Start, {
      hardFollowed: 9,
      hardTotal: 10,
      softFollowed: 30,
      softTotal: 40,
      topBreakRuleId: hardRule,
      topBreakCount: 1,
    });
    // Week 2: no hard break, more soft breaks.
    await seedWeek(user.id, week2Start, {
      hardFollowed: 10,
      hardTotal: 10,
      softFollowed: 30,
      softTotal: 40,
      topBreakRuleId: softRule,
      topBreakCount: 10,
    });

    const result = await fetchPeriodAdherence(user.id, week1Start, periodEnd);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.attribution).not.toBeNull();
    expect(result.attribution!.severity).toBe('hard');
    expect(result.attribution!.ruleId).toBe(hardRule); // the ONLY week with a hard break wins the hard pool
    expect(result.attribution!.count).toBe(1);
    expect(result.attribution!.ofBreaks).toBe(1); // 1 hard break total across the period
    expect(result.attribution!.rendered).toBe('Never trade outside the London session.');
  }, 30_000);

  it('attribution within one severity pool: the constituent week with the LARGEST topBreakCount wins, tie-broken by earliest week', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-adherence-pool-pick');
    cleanupUserIds.push(user.id);
    const ruleA = await makeRule(user.id, 'Rule A.');
    const ruleB = await makeRule(user.id, 'Rule B.');

    // Both weeks are all-soft (no hard breaks), so the soft pool decides.
    await seedWeek(user.id, week1Start, {
      hardFollowed: 10,
      hardTotal: 10,
      softFollowed: 30,
      softTotal: 40,
      topBreakRuleId: ruleA,
      topBreakCount: 5,
    });
    await seedWeek(user.id, week2Start, {
      hardFollowed: 10,
      hardTotal: 10,
      softFollowed: 25,
      softTotal: 40,
      topBreakRuleId: ruleB,
      topBreakCount: 8,
    });

    const result = await fetchPeriodAdherence(user.id, week1Start, periodEnd);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.attribution!.severity).toBe('soft');
    expect(result.attribution!.ruleId).toBe(ruleB); // 8 > 5
    expect(result.attribution!.count).toBe(8);
  }, 30_000);

  it('priorSoft compares against the equally-SIZED block of weeks immediately preceding the period (2 weeks vs 2 weeks)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-adherence-prior');
    cleanupUserIds.push(user.id);

    await seedWeek(user.id, priorWeek1Start, { hardFollowed: 10, hardTotal: 10, softFollowed: 40, softTotal: 50 });
    await seedWeek(user.id, priorWeek2Start, { hardFollowed: 10, hardTotal: 10, softFollowed: 41, softTotal: 49 });
    await seedWeek(user.id, week1Start, { hardFollowed: 10, hardTotal: 10, softFollowed: 45, softTotal: 50 });
    await seedWeek(user.id, week2Start, { hardFollowed: 10, hardTotal: 10, softFollowed: 43, softTotal: 50 });

    const result = await fetchPeriodAdherence(user.id, week1Start, periodEnd);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.priorSoft).toEqual({ followed: 81, total: 99 }); // 40+41 of 50+49, genuine sum of the PRIOR 2 weeks
  }, 30_000);

  it('priorSoft is null (omitted, never fabricated as 0-of-0) when the prior block has no materialised rows at all', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-adherence-no-prior');
    cleanupUserIds.push(user.id);

    await seedWeek(user.id, week1Start, { hardFollowed: 10, hardTotal: 10, softFollowed: 45, softTotal: 50 });

    const result = await fetchPeriodAdherence(user.id, week1Start, periodEnd);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.priorSoft).toBeNull();
  }, 30_000);

  it('cross-user isolation: user B never sees user A\'s adherence_weekly rows or attribution', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'period-adherence-a');
    const userB = await createTestAuthUser(envBundle, 'period-adherence-b');
    cleanupUserIds.push(userA.id, userB.id);
    const ruleA = await makeRule(userA.id, 'Rule A only.');

    await seedWeek(userA.id, week1Start, {
      hardFollowed: 9,
      hardTotal: 10,
      softFollowed: 20,
      softTotal: 30,
      topBreakRuleId: ruleA,
      topBreakCount: 1,
    });

    const resultB = await fetchPeriodAdherence(userB.id, week1Start, periodEnd);
    expect(resultB).toEqual({ status: 'insufficient_history' });

    const resultA = await fetchPeriodAdherence(userA.id, week1Start, periodEnd);
    expect(resultA.status).toBe('ready');
  }, 30_000);
});
