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
 *
 * Every test user created here via `createTestAuthUser` already gets 9
 * permanent `kind = 'derived'` `retrospeq.fields` rows automatically, via
 * `handle_new_user` (`20260902010000_field_registry_schema.sql`,
 * Module 03) — this is exactly the real-world shape (every real user has
 * them) that exposed a genuine critical regression: `executeErasure`
 * never explicitly deleted `fields`, so GoTrue's own final
 * `auth.admin.deleteUser` cascade hit `fields_forbid_derived_delete` on a
 * connection where `retrospeq.erasure_in_progress` was never set, and the
 * whole erasure failed for every single user. See
 * `lib/fields/fields-repository.ts`'s `deleteAllFieldsForUser` and
 * docs/adr/0010's 2026-09-02 addendum for the full account. Because every
 * test user here already carries the 9 derived rows, the existing "full
 * lifecycle" test below is extended with explicit field-count assertions
 * rather than relying on it having caught the bug by accident.
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

      // The 9 derived `fields` rows every real user gets at signup
      // (`handle_new_user` -> `seed_derived_fields_for_user`, Module 03)
      // — asserted explicitly here, before erasure, so the "9 -> 0" claim
      // below is proven against a real, counted starting state, not
      // assumed.
      const fieldsBefore = await db.query(
        "select id from retrospeq.fields where user_id = $1 and kind = 'derived'",
        [user.id],
      );
      expect(fieldsBefore.rows).toHaveLength(9);

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

      // The regression this test file now closes: all 9 derived `fields`
      // rows genuinely gone, not merely "not blocking the delete" —
      // `deleteAllFieldsForUser` ran explicitly inside `executeErasure`
      // itself, not left to (and previously silently failed by) GoTrue's
      // own cascade.
      const fieldsAfter = await db.query('select 1 from retrospeq.fields where user_id = $1', [
        user.id,
      ]);
      expect(fieldsAfter.rows).toHaveLength(0);

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

  it(
    'concurrent double-execution: exactly one caller wins the atomic pending->processing race, the other aborts cleanly before any destructive work — regression test for a retrospeq-security-reviewer FAIL (2026-08-21)',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure, ErasureAlreadyProcessedError } = await import(
        '../erasure'
      );

      const user = await createTestAuthUser(env, 'erasure-live-race');
      const request = await requestErasure(user.id);

      // Two genuinely concurrent calls for the SAME request id — this is
      // exactly the scenario a non-atomic check-then-act transition would
      // let both callers pass through, each eventually calling
      // `auth.admin.deleteUser` on a user the other one already erased.
      // `markDataRequestProcessing`'s atomic `UPDATE ... WHERE status =
      // 'pending'` (lib/privacy/data-requests-repository.ts) must ensure
      // only one of these two promises ever proceeds past that point.
      const results = await Promise.allSettled([
        executeErasure(request.id, { bypassGracePeriod: true }),
        executeErasure(request.id, { bypassGracePeriod: true }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The loser must fail with the clean, expected "already processed"
      // error — never an unhandled `auth.admin.deleteUser` failure (the
      // false-incident failure mode the race previously produced), and
      // never a database constraint violation from a double-delete.
      const loserReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(loserReason).toBeInstanceOf(ErasureAlreadyProcessedError);

      // The winner genuinely completed the full erasure — not a partial
      // or corrupted state.
      const { data, error } = await (
        await import('@/lib/supabase/service')
      ).createServiceRoleClient().auth.admin.getUserById(user.id);
      expect(data.user).toBeNull();
      expect(error).not.toBeNull();

      await db
        .query(
          "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
          [user.id],
        )
        .catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    30_000,
  );

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

  it(
    'succeeds for a user with a real broker-confirmed trade — regression test for the ' +
      'retrospeq.erasure_in_progress escape-hatch fix (PROGRESS.md "Infra gaps", Module 02 Slice 3)',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure } = await import('../erasure');

      const user = await createTestAuthUser(env, 'erasure-live-confirmed-trade');

      // Seed a REAL, broker-confirmed trade — a block, a non-manual fill,
      // and a trade with `confirmed_at` set, exactly the shape
      // `retrospeq.forbid_broker_confirmed_trade_delete` (docs/adr/0011)
      // refuses to let ANY caller delete directly, via the same
      // direct-SQL seeding pattern `lib/supabase/__tests__/ingestion-schema.rls.test.ts`
      // already established. Before this test's own fix
      // (`lib/broker/accounts-repository.ts`'s `deleteAllTradingAccountsForUser`
      // now sets `retrospeq.erasure_in_progress` before deleting
      // `trading_accounts`), this exact seed would make the
      // `delete from trading_accounts` below fail when Postgres's
      // cascade reaches this trade row, raising "cannot delete a
      // broker-confirmed trade" — which would have surfaced as
      // `executeErasure` throwing an unhandled database error instead of
      // completing.
      const accountRes = await db.query(
        `insert into retrospeq.trading_accounts
           (user_id, label, platform, base_currency, day_rollover)
         values ($1, 'Erasure Confirmed-Trade Test Account', 'mt5', 'USD', '00:00:00 UTC')
         returning id`,
        [user.id],
      );
      const accountId = accountRes.rows[0].id;

      const blockRes = await db.query(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', now() - interval '2 hours', now() - interval '1 hour', current_date)
         returning id`,
        [user.id, accountId],
      );
      const blockId = blockRes.rows[0].id;

      const fillRes = await db.query(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
         values ($1, $2, 'erasure-confirmed-trade-fill-1', 'EURUSD', 'buy', 100000, 1.1, now() - interval '2 hours', current_date, 'USD')
         returning id`,
        [user.id, accountId],
      );
      const fillId = fillRes.rows[0].id;

      const tradeRes = await db.query(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            currency, grouping_confidence, confirmed_at, confirmed_by)
         values ($1, $2, $3, 'EURUSD', 'long', now() - interval '2 hours', now() - interval '1 hour',
                 current_date, 'confirmed', 'USD', 'confident_single', now(), 'user')
         returning id`,
        [user.id, accountId, blockId],
      );
      const tradeId = tradeRes.rows[0].id;

      await db.query(
        `insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`,
        [tradeId, fillId, user.id],
      );

      // Sanity check on the seed itself: confirm the trigger really does
      // block a direct delete attempt outside the erasure escape hatch,
      // so this test is proving the fix against a genuinely reproducing
      // hazard, not a scenario that was never actually blocked.
      await expect(
        db.query('delete from retrospeq.trades where id = $1', [tradeId]),
      ).rejects.toThrow(/cannot delete a broker-confirmed trade/);

      const request = await requestErasure(user.id);
      await executeErasure(request.id, { bypassGracePeriod: true });

      const tradesAfter = await db.query('select 1 from retrospeq.trades where id = $1', [tradeId]);
      expect(tradesAfter.rows).toHaveLength(0);
      const accountsAfter = await db.query(
        'select 1 from retrospeq.trading_accounts where id = $1',
        [accountId],
      );
      expect(accountsAfter.rows).toHaveLength(0);
      const profileAfter = await db.query('select 1 from retrospeq.profiles where id = $1', [user.id]);
      expect(profileAfter.rows).toHaveLength(0);

      await db
        .query(
          "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
          [user.id],
        )
        .catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    30_000,
  );

  it(
    'succeeds for a real user with derived fields rows, and auth.admin.deleteUser genuinely ' +
      'succeeds — regression test for the retrospeq.erasure_in_progress escape-hatch gap in ' +
      'deleteAllFieldsForUser (docs/adr/0010 2026-09-02 addendum, Module 03)',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure } = await import('../erasure');

      const user = await createTestAuthUser(env, 'erasure-live-derived-fields');

      // Every real user gets these 9 rows automatically at signup
      // (`handle_new_user` -> `seed_derived_fields_for_user`) — asserted
      // explicitly here rather than assumed, so this test proves the fix
      // against a genuinely reproducing hazard, matching the confirmed-
      // trade test's own precedent immediately above.
      const derivedBefore = await db.query(
        "select id from retrospeq.fields where user_id = $1 and kind = 'derived' order by id",
        [user.id],
      );
      expect(derivedBefore.rows).toHaveLength(9);
      expect(derivedBefore.rows.map((r) => r.id)).toContain('drv.risk_pct');

      // Sanity check on the seed itself: confirm `fields_forbid_derived_delete`
      // really does block a direct delete attempt outside the erasure
      // escape hatch, exactly mirroring the confirmed-trade test's own
      // "prove the hazard is real" sanity check.
      await expect(
        db.query('delete from retrospeq.fields where user_id = $1 and id = $2', [
          user.id,
          'drv.risk_pct',
        ]),
      ).rejects.toThrow(/can never be deleted outside of account erasure/);

      const request = await requestErasure(user.id);
      await executeErasure(request.id, { bypassGracePeriod: true });

      // The regression itself, made explicit and permanent: before the
      // fix, this next assertion never even ran — `executeErasure` threw
      // inside `auth.admin.deleteUser`, because GoTrue's own cascade hit
      // the same trigger the direct-delete sanity check above just
      // proved is real, on a connection where the escape hatch was never
      // set. `executeErasure` now completes without throwing at all.
      const fieldsAfter = await db.query('select 1 from retrospeq.fields where user_id = $1', [
        user.id,
      ]);
      expect(fieldsAfter.rows).toHaveLength(0);

      // auth.admin.deleteUser genuinely succeeded — the exact call that
      // used to fail. Confirmed via the GoTrue admin API itself, not just
      // a local table check.
      const { createServiceRoleClient } = await import('@/lib/supabase/service');
      const supabase = createServiceRoleClient();
      const { data, error } = await supabase.auth.admin.getUserById(user.id);
      expect(data.user).toBeNull();
      expect(error).not.toBeNull();

      await db
        .query(
          "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
          [user.id],
        )
        .catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    30_000,
  );

  it(
    'succeeds for a real user with an authored rule AND a real, genuinely-frozen rule_evaluations ' +
      'row, and auth.admin.deleteUser genuinely succeeds — regression test for the ' +
      'retrospeq.erasure_in_progress escape-hatch gap in `rules`/`rule_evaluations` (docs/adr/0010 ' +
      '2026-09-02 addendum, Module 04 — the exact scenario flagged-but-not-fixed alongside the ' +
      'deleteAllFieldsForUser fix above, closed here by the new deleteAllRulesForUser)',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure } = await import('../erasure');

      const user = await createTestAuthUser(env, 'erasure-live-rules');

      // Seed a real trading account + a real, broker-shaped confirmed
      // trade — mirrors the confirmed-trade regression test's own seed
      // shape immediately above, since a `rule_evaluations` row needs a
      // real `trades.id` to reference (`trade_id` is NOT NULL).
      const accountRes = await db.query(
        `insert into retrospeq.trading_accounts
           (user_id, label, platform, base_currency, day_rollover)
         values ($1, 'Erasure Rules Test Account', 'mt5', 'USD', '00:00:00 UTC')
         returning id`,
        [user.id],
      );
      const accountId = accountRes.rows[0].id;

      const blockRes = await db.query(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', now() - interval '2 hours', now() - interval '1 hour', current_date)
         returning id`,
        [user.id, accountId],
      );
      const blockId = blockRes.rows[0].id;

      const tradeRes = await db.query(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            currency, grouping_confidence, confirmed_at, confirmed_by)
         values ($1, $2, $3, 'EURUSD', 'long', now() - interval '2 hours', now() - interval '1 hour',
                 current_date, 'confirmed', 'USD', 'confident_single', now(), 'user')
         returning id`,
        [user.id, accountId, blockId],
      );
      const tradeId = tradeRes.rows[0].id;

      // A real authored rule (`rules` + its `rule_versions` current
      // version 1), then a real, frozen `rule_evaluations` row against the
      // confirmed trade above — direct SQL, matching
      // `rule-overrides-repository.live.test.ts`'s own established seeding
      // pattern for this exact shape (that file's own `afterEach` cleanup
      // already had to work around this precise gap by explicitly
      // deleting `rule_evaluations`/`rules` under the escape hatch itself,
      // because `executeErasure` never did — this test proves the
      // PRODUCTION path now does the same thing, not just test cleanup).
      const ruleRes = await db.query<{ id: string }>(
        `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state)
         values ($1, 1, 'global', 'soft', 'authored', 'at_close', 'active')
         returning id`,
        [user.id],
      );
      const ruleId = ruleRes.rows[0].id;
      await db.query(
        `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
         values ($1, 1, $2, 'total_open_risk', 'lte', '1'::jsonb, 'Erasure regression test rule')`,
        [ruleId, user.id],
      );
      await db.query(
        `insert into retrospeq.rule_evaluations
           (user_id, trade_id, rule_id, rule_version, severity, result, observed, server_day)
         values ($1, $2, $3, 1, 'soft', 'broken', '{"total_open_risk": 1.5}'::jsonb, current_date)`,
        [user.id, tradeId, ruleId],
      );

      // Sanity check on the seed itself, matching the confirmed-trade and
      // derived-fields regression tests' own precedent: confirm both
      // triggers genuinely block a direct delete attempt outside the
      // erasure escape hatch, so this test is proving the fix against a
      // real, reproducing hazard — not a scenario that was never actually
      // blocked.
      await expect(
        db.query('delete from retrospeq.rule_evaluations where rule_id = $1', [ruleId]),
      ).rejects.toThrow(/cannot delete a frozen evaluation/);
      await expect(db.query('delete from retrospeq.rules where id = $1', [ruleId])).rejects.toThrow(
        /rules: cannot delete a rule/,
      );

      const request = await requestErasure(user.id);
      await executeErasure(request.id, { bypassGracePeriod: true });

      // The regression itself, made explicit and permanent: before the
      // fix, this next assertion never even ran — `executeErasure` threw
      // inside `auth.admin.deleteUser`, because GoTrue's own final cascade
      // (`auth.users -> profiles -> rules`) hit `rules_forbid_delete` on a
      // connection where the escape hatch was never set (the earlier
      // `deleteAllTradingAccountsForUser`/`trades` cascade never reaches
      // `rules` at all — `rules` has no FK to `trading_accounts`/`trades`).
      // `executeErasure` now completes without throwing at all, and both
      // rows are genuinely gone, not merely "not blocking the delete."
      const evaluationsAfter = await db.query(
        'select 1 from retrospeq.rule_evaluations where user_id = $1',
        [user.id],
      );
      expect(evaluationsAfter.rows).toHaveLength(0);

      const rulesAfter = await db.query('select 1 from retrospeq.rules where user_id = $1', [
        user.id,
      ]);
      expect(rulesAfter.rows).toHaveLength(0);

      // auth.admin.deleteUser genuinely succeeded — the exact call that
      // used to fail for every user who had ever authored a rule.
      // Confirmed via the GoTrue admin API itself, not just a local table
      // check.
      const { createServiceRoleClient } = await import('@/lib/supabase/service');
      const supabase = createServiceRoleClient();
      const { data, error } = await supabase.auth.admin.getUserById(user.id);
      expect(data.user).toBeNull();
      expect(error).not.toBeNull();

      await db
        .query(
          "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
          [user.id],
        )
        .catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    30_000,
  );

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
