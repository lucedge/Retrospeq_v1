/**
 * Module 01 §4.1 / §9's `ENTITLEMENT_LIMIT` copy: "Specific: 'You're at
 * 3 of 3 rules.' ... Specific number, from real data." §5.2's reference
 * markup shows the same pattern as an aside: "You're at 3 of 3 rules.
 * Your history suggests four more."
 *
 * DEVIATION, logged explicitly (per this slice's own dispatch): the
 * "Your history suggests four more" half is a DERIVED recommendation —
 * for `rules.create` the product could plausibly infer a likely count
 * of additional rules a trader's history suggests they'd write (that
 * derivation lives in Module 04/05, not built yet). For
 * `account.connect`, the only capability this slice can check for
 * real, there is no analogous derivable signal — "how many more
 * broker accounts does this trader's history suggest they have" isn't
 * something `trading_accounts` alone can answer (a trader's *other*
 * accounts are, by definition, accounts this app has never seen). This
 * file's `account.connect` message is therefore the honest, simpler
 * half of the pattern only: the specific fraction, no fabricated
 * "suggests N more" clause. The moment Module 04's rules-cap message is
 * built, IT is the right place to attempt the real derived-recommendation
 * clause, not this file, and not by inventing a number here.
 */

export function formatUsageFraction(used: number, limit: number | null): string {
  if (limit === null) return `${used} (unlimited)`;
  return `${used} of ${limit}`;
}

export function accountConnectLimitMessage(used: number, limit: number): string {
  const noun = limit === 1 ? 'account' : 'accounts';
  return `You're at ${used} of ${limit} ${noun}. Upgrade to connect more.`;
}
