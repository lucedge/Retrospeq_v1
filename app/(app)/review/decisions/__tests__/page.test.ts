import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Module 06 (Review & Graduation) Slice 6 (graduation) + Slice 7
 * (relaxation) — `retrospeq-tester` gate coverage. Matches
 * `app/(app)/review/__tests__/page.test.ts`'s own established pattern
 * (Slice 5): calls the real Server Component function directly with
 * `fetchNextDecision` mocked, renders to static HTML, asserts on actual
 * text content — the cheapest way in this repo to prove which branch
 * rendered without a live DB or browser.
 */
const { getUserMock, createClientMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
}));
const fetchNextDecisionMock = vi.hoisted(() => vi.fn());
const fetchDeferredBacklogMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('../actions', () => ({ fetchNextDecision: fetchNextDecisionMock, fetchDeferredBacklog: fetchDeferredBacklogMock }));

beforeEach(() => {
  getUserMock.mockReset();
  createClientMock.mockReset();
  fetchNextDecisionMock.mockReset();
  fetchDeferredBacklogMock.mockReset();
  createClientMock.mockResolvedValue({ auth: { getUser: getUserMock } });
  getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  // Only the `none_pending` branch calls this — an empty backlog is the
  // default for every other test, matching the normal, common case.
  fetchDeferredBacklogMock.mockResolvedValue({ success: true, items: [] });
});

async function renderPage(): Promise<string> {
  const { default: ReviewDecisionsPage } = await import('../page');
  const element = await ReviewDecisionsPage();
  return renderToStaticMarkup(element as React.ReactElement);
}

