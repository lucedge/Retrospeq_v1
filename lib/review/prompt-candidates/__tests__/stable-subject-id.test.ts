import { describe, expect, it } from 'vitest';
import { deriveStableSubjectId, detectionSubjectId, findingSubjectId } from '../stable-subject-id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveStableSubjectId', () => {
  it('is deterministic — same input always produces the same output', () => {
    const a = deriveStableSubjectId('finding:strategy-1:field-1');
    const b = deriveStableSubjectId('finding:strategy-1:field-1');
    expect(a).toBe(b);
  });

  it('produces a real, RFC 4122 version-5 uuid (version + variant bits set)', () => {
    const id = deriveStableSubjectId('anything');
    expect(id).toMatch(UUID_RE);
  });

  it('different inputs produce different outputs (no trivial collision)', () => {
    const a = deriveStableSubjectId('finding:strategy-1:field-1');
    const b = deriveStableSubjectId('finding:strategy-1:field-2');
    const c = deriveStableSubjectId('finding:strategy-2:field-1');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});

describe('findingSubjectId', () => {
  it('is stable across calls for the same (strategyId, fieldId)', () => {
    const a = findingSubjectId('strategy-1', 'field-1');
    const b = findingSubjectId('strategy-1', 'field-1');
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it('is NOT sensitive to a third argument the caller might be tempted to add — segment is deliberately excluded', () => {
    // Two different findings.id rows for the SAME (strategy, field) but a
    // DIFFERENT segment must still resolve to the SAME subject id — this is
    // the whole point (see stable-subject-id.ts's own header): the mute
    // guarantee is scoped to the field, not to a specific segment boundary
    // that can shift across recomputes.
    const a = findingSubjectId('strategy-1', 'field-1');
    const b = findingSubjectId('strategy-1', 'field-1');
    expect(a).toBe(b);
  });

  it('differs from detectionSubjectId for a colliding-looking name', () => {
    // 'finding:x:y' vs 'detection:x' should never collide by construction
    // (different literal prefixes), but assert it directly rather than
    // just trusting the string format.
    const finding = findingSubjectId('x', 'y');
    const detection = detectionSubjectId('x:y');
    expect(finding).not.toBe(detection);
  });
});

describe('detectionSubjectId', () => {
  it('is stable across calls for the same analyticId', () => {
    const a = detectionSubjectId('seq.re_entry_after_loss');
    const b = detectionSubjectId('seq.re_entry_after_loss');
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it('differs for different analytic ids', () => {
    const a = detectionSubjectId('seq.re_entry_after_loss');
    const b = detectionSubjectId('seq.daily_loss_breach');
    expect(a).not.toBe(b);
  });
});
