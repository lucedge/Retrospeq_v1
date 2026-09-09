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

vi.setConfig({ testTimeout: 30_000 });

/**
 * Independent-review regression test (2026-09-09), closing a real gap:
 * `createStrategyFromBuilder`'s multi-call orchestration (docs/adr/0027)
 * runs three sequential, non-transactional calls with no shared Postgres
 * transaction — a mid-flight infrastructure failure after step 1
 * (`createStrategy`, the empty shell) used to leave a permanently
 * orphaned, empty strategy in the trader's own list with no cleanup path
 * anywhere in this repo. This file proves the fix (docs/adr/0027's
 * Addendum; `deleteOrphanedStrategyShell`,
 * `lib/fields/strategy-repository.ts`) against a REAL, live database —
 * not merely that an error was returned, but that the orphaned row (and
 * any real `trigger_conditions` rows step 2 already committed) are
 * genuinely gone afterward, and that a failed cleanup attempt correctly
 * falls back to the pre-existing `STRATEGY_BUILDER_PARTIAL` path rather
 * than masking the original failure or silently leaving the trader
 * thinking nothing was saved when something actually was.
 *
 * What this mocks and why (the minimum needed, matching
 * `app/(app)/trades/__tests__/confirm-day-action.live.test.ts`'s own
 * established live-Server-Action-test posture): `@/lib/supabase/server`'s
 * `createClient` and `@/lib/rate-limit/http`'s `getClientIp` both need a
 * live Next.js request context this plain `vitest run` process doesn't
 * have; `enforceRateLimit` and `next/cache`'s `revalidatePath` are mocked
 * to isolate this file to the orphan-cleanup behaviour specifically, not
 * also a rate-limit/cache test. `@/lib/fields/strategy-repository`'s
 * `editStrategy` is forced to fail (simulating the genuine mid-flight
 * infrastructure failure docs/adr/0027 describes — a bad name/hedge-text/
 * capture-moment mistake never reaches this point at all, since
 * `preValidateBuilderInput` catches those before step 1 ever runs);
 * `deleteOrphanedStrategyShell` defaults to its REAL implementation
 * (call-through) and is forced to fail ONLY in the second test. Every
 * other function this Server Action calls — `createStrategy`,
 * `createTriggerCondition`, `canForUser` — runs FOR REAL against the live
 * dev/test Postgres instance, through real RLS.
 */
const env = readRlsTestEnv();

const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock, editStrategyMock, deleteOrphanedStrategyShellMock } =
  vi.hoisted(() => ({
    getUserMock: vi.fn(),
    createClientMock: vi.fn(),
    getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
    enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
    editStrategyMock: vi.fn(),
    deleteOrphanedStrategyShellMock: vi.fn(),
  }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: createClientMock,
}));
vi.mock('@/lib/rate-limit/http', () => ({
  getClientIp: getClientIpMock,
}));
vi.mock('@/lib/rate-limit/limiter', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/fields/strategy-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fields/strategy-repository')>();
  // Default: genuinely call through to the real implementation — only
  // overridden per-test via `.mockRejectedValueOnce(...)` below, so a test
  // that never touches this mock still exercises the real, live-DB
  // compensating delete.
  deleteOrphanedStrategyShellMock.mockImplementation(actual.deleteOrphanedStrategyShell);
  return {
    ...actual,
    editStrategy: editStrategyMock,
    deleteOrphanedStrategyShell: deleteOrphanedStrategyShellMock,
  };
});

/** Points the Server Action's session check at a specific real auth user. */
function sessionAs(userId: string, email: string) {
  createClientMock.mockResolvedValue({
    auth: {
      getUser: getUserMock.mockResolvedValue({ data: { user: { id: userId, email } }, error: null }),
    },
  });
}

async function setPlan(db: Client, userId: string, plan: 'free' | 'pro'): Promise<void> {
  await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
}

