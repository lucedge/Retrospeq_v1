import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  formatAdherenceFraction,
  formatAdherenceSequence,
  softRatios,
  buildSparklinePoints,
  type MonthlyAdherencePoint,
} from '../monthly-adherence';

const point = (key: string, label: string, hard: [number, number] | null, soft: [number, number] | null): MonthlyAdherencePoint => ({
  key,
  label,
  hard: hard ? { followed: hard[0], total: hard[1] } : null,
  soft: soft ? { followed: soft[0], total: soft[1] } : null,
});

describe('lib/review/monthly-adherence.ts pure formatting', () => {
  it('formatAdherenceFraction: a real fraction as numerators-as-heroes, "no data" for null, never a bare percentage', () => {
    expect(formatAdherenceFraction({ followed: 12, total: 14 })).toBe('12 of 14');
    expect(formatAdherenceFraction(null)).toBe('no data');
    expect(formatAdherenceFraction({ followed: 12, total: 14 })).not.toMatch(/%/);
  });

  it('formatAdherenceSequence joins chronologically with an arrow, per-panel label, never blends hard and soft', () => {
    const points = [point('2026-05', 'May', [34, 34], [12, 14]), point('2026-06', 'Jun', [30, 30], [15, 18]), point('2026-07', 'Jul', [28, 28], [19, 20])];
    expect(formatAdherenceSequence('Soft rules held', points, 'soft')).toBe('Soft rules held: 12 of 14 → 15 of 18 → 19 of 20.');
    expect(formatAdherenceSequence('Hard', points, 'hard')).toBe('Hard: 34 of 34 → 30 of 30 → 28 of 28.');
  });

  it('formatAdherenceSequence is honest about a month with no data', () => {
    const points = [point('2026-05', 'May', null, null), point('2026-06', 'Jun', [30, 30], [15, 18])];
    expect(formatAdherenceSequence('Soft rules held', points, 'soft')).toBe('Soft rules held: no data → 15 of 18.');
  });

  it('softRatios computes a ratio per month, null where total is 0 or missing (never a divide-by-zero NaN)', () => {
    const points = [point('a', 'A', null, [12, 14]), point('b', 'B', null, [0, 0]), point('c', 'C', null, null)];
    expect(softRatios(points)).toEqual([12 / 14, null, null]);
  });

  it('buildSparklinePoints returns null with fewer than 2 real points (never a fabricated flat line)', () => {
    expect(buildSparklinePoints([null, null, null])).toBeNull();
    expect(buildSparklinePoints([0.5, null, null])).toBeNull();
  });

  it('buildSparklinePoints plots exactly the real points, evenly spaced, higher ratio at a lower y', () => {
    const points = buildSparklinePoints([0.5, 1, 0]);
    expect(points).not.toBeNull();
    const coords = points!.split(' ').map((p) => p.split(',').map(Number));
    expect(coords).toHaveLength(3);
    // ratio 1 (index 1) must have a smaller y than ratio 0 (index 2) -- up is a lower y in SVG space.
    expect(coords[1]![1]).toBeLessThan(coords[2]![1]);
  });

  it('buildSparklinePoints leaves a gap (fewer plotted points than months) when one month is missing, never interpolated', () => {
    const points = buildSparklinePoints([0.5, null, 0.9]);
    expect(points).not.toBeNull();
    expect(points!.split(' ')).toHaveLength(2);
  });
});
