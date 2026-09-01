import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

/**
 * Independent tester verification (Module 04 Slice 10f, story 2.5's
 * edit-a-threshold UI) — NOT written by the coder, a fresh live-DB probe
 * of `app/(app)/rules/actions.ts`'s real `editRule`/`fetchRuleForEdit`
 * Server Actions against a real Postgres connection, per this repo's own
 * "don't trust the coder's own test suite" independent-verification
 * convention.
 *
 * Mocks ONLY the session layer (`@/lib/supabase/server`'s `createClient`)
 * and the rate limiter/`next/cache` — `lib/rules/rules-repository.ts` and
 * every validation module underneath `editRule`/`fetchRuleForEdit` run for
 * REAL, against the real dev/test Supabase Postgres instance, matching
 * `rules-repository.live.test.ts`'s own "live DB, not a mock" posture one
 * layer up (the Server Action layer, not just the repository layer).
 *
 * FOCUS 1 — the version-conflict / "stale open editor" scenario, dispatch
 * item 1. Confirms (or refutes) the coder's own claim that the repository-
 * layer race test is "sufficient" coverage for what the UI surfaces to a
 * trader who has an edit control open while a DIFFERENT process edits the
 * SAME rule.
 *
 * FOCUS 2 — the tier-unavailable guard, dispatch item 2, with a DIFFERENT
 * fixture shape than the coder's own "always zero connected accounts"
 * test: an account that HAD sufficient tier when the rule was created,
 * then genuinely downgrades/disconnects before the edit attempt.
 */

const env = readRlsTestEnv();

vi.mock('server-only', () => ({}));

const { getUserMock, createClientMock, enforceRateLimitMock, getClientIpMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.77'),
  revalidatePathMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: createClientMock,
}));
vi.mock('@/lib/rate-limit/limiter', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));
vi.mock('@/lib/rate-limit/http', () => ({
  getClientIp: getClientIpMock,
}));
vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}));

