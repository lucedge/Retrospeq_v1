/**
 * Module 06 §4.10 step 6 / Module 07 §5.6 — the one weekly notification's
 * actual copy. Pure (no I/O, no `server-only`) so it's trivially unit
 * testable and so `weekly-job.ts` can build the content before deciding
 * whether a send is even needed.
 *
 * The HTML below is a runtime COPY of
 * `retrospeq-design-system/brand/templates/email/weekly-review-ready.html`
 * (batch 7, "the only five emails the product sends") with its one
 * example sentence ("14 trades · 5 days · 2 decisions.") and its one
 * button `href` turned into real substitutions — same "edit the source,
 * re-sync the copy" discipline AGENTS.md already establishes for
 * `brand/css` -> `public/brand`/`app/brand-tokens`, applied here for the
 * first time to an email template because this is the first email this
 * repo actually SENDS with template-shaped content (erasure's
 * confirmation email, `lib/privacy/erasure.ts`, is plain-text prose with
 * no template). If the source `.html` file changes, this string must be
 * updated to match by hand — there is no build-time sync step for email
 * templates (unlike the CSS copies, which each have their own literal
 * file). Every other visible byte (colours, layout, copy) is unchanged
 * from the source file.
 *
 * Frame 4.14 (`brand/docs/screens/review-performance.html#4.14`)'s own
 * card copy is, per its own caption, "the notification copy; the email
 * template ... carries the same line" — this file is what makes that
 * literally true for the email side.
 */

export interface WeeklyNotificationCounts {
  tradeCount: number;
  daysTradedCount: number;
  decisionCount: number;
}

export interface WeeklyNotificationLinks {
  /** Absolute URL to `/review` — see `weekly-job.ts` for how this is
   *  built (an `APP_BASE_URL` env var, honestly TODO'd against the real
   *  domain gap, `docs/infra-gaps.md`). */
  reviewUrl: string;
  /** Absolute URL to the opt-out toggle (`/privacy`, where the toggle
   *  actually lives) — the email-law-required unsubscribe link. */
  unsubscribeUrl: string;
}

export interface WeeklyNotificationContent {
  subject: string;
  text: string;
  html: string;
}

/** "14 trades · 5 days · 2 decisions." — never fabricated: every number
 *  is the real count this review's own read payload/prompt set produced,
 *  including honest zeros (a no-trade week reads "0 trades · 0 days · 1
 *  decision.", never invented, never omitted). */
export function summaryLine(counts: WeeklyNotificationCounts): string {
  const trades = counts.tradeCount === 1 ? '1 trade' : `${counts.tradeCount} trades`;
  const days = counts.daysTradedCount === 1 ? '1 day' : `${counts.daysTradedCount} days`;
  const decisions = counts.decisionCount === 1 ? '1 decision' : `${counts.decisionCount} decisions`;
  return `${trades} · ${days} · ${decisions}.`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildWeeklyNotificationContent(
  counts: WeeklyNotificationCounts,
  links: WeeklyNotificationLinks,
): WeeklyNotificationContent {
  const summary = summaryLine(counts);
  const preheader = `${summary} About four minutes.`;
  const subject = 'Your week is ready to read';

  const text = [
    'Your week is ready to read.',
    '',
    `${summary} About four minutes: read first, decide second.`,
    '',
    'This is the only email Retrospeq sends on a schedule. No streak warnings, no reminders, nothing else.',
    '',
    `Start review: ${links.reviewUrl}`,
    '',
    "You get this once a week, on Sunday. It is the product's entire outbound volume.",
    `Email preferences: ${links.unsubscribeUrl}`,
  ].join('\n');

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><title>Your week is ready to read</title></head>' +
    '<body style="margin:0;padding:0;background:#F6F7F8;font-family:Archivo,\'Helvetica Neue\',Arial,sans-serif;">' +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F8;">' +
    '<tr><td align="center" style="padding:32px 16px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">' +
    '<tr><td style="padding:0 4px 18px;font-weight:800;font-size:18px;letter-spacing:-0.6px;color:#14181B;">' +
    '<span style="display:inline-block;width:14px;height:14px;border:2.4px solid #14181B;' +
    'border-radius:50%;vertical-align:-2px;margin-right:8px;"></span>Retrospe' +
    '<span style="color:#E9A23B;">q</span></td></tr>' +
    '<tr><td style="background:#FFFFFF;border:1px solid #E0E4E6;border-radius:14px;padding:28px 24px;">' +
    '<h1 style="margin:0 0 14px;font-size:24px;line-height:1.15;letter-spacing:-0.7px;font-weight:700;' +
    'color:#14181B;">Your week is ready to read.</h1>' +
    '<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#14181B;">' +
    `<span style="font-family:'Azeret Mono',Menlo,monospace;">${escapeHtml(summary)}</span> ` +
    'About four minutes: read first, decide second.</p>' +
    '<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#14181B;">' +
    'This is the only email Retrospeq sends on a schedule. No streak warnings, no reminders, nothing else.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;">' +
    '<tr><td style="background:#E9A23B;border-radius:10px;">' +
    `<a href="${escapeHtml(links.reviewUrl)}" style="display:inline-block;padding:14px 22px;font-weight:700;` +
    'font-size:15px;color:#14181B;text-decoration:none;">Start review</a></td></tr></table>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:#8A939A;">' +
    "You get this once a week, on Sunday. It is the product’s entire outbound volume.<br>" +
    `Retrospeq · retrospeq.app (TODO owner) · <a href="${escapeHtml(links.unsubscribeUrl)}" ` +
    'style="color:#8A939A;">Email preferences</a></td></tr>' +
    '</table></td></tr></table></body></html>';

  return { subject, text, html };
}
