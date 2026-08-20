/**
 * Module 02 §7.1 / 00-foundation §9.3 — golden fixture replay. Mandatory,
 * not optional, for anything touching block derivation.
 *
 * This slice's own scope note (per its dispatch): only `expected.json`'s
 * `fills[].server_day` and `blocks[]` arrays are asserted here —
 * `trades[]` is the grouping engine's output (next slice), out of scope.
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

interface ExpectedOutput {
  fills: ExpectedFill[];
  blocks: ExpectedBlock[];
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
});
