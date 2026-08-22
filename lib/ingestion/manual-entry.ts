import 'server-only';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { withUserConnection, withServiceRoleConnection } from '@/lib/supabase/direct';
import { computeServerDay } from './server-day';
import { recomputeInstrument, type RecomputeInstrumentAccountContext } from './sync';

/**
 * Module 02 (Trade Ingestion & Model) §4.8 — manual trade entry.
 *
 * "For accounts with `platform = 'manual'`. One screen, six fields, under
 * 30 seconds: instrument, direction, size, entry price, exit price, stop.
 * Everything else derived. Creates synthetic fills with `provider_ref =
 * 'manual:' || uuid` so the rest of the pipeline is identical — no
 * parallel code path."
 *
 * ## Judgment call #1 — the missing time/date field (flagged for
 * PROGRESS.md's decision log, per this slice's own dispatch)
 *
 * The six named fields have no time/date field, but block derivation
 * (`blocks.ts`) and derived facts (`trade-facts.ts`, specifically
 * `hold_seconds`) genuinely need two real `filled_at` timestamps — one for
 * the entry fill, one for the exit fill. Two readings were considered:
 *
 *  (a) Default both fills to `now()` — an honest "we don't know when"
 *      signal (`hold_seconds = 0`), matching "everything else derived"
 *      read strictly literally (nothing beyond the six fields exists).
 *  (b) Accept optional `enteredAt`/`exitedAt` fields as an input EXTENSION
 *      beyond the spec's literal six, each independently defaulting to the
 *      same shared "now" reference if omitted — closer to what a real
 *      product needs (a trader logging a trade from memory usually DOES
 *      remember roughly when it happened), and doesn't contradict "one
 *      screen, six fields, under 30 seconds" as long as both stay
 *      optional/auto-filled by default, with a "set the time" affordance
 *      left for a later UI pass (Slice 7) rather than a mandatory field on
 *      this screen.
 *
 * **Resolution: both, not a forced either/or.** `manualTradeInputSchema`
 * accepts optional `enteredAt`/`exitedAt` (reading (b), an extension a
 * future UI can surface or not), but when EITHER is omitted it defaults to
 * one shared `now` reference computed once per call (reading (a)'s exact
 * behavior when both are omitted, which is the common case until a UI for
 * (b) exists) — never two independent `new Date()` calls, which could
 * otherwise make `exitedAt` a few milliseconds before `enteredAt` purely
 * from clock ticking between two statements. This satisfies "make the
 * call, document it clearly" while leaving the function signature open for
 * either a bare 6-field caller (today, effectively reading (a)) or a
 * future caller that also collects real times (reading (b)) without a
 * breaking change either way. `exitedAt < enteredAt` (whether because both
 * were supplied explicitly and inconsistently, or because a caller mixed
 * an explicit past `enteredAt` with an omitted `exitedAt` that defaulted
 * to "now" and "now" happens to be earlier than the supplied `enteredAt`
 * — impossible in practice, but defensively checked anyway) is rejected
 * with `ManualEntryInvalidTimestampsError`, Module 02 §9's
 * `MANUAL_TRADE_INVALID` taxonomy ("inconsistent manual input | inline
 * field errors").
 *
 * ## Judgment call #2 — why this is a TWO-PHASE write, `withUserConnection`
 * THEN `withServiceRoleConnection`, not one or the other throughout
 * (flagged for PROGRESS.md's decision log and the security-reviewer)
 *
 * The dispatch for this slice asks for `withUserConnection`, "not
 * service-role," reasoning that this is "a genuine end-user-initiated
 * write" the way `corrections.ts`'s `toggleNotADecision` is. That is
 * correct for the actual NOVEL, untrusted-input part of this flow — but
 * literally routing every write in this function through one
 * `withUserConnection` transaction is not just a style choice, it is
 * **structurally impossible** given `20260822010000_ingestion_schema.sql`'s
 * own, already-reviewed RLS shape: `blocks` and `trade_fills` each have
 * ONLY an owner SELECT policy — no INSERT policy for the `authenticated`
 * role exists on either table AT ALL (see that migration's own comments:
 * "No client role may INSERT/UPDATE/DELETE this table under any
 * circumstance" for `blocks`; "Membership rows are always written by the
 * grouping engine's derivation logic ... never directly by a client
 * insert" for `trade_fills`). An `authenticated`-role INSERT into either
 * table is rejected by RLS unconditionally, regardless of `user_id`. This
 * is the exact same reason `confirm.ts`'s `confirmDay` — itself
 * unambiguously a "genuine end-user-initiated" action (a trader tapping
 * "Day done") — still runs entirely under `withServiceRoleConnection`: it
 * writes `day_closeouts`, which has the identical no-client-INSERT shape.
 *
 * **The resolution, matching that established precedent:** split this
 * function into exactly the two phases that have genuinely different
 * privilege requirements, and make each phase as narrowly scoped as it can
 * be —
 *
 *  1. **Phase 1, `withUserConnection` (genuinely RLS-enforced, the real
 *     security boundary for this new write path):** a SELECT confirming
 *     `accountId` both exists AND is owned by `userId` (RLS's own
 *     `trading_accounts_owner` policy independently enforces this too —
 *     two redundant checks of the same fact, same posture as
 *     `corrections.ts`), followed by inserting the two synthetic `fills`
 *     rows. This is the ACTUAL novel untrusted-input boundary the dispatch
 *     is right to flag: it is where a cross-user attempt would have to be
 *     rejected, and it is exactly the policy
 *     (`fills_owner_insert`'s `with check (user_id = auth.uid() and
 *     provider_ref like 'manual:%')`) that
 *     `20260822010000_ingestion_schema.sql`'s own comment says exists
 *     SPECIFICALLY for this: "Owner INSERT is kept ... because §4.8 manual
 *     trade entry needs a genuine client-writable path for its synthetic
 *     fills." Verified live, not assumed: see this file's own live test,
 *     "a second user cannot create a manual trade against the first
 *     user's account."
 *  2. **Phase 2, `withServiceRoleConnection`:** calls the UNCHANGED,
 *     shared `recomputeInstrument` (exported from `sync.ts` this same
 *     slice, specifically so this file has no reimplementation to
 *     maintain) to derive blocks/grouping/facts from the fills phase 1
 *     just wrote — identical to how a real broker sync would derive them.
 *     This is necessarily service-role for the structural RLS reason
 *     above, matching `confirm.ts`'s own established posture, not a
 *     shortcut invented for this slice.
 *
 * This split is about DATABASE PRIVILEGE PLUMBING ONLY — it does not
 * reintroduce a parallel code path for the actual grouping/derived-facts
 * LOGIC, which is the concrete, checkable meaning of §4.8's "no parallel
 * code path" this slice's dispatch cares about: `recomputeInstrument`
 * itself is called completely unchanged, byte-for-byte the same function
 * `runSync` uses. **Explicitly flagged for the security reviewer, not
 * decided unilaterally:** confirm this reasoning is sound rather than
 * simply trusting it — the alternative (adding an INSERT policy to
 * `blocks`/`trade_fills` for `authenticated`) was considered and rejected
 * here as a much larger, unreviewed change to an already-reviewed RLS
 * shape, for a benefit (one single `withUserConnection` transaction
 * instead of two) that doesn't change the actual security property once
 * phase 1's ownership check is real.
 *
 * ## Known gap — an orphaned-fills window between phase 1 and phase 2
 * (flagged, not fixed here; found during an independent test pass,
 * 2026-08-22)
 *
 * `withUserConnection`/`withServiceRoleConnection`
 * (`lib/supabase/direct.ts`'s `withRole`) each commit their OWN
 * transaction independently — there is no single transaction spanning
 * both phases. If phase 1 (the two synthetic `fills` rows) commits
 * successfully and phase 2 (`recomputeInstrument`) then throws for ANY
 * reason (a transient DB error, a future bug in derivation logic, a
 * connection drop), the two fills are left durably committed with no
 * block/trade ever derived from them. Because `sync.ts`'s `runSync`
 * explicitly skips `platform = 'manual'` accounts
 * (`{ skipped: true, reason: 'manual_account' }`), there is currently NO
 * retry or reconciliation path anywhere in this repo that would ever pick
 * those orphaned fills back up — they simply sit invisible (no trade
 * means no row surfaces anywhere in the product) until someone
 * deliberately queries for `fills` with no matching `trade_fills` row.
 *
 * This function itself still fails LOUDLY (the caller's promise rejects,
 * per AGENTS.md's "never fake it") — the gap is not a silent failure at
 * the call site, it is the absence of any cleanup/retry for what phase 1
 * already committed. Proven live, not hypothetical: see
 * `manual-entry-phase2-failure.live.test.ts` (a separate file, since it
 * mocks `recomputeInstrument` to throw, which would otherwise break every
 * happy-path test in `manual-entry.live.test.ts`).
 *
 * Not fixed in this pass because the right fix is a product/eng decision
 * with more than one honest shape (e.g.: a reconciliation sweep akin to
 * `autoConfirmStaleTrades` that finds fill-only-no-trade rows and retries
 * `recomputeInstrument`; wrapping phase 1+2 in one transaction by adding a
 * narrow, reviewed INSERT policy to `blocks`/`trade_fills` — the exact
 * alternative already considered and rejected above for a different
 * reason; or simply surfacing orphaned fills to the user as a visible
 * "entry failed partway, retry" state) — picking one is a deliberate
 * design decision, not a QA-pass fix. Tracked in PROGRESS.md.
 */

