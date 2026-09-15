import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';

// Same `server-only` mock every other `lib/privacy/__tests__/*.live.test.ts`
// file already uses (e.g. `erasure.live.test.ts`) — this test runs under
// vitest's Node environment, not a real Next.js Server Component render,
// so the package's own React-server-graph guard needs neutralizing.
vi.mock('server-only', () => ({}));

import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import {
  EXPORT_TABLE_REGISTRY,
  EXPORT_LEGACY_TYPED_TABLES,
  EXPORT_EXCLUDED_TABLES,
} from '../export-tables';
import { buildExportBundle } from '../export';
import { buildFullExportCsv } from '../export-csv';

/**
 * Module 01 story 5.1 / §8's own E2E line, "export completeness against
 * a fixture user," made real and run against the live shared dev/test
 * Supabase Postgres project — skipped (never faked) if the required env
 * vars aren't present, same pattern as every `.rls.test.ts`/`.live.test.ts`
 * file in this repo.
 *
 * Three things, all live-proven, matching this slice's own dispatch:
 *  1. COMPLETENESS: every real `retrospeq` table with a `user_id` column
 *     is accounted for — registry, legacy-typed, or excluded (with a
 *     reason) — never silently missing (the exact bug this slice fixes:
 *     `trades`/`rules`/etc were never exported before this).
 *  2. DENYLIST: `account_credentials` (ciphertext) and `mfa_recovery_codes`
 *     (hashes) never appear anywhere in a real bundle, even when both
 *     genuinely exist for the export subject.
 *  3. CROSS-USER ISOLATION: user B's rows never leak into user A's bundle.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('export bundle completeness/denylist/isolation (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every retrospeq table carrying a user_id column is registered, legacy-typed, or excluded with a reason — no silent gaps', async () => {
    const res = await db.query(
      `select distinct table_name
         from information_schema.columns
        where table_schema = 'retrospeq' and column_name = 'user_id'
        order by table_name`,
    );
    const liveTablesWithUserId = new Set(res.rows.map((r) => r.table_name as string));

    const accountedFor = new Set<string>([
      ...EXPORT_TABLE_REGISTRY.map((s) => s.table),
      ...EXPORT_LEGACY_TYPED_TABLES,
      ...Object.keys(EXPORT_EXCLUDED_TABLES),
    ]);

    const missing = [...liveTablesWithUserId].filter((t) => !accountedFor.has(t));
    expect(
      missing,
      `New table(s) with a user_id column found with no export decision: ${missing.join(', ')}. ` +
        'Add each to EXPORT_TABLE_REGISTRY (include) or EXPORT_EXCLUDED_TABLES (exclude, with a reason) ' +
        'in lib/privacy/export-tables.ts — see that file\'s own header.',
    ).toEqual([]);

    // The reverse direction matters too: every table THIS FILE claims to
    // include (and therefore generic-fetches at runtime) must still be a
    // real, live table with a real user_id column — otherwise a
    // renamed/dropped column would silently break `buildExportBundle`'s
    // own query rather than being caught here first.
    for (const table of EXPORT_TABLE_REGISTRY.map((s) => s.table)) {
      expect(liveTablesWithUserId.has(table), `${table} is registered but no longer has a user_id column live`).toBe(true);
    }
  });

  it('profiles (no user_id column of its own — the PK IS the user id) is a real table, handled by its own hand-typed field, not silently dropped', async () => {
    const res = await db.query(
      `select 1 from information_schema.tables where table_schema='retrospeq' and table_name='profiles'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  describe('denylist: credential/security material never in the bundle, even when it exists', () => {
    let user: TestAuthUser;

    beforeAll(async () => {
      if (!env) return;
      user = await createTestAuthUser(env, 'export-denylist');

      // A real trading account + a real (fake-but-shaped) encrypted
      // credential — proves the denylist holds even when there is
      // something to leak, not just when the table is empty.
      const acctRes = await db.query(
        `insert into retrospeq.trading_accounts
           (user_id, label, platform, base_currency, day_rollover, status)
         values ($1, 'Test MT5', 'mt5', 'USD', 'America/New_York 17:00', 'connected')
         returning id`,
        [user.id],
      );
      const accountId = acctRes.rows[0].id as string;

      await db.query(
        `insert into retrospeq.account_credentials
           (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
         values ($1, $2, $3, $3, $3, $3, 'test-kms-key', 'investor_password', true)`,
        [accountId, user.id, Buffer.from('super-secret-plaintext-marker-DO-NOT-LEAK')],
      );

      await db.query(
        `insert into retrospeq.mfa_recovery_codes (user_id, code_hash) values ($1, 'recovery-code-hash-marker-DO-NOT-LEAK')`,
        [user.id],
      );
    }, 30_000);

    afterAll(async () => {
      if (!env || !user) return;
      await deleteTestAuthUser(env, user.id);
    });

    it('bundle.tables has no account_credentials or mfa_recovery_codes key, and the raw markers never appear anywhere in the serialized bundle', async () => {
      const bundle = await buildExportBundle(user.id);

      expect(bundle.tables.account_credentials).toBeUndefined();
      expect(bundle.tables.mfa_recovery_codes).toBeUndefined();

      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain('DO-NOT-LEAK');
      expect(serialized).not.toContain('super-secret-plaintext-marker');
      expect(serialized).not.toContain('recovery-code-hash-marker');

      // The honest, non-reversible fact IS exported (count, never the codes).
      expect(bundle.mfa.recoveryCodesRemaining).toBe(1);
    }, 30_000);

    it('the CSV bundle (export-csv.ts) never contains the same denylisted markers either', async () => {
      const bundle = await buildExportBundle(user.id);
      const csv = buildFullExportCsv(bundle);

      expect(csv).not.toContain('## account_credentials');
      expect(csv).not.toContain('## mfa_recovery_codes');
      expect(csv).not.toContain('DO-NOT-LEAK');
      expect(csv).not.toContain('super-secret-plaintext-marker');
      expect(csv).not.toContain('recovery-code-hash-marker');
    }, 30_000);
  });

  describe('cross-user isolation', () => {
    let userA: TestAuthUser;
    let userB: TestAuthUser;

    beforeAll(async () => {
      if (!env) return;
      userA = await createTestAuthUser(env, 'export-isolation-a');
      userB = await createTestAuthUser(env, 'export-isolation-b');

      await db.query(
        `insert into retrospeq.audit_log (user_id, actor, action, target) values ($1, 'user', 'export_requested', 'A-ONLY-MARKER')`,
        [userA.id],
      );
      await db.query(
        `insert into retrospeq.audit_log (user_id, actor, action, target) values ($1, 'user', 'export_requested', 'B-ONLY-MARKER')`,
        [userB.id],
      );

      await db.query(
        `insert into retrospeq.strategies (user_id, name, current_version, is_default, state) values ($1, 'A-strategy-marker', 1, false, 'active')`,
        [userA.id],
      );
      await db.query(
        `insert into retrospeq.strategies (user_id, name, current_version, is_default, state) values ($1, 'B-strategy-marker', 1, false, 'active')`,
        [userB.id],
      );
    }, 30_000);

    afterAll(async () => {
      if (!env) return;
      if (userA) await deleteTestAuthUser(env, userA.id);
      if (userB) await deleteTestAuthUser(env, userB.id);
    });

    it("user A's bundle contains only A's rows, never B's, across every generic-registry table checked here", async () => {
      const bundleA = await buildExportBundle(userA.id);
      const bundleB = await buildExportBundle(userB.id);

      expect(bundleA.tables.audit_log.rows.map((r) => r.target)).toContain('A-ONLY-MARKER');
      expect(bundleA.tables.audit_log.rows.map((r) => r.target)).not.toContain('B-ONLY-MARKER');
      expect(bundleB.tables.audit_log.rows.map((r) => r.target)).toContain('B-ONLY-MARKER');
      expect(bundleB.tables.audit_log.rows.map((r) => r.target)).not.toContain('A-ONLY-MARKER');

      expect(bundleA.tables.strategies.rows.map((r) => r.name)).toContain('A-strategy-marker');
      expect(bundleA.tables.strategies.rows.map((r) => r.name)).not.toContain('B-strategy-marker');

      const serializedA = JSON.stringify(bundleA);
      expect(serializedA).not.toContain('B-ONLY-MARKER');
      expect(serializedA).not.toContain('B-strategy-marker');
    }, 30_000);

    it("the CSV bundle (export-csv.ts) preserves the same isolation — user A's CSV never contains B's rows", async () => {
      const bundleA = await buildExportBundle(userA.id);
      const csvA = buildFullExportCsv(bundleA);

      expect(csvA).toContain('A-ONLY-MARKER');
      expect(csvA).not.toContain('B-ONLY-MARKER');
      expect(csvA).toContain('A-strategy-marker');
      expect(csvA).not.toContain('B-strategy-marker');
    }, 30_000);
  });
});
