import { describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { computeWeekdayCanaryRenderRate, WEEKDAY_CANARY_RENDER_RATE_TARGET } from '../render-rate';

function row(userId: string, wouldRender: boolean, computedAt: string) {
  return { user_id: userId, would_render: wouldRender, computed_at: computedAt };
}

describe('computeWeekdayCanaryRenderRate', () => {
  it('reports null (not a fabricated 0) and exceedsTarget=false when there is no data at all', () => {
    const rate = computeWeekdayCanaryRenderRate([]);
    expect(rate.usersEvaluated).toBe(0);
    expect(rate.usersWhoWouldRender).toBe(0);
    expect(rate.renderRate).toBeNull();
    expect(rate.exceedsTarget).toBe(false);
    expect(rate.analyticId).toBe('spec.weekday');
  });

  it('computes the straightforward rate across distinct users, one row each', () => {
    const users = Array.from({ length: 20 }, () => uuidv7());
    const rows = users.map((u, i) => row(u, i < 1, '2026-09-01T00:00:00.000Z')); // 1 of 20 renders = 5%
    const rate = computeWeekdayCanaryRenderRate(rows);

    expect(rate.usersEvaluated).toBe(20);
    expect(rate.usersWhoWouldRender).toBe(1);
    expect(rate.renderRate).toBeCloseTo(0.05, 10);
    expect(rate.exceedsTarget).toBe(true); // >= target counts as exceeding, per this file's own header
  });

  it('exceedsTarget is false comfortably under the 5% target', () => {
    const users = Array.from({ length: 100 }, () => uuidv7());
    const rows = users.map((u, i) => row(u, i < 2, '2026-09-01T00:00:00.000Z')); // 2%
    const rate = computeWeekdayCanaryRenderRate(rows);
    expect(rate.renderRate).toBeCloseTo(0.02, 10);
    expect(rate.exceedsTarget).toBe(false);
  });

  it('dedupes to the MOST RECENT row per user — a stale would_render=true does not count if a later run corrected it', () => {
    const user = uuidv7();
    const rows = [
      row(user, true, '2026-09-01T00:00:00.000Z'), // stale — an earlier run that DID render
      row(user, false, '2026-09-05T00:00:00.000Z'), // most recent — does NOT render
    ];
    const rate = computeWeekdayCanaryRenderRate(rows);
    expect(rate.usersEvaluated).toBe(1);
    expect(rate.usersWhoWouldRender).toBe(0);
    expect(rate.renderRate).toBe(0);
  });

  it('dedupe is order-independent — the same result regardless of row arrival order', () => {
    const user = uuidv7();
    const inOrder = [row(user, true, '2026-09-01T00:00:00.000Z'), row(user, false, '2026-09-05T00:00:00.000Z')];
    const reversed = [...inOrder].reverse();
    expect(computeWeekdayCanaryRenderRate(inOrder).usersWhoWouldRender).toBe(
      computeWeekdayCanaryRenderRate(reversed).usersWhoWouldRender,
    );
  });

  it('WEEKDAY_CANARY_RENDER_RATE_TARGET matches Module 05 §8 exactly (< 5%)', () => {
    expect(WEEKDAY_CANARY_RENDER_RATE_TARGET).toBe(0.05);
  });
});
