'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import { toggleNotADecision, type TradeRow } from '@/lib/ingestion/corrections';
import {
  createManualTrade,
  ManualEntryInvalidTimestampsError,
  ManualEntryAccountNotFoundError,
  ManualEntryNotManualPlatformError,
  type ManualTradeResult,
} from '@/lib/ingestion/manual-entry';
import {
  splitTrade,
  joinTrades,
  resolveAmbiguousGroupingAsSingle,
  SplitTradeNotFoundError,
  SplitTradeAlreadyConfirmedError,
  SplitBoundaryNotMemberError,
  SplitBoundaryIsFirstMemberError,
  SplitBoundaryIsSyntheticEntryError,
  JoinTradeNotFoundError,
  JoinTradeAlreadyConfirmedError,
  JoinTradeDifferentBlockError,
  JoinTradeSameTradeError,
  ResolveAmbiguousGroupingNotFoundError,
  ResolveAmbiguousGroupingAlreadyConfirmedError,
  ResolveAmbiguousGroupingNotAmbiguousError,
  type SplitTradeResult,
  type JoinTradesResult,
  type ResolveAmbiguousGroupingResult,
} from '@/lib/ingestion/split-join';
import {
  confirmDay,
  ConfirmDayAccountNotFoundError,
  ConfirmDayNoEligibleTradesError,
  type ConfirmDaySuccess,
  type ConfirmDayBlockAnomalyRefusal,
} from '@/lib/ingestion/confirm';
import { isAccountOwnedByUser } from '@/lib/broker/accounts-repository';
import { withUserConnection } from '@/lib/supabase/direct';
import { writeTradeCapture, TRIM_REASONS, TRIM_REASON_FIELD_ID, type TrimReason } from '@/lib/ingestion/trade-captures';

