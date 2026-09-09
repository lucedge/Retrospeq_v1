import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

vi.setConfig({ testTimeout: 30_000 });

/**
 * Independent verification (retrospeq-tester dispatch, 2026-09-09) of
 * `app/(app)/fields/actions.ts` — the fields MANAGEMENT screen's write
 * paths (`createFieldAction`/`renameFieldAction`/`archiveFieldAction`/
 * `promoteFieldAction`), run against the REAL, live dev/test Postgres
 * instance through this exact action layer (not the repository directly —
 * `lib/fields/__tests__/fields-repository*.live.test.ts` already covers
 * that, this file's job is the SERVER ACTION orchestration on top of it:
 * session resolution, Zod boundary, error-code mapping, `revalidatePath`
 * calls, and — the two things a repository-only test structurally cannot
 * prove — that a crafted fieldId belonging to ANOTHER real user is
 * correctly rejected through this action's own real session-resolved
 * userId, and that a free-plan session's OWN direct call to this action
 * (not merely the UI hiding a button) is rejected server-side.
 *
 * What's mocked and why (the minimum, matching
 * `app/(app)/strategies/__tests__/create-strategy-orphan-cleanup.live.test.ts`'s
 * established live-Server-Action-test posture): `@/lib/supabase/server`'s
 * `createClient` and `@/lib/rate-limit/http`'s `getClientIp` both need a
 * live Next.js request context this plain `vitest run` process doesn't
 * have; `enforceRateLimit` and `next/cache`'s `revalidatePath` are mocked
 * so this file is never coupled to the rate limiter's own real backing
 * store. Every other function this Server Action calls — `createField`,
 * `renameField`, `archiveField`, `promoteField`, `fetchFieldsForManagement`,
 * `canForUser` — runs FOR REAL against the live DB, through real RLS.
 */
const env = readRlsTestEnv();

const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  revalidatePathMock: vi.fn(),
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
  revalidatePath: revalidatePathMock,
}));

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

async function fieldCount(db: Client, userId: string): Promise<number> {
  const res = await db.query('select count(*)::int as n from retrospeq.fields where user_id = $1 and kind <> $2', [userId, 'derived']);
  return res.rows[0].n;
}

