import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { evaluateAndFreezeTradeRules, fetchEligibleRuleVersionsForTrade, FreezeTradeNotFoundError } from '../freeze-evaluations';

/**
 * Module 04 (Rulebook & Evaluation) Slice 5 — mocked-client unit tests for
 * `lib/rules/freeze-evaluations.ts`'s ORCHESTRATION logic: eligible-rule
 * filtering (the exact SQL §5.5's `eligible(rule, trade)` predicate
 * compiles to), version resolution, the `evaluate()` call, the
 * `rule_evaluations` row shape written, and the `RuleEvaluationError`
 * anomaly path. Full end-to-end correctness against a real Postgres
 * schema (forward-only application, frozen immutability, session-rule
 * attachment) is `freeze-evaluations.live.test.ts`'s job — this file's
 * fake client never asserts anything about cross-trade FACT correctness
 * (every cross-trade query below is stubbed to an empty/default result,
 * which is a legitimate "fresh account, no history" case, not a
 * simulation of real trading history).
 *
 * Routing strategy: a single fake `client.query` dispatches on a
 * substring unique to each real query text in this file / its
 * collaborators (`cross-trade-operand-values.ts`) — every query this
 * orchestration touches either has an explicit route below or falls
 * through to a safe `{ rows: [] }` default, which every collaborator
 * function already handles gracefully (`rows[0]?.x ?? default`), per
 * this file's own header (verified by reading each collaborator, not
 * assumed).
 */

interface FakeClientConfig {
  tradeRow?: Record<string, unknown> | null;
  eligibleRuleRows?: Record<string, unknown>[];
  preEntryCaptureRow?: Record<string, unknown> | null;
  syncTierRow?: Record<string, unknown> | null;
  /** The row `fetchReferenceTradeContext` (cross-trade-operand-values.ts)
   *  needs — distinguished from this file's own trade fetch by its own
   *  query text (`starting_equity`, joined to trading_accounts). */
  referenceTradeContextRow?: Record<string, unknown> | null;
}

interface CapturedInsert {
  sql: string;
  params: unknown[];
}

function buildFakeClient(config: FakeClientConfig) {
  const inserts: CapturedInsert[] = [];
  const queryLog: string[] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queryLog.push(sql);

    if (sql.includes('insert into retrospeq.rule_evaluations')) {
      inserts.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    // This file's own trade fetch (fetchTradeForFreeze) -- distinguished
    // from cross-trade-operand-values.ts's fetchReferenceTradeContext by
    // selecting strategy_id/initial_risk_pct/hold_seconds, never joined
    // to trading_accounts.
    if (sql.includes('strategy_id') && sql.includes('from retrospeq.trades')) {
      return { rows: config.tradeRow ? [config.tradeRow] : [] };
    }
    if (sql.includes('from retrospeq.rules r')) {
      return { rows: config.eligibleRuleRows ?? [] };
    }
    if (sql.includes('from retrospeq.trade_captures')) {
      return { rows: config.preEntryCaptureRow ? [config.preEntryCaptureRow] : [] };
    }
    if (sql.includes('select sync_tier from retrospeq.trading_accounts')) {
      return { rows: config.syncTierRow ? [config.syncTierRow] : [] };
    }
    // cross-trade-operand-values.ts's fetchReferenceTradeContext.
    if (sql.includes('starting_equity')) {
      return { rows: config.referenceTradeContextRow ? [config.referenceTradeContextRow] : [] };
    }
    // Every other cross-trade sub-query (day/week counts, PnL window,
    // prior outcomes, last-trade timings, prior peak volumes, open-risk
    // sum, prior-instrument existence, fill plan, fill role counts,
    // volume events) -- safe empty default, see this file's own header.
    return { rows: [] };
  });

  return { query, inserts, queryLog };
}

function baseTradeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'trade-1',
    user_id: 'user-1',
    account_id: 'account-1',
    strategy_id: null,
    opened_at: '2026-08-10T09:00:00.000+00:00',
    server_day: '2026-08-10',
    instrument: 'EURUSD',
    direction: 'long',
    initial_stop: '1.09000000',
    initial_risk_pct: '1.500000',
    risk_pct: '1.500000',
    exit_price_avg: '1.10500000',
    hold_seconds: 3600,
    ...overrides,
  };
}

function baseReferenceTradeContextRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'trade-1',
    account_id: 'account-1',
    user_id: 'user-1',
    instrument: 'EURUSD',
    direction: 'long',
    server_day: '2026-08-10',
    opened_at: '2026-08-10T09:00:00.000+00:00',
    closed_at: '2026-08-10T11:00:00.000+00:00',
    status: 'closed',
    peak_volume: '100000.00000000',
    risk_pct: '1.500000',
    initial_stop: '1.09000000',
    exit_price_avg: '1.10500000',
    starting_equity: '10000.00000000',
    ...overrides,
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('fetchEligibleRuleVersionsForTrade — §5.5 eligible(rule, trade), compiled to SQL', () => {
  it('scopes by user_id, active state, forward-only created_at, scope/scope_id, and the version-live-at-open-time window', async () => {
    const client = buildFakeClient({});
    await fetchEligibleRuleVersionsForTrade(client as never, 'user-1', 'strategy-1', '2026-08-10T09:00:00.000+00:00');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];

    // The forward-only clause: rule.created_at <= trade.opened_at.
    expect(sql).toMatch(/r\.created_at <= \$3/);
    // Active-only.
    expect(sql).toMatch(/r\.state = 'active'/);
    // scope = global OR scope_id = trade.strategy_id.
    expect(sql).toMatch(/r\.scope = 'global' or r\.scope_id = \$2/);
    // Version-live-at-open half-open interval: [created_at, superseded_at).
    expect(sql).toMatch(/rv\.created_at <= \$3/);
    expect(sql).toMatch(/rv\.superseded_at is null or rv\.superseded_at > \$3/);

    expect(params).toEqual(['user-1', 'strategy-1', '2026-08-10T09:00:00.000+00:00']);
  });

  it('returns the mapped rows verbatim (rule_id/severity/rule_version/operand_id/op/value)', async () => {
    const client = buildFakeClient({
      eligibleRuleRows: [
        { rule_id: 'rule-1', severity: 'soft', rule_version: 2, operand_id: 'risk_pct', op: 'lte', value: 2 },
      ],
    });
    const result = await fetchEligibleRuleVersionsForTrade(client as never, 'user-1', null, '2026-08-10T09:00:00Z');
    expect(result).toEqual([
      { ruleId: 'rule-1', ruleVersion: 2, severity: 'soft', operandId: 'risk_pct', op: 'lte', value: 2 },
    ]);
  });
});

