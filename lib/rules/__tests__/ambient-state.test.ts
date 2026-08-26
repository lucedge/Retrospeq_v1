import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { withUserConnectionMock } = vi.hoisted(() => ({
  withUserConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

/**
 * Module 04 (Rulebook & Evaluation) §5.9 / §7.1 — Slice 8 mocked-client unit
 * tests for `lib/rules/ambient-state.ts`. `withUserConnection` mocked
 * (`severity-lifecycle-repository.test.ts`'s established pattern) with a
 * single fake `client.query` that routes on a substring unique to each real
 * query text this file's collaborators issue (`freeze-evaluations.test.ts`'s
 * established routing style) — `evaluate()` (`./evaluate.ts`) is used FOR
 * REAL here, spied on rather than mocked, matching `preview.test.ts`'s own
 * "one code path" precedent (`vi.spyOn(evaluateModule, 'evaluate')` on the
 * real export, not a parallel comparison implementation). Full end-to-end
 * correctness against a real Postgres schema (real `scope`/`evaluation`
 * filtering, genuinely-live second-call proof, RLS) is
 * `ambient-state.live.test.ts`'s job.
 */

import {
  getAmbientAccountState,
  fetchAmbientRules,
  AmbientAccountNotFoundError,
} from '../ambient-state';

// ---------------------------------------------------------------------
// Fake client — one query fn, routed by SQL substring
// ---------------------------------------------------------------------

interface FakeConfig {
  accountRow?: Record<string, unknown> | null;
  ruleRows?: Record<string, unknown>[];
  dayWeekRows?: Record<string, unknown>[];
  pnlRows?: Record<string, unknown>[];
  priorOutcomeRows?: Record<string, unknown>[];
  lastTradeRow?: Record<string, unknown> | null;
  lastLossRow?: Record<string, unknown> | null;
  openRiskRow?: Record<string, unknown> | null;
}

function buildFakeClient(config: FakeConfig = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    // fetchAmbientAccountContext.
    if (sql.includes('from retrospeq.trading_accounts')) {
      return { rows: config.accountRow ? [config.accountRow] : [] };
    }
    // fetchAmbientRules.
    if (sql.includes('from retrospeq.rules r')) {
      return { rows: config.ruleRows ?? [] };
    }
    // cross-trade-operand-values.ts: fetchTradesUpToReferenceInWeek.
    if (sql.includes('select server_day::text as server_day, instrument')) {
      return { rows: config.dayWeekRows ?? [] };
    }
    // cross-trade-operand-values.ts: fetchClosedTradesForPnlWindow.
    if (sql.includes('realized_pnl')) {
      return { rows: config.pnlRows ?? [] };
    }
    // cross-trade-operand-values.ts: fetchPriorOutcomesDescending.
    if (sql.includes('select outcome')) {
      return { rows: config.priorOutcomeRows ?? [] };
    }
    // cross-trade-operand-values.ts: fetchLastTradeTimings's lastLoss query
    // (checked BEFORE the generic "select closed_at" branch below, since
    // both queries share that same select list).
    if (sql.includes("outcome = 'loss'")) {
      return { rows: config.lastLossRow ? [config.lastLossRow] : [] };
    }
    // cross-trade-operand-values.ts: fetchLastTradeTimings's lastTrade query.
    if (sql.includes('select closed_at')) {
      return { rows: config.lastTradeRow ? [config.lastTradeRow] : [] };
    }
    // cross-trade-operand-values.ts: fetchOpenRiskSum.
    if (sql.includes('coalesce(sum(risk_pct)')) {
      return { rows: config.openRiskRow ? [config.openRiskRow] : [] };
    }
    throw new Error(`ambient-state.test.ts fake client: unrouted query -- ${sql} -- params: ${JSON.stringify(params)}`);
  });
  return { query };
}

function baseAccountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'account-1',
    sync_tier: 't0',
    day_rollover: '00:00:00 UTC',
    starting_equity: '10000.00000000',
    ...overrides,
  };
}