const DECIMAL_STRING_REGEX = /^\d{1,12}(\.\d{1,8})?$/; // numeric(20,8): up to 12 integer digits, up to 8 fractional.

function positiveDecimalString(label: string) {
  return z
    .string()
    .trim()
    .regex(DECIMAL_STRING_REGEX, `${label} must be a positive decimal number with up to 8 decimal places.`)
    .refine(
      (v) => {
        // Zod v4 runs every chained check on a schema regardless of whether
        // an earlier one already failed (no short-circuit within one
        // schema's check list) -- so this refine must never assume the
        // regex above already guaranteed `v` is Decimal-constructible. A
        // string that fails the regex (e.g. "abc") would otherwise reach
        // `new Decimal(v)` here and throw a raw, uncaught DecimalError
        // instead of a normal Zod validation failure. Treat "not
        // Decimal-constructible" as simply "not > 0" -- the regex check's
        // own message is what the caller actually sees for that case
        // either way, since Zod reports every failed check, not just one.
        try {
          return !new Decimal(v).isZero();
        } catch {
          return false;
        }
      },
      { message: `${label} must be greater than zero.` },
    );
}

const isoTimestamp = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Must be a valid ISO-8601 timestamp.' });

export const manualTradeInputSchema = z.strictObject({
  instrument: z
    .string()
    .trim()
    .min(1, 'Instrument is required.')
    .max(40, 'Instrument must be 40 characters or fewer.'),
  direction: z.enum(['long', 'short']),
  size: positiveDecimalString('Size'),
  entryPrice: positiveDecimalString('Entry price'),
  exitPrice: positiveDecimalString('Exit price'),
  /** §4.4 already handles a null stop honestly (risk fields become
   *  `null`, "not applicable," never a defaulted zero) — the spec doesn't
   *  say stop is mandatory, so it isn't here either. */
  stop: positiveDecimalString('Stop').nullable(),
  /** Extension beyond the spec's literal six fields — see this file's
   *  header, judgment call #1. Both optional; each independently defaults
   *  to one shared `now` reference when omitted. */
  enteredAt: isoTimestamp.optional(),
  exitedAt: isoTimestamp.optional(),
});
export type ManualTradeInput = z.infer<typeof manualTradeInputSchema>;

