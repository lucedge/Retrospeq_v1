import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';

/**
 * Module 02 §4.8 — unit tests for `lib/ingestion/manual-entry.ts`'s pure
 * pieces (00-foundation §9.1): `manualTradeInputSchema`,
 * `resolveManualTradeTimestamps` (header judgment call #1),
 * `deriveManualFillSides`, `computeManualRealizedPnl`.
 *
 * **Deliberate scoping decision, matching `sync.test.ts`'s own
 * precedent:** this file does not attempt to mock the full two-phase DB
 * write (`withUserConnection` + `withServiceRoleConnection` +
 * `recomputeInstrument`) — that's proven against the real database in
 * `manual-entry.live.test.ts` instead (account ownership/platform
 * rejection, RLS cross-user isolation, the full happy path producing real
 * rows), same "mocked pure logic AND a live-DB scenario" split this repo
 * already established elsewhere (e.g. `lib/entitlements/downgrade.ts`).
 * This module imports `server-only` transitively (via `sync.ts`), so
 * every dynamic `import('../manual-entry')` below runs under the same
 * `vi.mock('server-only', () => ({}))` every other ingestion test file
 * uses.
 */
import { vi } from 'vitest';
vi.mock('server-only', () => ({}));

describe('lib/ingestion/manual-entry.ts — manualTradeInputSchema', () => {
  const validInput = {
    instrument: 'EURUSD',
    direction: 'long' as const,
    size: '100000.00000000',
    entryPrice: '1.10000000',
    exitPrice: '1.10500000',
    stop: '1.09500000',
  };

  it('accepts a complete, valid six-field input', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('accepts a null stop (§4.4 honesty: stop not mandatory)', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, stop: null });
    expect(result.success).toBe(true);
  });

  it('accepts optional enteredAt/exitedAt (the extension beyond the literal six fields)', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({
      ...validInput,
      enteredAt: '2026-08-01T09:00:00Z',
      exitedAt: '2026-08-01T11:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognised key (z.strictObject, 00-foundation §4.2)', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, leverage: '10' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const { instrument: _drop, ...rest } = validInput;
    void _drop;
    const result = manualTradeInputSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects an empty instrument', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, instrument: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a direction outside long|short', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, direction: 'flat' });
    expect(result.success).toBe(false);
  });

  it.each(['size', 'entryPrice', 'exitPrice'] as const)('rejects a zero %s', async (field) => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, [field]: '0' });
    expect(result.success).toBe(false);
  });

  it.each(['size', 'entryPrice', 'exitPrice'] as const)('rejects a negative %s', async (field) => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, [field]: '-5' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric size', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, size: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects more than 8 fractional decimal places (exceeds numeric(20,8))', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, entryPrice: '1.123456789' });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 8 fractional decimal places', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, entryPrice: '1.12345678' });
    expect(result.success).toBe(true);
  });

  it('rejects a zero stop when stop is provided (not null)', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, stop: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed enteredAt', async () => {
    const { manualTradeInputSchema } = await import('../manual-entry');
    const result = manualTradeInputSchema.safeParse({ ...validInput, enteredAt: 'not-a-date' });
    expect(result.success).toBe(false);
  });
});