/**
 * Module 02 Slice 7a — the Server Actions layer wiring every Module 02
 * backend write function (Slices 1-6b, all already coded, tested,
 * security-reviewed) to a real UI for the first time in this module.
 *
 * Every action here follows `app/(app)/accounts/actions.ts`'s own
 * established shape: session check (mirrors that file's `createClient()`
 * + `auth.getUser()` pattern) -> rate-limit check
 * (`lib/rate-limit/config.ts`'s new scopes for this slice) -> Zod-parse
 * the boundary input -> call the backend function -> map every thrown
 * error to a named, user-safe message (never a raw error/stack — Module
 * 02 §9's own error taxonomy, 00-foundation's "no vendor/internal error
 * string ever reaches the user") -> `revalidatePath` on `/trades`.
 *
 * **`confirmDayAction`'s ownership check is the one thing genuinely new
 * to this file, not just a repeat of `accounts/actions.ts`'s pattern:**
 * `lib/ingestion/confirm.ts`'s `confirmDay(accountId, serverDay, options)`
 * is, by its own header comment, a TRUSTED BACKEND-PROCESS transaction
 * (same posture as `sync.ts`) — it resolves `accountId` to a row and an
 * owning `user_id` but never checks that `user_id` against a caller's own
 * session, because until this slice nothing ever called it from a
 * client-reachable boundary. This Server Action is the FIRST such
 * boundary, so it is where that check has to actually live — via
 * `isAccountOwnedByUser`, the same function `disconnectAccount`/
 * `updateAccountSettings` already use for the identical reason against
 * the same table. Flagged explicitly for the security reviewer: without
 * this check, any signed-in trader could pass an arbitrary `accountId`
 * belonging to a different user and confirm/freeze THEIR day.
 *
 * **`splitTradeAction`/`joinTradesAction` need no equivalent extra
 * check** — `splitTrade`/`joinTrades` themselves take `userId` as their
 * first argument and enforce ownership internally via
 * `withUserConnection` in their own phase 1 (see `split-join.ts`'s own
 * header) before any service-role-privileged phase 2 work happens, the
 * same shape `toggleNotADecision`/`createManualTrade` already use. This
 * action passes the CALLER's own `user.id`, never a client-submitted
 * value, to that first argument — the actual security boundary is
 * already inside the backend function, this layer just can't weaken it
 * by passing the wrong id.
 *
 * **Deliberately NOT built in this slice (see PROGRESS.md / the
 * dispatch this slice was built against):** a "sync now" Server Action.
 * `lib/ingestion/sync.ts`'s `runSync` needs a real `BrokerAdapter`, and
 * no real vendor exists yet (standing infra gap, 00-foundation §10) —
 * building a client-triggered sync button today would either have to
 * fake success against the fixture adapter (silently misleading, since a
 * "sync now" tap implies talking to a real broker) or surface a
 * permanently-broken button, neither of which is honest. Deferred until
 * a real `BrokerAdapter` exists, matching AGENTS.md's "never fake it."
 *
 * **Slice 7b addition: `writeTradeCaptureAction`.** The one genuinely new
 * action in this file since Slice 7a — the close-out screen's trim-reason
 * chip row (§3.3/§5.1/§5.2). Unlike every other action here, its backend
 * call (`writeTradeCapture`, `lib/ingestion/trade-captures.ts`) takes a
 * raw `PoolClient`, not a `userId`-scoped repository function — this
 * action is therefore the one place in this file that opens its own
 * `withUserConnection` block directly, doing its own ownership check
 * (`select 1 from retrospeq.trades where id = $1 and user_id = $2`) before
 * calling it, since `trade_captures`'s own RLS policy only constrains
 * `trade_captures.user_id` (self-supplied, always correct here), not
 * whether the `trade_id` being written actually belongs to that same
 * user's own trade — see this action's own inline comment.
 *
 * **Slice 7b addition: `confirmDayAction`'s error shape now carries the
 * refusal's own detail (`gapIds`/`tradeIds`/`trades`), not just the code
 * and message.** `confirmDay()` already computed this detail (Slice 5);
 * Slice 7a's action discarded it. The close-out screen needs it to render
 * §9's "silence over wrongness" honestly — a real, working link to
 * exactly which trade is blocking, not a generic "something's wrong."
 * Purely additive (existing `code`/`user_message` fields unchanged), and
 * the values are the same already-computed, non-sensitive ids the caller
 * is already entitled to see (their own account's own trades/gaps).
 *
 * **Design-ethics fix addition (2026-08-23): `resolveAmbiguousGroupingAction`.**
 * Closes a real `.rq-btn--equal` symmetry violation retrospeq-qa flagged on
 * `GroupingChip.tsx`: Slice 7b wired "Separate" to a real, working deep
 * link but left "Same trade" permanently disabled (no backing write
 * existed). Follows this file's exact established pattern — session check,
 * rate limit, Zod-validate `tradeId`, call the backend function
 * (`resolveAmbiguousGroupingAsSingle`, `lib/ingestion/split-join.ts`), map
 * every thrown error to a named, user-safe message, `revalidatePath`. No
 * new ownership-check pattern needed — same as `splitTradeAction`/
 * `joinTradesAction` above, the backend function itself enforces ownership
 * via `withUserConnection` in its own phase 1 before this action's caller
 * id is passed through unchanged.
 */

const uuidSchema = z.uuid();

function issuesToFieldErrors(issues: z.ZodIssue[]): Partial<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '_form';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

interface ActionErrorState {
  error?: { code: string; user_message: string };
}

async function requireSessionUser(): Promise<{ id: string } | ActionErrorState> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return {
      error: { code: 'TRADE_SESSION_MISSING', user_message: 'Your session expired. Please sign in again.' },
    };
  }
  return user;
}

function isErrorState(v: { id: string } | ActionErrorState): v is ActionErrorState {
  return 'error' in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: {
      code: 'TRADE_RATE_LIMITED',
      user_message: 'Too many attempts. Please wait a few minutes and try again.',
    },
  };
}

function internalErrorState(scope: string, err: unknown): ActionErrorState {
  console.error(`[trades/actions:${scope}] unexpected error:`, err);
  return {
    error: { code: `${scope}_INTERNAL`, user_message: 'Something went wrong. Please try again.' },
  };
}

// ---------------------------------------------------------------------
// toggleNotADecisionAction — Module 02 §4.7
// ---------------------------------------------------------------------

export interface ToggleNotADecisionState {
  error?: { code: string; user_message: string };
  success?: boolean;
  value?: boolean;
}

const toggleValueSchema = z.strictObject({ value: z.enum(['true', 'false']) });

/**
 * Bound to a specific `tradeId` at the call site
 * (`toggleNotADecisionAction.bind(null, tradeId)`), same convention as
 * `updateAccountSettings`. §4.7: "Plain toggle, no reason required" —
 * available before or after freeze, so this action never checks
 * `confirmed_at` itself; `toggleNotADecision`'s own UPDATE + the freeze
 * trigger's own `not_a_decision`-only allowlist are what make that safe.
 */
