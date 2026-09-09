import { describe, expect, it } from 'vitest';
import { computeEdgeFindingsForStrategy, type EdgeEngineField, type EdgeEngineTrade, NUMBER_FIELD_ANALYTIC_ID } from '../edge-engine';
import type { FieldRawValue } from '../field-values';

function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYNTHETIC_FIELDS: EdgeEngineField[] = [
  { fieldId: 'setup', dataType: 'pick_one' },
  { fieldId: 'flag', dataType: 'bool' },
  { fieldId: 'size', dataType: 'number' },
];

const SYNTHETIC_OPTIONS = ['a', 'b', 'c', 'd'];

/**
 * Generates ONE synthetic user's full strategy data with GENUINELY NO
 * TRUE EFFECT anywhere: outcome/R-multiple are drawn independently of
 * every field's value. `n` trades, deterministic given `seed` (a
 * `mulberry32` PRNG), so the whole 1,000-user run is reproducible.
 */
function generateNoEffectUser(seed: number, n = 150): { trades: EdgeEngineTrade[]; valuesByFieldAndTrade: Map<string, Map<string, FieldRawValue | null>> } {
  const rand = mulberry32(seed);
  const trades: EdgeEngineTrade[] = [];
  const setupValues = new Map<string, FieldRawValue | null>();
  const flagValues = new Map<string, FieldRawValue | null>();
  const sizeValues = new Map<string, FieldRawValue | null>();

  for (let i = 0; i < n; i++) {
    const id = `u${seed}_t${i}`;
    // Outcome/R drawn from a FIXED distribution, independent of any
    // field value — win probability 0.5, R uniform(-1, 1.5).
    const outcome: 'win' | 'loss' = rand() < 0.5 ? 'win' : 'loss';
    const rMultiple = -1 + rand() * 2.5;
    trades.push({ id, outcome, rMultiple });

    // Balanced, round-robin option assignment (not random) so every
    // segment reliably clears the SAMPLE gate — the point of this test
    // is to stress the EFFECT/SIGNIFICANCE gates specifically, not to
    // also be a test of the sample gate.
    setupValues.set(id, SYNTHETIC_OPTIONS[i % SYNTHETIC_OPTIONS.length]);
    flagValues.set(id, i % 2 === 0);
    sizeValues.set(id, rand() * 100);
  }

  const valuesByFieldAndTrade = new Map<string, Map<string, FieldRawValue | null>>([
    ['setup', setupValues],
    ['flag', flagValues],
    ['size', sizeValues],
  ]);

  return { trades, valuesByFieldAndTrade };
}

describe('computeEdgeFindingsForStrategy — integration', () => {
  it('produces no results for a field with data_type note', () => {
    const { trades, valuesByFieldAndTrade } = generateNoEffectUser(1);
    const fields: EdgeEngineField[] = [{ fieldId: 'notes', dataType: 'note' }];
    const results = computeEdgeFindingsForStrategy(trades, fields, valuesByFieldAndTrade);
    expect(results).toEqual([]);
  });

  it('produces no results for a field with no populated values at all', () => {
    const { trades } = generateNoEffectUser(2);
    const fields: EdgeEngineField[] = [{ fieldId: 'never_captured', dataType: 'pick_one' }];
    const results = computeEdgeFindingsForStrategy(trades, fields, new Map());
    expect(results).toEqual([]);
  });

  it('resolves the number-typed field to NUMBER_FIELD_ANALYTIC_ID', () => {
    const { trades, valuesByFieldAndTrade } = generateNoEffectUser(3);
    const results = computeEdgeFindingsForStrategy(trades, SYNTHETIC_FIELDS, valuesByFieldAndTrade);
    const sizeResults = results.filter((r) => r.fieldId === 'size');
    expect(sizeResults.length).toBeGreaterThan(0);
    sizeResults.forEach((r) => expect(r.analyticId).toBe(NUMBER_FIELD_ANALYTIC_ID));
  });

  it('resolves drv.session to the special find.session id, not the generic pick_one id', () => {
    const { trades, valuesByFieldAndTrade } = generateNoEffectUser(4);
    valuesByFieldAndTrade.set('drv.session', valuesByFieldAndTrade.get('setup')!);
    const fields: EdgeEngineField[] = [{ fieldId: 'drv.session', dataType: 'pick_one' }];
    const results = computeEdgeFindingsForStrategy(trades, fields, valuesByFieldAndTrade);
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => expect(r.analyticId).toBe('find.session'));
  });

  it('detects a real, engineered large win-rate effect in one segment end-to-end', () => {
    const { trades, valuesByFieldAndTrade } = generateNoEffectUser(5, 200);
    // Overwrite outcomes so option 'a' genuinely wins ~85% vs a baseline
    // that wins ~50%. Was engineered to 75% pre-fix (2026-09-09
    // Sidak/Bonferroni correction on the per-segment min-p-value combine,
    // see `gates.ts`'s `computeRawPValue`) which landed exactly on the
    // wrong side of significance after Holm-correcting across this
    // fixture's 9-segment family (pAdjusted=0.0523, just above alpha=0.05)
    // — a genuine, understood consequence of the fix (the raw p-value used
    // to be systematically too optimistic and no longer is), not a
    // regression to paper over. Bumped to 85% so this test asserts what it
    // says it does — "a real, decisively detectable effect is found" — with
    // headroom (pAdjusted ~= 0.0001 at 85%) rather than sitting on the
    // corrected significance boundary.
    const setupValues = valuesByFieldAndTrade.get('setup')!;
    const engineeredRand = mulberry32(999);
    const engineeredTrades = trades.map((t) => {
      if (setupValues.get(t.id) === 'a') {
        return { ...t, outcome: (engineeredRand() < 0.85 ? 'win' : 'loss') as 'win' | 'loss' };
      }
      return t;
    });
    const results = computeEdgeFindingsForStrategy(engineeredTrades, SYNTHETIC_FIELDS, valuesByFieldAndTrade);
    const optionA = results.find((r) => r.fieldId === 'setup' && r.segment.op === 'eq' && r.segment.value === 'a');
    expect(optionA).toBeDefined();
    expect(['confident', 'provisional']).toContain(optionA!.confidence);
  });
});

