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
  SplitTradeNotFoundError,
  SplitTradeAlreadyConfirmedError,
  SplitBoundaryNotMemberError,
  SplitBoundaryIsFirstMemberError,
  SplitBoundaryIsSyntheticEntryError,
  JoinTradeNotFoundError,
  JoinTradeAlreadyConfirmedError,
  JoinTradeDifferentBlockError,
  JoinTradeSameTradeError,
  type SplitTradeResult,
  type JoinTradesResult,
} from '@/lib/ingestion/split-join';
import {
  confirmDay,
  ConfirmDayAccountNotFoundError,
  ConfirmDayNoEligibleTradesError,
  type ConfirmDaySuccess,
} from '@/lib/ingestion/confirm';
import { isAccountOwnedByUser } from '@/lib/broker/accounts-repository';

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
// confirmDayAction — Module 02 §4.6
// ---------------------------------------------------------------------

export interface ConfirmDayActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string };
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
      return { error: { code: `CONFIRM_DAY_${result.code}`, user_message: result.message } };
    }
    revalidatePath('/trades');
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
