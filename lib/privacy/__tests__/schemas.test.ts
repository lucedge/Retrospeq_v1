import { describe, expect, it } from 'vitest';
import { telemetryToggleInputSchema, dataRequestIdSchema } from '../schemas';

describe('telemetryToggleInputSchema', () => {
  it('accepts "true"/"false"', () => {
    expect(telemetryToggleInputSchema.safeParse({ optOut: 'true' }).success).toBe(true);
    expect(telemetryToggleInputSchema.safeParse({ optOut: 'false' }).success).toBe(true);
  });

  it('rejects any other value', () => {
    expect(telemetryToggleInputSchema.safeParse({ optOut: 'yes' }).success).toBe(false);
  });

  it('rejects unknown keys — strictObject, per 00-foundation §4.2', () => {
    expect(telemetryToggleInputSchema.safeParse({ optOut: 'true', extra: 'x' }).success).toBe(false);
  });
});

describe('dataRequestIdSchema', () => {
  it('accepts a valid uuid', () => {
    expect(dataRequestIdSchema.safeParse('01a02055-f9dd-7c6e-9c49-4639351c47d2').success).toBe(true);
  });

  it('rejects a non-uuid string', () => {
    expect(dataRequestIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});