export async function toggleNotADecisionAction(
  tradeId: string,
  _prevState: ToggleNotADecisionState | undefined,
  formData: FormData,
): Promise<ToggleNotADecisionState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;

  try {
    await enforceRateLimit('toggleNotADecision', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }

  const parsedTradeId = uuidSchema.safeParse(tradeId);
  const parsedValue = toggleValueSchema.safeParse({ value: formData.get('value') });
  if (!parsedTradeId.success || !parsedValue.success) {
    return { error: { code: 'TRADE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.' } };
  }

  let updated: TradeRow | null;
  try {
    updated = await toggleNotADecision(user.id, parsedTradeId.data, parsedValue.data.value === 'true');
  } catch (err) {
    return internalErrorState('TOGGLE_NOT_A_DECISION', err);
  }
  if (!updated) {
    return { error: { code: 'TRADE_NOT_FOUND', user_message: "We couldn't find that trade." } };
  }

  revalidatePath('/trades');
  return { success: true, value: updated.not_a_decision };
}

// ---------------------------------------------------------------------
// createManualTradeAction — Module 02 §4.8
// ---------------------------------------------------------------------

export interface ManualEntryActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string };
  success?: boolean;
  result?: ManualTradeResult;
}

/**
 * No manual-entry FORM exists yet (Slice 7b's job, per this slice's own
 * scope boundary) — this action is built and tested against
 * `manualTradeInputSchema` (already exported from `manual-entry.ts`)
 * ready for that future form to call, `formData`-in/`formData`-out, same
 * as `connectAccount`.
 */
export async function createManualTradeAction(
  _prevState: ManualEntryActionState | undefined,
  formData: FormData,
): Promise<ManualEntryActionState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;

  try {
    await enforceRateLimit('manualTradeEntry', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }

  const accountIdParsed = uuidSchema.safeParse(formData.get('accountId'));
  if (!accountIdParsed.success) {
    return { fieldErrors: { accountId: ['Choose an account.'] } };
  }

  const stopRaw = formData.get('stop');
  const enteredAtRaw = formData.get('enteredAt');
  const exitedAtRaw = formData.get('exitedAt');
  const rawInput = {
    instrument: formData.get('instrument'),
    direction: formData.get('direction'),
    size: formData.get('size'),
    entryPrice: formData.get('entryPrice'),
    exitPrice: formData.get('exitPrice'),
    stop: typeof stopRaw === 'string' && stopRaw.trim() !== '' ? stopRaw : null,
    enteredAt: typeof enteredAtRaw === 'string' && enteredAtRaw.trim() !== '' ? enteredAtRaw : undefined,
    exitedAt: typeof exitedAtRaw === 'string' && exitedAtRaw.trim() !== '' ? exitedAtRaw : undefined,
  };

  try {
    const result = await createManualTrade(user.id, accountIdParsed.data, rawInput);
    revalidatePath('/trades');
    return { success: true, result };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { fieldErrors: issuesToFieldErrors(err.issues) };
    }
    if (err instanceof ManualEntryInvalidTimestampsError) {
      return {
        error: { code: 'MANUAL_TRADE_INVALID', user_message: 'The exit time cannot be before the entry time.' },
      };
    }
    if (err instanceof ManualEntryAccountNotFoundError) {
      return { error: { code: 'TRADE_ACCOUNT_NOT_FOUND', user_message: "We couldn't find that account." } };
    }
    if (err instanceof ManualEntryNotManualPlatformError) {
      return {
        error: {
          code: 'MANUAL_TRADE_NOT_MANUAL_PLATFORM',
          user_message: 'Manual entry is only available for manual accounts.',
        },
      };
    }
    return internalErrorState('MANUAL_TRADE', err);
  }
}

// ---------------------------------------------------------------------
// splitTradeAction — Module 02 §4.7
// ---------------------------------------------------------------------

export interface SplitTradeActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string };
  success?: boolean;
  result?: SplitTradeResult;
}

const splitTradeInputSchema = z.strictObject({
  tradeId: z.uuid(),
  splitAtFillId: z.uuid(),
});

/**
 * No split UI control exists yet beyond the open-position grouping
 * chip's own honest-scoping decision (see `TradeListPage`'s own comment)
 * — this action is built and tested so Slice 7c's split control has a
 * working Server Action to call on day one.
 */
