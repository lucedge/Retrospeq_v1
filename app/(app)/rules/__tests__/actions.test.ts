import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for `app/(app)/rules/actions.ts` — Module 04's
 * authoring-pipeline Server Actions (`createRule`/`editRule`). Mocks the
 * session, rate limiter, entitlement service, and the repository
 * (`lib/rules/rules-repository.ts`) — never a live DB, matching
 * `app/(app)/accounts/__tests__/actions.test.ts`'s established pattern
 * (see that file's own header for why: no `vi.resetModules()`, one
 * static import per module so every `instanceof` check inside
 * `actions.ts` sees the same class object this file's own imports
 * construct errors from).
 *
 * The pure validation layer (operand-catalogue, validate-*, render-
 * sentence) is used FOR REAL here, not mocked — this suite is exercising
 * the Server Action's ORCHESTRATION (order of checks, error-code mapping),
 * and real operand data (`risk_pct`, etc.) makes the fixtures meaningful
 * rather than arbitrary. Live-DB RLS / real-transaction correctness is
 * `lib/rules/__tests__/rules-repository.live.test.ts`'s job, not this
 * file's.
 */

const {
  getUserMock,
  createClientMock,
  enforceRateLimitMock,
  getClientIpMock,
  revalidatePathMock,
  canForUserMock,
  fetchAccountSyncTiersMock,
  fetchActiveGlobalRuleVersionsForOperandMock,
  fetchCurrentRuleForEditMock,
  insertRuleAndVersionMock,
  applyRuleEditMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  revalidatePathMock: vi.fn(),
  canForUserMock: vi.fn(),
  fetchAccountSyncTiersMock: vi.fn(),
  fetchActiveGlobalRuleVersionsForOperandMock: vi.fn(),
  fetchCurrentRuleForEditMock: vi.fn(),
  insertRuleAndVersionMock: vi.fn(),
  applyRuleEditMock: vi.fn(),
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
vi.mock('@/lib/entitlements/service', () => ({
  canForUser: canForUserMock,
}));
vi.mock('@/lib/rules/rules-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rules/rules-repository')>();
  return {
    ...actual,
    fetchAccountSyncTiers: fetchAccountSyncTiersMock,
    fetchActiveGlobalRuleVersionsForOperand: fetchActiveGlobalRuleVersionsForOperandMock,
    fetchCurrentRuleForEdit: fetchCurrentRuleForEditMock,
    insertRuleAndVersion: insertRuleAndVersionMock,
    applyRuleEdit: applyRuleEditMock,
  };
});
vi.mock('server-only', () => ({}));

const { createRule, editRule } = await import('../actions');
const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
const { RuleEditConflictError, RuleNotEditableError } = await import('@/lib/rules/rules-repository');

const FAKE_USER = { id: 'user-aaaa-1111', email: 'trader@example.com' };

beforeEach(() => {
  getUserMock.mockReset().mockResolvedValue({ data: { user: FAKE_USER }, error: null });
  createClientMock.mockReset().mockResolvedValue({ auth: { getUser: getUserMock } });
  enforceRateLimitMock.mockReset().mockResolvedValue(undefined);
  getClientIpMock.mockReset().mockResolvedValue('203.0.113.9');
  revalidatePathMock.mockClear();
  canForUserMock.mockReset().mockResolvedValue({ allowed: true, reason: 'ok', limit: 3, used: 0 });
  fetchAccountSyncTiersMock.mockReset().mockResolvedValue(['t1']);
  fetchActiveGlobalRuleVersionsForOperandMock.mockReset().mockResolvedValue([]);
  fetchCurrentRuleForEditMock.mockReset();
  insertRuleAndVersionMock.mockReset().mockResolvedValue({ ruleId: 'rule-new-1', version: 1 });
  applyRuleEditMock.mockReset();
});

