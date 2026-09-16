/**
 * Frame 6.8's "Authenticator app · on since 22 Aug" subline. Pure, so
 * the honest-when-unknown case is asserted directly
 * (`__tests__/format.test.ts`) rather than eyeballed.
 */

/** "22 Aug". Fixed locale + UTC so the string is the same on the server
 *  as in a test, and `null` for anything we don't actually have — the
 *  caller drops the clause rather than printing a placeholder date. */
export function formatShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

/** The frame's subline, assembled only from what is known. */
export function twoFactorSubline(enrolled: boolean, addedOn: string | null): string {
  if (!enrolled) return 'Not set up. A code from your authenticator app, every sign-in.';
  return addedOn ? `Authenticator app · added ${addedOn}` : 'Authenticator app';
}
