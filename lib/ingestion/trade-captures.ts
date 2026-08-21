import 'server-only';
import type { PoolClient } from 'pg';

/**
 * Module 02 (Trade Ingestion & Model) §4.5's second paragraph — the
 * pre-entry lock:
 *
 * "On match, `trade_captures` rows for `moment = 'pre_entry'` are written
 * and become immutable. Any later fill of a pre-entry field is written
 * with `captured_late = true` and excluded from judgment findings by
 * default."
 *
 * And §4.7's corrections table: "Edit pre-entry captures | Never after
 * lock | Late fills marked `captured_late`."
 *
 * ## The one real design tension worth recording (00-foundation §12)
 *
 * `retrospeq.trade_captures`'s primary key is `(trade_id, field_id)` —
 * NOT `(trade_id, field_id, moment)` (Module 02 §3.1's own literal DDL;
 * confirmed directly against `supabase/migrations/20260822010000_ingestion_schema.sql`).
 * There is exactly one row per field per trade, ever, regardless of
 * moment. That makes "never after lock" enforceable at the row level in
 * the simplest possible way: once a `(trade_id, field_id)` row exists
 * with `moment = 'pre_entry'`, this file's `writeTradeCapture` REJECTS
 * every subsequent write attempt for that same pair outright (a no-op —
 * `applied: false`), never overwriting the value, never changing its
 * `moment`, and never incrementing `edit_count`. This is the literal,
 * conservative reading of "never after lock" the schema actually supports
 * — there is no separate append-only log of rejected/late attempts for
 * this table (nothing in Module 02 §3.1's DDL provides one), so a
 * rejected write is simply not persisted, matching 00-foundation §6.2's
 * "silence over wrongness" posture applied here to a write path rather
 * than a read path. `captured_late` in this file's own vocabulary is
 * reserved for the (distinct, not this file's job to detect) case of a
 * genuinely NEW capture arriving after its own natural moment has passed
 * but BEFORE any lock exists for that field — a future write path
 * (Module 03/06's capture UI) sets it explicitly via `capturedLate` when
 * it knows that's the case; this file only enforces the lock, it doesn't
 * infer lateness on its own.
 *
 * ## Why this exists as a standalone module, not inlined in `sync.ts`
 *
 * `lockPreEntryCaptures` is called from `sync.ts`'s Step 8 hook (on a
 * fresh `arm_events` match), but `writeTradeCapture` is the general
 * invariant every FUTURE write path into this table must also go through
 * — no other write path exists in this repo yet (this is genuinely the
 * first code that writes to `trade_captures`), so there is nothing to
 * retrofit, but the next one (an in-trade/post-close capture Server
 * Action, Module 03/06 territory) should import `writeTradeCapture`
 * rather than hand-rolling its own INSERT.
 */

export interface WriteTradeCaptureParams {
  tradeId: string;
  userId: string;
  fieldId: string;
  /** Any JSON-serialisable capture value — the column is `jsonb`. */
  value: unknown;
  moment: 'pre_entry' | 'in_trade' | 'post_close';
  /** Default `false`. See this file's header re: when a caller should set this explicitly. */
  capturedLate?: boolean;
}

export type WriteTradeCaptureResult =
  | { applied: true; created: boolean }
  | { applied: false; reason: 'pre_entry_locked' };

/**
 * The one write path into `trade_captures`, enforcing the pre-entry lock
 * invariant. `client` must already be inside the caller's own transaction
 * (this function issues no `BEGIN`/`COMMIT` of its own) — matches
 * `sync.ts`'s `recomputeInstrument` convention of taking a `PoolClient`
 * rather than opening its own connection.
 */
export async function writeTradeCapture(
  client: Pick<PoolClient, 'query'>,
  params: WriteTradeCaptureParams,
): Promise<WriteTradeCaptureResult> {
  const existing = await client.query<{ moment: string }>(
    `select moment from retrospeq.trade_captures where trade_id = $1 and field_id = $2`,
    [params.tradeId, params.fieldId],
  );

  if (existing.rows[0]?.moment === 'pre_entry') {
    // "Never after lock" -- reject outright, never silently overwrite,
    // regardless of what `params.moment` on THIS attempt is.
    return { applied: false, reason: 'pre_entry_locked' };
  }

  const res = await client.query<{ inserted: boolean }>(
    `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment, captured_late, edit_count, updated_at)
     values ($1, $2, $3, $4::jsonb, $5, $6, 0, now())
     on conflict (trade_id, field_id) do update set
       value = excluded.value,
       moment = excluded.moment,
       captured_late = excluded.captured_late,
       edit_count = retrospeq.trade_captures.edit_count + 1,
       updated_at = now()
     returning (xmax = 0) as inserted`,
    [params.tradeId, params.userId, params.fieldId, JSON.stringify(params.value), params.moment, params.capturedLate ?? false],
  );

  return { applied: true, created: res.rows[0]?.inserted === true };
}

export interface LockPreEntryCapturesParams {
  tradeId: string;
  userId: string;
  /** `arm_events.captures` — `{ field_id: value }`. */
  captures: Record<string, unknown>;
}

/**
 * §4.5's "on match, `trade_captures` rows for `moment = 'pre_entry'` are
 * written and become immutable." Called exactly once per successful
 * `arm_events` match, from `sync.ts`'s Step 8 hook. Returns the field ids
 * actually locked (a field id already locked from some earlier call —
 * should not happen in practice for a freshly-matched trade, since a
 * trade only ever matches one `arm_events` row, but this function is
 * defensive rather than assuming that invariant holds forever) is
 * reported via `writeTradeCapture`'s `applied: false` and simply
 * excluded from the returned list, never silently treated as a success.
 */
export async function lockPreEntryCaptures(
  client: Pick<PoolClient, 'query'>,
  params: LockPreEntryCapturesParams,
): Promise<string[]> {
  const lockedFieldIds: string[] = [];
  for (const [fieldId, value] of Object.entries(params.captures)) {
    const result = await writeTradeCapture(client, {
      tradeId: params.tradeId,
      userId: params.userId,
      fieldId,
      value,
      moment: 'pre_entry',
      capturedLate: false,
    });
    if (result.applied) lockedFieldIds.push(fieldId);
  }
  return lockedFieldIds;
}