describe('createRule', () => {
  it('succeeds for a valid global rule and calls insertRuleAndVersion with the rendered sentence', async () => {
    const result = await createRule({ operandId: 'risk_pct', op: 'lte', value: 1.5, scope: 'global' });
    expect(result.success).toBe(true);
    expect(result.rule?.rendered).toBe('Never risk more than 1.5% per trade.');
    expect(insertRuleAndVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: FAKE_USER.id,
        operandId: 'risk_pct',
        op: 'lte',
        value: 1.5,
        scope: 'global',
        scopeId: null,
        rendered: 'Never risk more than 1.5% per trade.',
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith('/rules');
  });

  it('rejects an unknown operand_id with code UNKNOWN_OPERAND, before any repository call', async () => {
    const result = await createRule({ operandId: 'not_a_real_operand', op: 'lte', value: 1, scope: 'global' });
    expect(result.error?.code).toBe('UNKNOWN_OPERAND');
    expect(fetchAccountSyncTiersMock).not.toHaveBeenCalled();
    expect(canForUserMock).not.toHaveBeenCalled();
    expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
  });

  it('rejects a t1 operand when no connected account reports t1 sync capability', async () => {
    fetchAccountSyncTiersMock.mockResolvedValue(['t0']);
    const result = await createRule({ operandId: 'stop_moved_against', op: 'is_false', value: false, scope: 'global' });
    expect(result.error?.code).toBe('RULE_OPERAND_UNAVAILABLE');
    expect(canForUserMock).not.toHaveBeenCalled();
    expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
  });

  it('rejects a t1 operand when the trader has no connected accounts at all', async () => {
    fetchAccountSyncTiersMock.mockResolvedValue([]);
    const result = await createRule({ operandId: 'stop_moved_against', op: 'is_false', value: false, scope: 'global' });
    expect(result.error?.code).toBe('RULE_OPERAND_UNAVAILABLE');
  });

  it('rejects at the free-plan entitlement cap with code ENTITLEMENT_LIMIT', async () => {
    canForUserMock.mockResolvedValue({ allowed: false, reason: 'quota', limit: 3, used: 3 });
    const result = await createRule({ operandId: 'risk_pct', op: 'lte', value: 1.5, scope: 'global' });
    expect(result.error?.code).toBe('ENTITLEMENT_LIMIT');
    expect(result.error?.user_message).toContain('3 of 3');
    expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
  });

  it('rejects a looser strategy rule under an active global rule (RULE_LOOSER_THAN_GLOBAL)', async () => {
    fetchActiveGlobalRuleVersionsForOperandMock.mockResolvedValue([
      { ruleId: 'global-rule-1', op: 'lte', value: 1, rendered: 'Never risk more than 1% per trade.' },
    ]);
    const result = await createRule({
      operandId: 'risk_pct',
      op: 'lte',
      value: 2,
      scope: 'strategy',
      scopeId: '01927e00-0000-7000-8000-000000000001',
    });
    expect(result.error?.code).toBe('RULE_LOOSER_THAN_GLOBAL');
    expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
  });

  it('allows a tighter strategy rule under an active global rule', async () => {
    fetchActiveGlobalRuleVersionsForOperandMock.mockResolvedValue([
      { ruleId: 'global-rule-1', op: 'lte', value: 1, rendered: 'Never risk more than 1% per trade.' },
    ]);
    const result = await createRule({
      operandId: 'risk_pct',
      op: 'lte',
      value: 0.5,
      scope: 'strategy',
      scopeId: '01927e00-0000-7000-8000-000000000001',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unsatisfiable global rule against an existing active global rule (RULE_UNSATISFIABLE)', async () => {
    // day_of_week is the one v1 catalogue operand whose phrasing map
    // authors TWO operators (`in` and `not_in`) — the only operand a
    // genuine cross-operator contradiction is reachable through the real
    // authoring pipeline (validateOperandOpValue's phrasing gate rejects
    // any operator an operand doesn't actually author, e.g. risk_pct only
    // ever authors `lte`, never `gte` — see validate-operand-op-value's
    // own test suite for that boundary).
    fetchActiveGlobalRuleVersionsForOperandMock.mockResolvedValue([
      { ruleId: 'global-rule-1', op: 'in', value: ['mon', 'tue'], rendered: 'Only trade on mon, tue.' },
    ]);
    const result = await createRule({ operandId: 'day_of_week', op: 'not_in', value: ['mon', 'tue', 'wed'], scope: 'global' });
    expect(result.error?.code).toBe('RULE_UNSATISFIABLE');
    expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
  });

  it('requires scopeId for scope="strategy" (Zod boundary)', async () => {
    const result = await createRule({ operandId: 'risk_pct', op: 'lte', value: 1, scope: 'strategy' });
    expect(result.fieldErrors?.scopeId).toBeDefined();
  });

  it('rejects a value outside declared bounds with code INVALID_VALUE_SHAPE', async () => {
    const result = await createRule({ operandId: 'risk_pct', op: 'lte', value: 999, scope: 'global' });
    expect(result.error?.code).toBe('INVALID_VALUE_SHAPE');
  });

  describe('no compound expression is representable through this API path (Module 04 §5.2/§8.2, independent-review addition 2026-08-24)', () => {
    it('a nested {operand_id, op, value} object smuggled as `value` is rejected, not silently accepted as a second condition', async () => {
      const result = await createRule({
        operandId: 'risk_pct',
        op: 'lte',
        // Adversarial: a second condition attempting to ride along inside
        // the single `value` slot. There is no operand type whose value
        // validator accepts an object (number/duration/rating want a
        // number-or-numeric-string, pick_* want a string or string array,
        // bool wants a boolean, clock_time wants a string) — this must be
        // rejected as a structurally-invalid value, never interpreted as
        // an AND'd second clause.
        value: { operandId: 'daily_loss_pct', op: 'lte', value: 5 },
        scope: 'global',
      });
      expect(result.error?.code).toBe('INVALID_VALUE_SHAPE');
      expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
    });

    it('an array of two {operand_id, op, value} triples smuggled as `value` is rejected, not accepted as an OR/AND list', async () => {
      const result = await createRule({
        operandId: 'day_of_week',
        op: 'in',
        value: [
          { operandId: 'risk_pct', op: 'lte', value: 1 },
          { operandId: 'daily_loss_pct', op: 'lte', value: 5 },
        ],
        scope: 'global',
      });
      // day_of_week's `in` validator requires every array element to be a
      // string (a day-of-week enum value) — an object element fails that
      // check, the same class of rejection as the single-object case above.
      expect(result.error?.code).toBe('INVALID_VALUE_SHAPE');
      expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
    });

    it('unrecognised top-level fields (and/or/conditions/rules) are REJECTED outright by the Zod schema (.strict()), not silently stripped — security review finding 2, 00-foundation §4.2 "Reject unknown keys"', async () => {
      const result = await createRule({
        operandId: 'risk_pct',
        op: 'lte',
        value: 1.5,
        scope: 'global',
        // @ts-expect-error — deliberately adversarial extra fields a caller
        // might try to smuggle in, not part of CreateRuleInput's type.
        and: [{ operandId: 'daily_loss_pct', op: 'lte', value: 5 }],
        conditions: [{ operandId: 'consecutive_losses', op: 'lte', value: 3 }],
      });
      expect(result.success).toBeUndefined();
      expect(result.fieldErrors?._form).toBeDefined();
      expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
    });
  });

  it('surfaces a rate-limit rejection', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('createRule', 'ip:1.2.3.4', 3600));
    const result = await createRule({ operandId: 'risk_pct', op: 'lte', value: 1.5, scope: 'global' });
    expect(result.error?.code).toBe('RULE_RATE_LIMITED');
  });

  it('surfaces a missing session', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const result = await createRule({ operandId: 'risk_pct', op: 'lte', value: 1.5, scope: 'global' });
    expect(result.error?.code).toBe('RULE_SESSION_MISSING');
  });

  /**
   * Independent-review addition (retrospeq-tester, 2026-08-24) — Module 04
   * §8.2's "No compound expression is representable through any API path"
   * invariant, exercised structurally at THIS slice's real write boundary
   * (the Server Action's Zod schema), not just re-confirmed at the
   * schema/evaluator layer Slice 1 already proved it at. `op` is a single
   * `z.enum([...9 literals...])` — there is no array/union shape that lets
   * a caller attach a second `{operand_id, op, value}` triple to one rule.
   */
  it('cannot smuggle a second condition through `op` — a compound-shaped array is rejected by the Zod enum, never reaches the repository', async () => {
    const result = await createRule({
      operandId: 'risk_pct',
      // @ts-expect-error — deliberately malformed to prove the boundary rejects it, not just that TS would catch it
      op: ['lte', 'gte'],
      value: 1.5,
      scope: 'global',
    });
    expect(result.fieldErrors?.op).toBeDefined();
    expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
  });

  it('cannot smuggle a second condition through `operandId` — an array is rejected by the Zod string schema, never reaches the repository', async () => {
    const result = await createRule({
      // @ts-expect-error — deliberately malformed
      operandId: ['risk_pct', 'daily_pnl_pct'],
      op: 'lte',
      value: 1.5,
      scope: 'global',
    });
    expect(result.fieldErrors?.operandId).toBeDefined();
    expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
  });

  it('a nested array-of-conditions smuggled through `value` is never interpreted as a second condition — it is just an opaque value that fails the operand\'s own numeric-shape check', async () => {
    // risk_pct is a `number` operand — a compound-shaped payload here is
    // simply not a number/numeric string, so it fails
    // validateOperandOpValue's own type check exactly like any other
    // malformed value, never partially "applied" as a second rule.
    const result = await createRule({
      operandId: 'risk_pct',
      op: 'lte',
      value: [{ operandId: 'daily_pnl_pct', op: 'lte', value: -5 }],
      scope: 'global',
    });
    expect(result.error?.code).toBe('INVALID_VALUE_SHAPE');
    expect(insertRuleAndVersionMock).not.toHaveBeenCalled();
  });
});

