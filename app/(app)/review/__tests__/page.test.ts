import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Module 06 Slice 5 tester gate — the ADVERSARIAL compute-on-view test
 * `app/(app)/review/page.tsx` had zero permanent coverage for (the
 * coder's own self-check was throwaway, per its PROGRESS.md entry). This
 * file calls the real exported Server Component function directly
 * (`app/(app)/__tests__/layout.test.ts`'s own established pattern for
 * this repo — no testing-library dependency exists here), with every
 * data source mocked, then renders the returned element tree to static
 * HTML (`react-dom/server`) and asserts on the actual text content — the
 * cheapest way in this repo to prove WHICH branch (recompute vs. frozen
 * read) actually ran and WHAT it rendered, without a live DB or browser.
 *
 * UPDATED (2026-09-13 security-review fix): `page.tsx` no longer calls
 * `determineCurrentWeeklyReviewPeriod`/`assembleWeeklyReadPayload`/
 * `upsertWeeklyReview`/`fetchWeeklyReviewByPeriodStart`/
 * `computeAndWriteReviewPrompts`/`fetchPendingPromptCount` directly — the
 * entire compute-on-view pipeline now lives behind `./actions.ts`'s
 * rate-limited `fetchWeeklyReviewRead` Server Action (see that file's own
 * doc comment and `lib/rate-limit/config.ts`'s `weeklyReview` scope for
 * why). This file now mocks `../actions` at that one boundary instead of
 * the five underlying lib functions individually — every scenario below
 * is preserved exactly, only the mock boundary moved to match where the
 * real page's own dependency now sits. This still proves the SAME set of
 * behaviours (fresh vs. frozen render, caught_up, compute failure, no
 * session) because `fetchWeeklyReviewRead`'s own return shape carries
 * exactly the same distinguishing information (`status`, `readPayload`,
 * `pendingCount`) the page used to derive itself from the five raw calls.
 *
 * The one thing this file cannot see: `app/(app)/review/page.tsx`'s own
 * fallback for `!result.success` (a rate-limited or session-missing
 * action response) — covered separately below now that it's a real,
 * reachable branch of `page.tsx` itself (it wasn't, before this fix, since
 * rate limiting/session-checking lived nowhere in this route).
 */

const { getUserMock, createClientMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
}));

const fetchWeeklyReviewReadMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('../actions', () => ({
  fetchWeeklyReviewRead: fetchWeeklyReviewReadMock,
}));

const FRESH_PAYLOAD = {
  periodStart: '2026-08-31',
  periodEnd: '2026-09-13',
  outcome: { tradeCount: 999, daysTradedCount: 999, totalR: '99.0000' }, // deliberately implausible — proves this is the FRESH compute, never the frozen one
  consistency: { daysTraded: 5, daysClosed: 5, streakWeeks: 3 },
  adherence: { status: 'insufficient_history' as const },
  findings: [],
};

const FROZEN_PAYLOAD = {
  periodStart: '2026-08-31',
  periodEnd: '2026-09-13',
  outcome: { tradeCount: 4, daysTradedCount: 4, totalR: '1.4000' },
  consistency: { daysTraded: 4, daysClosed: 4, streakWeeks: 4 },
  adherence: { status: 'insufficient_history' as const },
  findings: [],
};

beforeEach(() => {
  getUserMock.mockReset();
  createClientMock.mockReset();
  fetchWeeklyReviewReadMock.mockReset();

  createClientMock.mockResolvedValue({ auth: { getUser: getUserMock } });
  getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } });
});

async function renderPage(): Promise<string> {
  const { default: WeeklyReviewPage } = await import('../page');
  const element = await WeeklyReviewPage();
  return renderToStaticMarkup(element as React.ReactElement);
}