describe.skipIf(!env)('app/(app)/fields/actions.ts — lifecycle write paths (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  afterEach(async () => {
    revalidatePathMock.mockClear();
    if (!env) return;
    for (const userId of cleanupUserIds.splice(0)) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.field_usages where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('full real lifecycle through the action layer: create -> rename -> promote -> archive, each backed by a genuine DB read afterward', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'fields-actions-lifecycle');
    cleanupUserIds.push(user.id);
    await setPlan(db, user.id, 'pro');
    sessionAs(user.id, user.email);

    const { createFieldAction, renameFieldAction, promoteFieldAction, archiveFieldAction, fetchFieldsList } = await import('../actions');

    // Create a strategy_var field.
    const stratRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Lifecycle test strategy', 1, false, 'active') returning id`,
      [user.id],
    );
    const strategyId = stratRes.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Lifecycle test strategy', '[]'::jsonb, '[]'::jsonb)`,
      [strategyId, user.id],
    );

    const createResult = await createFieldAction({
      name: 'Conviction (lifecycle)',
      dataType: 'rating',
      kind: 'strategy_var',
      ownerStrategyId: strategyId,
      config: {},
    });
    expect(createResult.success).toBe(true);
    const fieldId = createResult.field!.fieldId;
    expect(fieldId.startsWith('str.')).toBe(true);

    const createdRow = await db.query('select name, kind, owner_strategy_id, state from retrospeq.fields where id = $1', [fieldId]);
    expect(createdRow.rows[0]).toEqual({ name: 'Conviction (lifecycle)', kind: 'strategy_var', owner_strategy_id: strategyId, state: 'active' });

    // Rename.
    const renameResult = await renameFieldAction(fieldId, 'Conviction (renamed)');
    expect(renameResult.success).toBe(true);
    const renamedRow = await db.query('select name from retrospeq.fields where id = $1', [fieldId]);
    expect(renamedRow.rows[0].name).toBe('Conviction (renamed)');

    // Promote.
    const promoteResult = await promoteFieldAction(fieldId);
    expect(promoteResult.success).toBe(true);
    expect(promoteResult.kind).toBe('account');
    const promotedRow = await db.query('select kind, owner_strategy_id from retrospeq.fields where id = $1', [fieldId]);
    expect(promotedRow.rows[0]).toEqual({ kind: 'account', owner_strategy_id: null });

    // The management list read reflects the live state.
    const listResult = await fetchFieldsList();
    expect(listResult.success).toBe(true);
    const listed = listResult.fields!.find((f) => f.fieldId === fieldId);
    expect(listed?.name).toBe('Conviction (renamed)');
    expect(listed?.kind).toBe('account');

    // Archive.
    const archiveResult = await archiveFieldAction(fieldId);
    expect(archiveResult.success).toBe(true);
    const archivedRow = await db.query('select state, archived_at from retrospeq.fields where id = $1', [fieldId]);
    expect(archivedRow.rows[0].state).toBe('archived');
    expect(archivedRow.rows[0].archived_at).not.toBeNull();

    expect(revalidatePathMock).toHaveBeenCalledWith('/fields');
  });

  it('archiveFieldAction is genuinely blocked (FIELD_IN_USE) through the action layer when a real strategy references the field via field_usages, and zero state changes — then succeeds once the dependency is removed', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'fields-actions-in-use');
    cleanupUserIds.push(user.id);
    await setPlan(db, user.id, 'pro');
    sessionAs(user.id, user.email);

    const { createFieldAction, archiveFieldAction } = await import('../actions');

    const createResult = await createFieldAction({ name: 'Setup quality (in-use)', dataType: 'rating', kind: 'account', config: {} });
    expect(createResult.success).toBe(true);
    const fieldId = createResult.field!.fieldId;

    // Attach it to a real strategy via a genuine field_usages row (the same
    // shape `rebuildFieldUsagesForStrategy` writes).
    const stratRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Dependent strategy', 1, false, 'active') returning id`,
      [user.id],
    );
    const strategyId = stratRes.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Dependent strategy', $3::jsonb, '[]'::jsonb)`,
      [strategyId, user.id, JSON.stringify([{ field_id: fieldId, capture_moment: 'post_close', order: 0 }])],
    );
    await db.query(
      `insert into retrospeq.field_usages (user_id, field_id, used_by, used_by_id) values ($1, $2, 'strategy', $3)`,
      [user.id, fieldId, strategyId],
    );

    const blockedResult = await archiveFieldAction(fieldId);
    expect(blockedResult.error?.code).toBe('FIELD_IN_USE');
    expect(blockedResult.error?.retryable).toBe(false);
    expect(blockedResult.dependents).toEqual([{ usedBy: 'strategy', usedById: strategyId, label: 'Dependent strategy' }]);

    const stillActive = await db.query('select state from retrospeq.fields where id = $1', [fieldId]);
    expect(stillActive.rows[0].state).toBe('active');

    // Remove the dependency, then the exact same action succeeds.
    await db.query('delete from retrospeq.field_usages where user_id = $1 and field_id = $2', [user.id, fieldId]);
    const okResult = await archiveFieldAction(fieldId);
    expect(okResult.success).toBe(true);

    await db.query('delete from retrospeq.strategy_versions where strategy_id = $1', [strategyId]);
    await db.query('delete from retrospeq.strategies where id = $1', [strategyId]);
  });

  describe('cross-user isolation — a crafted fieldId belonging to ANOTHER real user cannot be mutated through this action layer', () => {
    let owner: TestAuthUser;
    let attacker: TestAuthUser;
    let victimFieldId: string;

    beforeAll(async () => {
      if (!env) return;
      owner = await createTestAuthUser(env, 'fields-actions-victim');
      attacker = await createTestAuthUser(env, 'fields-actions-attacker');
      await setPlan(db, owner.id, 'pro');
      await setPlan(db, attacker.id, 'pro');

      const res = await db.query<{ id: string }>(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, config)
         values ('acct.victim-conviction-field', $1, 'Victim conviction', 'account', 'rating', 'captured', '{"min":1,"max":5}'::jsonb)
         returning id`,
        [owner.id],
      );
      victimFieldId = res.rows[0].id;
    }, 30_000);

    afterAll(async () => {
      if (!env) return;
      await db.query('delete from retrospeq.fields where id = $1', [victimFieldId]).catch(() => {});
      await deleteTestAuthUser(env!, owner.id).catch(() => {});
      await deleteTestAuthUser(env!, attacker.id).catch(() => {});
    });

    it('renameFieldAction, called as the attacker against the victim\'s real fieldId, returns FIELD_NOT_FOUND and writes nothing', async () => {
      if (!env) return;
      sessionAs(attacker.id, attacker.email);
      const { renameFieldAction } = await import('../actions');
      const result = await renameFieldAction(victimFieldId, 'Hijacked by attacker');
      expect(result.error?.code).toBe('FIELD_NOT_FOUND');

      const row = await db.query('select name from retrospeq.fields where id = $1', [victimFieldId]);
      expect(row.rows[0].name).toBe('Victim conviction');
    });

    it('archiveFieldAction, called as the attacker against the victim\'s real fieldId, returns FIELD_NOT_FOUND and writes nothing', async () => {
      if (!env) return;
      sessionAs(attacker.id, attacker.email);
      const { archiveFieldAction } = await import('../actions');
      const result = await archiveFieldAction(victimFieldId);
      expect(result.error?.code).toBe('FIELD_NOT_FOUND');

      const row = await db.query('select state from retrospeq.fields where id = $1', [victimFieldId]);
      expect(row.rows[0].state).toBe('active');
    });

    it('promoteFieldAction, called as the attacker against the victim\'s real strategy_var fieldId, returns FIELD_NOT_FOUND and writes nothing', async () => {
      if (!env) return;
      // Needs a strategy_var field for a meaningful promotion attempt —
      // seed one owned by the victim, scoped to a strategy the victim owns.
      const stratRes = await db.query<{ id: string }>(
        `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
         values ($1, 'Victim strategy', 1, false, 'active') returning id`,
        [owner.id],
      );
      const strategyId = stratRes.rows[0].id;
      await db.query(
        `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
         values ($1, 1, $2, 'Victim strategy', '[]'::jsonb, '[]'::jsonb)`,
        [strategyId, owner.id],
      );
      const varRes = await db.query<{ id: string }>(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
         values ('str.victim-strategy-var', $1, 'Victim strategy var', 'strategy_var', 'note', 'captured', $2, '{}'::jsonb)
         returning id`,
        [owner.id, strategyId],
      );
      const victimVarFieldId = varRes.rows[0].id;

      sessionAs(attacker.id, attacker.email);
      const { promoteFieldAction } = await import('../actions');
      const result = await promoteFieldAction(victimVarFieldId);
      expect(result.error?.code).toBe('FIELD_NOT_FOUND');

      const row = await db.query('select kind, owner_strategy_id from retrospeq.fields where id = $1', [victimVarFieldId]);
      expect(row.rows[0]).toEqual({ kind: 'strategy_var', owner_strategy_id: strategyId });

      await db.query('delete from retrospeq.fields where id = $1', [victimVarFieldId]);
      await db.query('delete from retrospeq.strategy_versions where strategy_id = $1', [strategyId]);
      await db.query('delete from retrospeq.strategies where id = $1', [strategyId]);
    });

    it("createFieldAction with a crafted ownerStrategyId belonging to the VICTIM's strategy is rejected (STRATEGY_NOT_FOUND, RLS makes cross-user and nonexistent indistinguishable by design), writing nothing", async () => {
      if (!env) return;
      const stratRes = await db.query<{ id: string }>(
        `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
         values ($1, 'Victim strategy for create-bypass', 1, false, 'active') returning id`,
        [owner.id],
      );
      const strategyId = stratRes.rows[0].id;
      await db.query(
        `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
         values ($1, 1, $2, 'Victim strategy for create-bypass', '[]'::jsonb, '[]'::jsonb)`,
        [strategyId, owner.id],
      );

      sessionAs(attacker.id, attacker.email);
      const { createFieldAction } = await import('../actions');
      const result = await createFieldAction({
        name: 'Cross-user field-create attempt',
        dataType: 'note',
        kind: 'strategy_var',
        ownerStrategyId: strategyId,
        config: {},
      });
      expect(result.error?.code).toBe('STRATEGY_NOT_FOUND');

      expect(await fieldCount(db, attacker.id)).toBe(0);

      await db.query('delete from retrospeq.strategy_versions where strategy_id = $1', [strategyId]);
      await db.query('delete from retrospeq.strategies where id = $1', [strategyId]);
    });
  });

  describe('entitlement gating holds at the action layer directly, independent of the UI hiding "Add a field"', () => {
    it('createFieldAction rejects a free-plan session with ENTITLEMENT_LIMIT, zero rows written', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'fields-actions-free-gate');
      cleanupUserIds.push(user.id);
      await setPlan(db, user.id, 'free');
      sessionAs(user.id, user.email);

      const { createFieldAction } = await import('../actions');
      const result = await createFieldAction({ name: 'Free-plan bypass attempt', dataType: 'note', kind: 'account', config: {} });

      expect(result.error?.code).toBe('ENTITLEMENT_LIMIT');
      expect(result.success).toBeUndefined();
      expect(await fieldCount(db, user.id)).toBe(0);
    });

    it('a free-plan session can still rename/archive an EXISTING custom field it already owns (structurally only possible if it was created while Pro, then downgraded) — lifecycle ops are not re-gated on plan, matching the repository\'s own documented reasoning', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'fields-actions-downgrade');
      cleanupUserIds.push(user.id);
      await setPlan(db, user.id, 'pro');
      sessionAs(user.id, user.email);

      const { createFieldAction, renameFieldAction } = await import('../actions');
      const createResult = await createFieldAction({ name: 'Created while Pro', dataType: 'note', kind: 'account', config: {} });
      expect(createResult.success).toBe(true);
      const fieldId = createResult.field!.fieldId;

      await setPlan(db, user.id, 'free');
      const renameResult = await renameFieldAction(fieldId, 'Renamed after downgrade');
      expect(renameResult.success).toBe(true);

      const row = await db.query('select name from retrospeq.fields where id = $1', [fieldId]);
      expect(row.rows[0].name).toBe('Renamed after downgrade');
    });
  });
});
