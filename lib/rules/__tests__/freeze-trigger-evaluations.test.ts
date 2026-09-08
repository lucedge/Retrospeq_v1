import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { freezeTriggerEvaluationsForTrade } from '../freeze-trigger-evaluations';

/**
 * Module 04 §3.1/§4.7 — mocked-client unit tests for
 * `freezeTriggerEvaluationsForTrade`'s own orchestration: the no-strategy
 * no-op, the zero-triggers no-op, and the met/unmet/unrecorded resolution
 * for every `arm_events.trigger_state` shape. Full end-to-end correctness
 * against a real Postgres schema (the real FK/immutability/RLS shape, a
 * real `confirmDay` call) is `freeze-trigger-evaluations.live.test.ts`'s
 * job — same split `freeze-evaluations.test.ts`/`.live.test.ts` already
 * establish for the sibling rule-evaluation freeze path.
 */

interface FakeConfig {
  tradeRow?: Record<string, unknown> | null;
  strategyVersionRow?: Record<string, unknown> | null;
  armEventRow?: Record<string, unknown> | null;
}

function buildFakeClient(config: FakeConfig) {
  const inserts: { params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('insert into retrospeq.trigger_evaluations')) {
      inserts.push({ params });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('from retrospeq.trades')) {
      return { rows: config.tradeRow ? [config.tradeRow] : [] };
    }
    if (sql.includes('from retrospeq.strategy_versions')) {
      return { rows: config.strategyVersionRow ? [config.strategyVersionRow] : [] };
    }
    if (sql.includes('from retrospeq.arm_events')) {
      return { rows: config.armEventRow ? [config.armEventRow] : [] };
    }
    throw new Error(`unexpected query in test: ${sql}`);
  });
  return { query, inserts };
}

describe('freezeTriggerEvaluationsForTrade', () => {
  it('no-ops for a trade with no strategy_id at all (every real trade in this repo today)', async () => {
    const fake = buildFakeClient({ tradeRow: { user_id: 'u1', strategy_id: null, strategy_version: null } });
    const result = await freezeTriggerEvaluationsForTrade(fake as never, 'trade-1');
    expect(result).toEqual({ tradeId: 'trade-1', applicableCount: 0, evaluationsWritten: 0 });
    expect(fake.inserts).toHaveLength(0);
  });

  it('no-ops for a trade whose bound strategy_version has zero triggers', async () => {
    const fake = buildFakeClient({
      tradeRow: { user_id: 'u1', strategy_id: 's1', strategy_version: 1 },
      strategyVersionRow: { triggers: [] },
    });
    const result = await freezeTriggerEvaluationsForTrade(fake as never, 'trade-1');
    expect(result).toEqual({ tradeId: 'trade-1', applicableCount: 0, evaluationsWritten: 0 });
    expect(fake.inserts).toHaveLength(0);
  });

  it('no-ops when the strategy_versions row itself is missing (should be structurally rare, fails safe)', async () => {
    const fake = buildFakeClient({
      tradeRow: { user_id: 'u1', strategy_id: 's1', strategy_version: 1 },
      strategyVersionRow: null,
    });
    const result = await freezeTriggerEvaluationsForTrade(fake as never, 'trade-1');
    expect(result).toEqual({ tradeId: 'trade-1', applicableCount: 0, evaluationsWritten: 0 });
  });

  it('resolves met/unmet/unrecorded correctly and writes one row per applicable condition', async () => {
    const frozenAt = new Date('2026-09-09T12:00:00Z');
    const fake = buildFakeClient({
      tradeRow: { user_id: 'u1', strategy_id: 's1', strategy_version: 1 },
      strategyVersionRow: {
        triggers: [
          { condition_id: 'cond-met', text: 'a', order: 1 },
          { condition_id: 'cond-unmet', text: 'b', order: 2 },
          { condition_id: 'cond-never-answered', text: 'c', order: 3 },
        ],
      },
      armEventRow: { trigger_state: { 'cond-met': true, 'cond-unmet': false } },
    });

    const result = await freezeTriggerEvaluationsForTrade(fake as never, 'trade-1', { frozenAt });

    expect(result).toEqual({ tradeId: 'trade-1', applicableCount: 3, evaluationsWritten: 3 });
    expect(fake.inserts).toHaveLength(3);
    const byConditionId = new Map(fake.inserts.map((i) => [i.params[2], i.params[3]]));
    expect(byConditionId.get('cond-met')).toBe('met');
    expect(byConditionId.get('cond-unmet')).toBe('unmet');
    expect(byConditionId.get('cond-never-answered')).toBe('unrecorded');
    // frozen_at is the SAME injected `now`, not a fresh Date() per row.
    for (const insert of fake.inserts) {
      expect(insert.params[4]).toBe(frozenAt.toISOString());
    }
  });

  it('resolves unrecorded for every condition when the trade never matched an arm_events row at all (broker-history-only import)', async () => {
    const fake = buildFakeClient({
      tradeRow: { user_id: 'u1', strategy_id: 's1', strategy_version: 1 },
      strategyVersionRow: { triggers: [{ condition_id: 'cond-1', text: 'a', order: 1 }] },
      armEventRow: null,
    });
    const result = await freezeTriggerEvaluationsForTrade(fake as never, 'trade-1');
    expect(result.evaluationsWritten).toBe(1);
    expect(fake.inserts[0].params[3]).toBe('unrecorded');
  });

  it('a non-boolean trigger_state value (malformed data) fails safe to unrecorded, never throws', async () => {
    const fake = buildFakeClient({
      tradeRow: { user_id: 'u1', strategy_id: 's1', strategy_version: 1 },
      strategyVersionRow: { triggers: [{ condition_id: 'cond-1', text: 'a', order: 1 }] },
      armEventRow: { trigger_state: { 'cond-1': 'yes' } },
    });
    const result = await freezeTriggerEvaluationsForTrade(fake as never, 'trade-1');
    expect(result.evaluationsWritten).toBe(1);
    expect(fake.inserts[0].params[3]).toBe('unrecorded');
  });
});
