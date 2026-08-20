import { describe, expect, it, vi } from 'vitest';

/**
 * Pure Zod-boundary coverage for Module 01 stories 3.1-3.4 (account
 * settings) — `dayRolloverSchema`/`updateTradingAccountSettingsInputSchema`
 * in `lib/broker/accounts-repository.ts`. No DB, no live env needed;
 * `server-only` is mocked the same way every other pure unit suite in
 * this repo does it (`lib/broker/__tests__/connect.test.ts` etc.) so this
 * file can import the repository module without a `SUPABASE_DB_URL`.
 */
vi.mock('server-only', () => ({}));

const { dayRolloverSchema, updateTradingAccountSettingsInputSchema, ACCOUNT_KINDS } = await import(
  '../accounts-repository'
);

describe('dayRolloverSchema', () => {
  it.each([
    'America/New_York 17:00',
    'UTC 00:00',
    'Europe/London 22:00',
    'Australia/Sydney 07:00',
    '00:00:00 UTC',
    '22:00:00 UTC',
  ])('accepts the real repo format: %s', (value) => {
    expect(dayRolloverSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    '',
    'not-a-rollover',
    '25:00 UTC',
    'America/New_York 25:00',
    '17:00', // missing zone
    'UTC', // missing time
    '00:00:00', // missing "UTC" suffix
  ])('rejects an invalid value: %s', (value) => {
    expect(dayRolloverSchema.safeParse(value).success).toBe(false);
  });
});

describe('updateTradingAccountSettingsInputSchema', () => {
  const valid = {
    label: 'FTMO Challenge',
    dayRollover: 'America/New_York 17:00',
    accountKind: 'personal' as const,
  };

  it('accepts a valid input', () => {
    const result = updateTradingAccountSettingsInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('story 3.3: accepts a label at exactly 40 characters', () => {
    const result = updateTradingAccountSettingsInputSchema.safeParse({
      ...valid,
      label: 'x'.repeat(40),
    });
    expect(result.success).toBe(true);
  });

  it('story 3.3: rejects a label over 40 characters', () => {
    const result = updateTradingAccountSettingsInputSchema.safeParse({
      ...valid,
      label: 'x'.repeat(41),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty label (trimmed)', () => {
    const result = updateTradingAccountSettingsInputSchema.safeParse({ ...valid, label: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims surrounding whitespace off a valid label', () => {
    const result = updateTradingAccountSettingsInputSchema.safeParse({
      ...valid,
      label: '  FTMO Challenge  ',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.label).toBe('FTMO Challenge');
  });

  it.each(ACCOUNT_KINDS)('accepts every real account_kind value: %s', (kind) => {
    const result = updateTradingAccountSettingsInputSchema.safeParse({ ...valid, accountKind: kind });
    expect(result.success).toBe(true);
  });

  it('rejects an account_kind outside personal|prop|demo', () => {
    const result = updateTradingAccountSettingsInputSchema.safeParse({ ...valid, accountKind: 'elite' });
    expect(result.success).toBe(false);
  });

  it('00-foundation §4.2: rejects an unrecognised key via strictObject rather than silently stripping it', () => {
    const result = updateTradingAccountSettingsInputSchema.safeParse({
      ...valid,
      status: 'connected', // not a settable field — must not slip through
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing dayRollover', () => {
    const { dayRollover: _omit, ...withoutRollover } = valid;
    const result = updateTradingAccountSettingsInputSchema.safeParse(withoutRollover);
    expect(result.success).toBe(false);
  });
});