describe('evaluateAndFreezeTradeRules — orchestration', () => {
  it('throws FreezeTradeNotFoundError for an id with no trades row, before touching anything else', async () => {
    const client = buildFakeClient({ tradeRow: null });
    await expect(evaluateAndFreezeTradeRules(client as never, 'ghost-trade')).rejects.toThrow(FreezeTradeNotFoundError);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('zero eligible rules -> short-circuits after exactly two queries (trade fetch + eligibility fetch), no cross-trade/fact-assembly I/O at all', async () => {
    const client = buildFakeClient({ tradeRow: baseTradeRow(), eligibleRuleRows: [] });
    const result = await evaluateAndFreezeTradeRules(client as never, 'trade-1');

    expect(result).toEqual({ tradeId: 'trade-1', eligibleRuleCount: 0, evaluationsWritten: 0, anomalies: [] });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.inserts).toHaveLength(0);
  });

  it('a single followed rule (computableToday operand, risk_pct <= 2 against initial_risk_pct = 1.5) writes exactly one correctly-shaped rule_evaluations row', async () => {
    const client = buildFakeClient({
      tradeRow: baseTradeRow(),
      eligibleRuleRows: [
        { rule_id: 'rule-1', severity: 'soft', rule_version: 1, operand_id: 'risk_pct', op: 'lte', value: 2 },
      ],
      referenceTradeContextRow: baseReferenceTradeContextRow(),
      syncTierRow: { sync_tier: 't0' },
    });

    const frozenAt = new Date('2026-08-11T00:00:00Z');
    const result = await evaluateAndFreezeTradeRules(client as never, 'trade-1', { frozenAt });

    expect(result.eligibleRuleCount).toBe(1);
    expect(result.evaluationsWritten).toBe(1);
    expect(result.anomalies).toEqual([]);
    expect(client.inserts).toHaveLength(1);

    const [, params] = [client.inserts[0].sql, client.inserts[0].params];
    // (user_id, trade_id, rule_id, rule_version, severity, result, reason, observed, server_day, frozen_at)
    expect(params[0]).toBe('user-1');
    expect(params[1]).toBe('trade-1');
    expect(params[2]).toBe('rule-1');
    expect(params[3]).toBe(1);
    expect(params[4]).toBe('soft'); // severity copied from rules.severity AT THIS MOMENT
    expect(params[5]).toBe('followed');
    expect(params[6]).toBeNull(); // reason only set for not_applicable
    expect(params[7]).toBe('1.5'); // observed, JSON-stringified from the numeric string "1.500000" via Decimal round-trip in extractRiskPct
    expect(params[8]).toBe('2026-08-10'); // server_day
    expect(params[9]).toBe(frozenAt.toISOString());
  });

  it('a broken rule (risk_pct <= 1 against 1.5) writes result="broken"', async () => {
    const client = buildFakeClient({
      tradeRow: baseTradeRow(),
      eligibleRuleRows: [
        { rule_id: 'rule-1', severity: 'hard', rule_version: 3, operand_id: 'risk_pct', op: 'lte', value: 1 },
      ],
      referenceTradeContextRow: baseReferenceTradeContextRow(),
      syncTierRow: { sync_tier: 't0' },
    });

    const result = await evaluateAndFreezeTradeRules(client as never, 'trade-1', { frozenAt: new Date('2026-08-11T00:00:00Z') });
    expect(result.evaluationsWritten).toBe(1);
    expect(client.inserts[0].params[4]).toBe('hard');
    expect(client.inserts[0].params[5]).toBe('broken');
  });

  it('a t1-tier-gated operand on a t0 account resolves to not_applicable(reason="tier"), never thrown, never blocks the other rule in the same batch', async () => {
    const client = buildFakeClient({
      tradeRow: baseTradeRow(),
      eligibleRuleRows: [
        // stop_moved_against is tier: 't1' in the real catalogue.
        { rule_id: 'rule-t1', severity: 'soft', rule_version: 1, operand_id: 'stop_moved_against', op: 'is_false', value: true },
        { rule_id: 'rule-ok', severity: 'soft', rule_version: 1, operand_id: 'risk_pct', op: 'lte', value: 2 },
      ],
      referenceTradeContextRow: baseReferenceTradeContextRow(),
      syncTierRow: { sync_tier: 't0' },
    });

    const result = await evaluateAndFreezeTradeRules(client as never, 'trade-1', { frozenAt: new Date('2026-08-11T00:00:00Z') });
    expect(result.eligibleRuleCount).toBe(2);
    expect(result.evaluationsWritten).toBe(2);
    expect(result.anomalies).toEqual([]);

    const t1Insert = client.inserts.find((i) => i.params[2] === 'rule-t1')!;
    expect(t1Insert.params[5]).toBe('not_applicable');
    expect(t1Insert.params[6]).toBe('tier');
    expect(t1Insert.params[7]).toBeNull();
  });

  it('a genuinely malformed rule (unknown operand_id) is caught, logged loudly, recorded as an anomaly, writes NO row for that rule, and does not throw or block the sibling rule', async () => {
    const client = buildFakeClient({
      tradeRow: baseTradeRow(),
      eligibleRuleRows: [
        { rule_id: 'rule-corrupt', severity: 'hard', rule_version: 1, operand_id: 'not_a_real_operand', op: 'lte', value: 1 },
        { rule_id: 'rule-ok', severity: 'soft', rule_version: 1, operand_id: 'risk_pct', op: 'lte', value: 2 },
      ],
      referenceTradeContextRow: baseReferenceTradeContextRow(),
      syncTierRow: { sync_tier: 't0' },
    });

    const result = await evaluateAndFreezeTradeRules(client as never, 'trade-1', { frozenAt: new Date('2026-08-11T00:00:00Z') });

    expect(result.eligibleRuleCount).toBe(2);
    expect(result.evaluationsWritten).toBe(1); // only rule-ok
    expect(result.anomalies).toEqual([
      expect.objectContaining({ tradeId: 'trade-1', ruleId: 'rule-corrupt', ruleVersion: 1, code: 'UNKNOWN_OPERAND' }),
    ]);
    expect(client.inserts).toHaveLength(1);
    expect(client.inserts[0].params[2]).toBe('rule-ok');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/ANOMALY evaluating rule rule-corrupt/);
  });

  it('a malformed op-for-type (e.g. "is_true" against a number operand) is also caught as an anomaly, not thrown', async () => {
    const client = buildFakeClient({
      tradeRow: baseTradeRow(),
      eligibleRuleRows: [
        { rule_id: 'rule-bad-op', severity: 'soft', rule_version: 1, operand_id: 'risk_pct', op: 'is_true', value: true },
      ],
      referenceTradeContextRow: baseReferenceTradeContextRow(),
      syncTierRow: { sync_tier: 't0' },
    });

    const result = await evaluateAndFreezeTradeRules(client as never, 'trade-1', { frozenAt: new Date('2026-08-11T00:00:00Z') });
    expect(result.evaluationsWritten).toBe(0);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ ruleId: 'rule-bad-op', code: 'INVALID_OP_FOR_TYPE' }),
    ]);
  });
});
