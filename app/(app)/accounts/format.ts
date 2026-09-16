/**
 * Display helpers for frame 6.5 (`brand/docs/screens/account.html#6.5`).
 * Pure, so the honesty rules are asserted directly in
 * `__tests__/format.test.ts` rather than inferred from a screenshot.
 */

/**
 * The frame's "Last sync · 14 min ago". An account that has never
 * synced returns `null` from the column, and the card must say so —
 * "now"/"0 min ago" for an unknown timestamp is exactly the fabricated
 * figure this UI phase has already shipped three of.
 */
export function formatLastSync(lastSyncAt: string | null, now: Date = new Date()): string {
  if (!lastSyncAt) return 'Never';
  const then = new Date(lastSyncAt);
  if (Number.isNaN(then.getTime())) return 'Unknown';

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  // A clock skew between the database and this server must not render as
  // "in 3 minutes" on a status card; clamp to the present instead.
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hr ago' : `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** Module 01 §9: `status_detail` holds a machine code, never a raw
 *  vendor error. Nothing writes one yet (no sync worker exists — see
 *  `app/(app)/accounts/page.tsx`), so the map is the vocabulary the
 *  sync worker will use, and an unrecognised or absent code degrades to
 *  a statement of what we know, never an invented cause. */
const ATTENTION_REASONS: Record<string, string> = {
  CREDENTIAL_REJECTED:
    'Your broker rejected the saved credential. This usually means the password changed.',
  CREDENTIAL_EXPIRED: 'The saved credential has expired. Reconnecting will issue a new one.',
  BROKER_UNREACHABLE: "We couldn’t reach your broker on the last few attempts.",
  READ_ONLY_LOST: 'The saved credential is no longer read-only, so we stopped using it.',
};

export function attentionReason(statusDetail: string | null): string {
  if (statusDetail && ATTENTION_REASONS[statusDetail]) return ATTENTION_REASONS[statusDetail];
  return "We can’t sync this account right now, and your broker didn’t tell us why. Reconnecting is the fix if your password or API key changed.";
}
