/**
 * Module 02 (Trade Ingestion & Model) §4.2 — block derivation.
 *
 * "A block is the span in one instrument from net-flat to net-flat.
 * Deterministic, no heuristics":
 *
 * ```
 * running = 0
 * for fill in fills(account, instrument) ordered by filled_at, id:
 *     if running == 0: open new block
 *     running += signed_volume(fill)
 *     assign fill to current block
 *     if running == 0: close block at fill.filled_at
 * ```
 *
 * "Signed volume uses buy positive, sell negative. Floating-point
 * comparison is forbidden — use `numeric` and compare to exact zero."
 * This file uses `decimal.js` throughout for exactly that reason: JS's
 * native `number` cannot represent a value like `100000.00000000` in a
 * way that reliably compares equal to zero after several additions and
 * subtractions the way Postgres `numeric(20,8)` can (00-foundation §2.3:
 * "Never floating point"). `Decimal` objects — never a plain `number` —
 * carry every running-volume value in this module.
 *
 * **This module is deliberately scoped to BLOCK boundaries only.** It
 * does not implement the grouping engine (§4.3 — confidence scoring,
 * signals, the resting-baseline split) — that reads a block as its
 * *upper bound*, not its answer, and is a separate, later slice by
 * design (per this slice's own dispatch). A block here is the flat-to-flat
 * span; multiple trades may eventually live inside one block once the
 * grouping engine exists.
 *
 * ## The flip / no-flat-point case (§4.2, `flip_no_flat` fixture)
 *
 * "Direction flip with no flat point cannot occur in a net-position
 * model: crossing zero closes the block and opens a new one at the same
 * instant. The crossing fill is split across both blocks proportionally."
 *
 * This is purely a BLOCK-boundary rule — which block a fill's timestamp
 * belongs to. It is deliberately distinct from
 * `docs/adr/0001-flip-fill-split-via-trade-events.md`, which resolves a
 * *different* tension one layer up (how the physical `fills` row maps to
 * `trade_fills`/`trade_events` rows once trades — not just blocks — are
 * being assembled). `deriveBlocks` here has no `trade_fills` or
 * `trade_events` concept at all; it returns block spans plus a
 * `FillBlockAssignment` list recording which block(s) each fill
 * contributed volume to, so the grouping engine (next slice) has exactly
 * the per-fill, per-block volume split it needs without re-deriving it,
 * without this module needing to know anything about `trades`.
 */

import { Decimal } from 'decimal.js';
import { computeServerDay } from './server-day';

export type FillSide = 'buy' | 'sell';

/**
 * The minimal fill shape block derivation needs. `id` is the fill's true
 * sort/dedup key — §4.2 says "ordered by filled_at, id," which only makes
 * sense once a fill has a real, stable identifier (a fixture's
 * `input.json` has no `id` yet, since that's assigned at DB-insert time
 * per 00-foundation §2.1/§2.2 — the golden-fixture test harness assigns a
 * deterministic synthetic id per fixture fill before calling this
 * function, matching how the real sync pipeline would call it after
 * insert, per Module 02 §4.1 step 6 ("Recompute blocks for touched
 * (account, instrument) spans" — operating on already-inserted rows)).
 *
 * `volume` is a decimal string (`numeric(20,8)` text form), never a JS
 * `number` — see this file's header comment.
 */
export interface BlockDerivationFill {
  id: string;
  accountId: string;
  instrument: string;
  side: FillSide;
  volume: string;
  filledAt: string; // ISO-8601 timestamptz
}

export interface DerivedBlock {
  accountId: string;
  instrument: string;
  openedAt: string;
  /** null while net position is non-zero (matches `blocks.closed_at`'s own nullability). */
  closedAt: string | null;
  /** `server_day(openedAt)` — the `blocks` table DDL comment: "of opened_at." Fixed at open, never re-derived. */
  serverDay: string;
}

/**
 * One fill's contribution to one block. A normal fill produces exactly
 * one assignment. A flip fill (crosses zero within itself) produces
 * exactly two — one closing the old block, one opening the new one — per
 * §4.2's "split across both blocks proportionally." `appliedVolume` and
 * `runningAfter` are decimal strings for the same exact-arithmetic reason
 * as `volume` above.
 */
export interface FillBlockAssignment {
  fillId: string;
  blockIndex: number; // index into the `blocks` array returned alongside this
  appliedVolume: string;
  runningAfter: string;
}

