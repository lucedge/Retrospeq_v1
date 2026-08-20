import { describe, expect, it } from 'vitest';
import { totpCodeSchema, recoveryCodeSchema, factorIdSchema } from '../mfa-schemas';

describe('totpCodeSchema', () => {
  it('accepts a plain 6-digit code', () => {
    expect(totpCodeSchema.safeParse('123456').success).toBe(true);
  });

  it('strips whitespace before validating ("123 456")', () => {
    const result = totpCodeSchema.safeParse('123 456');
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe('123456');
  });

  it.each(['12345', '1234567', 'abcdef', '', '123-456'])('rejects %s', (bad) => {
    expect(totpCodeSchema.safeParse(bad).success).toBe(false);
  });
});

describe('recoveryCodeSchema', () => {
  it('accepts a well-formed recovery code', () => {
    expect(recoveryCodeSchema.safeParse('AAAA-BBBB-CCCC-DDDD').success).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(recoveryCodeSchema.safeParse('').success).toBe(false);
  });

  it('rejects something absurdly long (defence against a pathological input before it reaches a DB query)', () => {
    expect(recoveryCodeSchema.safeParse('A'.repeat(100)).success).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    const result = recoveryCodeSchema.safeParse('  AAAA-BBBB-CCCC-DDDD  ');
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe('AAAA-BBBB-CCCC-DDDD');
  });
});

describe('factorIdSchema', () => {
  it('accepts a UUID', () => {
    expect(factorIdSchema.safeParse('34e770dd-9ff9-416c-87fa-43b31d7ef225').success).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(factorIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects an empty/missing value', () => {
    expect(factorIdSchema.safeParse('').success).toBe(false);
    expect(factorIdSchema.safeParse(null).success).toBe(false);
  });
});