describe.skipIf(!env)('editRule/fetchRuleForEdit — independent live-DB verification (Slice 10f)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = new Client({ connectionString: env.SUPABASE_DB_URL });
    await db.connect();
    user = await createTestAuthUser(env, 'edit-control-verify');
  });

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)").catch(() => {});
    await db.query('delete from retrospeq.rule_versions where user_id = $1', [user.id]).catch(() => {});
    await db.query('delete from retrospeq.rules where user_id = $1', [user.id]).catch(() => {});
    await db.query('delete from retrospeq.trading_accounts where user_id = $1', [user.id]).catch(() => {});
    await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
    await db.end();
    await deleteTestAuthUser(env, user.id);
  });

  beforeEach(() => {
    getUserMock.mockReset();
    getUserMock.mockResolvedValue({ data: { user: { id: user.id } }, error: null });
    createClientMock.mockReset();
    createClientMock.mockResolvedValue({ auth: { getUser: getUserMock } });
    enforceRateLimitMock.mockClear();
    revalidatePathMock.mockClear();
  });

  async function seedGlobalRule(
    operandId: string,
    op: string,
    value: unknown,
    rendered: string,
    overrides: { severity?: 'soft' | 'hard'; state?: 'active' | 'retired' } = {},
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, $2, 'authored', 'pre_entry', $3)
       returning id`,
      [user.id, overrides.severity ?? 'soft', overrides.state ?? 'active'],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
      [ruleId, user.id, operandId, op, JSON.stringify(value), rendered],
    );
    return ruleId;
  }

  it('FOCUS 1 (RE-VERIFIED POST-FIX, Slice 10f coder pass, 2026-09-01): a trader with a stale open edit control (fetched BEFORE a different process commits a real edit) submits Save with their OWN snapshot version and the stale write is honestly rejected with RULE_EDIT_CONFLICT -- the intervening "elsewhere" edit survives untouched, not silently overwritten', async () => {
    // ORIGINAL FINDING (left in this test's own history/PROGRESS.md for the
    // record): `editRule` used to take no `expectedVersion` parameter at
    // all and re-derived "expected version" from its own fresh internal
    // re-fetch, so this exact scenario silently overwrote the intervening
    // edit with zero signal. Fixed by threading the CALLER's own snapshot
    // version through as a new required `expectedVersion` parameter (see
    // `editRule`'s own header comment in `app/(app)/rules/actions.ts`).
    // This test now asserts the FIXED behavior.
    // Matches this repo's own documented shared-dev-Supabase-project
    // round-trip latency (several sequential awaited round trips per
    // test) -- see rules-repository.live.test.ts's own timeout comments.
    const { fetchRuleForEdit, editRule } = await import('@/app/(app)/rules/actions');

    const ruleId = await seedGlobalRule('risk_pct', 'lte', 1.0, 'Never risk more than 1% per trade.');

    // Trader opens Edit -- this is the exact call EditRuleControl.tsx makes
    // on mount, capturing a SNAPSHOT (version 1, value 1.0).
    const snapshot = await fetchRuleForEdit(ruleId);
    expect(snapshot.success).toBe(true);
    expect(snapshot.rule?.currentVersion).toBe(1);
    expect(snapshot.rule?.value).toBe(1.0);

    // A DIFFERENT process (another tab, another device, whatever) commits
    // a real, independent edit while the trader's control is still open --
    // the exact "elsewhere" scenario the dispatch describes. This is a
    // genuinely later, genuinely committed write: version 1 -> 2, value 3.0.
    await db.query('begin');
    await db.query(
      `update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 1 and superseded_at is null`,
      [ruleId],
    );
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 2, $2, 'risk_pct', 'lte', '3'::jsonb, 'Never risk more than 3% per trade.')`,
      [ruleId, user.id],
    );
    await db.query(`update retrospeq.rules set current_version = 2 where id = $1`, [ruleId]);
    await db.query('commit');

    // The trader, still looking at their STALE 1.0-based control (they never
    // saw the "elsewhere" 3.0 edit at all -- their UI never re-fetched),
    // now clicks Save with their own locally-adjusted value (1.2), passing
    // back the EXACT `currentVersion` (1) their own initial `snapshot`
    // captured -- the real `EditRuleControl.tsx` behavior post-fix.
    const result = await editRule(ruleId, snapshot.rule!.currentVersion, 1.2);

    // THE FIX: the stale expectedVersion (1) no longer matches the rule's
    // true current version (2, from the "elsewhere" edit) -- rejected
    // honestly with RULE_EDIT_CONFLICT, retryable, BEFORE any write.
    expect(result.success).toBeUndefined();
    expect(result.error?.code).toBe('RULE_EDIT_CONFLICT');
    expect(result.error?.retryable).toBe(true);

    const current = await db.query<{ current_version: number; value: unknown; rendered: string }>(
      `select r.current_version, rv.value, rv.rendered
         from retrospeq.rules r join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.id = $1`,
      [ruleId],
    );
    // The "elsewhere" edit (version 2, value 3.0) survives completely
    // untouched -- no version 3 was ever written, the trader's stale 1.2
    // value never reached the database at all. This is the correctness
    // guarantee optimistic concurrency exists to provide: a stale writer
    // never silently clobbers a real intervening commit.
    expect(current.rows[0].current_version).toBe(2);
    expect(current.rows[0].value).toBe(3);
    expect(current.rows[0].rendered).toBe('Never risk more than 3% per trade.');

    // Per-row cleanup deferred to afterAll's own erasure-escape-hatch
    // sweep -- `retrospeq.rules` forbids a bare DELETE outside that
    // context (Module 04 §2.4: "retire only, no pause anywhere"),
    // matching every other live test file in this tree.
  }, 30_000);

  it('FOCUS 2: an account that HAD t1 (when the rule was created) then genuinely disconnects before the edit attempt is honestly rejected as RULE_OPERAND_UNAVAILABLE, not a different fixture than the coder\'s own "always zero accounts" case', async () => {
    const { editRule } = await import('@/app/(app)/rules/actions');

    const accountRes = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier, status)
       values ($1, 'Downgrade-scenario account', 'mt5', 'USD', '00:00:00 UTC', 't1', 'connected')
       returning id`,
      [user.id],
    );
    const accountId = accountRes.rows[0].id;

    // stop_move_count is t1 -- authorable and editable while this account
    // reports t1/connected (mirrors real usage: the rule was created while
    // the trader had a genuinely capable account).
    const ruleId = await seedGlobalRule('stop_move_count', 'lte', 2, 'Never move your stop more than 2 time(s).');

    // Sanity: with the account still connected at t1, an edit succeeds.
    // seedGlobalRule always inserts at version 1, so the caller's own
    // "current" snapshot version at this point is 1.
    const beforeDowngrade = await editRule(ruleId, 1, 3);
    expect(beforeDowngrade.success).toBe(true);

    // The account now genuinely disconnects (a real product event -- an
    // expired token, a broker outage, the trader unlinking it) BEFORE the
    // next edit attempt.
    await db.query(`update retrospeq.trading_accounts set status = 'disconnected' where id = $1`, [accountId]);

    // The successful edit above bumped the rule to version 2 -- this
    // second attempt's own caller-supplied expectedVersion is genuinely
    // current (2), so this exercises the tier guard specifically, not the
    // version-conflict path FOCUS 1 already covers.
    const afterDowngrade = await editRule(ruleId, 2, 4);
    expect(afterDowngrade.success).toBeUndefined();
    expect(afterDowngrade.error?.code).toBe('RULE_OPERAND_UNAVAILABLE');
    expect(afterDowngrade.error?.user_message).toContain('connected accounts');

    // No corruption -- the rule is still at whatever the last SUCCESSFUL
    // edit left it (version 2, value 3), not silently at 4.
    const current = await db.query<{ current_version: number; value: unknown }>(
      `select r.current_version, rv.value from retrospeq.rules r
         join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.id = $1`,
      [ruleId],
    );
    expect(current.rows[0].current_version).toBe(2);
    expect(current.rows[0].value).toBe(3);

    await db.query('delete from retrospeq.trading_accounts where id = $1', [accountId]);
    // Rule cleanup deferred to afterAll -- see FOCUS 1's own comment.
  }, 30_000);
});