export async function splitTradeAction(
  _prevState: SplitTradeActionState | undefined,
  formData: FormData,
): Promise<SplitTradeActionState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;

  try {
    await enforceRateLimit('splitTrade', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }

  const parsed = splitTradeInputSchema.safeParse({
    tradeId: formData.get('tradeId'),
    splitAtFillId: formData.get('splitAtFillId'),
  });
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }

  try {
    const result = await splitTrade(user.id, parsed.data.tradeId, parsed.data.splitAtFillId);
    revalidatePath('/trades');
    return { success: true, result };
  } catch (err) {
    if (err instanceof SplitTradeNotFoundError) {
      return { error: { code: 'SPLIT_TRADE_NOT_FOUND', user_message: "We couldn't find that trade." } };
    }
    if (err instanceof SplitTradeAlreadyConfirmedError) {
      return {
        error: {
          code: 'SPLIT_TRADE_ALREADY_CONFIRMED',
          user_message: 'This trade is already confirmed and can no longer be split.',
        },
      };
    }
    if (err instanceof SplitBoundaryNotMemberError) {
      return { error: { code: 'SPLIT_BOUNDARY_NOT_MEMBER', user_message: "That fill isn't part of this trade." } };
    }
    if (err instanceof SplitBoundaryIsFirstMemberError) {
      return {
        error: {
          code: 'SPLIT_BOUNDARY_IS_FIRST_MEMBER',
          user_message: "You can't split at the trade's first fill.",
        },
      };
    }
    if (err instanceof SplitBoundaryIsSyntheticEntryError) {
      return {
        error: { code: 'SPLIT_BOUNDARY_IS_SYNTHETIC_ENTRY', user_message: "That point can't be used as a split boundary." },
      };
    }
    return internalErrorState('SPLIT_TRADE', err);
  }
}

// ---------------------------------------------------------------------
// joinTradesAction — Module 02 §4.7
// ---------------------------------------------------------------------

export interface JoinTradesActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string };
  success?: boolean;
  result?: JoinTradesResult;
}

const joinTradesInputSchema = z.strictObject({
  tradeIdA: z.uuid(),
  tradeIdB: z.uuid(),
});

export async function joinTradesAction(
  _prevState: JoinTradesActionState | undefined,
  formData: FormData,
): Promise<JoinTradesActionState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;

  try {
    await enforceRateLimit('joinTrades', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }

  const parsed = joinTradesInputSchema.safeParse({
    tradeIdA: formData.get('tradeIdA'),
    tradeIdB: formData.get('tradeIdB'),
  });
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }

  try {
    const result = await joinTrades(user.id, parsed.data.tradeIdA, parsed.data.tradeIdB);
    revalidatePath('/trades');
    return { success: true, result };
  } catch (err) {
    if (err instanceof JoinTradeNotFoundError) {
      return { error: { code: 'JOIN_TRADE_NOT_FOUND', user_message: "We couldn't find that trade." } };
    }
    if (err instanceof JoinTradeAlreadyConfirmedError) {
      return {
        error: {
          code: 'JOIN_TRADE_ALREADY_CONFIRMED',
          user_message: 'A trade is already confirmed and can no longer be joined.',
        },
      };
    }
    if (err instanceof JoinTradeDifferentBlockError) {
      return {
        error: { code: 'JOIN_TRADE_DIFFERENT_BLOCK', user_message: 'Only trades from the same position can be joined.' },
      };
    }
    if (err instanceof JoinTradeSameTradeError) {
      return { error: { code: 'JOIN_TRADE_SAME_TRADE', user_message: "Choose two different trades to join." } };
    }
    return internalErrorState('JOIN_TRADES', err);
  }
}

// ---------------------------------------------------------------------
// resolveAmbiguousGroupingAction — Module 02 §4.3/§4.7 design-ethics fix,
// 2026-08-23 (see this file's header)
// ---------------------------------------------------------------------

export interface ResolveAmbiguousGroupingActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string };
  success?: boolean;
  result?: ResolveAmbiguousGroupingResult;
}

const resolveAmbiguousGroupingInputSchema = z.strictObject({
  tradeId: z.uuid(),
});

