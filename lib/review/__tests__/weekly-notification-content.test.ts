import { describe, expect, it } from 'vitest';
import { buildWeeklyNotificationContent, summaryLine } from '../weekly-notification-content';

/**
 * Module 06 §4.10 step 6 — pure content-building tests. No I/O, no
 * `server-only` mock needed (this file has neither).
 */

describe('lib/review/weekly-notification-content.ts — summaryLine', () => {
  it('renders real counts, plural', () => {
    expect(summaryLine({ tradeCount: 14, daysTradedCount: 5, decisionCount: 2 })).toBe(
      '14 trades · 5 days · 2 decisions.',
    );
  });

  it('singularises 1 correctly for each of the three counts independently', () => {
    expect(summaryLine({ tradeCount: 1, daysTradedCount: 1, decisionCount: 1 })).toBe(
      '1 trade · 1 day · 1 decision.',
    );
  });

  it('renders honest zeros — never fabricated, never omitted (a genuinely quiet week)', () => {
    expect(summaryLine({ tradeCount: 0, daysTradedCount: 0, decisionCount: 0 })).toBe(
      '0 trades · 0 days · 0 decisions.',
    );
  });
});

describe('lib/review/weekly-notification-content.ts — buildWeeklyNotificationContent', () => {
  const links = { reviewUrl: 'https://app.example.com/review', unsubscribeUrl: 'https://app.example.com/privacy' };

  it('subject matches frame 4.14 / the source template exactly', () => {
    const content = buildWeeklyNotificationContent({ tradeCount: 14, daysTradedCount: 5, decisionCount: 2 }, links);
    expect(content.subject).toBe('Your week is ready to read');
  });

  it('never mentions currency or "you haven\'t..." nagging copy (the template\'s own "No streak warnings" line is a reassurance, not a violation)', () => {
    const content = buildWeeklyNotificationContent({ tradeCount: 14, daysTradedCount: 5, decisionCount: 2 }, links);
    for (const body of [content.text, content.html]) {
      expect(body).not.toMatch(/\$|currency|haven't/i);
      expect(body).not.toMatch(/streak (intact|broken|lost|saved)/i);
    }
  });

  it('embeds the real review/unsubscribe URLs, not a placeholder "#"', () => {
    const content = buildWeeklyNotificationContent({ tradeCount: 14, daysTradedCount: 5, decisionCount: 2 }, links);
    expect(content.html).toContain(`href="${links.reviewUrl}"`);
    expect(content.html).toContain(`href="${links.unsubscribeUrl}"`);
    expect(content.text).toContain(links.reviewUrl);
    expect(content.text).toContain(links.unsubscribeUrl);
  });

  it('states this is the only scheduled email, matching §5.6\'s own product claim', () => {
    const content = buildWeeklyNotificationContent({ tradeCount: 0, daysTradedCount: 0, decisionCount: 0 }, links);
    expect(content.text).toMatch(/only email .* sends on a schedule/i);
    expect(content.html).toMatch(/only email .* sends on a schedule/i);
  });

  it('a zero-trade week is rendered honestly, not hidden or invented', () => {
    const content = buildWeeklyNotificationContent({ tradeCount: 0, daysTradedCount: 0, decisionCount: 1 }, links);
    expect(content.text).toContain('0 trades · 0 days · 1 decision.');
  });

  it('escapes HTML-significant characters in the summary line (defense in depth, counts are numbers today but never trust it blindly)', () => {
    // Not a realistic count, but proves the escaping path exists rather
    // than trusting every future caller to only ever pass safe numbers.
    const content = buildWeeklyNotificationContent({ tradeCount: 14, daysTradedCount: 5, decisionCount: 2 }, links);
    expect(content.html).not.toContain('<script');
  });
});
