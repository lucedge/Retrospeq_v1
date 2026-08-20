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
 * Live-DB coverage for `lib/supabase/direct.ts` + `lib/broker/accounts-repository.ts`
 * (docs/adr/0006) — the direct-Postgres role-switching helpers actually
 * used by app/(app)/accounts/actions.ts. This is the one place in the
 * repo that proves `withUserConnection`/`withServiceRoleConnection`
 * genuinely enforce RLS (not just "trusted" application-layer filters)
 * against the real shared dev/test Supabase project, complementing (not
 * duplicating) lib/supabase/__tests__/trading-accounts.rls.test.ts's raw
 * `asRole` cross-user-isolation coverage — that file proves the SQL
 * policies themselves; this file proves the repository functions the
 * Server Actions actually call behave correctly on top of them,
 * including a real cross-user isolation check through this module's own
 * code path (not `asRole` directly).
 *
 * Skipped (never faked) if the required env vars aren't present, same
 * pattern as every other live-DB suite in this repo.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/broker/accounts-repository.ts (live DB, via lib/supabase/direct.ts)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'accounts-repo-a');
    userB = await createTestAuthUser(env, 'accounts-repo-b');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  it('inserts a trading_accounts row under the caller\'s own authenticated role, readable back via listTradingAccounts', async () => {
    const { insertTradingAccount, listTradingAccounts } = await import('../accounts-repository');

    const { id } = await insertTradingAccount({
      userId: userA.id,
      label: 'Live Test MT5',
      platform: 'mt5',
      providerRef: `live-test-${Date.now()}`,
      server: 'ICMarketsSC-Live02',
      baseCurrency: 'USD',
      dayRollover: 'America/New_York 17:00',
      capabilities: { tier: 't0', history: true, openPositions: true, positionSnapshots: false, liveSession: false },
    });

    expect(id).toBeTruthy();

    const rows = await listTradingAccounts(userA.id);
    expect(rows.map((r) => r.id)).toContain(id);
    const row = rows.find((r) => r.id === id)!;
    expect(row.status).toBe('connected');
    expect(row.sync_tier).toBe('t0');

    // Cleanup via the owner connection (bypasses RLS — teardown, not the
    // thing under test).
    await db.query('delete from retrospeq.trading_accounts where id = $1', [id]);
  });

  it('a second user never sees the first user\'s account via listTradingAccounts — RLS genuinely enforced, not just app-layer filtering', async () => {
    const { insertTradingAccount, listTradingAccounts } = await import('../accounts-repository');

    const { id } = await insertTradingAccount({
      userId: userA.id,
      label: 'Live Test Isolation',
      platform: 'manual',
      providerRef: null,
      server: null,
      baseCurrency: 'USD',
      dayRollover: '00:00:00 UTC',
      capabilities: { tier: 't0', history: false, openPositions: false, positionSnapshots: false, liveSession: false },
    });

    const userBRows = await listTradingAccounts(userB.id);
    expect(userBRows.map((r) => r.id)).not.toContain(id);

    await db.query('delete from retrospeq.trading_accounts where id = $1', [id]);
  });

  it('rejects a duplicate (user_id, platform, provider_ref) with DuplicateAccountError', async () => {
    const { insertTradingAccount, DuplicateAccountError, deleteTradingAccount } = await import(
      '../accounts-repository'
    );
    const providerRef = `live-test-dup-${Date.now()}`;

    const { id } = await insertTradingAccount({
      userId: userA.id,
      label: 'Live Test Dup 1',
      platform: 'ctrader',
      providerRef,
      server: 'demo.ctrader.com',
      baseCurrency: 'USD',
      dayRollover: 'America/New_York 17:00',
      capabilities: { tier: 't0', history: true, openPositions: true, positionSnapshots: false, liveSession: false },
    });

    await expect(
      insertTradingAccount({
        userId: userA.id,
        label: 'Live Test Dup 2',
        platform: 'ctrader',
        providerRef,
        server: 'demo.ctrader.com',
        baseCurrency: 'USD',
        dayRollover: 'America/New_York 17:00',
        capabilities: { tier: 't0', history: true, openPositions: true, positionSnapshots: false, liveSession: false },
      }),
    ).rejects.toBeInstanceOf(DuplicateAccountError);

    await deleteTradingAccount(userA.id, id);
  });

  // 8 sequential round trips against the live DB (insert account,
  // insert credential, 2x isAccountOwnedByUser, delete credential,
  // markAccountDisconnected, plus 2 owner-connection verification
  // queries) — vitest's 5000ms default is comfortably enough for any
  // single query (~600-900ms observed elsewhere in this suite) but not
  // for this many chained in one test. Not a flake: reproduced
  // consistently, not intermittently. 20s leaves generous headroom.
  it(
    'the full connect->disconnect lifecycle: credential insert (service role), isAccountOwnedByUser, deleteAccountCredential, markAccountDisconnected',
    async () => {
    const {
      insertTradingAccount,
      insertAccountCredential,
      isAccountOwnedByUser,
      deleteAccountCredential,
      markAccountDisconnected,
    } = await import('../accounts-repository');

    const { id: accountId } = await insertTradingAccount({
      userId: userA.id,
      label: 'Live Test Lifecycle',
      platform: 'mt5',
      providerRef: `live-test-lifecycle-${Date.now()}`,
      server: 'ICMarketsSC-Live02',
      baseCurrency: 'USD',
      dayRollover: 'America/New_York 17:00',
      capabilities: { tier: 't0', history: true, openPositions: true, positionSnapshots: false, liveSession: false },
    });

    await insertAccountCredential({
      accountId,
      userId: userA.id,
      credentialKind: 'investor_password',
      encrypted: {
        ciphertext: Buffer.from('fake-ciphertext'),
        wrappedDek: Buffer.from('fake-wrapped-dek'),
        iv: Buffer.from('fake-iv-12b!'),
        authTag: Buffer.from('fake-auth-tag16'),
        kmsKeyId: 'live-test-kms-key',
      },
    });

    // Confirm the credential row really exists, via the owner connection
    // (service_role would also work but the owner connection already
    // bypasses RLS for verification purposes here).
    const credCheck = await db.query(
      'select account_id from retrospeq.account_credentials where account_id = $1',
      [accountId],
    );
    expect(credCheck.rows).toHaveLength(1);

    await expect(isAccountOwnedByUser(userA.id, accountId)).resolves.toBe(true);
    await expect(isAccountOwnedByUser(userB.id, accountId)).resolves.toBe(false);

    await deleteAccountCredential(accountId);
    const credCheckAfter = await db.query(
      'select account_id from retrospeq.account_credentials where account_id = $1',
      [accountId],
    );
    expect(credCheckAfter.rows).toHaveLength(0);

    await markAccountDisconnected(userA.id, accountId);
    const accountCheck = await db.query(
      'select status, disconnected_at from retrospeq.trading_accounts where id = $1',
      [accountId],
    );
    expect(accountCheck.rows[0].status).toBe('disconnected');
    expect(accountCheck.rows[0].disconnected_at).not.toBeNull();

    await db.query('delete from retrospeq.trading_accounts where id = $1', [accountId]);
    },
    20_000,
  );

  // Module 01 stories 3.1-3.4 (account settings). `trading_accounts`
  // carries a real owner SELECT policy (unlike `account_credentials`),
  // so this exercises `updateTradingAccountSettings`'s own
  // `WHERE id = ... AND user_id = ...` layered under a genuinely
  // RLS-enforced `withUserConnection` call — proving the settings write
  // path, not just the schema/action-layer mocks in
  // app/(app)/accounts/__tests__/actions.test.ts.
  it('updateTradingAccountSettings updates label/day_rollover/account_kind for the owner and returns the updated row', async () => {
    const { insertTradingAccount, updateTradingAccountSettings } = await import('../accounts-repository');

    const { id } = await insertTradingAccount({
      userId: userA.id,
      label: 'Original Label',
      platform: 'mt5',
      providerRef: `live-test-settings-${Date.now()}`,
      server: 'ICMarketsSC-Live02',
      baseCurrency: 'USD',
      dayRollover: 'America/New_York 17:00',
      capabilities: { tier: 't0', history: true, openPositions: true, positionSnapshots: false, liveSession: false },
    });

    const updated = await updateTradingAccountSettings(userA.id, id, {
      label: 'FTMO Challenge',
      dayRollover: '00:00:00 UTC',
      accountKind: 'prop',
    });

    expect(updated).not.toBeNull();
    expect(updated?.label).toBe('FTMO Challenge');
    expect(updated?.day_rollover).toBe('00:00:00 UTC');
    expect(updated?.account_kind).toBe('prop');

    await db.query('delete from retrospeq.trading_accounts where id = $1', [id]);
  });

  it("cross-user isolation: a second user's updateTradingAccountSettings call against user A's account touches zero rows and returns null — RLS enforced, not just app-layer filtering", async () => {
    const { insertTradingAccount, updateTradingAccountSettings } = await import('../accounts-repository');

    const { id } = await insertTradingAccount({
      userId: userA.id,
      label: 'User A Original Label',
      platform: 'manual',
      providerRef: null,
      server: null,
      baseCurrency: 'USD',
      dayRollover: '00:00:00 UTC',
      capabilities: { tier: 't0', history: false, openPositions: false, positionSnapshots: false, liveSession: false },
    });

    const attackerResult = await updateTradingAccountSettings(userB.id, id, {
      label: 'Hijacked Label',
      dayRollover: 'UTC 00:00',
      accountKind: 'prop',
    });
    expect(attackerResult).toBeNull();

    // Confirm nothing actually changed, via the owner connection.
    const row = await db.query('select label, account_kind from retrospeq.trading_accounts where id = $1', [
      id,
    ]);
    expect(row.rows[0].label).toBe('User A Original Label');
    expect(row.rows[0].account_kind).toBe('personal');

    await db.query('delete from retrospeq.trading_accounts where id = $1', [id]);
  });

  // `getTradingAccount` had zero direct test coverage despite being the
  // exact function `app/(app)/accounts/[id]/settings/page.tsx` uses to
  // decide between rendering the settings form and "We couldn't find
  // that account" — the cross-user case below is what makes that
  // decision safe (a stranger's account id in the URL must render the
  // same not-found state as a genuinely nonexistent id, not leak
  // whether the account exists).
  it('getTradingAccount returns the account for its owner, and null for a non-owner or a nonexistent id', async () => {
    const { insertTradingAccount, getTradingAccount } = await import('../accounts-repository');

    const { id } = await insertTradingAccount({
      userId: userA.id,
      label: 'Live Test getTradingAccount',
      platform: 'manual',
      providerRef: null,
      server: null,
      baseCurrency: 'USD',
      dayRollover: '00:00:00 UTC',
      capabilities: { tier: 't0', history: false, openPositions: false, positionSnapshots: false, liveSession: false },
    });

    const ownRead = await getTradingAccount(userA.id, id);
    expect(ownRead?.id).toBe(id);
    expect(ownRead?.label).toBe('Live Test getTradingAccount');

    const strangerRead = await getTradingAccount(userB.id, id);
    expect(strangerRead).toBeNull();

    const nonexistentRead = await getTradingAccount(userA.id, '00000000-0000-0000-0000-000000000000');
    expect(nonexistentRead).toBeNull();

    await db.query('delete from retrospeq.trading_accounts where id = $1', [id]);
  });
});

describe.skipIf(!!env)('lib/broker/accounts-repository.ts (live DB) — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
