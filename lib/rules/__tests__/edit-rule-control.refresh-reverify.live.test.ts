import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

/**
 * Independent tester RE-verification (Module 04 Slice 10f, story 2.5) of
 * the coder's fix pass closing the `editRule` optimistic-concurrency gap
 * this tester originally found (see
 * `edit-rule-control.independent-verify.live.test.ts`, FOCUS 1, and
 * PROGRESS.md's "Slice 10f -- INDEPENDENT TESTER VERIFICATION" /
 * "Slice 10f -- CODER FIX PASS" entries).
 *
 * Deliberately does NOT repeat the original FOCUS 1 reproduction (same
 * operand, same values, same fully-sequential timing) -- per this
 * dispatch's own instruction, every scenario below is genuinely new:
 * different operand, different values, a tighter concurrency window (the
 * intervening commit racing WHILE `editRule`'s own call is already in
 * flight, not fully before it starts), a dedicated stress of the new
 * "Refresh with the latest value" recovery path (including whether a
 * refreshed snapshot's version baseline can itself go stale), and a
 * same-session double-submit race against one shared stale snapshot.
 *
 * Same mocking posture as every other file in this tree: only the session
 * layer / rate limiter / `next/cache` are mocked -- `rules-repository.ts`
 * and everything under `editRule`/`fetchRuleForEdit` run for real against
 * the real dev/test Supabase Postgres instance.
 */

const env = readRlsTestEnv();

vi.mock('server-only', () => ({}));