describe.skipIf(!env)('app/(app)/strategies/actions.ts createStrategyFromBuilder — compensating delete of an orphaned shell (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  afterEach(async () => {
    editStrategyMock.mockReset();
    if (!env) return;
    for (const userId of cleanupUserIds.splice(0)) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it(
    'step 3 (editStrategy) fails after step 1/2 committed: the orphaned shell AND the real trigger_conditions rows step 2 created are both actually gone afterward, not just an error returned',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'strategy-orphan-cleanup-success');
      cleanupUserIds.push(user.id);
      await setPlan(db, user.id, 'pro');

      editStrategyMock.mockRejectedValueOnce(new Error('forced test failure: simulated infrastructure error at step 3'));

      const { createStrategyFromBuilder } = await import('../actions');

      sessionAs(user.id, user.email);
      const result = await createStrategyFromBuilder({
        name: 'Orphan cleanup regression strategy',
        triggers: [{ text: 'Price closes above the 20 EMA' }, { text: 'Volume confirms the breakout' }],
        fields: [],
      });

      // The new, narrower outcome: cleanup succeeded, so the trader is
      // told plainly nothing was saved — never the old STRATEGY_BUILDER_PARTIAL
      // manual-cleanup code, since there is nothing left to manually clean up.
      expect(result.error?.code).toBe('STRATEGY_BUILDER_CREATE_FAILED');
      expect(result.success).toBeUndefined();

      // The real, load-bearing assertion: zero strategies and zero
      // trigger_conditions remain for this user — backed by the DB, not a
      // mock's call count. Before this fix, exactly one orphaned
      // `strategies` row (plus two real `trigger_conditions` rows from
      // step 2) would have been left behind here.
      const strategyCount = await db.query('select count(*)::int as n from retrospeq.strategies where user_id = $1', [user.id]);
      expect(strategyCount.rows[0].n).toBe(0);

      const triggerCount = await db.query('select count(*)::int as n from retrospeq.trigger_conditions where user_id = $1', [user.id]);
      expect(triggerCount.rows[0].n).toBe(0);
    },
    30_000,
  );

  it(
    'compensating delete itself fails: falls back to the pre-existing STRATEGY_BUILDER_PARTIAL error, never silently claims success, and the original step-3 failure is not masked',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'strategy-orphan-cleanup-fallback');
      cleanupUserIds.push(user.id);
      await setPlan(db, user.id, 'pro');

      editStrategyMock.mockRejectedValueOnce(new Error('forced test failure: simulated infrastructure error at step 3'));
      deleteOrphanedStrategyShellMock.mockRejectedValueOnce(new Error('forced test failure: simulated infrastructure error during compensating delete'));

      const { createStrategyFromBuilder } = await import('../actions');

      sessionAs(user.id, user.email);
      const result = await createStrategyFromBuilder({
        name: 'Orphan cleanup fallback regression strategy',
        triggers: [{ text: 'Price closes above the 20 EMA' }],
        fields: [],
      });

      // Cleanup failed -- must fall back to the ORIGINAL error code, not
      // silently succeed and not invent a third, unhandled failure mode.
      expect(result.error?.code).toBe('STRATEGY_BUILDER_PARTIAL');
      expect(result.success).toBeUndefined();

      // The shell (and its one real trigger_conditions row) are genuinely
      // still present -- proving this is a real fallback to the documented
      // manual-cleanup path, not a false claim of cleanup success.
      const strategyRows = await db.query<{ id: string; current_version: number }>(
        'select id, current_version from retrospeq.strategies where user_id = $1',
        [user.id],
      );
      expect(strategyRows.rows).toHaveLength(1);
      expect(strategyRows.rows[0].current_version).toBe(1);

      const triggerCount = await db.query('select count(*)::int as n from retrospeq.trigger_conditions where user_id = $1', [user.id]);
      expect(triggerCount.rows[0].n).toBe(1);
    },
    30_000,
  );

  it(
    'positive control: no forced failure, the real code path succeeds normally and the compensating-delete machinery is never invoked',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'strategy-orphan-cleanup-positive');
      cleanupUserIds.push(user.id);
      await setPlan(db, user.id, 'pro');

      // editStrategyMock has no queued rejection this time -- but it also
      // has no implementation queued, so it must be restored to a
      // call-through for this ONE test to actually succeed for real.
      const { editStrategy: realEditStrategy } = await vi.importActual<typeof import('@/lib/fields/strategy-repository')>(
        '@/lib/fields/strategy-repository',
      );
      editStrategyMock.mockImplementationOnce(realEditStrategy);

      const { createStrategyFromBuilder } = await import('../actions');

      sessionAs(user.id, user.email);
      const result = await createStrategyFromBuilder({
        name: 'Orphan cleanup positive-control strategy',
        triggers: [{ text: 'Price closes above the 20 EMA' }],
        fields: [],
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.version).toBe(2); // real content, version 2 -- docs/adr/0027

      const strategyRows = await db.query<{ current_version: number }>(
        'select current_version from retrospeq.strategies where user_id = $1',
        [user.id],
      );
      expect(strategyRows.rows).toHaveLength(1);
      expect(strategyRows.rows[0].current_version).toBe(2);

      const triggerCount = await db.query('select count(*)::int as n from retrospeq.trigger_conditions where user_id = $1', [user.id]);
      expect(triggerCount.rows[0].n).toBe(1);
    },
    30_000,
  );
});
