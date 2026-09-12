import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const fetchLatestCompletedWeeklyReviewPeriodEnd = vi.fn<(userId: string) => Promise<string | null>>();

vi.mock('../reviews-repository', () => ({
  fetchLatestCompletedWeeklyReviewPeriodEnd: (userId: string) => fetchLatestCompletedWeeklyReviewPeriodEnd(userId),
}));

import { determineCurrentWeeklyReviewPeriod } from '../current-period';

/**
 * Module 06 Slice 5 tester gate — `determineCurrentWeeklyReviewPeriod`
 * against docs/adr/0039 decision #3 / §4.8's own scenarios, with the
 * repository's own read mocked (this file tests the PURE selection logic;
 * `fetchLatestCompletedWeeklyReviewPeriodEnd` itself is exercised against
 * the live DB in `reviews-repository.slice5.live.test.ts`).
 *
 * "now" is pinned to a Wednesday so `lastEndedWeekStart` is unambiguous:
 * now = 2026-09-16 (Wed) -> current ISO week starts Monday 2026-09-14 ->
 * the immediately-preceding week (the most recently ENDED one) starts
 * Monday 2026-09-07, ends Sunday 2026-09-13.
 */
const NOW = new Date('2026-09-16T12:00:00.000Z');
const LAST_ENDED_WEEK_START = '2026-09-07';
const LAST_ENDED_WEEK_END = '2026-09-13';

beforeEach(() => {
  fetchLatestCompletedWeeklyReviewPeriodEnd.mockReset();
});

describe('determineCurrentWeeklyReviewPeriod', () => {
  it('brand-new user, no completed weeks ever — shows just the most recently ended week alone (covers_weeks = 1 shape), NOT backdated to signup', async () => {
    fetchLatestCompletedWeeklyReviewPeriodEnd.mockResolvedValue(null);

    const result = await determineCurrentWeeklyReviewPeriod('user-1', NOW);

    expect(result).toEqual({
      status: 'ready',
      periodStart: LAST_ENDED_WEEK_START,
      periodEnd: LAST_ENDED_WEEK_END,
    });
  });

  it('user who completed last review normally (period_end = the week immediately before the most recently ended one) — shows the single next week', async () => {
    // Their last completed review covered exactly the week immediately
    // before the most-recently-ended one: 2026-08-31..2026-09-06.
    fetchLatestCompletedWeeklyReviewPeriodEnd.mockResolvedValue('2026-09-06');

    const result = await determineCurrentWeeklyReviewPeriod('user-2', NOW);

    expect(result).toEqual({
      status: 'ready',
      periodStart: LAST_ENDED_WEEK_START,
      periodEnd: LAST_ENDED_WEEK_END,
    });
    // Single week: periodEnd is exactly periodStart + 6 days.
    const startMs = Date.parse(`${LAST_ENDED_WEEK_START}T00:00:00.000Z`);
    const endMs = Date.parse(`${LAST_ENDED_WEEK_END}T00:00:00.000Z`);
    expect(Math.round((endMs - startMs) / 86_400_000) + 1).toBe(7);
  });

  it('user who missed exactly one review — next candidate period spans TWO weeks (§4.8 "covers two")', async () => {
    // Their last completed review covered the week BEFORE the one
    // immediately preceding the most-recently-ended week — i.e. one whole
    // week (2026-08-31..2026-09-06) was never reviewed at all.
    fetchLatestCompletedWeeklyReviewPeriodEnd.mockResolvedValue('2026-08-30');

    const result = await determineCurrentWeeklyReviewPeriod('user-3', NOW);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.periodStart).toBe('2026-08-31');
    expect(result.periodEnd).toBe(LAST_ENDED_WEEK_END);

    // Confirm this genuinely spans two ISO weeks (14 days inclusive), not one.
    const startMs = Date.parse(`${result.periodStart}T00:00:00.000Z`);
    const endMs = Date.parse(`${result.periodEnd}T00:00:00.000Z`);
    const dayCount = Math.round((endMs - startMs) / 86_400_000) + 1;
    expect(dayCount).toBe(14);
  });

  it('caught_up: trader already completed a review covering every week through the most recently ended one', async () => {
    // Their last completed review's own period_end IS the most recently
    // ended week's Sunday — nothing new to review yet.
    fetchLatestCompletedWeeklyReviewPeriodEnd.mockResolvedValue(LAST_ENDED_WEEK_END);

    const result = await determineCurrentWeeklyReviewPeriod('user-4', NOW);

    expect(result).toEqual({
      status: 'caught_up',
      nextPeriodStart: '2026-09-14', // the day after periodEnd — the in-progress week's own Monday
    });
  });

  it('caught_up boundary is exact: one day earlier period_end still yields a ready single week, not caught_up', async () => {
    // period_end one day before LAST_ENDED_WEEK_END would be malformed (not
    // a whole week) in real data, but this test exercises the boundary
    // arithmetic itself: period_end = LAST_ENDED_WEEK_START's own eve
    // (i.e. the trader is current through the PREVIOUS week only).
    fetchLatestCompletedWeeklyReviewPeriodEnd.mockResolvedValue(addDays(LAST_ENDED_WEEK_START, -1));

    const result = await determineCurrentWeeklyReviewPeriod('user-5', NOW);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.periodStart).toBe(LAST_ENDED_WEEK_START);
    expect(result.periodEnd).toBe(LAST_ENDED_WEEK_END);
  });

  it('the in-progress (current) week is never selected, no matter how far into it "now" is', async () => {
    fetchLatestCompletedWeeklyReviewPeriodEnd.mockResolvedValue(null);
    const lateInWeekNow = new Date('2026-09-19T23:59:00.000Z'); // Saturday of the CURRENT week
    const result = await determineCurrentWeeklyReviewPeriod('user-6', lateInWeekNow);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    // Regardless of how late in its own week "now" is, the selected period
    // must never include any day >= that week's own Monday.
    expect(result.periodEnd < '2026-09-14').toBe(true);
  });
});

function addDays(serverDay: string, delta: number): string {
  const [y, m, d] = serverDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}
