/**
 * Frame 6.4 (`brand/docs/screens/account.html#6.4`) previews each
 * settings row's own state under its label ("1 connected · 1 needs
 * attention", "Free · 3 of 3 rules") so a trader knows before tapping.
 *
 * Pure string builders, kept out of the page so the honesty rules can be
 * asserted directly (`__tests__/summaries.test.ts`): a count we never
 * measured is never rendered as a zero, and an unlimited cap is never
 * rendered as a fraction (AGENTS.md "never fake it"; three fabricated
 * figures have already shipped in this UI phase).
 */

export interface AccountStatusCounts {
  connected: number;
  syncing: number;
  attention: number;
  disconnected: number;
  other: number;
}

export function countAccountStatuses(statuses: readonly string[]): AccountStatusCounts {
  const counts: AccountStatusCounts = {
    connected: 0,
    syncing: 0,
    attention: 0,
    disconnected: 0,
    other: 0,
  };
  for (const status of statuses) {
    if (status === 'connected') counts.connected += 1;
    else if (status === 'syncing') counts.syncing += 1;
    else if (status === 'attention') counts.attention += 1;
    else if (status === 'disconnected') counts.disconnected += 1;
    else counts.other += 1;
  }
  return counts;
}

/** "1 connected · 1 needs attention" — only the non-zero segments, so a
 *  trader is never told about a state they aren't in. */
export function accountsSummary(counts: AccountStatusCounts): string {
  const parts: string[] = [];
  if (counts.connected > 0) parts.push(`${counts.connected} connected`);
  if (counts.syncing > 0) parts.push(`${counts.syncing} syncing`);
  if (counts.attention > 0) {
    parts.push(counts.attention === 1 ? '1 needs attention' : `${counts.attention} need attention`);
  }
  if (counts.disconnected > 0) parts.push(`${counts.disconnected} disconnected`);
  if (counts.other > 0) parts.push(counts.other === 1 ? '1 paused by your plan' : `${counts.other} paused by your plan`);
  if (parts.length === 0) return 'None connected yet';
  return parts.join(' · ');
}

/**
 * "Free · 3 of 3 rules". `rulesUsed`/`rulesLimit` come straight from the
 * entitlement result: a `null` limit is unlimited (Pro) and carries no
 * usage count, and an `undefined` count means nobody counted — neither
 * may be rendered as "0 of …".
 */
export function planSummary(
  plan: 'free' | 'pro',
  rulesUsed: number | undefined,
  rulesLimit: number | null,
): string {
  const planLabel = plan === 'pro' ? 'Pro' : 'Free';
  if (rulesLimit === null) return `${planLabel} · unlimited rules`;
  if (rulesUsed === undefined) return planLabel;
  return `${planLabel} · ${rulesUsed} of ${rulesLimit} rules`;
}

/** Frame 6.4 reads "Two-factor on · 2 sessions". There is no per-device
 *  session list to count (Supabase Auth exposes none for a user's own
 *  sessions — see `SecurityScreenClient`), so the session half is
 *  omitted rather than invented. */
export function securitySummary(twoFactorOn: boolean): string {
  return twoFactorOn ? 'Two-factor on' : 'Two-factor off';
}