export interface CreateManualTradeOptions {
  /** Testability hook, same posture as `sync.ts`/`confirm.ts`. The single
   *  shared reference instant used for whichever of `enteredAt`/`exitedAt`
   *  is omitted — see header judgment call #1. */
  now?: () => Date;
}

export interface ManualTradeResult {
  tradeId: string;
  blockId: string;
  entryFillId: string;
  exitFillId: string;
}

/** Module 02 §9's `MANUAL_TRADE_INVALID` — thrown for input that is
 *  well-typed per `manualTradeInputSchema` but internally inconsistent.
 *  Zod's own `.parse()` throwing a `ZodError` covers every literal
 *  per-field validation failure (size <= 0, malformed decimal string,
 *  etc.) — this class covers the one cross-field consistency rule Zod
 *  can't express declaratively. */
export class ManualEntryInvalidTimestampsError extends Error {
  constructor(enteredAt: Date, exitedAt: Date) {
    super(
      `createManualTrade: exitedAt (${exitedAt.toISOString()}) is before enteredAt (${enteredAt.toISOString()}) — a trade cannot exit before it entered.`,
    );
    this.name = 'ManualEntryInvalidTimestampsError';
  }
}

/** Thrown when `accountId` doesn't reference a real `trading_accounts`
 *  row owned by `userId` — either it doesn't exist, or (this is the
 *  cross-user case this file's header discusses) it belongs to someone
 *  else. RLS-scoped `withUserConnection` SELECT genuinely cannot tell
 *  these apart (both return zero rows), which is the correct, standard
 *  "not found / not yours" posture this repo already uses elsewhere
 *  (`accounts-repository.ts`'s `getTradingAccount`) — never leaking
 *  whether a stranger's account id exists. */
