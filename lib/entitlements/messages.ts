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

/**
 * Module 04 §10's `ENTITLEMENT_LIMIT` copy, verbatim as the worked
 * example: "You're at 3 of 3 rules. Your history suggests four more."
 * §5.2's reference markup shows the identical line as an aside.
 *
 * Unlike `accountConnectLimitMessage` above, this module's own dispatch
 * explicitly asks for the derived-recommendation clause where this
 * file's own header comment said Module 04 would be "the right place to
 * attempt the real derived-recommendation clause" once it existed —
 * this IS that slice. The "four more" style number would need a real
 * behavioural signal (how many additional rules this trader's own
 * history suggests, per §5.8's preview/discovery engine) that this
 * authoring-pipeline slice does not build (the preview engine is
 * explicitly Slice 3, per this slice's own dispatch: "Do NOT build the
 * preview engine in this slice"). Fabricating a plausible-sounding
 * number here without a real derivation behind it would be exactly the
 * kind of invented confidence 00-foundation's "never fake it" rules out
 * — so this function, like `accountConnectLimitMessage`, ships the
 * honest half of the pattern only (the specific fraction), leaving the
 * "suggests N more" clause for whichever slice builds the real
 * derivation (Slice 3's preview/discovery engine, or Module 06).
 */
export function ruleCreateLimitMessage(used: number, limit: number): string {
  const noun = limit === 1 ? 'rule' : 'rules';
  return `You're at ${used} of ${limit} ${noun}. Upgrade to write more.`;
}