export interface BlockDerivationResult {
  blocks: DerivedBlock[];
  assignments: FillBlockAssignment[];
}

function signedVolume(fill: BlockDerivationFill): Decimal {
  const magnitude = new Decimal(fill.volume);
  // Real bug found by retrospeq-security-reviewer (2026-08-22), verified
  // directly against decimal.js: `new Decimal('NaN')` does NOT throw, and
  // `isNegative()`/`isZero()`/`isPositive()` are all `false` for it — so
  // a NaN volume silently passed the guard below when it only checked
  // those two, then poisoned `running` (`5 + NaN = NaN`), which never
  // returns to zero — a block would silently never close instead of
  // failing loudly as this function's own error message promises.
  // `numeric` in Postgres genuinely accepts `NaN` as a value (no CHECK
  // constraint on `fills.volume` rules it out), so this isn't
  // hypothetical. `isFinite()` catches NaN and (defensively) Infinity in
  // one check — decimal.js's own docs: false for NaN and ±Infinity, true
  // otherwise.
  if (!magnitude.isFinite() || magnitude.isNegative() || magnitude.isZero()) {
    throw new Error(
      `deriveBlocks: fill ${fill.id} has a non-positive-finite volume "${fill.volume}" — a fill's printed volume must always be a positive, finite magnitude; direction comes from \`side\`.`,
    );
  }
  return fill.side === 'buy' ? magnitude : magnitude.negated();
}

function sign(d: Decimal): -1 | 0 | 1 {
  if (d.isZero()) return 0;
  return d.isPositive() ? 1 : -1;
}

/**
 * Defensive re-run safety (Module 02 §7.2 "Re-running sync over an
 * overlapping window changes nothing" / 00-foundation §6.4 idempotency):
 * a caller that accidentally passes the same physical fill twice (e.g.
 * two overlapping fetch windows, before any DB-level
 * `on conflict (account_id, provider_ref) do nothing` dedup has run) must
 * not have that fill's volume counted twice. Fills are keyed on `id`
 * (the true row identity once inserted) — an exact duplicate (identical
 * content) is silently collapsed to one; a same-id fill with DIFFERENT
 * content is a genuine data-integrity violation (`fills` is append-only —
 * 00-foundation §2.4 — so two different payloads can never legitimately
 * share one id) and is rejected loudly rather than silently picking one,
 * per AGENTS.md's "never fake it."
 */
function dedupeById(fills: BlockDerivationFill[]): BlockDerivationFill[] {
  const byId = new Map<string, BlockDerivationFill>();
  for (const fill of fills) {
    const existing = byId.get(fill.id);
    if (!existing) {
      byId.set(fill.id, fill);
      continue;
    }
    const same =
      existing.accountId === fill.accountId &&
      existing.instrument === fill.instrument &&
      existing.side === fill.side &&
      existing.volume === fill.volume &&
      existing.filledAt === fill.filledAt;
    if (!same) {
      throw new Error(
        `deriveBlocks: fill id ${fill.id} appears twice with different content — fills are append-only and immutable, this indicates a caller bug, not legitimate re-delivery.`,
      );
    }
  }
  return [...byId.values()];
}

function compareFills(a: BlockDerivationFill, b: BlockDerivationFill): number {
  const timeDelta = new Date(a.filledAt).getTime() - new Date(b.filledAt).getTime();
  if (timeDelta !== 0) return timeDelta;
  // Tie-break on id, per §4.2 "ordered by filled_at, id" — for real rows
  // this is a UUIDv7, itself time-ordered, so this tie-break is stable
  // and matches insertion order for genuinely simultaneous fills.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function groupKey(accountId: string, instrument: string): string {
  // NUL-separated — neither account ids (UUIDs) nor instrument tickers
  // can legitimately contain a NUL byte, so this can never collide two
  // distinct (account, instrument) pairs onto the same key.
  return `${accountId} ${instrument}`;
}

/**
 * Derives flat-to-flat blocks for every (account, instrument) pair
 * present in `fills`, per Module 02 §4.2. `fills` may span multiple
 * accounts and instruments in one call (the sync pipeline recomputes "for
 * touched (account, instrument) spans," §4.1 step 6 — this function
 * accepts the touched set directly and partitions it internally, rather
 * than requiring the caller to pre-split by instrument).
 *
 * `dayRolloverForAccount` resolves each fill's account to its
 * `trading_accounts.day_rollover` string (both literal shapes —
 * `server-day.ts` handles both) — a function rather than a single string,
 * since one call may cover several accounts with different rollovers
 * (the `multi_currency` and `overnight_weekend` fixtures both exercise
 * this).
 */