export class ManualEntryAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(
      `createManualTrade: no retrospeq.trading_accounts row for id ${accountId} owned by the calling user.`,
    );
    this.name = 'ManualEntryAccountNotFoundError';
  }
}

/** Thrown when `accountId` is real and owned by the caller, but
 *  `platform !== 'manual'` — §4.8 is explicit this entry point is "for
 *  accounts with `platform = 'manual'`" only. Must fail loudly, never
 *  silently create a fake "manual" fill on a real broker account (this
 *  slice's own dispatch, verbatim). */
export class ManualEntryNotManualPlatformError extends Error {
  constructor(accountId: string, platform: string) {
    super(
      `createManualTrade: account ${accountId} has platform "${platform}", not "manual" — manual entry is only valid for platform = 'manual' accounts (Module 02 §4.8).`,
    );
    this.name = 'ManualEntryNotManualPlatformError';
  }
}

interface Phase1Result {
  account: RecomputeInstrumentAccountContext;
  entryFillId: string;
  exitFillId: string;
}

/**
 * Pure, directly unit-testable — see header judgment call #1.
 * `input.enteredAt`/`input.exitedAt` are ISO-8601 strings (already
 * Zod-validated as parseable), `now` is the caller's single shared
 * reference instant for whichever one is omitted. Throws
 * `ManualEntryInvalidTimestampsError` rather than silently swapping or
 * clamping the pair.
 */
export function resolveManualTradeTimestamps(
  input: Pick<ManualTradeInput, 'enteredAt' | 'exitedAt'>,
  now: Date,
): { enteredAt: Date; exitedAt: Date } {
  const enteredAt = input.enteredAt ? new Date(input.enteredAt) : now;
  const exitedAt = input.exitedAt ? new Date(input.exitedAt) : now;
  if (exitedAt.getTime() < enteredAt.getTime()) {
    throw new ManualEntryInvalidTimestampsError(enteredAt, exitedAt);
  }
  return { enteredAt, exitedAt };
}

/** Pure, directly unit-testable. Long: buy to enter, sell to exit. Short: the reverse. */
export function deriveManualFillSides(direction: 'long' | 'short'): {
  entrySide: 'buy' | 'sell';
  exitSide: 'buy' | 'sell';
} {
  return direction === 'long' ? { entrySide: 'buy', exitSide: 'sell' } : { entrySide: 'sell', exitSide: 'buy' };
}

/**
 * Pure, directly unit-testable. Realized P&L belongs on the EXIT fill
 * only (a broker never reports P&L on an opening fill either — no
 * position has closed yet to realize anything against).
 * `trade-facts.ts`'s `computeTradeFacts` sums every member's
 * `realizedPnl` (`null` treated as `0`), so putting the whole computed
 * amount on the exit fill and leaving the entry fill's `null` reproduces
 * exactly the real-fill convention with no special-casing needed
 * downstream.
 */
export function computeManualRealizedPnl(
  direction: 'long' | 'short',
  entryPrice: string,
  exitPrice: string,
  size: string,
): Decimal {
  return direction === 'long'
    ? new Decimal(exitPrice).minus(entryPrice).mul(size)
    : new Decimal(entryPrice).minus(exitPrice).mul(size);
}

/**
 * Module 02 §4.8 — creates one manual trade for a `platform = 'manual'`
 * account. See this file's header for the two judgment calls (the
 * timestamp extension, and the two-phase RLS/service-role write split).
 *
 * `rawInput` is `unknown` and validated internally via
 * `manualTradeInputSchema.parse` (throws `ZodError` on a literal per-field
 * problem — §9's `MANUAL_TRADE_INVALID`, "inline field errors") — a future
 * Server Action passes `formData`-derived input straight through rather
 * than pre-validating twice.
 */
