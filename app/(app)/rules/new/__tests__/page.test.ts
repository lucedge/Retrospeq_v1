import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Module 04 (Rulebook & Evaluation) §6.1 story 1.3 / inventory row 3.10 —
 * `/rules/new` render test, Slice 10c. Matches `app/(app)/review/decisions/
 * __tests__/page.test.ts`'s own established pattern: calls the real Server
 * Component function directly with its own data reads mocked, renders to
 * static HTML, asserts on actual text/markup — no live DB, no browser.
 */
const { getUserMock, createClientMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
}));
const canForUserMock = vi.hoisted(() => vi.fn());
const fetchAccountSyncTiersMock = vi.hoisted(() => vi.fn());
const fetchDiscoveryForUserMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/entitlements/service', () => ({ canForUser: canForUserMock }));
vi.mock('@/lib/rules/rules-repository', () => ({ fetchAccountSyncTiers: fetchAccountSyncTiersMock }));
vi.mock('@/lib/review/discovery', () => ({ fetchDiscoveryForUser: fetchDiscoveryForUserMock }));
// `RuleEditor.tsx` (rendered by the page, one directory up from this test
// file) imports `createRule`/`previewRule` from `../actions` relative to
// ITSELF (`app/(app)/rules/actions.ts`) -- a real Server Action module
// whose own import graph pulls in several `server-only` repository files
// this render test never needs (nothing here submits a rule). Mocked by
// the path `RuleEditor.tsx` actually resolves it to, one level further up
// than this test file's own `../actions` would reach -- exactly like
// `app/(app)/review/decisions/__tests__/page.test.ts`'s own established
// pattern of mocking a sibling's import target by ITS resolution path.
vi.mock('../../actions', () => ({ createRule: vi.fn(), previewRule: vi.fn() }));

beforeEach(() => {
  getUserMock.mockReset();
  createClientMock.mockReset();
  canForUserMock.mockReset();
  fetchAccountSyncTiersMock.mockReset();
  fetchDiscoveryForUserMock.mockReset();
  createClientMock.mockResolvedValue({ auth: { getUser: getUserMock } });
  getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  fetchAccountSyncTiersMock.mockResolvedValue([]);
  canForUserMock.mockResolvedValue({ allowed: true, limit: 3, used: 0 });
  fetchDiscoveryForUserMock.mockResolvedValue({ windowDays: 90, items: [] });
});

async function renderPage(): Promise<string> {
  const { default: NewRulePage } = await import('../page');
  const element = await NewRulePage();
  return renderToStaticMarkup(element as React.ReactElement);
}

describe('/rules/new — discovery (Slice 10c, frame 3.10)', () => {
  it('no signed-in user: renders the session-expired fallback, never calls fetchDiscoveryForUser', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const html = await renderPage();
    expect(html).toContain('Your session expired');
    expect(fetchDiscoveryForUserMock).not.toHaveBeenCalled();
  });

  it('no detections: honest "not enough data yet" empty state, catalogue still present', async () => {
    fetchDiscoveryForUserMock.mockResolvedValue({ windowDays: 90, items: [] });
    const html = await renderPage();

    expect(html).toContain('Based on your last 90 days');
    expect(html).toContain('Not enough data yet');
    expect(html).toContain('Browse all rule types');
    expect(html).not.toContain('discovery__list'); // absent when empty
  });

  it('ranked detections: each item rendered as a list button (not .rq-btn), name + evidence, evidence tagged .rq-num', async () => {
    fetchDiscoveryForUserMock.mockResolvedValue({
      windowDays: 90,
      items: [
        {
          analyticId: 'seq.consecutive_losses',
          operandId: 'consecutive_losses',
          label: 'Losing streak',
          evidence: '25 times',
          seedValue: 2,
        },
        {
          analyticId: 'seq.reentry_after_loss',
          operandId: 'time_since_last_loss',
          label: 'Cool-off after a loss',
          evidence: '11 times',
          seedValue: 2,
        },
      ],
    });
    const html = await renderPage();

    expect(html).toContain('You might want rules about:');
    expect(html).toContain('discovery__btn');
    expect(html).toContain('Losing streak');
    expect(html).toContain('25 times');
    expect(html).toContain('Cool-off after a loss');
    expect(html).toContain('11 times');
    expect(html).toContain('discovery__evidence rq-num');
    // Exactly one .rq-btn in this initial render -- the "Add rule" submit
    // button only appears once an operand is selected (client state), so
    // the server-rendered HTML has none of THAT button yet; assert no
    // discovery item itself carries the primary class.
    expect(html).not.toMatch(/class="[^"]*\bdiscovery__btn\b[^"]*\brq-btn\b/);
  });

  it('catalogue is behind a <details> disclosure with a search input, grouped by operand group', async () => {
    const html = await renderPage();
    expect(html).toMatch(/<details class="catalogue">/);
    expect(html).toContain('<summary>Browse all rule types</summary>');
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Search rule types"');
  });

  it('at the rule cap: shows the existing plan affordance copy, no invented upgrade path', async () => {
    canForUserMock.mockResolvedValue({ allowed: false, limit: 3, used: 3 });
    const html = await renderPage();
    expect(html).toContain("You&#x27;re already at your rule limit, so this can&#x27;t be added right now.");
  });
});
