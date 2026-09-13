import { describe, expect, it } from 'vitest';
import { sectionFor } from '../AppShellNav';

describe('AppShellNav sectionFor — which tab is active', () => {
  it.each([
    ['/dashboard', 'home'],
    ['/review', 'home'],
    ['/review/decisions', 'home'],
    ['/onboarding/hook', 'home'],
    ['/trades', 'trades'],
    ['/trades/close-out', 'trades'],
    ['/rules', 'rulebook'],
    ['/rules/new', 'rulebook'],
    ['/strategies/abc', 'rulebook'],
    ['/fields/new', 'rulebook'],
    ['/performance', 'performance'],
    ['/settings', 'settings'],
    ['/accounts/connect', 'settings'],
    ['/plan', 'settings'],
    ['/security', 'settings'],
    ['/privacy', 'settings'],
  ])('%s -> %s', (pathname, section) => {
    expect(sectionFor(pathname)).toBe(section);
  });

  it('matches whole segments only, never a bare prefix', () => {
    expect(sectionFor('/rulesets')).toBeNull();
    expect(sectionFor('/tradesman')).toBeNull();
  });

  it('returns null for routes outside every tab', () => {
    expect(sectionFor('/')).toBeNull();
  });
});
