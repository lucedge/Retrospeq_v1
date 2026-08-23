import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '../../supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Live-DB proof for `countActiveRules` (`lib/entitlements/rules-usage.ts`),
 * added by an independent verification pass (2026-08-24) closing a real
 * gap: `rules-usage.test.ts` only ever mocks the query result and asserts
 * the SQL TEXT contains `state = 'active'` — it never proves against a
 * real `retrospeq.rules` table that a `retired`/`deactivated_by_plan` row
 * is actually excluded from the count. This is exactly the kind of thing
 * a mock can get subtly wrong (e.g. a typo'd state literal, a missing
 * `and`, an accidental `or`) without any test catching it, and the
 * dispatch for this verification pass specifically named "confirm
 * countActiveRules excludes retired rules" as something to check.
 *
 * Seeds one `active`, one `retired`, and one `deactivated_by_plan` rule
 * (each with its own `rule_versions` row 1, satisfying the FK/NOT NULL
 * shape a real `insertRuleAndVersion` write would produce) directly via
 * the owner connection — `rules`/`rule_versions` DDL only, not going
 * through the authoring pipeline, since nothing in this slice (or any
 * later one, per PROGRESS.md) yet writes `state = 'retired'` for real.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/entitlements/rules-usage.ts countActiveRules (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  const insertRule = async (state: 'active' | 'retired' | 'deactivated_by_plan', operandId: string) => {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, 'soft', 'authored', 'pre_entry', $2)
       returning id`,
      [user.id, state],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, 'lte', '2'::jsonb, 'Never risk more than 2% per trade.')`,
      [ruleId, user.id, operandId],
    );
    return ruleId;
  };

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'rules-usage-live');

    await insertRule('active', 'risk_pct');
    await insertRule('active', 'daily_pnl_pct');
    await insertRule('retired', 'weekly_loss_pct');
    await insertRule('deactivated_by_plan', 'consecutive_losses');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.rules where user_id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('counts only the 2 active rules, excluding the retired and deactivated_by_plan ones', async () => {
    const { countActiveRules } = await import('../rules-usage');
    await expect(countActiveRules(user.id)).resolves.toBe(2);
  });

  it('returns 0 for a user with zero rules rows at all', async () => {
    const { countActiveRules } = await import('../rules-usage');
    const otherUser = await createTestAuthUser(env!, 'rules-usage-live-empty');
    try {
      await expect(countActiveRules(otherUser.id)).resolves.toBe(0);
    } finally {
      await deleteTestAuthUser(env!, otherUser.id).catch(() => {});
    }
  });
});