async function runAmbientState(
  config: FakeConfig,
  userId = 'user-1',
  accountId = 'account-1',
  now = new Date('2026-08-20T12:00:00.000Z'),
) {
  const client = buildFakeClient(config);
  withUserConnectionMock.mockImplementation(async (_uid: string, fn: (c: unknown) => unknown) => fn(client));
  const result = await getAmbientAccountState(userId, accountId, { now });
  return { result, client };
}

beforeEach(() => {
  withUserConnectionMock.mockReset();
});

// ---------------------------------------------------------------------
// 1. "Always visible" — the single most important test in this file
// ---------------------------------------------------------------------

describe('always visible, never appear-on-threshold (AGENTS.md non-negotiable)', () => {
  it('an active rule currently FOLLOWED (not broken) still gets a real entry in `rules`, tinted neutral -- never omitted just because nothing is currently wrong', async () => {
    const { result } = await runAmbientState({
      accountRow: baseAccountRow(),
      ruleRows: [
        { rule_id: 'rule-followed', severity: 'soft', evaluation: 'pre_entry', rule_version: 1, operand_id: 'trades_today', op: 'lte', value: 100 },
      ],
    });
    expect(result.rules).toHaveLength(1);
    const rule = result.rules[0];
    expect(rule.result).toBe('followed');
    expect(rule.tint).toBe('neutral');
    // Structurally present, not merely non-erroring -- every field the
    // AmbientRuleState type promises is genuinely on the object.
    for (const key of ['ruleId', 'ruleVersion', 'severity', 'evaluation', 'operandId', 'result', 'observed', 'tint']) {
      expect(Object.hasOwn(rule, key)).toBe(true);
    }
  });

  it('facts (tradesToday/dayPnlPct/riskVsCap) are ALWAYS present and well-formed even when zero active rules exist -- never absent, never a field silently undefined', async () => {
    const { result } = await runAmbientState({ accountRow: baseAccountRow(), ruleRows: [] });

    expect(result.rules).toEqual([]); // no rules authored -- correctly empty, not a bug
    expect(Object.hasOwn(result, 'facts')).toBe(true);
    expect(result.facts).toBeDefined();

    expect(Object.hasOwn(result.facts, 'tradesToday')).toBe(true);
    expect(result.facts.tradesToday.value).toBe(0); // "0 trades today" is a defined fact, not an absence
    expect(result.facts.tradesToday.tint).toBe('neutral');

    expect(Object.hasOwn(result.facts, 'dayPnlPct')).toBe(true);
    expect(result.facts.dayPnlPct.value).toBe(0);
    expect(result.facts.dayPnlPct.tint).toBe('neutral');

    expect(Object.hasOwn(result.facts, 'riskVsCap')).toBe(true);
    expect(Object.hasOwn(result.facts.riskVsCap, 'capPct')).toBe(true);
    expect(result.facts.riskVsCap.capPct).toBeNull(); // "no cap configured" is itself a real, always-present state
    expect(result.facts.riskVsCap.currentPct).toBe(0);
    expect(result.facts.riskVsCap.tint).toBe('neutral');
  });
});

// ---------------------------------------------------------------------
// 2. No red/green anywhere
// ---------------------------------------------------------------------