describe('lib/ingestion/manual-entry.ts — resolveManualTradeTimestamps (header judgment call #1)', () => {
  const now = new Date('2026-08-01T12:00:00Z');

  it('both omitted -> both default to the same shared "now" reference (honest hold_seconds = 0 signal)', async () => {
    const { resolveManualTradeTimestamps } = await import('../manual-entry');
    const result = resolveManualTradeTimestamps({}, now);
    expect(result.enteredAt).toEqual(now);
    expect(result.exitedAt).toEqual(now);
  });

  it('both provided, consistent -> passed through as given', async () => {
    const { resolveManualTradeTimestamps } = await import('../manual-entry');
    const enteredAt = '2026-07-01T09:00:00Z';
    const exitedAt = '2026-07-01T11:00:00Z';
    const result = resolveManualTradeTimestamps({ enteredAt, exitedAt }, now);
    expect(result.enteredAt.toISOString()).toBe(new Date(enteredAt).toISOString());
    expect(result.exitedAt.toISOString()).toBe(new Date(exitedAt).toISOString());
  });

  it('only enteredAt provided -> exitedAt defaults to "now"', async () => {
    const { resolveManualTradeTimestamps } = await import('../manual-entry');
    const enteredAt = '2026-07-01T09:00:00Z';
    const result = resolveManualTradeTimestamps({ enteredAt }, now);
    expect(result.enteredAt.toISOString()).toBe(new Date(enteredAt).toISOString());
    expect(result.exitedAt).toEqual(now);
  });

  it('only exitedAt provided -> enteredAt defaults to "now"', async () => {
    const { resolveManualTradeTimestamps } = await import('../manual-entry');
    const exitedAt = '2026-08-05T09:00:00Z'; // after `now`
    const result = resolveManualTradeTimestamps({ exitedAt }, now);
    expect(result.enteredAt).toEqual(now);
    expect(result.exitedAt.toISOString()).toBe(new Date(exitedAt).toISOString());
  });

  it('exitedAt strictly before enteredAt (both explicit) throws ManualEntryInvalidTimestampsError', async () => {
    const { resolveManualTradeTimestamps, ManualEntryInvalidTimestampsError } = await import('../manual-entry');
    expect(() =>
      resolveManualTradeTimestamps({ enteredAt: '2026-07-01T11:00:00Z', exitedAt: '2026-07-01T09:00:00Z' }, now),
    ).toThrow(ManualEntryInvalidTimestampsError);
  });

  it('exitedAt omitted (defaults to "now") but before an explicit past enteredAt is impossible when now >= enteredAt -- and throws when now genuinely precedes an explicit exitedAt paired with an omitted enteredAt that is LATER than exitedAt', async () => {
    // Constructed edge case: enteredAt omitted (defaults to `now`, which is
    // AFTER the explicitly supplied exitedAt) -- exercises the same guard
    // from the other direction, proving it's not one-sided.
    const { resolveManualTradeTimestamps, ManualEntryInvalidTimestampsError } = await import('../manual-entry');
    const pastExitedAt = '2026-01-01T00:00:00Z'; // well before `now`
    expect(() => resolveManualTradeTimestamps({ exitedAt: pastExitedAt }, now)).toThrow(
      ManualEntryInvalidTimestampsError,
    );
  });

  it('exactly equal enteredAt/exitedAt is allowed (hold_seconds = 0), not rejected as invalid', async () => {
    const { resolveManualTradeTimestamps } = await import('../manual-entry');
    const t = '2026-07-01T09:00:00Z';
    const result = resolveManualTradeTimestamps({ enteredAt: t, exitedAt: t }, now);
    expect(result.enteredAt).toEqual(result.exitedAt);
  });
});

describe('lib/ingestion/manual-entry.ts — deriveManualFillSides', () => {
  it('long -> buy to enter, sell to exit', async () => {
    const { deriveManualFillSides } = await import('../manual-entry');
    expect(deriveManualFillSides('long')).toEqual({ entrySide: 'buy', exitSide: 'sell' });
  });

  it('short -> sell to enter, buy to exit', async () => {
    const { deriveManualFillSides } = await import('../manual-entry');
    expect(deriveManualFillSides('short')).toEqual({ entrySide: 'sell', exitSide: 'buy' });
  });
});

describe('lib/ingestion/manual-entry.ts — computeManualRealizedPnl', () => {
  it('long, profitable: (exit - entry) * size', async () => {
    const { computeManualRealizedPnl } = await import('../manual-entry');
    const pnl = computeManualRealizedPnl('long', '1.10000000', '1.10500000', '100000');
    expect(pnl.toFixed(8)).toBe(new Decimal('0.005').mul('100000').toFixed(8));
  });

  it('long, losing: negative P&L', async () => {
    const { computeManualRealizedPnl } = await import('../manual-entry');
    const pnl = computeManualRealizedPnl('long', '1.10500000', '1.10000000', '100000');
    expect(pnl.isNegative()).toBe(true);
  });

  it('short, profitable: (entry - exit) * size', async () => {
    const { computeManualRealizedPnl } = await import('../manual-entry');
    const pnl = computeManualRealizedPnl('short', '1.10500000', '1.10000000', '100000');
    expect(pnl.toFixed(8)).toBe(new Decimal('0.005').mul('100000').toFixed(8));
  });

  it('short, losing: negative P&L', async () => {
    const { computeManualRealizedPnl } = await import('../manual-entry');
    const pnl = computeManualRealizedPnl('short', '1.10000000', '1.10500000', '100000');
    expect(pnl.isNegative()).toBe(true);
  });

  it('exactly flat entry/exit -> exactly zero, not a near-zero float artifact', async () => {
    const { computeManualRealizedPnl } = await import('../manual-entry');
    const pnl = computeManualRealizedPnl('long', '1.10000000', '1.10000000', '100000');
    expect(pnl.isZero()).toBe(true);
  });
});
