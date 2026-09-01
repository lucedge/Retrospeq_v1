import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 08 (Onboarding & Home) §7/§12 — mocked-repository unit coverage
 * for `getDashboardStateForUser`. Mocks `listOpenTrades`/
 * `listClosedUnconfirmedTrades`/`listTradingAccounts` (already separately
 * proven live elsewhere in this repo — Module 02/01) and exercises the
 * REAL `computeServerDay`/`resolveDashboardKind` — this file's own job is
 * "does the composition (today-filtering, ranking, target-grouping,
 * degrade-on-failure) work," not a re-proof of the underlying reads.
 */

const { listOpenTradesMock, listClosedUnconfirmedTradesMock, listTradingAccountsMock } = vi.hoisted(() => ({
  listOpenTradesMock: vi.fn(),
  listClosedUnconfirmedTradesMock: vi.fn(),
  listTradingAccountsMock: vi.fn(),
}));

vi.mock('@/lib/ingestion/trades-repository', () => ({
  listOpenTrades: listOpenTradesMock,
  listClosedUnconfirmedTrades: listClosedUnconfirmedTradesMock,
}));

vi.mock('@/lib/broker/accounts-repository', () => ({
  listTradingAccounts: listTradingAccountsMock,
}));

import { getDashboardStateForUser } from '../dashboard-repository';

const USER_ID = 'user-1';

function trade(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'trade-1',
    account_id: 'acct-a',
    instrument: 'EURUSD',
    direction: 'long',
    opened_at: '2026-06-10T09:00:00.000Z',
    server_day: '2026-06-10',
    risk_pct: '1.500000',
    ...overrides,
  };
}

function account(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'acct-a',
    day_rollover: '00:00:00 UTC',
    ...overrides,
  };
}

// A fixed instant chosen so the two `day_rollover` shapes below genuinely
// disagree about "today" -- see this file's own inline math comments at
// each use site.
const NOW = new Date('2026-06-10T23:00:00.000Z');

describe('getDashboardStateForUser', () => {
  beforeEach(() => {
    listOpenTradesMock.mockReset();
    listClosedUnconfirmedTradesMock.mockReset();
    listTradingAccountsMock.mockReset();
  });

  it('resolves clear when there are no open positions and nothing to close today', async () => {
    listOpenTradesMock.mockResolvedValue([]);
    listClosedUnconfirmedTradesMock.mockResolvedValue([]);
    listTradingAccountsMock.mockResolvedValue([account()]);

    const state = await getDashboardStateForUser(USER_ID, NOW);
    expect(state).toEqual({ kind: 'clear', syncDegraded: false });
  });

  it('resolves open, with real riskPct passed through, when at least one position is open', async () => {
    listOpenTradesMock.mockResolvedValue([trade({ id: 't-open', risk_pct: '2.250000' })]);
    listClosedUnconfirmedTradesMock.mockResolvedValue([]);
    listTradingAccountsMock.mockResolvedValue([account()]);

    const state = await getDashboardStateForUser(USER_ID, NOW);
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.positions).toEqual([
        { id: 't-open', instrument: 'EURUSD', direction: 'long', openedAt: '2026-06-10T09:00:00.000Z', riskPct: '2.250000' },
      ]);
    }
  });

  it('open ranks above closeout even when both signals are present (§7.1)', async () => {
    listOpenTradesMock.mockResolvedValue([trade({ id: 't-open' })]);
    // midnight rollover: today = date(NOW) = 2026-06-10.
    listClosedUnconfirmedTradesMock.mockResolvedValue([trade({ id: 't-closed', server_day: '2026-06-10' })]);
    listTradingAccountsMock.mockResolvedValue([account()]);

    const state = await getDashboardStateForUser(USER_ID, NOW);
    expect(state.kind).toBe('open');
  });

  it('excludes a closed-unconfirmed trade whose server_day is not TODAY for its own account', async () => {
    listOpenTradesMock.mockResolvedValue([]);
    // acct-a is midnight-rollover, so today = 2026-06-10; this trade is
    // from a prior day and must not count.
    listClosedUnconfirmedTradesMock.mockResolvedValue([trade({ id: 't-old', server_day: '2026-06-05' })]);
    listTradingAccountsMock.mockResolvedValue([account()]);

    const state = await getDashboardStateForUser(USER_ID, NOW);
    expect(state).toEqual({ kind: 'clear', syncDegraded: false });
  });

  it('resolves closeout with a real single-account/single-day target when every unconfirmed trade agrees', async () => {
    listOpenTradesMock.mockResolvedValue([]);
    listClosedUnconfirmedTradesMock.mockResolvedValue([
      trade({ id: 't-1', server_day: '2026-06-10' }),
      trade({ id: 't-2', server_day: '2026-06-10' }),
    ]);
    listTradingAccountsMock.mockResolvedValue([account()]);

    const state = await getDashboardStateForUser(USER_ID, NOW);
    expect(state.kind).toBe('closeout');
    if (state.kind === 'closeout') {
      expect(state.trades).toHaveLength(2);
      expect(state.target).toEqual({ accountId: 'acct-a', serverDay: '2026-06-10' });
    }
  });

  it('per-account "today": two accounts on different day_rollover configs genuinely disagree about today, and each trade is judged against its OWN account', async () => {
    // NOW = 2026-06-10T23:00:00Z.
    // acct-a: midnight rollover -> today = date(NOW) = 2026-06-10.
    // acct-b: 22:00 UTC rollover, timeOfDay(23:00) >= 22:00 -> today =
    //         date(NOW) + 1 day = 2026-06-11.
    listOpenTradesMock.mockResolvedValue([]);
    listClosedUnconfirmedTradesMock.mockResolvedValue([
      trade({ id: 't-a-today', account_id: 'acct-a', server_day: '2026-06-10' }), // counts for A
      trade({ id: 't-b-today', account_id: 'acct-b', server_day: '2026-06-11' }), // counts for B
      trade({ id: 't-b-not-today', account_id: 'acct-b', server_day: '2026-06-10' }), // does NOT count for B
    ]);
    listTradingAccountsMock.mockResolvedValue([
      account({ id: 'acct-a', day_rollover: '00:00:00 UTC' }),
      account({ id: 'acct-b', day_rollover: '22:00:00 UTC' }),
    ]);

    const state = await getDashboardStateForUser(USER_ID, NOW);
    expect(state.kind).toBe('closeout');
    if (state.kind === 'closeout') {
      const ids = state.trades.map((t) => t.id).sort();
      expect(ids).toEqual(['t-a-today', 't-b-today']);
      // Two distinct (account, day) pairs among today's trades -> genuinely
      // ambiguous, so the deep-link target falls back to null (the plain
      // picker), never an arbitrary guess.
      expect(state.target).toBeNull();
    }
  });

  it('degrades to Clear with syncDegraded=true, never throwing, when an underlying read fails (§12 DASH_STATE_UNRESOLVED)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    listOpenTradesMock.mockRejectedValue(new Error('connection reset'));
    listClosedUnconfirmedTradesMock.mockResolvedValue([]);
    listTradingAccountsMock.mockResolvedValue([]);

    const state = await getDashboardStateForUser(USER_ID, NOW);
    expect(state).toEqual({ kind: 'clear', syncDegraded: true });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