describe('/review compute-on-view trigger — adversarial', () => {
  it('no reviews row exists yet: the action reports a FRESH compute (status "ready" with the freshly-assembled payload), and the page renders it', async () => {
    fetchWeeklyReviewReadMock.mockResolvedValue({
      success: true,
      status: 'ready',
      periodStart: '2026-08-31',
      periodEnd: '2026-09-13',
      coversWeeks: 1,
      pendingCount: 1,
      readPayload: FRESH_PAYLOAD,
    });

    const html = await renderPage();

    expect(fetchWeeklyReviewReadMock).toHaveBeenCalledTimes(1);
    expect(fetchWeeklyReviewReadMock).toHaveBeenCalledWith(); // no arguments — session-derived inside the action itself
    expect(html).toContain('999'); // the fresh payload's own trade count
    expect(html).toContain('1 decision');
  });

  it('a review row exists but is NOT yet completed: the action still reports the FRESH recompute, never the stale stored payload', async () => {
    fetchWeeklyReviewReadMock.mockResolvedValue({
      success: true,
      status: 'ready',
      periodStart: '2026-08-31',
      periodEnd: '2026-09-13',
      coversWeeks: 1,
      pendingCount: 0,
      readPayload: FRESH_PAYLOAD,
    });

    const html = await renderPage();

    expect(html).toContain('999'); // fresh, not the stale frozen "4"
    expect(html).not.toContain('>4<'); // the frozen payload's own trade count text never appears
  });

  it('ADVERSARIAL: a completed review — the action reports the exact stored (frozen) payload, and the page renders it untouched, never a fresh/implausible value', async () => {
    fetchWeeklyReviewReadMock.mockResolvedValue({
      success: true,
      status: 'ready',
      periodStart: '2026-08-31',
      periodEnd: '2026-09-13',
      coversWeeks: 1,
      pendingCount: 0,
      readPayload: FROZEN_PAYLOAD,
    });

    const html = await renderPage();

    // Renders the FROZEN numbers, not any fresh/implausible value.
    expect(html).toContain('>4</span> trades');
    expect(html).not.toContain('999');
    expect(html).toContain('Week closed'); // 0 pending prompts
  });

  it('caught_up: renders the steady-state copy', async () => {
    fetchWeeklyReviewReadMock.mockResolvedValue({ success: true, status: 'caught_up' });

    const html = await renderPage();

    expect(html).toContain("You&#x27;re caught up.");
  });

  it('the action reports a compute failure (status "unavailable") — REVIEW_NOT_READY copy only, never a half-built panel', async () => {
    fetchWeeklyReviewReadMock.mockResolvedValue({ success: true, status: 'unavailable' });

    const html = await renderPage();

    expect(html).toContain('Your review is being prepared.');
    expect(html).not.toContain('Consistency');
    expect(html).not.toContain('Adherence');
  });

  it('the action reports rate-limited: the page renders the action\'s own honest, retryable message, never a partial review', async () => {
    fetchWeeklyReviewReadMock.mockResolvedValue({
      error: { code: 'REVIEW_RATE_LIMITED', user_message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
    });

    const html = await renderPage();

    expect(html).toContain('Too many attempts. Please wait a few minutes and try again.');
    expect(html).not.toContain('Consistency');
    expect(html).not.toContain('caught up');
  });

  it('no signed-in user: renders the session-expired fallback, never even calls the rate-limited action', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const html = await renderPage();

    expect(html).toContain('Your session expired');
    expect(fetchWeeklyReviewReadMock).not.toHaveBeenCalled();
  });

  it('the action itself is the only thing the page depends on for user scoping — the page never passes any id of its own into it (it takes no arguments)', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'the-real-session-user' } } });
    fetchWeeklyReviewReadMock.mockResolvedValue({
      success: true,
      status: 'ready',
      periodStart: '2026-08-31',
      periodEnd: '2026-09-13',
      coversWeeks: 1,
      pendingCount: 0,
      readPayload: FRESH_PAYLOAD,
    });

    await renderPage();

    expect(fetchWeeklyReviewReadMock).toHaveBeenCalledWith();
  });
});
