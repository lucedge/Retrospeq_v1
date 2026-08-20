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
 * Module 01 stories 5.2/5.3 — the highest-stakes test in this slice.
 * Proves `executeErasure` (`lib/privacy/erasure.ts`) genuinely removes
 * everything it should, from a real disposable test user created via the
 * GoTrue admin API (same pattern as every other live-DB test in this
 * repo — `lib/supabase/__tests__/rls-test-helpers.ts`), and leaves the
 * tombstone behind. Not a mock: `deleteAllAccountCredentialsForUser` /
 * `deleteAllRecoveryCodes` / `deleteAllTradingAccountsForUser` /
 * `deleteSubscriptionForUser` / `createServiceRoleClient().auth.admin.deleteUser`
 * all run for real against the live shared dev/test Supabase project.
 *
 * Uses `executeErasure(id, { bypassGracePeriod: true })` — the real
 * dev/test-only immediate-execution path, gated by
 * `RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS=true` (set for this test file
 * only, via `vi.stubEnv`, never process-wide) — see
 * `lib/privacy/dev-tools-guard.ts`'s own doc comment for why this is not
 * a production affordance.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/privacy/erasure.ts executeErasure (live DB)', () => {
  let db: Client;
  let originalDevFlag: string | undefined;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  beforeEach(() => {
    // `devPrivacyToolsEnabled()`'s other condition, `NODE_ENV !==
    // 'production'`, is already satisfied by vitest's own default test
    // environment — only the explicit opt-in var needs setting here.
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
    'destroys credentials, deletes every owned row, writes a tombstone, and deletes the auth.users row — full lifecycle, real data',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure } = await import('../erasure');

      const user = await createTestAuthUser(env, 'erasure-live');

      // Seed real owned rows across every table `executeErasure` must
      // clear — a trading account, a credential for it, and recovery
      // codes — via the owner connection (setup, not the thing under
      // test). `subscriptions` already exists from `handle_new_user`.
      const accountRes = await db.query(
        `insert into retrospeq.trading_accounts
           (user_id, label, platform, base_currency, day_rollover)
         values ($1, 'Erasure Test Account', 'mt5', 'USD', 'America/New_York 17:00')
         returning id`,
        [user.id],
      );
      const accountId = accountRes.rows[0].id;

      await db.query(
        `insert into retrospeq.account_credentials
           (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
         values ($1, $2, '\\x01', '\\x02', '\\x03', '\\x04', 'test-key', 'investor_password', true)`,
        [accountId, user.id],
      );

      await db.query(
        `insert into retrospeq.mfa_recovery_codes (user_id, code_hash) values ($1, 'erasure-test-hash')`,
        [user.id],
      );

      const subscriptionBefore = await db.query(
        'select 1 from retrospeq.subscriptions where user_id = $1',
        [user.id],
      );
      expect(subscriptionBefore.rows).toHaveLength(1);

      // Real story 5.2 request flow — grace period created for real,
      // then bypassed only via the guarded dev/test path.
      const request = await requestErasure(user.id);
      expect(request.status).toBe('pending');
      expect(request.expires_at).not.toBeNull();

      await executeErasure(request.id, { bypassGracePeriod: true });

      // --- Every owned row is gone -----------------------------------
      const credentials = await db.query(
        'select 1 from retrospeq.account_credentials where account_id = $1',
        [accountId],
      );
      expect(credentials.rows).toHaveLength(0);

      const accounts = await db.query('select 1 from retrospeq.trading_accounts where user_id = $1', [
        user.id,
      ]);
      expect(accounts.rows).toHaveLength(0);

      const recoveryCodes = await db.query(
        'select 1 from retrospeq.mfa_recovery_codes where user_id = $1',
        [user.id],
      );
      expect(recoveryCodes.rows).toHaveLength(0);

      const subscriptionAfter = await db.query(
        'select 1 from retrospeq.subscriptions where user_id = $1',
        [user.id],
      );
      expect(subscriptionAfter.rows).toHaveLength(0);

      const profileAfter = await db.query('select 1 from retrospeq.profiles where id = $1', [
        user.id,
      ]);
      expect(profileAfter.rows).toHaveLength(0);

      // data_requests cascades away with profiles (by design — see the
      // migration's own comment on why this table has no `on delete set
      // null` the way audit_log does).
      const dataRequestsAfter = await db.query('select 1 from retrospeq.data_requests where id = $1', [
        request.id,
      ]);
      expect(dataRequestsAfter.rows).toHaveLength(0);

      // --- The tombstone survives, decoupled from the (now-gone) user -
      const tombstones = await db.query(
        'select email_hash, request_id from retrospeq.erasure_tombstones where request_id = $1',
        [request.id],
      );
      expect(tombstones.rows).toHaveLength(1);
      expect(tombstones.rows[0].email_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
      expect(tombstones.rows[0].email_hash).not.toBe(user.email); // never the raw email

      // --- The audit trail survives too, user_id nulled (on delete set
      // null), never cascaded away with the account it was about -------
      const auditRows = await db.query(
        `select user_id, actor, action, metadata
           from retrospeq.audit_log
          where action = 'erasure_executed' and metadata->>'erasedUserId' = $1`,
        [user.id],
      );
      expect(auditRows.rows).toHaveLength(1);
      expect(auditRows.rows[0].user_id).toBeNull();
      expect(auditRows.rows[0].actor).toBe('system');

      // --- The auth.users row itself is gone — confirmed by the GoTrue
      // admin API returning 404 for a getUser call, not merely a DB
      // table check (the whole point of this step is the auth-schema
      // row, which this repo's own tables never see directly). ---------
      const { createServiceRoleClient } = await import('@/lib/supabase/service');
      const supabase = createServiceRoleClient();
      const { data, error } = await supabase.auth.admin.getUserById(user.id);
      expect(data.user).toBeNull();
      expect(error).not.toBeNull();

      // Cleanup: audit_log/erasure_tombstones don't cascade away with
      // the (already-deleted) user — remove the rows this test itself
      // created so the shared dev project doesn't accumulate permanent
      // test debt. deleteTestAuthUser is a no-op 404 here (already gone).
      await db.query("delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1", [user.id]).catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    30_000,
  );

  it(
    'refuses to execute a second time — the data_requests row itself is gone by then, ' +
      'cascade-deleted along with the (already-erased) profile, per docs/adr/0010',
    async () => {
    if (!env) return;
    const { requestErasure, executeErasure } = await import('../erasure');

    const user = await createTestAuthUser(env, 'erasure-live-double');
    const request = await requestErasure(user.id);

    await executeErasure(request.id, { bypassGracePeriod: true });

    // Not `ErasureAlreadyProcessedError` — that branch fires only when
    // the ROW still exists with a non-'pending' status. Here the row
    // itself no longer exists at all: `data_requests.user_id references
    // profiles(id) on delete cascade` (no `on delete set null` the way
    // `audit_log` has) means the completed request row was cascade-
    // deleted the instant `executeErasure` deleted the profile in its
    // final step — see the migration's own comment. A second call
    // therefore hits the "not found" branch, which is the more accurate
    // outcome: there is truly nothing left to re-process.
    await expect(executeErasure(request.id, { bypassGracePeriod: true })).rejects.toThrow(
      /not found/,
    );

    // Cleanup (the first executeErasure already deleted the profile/auth
    // user for real — this just clears the audit/tombstone rows it left).
    await db
      .query(
        "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
        [user.id],
      )
      .catch(() => {});
    await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
    await deleteTestAuthUser(env, user.id).catch(() => {});
  }, 30_000);

  it('refuses to execute before the grace period elapses without the dev bypass', async () => {
    if (!env) return;
    const { requestErasure, executeErasure, ErasureGracePeriodNotElapsedError } = await import(
      '../erasure'
    );

    const user = await createTestAuthUser(env, 'erasure-live-grace');
    const request = await requestErasure(user.id);

    await expect(executeErasure(request.id)).rejects.toBeInstanceOf(
      ErasureGracePeriodNotElapsedError,
    );

    // The request is untouched (still pending) — clean up via the normal
    // GoTrue admin delete, which cascades profiles/data_requests for us.
    await deleteTestAuthUser(env, user.id).catch(() => {});
  }, 30_000);

  it('cancelErasure prevents execution — a canceled request can never be executed', async () => {
    if (!env) return;
    const { requestErasure, cancelErasure, executeErasure, ErasureAlreadyProcessedError } =
      await import('../erasure');

    const user = await createTestAuthUser(env, 'erasure-live-cancel');
    const request = await requestErasure(user.id);

    await cancelErasure(user.id, request.id);

    await expect(executeErasure(request.id, { bypassGracePeriod: true })).rejects.toBeInstanceOf(
      ErasureAlreadyProcessedError,
    );

    // The account is genuinely untouched — still exists.
    const profileStillExists = await db.query('select 1 from retrospeq.profiles where id = $1', [
      user.id,
    ]);
    expect(profileStillExists.rows).toHaveLength(1);

    await deleteTestAuthUser(env, user.id).catch(() => {});
  }, 30_000);
});