describe('no red/green anywhere (AGENTS.md non-negotiable), grep the file\'s own source', () => {
  it('the AmbientTint vocabulary is exactly neutral/watch/breach -- no hex/rgb literal, and no ACTUAL success/danger field/type anywhere in this file (only the doc-comment quoting the non-negotiable itself may mention the words)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', 'ambient-state.ts'), 'utf8');

    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // no hex colour literal
    expect(source).not.toMatch(/rgba?\(/i); // no rgb()/rgba() literal
    // No REAL field/property/type named success or danger (a genuine
    // `--color-success`/`--color-danger`-shaped pair) -- as distinct from
    // this file's own doc-comment quoting AGENTS.md's non-negotiable
    // ("never a hex code or a `success`/`danger` field name") to explain
    // WHY it doesn't have one, which is expected and fine.
    expect(source).not.toMatch(/\b(success|danger)\s*[:?]\s*(string|boolean|number|'|"|`)/i);
    expect(source).not.toMatch(/\b(is|has)(Success|Danger)\b/);
    expect(source).toMatch(/export type AmbientTint = 'neutral' \| 'watch' \| 'breach';/);
  });
});

// ---------------------------------------------------------------------
// 3. Tint derivation correctness
// ---------------------------------------------------------------------

describe('tint derivation -- breach > watch > neutral ranking', () => {
  it('a broken HARD rule tints breach; a broken SOFT rule tints watch; a followed rule tints neutral -- each independently, on the same operand -- and the aggregate fact tint is the WORST of the three', async () => {
    const { result } = await runAmbientState({
      accountRow: baseAccountRow(),
      ruleRows: [
        { rule_id: 'rule-followed', severity: 'soft', evaluation: 'pre_entry', rule_version: 1, operand_id: 'total_open_risk', op: 'lte', value: 5 },
        { rule_id: 'rule-soft-broken', severity: 'soft', evaluation: 'pre_entry', rule_version: 1, operand_id: 'total_open_risk', op: 'lte', value: 1 },
        { rule_id: 'rule-hard-broken', severity: 'hard', evaluation: 'session', rule_version: 1, operand_id: 'total_open_risk', op: 'lte', value: 0 },
      ],
      openRiskRow: { total: '2.0' },
    });

    const byId = Object.fromEntries(result.rules.map((r) => [r.ruleId, r]));
    expect(byId['rule-followed']).toEqual(expect.objectContaining({ result: 'followed', tint: 'neutral' }));
    expect(byId['rule-soft-broken']).toEqual(expect.objectContaining({ result: 'broken', tint: 'watch' }));
    expect(byId['rule-hard-broken']).toEqual(expect.objectContaining({ result: 'broken', tint: 'breach' }));

    expect(result.facts.riskVsCap.currentPct).toBe(2);
    expect(result.facts.riskVsCap.capPct).toBe(0); // tightest lte among total_open_risk rules
    expect(result.facts.riskVsCap.tint).toBe('breach'); // worst of the three governing rules
  });

  it('a not_applicable rule (operand genuinely absent from the ambient fact set) tints neutral regardless of severity', async () => {
    const { result } = await runAmbientState({
      accountRow: baseAccountRow(),
      ruleRows: [
        // risk_pct is a real, t0 operand, but it is NOT part of the ambient
        // live-facts operandValues set (only cross-trade day/week facts
        // are) -- resolves to not_applicable(operand_missing).
        { rule_id: 'rule-na', severity: 'hard', evaluation: 'pre_entry', rule_version: 1, operand_id: 'risk_pct', op: 'lte', value: 1 },
      ],
    });
    expect(result.rules[0]).toEqual(
      expect.objectContaining({ result: 'not_applicable', reason: 'operand_missing', tint: 'neutral' }),
    );
  });

  it('a tier-gated not_applicable rule (t1 operand on a t0 account) also tints neutral', async () => {
    const { result } = await runAmbientState({
      accountRow: baseAccountRow({ sync_tier: 't0' }),
      ruleRows: [
        { rule_id: 'rule-tier', severity: 'hard', evaluation: 'session', rule_version: 1, operand_id: 'stop_moved_against', op: 'is_false', value: true },
      ],
    });
    expect(result.rules[0]).toEqual(
      expect.objectContaining({ result: 'not_applicable', reason: 'tier', tint: 'neutral' }),
    );
  });
});

// ---------------------------------------------------------------------
// 4. evaluate() reuse, not a parallel implementation
// ---------------------------------------------------------------------

