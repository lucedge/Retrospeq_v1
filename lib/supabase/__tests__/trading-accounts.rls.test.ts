import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from './rls-test-helpers';

/**
 * Module 01 §7.2 "Cross-user isolation ... 100% table coverage,
 * automated" for `retrospeq.trading_accounts` and
 * `retrospeq.account_credentials` (supabase/migrations/
 * 20260820040000_trading_accounts.sql). Runs against the real, live
 * shared dev/test Supabase Postgres project (.env.local) — not a mock,
 * skipped (never faked) if the required env vars aren't present, same
 * pattern as `profiles.rls.test.ts` / `rate-limit.rls.test.ts`.
 *
 * `account_credentials` is the security-critical half of this file:
 * Module 01 §3.3's "no select policy for any role except service" must
 * hold even for the owning user — this is the mechanical backstop
 * behind "the client can create and destroy a credential it can never
 * read back."
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq.trading_accounts / account_credentials — RLS cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'trading-a');
    userB = await createTestAuthUser(env, 'trading-b');

    // Seed one trading_accounts row per user via the owner connection
    // (bypasses RLS — this is setup, not the thing under test).
    const insertA = await db.query(
      `insert into retrospeq.trading_accounts
         (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'RLS Test Account A', 'mt5', 'USD', 'America/New_York 17:00')
       returning id`,
      [userA.id],
    );
    accountA = insertA.rows[0].id;

    const insertB = await db.query(
      `insert into retrospeq.trading_accounts
         (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'RLS Test Account B', 'mt5', 'USD', 'America/New_York 17:00')
       returning id`,
      [userB.id],
    );
    accountB = insertB.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // Cascades to trading_accounts (FK on_delete cascade from
    // profiles) and account_credentials (FK on_delete cascade from
    // trading_accounts) — no orphaned test data.
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  describe('trading_accounts — standard owner policy', () => {
    it('user A can select their own trading_accounts row', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.trading_accounts where id = $1', [
          accountA,
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it("user A cannot select user B's trading_accounts row", async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.trading_accounts where id = $1', [
          accountB,
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('an unfiltered select as user A never includes user B\'s account', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.trading_accounts');
        return res.rows;
      });
      expect(rows.map((r) => r.id)).toContain(accountA);
      expect(rows.map((r) => r.id)).not.toContain(accountB);
    });

    it('an anonymous client cannot select any trading_accounts rows', async () => {
      const rows = await asRole(db, 'anon', null, async (c) => {
        const res = await c.query('select id from retrospeq.trading_accounts');
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it("user A cannot update user B's trading_accounts row — zero rows affected", async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `update retrospeq.trading_accounts set label = 'hijacked' where id = $1`,
          [accountB],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it("user A cannot delete user B's trading_accounts row — zero rows affected", async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('delete from retrospeq.trading_accounts where id = $1', [
          accountB,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
      const check = await db.query('select id from retrospeq.trading_accounts where id = $1', [
        accountB,
      ]);
      expect(check.rows).toHaveLength(1);
    });

    it('user A can insert a new trading_accounts row for themselves', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.trading_accounts
             (user_id, label, platform, base_currency, day_rollover)
           values ($1, 'RLS Test Insert', 'manual', 'USD', '00:00:00 UTC')
           returning id`,
          [userA.id],
        );
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      // Cleanup via owner connection (outside the rolled-back asRole
      // transaction, this row was already rolled back automatically —
      // asRole always rolls back, see its own doc comment. Nothing to
      // clean up here; this assertion is just proving the insert
      // succeeded within the transaction before rollback.)
    });

    it('user A cannot insert a trading_accounts row claiming to belong to user B', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.trading_accounts
               (user_id, label, platform, base_currency, day_rollover)
             values ($1, 'Impersonation attempt', 'manual', 'USD', '00:00:00 UTC')`,
            [userB.id],
          );
        }),
      ).rejects.toThrow();
    });

    it('the service role can read across users — RLS bypass is by design, not a leak', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('select id from retrospeq.trading_accounts where id in ($1, $2)', [
          accountA,
          accountB,
        ]);
        return res.rows;
      });
      expect(rows.map((r) => r.id).sort()).toEqual([accountA, accountB].sort());
    });
  });

  describe('account_credentials — no select/update policy for any client role (Module 01 §3.3)', () => {
    // NOTE on RETURNING: `insert ... returning` implicitly requires the
    // same row-visibility check a SELECT policy would grant — since none
    // exists here on purpose, every insert in this block omits
    // RETURNING and checks `rowCount` instead. See
    // docs/adr/0005-account-credentials-writes-via-service-role.md for
    // the full, verified explanation (this is real Postgres RLS
    // behavior, not a quirk of this test file).
    it('user A can insert a credential for their own account (no RETURNING)', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.account_credentials
             (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
           values ($1, $2, '\\x00', '\\x00', '\\x00', '\\x00', 'test-key', 'investor_password', true)`,
          [accountA, userA.id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
      // asRole always rolls back (see its own doc comment), so this
      // insert never actually persists past this test — the assertion
      // above is proving the RLS policy allowed it within the
      // transaction, nothing more.
    });

    it('user A cannot insert a credential claiming to belong to user B (even for their own account row)', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.account_credentials
               (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
             values ($1, $2, '\\x00', '\\x00', '\\x00', '\\x00', 'test-key', 'investor_password', true)`,
            [accountA, userB.id],
          );
        }),
      ).rejects.toThrow();
    });

    it('the database rejects an insert claiming verified_readonly = false — the check constraint backstop', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.account_credentials
               (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
             values ($1, $2, '\\x00', '\\x00', '\\x00', '\\x00', 'test-key', 'investor_password', false)`,
            [accountA, userA.id],
          );
        }),
      ).rejects.toThrow(/account_credentials_must_be_verified_readonly/);
    });

    describe('with a real committed credential row (owner-seeded, since asRole always rolls back)', () => {
      beforeAll(async () => {
        if (!env) return;
        await db.query(
          `insert into retrospeq.account_credentials
             (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
           values ($1, $2, '\\x00', '\\x00', '\\x00', '\\x00', 'test-key', 'investor_password', true)
           on conflict (account_id) do nothing`,
          [accountA, userA.id],
        );
      });

      it('the owning user CANNOT select their own credential row — no select policy exists at all', async () => {
        const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
          const res = await c.query(
            'select account_id from retrospeq.account_credentials where account_id = $1',
            [accountA],
          );
          return res.rows;
        });
        expect(rows).toHaveLength(0);
      });

      it('an unfiltered select as the owning user returns zero rows, not just a narrowed set', async () => {
        const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
          const res = await c.query('select account_id from retrospeq.account_credentials');
          return res.rows;
        });
        expect(rows).toHaveLength(0);
      });

      it('an anonymous client cannot select any account_credentials rows', async () => {
        const rows = await asRole(db, 'anon', null, async (c) => {
          const res = await c.query('select account_id from retrospeq.account_credentials');
          return res.rows;
        });
        expect(rows).toHaveLength(0);
      });

      it('the owning user cannot update their own credential row — no update policy exists at all (silent no-op, not an error, matching the profiles-table owner-policy pattern for a non-matching row)', async () => {
        const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
          const res = await c.query(
            `update retrospeq.account_credentials set kms_key_id = 'hijacked' where account_id = $1`,
            [accountA],
          );
          return res.rowCount;
        });
        expect(rowCount).toBe(0);
        // Confirmed untouched from the owner connection, outside the
        // rolled-back transaction (belt and suspenders — the rollback
        // alone already guarantees this).
        const check = await db.query(
          'select kms_key_id from retrospeq.account_credentials where account_id = $1',
          [accountA],
        );
        expect(check.rows[0]?.kms_key_id).not.toBe('hijacked');
      });

      it(
        'the owning user CANNOT delete their own credential row via a WHERE-qualified DELETE ' +
          '— see docs/adr/0005: with no SELECT policy, Postgres cannot evaluate a qualified ' +
          'DELETE at all under RLS, regardless of the DELETE policy’s own USING clause. ' +
          'This is exactly why the real disconnect flow must use the service-role client ' +
          '(next slice), not a direct RLS-scoped delete.',
        async () => {
          const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
            const res = await c.query(
              'delete from retrospeq.account_credentials where account_id = $1',
              [accountA],
            );
            return res.rowCount;
          });
          expect(rowCount).toBe(0);
        },
      );

      it('the service role CAN delete a specific credential row by account_id — the real disconnect path', async () => {
        const rowCount = await asRole(db, 'service_role', null, async (c) => {
          const res = await c.query(
            'delete from retrospeq.account_credentials where account_id = $1',
            [accountA],
          );
          return res.rowCount;
        });
        expect(rowCount).toBe(1);
      });

      it('the service role can select the credential row — RLS bypass is by design, not a leak', async () => {
        const rows = await asRole(db, 'service_role', null, async (c) => {
          const res = await c.query(
            'select account_id, verified_readonly from retrospeq.account_credentials where account_id = $1',
            [accountA],
          );
          return res.rows;
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].verified_readonly).toBe(true);
      });

      afterAll(async () => {
        if (!env) return;
        await db
          .query('delete from retrospeq.account_credentials where account_id = $1', [accountA])
          .catch(() => {});
      });
    });
  });
});

describe.skipIf(!!env)('retrospeq.trading_accounts / account_credentials RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
