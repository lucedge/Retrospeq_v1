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
 * Module 01 §7.1 "Downgrade deactivates without deleting; upgrade
 * restores exactly" — live-DB proof against the real shared dev/test
 * Supabase project, per this task's own instruction ("prefer the live-DB
 * version ... since this is exactly the kind of behavior a mock could
 * get subtly wrong about real SQL ordering"). Complements (does not
 * duplicate) `downgrade.test.ts`'s mocked SQL-shape assertions.
 *
 * Scenario: one trader connects THREE trading_accounts with distinct,
 * staggered `connected_at` timestamps, then downgrades to Free
 * (`account.connect` cap = 1, capability-table.ts). Proves:
 *   - exactly 2 of the 3 become `plan_limited` (the cap is 1)
 *   - the OLDEST-connected account is the one that stays `connected`
 *     (downgrade.ts's own documented ordering: `connected_at asc nulls
 *     last, created_at asc` — oldest kept, newest deactivated first)
 *   - nothing is deleted — all 3 rows still exist afterward
 *   - upgrading back to Pro reactivates BOTH deactivated accounts to
 *     `connected` — "restores exactly," not a partial/lossy restore
 *
 * Skipped (never faked) if the required env vars aren't present, same
 * pattern as every other live-DB suite in this repo.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/entitlements/downgrade.ts (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;
  let oldestId: string;
  let middleId: string;
  let newestId: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'downgrade-live');

    const insert = async (label: string, connectedAt: string) => {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts
           (user_id, label, platform, base_currency, day_rollover, status, connected_at)
         values ($1, $2, 'manual', 'USD', '00:00:00 UTC', 'connected', $3::timestamptz)
         returning id`,
        [user.id, label, connectedAt],
      );
      return res.rows[0].id;
    };

    // Staggered connected_at, oldest first — inserted out of chronological
    // order on purpose (insertion order must not matter, only connected_at).
    newestId = await insert('Downgrade Live Newest', '2026-08-20T12:00:00Z');
    oldestId = await insert('Downgrade Live Oldest', '2026-08-18T09:00:00Z');
    middleId = await insert('Downgrade Live Middle', '2026-08-19T15:30:00Z');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('delete from retrospeq.trading_accounts where user_id = $1', [user.id]).catch(() => {});
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'downgrading to Free (cap=1) leaves exactly the oldest-connected account active and deactivates the other two without deleting anything; upgrading restores both exactly',
    async () => {
      const { applyAccountConnectDowngrade, reactivateAccountsOnUpgrade } = await import('../downgrade');

      const downgradeResult = await applyAccountConnectDowngrade(user.id);
      expect(downgradeResult.deactivatedAccountIds.sort()).toEqual([middleId, newestId].sort());

      const afterDowngrade = await db.query<{ id: string; status: string }>(
        'select id, status from retrospeq.trading_accounts where user_id = $1',
        [user.id],
      );
      const statusById = new Map(afterDowngrade.rows.map((r) => [r.id, r.status]));
      expect(statusById.get(oldestId)).toBe('connected');
      expect(statusById.get(middleId)).toBe('plan_limited');
      expect(statusById.get(newestId)).toBe('plan_limited');
      // Nothing deleted — all 3 rows still exist.
      expect(afterDowngrade.rows).toHaveLength(3);

      const reactivateResult = await reactivateAccountsOnUpgrade(user.id);
      expect(reactivateResult.reactivatedAccountIds.sort()).toEqual([middleId, newestId].sort());

      const afterUpgrade = await db.query<{ id: string; status: string }>(
        'select id, status from retrospeq.trading_accounts where user_id = $1',
        [user.id],
      );
      const statusAfterUpgrade = new Map(afterUpgrade.rows.map((r) => [r.id, r.status]));
      expect(statusAfterUpgrade.get(oldestId)).toBe('connected');
      expect(statusAfterUpgrade.get(middleId)).toBe('connected');
      expect(statusAfterUpgrade.get(newestId)).toBe('connected');
      expect(afterUpgrade.rows).toHaveLength(3);
    },
    // 2 repository calls (each their own DB round trip) + verification
    // reads — same genuine-budget-not-a-flake reasoning as
    // accounts-repository.live.test.ts's lifecycle test.
    20_000,
  );

  it('a second downgrade call (already at cap) is idempotent — no further accounts deactivated', async () => {
    const { applyAccountConnectDowngrade, reactivateAccountsOnUpgrade } = await import('../downgrade');

    // Ensure we start from the downgraded state for this test's own assertion.
    await applyAccountConnectDowngrade(user.id);
    const secondCall = await applyAccountConnectDowngrade(user.id);
    // Already-plan_limited accounts are excluded from the excess query
    // (`status not in ('disconnected', 'plan_limited')`), so a repeat
    // downgrade call finds nothing new to deactivate.
    expect(secondCall.deactivatedAccountIds).toEqual([]);

    // Restore to connected for a clean afterAll teardown expectation (not
    // load-bearing for this test's assertion, just tidy).
    await reactivateAccountsOnUpgrade(user.id);
  }, 20_000);
});

describe.skipIf(!!env)('lib/entitlements/downgrade.ts (live DB) — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
