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

// Forces `createManualTrade`'s phase 2 (`withServiceRoleConnection` ->
// `recomputeInstrument`) to fail, so this file lives separately from
// `manual-entry.live.test.ts` rather than inside it — mocking
// `recomputeInstrument` here would otherwise also break every happy-path
// test in that file, which needs the real implementation.
vi.mock('../sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync')>();
  return {
    ...actual,
    recomputeInstrument: vi.fn(async () => {
      throw new Error('forced phase 2 failure for test — simulates a service-role/derivation error after phase 1 already committed');
    }),
  };
});

/**
 * Module 02 §4.8 — proves the two-phase write's known, currently
 * UNMITIGATED failure-mode gap (flagged, not silently accepted — see
 * `manual-entry.ts`'s header, "Known gap: an orphaned-fills window between
 * phase 1 and phase 2" paragraph, added alongside this test):
 *
 * Phase 1 (`withUserConnection`, inserting the two synthetic `fills` rows)
 * and phase 2 (`withServiceRoleConnection`, `recomputeInstrument`) are two
 * INDEPENDENT transactions (`lib/supabase/direct.ts`'s `withRole` commits
 * per call, not once across both calls). If phase 1 succeeds and phase 2
 * throws for any reason, the two fills are already durably committed with
 * no trade/block ever derived from them — and because `sync.ts`'s
 * `runSync` explicitly skips `platform = 'manual'` accounts
 * (`{ skipped: true, reason: 'manual_account' }`), nothing else in this
 * repo will ever retry deriving a trade from them. This test proves that
 * state is real, not hypothetical, and pins it as a known/regression-
 * tracked gap rather than an assumed one.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/ingestion/manual-entry.ts — phase 2 failure leaves orphaned fills (live DB, known gap)', () => {
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
      // No trade/block was ever created for the orphaned-fills scenario
      // this file exercises, so — unlike every other live test file's
      // cleanup, which deletes via `trades` and lets FKs cascade — the
      // fills themselves must be deleted directly here.
      await db.query('delete from retrospeq.fills where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedManualAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Manual Entry Phase2 Failure Live Test', 'manual', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  it('phase 1 fills are committed and durable, but no block/trade is ever derived, when phase 2 throws', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'manual-phase2-fail');
    cleanupUserIds.push(user.id);
    const accountId = await seedManualAccount(user.id);

    const { createManualTrade } = await import('../manual-entry');

    await expect(
      createManualTrade(user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        size: '100000',
        entryPrice: '1.10000000',
        exitPrice: '1.10500000',
        stop: '1.09500000',
        enteredAt: '2026-08-01T09:00:00Z',
        exitedAt: '2026-08-01T11:00:00Z',
      }),
    ).rejects.toThrow(/forced phase 2 failure/);

    // The gap, proven concretely: phase 1's two fills are durably
    // committed (a separate, already-COMMITted transaction — phase 2's
    // failure cannot roll them back) ...
    const fillsRes = await db.query(
      `select id, provider_ref from retrospeq.fills where account_id = $1 order by filled_at`,
      [accountId],
    );
    expect(fillsRes.rows).toHaveLength(2);
    expect(fillsRes.rows[0].provider_ref).toMatch(/^manual:/);
    expect(fillsRes.rows[1].provider_ref).toMatch(/^manual:/);

    // ... but no block and no trade were ever derived from them.
    const blocksRes = await db.query(`select count(*)::int as n from retrospeq.blocks where account_id = $1`, [
      accountId,
    ]);
    expect(blocksRes.rows[0].n).toBe(0);
    const tradesRes = await db.query(`select count(*)::int as n from retrospeq.trades where account_id = $1`, [
      accountId,
    ]);
    expect(tradesRes.rows[0].n).toBe(0);

    // And nothing else in this repo will ever pick these fills back up —
    // `runSync` explicitly skips manual accounts (`sync.ts`, "manual
    // accounts have no credential and nothing to sync from"), so there is
    // no retry path. This assertion documents that fact rather than
    // testing `runSync` itself (covered by `sync.live.test.ts`/
    // `sync.test.ts`).
    const { runSync } = await import('../sync');
    void runSync; // exists, but is never invoked for platform = 'manual' accounts anywhere in this codebase.
  });
});