describe('/review/decisions — Part 2, graduation + relaxation', () => {
  it('no signed-in user: renders the session-expired fallback, never calls fetchNextDecision', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const html = await renderPage();
    expect(html).toContain('Your session expired');
    expect(fetchNextDecisionMock).not.toHaveBeenCalled();
  });

  it('plan_required: Pro-upsell copy, a single ghost button, never the decision content', async () => {
    fetchNextDecisionMock.mockResolvedValue({ success: true, status: 'plan_required' });
    const html = await renderPage();
    expect(html).toContain('Turning a finding into a rule is a Pro feature.');
    expect(html).toContain('rq-btn--ghost');
    expect(html).not.toContain('rq-btn"'); // no un-suffixed primary button in this branch
    expect(html).not.toContain('Add the rule');
  });

  it('no_review: honest "open your review first" copy with a link back, never a decision', async () => {
    fetchNextDecisionMock.mockResolvedValue({ success: true, status: 'no_review' });
    const html = await renderPage();
    expect(html).toContain('Open your weekly review first.');
    expect(html).not.toContain('Add the rule');
  });

  it('none_pending, empty backlog: the normal-case "nothing to decide" copy, per §4.3 ("most weeks should have zero prompts")', async () => {
    fetchNextDecisionMock.mockResolvedValue({ success: true, status: 'none_pending' });
    const html = await renderPage();
    expect(html).toContain('Nothing to decide right now.');
    expect(html).toContain('Most weeks have none');
    expect(html).not.toContain('backlog');
  });

  it('none_pending, non-empty backlog: frame 4.11 — "Not yet, from earlier weeks", the deferred list, one ghost button, no decision buttons', async () => {
    fetchNextDecisionMock.mockResolvedValue({ success: true, status: 'none_pending' });
    fetchDeferredBacklogMock.mockResolvedValue({
      success: true,
      items: [
        { id: 'p1', subjectSentence: 'Make conviction a rule?', ageLabel: '2 wk ago' },
        { id: 'p2', subjectSentence: 'Make "stop after 3 losses" hard?', ageLabel: '3 wk ago' },
      ],
    });
    const html = await renderPage();

    expect(html).toContain('Not yet, from earlier weeks');
    expect(html).toContain('Deferred decisions wait here. Anything older than four weeks expires quietly.');
    expect(html).toContain('Make conviction a rule?');
    expect(html).toContain('2 wk ago');
    expect(html).toContain('Make &quot;stop after 3 losses&quot; hard?');
    expect(html).toContain('3 wk ago');
    expect(html).toContain('Back to this week');
    expect(html).not.toContain('Nothing to decide right now.');
    // Read-only — no accept/decline/defer affordance anywhere on this screen.
    expect((html.match(/class="rq-btn[^"]*"/g) ?? []).length).toBe(1);
    expect(html).toContain('rq-btn--ghost');
  });

  it('a rate-limited/error response renders the honest retryable message, never a partial decision screen', async () => {
    fetchNextDecisionMock.mockResolvedValue({
      error: { code: 'REVIEW_DECISION_RATE_LIMITED', user_message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
    });
    const html = await renderPage();
    expect(html).toContain('Too many attempts. Please wait a few minutes and try again.');
    expect(html).not.toContain('Add the rule');
  });

  it('ready (graduation) + canAccept: renders exactly one primary .rq-btn ("Add the rule") and one .rq-btn--ghost ("Not yet"), never .rq-btn--equal', async () => {
    fetchNextDecisionMock.mockResolvedValue({
      success: true,
      status: 'ready',
      kind: 'graduation',
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
    // frame 4.6's own literal markup: both buttons are `--block` (full-width,
    // stacked); still exactly one PRIMARY (no `--ghost`) among them.
    expect((html.match(/class="rq-btn rq-btn--block"/g) ?? []).length).toBe(1);
    expect((html.match(/class="rq-btn rq-btn--ghost rq-btn--block"/g) ?? []).length).toBe(1);
    expect(html).toContain('rq-cost'); // §4.6's explore/exploit cost, in the shipped .rq-cost component
    expect(html).toContain('rq-num'); // Decision N of M is tabular-numeral
  });

  it('ready (graduation) + canAccept false: the honest blocked reason replaces the Accept button, Defer stays available, no primary button at all', async () => {
    fetchNextDecisionMock.mockResolvedValue({
      success: true,
      status: 'ready',
      kind: 'graduation',
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

  it('ready (relaxation): renders TWO .rq-btn--equal buttons ("Keep"/"Change to"), never a primary/ghost pair, never a third button', async () => {
    fetchNextDecisionMock.mockResolvedValue({
      success: true,
      status: 'ready',
      kind: 'relaxation',
      index: 1,
      total: 1,
      detail: {
        promptId: '22222222-2222-4222-8222-222222222222',
        rank: 1,
        statement: 'You have set risk per trade to 1% and traded a median of 2% over the last six weeks.',
        meta: '15 of 30 applicable trades exceeded it.',
        decisionFrame: 'A rule you break most weeks stops meaning anything. Recommit to it, or move it to where you actually trade.',
        canDecide: true,
        blockedReason: null,
        currentLabel: '1%',
        newLabel: '2%',
      },
    });
    const html = await renderPage();

    expect(html).toContain('Which one is true?');
    expect(html).toContain('Keep 1%');
    expect(html).toContain('Change to 2%');
    expect((html.match(/rq-btn--equal/g) ?? []).length).toBe(2); // exactly two, one per choice
    expect(html).not.toContain('rq-btn--ghost'); // no defer/ghost option on this screen
    expect(html).toContain('A rule you break most weeks stops meaning anything');
  });

  it('ready (relaxation) + canDecide false (defensive-only race): the honest blocked reason with a link back, never the equal-choice pair', async () => {
    fetchNextDecisionMock.mockResolvedValue({
      success: true,
      status: 'ready',
      kind: 'relaxation',
      index: 1,
      total: 1,
      detail: {
        promptId: '22222222-2222-4222-8222-222222222222',
        rank: 1,
        statement: 'This rule is no longer active.',
        meta: '',
        decisionFrame: 'A rule you break most weeks stops meaning anything. Recommit to it, or move it to where you actually trade.',
        canDecide: false,
        blockedReason: 'This rule has been retired since your review was prepared. Defer to see an updated one next review.',
        currentLabel: null,
        newLabel: null,
      },
    });
    const html = await renderPage();

    expect(html).toContain('This rule has been retired');
    expect(html).not.toContain('rq-btn--equal');
    expect(html).toContain('Back to your review');
  });

  // Frame 4.10 — Module 04's cross-trade freeze-wiring flip (2026-09-15)
  // made `seq.reentry_after_loss` genuinely resolve a real rule proposal
  // (`time_since_last_loss`, real freeze-wiring, see operand-catalogue.ts's
  // own "UPDATE" header) -- this `canAccept: true` branch was previously
  // UNREACHABLE in production (every real detection resolved `null`); no
  // coverage existed for it in this file at all before this slice. The
  // rendered sentence below is the REAL `renderSentence('time_since_last_loss',
  // 'gte', 2)` output (ceil(90s / 60) = 2 minutes,
  // `occurrence-detectors.ts`'s own REENTRY_THRESHOLD_SECONDS), not invented
  // copy -- matches `brand/docs/screens/review-performance.html#4.10`'s own
  // layout (evidence -> `.detection` block -> Add the rule / Not yet).
  it('ready (detection) + canAccept true: frame 4.10, now-reachable — one primary .rq-btn ("Add the rule"), one ghost ("Not yet"), the real proposed-rule sentence and preview line render', async () => {
    fetchNextDecisionMock.mockResolvedValue({
      success: true,
      status: 'ready',
      kind: 'detection',
      index: 2,
      total: 2,
      detail: {
        promptId: '33333333-3333-4333-8333-333333333333',
        rank: 2,
        analyticId: 'seq.reentry_after_loss',
        statement: 'You re-entered within 90 seconds of a loss 11 times.',
        outcomeLine: 'Those trades averaged -0.6R against +0.3R for the rest.',
        proposedRuleSentence: 'Wait at least 2 minutes after a loss before entering again.',
        previewCount: 11,
        previewTotal: 90,
        conceptSummary:
          'Traders often re-enter quickly after a loss to try to recover it. The pattern is common and well documented; the numbers above are your own.',
        canAccept: true,
        blockedReason: null,
      },
    });
    const html = await renderPage();

    expect(html).toContain('Make a rule from this pattern?');
    expect(html).toContain('You re-entered within 90 seconds of a loss');
    expect(html).toContain('Wait at least 2 minutes after a loss');
    expect(html).toContain('Would have applied to');
    expect(html).toContain('Add the rule');
    expect(html).toContain('Not yet');
    expect(html).not.toContain('rq-btn--equal');
    expect((html.match(/class="rq-btn"/g) ?? []).length).toBe(1); // exactly one primary
    expect(html).toContain('rq-num'); // Decision N of M, and the preview counts, are tabular-numeral
    expect(html).toContain('detection__concept'); // disclosure stays collapsed by default (a <details> element)
    expect(html).not.toContain('revenge'); // observation, never a syndrome name outside the disclosure
  });

  it('ready (detection) + canAccept false: the honest blocked reason (still today\'s real outcome for seq.trades_per_day/daily_loss_breach/risk.spread — no persisted per-user threshold), Not yet stays available, no primary button', async () => {
    fetchNextDecisionMock.mockResolvedValue({
      success: true,
      status: 'ready',
      kind: 'detection',
      index: 1,
      total: 1,
      detail: {
        promptId: '44444444-4444-4444-8444-444444444444',
        rank: 1,
        analyticId: 'seq.trades_per_day',
        statement: 'You traded well above your own typical pace on 6 days.',
        outcomeLine: null,
        proposedRuleSentence: null,
        previewCount: null,
        previewTotal: null,
        conceptSummary:
          'A day that runs far past your own usual trade count is often a sign of chasing outcomes rather than following a plan. The numbers above are your own.',
        canAccept: false,
        blockedReason: "This pattern can't become a rule yet.",
      },
    });
    const html = await renderPage();

    expect(html).toContain("This pattern can");
    expect(html).toContain("t become a rule yet.");
    expect(html).not.toContain('Add the rule');
    expect(html).toContain('Not yet');
    expect((html.match(/class="rq-btn"/g) ?? []).length).toBe(0); // no primary button when nothing can be accepted
  });
});
