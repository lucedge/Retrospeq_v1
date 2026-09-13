import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Module 06 (Review & Graduation) Slice 6 — `retrospeq-tester` gate,
 * 2026-09-13. Matches `app/(app)/review/__tests__/page.test.ts`'s own
 * established pattern (Slice 5): calls the real Server Component function
 * directly with `fetchNextGraduationDecision` mocked, renders to static
 * HTML, asserts on actual text content — the cheapest way in this repo to
 * prove which branch rendered without a live DB or browser.
 */
const { getUserMock, createClientMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
}));
const fetchNextGraduationDecisionMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('../actions', () => ({ fetchNextGraduationDecision: fetchNextGraduationDecisionMock }));

beforeEach(() => {
  getUserMock.mockReset();
  createClientMock.mockReset();
  fetchNextGraduationDecisionMock.mockReset();
  createClientMock.mockResolvedValue({ auth: { getUser: getUserMock } });
  getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } });
});

async function renderPage(): Promise<string> {
  const { default: ReviewDecisionsPage } = await import('../page');
  const element = await ReviewDecisionsPage();
  return renderToStaticMarkup(element as React.ReactElement);
}

describe('/review/decisions — Part 2, GRADUATION ONLY', () => {
  it('no signed-in user: renders the session-expired fallback, never calls fetchNextGraduationDecision', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const html = await renderPage();
    expect(html).toContain('Your session expired');
    expect(fetchNextGraduationDecisionMock).not.toHaveBeenCalled();
  });

  it('plan_required: Pro-upsell copy, a single ghost button, never the decision content', async () => {
    fetchNextGraduationDecisionMock.mockResolvedValue({ success: true, status: 'plan_required' });
    const html = await renderPage();
    expect(html).toContain('Turning a finding into a rule is a Pro feature.');
    expect(html).toContain('rq-btn--ghost');
    expect(html).not.toContain('rq-btn"'); // no un-suffixed primary button in this branch
    expect(html).not.toContain('Add the rule');
  });

  it('no_review: honest "open your review first" copy with a link back, never a decision', async () => {
    fetchNextGraduationDecisionMock.mockResolvedValue({ success: true, status: 'no_review' });
    const html = await renderPage();
    expect(html).toContain('Open your weekly review first.');
    expect(html).not.toContain('Add the rule');
  });

  it('none_pending: the normal-case "nothing to decide" copy, per §4.3 ("most weeks should have zero prompts")', async () => {
    fetchNextGraduationDecisionMock.mockResolvedValue({ success: true, status: 'none_pending' });
    const html = await renderPage();
    expect(html).toContain('Nothing to decide right now.');
    expect(html).toContain('Most weeks have none');
  });

  it('a rate-limited/error response renders the honest retryable message, never a partial decision screen', async () => {
    fetchNextGraduationDecisionMock.mockResolvedValue({
      error: { code: 'REVIEW_DECISION_RATE_LIMITED', user_message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
    });
    const html = await renderPage();
    expect(html).toContain('Too many attempts. Please wait a few minutes and try again.');
    expect(html).not.toContain('Add the rule');
  });

  it('ready + canAccept: renders exactly one primary .rq-btn ("Add the rule") and one .rq-btn--ghost ("Not yet"), never .rq-btn--equal', async () => {
    fetchNextGraduationDecisionMock.mockResolvedValue({
      success: true,
      status: 'ready',
      index: 1,
      total: 1,
      detail: {
        promptId: '11111111-1111-4111-8111-111111111111',
        rank: 1,
        fieldName: 'Risk %',
        statement: 'Trades with a tighter risk cap won more often.',
        meta: 'Based on 40 trades. Last updated 1 September.',
        costLine: 'You will stop collecting data on Risk % outside "up to 1.0", so that breakdown stops changing.',
        hint: 'Starts soft. Promotes to hard after sustained compliance.',
        canAccept: true,
        blockedReason: null,
      },
    });
    const html = await renderPage();

    expect(html).toContain('Decision');
    expect(html).toContain('Add the rule');
    expect(html).toContain('Not yet');
    expect(html).not.toContain('rq-btn--equal');
    expect((html.match(/class="rq-btn"/g) ?? []).length).toBe(1); // exactly one primary
    expect(html).toContain('rq-cost'); // §4.6's explore/exploit cost, in the shipped .rq-cost component
    expect(html).toContain('rq-num'); // Decision N of M is tabular-numeral
  });

  it('ready + canAccept false: the honest blocked reason replaces the Accept button, Defer stays available, no primary button at all', async () => {
    fetchNextGraduationDecisionMock.mockResolvedValue({
      success: true,
      status: 'ready',
      index: 1,
      total: 1,
      detail: {
        promptId: '11111111-1111-4111-8111-111111111111',
        rank: 1,
        fieldName: 'Conviction',
        statement: 'Trades with conviction 4-5 won more often.',
        meta: 'Based on 14 trades. Last updated 1 September.',
        costLine: 'You will stop collecting data on Conviction outside "4-5", so that breakdown stops changing.',
        hint: 'Starts soft. Promotes to hard after sustained compliance.',
        canAccept: false,
        blockedReason: "This kind of finding can't become a rule yet.",
      },
    });
    const html = await renderPage();

    expect(html).toContain('This kind of finding can');
    expect(html).toContain('t become a rule yet.');
    expect(html).not.toContain('Add the rule');
    expect(html).toContain('Not yet');
    expect((html.match(/class="rq-btn"/g) ?? []).length).toBe(0); // no primary button when nothing can be accepted
  });
});