/**
 * Bound to a specific `tradeId` at the call site
 * (`resolveAmbiguousGroupingAction.bind(null, tradeId)`), same convention
 * as `toggleNotADecisionAction`/`writeTradeCaptureAction`. `GroupingChip`'s
 * "Same trade" button submits this action with no other fields — the
 * whole point of this operation is that it resolves the grouping VERDICT
 * on an already-correctly-grouped trade, never restructures membership,
 * so there is no boundary/counterpart id to collect from the trader.
 */
export async function resolveAmbiguousGroupingAction(
  tradeId: string,
  _prevState: ResolveAmbiguousGroupingActionState | undefined,
  _formData: FormData,
): Promise<ResolveAmbiguousGroupingActionState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;

  try {
    await enforceRateLimit('resolveAmbiguousGrouping', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }

  const parsed = resolveAmbiguousGroupingInputSchema.safeParse({ tradeId });
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }

  try {
    const result = await resolveAmbiguousGroupingAsSingle(user.id, parsed.data.tradeId);
    revalidatePath('/trades');
    return { success: true, result };
  } catch (err) {
    if (err instanceof ResolveAmbiguousGroupingNotFoundError) {
      return { error: { code: 'RESOLVE_GROUPING_NOT_FOUND', user_message: "We couldn't find that trade." } };
    }
    if (err instanceof ResolveAmbiguousGroupingAlreadyConfirmedError) {
      return {
        error: {
          code: 'RESOLVE_GROUPING_ALREADY_CONFIRMED',
          user_message: 'This trade is already confirmed and its grouping can no longer be changed.',
        },
      };
    }
    if (err instanceof ResolveAmbiguousGroupingNotAmbiguousError) {
      return {
        error: {
          code: 'RESOLVE_GROUPING_NOT_AMBIGUOUS',
          user_message: 'This trade no longer needs a grouping decision.',
        },
      };
    }
    return internalErrorState('RESOLVE_AMBIGUOUS_GROUPING', err);
  }
}

// ---------------------------------------------------------------------
// confirmDayAction — Module 02 §4.6
// ---------------------------------------------------------------------

export interface ConfirmDayActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: {
    code: string;
    user_message: string;
    /** Only set when `code === 'CONFIRM_DAY_COVERAGE_GAP'`. */
    gapIds?: string[];
    /** Only set when `code === 'CONFIRM_DAY_AMBIGUOUS_GROUPING'`. */
    tradeIds?: string[];
    /** Only set when `code === 'CONFIRM_DAY_UNRESOLVED_BLOCK_ANOMALY'`. */
    trades?: ConfirmDayBlockAnomalyRefusal['trades'];
  };
  success?: boolean;
  result?: ConfirmDaySuccess;
}

const confirmDayInputSchema = z.strictObject({
  accountId: z.uuid(),
  serverDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date like 2026-08-01.'),
  kind: z.enum(['traded', 'deliberate_no_trade']).optional(),
});

/**
 * No close-out screen exists yet (Module 06's job, per this slice's own
 * scope boundary) — this action is built and tested so that screen has
 * a working Server Action to call on day one. See this file's header for
 * why the `isAccountOwnedByUser` check below is the one genuinely new
 * security-relevant addition in this file, not boilerplate.
 */