export async function createManualTrade(
  userId: string,
  accountId: string,
  rawInput: unknown,
  options: CreateManualTradeOptions = {},
): Promise<ManualTradeResult> {
  const input = manualTradeInputSchema.parse(rawInput);

  const now = options.now ? options.now() : new Date();
  const { enteredAt, exitedAt } = resolveManualTradeTimestamps(input, now);
  const { entrySide, exitSide } = deriveManualFillSides(input.direction);
  const pnl = computeManualRealizedPnl(input.direction, input.entryPrice, input.exitPrice, input.size);

  // -----------------------------------------------------------------
  // Phase 1 -- withUserConnection, genuinely RLS-enforced. See header
  // judgment call #2.
  // -----------------------------------------------------------------
  const { account, entryFillId, exitFillId }: Phase1Result = await withUserConnection(userId, async (client) => {
    const accountRes = await client.query<{
      id: string;
      user_id: string;
      platform: string;
      day_rollover: string;
      base_currency: string;
      starting_equity: string | null;
    }>(
      `select id, user_id, platform, day_rollover, base_currency, starting_equity
         from retrospeq.trading_accounts
        where id = $1 and user_id = $2`,
      [accountId, userId],
    );
    const acct = accountRes.rows[0];
    if (!acct) {
      throw new ManualEntryAccountNotFoundError(accountId);
    }
    if (acct.platform !== 'manual') {
      throw new ManualEntryNotManualPlatformError(accountId, acct.platform);
    }

    const entryProviderRef = `manual:${randomUUID()}`;
    const exitProviderRef = `manual:${randomUUID()}`;
    const entryServerDay = computeServerDay(enteredAt.toISOString(), acct.day_rollover);
    const exitServerDay = computeServerDay(exitedAt.toISOString(), acct.day_rollover);

    // fills_owner_insert's `with check` requires `user_id = auth.uid()`
    // (== userId, resolved from the caller's own session, never
    // attacker-suppliable) AND `provider_ref like 'manual:%'` — both
    // satisfied here by construction.
    const entryRes = await client.query<{ id: string }>(
      `insert into retrospeq.fills
         (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency, stop_at_fill, realized_pnl)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,null)
       returning id`,
      [
        userId,
        accountId,
        entryProviderRef,
        input.instrument,
        entrySide,
        input.size,
        input.entryPrice,
        enteredAt.toISOString(),
        entryServerDay,
        acct.base_currency,
        input.stop,
      ],
    );
    const exitRes = await client.query<{ id: string }>(
      `insert into retrospeq.fills
         (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency, stop_at_fill, realized_pnl)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,$11)
       returning id`,
      [
        userId,
        accountId,
        exitProviderRef,
        input.instrument,
        exitSide,
        input.size,
        input.exitPrice,
        exitedAt.toISOString(),
        exitServerDay,
        acct.base_currency,
        pnl.toFixed(8),
      ],
    );

    return {
      account: {
        id: acct.id,
        user_id: acct.user_id,
        day_rollover: acct.day_rollover,
        starting_equity: acct.starting_equity,
        base_currency: acct.base_currency,
      },
      entryFillId: entryRes.rows[0].id,
      exitFillId: exitRes.rows[0].id,
    };
  });

  // -----------------------------------------------------------------
  // Phase 2 -- withServiceRoleConnection, matching sync.ts/confirm.ts's
  // established posture for blocks/trade_fills/trade_events (no client
  // write policy exists for either table -- see header judgment call #2).
  // Calls the SAME recomputeInstrument real syncs use -- no parallel
  // grouping/derived-facts logic.
  // -----------------------------------------------------------------
  const { tradeId, blockId } = await withServiceRoleConnection(async (client) => {
    await recomputeInstrument(client, account, input.instrument);

    // The entry fill's own trade_fills row names the trade recomputeInstrument
    // just created for it -- robust even if this call's fresh blocks aren't
    // the only new blocks derived this pass (e.g. a concurrent second manual
    // entry on the same instrument), since it's keyed on OUR OWN fill id,
    // not on recomputeInstrument's aggregate counts.
    const res = await client.query<{ trade_id: string; block_id: string }>(
      `select tf.trade_id, t.block_id
         from retrospeq.trade_fills tf
         join retrospeq.trades t on t.id = tf.trade_id
        where tf.fill_id = $1`,
      [entryFillId],
    );
    const row = res.rows[0];
    if (!row) {
      // Structurally should not happen: a manual entry's two fills always
      // form exactly one confident_single group (see this file's header),
      // so recomputeInstrument always writes a trade_fills row for the
      // entry fill it was just given. Thrown, not silently swallowed --
      // AGENTS.md's "never fake it."
      throw new Error(
        `createManualTrade: recomputeInstrument did not produce a trade_fills row for entry fill ${entryFillId} -- this should be structurally impossible for a fresh two-fill manual block.`,
      );
    }
    return { tradeId: row.trade_id, blockId: row.block_id };
  });

  return { tradeId, blockId, entryFillId, exitFillId };
}
