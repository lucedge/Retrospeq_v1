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

/**
 * Module 05 §4.11 — decay checking, live-DB adversarial proof. Fresh
 * fixtures for this dispatch, not reused from the coder's own tests.
 * Seeding pattern mirrors `edge-engine/repository.live.test.ts`, but
 * `findings` rows are inserted DIRECTLY (not via a real edge-engine
 * recompute) so each test can control `n`/`delta_win_rate` precisely —
 * decay checking's own contract only cares about the CURRENT active
 * row's stats for a fixed tuple, not how they got there.
 *
 * Adversarial targets this file is built to hit (per this dispatch's own
 * brief, latest revision):
 *
 *   - the 30-trade throttle is a genuine TRADE-COUNT gate, not time-based
 *   - the stale-finding trap: decay checking must follow a graduated
 *     link to the CURRENT active row for its tuple, not the original
 *     (possibly long-superseded) finding_id
 *   - per-link error containment: a throwing link must not abort the
 *     rest of the batch, must not inflate linksChecked/decaySignalsEmitted,
 *     and must log loudly with the offending ids
 *   - frozen data: the decay-check write only ever touches the CURRENT
 *     `active` finding, guarded by `state = 'active'`, never a
 *     superseded/frozen row
 *   - cross-user isolation at the application-scoping layer (this whole
 *     module runs under a service-role connection that bypasses RLS)
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/analytics/decay-engine/repository.ts (live DB)', () => {
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
      await db.query('delete from retrospeq.finding_rule_links where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  let seq = 0;
  function fieldIdFor(): string {
    seq += 1;
    return `decay_test_field_${seq}`;
  }

  /** Minimal strategy + bool field, satisfying `findings`' composite FKs
   *  (`strategy_id`/`field_id` both reference `(user_id, id)`). No real
   *  trades are seeded -- this file writes `findings` rows directly. */
  async function seedStrategyAndField(userId: string): Promise<{ strategyId: string; fieldId: string }> {
    const fieldId = fieldIdFor();
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Decay Live Test Strategy', 1, false, 'active')
       returning id`,
      [userId],
    );
    const strategyId = strategyRes.rows[0].id;

    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Decay Test Flag', 'strategy_var', 'bool', 'captured', $3, '{}'::jsonb)`,
      [fieldId, userId, strategyId],
    );

    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Decay Live Test Strategy', $3::jsonb, '[]'::jsonb)`,
      [strategyId, userId, JSON.stringify([{ field_id: fieldId, capture_moment: 'pre_entry', order: 1 }])],
    );

    return { strategyId, fieldId };
  }

  const SEGMENT = { op: 'eq', value: true };

  async function insertFinding(
    userId: string,
    strategyId: string,
    fieldId: string,
    n: number,
    deltaWinRate: number | null,
    state: 'active' | 'superseded' | 'decayed' = 'active',
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.findings
         (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
          baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
          p_value, p_adjusted, confidence, gate_failures, state)
       values ($1,'find.toggle',$2,$3,$4::jsonb,$5,0.6,0.4,$5,0.4,0.1,$6,0.3,0.001,0.001,'confident','{}',$7)
       returning id`,
      [userId, strategyId, fieldId, JSON.stringify(SEGMENT), n, deltaWinRate === null ? null : deltaWinRate.toFixed(4), state],
    );
    return res.rows[0].id;
  }

  async function getLink(userId: string, findingId: string, ruleId: string) {
    const res = await db.query(
      `select * from retrospeq.finding_rule_links where user_id = $1 and finding_id = $2 and rule_id = $3`,
      [userId, findingId, ruleId],
    );
    return res.rows[0] as
      | {
          last_checked_at: string | null;
          last_delta: string | null;
          trades_at_last_check: number | null;
          consecutive_decay_checks: number;
        }
      | undefined;
  }

  it(
    'the 30-trade throttle is a TRADE-COUNT gate: fewer than 30 new trades in the segment is a silent no-op regardless of how much time has "passed" (no time input exists at all)',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'decay-throttle');
      cleanupUserIds.push(userId);
      const { strategyId, fieldId } = await seedStrategyAndField(userId);
      const { createFindingRuleLink, runDecayChecksForUser } = await import('../repository');

      const findingId = await insertFinding(userId, strategyId, fieldId, 70, 0.2);
      const ruleId = '00000000-0000-0000-0000-0000000000a1';
      await createFindingRuleLink(userId, findingId, ruleId, 0.2, 70);

      // Only 20 new trades since graduation (n=90 vs trades_at_graduation=70) -- below 30.
      await db.query(`update retrospeq.findings set n = 90, delta_win_rate = 0.02 where id = $1`, [findingId]);
      const result1 = await runDecayChecksForUser(userId);
      expect(result1.linksChecked).toBe(0);
      expect(result1.linksSkippedDueToError).toBe(0);
      const linkAfter1 = await getLink(userId, findingId, ruleId);
      expect(linkAfter1!.last_checked_at).toBeNull();
      expect(linkAfter1!.consecutive_decay_checks).toBe(0);

      // Exactly 30 new trades -- now due.
      await db.query(`update retrospeq.findings set n = 100, delta_win_rate = 0.02 where id = $1`, [findingId]);
      const result2 = await runDecayChecksForUser(userId);
      expect(result2.linksChecked).toBe(1);
      const linkAfter2 = await getLink(userId, findingId, ruleId);
      expect(linkAfter2!.trades_at_last_check).toBe(100);
      expect(linkAfter2!.consecutive_decay_checks).toBe(1);

      // Calling again immediately with NO new trades (n unchanged) must
      // NOT re-fire -- proves the gate is trade count, not "has some
      // wall-clock interval elapsed since last_checked_at."
      const result3 = await runDecayChecksForUser(userId);
      expect(result3.linksChecked).toBe(0);
      const linkAfter3 = await getLink(userId, findingId, ruleId);
      expect(linkAfter3!.consecutive_decay_checks).toBe(1); // unchanged
    },
    60_000,
  );

  it(
    'two consecutive below-half checks emit the decay signal and transition the finding to state=decayed; a recovery in between resets the streak to zero (end-to-end DB proof)',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'decay-streak');
      cleanupUserIds.push(userId);
      const { strategyId, fieldId } = await seedStrategyAndField(userId);
      const { createFindingRuleLink, runDecayChecksForUser } = await import('../repository');

      const findingId = await insertFinding(userId, strategyId, fieldId, 70, 0.2);
      const ruleId = '00000000-0000-0000-0000-0000000000a2';
      await createFindingRuleLink(userId, findingId, ruleId, 0.2, 70);

      // Check 1: decaying (delta 0.02 < 0.1 half-threshold).
      await db.query(`update retrospeq.findings set n = 100, delta_win_rate = 0.02 where id = $1`, [findingId]);
      await runDecayChecksForUser(userId);
      expect((await getLink(userId, findingId, ruleId))!.consecutive_decay_checks).toBe(1);

      // Check 2: recovers (delta back above half) -- must reset to 0, not
      // hold at 1 or emit a signal.
      await db.query(`update retrospeq.findings set n = 130, delta_win_rate = 0.2 where id = $1`, [findingId]);
      const recoveryResult = await runDecayChecksForUser(userId);
      expect(recoveryResult.decaySignalsEmitted).toBe(0);
      expect((await getLink(userId, findingId, ruleId))!.consecutive_decay_checks).toBe(0);
      expect((await db.query(`select state from retrospeq.findings where id = $1`, [findingId])).rows[0].state).toBe('active');

      // Check 3 + 4: two genuinely consecutive decaying checks.
      await db.query(`update retrospeq.findings set n = 160, delta_win_rate = 0.01 where id = $1`, [findingId]);
      await runDecayChecksForUser(userId);
      expect((await getLink(userId, findingId, ruleId))!.consecutive_decay_checks).toBe(1);

      await db.query(`update retrospeq.findings set n = 190, delta_win_rate = 0.01 where id = $1`, [findingId]);
      const finalResult = await runDecayChecksForUser(userId);
      expect(finalResult.decaySignalsEmitted).toBe(1);
      expect((await getLink(userId, findingId, ruleId))!.consecutive_decay_checks).toBe(2);

      const findingRow = await db.query(`select state from retrospeq.findings where id = $1`, [findingId]);
      expect(findingRow.rows[0].state).toBe('decayed');
    },
    60_000,
  );

  it(
    'the STALE-FINDING TRAP: after the linked finding is superseded by a fresh edge-engine recompute, decay checking follows the CURRENT active row for the same tuple, never the original (now-superseded) finding_id',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'decay-stale');
      cleanupUserIds.push(userId);
      const { strategyId, fieldId } = await seedStrategyAndField(userId);
      const { createFindingRuleLink, runDecayChecksForUser } = await import('../repository');

      // v1: the finding graduation actually linked, at n=70, delta=0.2.
      const findingV1 = await insertFinding(userId, strategyId, fieldId, 70, 0.2, 'active');
      const ruleId = '00000000-0000-0000-0000-0000000000a3';
      await createFindingRuleLink(userId, findingV1, ruleId, 0.2, 70);

      // Simulate a real edge-engine recompute superseding v1 with v2 for
      // the EXACT SAME tuple (strategy_id, field_id, segment) -- the
      // supersession shape `writeFindingsForStrategy` itself uses.
      await db.query(`update retrospeq.findings set state = 'superseded' where id = $1`, [findingV1]);
      const findingV2 = await insertFinding(userId, strategyId, fieldId, 100, 0.02, 'active');
      await db.query(`update retrospeq.findings set superseded_by = $1 where id = $2`, [findingV2, findingV1]);

      const result = await runDecayChecksForUser(userId);
      expect(result.linksChecked).toBe(1);

      // The link's own last_delta must be v2's delta (0.02), not v1's
      // (0.2) -- proves it read the CURRENT active row, not the stale
      // originally-linked one.
      const link = await getLink(userId, findingV1, ruleId);
      expect(Number(link!.last_delta)).toBeCloseTo(0.02, 3);
      expect(link!.trades_at_last_check).toBe(100); // v2's own n, not v1's

      // v1 (frozen, superseded) must remain untouched -- never rewritten,
      // never re-marked active or decayed by this check.
      const v1Row = await db.query(`select state, delta_win_rate, n from retrospeq.findings where id = $1`, [findingV1]);
      expect(v1Row.rows[0].state).toBe('superseded');
      expect(Number(v1Row.rows[0].delta_win_rate)).toBeCloseTo(0.2, 3);
      expect(v1Row.rows[0].n).toBe(70);

      // Push it to a decay signal and confirm v2 (the CURRENT active row)
      // is the one that transitions to 'decayed', not v1.
      await db.query(`update retrospeq.findings set n = 130, delta_win_rate = 0.01 where id = $1`, [findingV2]);
      const secondResult = await runDecayChecksForUser(userId);
      expect(secondResult.decaySignalsEmitted).toBe(1);

      const v1After = await db.query(`select state from retrospeq.findings where id = $1`, [findingV1]);
      const v2After = await db.query(`select state from retrospeq.findings where id = $1`, [findingV2]);
      expect(v1After.rows[0].state).toBe('superseded'); // still untouched
      expect(v2After.rows[0].state).toBe('decayed');
    },
    60_000,
  );

  it(
    'PER-LINK ERROR CONTAINMENT: a link whose deltaAtGraduation is corrupt (<= 0) throws internally but does NOT abort the batch -- every other due link for the same user is still checked and written, the corrupt link is counted in linksSkippedDueToError (not linksChecked), and the failure is logged loudly with the offending ids',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'decay-containment');
      cleanupUserIds.push(userId);
      const { createFindingRuleLink, runDecayChecksForUser } = await import('../repository');

      // Three independent tuples (separate strategy+field each, so each
      // link's own findings row is genuinely distinct) -- one corrupt,
      // two good, so this test proves the containment property
      // regardless of which order fetchFindingRuleLinksForUser happens to
      // return them in (that query has no ORDER BY).
      const good1 = await seedStrategyAndField(userId);
      const bad = await seedStrategyAndField(userId);
      const good2 = await seedStrategyAndField(userId);

      const good1FindingId = await insertFinding(userId, good1.strategyId, good1.fieldId, 100, 0.02);
      const badFindingId = await insertFinding(userId, bad.strategyId, bad.fieldId, 100, 0.02);
      const good2FindingId = await insertFinding(userId, good2.strategyId, good2.fieldId, 100, 0.02);

      const good1RuleId = '00000000-0000-0000-0000-0000000000b1';
      const badRuleId = '00000000-0000-0000-0000-0000000000b2';
      const good2RuleId = '00000000-0000-0000-0000-0000000000b3';

      await createFindingRuleLink(userId, good1FindingId, good1RuleId, 0.2, 70);
      await createFindingRuleLink(userId, good2FindingId, good2RuleId, 0.2, 70);
      // The corrupt link: deltaAtGraduation = 0, which evaluateDecayCheck
      // itself throws on. Written directly via raw SQL since
      // createFindingRuleLink would happily insert it too (no DB-level
      // CHECK constraint enforces positivity -- see the migration's own
      // header) -- either path produces the same corrupt row.
      await db.query(
        `insert into retrospeq.finding_rule_links (finding_id, rule_id, user_id, delta_at_graduation, trades_at_graduation)
         values ($1, $2, $3, 0, 70)`,
        [badFindingId, badRuleId, userId],
      );

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let result;
      try {
        result = await runDecayChecksForUser(userId);
      } finally {
        // proven not to throw regardless -- see assertion below too
      }

      // The call itself must not reject/throw.
      expect(result).toBeDefined();
      expect(result!.linksSkippedDueToError).toBe(1);
      // Both good links were genuinely checked and written -- proves the
      // batch was NOT aborted partway.
      expect(result!.linksChecked).toBe(2);

      const good1Link = await getLink(userId, good1FindingId, good1RuleId);
      const good2Link = await getLink(userId, good2FindingId, good2RuleId);
      expect(good1Link!.last_checked_at).not.toBeNull();
      expect(good1Link!.trades_at_last_check).toBe(100);
      expect(good2Link!.last_checked_at).not.toBeNull();
      expect(good2Link!.trades_at_last_check).toBe(100);

      // The corrupt link's own row must be left EXACTLY as it was before
      // the attempt -- no partial write.
      const badLink = await getLink(userId, badFindingId, badRuleId);
      expect(badLink!.last_checked_at).toBeNull();
      expect(badLink!.trades_at_last_check).toBeNull();
      expect(badLink!.consecutive_decay_checks).toBe(0);

      // The failure was logged loudly, naming the offending ids -- not
      // swallowed silently.
      expect(errorSpy).toHaveBeenCalled();
      const loggedCall = errorSpy.mock.calls.find((call) => String(call[0]).includes(badFindingId) && String(call[0]).includes(badRuleId));
      expect(loggedCall).toBeDefined();
      expect(String(loggedCall![0])).toContain(userId);
      expect(String(loggedCall![0])).toContain('[decay-engine]');

      errorSpy.mockRestore();

      // A SECOND call must reproduce the exact same failure for the SAME
      // corrupt link (it's never marked "checked", so it stays due
      // forever until the underlying row is fixed) -- proves the
      // recurring nature of this failure mode is real, not a one-off,
      // while ALSO proving it never blocks the two good links a second
      // time either.
      const errorSpy2 = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result2 = await runDecayChecksForUser(userId);
      expect(result2.linksSkippedDueToError).toBe(1);
      // Good links are no longer "due" (0 new trades since last check),
      // so linksChecked is correctly 0 on this second call -- not
      // evidence of a regression, just the throttle doing its job.
      expect(result2.linksChecked).toBe(0);
      expect(errorSpy2).toHaveBeenCalled();
      errorSpy2.mockRestore();
    },
    60_000,
  );

  it('"not enough data yet" (zero finding_rule_links rows at all) is a correct, silent, non-throwing no-op — the real steady state today', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'decay-empty');
    cleanupUserIds.push(userId);
    const { runDecayChecksForUser } = await import('../repository');
    const result = await runDecayChecksForUser(userId);
    expect(result).toEqual({ linksChecked: 0, decaySignalsEmitted: 0, linksSkippedDueToError: 0 });
  });

  it('a link whose current active finding has a NULL delta_win_rate (no win-rate computable) is a silent no-op, not an error', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'decay-nulldelta');
    cleanupUserIds.push(userId);
    const { strategyId, fieldId } = await seedStrategyAndField(userId);
    const { createFindingRuleLink, runDecayChecksForUser } = await import('../repository');

    const findingId = await insertFinding(userId, strategyId, fieldId, 100, null);
    const ruleId = '00000000-0000-0000-0000-0000000000c1';
    await createFindingRuleLink(userId, findingId, ruleId, 0.2, 70);

    const result = await runDecayChecksForUser(userId);
    expect(result.linksChecked).toBe(0);
    expect(result.linksSkippedDueToError).toBe(0);
  });

  it('a link whose tuple has NO current active row at all (segment simply was not recomputed as active in the latest run) is a silent no-op, not an error', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'decay-noactive');
    cleanupUserIds.push(userId);
    const { strategyId, fieldId } = await seedStrategyAndField(userId);
    const { createFindingRuleLink, runDecayChecksForUser } = await import('../repository');

    const findingId = await insertFinding(userId, strategyId, fieldId, 100, 0.02, 'superseded');
    const ruleId = '00000000-0000-0000-0000-0000000000e1';
    await createFindingRuleLink(userId, findingId, ruleId, 0.2, 70);
    // No `active` row exists for this exact tuple at all -- the original
    // linked row is itself the only one, and it's `superseded`.

    const result = await runDecayChecksForUser(userId);
    expect(result.linksChecked).toBe(0);
    expect(result.linksSkippedDueToError).toBe(0);
    const link = await getLink(userId, findingId, ruleId);
    expect(link!.last_checked_at).toBeNull();
  });

  it('a link whose ORIGINAL finding had its strategy hard-deleted since graduation (composite FK nulls strategy_id) is skipped, not an error -- the tuple can no longer be recovered', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'decay-harddeleted');
    cleanupUserIds.push(userId);
    const { strategyId, fieldId } = await seedStrategyAndField(userId);
    const { createFindingRuleLink, runDecayChecksForUser } = await import('../repository');

    const findingId = await insertFinding(userId, strategyId, fieldId, 100, 0.02, 'active');
    const ruleId = '00000000-0000-0000-0000-0000000000e2';
    await createFindingRuleLink(userId, findingId, ruleId, 0.2, 70);

    // Hard-delete the strategy -- the composite FK (`on delete set
    // null (strategy_id)`) nulls findings.strategy_id, never cascades the
    // finding itself away.
    await db.query('delete from retrospeq.strategies where id = $1', [strategyId]);
    const findingAfterDelete = await db.query('select strategy_id from retrospeq.findings where id = $1', [findingId]);
    expect(findingAfterDelete.rows[0].strategy_id).toBeNull();

    const result = await runDecayChecksForUser(userId);
    expect(result.linksChecked).toBe(0);
    expect(result.linksSkippedDueToError).toBe(0);
    const link = await getLink(userId, findingId, ruleId);
    expect(link!.last_checked_at).toBeNull();
  });

  it(
    'ISOLATION: this module never touches rule_evaluations, rules, rule_versions, or adherence_weekly — static source check (§7.5)',
    async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const repoSource = await fs.readFile(path.resolve(process.cwd(), 'lib/analytics/decay-engine/repository.ts'), 'utf8');
      const engineSource = await fs.readFile(path.resolve(process.cwd(), 'lib/analytics/decay-engine/decay-engine.ts'), 'utf8');
      for (const forbidden of ['rule_evaluations', 'adherence_weekly', "from retrospeq.rules", 'rule_versions']) {
        expect(repoSource).not.toContain(forbidden);
        expect(engineSource).not.toContain(forbidden);
      }
      expect(repoSource).not.toMatch(/from ['"]@\/lib\/rules/);
      expect(engineSource).not.toMatch(/from ['"]@\/lib\/rules/);
    },
  );

  it(
    'CROSS-USER ISOLATION: user A decay checking never reads, updates, or emits a signal against user B links or findings, even when both users have an identically-shaped tuple (same field id, same segment)',
    async () => {
      if (!env) return;
      const { id: userIdA } = await createTestAuthUser(envBundle, 'decay-isoA');
      const { id: userIdB } = await createTestAuthUser(envBundle, 'decay-isoB');
      cleanupUserIds.push(userIdA, userIdB);
      const { createFindingRuleLink, runDecayChecksForUser } = await import('../repository');

      // Both users get their OWN strategy but reuse the SAME bool field id
      // string across users (field ids are user-scoped by the fields
      // table's own (user_id, id) shape, so this is a legitimate
      // same-shaped-tuple collision to test against, not an artificial
      // setup).
      seq -= 1; // force the SAME generated field id string for both users
      const sharedFieldId = fieldIdFor();
      seq -= 1;
      const sameFieldIdAgain = fieldIdFor();
      expect(sharedFieldId).toBe(sameFieldIdAgain);

      async function seedWithFieldId(userId: string, fieldId: string) {
        const strategyRes = await db.query<{ id: string }>(
          `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
           values ($1, 'Decay Live Test Strategy', 1, false, 'active') returning id`,
          [userId],
        );
        const strategyId = strategyRes.rows[0].id;
        await db.query(
          `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
           values ($1, $2, 'Decay Test Flag', 'strategy_var', 'bool', 'captured', $3, '{}'::jsonb)`,
          [fieldId, userId, strategyId],
        );
        await db.query(
          `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
           values ($1, 1, $2, 'Decay Live Test Strategy', $3::jsonb, '[]'::jsonb)`,
          [strategyId, userId, JSON.stringify([{ field_id: fieldId, capture_moment: 'pre_entry', order: 1 }])],
        );
        return strategyId;
      }

      const strategyIdA = await seedWithFieldId(userIdA, sharedFieldId);
      const strategyIdB = await seedWithFieldId(userIdB, sharedFieldId);

      const findingA = await insertFinding(userIdA, strategyIdA, sharedFieldId, 70, 0.2);
      const findingB = await insertFinding(userIdB, strategyIdB, sharedFieldId, 70, 0.2);
      const ruleId = '00000000-0000-0000-0000-0000000000d1'; // same rule id string reused across users too
      await createFindingRuleLink(userIdA, findingA, ruleId, 0.2, 70);
      await createFindingRuleLink(userIdB, findingB, ruleId, 0.2, 70);

      // Only user A's finding accrues enough new trades to be due.
      await db.query(`update retrospeq.findings set n = 100, delta_win_rate = 0.02 where id = $1`, [findingA]);
      // User B's stays at n=70 (not due).

      const resultA = await runDecayChecksForUser(userIdA);
      expect(resultA.linksChecked).toBe(1);

      // User B must be completely untouched by A's run.
      const linkB = await getLink(userIdB, findingB, ruleId);
      expect(linkB!.last_checked_at).toBeNull();
      expect(linkB!.consecutive_decay_checks).toBe(0);

      const resultB = await runDecayChecksForUser(userIdB);
      expect(resultB.linksChecked).toBe(0); // still not due for B
    },
    60_000,
  );
});
