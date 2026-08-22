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
 * Module 02 §3.1/§4.7, docs/adr/0011-ingestion-rls-shape.md — RLS
 * coverage and shape for all 11 ingestion tables
 * (`supabase/migrations/20260822010000_ingestion_schema.sql`), plus the
 * `trades` broker-confirmed-delete trigger. Runs against the real, live
 * shared dev/test Supabase Postgres project — skipped (never faked) if
 * the required env vars aren't present, same pattern as every other RLS
 * test file in this repo.
 *
 * Scope note: this file proves the SCHEMA-LEVEL contract (RLS shape per
 * table, cross-user isolation on the tables that matter most for this
 * slice, the delete trigger) — it seeds rows directly via the owner
 * connection, not through any application code, since no sync
 * pipeline/grouping engine/Server Action exists yet to seed through.
 */
const env = readRlsTestEnv();

const ALL_TABLES = [
  'fills',
  'blocks',
  'trades',
  'trade_fills',
  'trade_events',
  'arm_events',
  'trade_captures',
  'sync_runs',
  'coverage_gaps',
  'day_closeouts',
  'position_snapshots',
] as const;

describe.skipIf(!env)('retrospeq ingestion schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every ingestion table has RLS enabled — 100% coverage, no exceptions (AGENTS.md)', async () => {
    const res = await db.query(
      `select relname, relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'retrospeq' and relname = any($1)`,
      [ALL_TABLES],
    );
    expect(res.rows).toHaveLength(ALL_TABLES.length);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname} should have RLS enabled`).toBe(true);
    }
  });

  it('matches the exact per-table policy shape docs/adr/0011 documents', async () => {
    const res = await db.query(
      `select tablename, policyname, cmd, roles
         from pg_policies
        where schemaname = 'retrospeq' and tablename = any($1)
        order by tablename, cmd`,
      [ALL_TABLES],
    );
    const shape = new Map<string, string[]>();
    for (const row of res.rows) {
      const cmds = shape.get(row.tablename) ?? [];
      cmds.push(row.cmd);
      shape.set(row.tablename, cmds);
    }

    const expectedShape: Record<(typeof ALL_TABLES)[number], string[]> = {
      fills: ['INSERT', 'SELECT'],
      blocks: ['SELECT'],
      trades: ['ALL'],
      trade_fills: ['SELECT'],
      trade_events: ['INSERT', 'SELECT'],
      arm_events: ['ALL'],
      trade_captures: ['ALL'],
      sync_runs: ['SELECT'],
      coverage_gaps: ['SELECT'],
      day_closeouts: ['SELECT'],
      position_snapshots: ['SELECT'],
    };

    for (const table of ALL_TABLES) {
      expect((shape.get(table) ?? []).sort(), `${table} policy command set`).toEqual(
        [...expectedShape[table]].sort(),
      );
    }
  });
});

describe.skipIf(!env)('retrospeq ingestion schema — cross-user isolation and trigger behaviour (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let accountA: string;
  let accountB: string;
  let blockA: string;
  let fillA: string;
  let fillAManual: string;
  let tradeA: string; // broker-originated, open, has a trade_fills row
  let tradeAManual: string; // manual-only, unconfirmed -- deletable
  let tradeEventA: string;
  let armEventA: string;
  let syncRunA: string;
  let coverageGapA: string;
  let positionSnapshotA: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'ingestion-a');
    userB = await createTestAuthUser(env, 'ingestion-b');

    const acctA = await db.query(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Ingestion RLS Test A', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userA.id],
    );
    accountA = acctA.rows[0].id;

    const acctB = await db.query(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Ingestion RLS Test B', 'mt5', 'USD', '00:00:00 UTC') returning id`,
      [userB.id],
    );
    accountB = acctB.rows[0].id;

    const block = await db.query(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, server_day)
       values ($1, $2, 'EURUSD', now(), current_date) returning id`,
      [userA.id, accountA],
    );
    blockA = block.rows[0].id;

    const fill = await db.query(
      `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
       values ($1, $2, 'ingestion-rls-1', 'EURUSD', 'buy', 100000, 1.1, now(), current_date, 'USD') returning id`,
      [userA.id, accountA],
    );
    fillA = fill.rows[0].id;

    const fillManual = await db.query(
      `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
       values ($1, $2, $3, 'EURUSD', 'buy', 50000, 1.1, now(), current_date, 'USD') returning id`,
      [userA.id, accountA, `manual:${crypto.randomUUID()}`],
    );
    fillAManual = fillManual.rows[0].id;

    const trade = await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, server_day, currency, grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', now(), current_date, 'USD', 'confident_single') returning id`,
      [userA.id, accountA, blockA],
    );
    tradeA = trade.rows[0].id;

    await db.query(
      `insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`,
      [tradeA, fillA, userA.id],
    );

    const tradeManual = await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, server_day, currency, grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', now(), current_date, 'USD', 'confident_single') returning id`,
      [userA.id, accountA, blockA],
    );
    tradeAManual = tradeManual.rows[0].id;

    await db.query(
      `insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`,
      [tradeAManual, fillAManual, userA.id],
    );

    // Retrospeq-security-reviewer (2026-08-22): 8 of 11 tables had zero
    // cross-user isolation coverage — only policy metadata (pg_policies)
    // was checked, never a real row-level assertion. Seeding + testing
    // the remainder here.
    const tradeEvent = await db.query(
      `insert into retrospeq.trade_events (user_id, trade_id, fill_id, kind, occurred_at)
       values ($1, $2, $3, 'entry', now()) returning id`,
      [userA.id, tradeA, fillA],
    );
    tradeEventA = tradeEvent.rows[0].id;

    const armEvent = await db.query(
      `insert into retrospeq.arm_events (user_id, account_id, instrument, direction, armed_at)
       values ($1, $2, 'EURUSD', 'long', now()) returning id`,
      [userA.id, accountA],
    );
    armEventA = armEvent.rows[0].id;

    const syncRun = await db.query(
      `insert into retrospeq.sync_runs (account_id, user_id, tier, trigger, window_from, window_to, status)
       values ($1, $2, 't0', 'connect', now() - interval '1 hour', now(), 'ok') returning id`,
      [accountA, userA.id],
    );
    syncRunA = syncRun.rows[0].id;

    const coverageGap = await db.query(
      `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to)
       values ($1, $2, now() - interval '2 hours', now() - interval '1 hour') returning id`,
      [accountA, userA.id],
    );
    coverageGapA = coverageGap.rows[0].id;

    await db.query(
      `insert into retrospeq.day_closeouts (user_id, account_id, server_day, kind, confirmed_at, confirmed_by)
       values ($1, $2, current_date, 'traded', now(), 'user')`,
      [userA.id, accountA],
    );

    const positionSnapshot = await db.query(
      `insert into retrospeq.position_snapshots (user_id, account_id, instrument, taken_at, volume)
       values ($1, $2, 'EURUSD', now(), 100000) returning id`,
      [userA.id, accountA],
    );
    positionSnapshotA = positionSnapshot.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // tradeA is broker-confirmed (a real, non-"manual:" fill backs it).
    // `deleteTestAuthUser` deletes the `auth.users` row through GoTrue's
    // admin REST API -- a SEPARATE Postgres session from `db`, so a
    // `set_config` on `db` can't reach the cascade delete that follows
    // (trading_accounts -> trades) inside GoTrue's own connection.
    // Pre-deleting the trades directly here, on `db`, WITH the escape
    // hatch set for that one transaction, means there is nothing left for
    // GoTrue's later cascade to trip the trigger on -- this mirrors
    // exactly what a real erasure flow must do (delete Module 02 rows
    // itself, transaction-locally, before the account row goes) rather
    // than relying on the cascade alone, consistent with
    // docs/adr/0010-erasure-explicit-delete-order.md's existing "explicit
    // delete list, not cascade reliance" posture for every other table.
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.trades where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('commit');
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  describe('fills — owner SELECT + INSERT, no UPDATE/DELETE for any client role', () => {
    it('user A can select their own fill', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.fills where id = $1', [fillA]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it("user B cannot select user A's fill", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.fills where id = $1', [fillA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A can insert a fill for their own account (manual-entry path, §4.8)', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
           values ($1, $2, $3, 'EURUSD', 'buy', 1, 1.1, now(), current_date, 'USD')`,
          [userA.id, accountA, `manual:${crypto.randomUUID()}`],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('user A cannot insert a fill claiming to belong to user B', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
             values ($1, $2, $3, 'EURUSD', 'buy', 1, 1.1, now(), current_date, 'USD')`,
            [userB.id, accountA, `manual:${crypto.randomUUID()}`],
          );
        }),
      ).rejects.toThrow();
    });

    it(
      "user A cannot insert a fill with a non-manual provider_ref -- fills_owner_insert's WITH CHECK requires provider_ref like 'manual:%' " +
        '(retrospeq-security-reviewer follow-up, 2026-08-22, Module 02 Slice 6: this negative case was previously unproven live, only the manual-prefixed success case and the cross-user rejection were)',
      async () => {
        await expect(
          asRole(db, 'authenticated', userA.id, async (c) => {
            await c.query(
              `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
               values ($1, $2, 'BROKER-DEAL-COLLISION', 'EURUSD', 'buy', 1, 1.1, now(), current_date, 'USD')`,
              [userA.id, accountA],
            );
          }),
        ).rejects.toThrow(/row-level security/i);
      },
    );

    it('user A cannot update their own fill row — no UPDATE policy exists at all (append-only, 00-foundation §2.4)', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.fills set instrument = 'HIJACKED' where id = $1`, [
          fillA,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
      const check = await db.query('select instrument from retrospeq.fills where id = $1', [fillA]);
      expect(check.rows[0].instrument).not.toBe('HIJACKED');
    });

    it('user A cannot delete their own fill row — no DELETE policy exists at all', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('delete from retrospeq.fills where id = $1', [fillA]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
      const check = await db.query('select id from retrospeq.fills where id = $1', [fillA]);
      expect(check.rows).toHaveLength(1);
    });
  });

  describe('blocks — owner SELECT only, no client write path at all', () => {
    it('user A can select their own block', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.blocks where id = $1', [blockA]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it("user B cannot select user A's block", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.blocks where id = $1', [blockA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A cannot insert a block row directly — "never user-editable" (Module 02 §3.1)', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, server_day)
             values ($1, $2, 'EURUSD', now(), current_date)`,
            [userA.id, accountA],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('trade_fills — owner SELECT only', () => {
    it("user A can select their own trade's fill membership row", async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          'select fill_id from retrospeq.trade_fills where trade_id = $1 and fill_id = $2',
          [tradeA, fillA],
        );
        return res.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it("user B cannot select user A's trade_fills row", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select fill_id from retrospeq.trade_fills where trade_id = $1', [
          tradeA,
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A cannot insert a trade_fills row directly — membership is grouping-engine output, no client write path (docs/adr/0011)', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            'insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, $4)',
            [tradeA, fillAManual, userA.id, 'add'],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('trade_events — owner SELECT + INSERT, append-only', () => {
    it('user A can select their own trade_events row', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.trade_events where id = $1', [tradeEventA]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it("user B cannot select user A's trade_events row", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.trade_events where id = $1', [tradeEventA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A can insert a trade_events row for their own trade', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.trade_events (user_id, trade_id, kind, occurred_at) values ($1, $2, 'trim', now())`,
          [userA.id, tradeA],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('user A cannot update their own trade_events row — no UPDATE policy, append-only', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.trade_events set kind = 'exit' where id = $1`, [
          tradeEventA,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });
  });

  describe('arm_events — standard owner "for all" (a real-time user action, not a derived output)', () => {
    it('user A can select and update their own arm_events row', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.arm_events set match_state = 'ambiguous' where id = $1`, [
          armEventA,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user B cannot select or update user A's arm_events row", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.arm_events where id = $1', [armEventA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);

      const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query(`update retrospeq.arm_events set match_state = 'matched' where id = $1`, [
          armEventA,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });
  });

  describe('trade_captures — standard owner "for all" (§4.7 "Edit post-close captures: Always")', () => {
    it('user A can insert and update their own trade_captures row', async () => {
      const insertCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment)
           values ($1, $2, 'conviction', '4', 'post_close')`,
          [tradeA, userA.id],
        );
        return res.rowCount;
      });
      expect(insertCount).toBe(1);
    });

    it("user B cannot see or write user A's trade_captures row", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select field_id from retrospeq.trade_captures where trade_id = $1', [
          tradeA,
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });
  });

  describe('sync_runs / coverage_gaps / day_closeouts / position_snapshots — owner SELECT only, no client write path', () => {
    it('user A can select their own sync_runs, coverage_gaps, day_closeouts, and position_snapshots rows; user B sees none of them', async () => {
      // Sequential, not Promise.all — a single `pg` `Client` cannot
      // safely run concurrent queries (deprecated in `pg`, will be
      // removed in pg@9); `asRole` hands every query in this block the
      // same underlying connection.
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const sync = await c.query('select id from retrospeq.sync_runs where id = $1', [syncRunA]);
        const gap = await c.query('select id from retrospeq.coverage_gaps where id = $1', [coverageGapA]);
        const closeout = await c.query('select server_day from retrospeq.day_closeouts where account_id = $1', [
          accountA,
        ]);
        const snapshot = await c.query('select id from retrospeq.position_snapshots where id = $1', [
          positionSnapshotA,
        ]);
        return { sync: sync.rows, gap: gap.rows, closeout: closeout.rows, snapshot: snapshot.rows };
      });
      expect(ownRows.sync).toHaveLength(1);
      expect(ownRows.gap).toHaveLength(1);
      expect(ownRows.closeout).toHaveLength(1);
      expect(ownRows.snapshot).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const sync = await c.query('select id from retrospeq.sync_runs where id = $1', [syncRunA]);
        const gap = await c.query('select id from retrospeq.coverage_gaps where id = $1', [coverageGapA]);
        const closeout = await c.query('select server_day from retrospeq.day_closeouts where account_id = $1', [
          accountA,
        ]);
        const snapshot = await c.query('select id from retrospeq.position_snapshots where id = $1', [
          positionSnapshotA,
        ]);
        return { sync: sync.rows, gap: gap.rows, closeout: closeout.rows, snapshot: snapshot.rows };
      });
      expect(strangerRows.sync).toHaveLength(0);
      expect(strangerRows.gap).toHaveLength(0);
      expect(strangerRows.closeout).toHaveLength(0);
      expect(strangerRows.snapshot).toHaveLength(0);
    });

    it('user A cannot insert a sync_runs row directly — exclusively sync-worker-written', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.sync_runs (account_id, user_id, tier, trigger, window_from, window_to, status)
             values ($1, $2, 't0', 'on_demand', now(), now(), 'ok')`,
            [accountA, userA.id],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('trades — standard owner "for all" policy (§4.7 real client-driven corrections)', () => {
    it('user A can select their own trade', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.trades where id = $1', [tradeA]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it("user B cannot select user A's trade", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select id from retrospeq.trades where id = $1', [tradeA]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('user A can toggle not_a_decision on their own trade (§4.7)', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.trades set not_a_decision = true where id = $1`, [
          tradeA,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user A cannot update user B's trade — zero rows affected", async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.trades set not_a_decision = true where account_id = $1`, [
          accountB,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });
  });

  describe('trades — broker-confirmed delete trigger (§4.7 "the obvious gaming vector")', () => {
    it('rejects deleting a trade backed by a real (non-manual) fill, even for the service role', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query('delete from retrospeq.trades where id = $1', [tradeA]);
        }),
      ).rejects.toThrow(/cannot delete a broker-confirmed trade/);
    });

    it('allows deleting a manual-only trade before freeze', async () => {
      // asRole always rolls back (see its own doc comment), so this
      // proves the trigger permits the delete WITHIN the transaction
      // without needing to actually persist it — tradeAManual and its
      // trade_fills row are untouched afterward for the next test below.
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('delete from retrospeq.trades where id = $1', [tradeAManual]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('rejects deleting a manual trade after freeze (confirmed_at set)', async () => {
      await db.query(`update retrospeq.trades set confirmed_at = now(), confirmed_by = 'user' where id = $1`, [
        tradeAManual,
      ]);
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query('delete from retrospeq.trades where id = $1', [tradeAManual]);
        }),
      ).rejects.toThrow(/cannot delete trade .* after freeze/);
    });
  });

  describe('the service role bypasses RLS by design, not a leak', () => {
    it('can read across users', async () => {
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
});

describe.skipIf(!!env)('retrospeq ingestion schema RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
