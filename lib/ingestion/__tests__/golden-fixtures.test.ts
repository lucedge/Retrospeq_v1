/**
 * Module 02 §7.1 / 00-foundation §9.3 — golden fixture replay. Mandatory,
 * not optional, for anything touching block derivation or grouping.
 *
 * Extended (Slice 2) to also assert `expected.json`'s `trades[]` array —
 * §4.3's grouping engine and §4.4's derived facts — matched by stable
 * fill-membership signature (`account_id | provider_ref | trade_fills-or-
 * trade_events | role`), never by array position or a synthetic UUID,
 * same convention Slice 1 already used for matching `blocks[]`.
 *
 * Runs against literally all 8 fixtures in `fixtures/golden/`, not a
 * subset: `simple_daytrades`, `scaled_in_out`, `swing_with_intraday`,
 * `flip_no_flat`, `partial_fills_subsecond`, `overnight_weekend`,
 * `multi_currency`, `gapped_history`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeServerDay } from '../server-day';
import { type BlockDerivationFill, type DerivedBlock, deriveBlocks } from '../blocks';
import { type GroupingInputFill, groupBlock } from '../grouping';
import { type TradeFactsMember, computeTradeFacts } from '../trade-facts';

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'fixtures', 'golden');

interface FixtureAccount {
  account_ref?: string; // present only on multi-account fixtures (overnight_weekend, multi_currency)
  account_id: string;
  user_id: string;
  currency: string;
  platform: string;
  day_rollover: string;
  starting_equity: string;
  // Only present on a multi-account fixture's per-account object (see
  // fixtures/README.md's "Shape variant" note) -- single-account fixtures
  // carry fills at the TOP LEVEL of input.json instead, sibling to
  // "account", not nested inside it.
  fills?: FixtureFill[];
}

interface FixtureFill {
  provider_ref: string;
  instrument: string;
  side: 'buy' | 'sell';
  volume: string;
  price: string;
  filled_at: string;
  stop_at_fill: string | null;
  provider_position_ref?: string | null;
  provider_parent_ref?: string | null;
  realized_pnl?: string | null;
  [key: string]: unknown;
}

interface FixtureInput {
  fixture: string;
  account?: FixtureAccount;
  accounts?: FixtureAccount[];
  fills?: FixtureFill[]; // single-account shape only -- see FixtureAccount.fills comment
}

interface ExpectedBlock {
  block_ref: string;
  account_ref?: string;
  instrument: string;
  opened_at: string;
  closed_at: string | null;
  server_day: string;
  note?: string;
}

interface ExpectedFill {
  account_ref?: string;
  provider_ref: string;
  server_day: string;
}

interface ExpectedTradeFill {
  fill_ref: string;
  role: string;
}

interface ExpectedTradeEvent {
  kind: string;
  fill_ref: string;
  [key: string]: unknown;
}

interface ExpectedTrade {
  trade_ref: string;
  block_ref: string;
  account_ref?: string;
  instrument: string;
  direction: string;
  opened_at: string;
  closed_at: string | null;
  server_day: string;
  status: string;
  entry_price_avg: string;
  exit_price_avg: string | null;
  peak_volume: string;
  initial_stop: string | null;
  initial_risk_pct: string | null;
  risk_pct: string | null;
  r_multiple: string | null;
  realized_pnl: string;
  currency: string;
  hold_seconds: number | null;
  outcome: string | null;
  scale_out_count?: number;
  grouping_confidence: string;
  grouping_signals: Record<string, number>;
  grouping_source: string;
  confirmed_at: string | null;
  not_a_decision: boolean;
  trade_fills: ExpectedTradeFill[];
  trade_events?: ExpectedTradeEvent[];
}

interface ExpectedOutput {
  fills: ExpectedFill[];
  blocks: ExpectedBlock[];
  trades: ExpectedTrade[];
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function loadAccounts(input: FixtureInput): FixtureAccount[] {
  if (input.accounts) return input.accounts;
  if (input.account) {
    if (!input.fills) {
      throw new Error(`fixture ${input.fixture}: single-account shape but top-level "fills" is missing`);
    }
    return [{ ...input.account, fills: input.fills }];
  }
  throw new Error(`fixture ${input.fixture}: neither "account" nor "accounts" present`);
}

const fixtureNames = readdirSync(FIXTURES_DIR).filter((name) =>
  readdirSync(join(FIXTURES_DIR, name)).includes('input.json'),
);

// Sanity check on the harness itself, not just the fixtures it happens to
// find on disk — this is exactly the kind of silent scope-shrink ("ran
// against a subset without anyone noticing") the dispatch explicitly
// warned against.
const REQUIRED_FIXTURES = [
  'simple_daytrades',
  'scaled_in_out',
  'swing_with_intraday',
  'flip_no_flat',
  'partial_fills_subsecond',
  'overnight_weekend',
  'multi_currency',
  'gapped_history',
];

describe('golden fixture replay — harness sanity', () => {
  it('finds all 8 required fixtures on disk', () => {
    for (const name of REQUIRED_FIXTURES) {
      expect(fixtureNames).toContain(name);
    }
    expect(fixtureNames.length).toBeGreaterThanOrEqual(REQUIRED_FIXTURES.length);
  });
});

describe.each(REQUIRED_FIXTURES)('golden fixture: %s', (fixtureName) => {
  const dir = join(FIXTURES_DIR, fixtureName);
  const input: FixtureInput = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf-8'));
  const expected: ExpectedOutput = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf-8'));
  const accounts = loadAccounts(input);

  const dayRolloverByAccountId = new Map<string, string>();
  const accountRefByAccountId = new Map<string, string | undefined>();
  for (const acct of accounts) {
    dayRolloverByAccountId.set(acct.account_id, acct.day_rollover);
    accountRefByAccountId.set(acct.account_id, acct.account_ref);
  }

  // Synthetic, deterministic ids: `provider_ref` is already the fixture's
  // stable join key (per fixtures/README.md §2 — it's caller-supplied,
  // not DB-generated, unlike `id`). Using it directly as the block-
  // derivation `id` is safe for these fixtures specifically because none
  // of them exercises a genuine filled_at TIE needing the real UUIDv7
  // insertion-order tie-break (verified by inspection of every fixture's
  // fill timestamps — `partial_fills_subsecond`, the one fixture that
  // could plausibly need it, uses distinct sub-second timestamps for
  // every fill instead).
  const allFills: BlockDerivationFill[] = accounts.flatMap((acct) =>
    (acct.fills ?? []).map((f) => ({
      id: `${acct.account_id}:${f.provider_ref}`,
      accountId: acct.account_id,
      instrument: f.instrument,
      side: f.side,
      volume: f.volume,
      filledAt: f.filled_at,
    })),
  );

  it("computes each fill's server_day matching expected.json exactly", () => {
    for (const expectedFill of expected.fills) {
      const acct = expectedFill.account_ref
        ? accounts.find((a) => a.account_ref === expectedFill.account_ref)
        : accounts[0];
      if (!acct) throw new Error(`fixture ${fixtureName}: no account for ref ${expectedFill.account_ref}`);
      const fill = (acct.fills ?? []).find((f) => f.provider_ref === expectedFill.provider_ref);
      if (!fill) {
        throw new Error(
          `fixture ${fixtureName}: expected.json references provider_ref ${expectedFill.provider_ref} not present in input.json`,
        );
      }
      const actual = computeServerDay(fill.filled_at, acct.day_rollover);
      expect(actual, `${fixtureName} fill ${expectedFill.provider_ref} server_day`).toBe(expectedFill.server_day);
    }
  });

  it('derives blocks matching expected.json exactly (instrument/opened_at/closed_at/server_day)', () => {
    const { blocks } = deriveBlocks(allFills, (accountId) => {
      const rollover = dayRolloverByAccountId.get(accountId);
      if (!rollover) throw new Error(`fixture ${fixtureName}: no day_rollover for account ${accountId}`);
      return rollover;
    });

    expect(blocks, `${fixtureName}: block count`).toHaveLength(expected.blocks.length);

    for (const expectedBlock of expected.blocks) {
      const expectedAccountId = expectedBlock.account_ref
        ? accounts.find((a) => a.account_ref === expectedBlock.account_ref)?.account_id
        : accounts[0].account_id;

      const match = blocks.find(
        (b: DerivedBlock) =>
          b.instrument === expectedBlock.instrument &&
          b.openedAt === expectedBlock.opened_at &&
          b.accountId === expectedAccountId,
      );

      expect(
        match,
        `${fixtureName}: no derived block found for ${expectedBlock.block_ref} (${expectedBlock.instrument} @ ${expectedBlock.opened_at})`,
      ).toBeDefined();
      expect(match!.closedAt, `${fixtureName}: ${expectedBlock.block_ref} closed_at`).toBe(expectedBlock.closed_at);
      expect(match!.serverDay, `${fixtureName}: ${expectedBlock.block_ref} server_day`).toBe(expectedBlock.server_day);
    }

    // Every derived block should have been claimed by exactly one
    // expected block above — catches a spurious extra block the
    // instrument/opened_at matching loop wouldn't otherwise notice.
    for (const derived of blocks) {
      const claimed = expected.blocks.some(
        (eb) =>
          eb.instrument === derived.instrument &&
          eb.opened_at === derived.openedAt &&
          (eb.account_ref ? accounts.find((a) => a.account_ref === eb.account_ref)?.account_id : accounts[0].account_id) ===
            derived.accountId,
      );
      expect(claimed, `${fixtureName}: unexpected derived block ${derived.instrument} @ ${derived.openedAt}`).toBe(true);
    }
  });

  it('derives trades matching expected.json exactly (§4.3 grouping + §4.4 derived facts)', () => {
    const rolloverResolver = (accountId: string): string => {
      const rollover = dayRolloverByAccountId.get(accountId);
      if (!rollover) throw new Error(`fixture ${fixtureName}: no day_rollover for account ${accountId}`);
      return rollover;
    };
    const { blocks, assignments } = deriveBlocks(allFills, rolloverResolver);

    // fillId ("<account_id>:<provider_ref>") -> the fixture's own fill record.
    const fillDataById = new Map<string, FixtureFill & { accountId: string }>();
    for (const acct of accounts) {
      for (const f of acct.fills ?? []) {
        fillDataById.set(`${acct.account_id}:${f.provider_ref}`, { ...f, accountId: acct.account_id });
      }
    }

    interface DerivedTrade {
      instrument: string;
      openedAt: string;
      closedAt: string | null;
      serverDay: string;
      status: 'open' | 'closed';
      direction: string;
      entryPriceAvg: string;
      exitPriceAvg: string | null;
      peakVolume: string;
      initialStop: string | null;
      initialRiskPct: string | null;
      riskPct: string | null;
      rMultiple: string | null;
      realizedPnl: string;
      currency: string;
      holdSeconds: number | null;
      outcome: string | null;
      scaleOutCount: number;
      confidence: string;
      signals: Record<string, number>;
      signature: Set<string>;
    }

    const derivedTrades: DerivedTrade[] = [];

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      const account = accounts.find((a) => a.account_id === block.accountId);
      if (!account) throw new Error(`fixture ${fixtureName}: no account for block accountId ${block.accountId}`);

      // Each block only ever receives ONE assignment per fillId (a flip
      // fill's two assignments land on two DIFFERENT blockIndex values —
      // see blocks.ts/ADR 0001) so this filter can't collide.
      const blockAssignments = assignments.filter((a) => a.blockIndex === blockIndex);
      const groupingFills: GroupingInputFill[] = blockAssignments.map((a) => {
        const data = fillDataById.get(a.fillId);
        if (!data) throw new Error(`fixture ${fixtureName}: no fill data for ${a.fillId}`);
        return {
          fillId: a.fillId,
          side: data.side,
          volume: data.volume,
          appliedVolume: a.appliedVolume,
          price: data.price,
          filledAt: data.filled_at,
          stopAtFill: data.stop_at_fill ?? null,
          providerPositionRef: data.provider_position_ref ?? null,
          providerParentRef: data.provider_parent_ref ?? null,
        };
      });

      const groups = groupBlock(groupingFills, { dayRollover: account.day_rollover });

      for (const group of groups) {
        const members: TradeFactsMember[] = group.members.map((m) => {
          const data = fillDataById.get(m.fillId);
          if (!data) throw new Error(`fixture ${fixtureName}: no fill data for ${m.fillId}`);
          return {
            fillId: m.fillId,
            role: m.role,
            side: m.side,
            volume: m.volume,
            price: m.price,
            filledAt: m.filledAt,
            stopAtFill: m.stopAtFill,
            realizedPnl: m.syntheticEntryEvent ? null : (data.realized_pnl ?? null),
            syntheticEntryEvent: m.syntheticEntryEvent,
          };
        });

        const facts = computeTradeFacts(members, {
          startingEquity: account.starting_equity,
          currency: account.currency,
          contractValue: '1',
        });

        const first = members[0];
        const last = members[members.length - 1];
        const isClosed = last.role === 'exit';
        const openedAt = first.filledAt;
        const closedAt = isClosed ? last.filledAt : null;
        const serverDay = computeServerDay(openedAt, account.day_rollover);

        const signature = new Set<string>();
        for (const m of members) {
          const data = fillDataById.get(m.fillId);
          if (!data) throw new Error(`fixture ${fixtureName}: no fill data for ${m.fillId}`);
          const kind = m.syntheticEntryEvent ? 'trade_events' : 'trade_fills';
          signature.add(`${block.accountId}|${data.provider_ref}|${kind}|${m.role}`);
        }

        derivedTrades.push({
          instrument: block.instrument,
          openedAt,
          closedAt,
          serverDay,
          status: isClosed ? 'closed' : 'open',
          direction: facts.direction,
          entryPriceAvg: facts.entryPriceAvg,
          exitPriceAvg: facts.exitPriceAvg,
          peakVolume: facts.peakVolume,
          initialStop: facts.initialStop,
          initialRiskPct: facts.initialRiskPct,
          riskPct: facts.riskPct,
          rMultiple: facts.rMultiple,
          realizedPnl: facts.realizedPnl,
          currency: facts.currency,
          holdSeconds: facts.holdSeconds,
          outcome: facts.outcome,
          scaleOutCount: facts.scaleOutCount,
          confidence: group.confidence,
          signals: group.signals as Record<string, number>,
          signature,
        });
      }
    }

    expect(derivedTrades, `${fixtureName}: derived trade count`).toHaveLength(expected.trades.length);

    for (const expTrade of expected.trades) {
      const expectedAccountId = expTrade.account_ref
        ? accounts.find((a) => a.account_ref === expTrade.account_ref)?.account_id
        : accounts[0].account_id;
      if (!expectedAccountId) throw new Error(`fixture ${fixtureName}: no account for ref ${expTrade.account_ref}`);

      const expectedSignature = new Set<string>();
      for (const tf of expTrade.trade_fills) {
        expectedSignature.add(`${expectedAccountId}|${tf.fill_ref}|trade_fills|${tf.role}`);
      }
      for (const te of expTrade.trade_events ?? []) {
        expectedSignature.add(`${expectedAccountId}|${te.fill_ref}|trade_events|${te.kind}`);
      }

      const match = derivedTrades.find((dt) => setsEqual(dt.signature, expectedSignature));
      expect(
        match,
        `${fixtureName}: no derived trade found matching ${expTrade.trade_ref}'s fill membership (${[...expectedSignature].join(', ')})`,
      ).toBeDefined();
      const dt = match!;

      expect(dt.instrument, `${fixtureName} ${expTrade.trade_ref} instrument`).toBe(expTrade.instrument);
      expect(dt.direction, `${fixtureName} ${expTrade.trade_ref} direction`).toBe(expTrade.direction);
      expect(dt.openedAt, `${fixtureName} ${expTrade.trade_ref} opened_at`).toBe(expTrade.opened_at);
      expect(dt.closedAt, `${fixtureName} ${expTrade.trade_ref} closed_at`).toBe(expTrade.closed_at);
      expect(dt.serverDay, `${fixtureName} ${expTrade.trade_ref} server_day`).toBe(expTrade.server_day);
      expect(dt.status, `${fixtureName} ${expTrade.trade_ref} status`).toBe(expTrade.status);
      expect(dt.entryPriceAvg, `${fixtureName} ${expTrade.trade_ref} entry_price_avg`).toBe(expTrade.entry_price_avg);
      expect(dt.exitPriceAvg, `${fixtureName} ${expTrade.trade_ref} exit_price_avg`).toBe(expTrade.exit_price_avg);
      expect(dt.peakVolume, `${fixtureName} ${expTrade.trade_ref} peak_volume`).toBe(expTrade.peak_volume);
      expect(dt.initialStop, `${fixtureName} ${expTrade.trade_ref} initial_stop`).toBe(expTrade.initial_stop);
      expect(dt.initialRiskPct, `${fixtureName} ${expTrade.trade_ref} initial_risk_pct`).toBe(expTrade.initial_risk_pct);
      expect(dt.riskPct, `${fixtureName} ${expTrade.trade_ref} risk_pct`).toBe(expTrade.risk_pct);
      expect(dt.rMultiple, `${fixtureName} ${expTrade.trade_ref} r_multiple`).toBe(expTrade.r_multiple);
      expect(dt.realizedPnl, `${fixtureName} ${expTrade.trade_ref} realized_pnl`).toBe(expTrade.realized_pnl);
      expect(dt.currency, `${fixtureName} ${expTrade.trade_ref} currency`).toBe(expTrade.currency);
      expect(dt.holdSeconds, `${fixtureName} ${expTrade.trade_ref} hold_seconds`).toBe(expTrade.hold_seconds);
      expect(dt.outcome, `${fixtureName} ${expTrade.trade_ref} outcome`).toBe(expTrade.outcome);
      if (expTrade.scale_out_count !== undefined) {
        expect(dt.scaleOutCount, `${fixtureName} ${expTrade.trade_ref} scale_out_count`).toBe(expTrade.scale_out_count);
      }
      expect(dt.confidence, `${fixtureName} ${expTrade.trade_ref} grouping_confidence`).toBe(expTrade.grouping_confidence);
      expect(dt.signals, `${fixtureName} ${expTrade.trade_ref} grouping_signals`).toEqual(expTrade.grouping_signals);
      // Sanity checks on the fixture's own pre-freeze invariants, not this
      // slice's own computed output (these fields aren't produced by
      // grouping.ts/trade-facts.ts at all -- confirmed_at/grouping_source
      // belong to the confirm-transaction/corrections slices, out of scope
      // here) -- asserted so a fixture drift here is caught immediately.
      expect(expTrade.grouping_source, `${fixtureName} ${expTrade.trade_ref} grouping_source`).toBe('auto');
      expect(expTrade.confirmed_at, `${fixtureName} ${expTrade.trade_ref} confirmed_at`).toBeNull();
      expect(expTrade.not_a_decision, `${fixtureName} ${expTrade.trade_ref} not_a_decision`).toBe(false);
    }
  });
});