export async function confirmDayAction(
  _prevState: ConfirmDayActionState | undefined,
  formData: FormData,
): Promise<ConfirmDayActionState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;

  try {
    await enforceRateLimit('confirmDay', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }

  const kindRaw = formData.get('kind');
  const parsed = confirmDayInputSchema.safeParse({
    accountId: formData.get('accountId'),
    serverDay: formData.get('serverDay'),
    kind: typeof kindRaw === 'string' && kindRaw.trim() !== '' ? kindRaw : undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }

  // See this file's header: confirmDay() itself is a trusted-backend-process
  // transaction that never checks caller ownership of accountId — this
  // Server Action is the first client-reachable boundary in front of it,
  // so ownership has to be verified here, same as disconnectAccount /
  // updateAccountSettings already do for trading_accounts.
  const owned = await isAccountOwnedByUser(user.id, parsed.data.accountId);
  if (!owned) {
    return { error: { code: 'TRADE_ACCOUNT_NOT_FOUND', user_message: "We couldn't find that account." } };
  }

  try {
    const result = await confirmDay(
      parsed.data.accountId,
      parsed.data.serverDay,
      parsed.data.kind ? { kind: parsed.data.kind } : {},
    );
    if (!result.confirmed) {
      const code = `CONFIRM_DAY_${result.code}`;
      if (result.code === 'COVERAGE_GAP') {
        return { error: { code, user_message: result.message, gapIds: result.gapIds } };
      }
      if (result.code === 'AMBIGUOUS_GROUPING') {
        return { error: { code, user_message: result.message, tradeIds: result.tradeIds } };
      }
      return { error: { code, user_message: result.message, trades: result.trades } };
    }
    revalidatePath('/trades');
    revalidatePath('/trades/close-out');
    return { success: true, result };
  } catch (err) {
    if (err instanceof ConfirmDayAccountNotFoundError) {
      return { error: { code: 'TRADE_ACCOUNT_NOT_FOUND', user_message: "We couldn't find that account." } };
    }
    if (err instanceof ConfirmDayNoEligibleTradesError) {
      return {
        error: {
          code: 'CONFIRM_DAY_NO_TRADES',
          user_message: 'Say whether this was a deliberate no-trade day before confirming.',
        },
      };
    }
    return internalErrorState('CONFIRM_DAY', err);
  }
}

// ---------------------------------------------------------------------
// writeTradeCaptureAction — Module 02 §3.3/§4.5's trade_captures write
// path, wired here for the close-out screen's trim-reason chip row
// (Slice 7b). See this file's header for why this action opens its own
// `withUserConnection` block rather than calling a repository function.
// ---------------------------------------------------------------------

export interface WriteTradeCaptureActionState {
  error?: { code: string; user_message: string };
  success?: boolean;
  value?: TrimReason;
}

const trimReasonValueSchema = z.enum(TRIM_REASONS);

/**
 * Bound to a specific `tradeId` at the call site
 * (`writeTradeCaptureAction.bind(null, tradeId)`), same convention as
 * `toggleNotADecisionAction`. Only ever writes the built-in
 * `TRIM_REASON_FIELD_ID` (see `lib/ingestion/trade-captures.ts`'s own
 * header for why this is a literal, not a registry-defined, field id) at
 * `moment: 'post_close'` — §3.3: "one tap, fixed options, always
 * skippable," so this is never called on skip, only on a real chip tap.
 */
export async function writeTradeCaptureAction(
  tradeId: string,
  _prevState: WriteTradeCaptureActionState | undefined,
  formData: FormData,
): Promise<WriteTradeCaptureActionState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;

  try {
    await enforceRateLimit('writeTradeCapture', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }

  const parsedTradeId = uuidSchema.safeParse(tradeId);
  const parsedValue = trimReasonValueSchema.safeParse(formData.get('reason'));
  if (!parsedTradeId.success || !parsedValue.success) {
    return { error: { code: 'TRADE_CAPTURE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.' } };
  }

  try {
    // trade_captures's own RLS policy (`trade_captures_owner`) only
    // constrains `trade_captures.user_id`, which we always supply as the
    // caller's own session id — it has no way to also constrain whether
    // `trade_id` belongs to that same user's own trade (no FK ties
    // trade_captures.user_id to trades.user_id). This explicit ownership
    // check is therefore the real security boundary here, same posture
    // as `confirmDayAction`'s own `isAccountOwnedByUser` call above.
    const result = await withUserConnection(user.id, async (client) => {
      const ownedRes = await client.query('select 1 from retrospeq.trades where id = $1 and user_id = $2', [
        parsedTradeId.data,
        user.id,
      ]);
      if ((ownedRes.rowCount ?? 0) === 0) return null;
      return writeTradeCapture(client, {
        tradeId: parsedTradeId.data,
        userId: user.id,
        fieldId: TRIM_REASON_FIELD_ID,
        value: parsedValue.data,
        moment: 'post_close',
      });
    });

    if (result === null) {
      return { error: { code: 'TRADE_NOT_FOUND', user_message: "We couldn't find that trade." } };
    }
    if (!result.applied) {
      // Structurally should not happen for trim_reason (always written at
      // moment 'post_close', never 'pre_entry') — handled anyway per this
      // repo's "should be structurally impossible, still handled" posture.
      return { error: { code: 'TRADE_CAPTURE_LOCKED', user_message: 'This value can no longer be changed.' } };
    }

    revalidatePath('/trades');
    revalidatePath('/trades/close-out');
    return { success: true, value: parsedValue.data };
  } catch (err) {
    return internalErrorState('WRITE_TRADE_CAPTURE', err);
  }
}