describe('computeEdgeFindingsForStrategy — §7.1 false-positive rate across 1,000 synthetic no-effect users', () => {
  it('the family-wise false-positive rate approaches (does not wildly exceed) the nominal alpha', () => {
    const USER_COUNT = 1000;
    const NOMINAL_ALPHA = 0.05;
    let usersWithAtLeastOneFalsePositive = 0;
    let totalSegmentsEvaluated = 0;
    let totalFalsePositiveSegments = 0;

    for (let userSeed = 1; userSeed <= USER_COUNT; userSeed++) {
      const { trades, valuesByFieldAndTrade } = generateNoEffectUser(userSeed * 7919 + 13); // arbitrary distinct seed stream
      const results = computeEdgeFindingsForStrategy(trades, SYNTHETIC_FIELDS, valuesByFieldAndTrade);
      totalSegmentsEvaluated += results.length;
      const falsePositivesForUser = results.filter((r) => r.confidence === 'confident' || r.confidence === 'provisional');
      totalFalsePositiveSegments += falsePositivesForUser.length;
      if (falsePositivesForUser.length > 0) usersWithAtLeastOneFalsePositive += 1;
    }

    const familyWiseFalsePositiveRate = usersWithAtLeastOneFalsePositive / USER_COUNT;
    const perSegmentFalsePositiveRate = totalFalsePositiveSegments / totalSegmentsEvaluated;

    // Reported so the actual measured numbers are visible in test output,
    // not just the pass/fail — required by this slice's own dispatch.
    console.log(
      `[edge-engine false-positive-rate test] users=${USER_COUNT} ` +
        `familyWiseFalsePositiveRate=${familyWiseFalsePositiveRate.toFixed(4)} ` +
        `perSegmentFalsePositiveRate=${perSegmentFalsePositiveRate.toFixed(4)} ` +
        `(nominal alpha=${NOMINAL_ALPHA}, totalSegmentsEvaluated=${totalSegmentsEvaluated})`,
    );

    // CORRECTED 2026-09-09 (was previously reported as ~0.079, "asymptotic
    // test calibration," and bounded at 2x nominal to force a pass — that
    // explanation was WRONG and has been retracted; see
    // `docs/adr/0025-holm-correction-family-scoping.md`'s Consequences
    // section for the full incident writeup). Independent verification
    // (tester, pure-Python/mpmath simulation, zero shared code with this
    // repo's `stats.ts`, 6000 synthetic no-effect users) isolated the real
    // mechanism: `gates.ts`'s `computeRawPValue` fed `min(pWinRate, pAvgR)`
    // — NOT itself a valid p-value under the null, since taking the
    // smaller of two not-fully-independent draws is an implicit "best of
    // two chances" step — directly into Holm's step-down correction,
    // whose family-wise error-rate guarantee is conditioned on every
    // family member being a genuine raw p-value. Fixed by Sidak/Bonferroni-
    // adjusting that combination (`min(1, 2*min(pWinRate, pAvgR))`) BEFORE
    // it enters the Holm family — see `computeRawPValue`'s own doc comment.
    //
    // MEASURED RESULT after the fix (this exact deterministic seed
    // stream): familyWiseFalsePositiveRate ~= 0.041, perSegmentFalsePositiveRate
    // ~= 0.0052 — both now comfortably AT/UNDER nominal alpha=0.05, matching
    // the tester's own independent Python re-verification of the same fix
    // (0.0658 -> 0.0347 on their structurally different generative design).
    // Bound tightened accordingly from the old "2x nominal" placeholder to
    // a statistically justified ceiling: nominal alpha plus 3 standard
    // errors for a Bernoulli proportion at this sample size
    // (se = sqrt(0.05*0.95/1000) ~= 0.0069, so alpha + 3*se ~= 0.0707) —
    // a true rate meaningfully above nominal would need to clear this before
    // being dismissed as sampling noise, whereas the OLD 2x-nominal bound
    // (0.10) would have silently tolerated the exact defect this test
    // exists to catch.
    const familyWiseStandardError = Math.sqrt((NOMINAL_ALPHA * (1 - NOMINAL_ALPHA)) / USER_COUNT);
    const familyWiseCeiling = NOMINAL_ALPHA + 3 * familyWiseStandardError;
    expect(familyWiseFalsePositiveRate).toBeLessThanOrEqual(familyWiseCeiling);
    expect(perSegmentFalsePositiveRate).toBeLessThanOrEqual(NOMINAL_ALPHA);
  }, 30_000);
});
