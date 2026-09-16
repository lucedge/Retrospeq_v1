import { describe, expect, it } from 'vitest';
import {
  accountsSummary,
  countAccountStatuses,
  planSummary,
  securitySummary,
} from '../summaries';

describe('countAccountStatuses', () => {
  it('counts each known status and buckets anything else', () => {
    expect(
      countAccountStatuses(['connected', 'connected', 'attention', 'syncing', 'plan_limited']),
    ).toEqual({ connected: 2, syncing: 1, attention: 1, disconnected: 0, other: 1 });
  });
});

describe('accountsSummary', () => {
  it('renders only the states the trader is actually in', () => {
    expect(
      accountsSummary({ connected: 1, syncing: 0, attention: 1, disconnected: 0, other: 0 }),
    ).toBe('1 connected · 1 needs attention');
  });

  it('agrees in number with itself', () => {
    expect(
      accountsSummary({ connected: 0, syncing: 0, attention: 3, disconnected: 0, other: 0 }),
    ).toBe('3 need attention');
  });

  it('says none rather than "0 connected" when there are no accounts', () => {
    expect(
      accountsSummary({ connected: 0, syncing: 0, attention: 0, disconnected: 0, other: 0 }),
    ).toBe('None connected yet');
  });
});

describe('planSummary', () => {
  it('shows the real fraction when a finite cap was actually counted', () => {
    expect(planSummary('free', 3, 3)).toBe('Free · 3 of 3 rules');
  });

  it('never renders an unlimited cap as a fraction', () => {
    expect(planSummary('pro', undefined, null)).toBe('Pro · unlimited rules');
  });

  it('never renders an uncounted usage as zero', () => {
    expect(planSummary('free', undefined, 3)).toBe('Free');
  });
});

describe('securitySummary', () => {
  it('states two-factor without inventing a session count', () => {
    expect(securitySummary(true)).toBe('Two-factor on');
    expect(securitySummary(false)).toBe('Two-factor off');
  });
});