export function deriveBlocks(
  fills: BlockDerivationFill[],
  dayRolloverForAccount: (accountId: string) => string,
): BlockDerivationResult {
  const deduped = dedupeById(fills);

  const groups = new Map<string, BlockDerivationFill[]>();
  for (const fill of deduped) {
    const key = groupKey(fill.accountId, fill.instrument);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(fill);
    } else {
      groups.set(key, [fill]);
    }
  }

  const blocks: DerivedBlock[] = [];
  const assignments: FillBlockAssignment[] = [];

  // Sorted group-key iteration order, purely so repeated calls on
  // identical input produce blocks in the same array order every time
  // (Module 02 §7.2 "Grouping is deterministic for identical input") —
  // `Map` iteration order otherwise follows insertion order, which is
  // caller-dependent and not itself a meaningful ordering here.
  for (const key of [...groups.keys()].sort()) {
    const groupFills = [...(groups.get(key) ?? [])].sort(compareFills);
    deriveBlocksForGroup(groupFills, dayRolloverForAccount, blocks, assignments);
  }

  return { blocks, assignments };
}

function deriveBlocksForGroup(
  fillsSorted: BlockDerivationFill[],
  dayRolloverForAccount: (accountId: string) => string,
  blocksOut: DerivedBlock[],
  assignmentsOut: FillBlockAssignment[],
): void {
  let running = new Decimal(0);
  let currentBlockIndex: number | null = null;

  for (const fill of fillsSorted) {
    const delta = signedVolume(fill);

    if (running.isZero()) {
      // "if running == 0: open new block" — §4.2, verbatim.
      currentBlockIndex = blocksOut.length;
      blocksOut.push({
        accountId: fill.accountId,
        instrument: fill.instrument,
        openedAt: fill.filledAt,
        closedAt: null,
        serverDay: computeServerDay(fill.filledAt, dayRolloverForAccount(fill.accountId)),
      });
    }

    // currentBlockIndex is guaranteed non-null here: either just opened
    // above, or carried over from a still-open block from a prior fill.
    const openIndex = currentBlockIndex as number;
    const before = running;
    const after = before.plus(delta);

    const isFlip = !before.isZero() && !after.isZero() && sign(before) !== sign(after);

    if (isFlip) {
      // §4.2: "crossing zero closes the block and opens a new one at the
      // same instant. The crossing fill is split across both blocks
      // proportionally." The portion that closes the old block is
      // exactly `-before` (the amount needed to bring running to zero);
      // algebraically the remainder (`delta - (-before)`) equals `after`
      // directly, since `before + delta = after`.
      const closingPortion = before.negated();

      assignmentsOut.push({
        fillId: fill.id,
        blockIndex: openIndex,
        appliedVolume: closingPortion.toString(),
        runningAfter: '0',
      });
      blocksOut[openIndex].closedAt = fill.filledAt;

      // Open the new block "at the same instant" — same fill's filled_at,
      // same server_day computation, on the far side of zero.
      const newIndex = blocksOut.length;
      blocksOut.push({
        accountId: fill.accountId,
        instrument: fill.instrument,
        openedAt: fill.filledAt,
        closedAt: null,
        serverDay: computeServerDay(fill.filledAt, dayRolloverForAccount(fill.accountId)),
      });
      assignmentsOut.push({
        fillId: fill.id,
        blockIndex: newIndex,
        appliedVolume: after.toString(),
        runningAfter: after.toString(),
      });

      running = after;
      currentBlockIndex = newIndex;
      continue;
    }

    // Ordinary case: the fill's full volume applies to the currently open
    // block, whether that leaves it open, closes it exactly, or (having
    // just opened it above) starts it.
    assignmentsOut.push({
      fillId: fill.id,
      blockIndex: openIndex,
      appliedVolume: delta.toString(),
      runningAfter: after.toString(),
    });

    running = after;

    if (running.isZero()) {
      // "if running == 0: close block at fill.filled_at" — §4.2, verbatim.
      blocksOut[openIndex].closedAt = fill.filledAt;
      currentBlockIndex = null;
    }
  }
  // A group whose last block never returns to zero is left with
  // `closedAt: null` — an open position at the end of the provided fill
  // window. Correct and expected (the `blocks` table DDL comment: "null
  // while net position is non-zero").
}
