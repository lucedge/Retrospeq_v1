import { describe, expect, it } from 'vitest';
import {
  isFieldIntroductionOfferEligible,
  FIELD_INTRODUCTION_MIN_TRADES_CONFIRMED,
  FIELD_INTRODUCTION_COOLDOWN_DAYS,
  FIELD_INTRODUCTION_MAX_DECLINES,
  type FieldIntroductionEligibilityInput,
} from '../field-introduction';

/**
 * Module 08 (Onboarding & Home) §5.5 / §10.1 — "Field introduction respects
 * the 30-day cooldown and stops after two declines." Pure, no I/O — see
 * `field-introduction.ts`'s own header for why this is split out of the
 * repository layer.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z');

function baseInput(overrides: Partial<FieldIntroductionEligibilityInput> = {}): FieldIntroductionEligibilityInput {
  return {
    tradesConfirmed: FIELD_INTRODUCTION_MIN_TRADES_CONFIRMED,
    fieldsDeclinedCount: 0,
    fieldsOfferedAt: null,
    hasFramingFinding: true,
    alreadyIntroduced: false,
    now: NOW,
    ...overrides,
  };
}

describe('isFieldIntroductionOfferEligible', () => {
  it('is eligible when every §5.5 condition clears', () => {
    expect(isFieldIntroductionOfferEligible(baseInput())).toBe(true);
  });

  it('29 confirmed trades: not eligible (boundary below the 30-trade floor)', () => {
    expect(isFieldIntroductionOfferEligible(baseInput({ tradesConfirmed: 29 }))).toBe(false);
  });

  it('30 confirmed trades: eligible (boundary is inclusive, ">= 30")', () => {
    expect(isFieldIntroductionOfferEligible(baseInput({ tradesConfirmed: 30 }))).toBe(true);
  });

  it('no framing finding: never eligible, regardless of every other condition', () => {
    expect(isFieldIntroductionOfferEligible(baseInput({ hasFramingFinding: false }))).toBe(false);
  });

  it('offered exactly 30 days ago: cooldown has elapsed, eligible again', () => {
    const offeredAt = new Date(NOW.getTime() - FIELD_INTRODUCTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(isFieldIntroductionOfferEligible(baseInput({ fieldsOfferedAt: offeredAt }))).toBe(true);
  });

  it('offered 29 days ago: still inside the cooldown window, not eligible', () => {
    const offeredAt = new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString();
    expect(isFieldIntroductionOfferEligible(baseInput({ fieldsOfferedAt: offeredAt }))).toBe(false);
  });

  it('offered 1 millisecond less than 30 days ago: still inside the window, not eligible', () => {
    const offeredAt = new Date(NOW.getTime() - FIELD_INTRODUCTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000 + 1).toISOString();
    expect(isFieldIntroductionOfferEligible(baseInput({ fieldsOfferedAt: offeredAt }))).toBe(false);
  });

  it('never offered before (fieldsOfferedAt null): the cooldown never applies', () => {
    expect(isFieldIntroductionOfferEligible(baseInput({ fieldsOfferedAt: null }))).toBe(true);
  });

  it('declined once: still eligible (only stops after the SECOND decline)', () => {
    expect(isFieldIntroductionOfferEligible(baseInput({ fieldsDeclinedCount: 1 }))).toBe(true);
  });

  it(`declined ${FIELD_INTRODUCTION_MAX_DECLINES} times: permanently not eligible`, () => {
    expect(isFieldIntroductionOfferEligible(baseInput({ fieldsDeclinedCount: FIELD_INTRODUCTION_MAX_DECLINES }))).toBe(false);
  });

  it('declined twice AND the cooldown has long since elapsed: still not eligible (declines are permanent, not a cooldown)', () => {
    const offeredAt = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      isFieldIntroductionOfferEligible(
        baseInput({ fieldsDeclinedCount: FIELD_INTRODUCTION_MAX_DECLINES, fieldsOfferedAt: offeredAt }),
      ),
    ).toBe(false);
  });

  it('already introduced (accepted previously): never eligible again, regardless of every other condition', () => {
    expect(isFieldIntroductionOfferEligible(baseInput({ alreadyIntroduced: true }))).toBe(false);
  });

  it('every gate combined at its most permissive boundary is still exactly one true/false result (total function)', () => {
    const result = isFieldIntroductionOfferEligible(
      baseInput({ tradesConfirmed: 30, fieldsDeclinedCount: 1, fieldsOfferedAt: null }),
    );
    expect(typeof result).toBe('boolean');
  });
});
