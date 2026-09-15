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
 * Module 04 (Rulebook & Evaluation) §6.1 story 1.3 / inventory row 3.10 —
 * live-DB proof for `lib/review/discovery.ts`'s `fetchDiscoveryForUser`,
 * the owner-scoped data read behind `/rules/new`'s discovery section.
 *
 * `detections` rows are DIRECT-INSERT fixtures (same posture `eligibility.
 * live.test.ts`'s own DETECTION test uses: "the detection ENGINE's own
 * tier/classification computation is Module 05's concern, already covered
 * there" — this file is proving discovery's OWN read/filter/rank against
 * real rows, not re-proving the engine that writes them). The "already
 * governed" check goes through the REAL `insertRuleAndVersion` write path
 * (never a hand-built `rules`/`rule_versions` row), matching `guided-
 * front-door.live.test.ts`'s own established precedent for that exact
 * check.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/discovery.ts (live DB)', () => {
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
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
      await db.query('delete from retrospeq.detections where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function insertDetection(
    userId: string,
    analyticId: string,
    occurrences: number,
    ruleProposable: boolean,
    opts: { tier?: 'count' | 'count_outcome'; classification?: 'incident' | 'pattern' } = {},
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.detections
         (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, base_rate,
          outcome_avg_r, outcome_baseline_avg_r, tier, classification, rule_proposable, direction, state)
       values ($1,$2,$3,'2026-06-01T00:00:00Z','2026-09-01T00:00:00Z',5,0.1,-0.5,0.2,$4,$5,$6,'active','active')`,
      [userId, analyticId, occurrences, opts.tier ?? 'count_outcome', opts.classification ?? 'pattern', ruleProposable],
    );
  }

  it('returns an empty list for a brand-new trader with zero detections (honest "not enough data yet", never invented)', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'discovery-empty');
    cleanupUserIds.push(userId);

    const { fetchDiscoveryForUser } = await import('../discovery');
    const result = await fetchDiscoveryForUser(userId);
    expect(result.items).toEqual([]);
    expect(result.windowDays).toBe(90);
  });

  it('surfaces real, rule-proposable detections with an honest operand mapping, ranked by occurrences', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'discovery-real');
    cleanupUserIds.push(userId);

    await insertDetection(userId, 'seq.reentry_after_loss', 11, true);
    await insertDetection(userId, 'seq.consecutive_losses', 25, true);
    // No honest operand mapping today (detection-operand-map.ts) -- must
    // never surface regardless of how "qualifying" the row looks. Only one
    // ACTIVE row per (user, analytic_id) is allowed
    // (`detections_active_analytic_uidx`), so a separate "not
    // rule_proposable" exclusion is covered by the unit test
    // (`discovery.test.ts`) instead of a second row for an already-used
    // analytic here.
    await insertDetection(userId, 'seq.trades_per_day', 40, true);

    const { fetchDiscoveryForUser } = await import('../discovery');
    const result = await fetchDiscoveryForUser(userId);

    expect(result.items.map((i) => i.analyticId)).toEqual(['seq.consecutive_losses', 'seq.reentry_after_loss']);
    expect(result.items[0]).toMatchObject({ operandId: 'consecutive_losses', evidence: '25 times', seedValue: 2 });
    expect(result.items[1]).toMatchObject({ operandId: 'time_since_last_loss', evidence: '11 times', seedValue: 2 });
  });

  it('excludes an operand already governed by a real active global rule', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'discovery-governed');
    cleanupUserIds.push(userId);

    await insertDetection(userId, 'seq.reentry_after_loss', 14, true);
    await insertDetection(userId, 'seq.consecutive_losses', 9, true);

    const { insertRuleAndVersion } = await import('@/lib/rules/rules-repository');
    await insertRuleAndVersion({
      userId,
      operandId: 'time_since_last_loss',
      op: 'gte',
      value: 5,
      scope: 'global',
      scopeId: null,
      evaluation: 'pre_entry',
      rendered: 'Wait at least 5 minutes after a loss before entering again.',
      capLimit: null,
    });

    const { fetchDiscoveryForUser } = await import('../discovery');
    const result = await fetchDiscoveryForUser(userId);

    expect(result.items.map((i) => i.operandId)).toEqual(['consecutive_losses']);
  });

  it('CROSS-USER ISOLATION: one trader\'s real detections and rules never surface for another', async () => {
    if (!env) return;
    const { id: userA } = await createTestAuthUser(envBundle, 'discovery-iso-a');
    const { id: userB } = await createTestAuthUser(envBundle, 'discovery-iso-b');
    cleanupUserIds.push(userA, userB);

    await insertDetection(userA, 'seq.reentry_after_loss', 17, true);

    const { fetchDiscoveryForUser } = await import('../discovery');
    const [resultA, resultB] = await Promise.all([fetchDiscoveryForUser(userA), fetchDiscoveryForUser(userB)]);

    expect(resultA.items.map((i) => i.analyticId)).toEqual(['seq.reentry_after_loss']);
    expect(resultB.items).toEqual([]);
  });
});