describe('evaluate() reuse (§5.3 "one code path")', () => {
  it('genuinely calls the real evaluate() export from ./evaluate, not a reimplementation', async () => {
    const evaluateModule = await import('../evaluate');
    const evaluateSpy = vi.spyOn(evaluateModule, 'evaluate');
    try {
      const { result } = await runAmbientState({
        accountRow: baseAccountRow(),
        ruleRows: [
          { rule_id: 'rule-1', severity: 'soft', evaluation: 'pre_entry', rule_version: 1, operand_id: 'trades_today', op: 'lte', value: 100 },
        ],
      });
      expect(evaluateSpy).toHaveBeenCalledTimes(1);
      expect(evaluateSpy).toHaveBeenCalledWith(
        { operandId: 'trades_today', op: 'lte', value: 100 },
        expect.objectContaining({ accountSyncTier: 't0' }),
      );
      expect(result.rules[0].result).toBe('followed');
    } finally {
      evaluateSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------
// 5. NO_REFERENCE_TRADE_ID sentinel reuse
// ---------------------------------------------------------------------

describe('NO_REFERENCE_TRADE_ID sentinel -- reused Slice 4 self-exclusion filter, not a forked query', () => {
  it('fetchPriorOutcomesDescending / fetchLastTradeTimings are both called with the nil-UUID sentinel', async () => {
    const NIL_UUID = '00000000-0000-0000-0000-000000000000';
    const { client } = await runAmbientState({ accountRow: baseAccountRow(), ruleRows: [] });

    const calls = client.query.mock.calls as unknown as [string, unknown[]][];
    const priorOutcomesCall = calls.find(([sql]) => sql.includes('select outcome'));
    expect(priorOutcomesCall).toBeDefined();
    expect(priorOutcomesCall![1]).toContain(NIL_UUID);

    const lastTradeTimingCalls = calls.filter(([sql]) => sql.includes('select closed_at'));
    expect(lastTradeTimingCalls).toHaveLength(2); // lastTrade + lastLoss sub-queries
    for (const call of lastTradeTimingCalls) {
      expect(call[1]).toContain(NIL_UUID);
    }
  });
});

// ---------------------------------------------------------------------
// 6. scope='global', evaluation in (pre_entry, session) only
// ---------------------------------------------------------------------

describe('fetchAmbientRules -- scope=global, evaluation in (pre_entry, session) only', () => {
  it('the query text scopes to user_id, active state, global scope, and pre_entry/session evaluation -- excludes scope=strategy and at_close by construction', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }));
    await fetchAmbientRules({ query: queryMock } as never, 'user-1');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/r\.state = 'active'/);
    expect(sql).toMatch(/r\.scope = 'global'/);
    expect(sql).not.toMatch(/scope = 'strategy'/);
    expect(sql).toMatch(/r\.evaluation in \('pre_entry', 'session'\)/);
    expect(sql).not.toMatch(/at_close/);
    expect(sql).toMatch(/rv\.version = r\.current_version/);
    expect(params).toEqual(['user-1']);
  });

  it('maps rows verbatim to the camelCase AmbientEligibleRule shape', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [{ rule_id: 'rule-1', severity: 'hard', evaluation: 'session', rule_version: 3, operand_id: 'trades_today', op: 'lte', value: 3 }],
    }));
    const result = await fetchAmbientRules({ query: queryMock } as never, 'user-1');
    expect(result).toEqual([
      { ruleId: 'rule-1', severity: 'hard', evaluation: 'session', ruleVersion: 3, operandId: 'trades_today', op: 'lte', value: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------
// 7. Read-only, proven
// ---------------------------------------------------------------------

describe('getAmbientAccountState is read-only end to end (§5.9 header: "writes nothing")', () => {
  it('never issues an INSERT/UPDATE/DELETE-shaped query, across a zero-rule scenario and a multi-rule broken-and-followed scenario', async () => {
    const scenarios: FakeConfig[] = [
      { accountRow: baseAccountRow(), ruleRows: [] },
      {
        accountRow: baseAccountRow(),
        ruleRows: [
          { rule_id: 'r1', severity: 'hard', evaluation: 'session', rule_version: 1, operand_id: 'total_open_risk', op: 'lte', value: 1 },
          { rule_id: 'r2', severity: 'soft', evaluation: 'pre_entry', rule_version: 1, operand_id: 'trades_today', op: 'lte', value: 3 },
        ],
        openRiskRow: { total: '2' },
        dayWeekRows: [{ server_day: '2026-08-20', instrument: 'EURUSD' }],
      },
    ];
    for (const config of scenarios) {
      const { client } = await runAmbientState(config);
      expect(client.query.mock.calls.length).toBeGreaterThan(0);
      for (const call of client.query.mock.calls) {
        const sql = String(call[0]);
        expect(sql).not.toMatch(/\b(insert|update|delete)\b/i);
      }
    }
  });
});

// ---------------------------------------------------------------------
// 8. AmbientAccountNotFoundError
// ---------------------------------------------------------------------

describe('AmbientAccountNotFoundError', () => {
  it('is thrown for an account id that does not exist / is not owned by the caller, before any other query', async () => {
    await expect(runAmbientState({ accountRow: null })).rejects.toBeInstanceOf(AmbientAccountNotFoundError);
  });
});

// ---------------------------------------------------------------------
// 10. Performance query-count sanity — ~8 round trips, never per-rule
// ---------------------------------------------------------------------

describe('defensive edge branches', () => {
  // Note: `deriveRiskCapPct`'s own defensive non-number/non-string `value`
  // skip (a `total_open_risk`/`lte` rule with a corrupted, non-numeric
  // `rule_versions.value`) is not independently reachable through the
  // public `getAmbientAccountState()` entry point -- the SAME malformed
  // rule is also fed to the real `evaluate()` in the very same loop
  // (this file's own header: thrown deliberately, not caught), which
  // throws first. That branch guards against corrupted data alongside an
  // already-thrown, already-tested `RuleEvaluationError` path, not a
  // silently-reachable product state -- left uncovered rather than forcing
  // an artificial unit test around a code path `evaluate()` itself already
  // proves unreachable in practice.

  it('defaults `now` to the real current time when the caller omits the options argument entirely', async () => {
    const client = buildFakeClient({ accountRow: baseAccountRow(), ruleRows: [] });
    withUserConnectionMock.mockImplementation(async (_uid: string, fn: (c: unknown) => unknown) => fn(client));
    const before = Date.now();
    const result = await getAmbientAccountState('user-1', 'account-1');
    const after = Date.now();
    const asOfMillis = new Date(result.asOf).getTime();
    expect(asOfMillis).toBeGreaterThanOrEqual(before);
    expect(asOfMillis).toBeLessThanOrEqual(after);
  });
});

describe('performance -- total round trips stay constant regardless of active rule count (§12 budget)', () => {
  it('exactly 8 queries with zero active rules', async () => {
    const { client } = await runAmbientState({ accountRow: baseAccountRow(), ruleRows: [] });
    expect(client.query).toHaveBeenCalledTimes(8);
  });

  it('still exactly 8 queries with 5 active rules -- no per-rule query, every rule evaluated in-memory against the same assembled fact object', async () => {
    const manyRules = Array.from({ length: 5 }, (_, i) => ({
      rule_id: `rule-${i}`,
      severity: 'soft' as const,
      evaluation: 'pre_entry' as const,
      rule_version: 1,
      operand_id: 'trades_today',
      op: 'lte' as const,
      value: 100,
    }));
    const { client } = await runAmbientState({ accountRow: baseAccountRow(), ruleRows: manyRules });
    expect(client.query).toHaveBeenCalledTimes(8);
  });
});