describe('editRule', () => {
  const RULE_ID = '01927e00-0000-7000-8000-000000000099';

  function activeGlobalRule(
    overrides: Partial<{ scope: 'global' | 'strategy'; scopeId: string | null; operandId: string; op: string; value: unknown }> = {},
  ) {
    return {
      ruleId: RULE_ID,
      scope: overrides.scope ?? 'global',
      scopeId: overrides.scopeId ?? null,
      state: 'active',
      currentVersion: 1,
      operandId: overrides.operandId ?? 'risk_pct',
      op: overrides.op ?? 'lte',
      value: overrides.value ?? 2,
    };
  }

  it('succeeds and returns the incremented version, superseding the old one via applyRuleEdit', async () => {
    fetchCurrentRuleForEditMock.mockResolvedValue(activeGlobalRule({ value: 2 }));
    applyRuleEditMock.mockResolvedValue({ newVersion: 2 });

    const result = await editRule(RULE_ID, 1);

    expect(result.success).toBe(true);
    expect(result.rule?.version).toBe(2);
    expect(result.rule?.rendered).toBe('Never risk more than 1% per trade.');
    expect(applyRuleEditMock).toHaveBeenCalledWith(FAKE_USER.id, RULE_ID, 1, 'risk_pct', 'lte', 1, 'Never risk more than 1% per trade.');
    expect(revalidatePathMock).toHaveBeenCalledWith('/rules');
  });

  it('maps a lost concurrency race to RULE_EDIT_CONFLICT, retryable', async () => {
    fetchCurrentRuleForEditMock.mockResolvedValue(activeGlobalRule({ value: 2 }));
    applyRuleEditMock.mockRejectedValue(new RuleEditConflictError(RULE_ID, 1));

    const result = await editRule(RULE_ID, 1);

    expect(result.error?.code).toBe('RULE_EDIT_CONFLICT');
    expect(result.error?.retryable).toBe(true);
  });

  it('rejects editing a retired rule', async () => {
    fetchCurrentRuleForEditMock.mockResolvedValue({ ...activeGlobalRule(), state: 'retired' });
    const result = await editRule(RULE_ID, 1);
    expect(result.error?.code).toBe(new RuleNotEditableError(RULE_ID, 'retired').code);
    expect(applyRuleEditMock).not.toHaveBeenCalled();
  });

  it('returns RULE_NOT_FOUND when the rule does not exist (or is not owned by the caller)', async () => {
    fetchCurrentRuleForEditMock.mockResolvedValue(null);
    const result = await editRule(RULE_ID, 1);
    expect(result.error?.code).toBe('RULE_NOT_FOUND');
  });

  it('re-validates tier gating on edit', async () => {
    fetchCurrentRuleForEditMock.mockResolvedValue({ ...activeGlobalRule(), operandId: 'stop_moved_against', op: 'is_false', value: false });
    fetchAccountSyncTiersMock.mockResolvedValue(['t0']);
    const result = await editRule(RULE_ID, false);
    expect(result.error?.code).toBe('RULE_OPERAND_UNAVAILABLE');
    expect(applyRuleEditMock).not.toHaveBeenCalled();
  });

  it('re-validates tighten-only on edit for a strategy-scoped rule', async () => {
    fetchCurrentRuleForEditMock.mockResolvedValue(activeGlobalRule({ scope: 'strategy', scopeId: 'strategy-1' }));
    fetchActiveGlobalRuleVersionsForOperandMock.mockResolvedValue([
      { ruleId: 'global-rule-1', op: 'lte', value: 1, rendered: 'Never risk more than 1% per trade.' },
    ]);
    // editing the strategy rule's threshold LOOSER than the active global cap
    const result = await editRule(RULE_ID, 3);
    expect(result.error?.code).toBe('RULE_LOOSER_THAN_GLOBAL');
    expect(applyRuleEditMock).not.toHaveBeenCalled();
  });

  it('re-validates satisfiability on edit for a global-scoped rule, excluding itself from the comparison set', async () => {
    // Same operand-choice reasoning as createRule's own satisfiability
    // test above: day_of_week is the one v1 operand whose phrasing
    // authors two operators, so a real cross-operator contradiction is
    // reachable through the full pipeline. The rule being edited keeps
    // its own fixed op ('in') — only `value` changes on edit (§2.5).
    fetchCurrentRuleForEditMock.mockResolvedValue(activeGlobalRule({ operandId: 'day_of_week', op: 'in', value: ['mon'] }));
    fetchActiveGlobalRuleVersionsForOperandMock.mockResolvedValue([
      { ruleId: 'other-global-rule', op: 'not_in', value: ['mon', 'tue', 'wed'], rendered: 'Never trade on mon, tue, wed.' },
    ]);
    const result = await editRule(RULE_ID, ['mon', 'tue']);
    expect(result.error?.code).toBe('RULE_UNSATISFIABLE');
    // excludeRuleId (the 3rd argument) is the rule itself, so the mocked
    // repository result above never actually includes the rule's own
    // pre-edit row — this asserts the exclusion argument was passed.
    expect(fetchActiveGlobalRuleVersionsForOperandMock).toHaveBeenCalledWith(FAKE_USER.id, 'day_of_week', RULE_ID);
  });

  it('does NOT re-check the rules.create entitlement on edit', async () => {
    fetchCurrentRuleForEditMock.mockResolvedValue(activeGlobalRule({ value: 2 }));
    applyRuleEditMock.mockResolvedValue({ newVersion: 2 });
    await editRule(RULE_ID, 1);
    expect(canForUserMock).not.toHaveBeenCalled();
  });
});