const { getUserMock, createClientMock, enforceRateLimitMock, getClientIpMock, revalidatePathMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.201'),
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

describe.skipIf(!env)('editRule/fetchRuleForEdit -- re-verification of the Slice 10f version-conflict fix, fresh scenarios', () => {
  let db: Client;
  let db2: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = new Client({ connectionString: env.SUPABASE_DB_URL });
    await db.connect();
    db2 = new Client({ connectionString: env.SUPABASE_DB_URL });
    await db2.connect();
    user = await createTestAuthUser(env, 'edit-refresh-reverify');
  });

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)").catch(() => {});
    await db.query('delete from retrospeq.rule_versions where user_id = $1', [user.id]).catch(() => {});
    await db.query('delete from retrospeq.rules where user_id = $1', [user.id]).catch(() => {});
    await db.query('commit').catch(() => db.query('rollback').catch(() => {}));
    await db.end();
    await db2.end();
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

  async function seedGlobalRule(operandId: string, op: string, value: unknown, rendered: string): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
       values ($1, 1, 'global', null, 'soft', 'authored', 'pre_entry', 'active')
       returning id`,
      [user.id],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
      [ruleId, user.id, operandId, op, JSON.stringify(value), rendered],
    );
    return ruleId;
  }

  async function currentRow(ruleId: string): Promise<{ currentVersion: number; value: unknown; rendered: string }> {
    const res = await db.query<{ current_version: number; value: unknown; rendered: string }>(
      `select r.current_version, rv.value, rv.rendered
         from retrospeq.rules r join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
        where r.id = $1`,
      [ruleId],
    );
    return { currentVersion: res.rows[0].current_version, value: res.rows[0].value, rendered: res.rows[0].rendered };
  }

  // ---------------------------------------------------------------------
  // ITEM 1 -- fresh operand/values, TIGHTER concurrency window: the
  // "elsewhere" edit commits WHILE editRule's own call is already
  // in-flight (races against its internal pipeline), not fully before
  // editRule is even invoked (the original FOCUS 1 reproduction's own
  // timing).
  // ---------------------------------------------------------------------
  it('ITEM 1: intervening edit commits WHILE the stale save is already in flight (tighter race than the original reproduction) -- still honestly rejected, no corruption', async () => {
    const { editRule } = await import('@/app/(app)/rules/actions');

    // Different operand than the original reproduction (risk_pct) and
    // different values -- consecutive_losses is tier t0 (no account/tier
    // gating involved at all), so this exercises the version-conflict path
    // in isolation.
    const ruleId = await seedGlobalRule('consecutive_losses', 'lte', 3, 'Stop trading after 3 losses in a row.');

    // Kick off the stale save WITHOUT awaiting it yet -- editRule's own
    // async pipeline (session check, rate limit, fetchCurrentRuleForEdit,
    // the early version-conflict check, tier check, tighten-only,
    // satisfiability, render, applyRuleEdit) yields the event loop at
    // multiple internal `await` points, so the concurrent commit issued
    // immediately below has real opportunity to land in the MIDDLE of that
    // pipeline -- a genuinely tighter race window than committing fully
    // before this call starts.
    const stalePromise = editRule(ruleId, 1, 5);

    // The "elsewhere" edit, on a SEPARATE connection, committed while the
    // above call is genuinely in flight.
    await db2.query('begin');
    await db2.query(
      `update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 1 and superseded_at is null`,
      [ruleId],
    );
    await db2.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 2, $2, 'consecutive_losses', 'lte', '7'::jsonb, 'Stop trading after 7 losses in a row.')`,
      [ruleId, user.id],
    );
    await db2.query(`update retrospeq.rules set current_version = 2 where id = $1`, [ruleId]);
    await db2.query('commit');

    const result = await stalePromise;

    // Whichever check catches it (the early short-circuit, if the
    // intervening commit landed before editRule's own re-read; or
    // applyRuleEdit's own atomic guarded UPDATE, if it landed after) --
    // either way this must be rejected, never a silent success.
    expect(result.success).toBeUndefined();
    expect(result.error?.code).toBe('RULE_EDIT_CONFLICT');
    expect(result.error?.retryable).toBe(true);

    const row = await currentRow(ruleId);
    // The "elsewhere" edit (v2, 7 losses) survives completely untouched --
    // no v3 was ever written with the stale value 5.
    expect(row.currentVersion).toBe(2);
    expect(row.value).toBe(7);
    expect(row.rendered).toBe('Stop trading after 7 losses in a row.');
  }, 30_000);

  // ---------------------------------------------------------------------
  // ITEM 2 -- the "Refresh with the latest value" recovery path, stressed
  // end to end, including the THIRD-edit staleness-of-the-refresh-itself
  // check the dispatch specifically calls out as the most important thing
  // to verify.
  // ---------------------------------------------------------------------
  it('ITEM 2a/2c: Refresh genuinely re-fetches the CURRENT server value (verified directly against Postgres, not a client-side guess), and a save after Refresh + a new edit succeeds and produces the correct final DB state', async () => {
    const { fetchRuleForEdit, editRule } = await import('@/app/(app)/rules/actions');

    const ruleId = await seedGlobalRule('trades_this_week', 'lte', 10, 'Never take more than 10 trades in a week.');

    // Trader opens Edit -- snapshot v1.
    const snapshot = await fetchRuleForEdit(ruleId);
    expect(snapshot.rule?.currentVersion).toBe(1);
    expect(snapshot.rule?.value).toBe(10);

    // A genuinely committed "elsewhere" edit lands: v1 -> v2, value 22.
    await db2.query('begin');
    await db2.query(
      `update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 1 and superseded_at is null`,
      [ruleId],
    );
    await db2.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 2, $2, 'trades_this_week', 'lte', '22'::jsonb, 'Never take more than 22 trades in a week.')`,
      [ruleId, user.id],
    );
    await db2.query(`update retrospeq.rules set current_version = 2 where id = $1`, [ruleId]);
    await db2.query('commit');

    // Stale save (still using v1) -- must be rejected.
    const staleResult = await editRule(ruleId, snapshot.rule!.currentVersion, 15);
    expect(staleResult.error?.code).toBe('RULE_EDIT_CONFLICT');

    // "Refresh with the latest value" is, at the wire level, exactly
    // another `fetchRuleForEdit(ruleId)` call (`EditRuleControl.tsx`'s own
    // `handleRefresh` -> `applyFetchResult` -- confirmed by direct code
    // read, `app/(app)/rules/EditRuleControl.tsx`). Confirm the response it
    // returns matches Postgres DIRECTLY, not merely "something changed":
    const refreshed = await fetchRuleForEdit(ruleId);
    const truth = await currentRow(ruleId);
    expect(refreshed.success).toBe(true);
    expect(refreshed.rule?.currentVersion).toBe(truth.currentVersion);
    expect(refreshed.rule?.currentVersion).toBe(2);
    expect(refreshed.rule?.value).toBe(truth.value);
    expect(refreshed.rule?.value).toBe(22);

    // The refreshed snapshot's version (2) is what genuinely gets used for
    // the next save -- a fresh edit succeeds cleanly.
    const finalResult = await editRule(ruleId, refreshed.rule!.currentVersion, 18);
    expect(finalResult.success).toBe(true);
    expect(finalResult.rule?.version).toBe(3);

    const finalRow = await currentRow(ruleId);
    expect(finalRow.currentVersion).toBe(3);
    expect(finalRow.value).toBe(18);
    expect(finalRow.rendered).toBe('Never take more than 18 trades in a week.');
  }, 30_000);

  it('ITEM 2b (the most important check): a refreshed snapshot does NOT carry forward a stale version -- if a THIRD edit lands after Refresh but before the next Save, that next Save is correctly rejected too, not silently accepted', async () => {
    const { fetchRuleForEdit, editRule } = await import('@/app/(app)/rules/actions');

    const ruleId = await seedGlobalRule('trades_this_week', 'lte', 5, 'Never take more than 5 trades in a week.');

    // Snapshot v1.
    const snapshot = await fetchRuleForEdit(ruleId);
    expect(snapshot.rule?.currentVersion).toBe(1);

    // Elsewhere edit #1: v1 -> v2.
    await db2.query('begin');
    await db2.query(
      `update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 1 and superseded_at is null`,
      [ruleId],
    );
    await db2.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 2, $2, 'trades_this_week', 'lte', '9'::jsonb, 'Never take more than 9 trades in a week.')`,
      [ruleId, user.id],
    );
    await db2.query(`update retrospeq.rules set current_version = 2 where id = $1`, [ruleId]);
    await db2.query('commit');

    // Stale save at v1 is rejected.
    const staleResult = await editRule(ruleId, snapshot.rule!.currentVersion, 6);
    expect(staleResult.error?.code).toBe('RULE_EDIT_CONFLICT');

    // Trader clicks "Refresh with the latest value" -- captures v2 for
    // real. If there were any caching layer or stale-state bug in the
    // refresh wiring, this is where it would show up as the WRONG version
    // being captured.
    const refreshed = await fetchRuleForEdit(ruleId);
    expect(refreshed.rule?.currentVersion).toBe(2);
    expect(refreshed.rule?.value).toBe(9);

    // A THIRD, independent edit now lands -- v2 -> v3 -- AFTER the refresh
    // captured v2, but BEFORE the trader's next Save. If the refresh path
    // somehow reused the ORIGINAL stale v1 baseline (the exact bug being
    // re-verified, one level removed), a save using that wrong baseline
    // could either succeed wrongly against a version that's no longer
    // current, or coincidentally still get rejected for the wrong reason.
    // The correct behavior either way: the refreshed baseline (2) is a
    // REAL, honest snapshot of what was true at refresh time, and a save
    // against it is STILL correctly caught by the exact same conflict
    // mechanism now that v3 exists.
    await db2.query('begin');
    await db2.query(
      `update retrospeq.rule_versions set superseded_at = now() where rule_id = $1 and version = 2 and superseded_at is null`,
      [ruleId],
    );
    await db2.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 3, $2, 'trades_this_week', 'lte', '14'::jsonb, 'Never take more than 14 trades in a week.')`,
      [ruleId, user.id],
    );
    await db2.query(`update retrospeq.rules set current_version = 3 where id = $1`, [ruleId]);
    await db2.query('commit');

    // The trader's next Save, using the REFRESHED (v2) baseline (exactly
    // what EditRuleControl.tsx's `version` state would hold at this point),
    // must be rejected -- the refreshed baseline is genuinely v2, and v2 is
    // genuinely no longer current (v3 is).
    const postRefreshSave = await editRule(ruleId, refreshed.rule!.currentVersion, 7);
    expect(postRefreshSave.success).toBeUndefined();
    expect(postRefreshSave.error?.code).toBe('RULE_EDIT_CONFLICT');

    // No corruption: the THIRD edit (v3, 14) survives untouched -- the
    // trader's v2-based save (7) never landed, and critically, the
    // trader's ORIGINAL v1-based value (6) never landed either (would
    // indicate the refresh reused the old v1 baseline instead of a genuine
    // re-fetch).
    const row = await currentRow(ruleId);
    expect(row.currentVersion).toBe(3);
    expect(row.value).toBe(14);
    expect(row.rendered).toBe('Never take more than 14 trades in a week.');

    // Confirm the refresh baseline is USABLE for a genuinely fresh save --
    // refresh again (now catching v3 for real) and save cleanly, proving
    // the recovery path is not permanently broken by the intervening race,
    // just correctly protective of it.
    const refreshedAgain = await fetchRuleForEdit(ruleId);
    expect(refreshedAgain.rule?.currentVersion).toBe(3);
    expect(refreshedAgain.rule?.value).toBe(14);
    const cleanSave = await editRule(ruleId, refreshedAgain.rule!.currentVersion, 8);
    expect(cleanSave.success).toBe(true);
    const finalRow = await currentRow(ruleId);
    expect(finalRow.currentVersion).toBe(4);
    expect(finalRow.value).toBe(8);
  }, 30_000);

  // ---------------------------------------------------------------------
  // ITEM 3 -- same-session double-submit racing against the SAME original
  // stale snapshot (two tabs / a genuine double-click double-submit), NOT
  // one edit racing against a different intervening edit.
  // ---------------------------------------------------------------------
  it('ITEM 3: two concurrent submissions from the same session, both using the SAME snapshot version -- exactly one succeeds, the other is rejected, no double-write, no crash', async () => {
    const { fetchRuleForEdit, editRule } = await import('@/app/(app)/rules/actions');

    const ruleId = await seedGlobalRule('consecutive_losses', 'lte', 4, 'Stop trading after 4 losses in a row.');

    const snapshot = await fetchRuleForEdit(ruleId);
    expect(snapshot.rule?.currentVersion).toBe(1);

    // Two genuinely concurrent submissions, both racing against the SAME
    // v1 snapshot -- the same-tab double-click / two-tabs-same-snapshot
    // scenario, distinct from ITEM 1's "different intervening editor"
    // scenario. Different target values so a corruption bug (both somehow
    // "succeeding") would be unambiguously detectable.
    const [resultA, resultB] = await Promise.all([
      editRule(ruleId, snapshot.rule!.currentVersion, 2),
      editRule(ruleId, snapshot.rule!.currentVersion, 6),
    ]);

    const successes = [resultA, resultB].filter((r) => r.success === true);
    const conflicts = [resultA, resultB].filter((r) => r.error?.code === 'RULE_EDIT_CONFLICT');

    // Exactly one succeeds, exactly one is rejected -- not both succeeding
    // (which would mean two version-2 rows or a corrupted chain), not both
    // failing (which would mean the guard is over-strict / broken), no
    // exception thrown by either (Promise.all would have rejected here).
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(1);

    const row = await currentRow(ruleId);
    // The DB lands on exactly ONE coherent version-2 state, matching
    // whichever of {2, 6} the successful call actually carried -- proven
    // by cross-referencing which result succeeded, not assumed.
    const winner = successes[0];
    expect(row.currentVersion).toBe(2);
    expect(row.value).toBe(winner.rule?.value);
    expect([2, 6]).toContain(row.value);

    // Sanity: no version 3 was ever created by this race (would indicate
    // both submissions somehow each wrote their own new version instead of
    // exactly one atomic winner).
    const versionCount = await db.query<{ count: string }>(
      `select count(*)::text as count from retrospeq.rule_versions where rule_id = $1`,
      [ruleId],
    );
    expect(versionCount.rows[0].count).toBe('2');
  }, 30_000);
});
