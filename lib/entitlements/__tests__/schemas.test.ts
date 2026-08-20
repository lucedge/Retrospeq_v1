import { describe, expect, it } from 'vitest';
import { devSetPlanInputSchema, planSchema } from '../schemas';

describe('lib/entitlements/schemas.ts', () => {
  describe('planSchema', () => {
    it('accepts "free" and "pro"', () => {
      expect(planSchema.safeParse('free').success).toBe(true);
      expect(planSchema.safeParse('pro').success).toBe(true);
    });

    it('rejects any other value, including the not-yet-modeled trader_plus', () => {
      expect(planSchema.safeParse('trader_plus').success).toBe(false);
      expect(planSchema.safeParse('').success).toBe(false);
      expect(planSchema.safeParse(undefined).success).toBe(false);
    });
  });

  describe('devSetPlanInputSchema', () => {
    it('accepts a well-formed { plan } object', () => {
      const result = devSetPlanInputSchema.safeParse({ plan: 'pro' });
      expect(result.success).toBe(true);
    });

    it('rejects an unrecognised key — strictObject, 00-foundation §4.2', () => {
      const result = devSetPlanInputSchema.safeParse({ plan: 'pro', extra: 'nope' });
      expect(result.success).toBe(false);
    });

    it('rejects a missing plan field', () => {
      expect(devSetPlanInputSchema.safeParse({}).success).toBe(false);
    });

    it('rejects an invalid plan value', () => {
      expect(devSetPlanInputSchema.safeParse({ plan: 'admin' }).success).toBe(false);
    });
  });
});
