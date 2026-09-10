import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isAssetClassSuppressedField, partitionByAssetClassSuppression, ASSET_CLASS_SUPPRESSED_FIELD_IDS } from '../asset-class-suppression';
import type { SegmentComputationResult } from '../gates';

/**
 * Module 05 §4.12 — asset-class suppression, the pure half. Fresh
 * fixtures for this dispatch (not reused from the coder's own tests).
 */

function makeResult(fieldId: string, analyticId = 'find.pickone'): SegmentComputationResult {
  return {
    fieldId,
    analyticId,
    segment: { op: 'eq', value: 'x' },
    n: 40,
    winRate: 0.6,
    avgR: 0.5,
    baselineN: 40,
    baselineWinRate: 0.4,
    baselineAvgR: 0.1,
    deltaWinRate: 0.2,
    deltaAvgR: 0.4,
    pValue: 0.01,
    pAdjusted: 0.02,
    confidence: 'confident',
    gateFailures: [],
  } as unknown as SegmentComputationResult;
}

describe('isAssetClassSuppressedField', () => {
  it('is exactly the two-item literal set from §4.12', () => {
    expect([...ASSET_CLASS_SUPPRESSED_FIELD_IDS].sort()).toEqual(['drv.day_of_week', 'drv.session']);
  });

  it('flags drv.session and drv.day_of_week', () => {
    expect(isAssetClassSuppressedField('drv.session')).toBe(true);
    expect(isAssetClassSuppressedField('drv.day_of_week')).toBe(true);
  });

  it('does not flag an unrelated derived field or a custom field', () => {
    expect(isAssetClassSuppressedField('drv.risk_pct')).toBe(false);
    expect(isAssetClassSuppressedField('drv.direction')).toBe(false);
    expect(isAssetClassSuppressedField('conviction_flag')).toBe(false);
  });
});

describe('partitionByAssetClassSuppression', () => {
  it('when isCryptoStrategy is false, every result is rendered regardless of fieldId — including the suppressible fields', () => {
    const results = [makeResult('drv.session', 'find.session'), makeResult('drv.day_of_week'), makeResult('conviction_flag')];
    const { rendered, suppressed } = partitionByAssetClassSuppression(results, false);
    expect(rendered).toHaveLength(3);
    expect(suppressed).toHaveLength(0);
  });

  it('when isCryptoStrategy is true, only the two suppressible fields move to suppressed — unrelated fields still render', () => {
    const results = [makeResult('drv.session', 'find.session'), makeResult('drv.day_of_week'), makeResult('conviction_flag')];
    const { rendered, suppressed } = partitionByAssetClassSuppression(results, true);
    expect(rendered.map((r) => r.fieldId)).toEqual(['conviction_flag']);
    expect(suppressed.map((r) => r.fieldId).sort()).toEqual(['drv.day_of_week', 'drv.session']);
  });

  it('the fields still exist — a suppressed result carries its full original stats, not a stripped-down record', () => {
    const original = makeResult('drv.session', 'find.session');
    const { suppressed } = partitionByAssetClassSuppression([original], true);
    expect(suppressed[0]).toBe(original); // same object, no mutation, no data loss
  });

  it('partition is exhaustive and disjoint: every input result appears in exactly one of the two output arrays', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('drv.session', 'drv.day_of_week', 'conviction_flag', 'drv.risk_pct'), { minLength: 0, maxLength: 30 }),
        fc.boolean(),
        (fieldIds, isCrypto) => {
          const results = fieldIds.map((id, i) => makeResult(id, `analytic-${i}`));
          const { rendered, suppressed } = partitionByAssetClassSuppression(results, isCrypto);
          expect(rendered.length + suppressed.length).toBe(results.length);
          const renderedSet = new Set(rendered);
          const suppressedSet = new Set(suppressed);
          for (const r of results) {
            expect(renderedSet.has(r) !== suppressedSet.has(r)).toBe(true);
          }
        },
      ),
    );
  });

  it('a suppressible field is NEVER rendered when isCryptoStrategy is true, for any result set (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('drv.session', 'drv.day_of_week', 'other_field'), { minLength: 1, maxLength: 20 }), (fieldIds) => {
        const results = fieldIds.map((id, i) => makeResult(id, `analytic-${i}`));
        const { rendered } = partitionByAssetClassSuppression(results, true);
        expect(rendered.some((r) => isAssetClassSuppressedField(r.fieldId))).toBe(false);
      }),
    );
  });

  it('a non-suppressible field is NEVER suppressed, regardless of isCryptoStrategy (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('conviction_flag', 'drv.risk_pct', 'drv.instrument'), { minLength: 1, maxLength: 20 }), fc.boolean(), (fieldIds, isCrypto) => {
        const results = fieldIds.map((id, i) => makeResult(id, `analytic-${i}`));
        const { suppressed } = partitionByAssetClassSuppression(results, isCrypto);
        expect(suppressed).toHaveLength(0);
      }),
    );
  });
});
