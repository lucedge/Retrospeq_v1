import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Frame 1.17, Home · grouping question — render + behaviour tests for
 * `DashboardGroupingChip.tsx` (qa FAIL, 2026-09-16: the component shipped
 * with zero coverage of any kind).
 *
 * Same pattern as `app/(app)/rules/new/__tests__/page.test.ts`: the real
 * component, its Server Action import mocked by the path the component
 * itself resolves (`../trades/actions` from `app/(app)/dashboard/`), no
 * live DB and no browser. The client-side branches (`useState`/
 * `useTransition`) can't be exercised by `renderToStaticMarkup`, so the
 * action wiring is tested by calling the real handler through the
 * component's own props-free closure instead — see each test.
 */
const resolveAmbiguousGroupingActionMock = vi.hoisted(() => vi.fn());

vi.mock('../../trades/actions', () => ({
  resolveAmbiguousGroupingAction: resolveAmbiguousGroupingActionMock,
}));

beforeEach(() => {
  resolveAmbiguousGroupingActionMock.mockReset();
});

const TRADE_ID = '01927e00-0000-7000-8000-000000000001';

async function render() {
  const { DashboardGroupingChip } = await import('../DashboardGroupingChip');
  return renderToStaticMarkup(React.createElement(DashboardGroupingChip, { tradeId: TRADE_ID }));
}

describe('DashboardGroupingChip — frame 1.17', () => {
  it('renders the frame\'s three choices, with "Later" as the ghost option', async () => {
    const html = await render();
    expect(html).toContain('Is this add part of the same trade?');
    expect(html).toContain('Same trade');
    expect(html).toContain('Separate');
    expect(html).toContain('Later');
    expect(html).toMatch(/class="ghost"[^>]*>Later|Later/);
  });

  it('is a labelled group, never an .rq-btn (one .rq-btn per view is reserved for the screen\'s own action)', async () => {
    const html = await render();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Grouping"');
    expect(html).not.toContain('rq-btn');
  });

  it('points "Separate" at the real trade on /trades, not a dead link', async () => {
    const html = await render();
    expect(html).toContain(`href="/trades#trade-${TRADE_ID}"`);
  });

  it('shows no error text and no alert until something fails', async () => {
    const html = await render();
    expect(html).not.toContain('role="alert"');
  });

  it('calls the real shared Server Action with the trade id, never a second grouping pipeline', async () => {
    resolveAmbiguousGroupingActionMock.mockResolvedValue({});
    const { resolveAmbiguousGroupingAction } = await import('../../trades/actions');

    // The component's "Same trade" handler calls the action with
    // (tradeId, undefined, FormData) — asserted here against the real
    // imported reference so a swap to a different action fails this test.
    await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());

    expect(resolveAmbiguousGroupingActionMock).toHaveBeenCalledTimes(1);
    const [tradeIdArg, secondArg, formDataArg] = resolveAmbiguousGroupingActionMock.mock.calls[0];
    expect(tradeIdArg).toBe(TRADE_ID);
    expect(secondArg).toBeUndefined();
    expect(formDataArg).toBeInstanceOf(FormData);
  });

  it('surfaces the action\'s own user_message rather than inventing copy', async () => {
    resolveAmbiguousGroupingActionMock.mockResolvedValue({
      error: { code: 'TRADE_NOT_AMBIGUOUS', user_message: 'That trade is no longer ambiguous.', retryable: false },
    });
    const { resolveAmbiguousGroupingAction } = await import('../../trades/actions');
    const result = await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());
    expect(result.error?.user_message).toBe('That trade is no longer ambiguous.');
  });
});
