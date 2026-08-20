import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { asRole, connectAsOwner, readRlsTestEnv } from '@/lib/supabase/__tests__/rls-test-helpers';

/**
 * `retrospeq.rate_limit_hits` / `retrospeq.increment_rate_limit`
 * (supabase/migrations/20260820030000_rate_limit_hits.sql) — 00-foundation
 * §9.1's "RLS cross-user isolation asserted on 100% of tables, automated"
 * applies here too, even though this table has no per-user owner column
 * (its RLS shape is "no policy at all," the same pattern
 * `account_credentials` uses per Module 01 §3.3 — deny by default,
 * service role only). Runs against the real, live shared dev/test
 * Supabase Postgres project; skipped (not faked) if the env isn't there.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq.rate_limit_hits — service-role-only access (live DB)', () => {
  let db: Client;
  const scope = `test.rls.${Date.now()}`;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // Best-effort cleanup of anything a non-rolled-back path might have
    // left behind (none currently do, but this keeps the suite honest
    // if that ever changes).
    await db.query('delete from retrospeq.rate_limit_hits where scope = $1', [scope]).catch(() => {});
    await db.end();
  });

  it('an anonymous client cannot select any rate_limit_hits rows', async () => {
    const rows = await asRole(db, 'anon', null, async (c) => {
      const res = await c.query('select scope from retrospeq.rate_limit_hits');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('an authenticated client cannot select any rate_limit_hits rows, even its own IP/email bucket', async () => {
    const rows = await asRole(db, 'authenticated', null, async (c) => {
      const res = await c.query('select scope from retrospeq.rate_limit_hits');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('an authenticated client cannot insert directly into rate_limit_hits — bookkeeping goes through the function only', async () => {
    await expect(
      asRole(db, 'authenticated', null, async (c) => {
        await c.query(
          `insert into retrospeq.rate_limit_hits (scope, identifier, window_start) values ($1, 'ip:1.2.3.4', now())`,
          [scope],
        );
      }),
    ).rejects.toThrow();
  });

  it('an authenticated client cannot call increment_rate_limit — EXECUTE is revoked from everyone but service_role', async () => {
    await expect(
      asRole(db, 'authenticated', null, async (c) => {
        await c.query('select retrospeq.increment_rate_limit($1, $2, now())', [
          scope,
          'ip:1.2.3.4',
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the service role can read across the table — RLS bypass is by design, not a leak', async () => {
    const rows = await asRole(db, 'service_role', null, async (c) => {
      await c.query(
        `insert into retrospeq.rate_limit_hits (scope, identifier, window_start, count) values ($1, 'ip:9.9.9.9', now(), 1)`,
        [scope],
      );
      const res = await c.query('select scope from retrospeq.rate_limit_hits where scope = $1', [
        scope,
      ]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it('increment_rate_limit atomically increments an existing bucket rather than overwriting it', async () => {
    const counts = await asRole(db, 'service_role', null, async (c) => {
      const windowStart = new Date(0).toISOString(); // fixed bucket, isolated by the unique test scope
      const first = await c.query('select retrospeq.increment_rate_limit($1, $2, $3) as count', [
        scope,
        'ip:5.5.5.5',
        windowStart,
      ]);
      const second = await c.query('select retrospeq.increment_rate_limit($1, $2, $3) as count', [
        scope,
        'ip:5.5.5.5',
        windowStart,
      ]);
      const third = await c.query('select retrospeq.increment_rate_limit($1, $2, $3) as count', [
        scope,
        'ip:5.5.5.5',
        windowStart,
      ]);
      return [first.rows[0].count, second.rows[0].count, third.rows[0].count];
    });
    expect(counts).toEqual([1, 2, 3]);
  });

  it('a different identifier in the same scope+window gets its own independent count', async () => {
    const counts = await asRole(db, 'service_role', null, async (c) => {
      const windowStart = new Date(0).toISOString();
      await c.query('select retrospeq.increment_rate_limit($1, $2, $3)', [
        scope,
        'ip:6.6.6.6',
        windowStart,
      ]);
      const otherFirst = await c.query(
        'select retrospeq.increment_rate_limit($1, $2, $3) as count',
        [scope, 'ip:7.7.7.7', windowStart],
      );
      return otherFirst.rows[0].count;
    });
    expect(counts).toBe(1);
  });
});

describe.skipIf(!!env)('retrospeq.rate_limit_hits RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
