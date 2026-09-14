import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { connectAsOwner, createTestAuthUser, deleteTestAuthUser, readRlsTestEnv, type TestAuthUser } from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

import { applyRuleEdit, fetchRuleVersionChangesForUser, insertRuleAndVersion } from '../rules-repository';

/**
 * Module 06 (Review & Graduation) §4.7's own worked example — live-DB
 * proof for `fetchRuleVersionChangesForUser`, the read ADR 0041's §4.7
 * paragraph said `rule_versions` already had every fact for but that
 * nothing in this repo read yet. Same fixture/cleanup shape as this
 * directory's own `rules-repository.live.test.ts` (real
 * `createTestAuthUser`/`deleteTestAuthUser`, the erasure-escape-hatch
 * cleanup pattern for `rules_forbid_delete`).
 */

const env = readRlsTestEnv();

describe.skipIf(!env)('fetchRuleVersionChangesForUser (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'rule-version-changes');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.rules where user_id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it(
    'two edits to the same rule produce two changes (oldest predecessor value carried correctly); creation (version 1) never appears',
    async () => {
      const created = await insertRuleAndVersion({
        userId: user.id,
        operandId: 'risk_pct',
        op: 'lte',
        value: 1,
        scope: 'global',
        scopeId: null,
        evaluation: 'pre_entry',
        rendered: 'Never risk more than 1% per trade.',
        capLimit: null,
      });

      const editedOnce = await applyRuleEdit(user.id, created.ruleId, 1, 'risk_pct', 'lte', 2, 'Never risk more than 2% per trade.');
      expect(editedOnce.newVersion).toBe(2);
      await applyRuleEdit(user.id, created.ruleId, 2, 'risk_pct', 'lte', 3, 'Never risk more than 3% per trade.');

      const today = new Date().toISOString().slice(0, 10);
      const changes = await fetchRuleVersionChangesForUser(user.id, today, today);

      // Both edits present, most recent first, creation (v1) excluded.
      expect(changes).toHaveLength(2);
      expect(changes[0]).toMatchObject({
        ruleId: created.ruleId,
        operandId: 'risk_pct',
        op: 'lte',
        rendered: 'Never risk more than 3% per trade.',
      });
      expect(Number(changes[0].oldValue)).toBe(2);
      expect(Number(changes[0].newValue)).toBe(3);
      expect(changes[1]).toMatchObject({
        ruleId: created.ruleId,
        operandId: 'risk_pct',
        op: 'lte',
        rendered: 'Never risk more than 2% per trade.',
      });
      expect(Number(changes[1].oldValue)).toBe(1);
      expect(Number(changes[1].newValue)).toBe(2);
      // Newer change strictly first.
      expect(new Date(changes[0].changedAt).getTime()).toBeGreaterThanOrEqual(new Date(changes[1].changedAt).getTime());
    },
    15_000,
  );

  it('a rule with no edits (only its creation, version 1) contributes no change row', async () => {
    const created = await insertRuleAndVersion({
      userId: user.id,
      operandId: 'daily_pnl_pct',
      op: 'lte',
      value: -1,
      scope: 'global',
      scopeId: null,
      evaluation: 'session',
      rendered: 'Never-edited rule.',
      capLimit: null,
    });

    const today = new Date().toISOString().slice(0, 10);
    const changes = await fetchRuleVersionChangesForUser(user.id, today, today);
    expect(changes.find((c) => c.ruleId === created.ruleId)).toBeUndefined();
  });

  it('retiring a rule (no new rule_versions row) never surfaces as a change', async () => {
    const created = await insertRuleAndVersion({
      userId: user.id,
      operandId: 'daily_pnl_pct',
      op: 'lte',
      value: -2,
      scope: 'global',
      scopeId: null,
      evaluation: 'session',
      rendered: 'Retirement test rule.',
      capLimit: null,
    });
    await db.query(`update retrospeq.rules set state = 'retired', retired_at = now() where id = $1`, [created.ruleId]);

    const today = new Date().toISOString().slice(0, 10);
    const changes = await fetchRuleVersionChangesForUser(user.id, today, today);
    expect(changes.find((c) => c.ruleId === created.ruleId)).toBeUndefined();
  });

  it(
    'cross-user isolation: a second user editing their own rule never appears in the first user\'s read',
    async () => {
      const otherUser = await createTestAuthUser(env!, 'rule-version-changes-other');
      try {
        const otherRule = await insertRuleAndVersion({
          userId: otherUser.id,
          operandId: 'risk_pct',
          op: 'lte',
          value: 1,
          scope: 'global',
          scopeId: null,
          evaluation: 'pre_entry',
          rendered: 'Other user rule.',
          capLimit: null,
        });
        await applyRuleEdit(otherUser.id, otherRule.ruleId, 1, 'risk_pct', 'lte', 2, 'Other user rule, edited.');

        const today = new Date().toISOString().slice(0, 10);
        const ownFirstUserChanges = await fetchRuleVersionChangesForUser(user.id, today, today);
        expect(ownFirstUserChanges.find((c) => c.ruleId === otherRule.ruleId)).toBeUndefined();

        const otherUserChanges = await fetchRuleVersionChangesForUser(otherUser.id, today, today);
        expect(otherUserChanges.find((c) => c.ruleId === otherRule.ruleId)).toBeDefined();
      } finally {
        await db.query('begin');
        await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
        await db.query('delete from retrospeq.rules where user_id = $1', [otherUser.id]);
        await db.query('commit');
        await deleteTestAuthUser(env!, otherUser.id).catch(() => {});
      }
    },
    15_000,
  );

  it('a date range that excludes today returns no rows for an edit made today', async () => {
    const created = await insertRuleAndVersion({
      userId: user.id,
      operandId: 'risk_pct',
      op: 'lte',
      value: 1,
      scope: 'global',
      scopeId: null,
      evaluation: 'pre_entry',
      rendered: 'Range-exclusion test rule.',
      capLimit: null,
    });
    await applyRuleEdit(user.id, created.ruleId, 1, 'risk_pct', 'lte', 2, 'Range-exclusion test rule, edited.');

    const changes = await fetchRuleVersionChangesForUser(user.id, '2000-01-01', '2000-01-02');
    expect(changes.find((c) => c.ruleId === created.ruleId)).toBeUndefined();
  });
});
