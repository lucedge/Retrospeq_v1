import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { fetchFieldForRuleOperandMock } = vi.hoisted(() => ({
  fetchFieldForRuleOperandMock: vi.fn(),
}));

vi.mock('@/lib/fields/fields-repository', () => ({
  fetchFieldForRuleOperand: fetchFieldForRuleOperandMock,
}));

import { resolveFieldOperandForRule } from '../field-operand-resolver';
import {
  FieldOperandNotFoundError,
  FieldOperandScopeMismatchError,
  FieldOperandTypeNotAuthorableError,
} from '../field-operand-catalogue';

/**
 * Module 04 — custom fields as rule operands (ADR 0046). Unit coverage for
 * `resolveFieldOperandForRule`'s ownership/state/scope-usability branching,
 * with `fetchFieldForRuleOperand` mocked so every rejection path (unknown
 * id, another user's field — RLS makes the two indistinguishable, both
 * return `null` from the repository — archived field, scope mismatch) is
 * exercised without a live DB. The DB round trip itself, and the real RLS
 * cross-user isolation it depends on, is proven live
 * (`field-operand.live.test.ts`).
 */
describe('field-operand-resolver — resolveFieldOperandForRule', () => {
  beforeEach(() => {
    fetchFieldForRuleOperandMock.mockReset();
  });

  it('rejects a malformed field operand id before ever reading the DB', async () => {
    await expect(resolveFieldOperandForRule('u1', 'field:', 'global', null)).rejects.toThrow(FieldOperandNotFoundError);
    expect(fetchFieldForRuleOperandMock).not.toHaveBeenCalled();
  });

  it('rejects when the repository returns null — nonexistent OR another user\'s field, indistinguishable by design (RLS)', async () => {
    fetchFieldForRuleOperandMock.mockResolvedValue(null);
    await expect(resolveFieldOperandForRule('u1', 'field:acct.other-users-field', 'global', null)).rejects.toThrow(
      FieldOperandNotFoundError,
    );
  });

  it('rejects an archived field', async () => {
    fetchFieldForRuleOperandMock.mockResolvedValue({
      fieldId: 'acct.f1',
      name: 'Conviction',
      kind: 'account',
      dataType: 'bool',
      config: {},
      ownerStrategyId: null,
      state: 'archived',
    });
    await expect(resolveFieldOperandForRule('u1', 'field:acct.f1', 'global', null)).rejects.toThrow(FieldOperandNotFoundError);
  });

  it('rejects a strategy_var field referenced by a global rule', async () => {
    fetchFieldForRuleOperandMock.mockResolvedValue({
      fieldId: 'str.f1',
      name: 'Setup grade',
      kind: 'strategy_var',
      dataType: 'number',
      config: { min: 0, max: 10, step: 1 },
      ownerStrategyId: 'strategy-a',
      state: 'active',
    });
    await expect(resolveFieldOperandForRule('u1', 'field:str.f1', 'global', null)).rejects.toThrow(
      FieldOperandScopeMismatchError,
    );
  });

  it('rejects a strategy_var field referenced by a DIFFERENT strategy than the one that owns it', async () => {
    fetchFieldForRuleOperandMock.mockResolvedValue({
      fieldId: 'str.f1',
      name: 'Setup grade',
      kind: 'strategy_var',
      dataType: 'number',
      config: { min: 0, max: 10, step: 1 },
      ownerStrategyId: 'strategy-a',
      state: 'active',
    });
    await expect(resolveFieldOperandForRule('u1', 'field:str.f1', 'strategy', 'strategy-b')).rejects.toThrow(
      FieldOperandScopeMismatchError,
    );
  });

  it('accepts a strategy_var field referenced by its own owning strategy', async () => {
    fetchFieldForRuleOperandMock.mockResolvedValue({
      fieldId: 'str.f1',
      name: 'Setup grade',
      kind: 'strategy_var',
      dataType: 'number',
      config: { min: 0, max: 10, step: 1 },
      ownerStrategyId: 'strategy-a',
      state: 'active',
    });
    const entry = await resolveFieldOperandForRule('u1', 'field:str.f1', 'strategy', 'strategy-a');
    expect(entry.id).toBe('field:str.f1');
    expect(entry.type).toBe('number');
  });

  it('accepts an account field referenced by a global rule', async () => {
    fetchFieldForRuleOperandMock.mockResolvedValue({
      fieldId: 'acct.f1',
      name: 'Conviction',
      kind: 'account',
      dataType: 'bool',
      config: {},
      ownerStrategyId: null,
      state: 'active',
    });
    const entry = await resolveFieldOperandForRule('u1', 'field:acct.f1', 'global', null);
    expect(entry.type).toBe('bool');
  });

  it('accepts an account field referenced by a strategy-scoped rule (account fields are usable everywhere)', async () => {
    fetchFieldForRuleOperandMock.mockResolvedValue({
      fieldId: 'acct.f1',
      name: 'Conviction',
      kind: 'account',
      dataType: 'bool',
      config: {},
      ownerStrategyId: null,
      state: 'active',
    });
    const entry = await resolveFieldOperandForRule('u1', 'field:acct.f1', 'strategy', 'strategy-a');
    expect(entry.type).toBe('bool');
  });

  it('propagates the not-authorable error for a resolvable-but-note-type field', async () => {
    fetchFieldForRuleOperandMock.mockResolvedValue({
      fieldId: 'acct.f1',
      name: 'Journal notes',
      kind: 'account',
      dataType: 'note',
      config: {},
      ownerStrategyId: null,
      state: 'active',
    });
    await expect(resolveFieldOperandForRule('u1', 'field:acct.f1', 'global', null)).rejects.toThrow(
      FieldOperandTypeNotAuthorableError,
    );
  });
});
