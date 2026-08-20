'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import {
  connectTradingAccount,
  connectTradingAccountInputSchema,
  ConnectInputValidationError,
  type ConnectFailureCode,
} from '@/lib/broker/connect';
import {
  createFixtureBrokerAdapter,
  type FixtureAdapterBehavior,
} from '@/lib/broker/fixture-adapter';
import {
  createKmsMasterKeyProvider,
  KmsNotConfiguredError,
  type MasterKeyProvider,
} from '@/lib/broker/envelope-encryption';
import type { Platform, TierFlags } from '@/lib/broker/adapter';
import {
  credentialKindForPlatform,
  defaultBaseCurrencyForPlatform,
  defaultDayRolloverForPlatform,
  defaultLabelForPlatform,
} from '@/lib/broker/platform-defaults';
import {
  DuplicateAccountError,
  deleteAccountCredential,
  deleteTradingAccount,
  insertAccountCredential,
  insertTradingAccount,
  isAccountOwnedByUser,
  markAccountDisconnected,
  updateTradingAccountSettings,
  updateTradingAccountSettingsInputSchema,
  type TradingAccountRow,
} from '@/lib/broker/accounts-repository';
import { canForUser } from '@/lib/entitlements/service';
import { accountConnectLimitMessage } from '@/lib/entitlements/messages';

/**
 * Module 01 stories 2.x — the Server Action layer wiring `lib/broker/connect.ts`'s
 * orchestration to a real database write, per this slice's dispatch and
 * docs/adr/0005 / docs/adr/0006.
 *
 * NO REAL BROKER VENDOR EXISTS YET (PROGRESS.md "Infra gaps" / 00-foundation
 * §10.1). `connectAccount` below only ever constructs
 * `createFixtureBrokerAdapter` (`lib/broker/fixture-adapter.ts`) — a
 * deterministic, clearly-named, test/dev-only adapter, never a stand-in
 * silently presented as a real broker (AGENTS.md "When something needs
 * the owner — never fake it, always flag it"). It still exercises the
 * whole connect flow honestly, including the mandatory
 * too-permissive-credential rejection (`pickFixtureBehavior` below).
 *
 * ALSO NO REAL KMS EXISTS YET. `createKmsMasterKeyProvider()`
 * (`lib/broker/envelope-encryption.ts`) throws `KmsNotConfiguredError`
 * unconditionally until a real external KMS vendor is wired in. That
 * means every CREDENTIALED connect attempt (MT4/MT5/cTrader/Binance/
 * Bybit) that gets past broker auth + the read-only check will currently
 * fail at the encryption step, before any row is written — caught below
 * and surfaced as a named, non-retryable error, never faked as a
 * success. Only `manual` accounts (no credential, no encryption) can
 * complete end-to-end today. This is the same standing infra gap
 * PROGRESS.md already tracks, not a new one introduced by this slice.
 *
 * Module 01 story 4.4 (this repo's plan/entitlement slice) added a real
 * server-side `account.connect` cap check here — see
 * `lib/entitlements/service.ts`'s `canForUser`, applied before either
 * the manual or credentialed branch below, so a free-plan trader cannot
 * connect a second account by any path through this action.
 */

export interface AccountActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  message?: string;
  capabilities?: TierFlags;
  /** True only for `connectManualAccount`'s success path. Lets the UI
   *  distinguish "this broker doesn't expose this capability" from
   *  "there is no broker at all" — flagged by retrospeq-qa (2026-08-20):
   *  the success screen was showing "Not available on this broker" for
   *  every unavailable capability even in manual mode, which is
   *  inaccurate (there's no broker to blame). */
  isManual?: boolean;
}

/** Zod's own shape for the connect form's non-credential fields, reused
 *  before ever constructing a `BrokerCredentialInput` (00-foundation
 *  §4.2: validate at the boundary before doing anything with the input). */
const platformFieldSchema = z.enum(['mt4', 'mt5', 'ctrader', 'binance', 'bybit', 'manual']);

function issuesToFieldErrors(issues: z.ZodIssue[]): Partial<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '_form';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * DEV-ONLY placeholder standing in for a real vendor's own credential-
 * permission inspection (Module 01 §4.1 step 4 / story 2.2/2.3) — the
 * fixture adapter (`lib/broker/fixture-adapter.ts`) does not itself
 * inspect the submitted credential, its `connect()` just returns whatever
 * `behavior` it was constructed with. Since this slice has no real
 * vendor to ask, this heuristic lets the connect screen be genuinely
 * exercised end-to-end (including the mandatory rejection alert) rather
 * than only ever simulating success. NEVER treat this as real security
 * logic — a real adapter's `connect()` inspects actual vendor-reported
 * account permissions, not credential text.
 */
function pickFixtureBehavior(credential: string, server: string | undefined): FixtureAdapterBehavior {
  const c = credential.toLowerCase();
  if (c.includes('master')) return 'credential_too_permissive';
  if (c.includes('wrongpass')) return 'auth_failed';
  if (c.includes('vendordown')) return 'vendor_unavailable';
  if ((server ?? '').toLowerCase().includes('unknownserver')) return 'server_unknown';
  return 'connect_ok';
}

/**
 * `createKmsMasterKeyProvider()` throws `KmsNotConfiguredError`
 * unconditionally (no real KMS yet — see this file's header comment).
 * Calling it eagerly as an argument to `connectTradingAccount(adapter,
 * input, createKmsMasterKeyProvider())` would throw BEFORE
 * `connectTradingAccount` ever runs — since JS evaluates arguments
 * before the call — which would short-circuit Module 01 §4.1 steps 3-4
 * (auth + the mandatory read-only check) for every credentialed connect
 * attempt, masking `CONNECT_AUTH_FAILED`/`CONNECT_CREDENTIAL_TOO_PERMISSIVE`/
 * etc. behind a KMS error even when the adapter would have rejected the
 * credential anyway. This lazy wrapper defers the real
 * `createKmsMasterKeyProvider()` call (and therefore the throw) until
 * `wrapDataKey`/`unwrapDataKey` is actually invoked — which only happens
 * inside `connectTradingAccount`'s own step 6, AFTER steps 3-4 already
 * succeeded — so every earlier failure mode still surfaces correctly,
 * and only a genuinely-would-have-succeeded connect ever reaches (and
 * is honestly blocked by) the missing-KMS wall. Caught this via the
 * screenshot self-check: a "this-is-my-master-password" submission was
 * incorrectly surfacing `CONNECT_KMS_NOT_CONFIGURED` instead of the
 * mandatory `CONNECT_CREDENTIAL_TOO_PERMISSIVE` rejection before this fix.
 */
function lazyKmsMasterKeyProvider(): MasterKeyProvider {
  return {
    wrapDataKey: (dataKey) => createKmsMasterKeyProvider().wrapDataKey(dataKey),
    unwrapDataKey: (wrappedDek, kmsKeyId) =>
      createKmsMasterKeyProvider().unwrapDataKey(wrappedDek, kmsKeyId),
  };
}

function connectFailureToState(code: ConnectFailureCode, userMessage: string, retryable: boolean): AccountActionState {
  return { error: { code, user_message: userMessage, retryable } };
}

function rateLimitToState(): AccountActionState {
  return {
    error: {
      code: 'ACCOUNT_RATE_LIMITED',
      user_message: 'Too many attempts. Please wait a few minutes and try again.',
      retryable: true,
    },
  };
}

/**
 * Module 01 stories 2.1-2.4, 2.7, 2.8. Manual accounts (story 2.7) skip
 * the entire adapter/encryption path — there is no credential to verify
 * or store, per spec ("Manual mode; full product minus auto-import").
 * Every other platform goes through `connectTradingAccount()`'s full
 * Module 01 §4.1 orchestration against the fixture adapter.
 */
export async function connectAccount(
  _prevState: AccountActionState | undefined,
  formData: FormData,
): Promise<AccountActionState> {
  const platformParsed = platformFieldSchema.safeParse(formData.get('platform'));
  if (!platformParsed.success) {
    return { fieldErrors: { platform: ['Choose a platform.'] } };
  }
  const platform: Platform = platformParsed.data;

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return {
      error: {
        code: 'ACCOUNT_SESSION_MISSING',
        user_message: 'Your session expired. Please sign in again.',
        retryable: false,
      },
    };
  }

  try {
    await enforceRateLimit('connectAccount', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitToState();
    throw err;
  }

  // Module 01 story 4.4: "my entitlements enforced server-side ... every
  // capability check server-side; client state advisory only." Applies
  // to EVERY platform including manual (story 2.7) — a manual account
  // still occupies an `account.connect` slot, per
  // lib/entitlements/account-usage.ts's own reasoning. Checked before
  // the manual/credentialed branch below so neither path can bypass it.
  const entitlement = await canForUser(user.id, 'account.connect');
  if (!entitlement.allowed) {
    return {
      error: {
        code: 'ENTITLEMENT_LIMIT',
        user_message:
          entitlement.limit !== null
            ? accountConnectLimitMessage(entitlement.used ?? entitlement.limit, entitlement.limit)
            : "You've reached your account connection limit.",
        retryable: false,
      },
    };
  }

  if (platform === 'manual') {
    return connectManualAccount(user.id);
  }

  const rawInput = {
    platform,
    server: (formData.get('server') as string | null)?.trim() || undefined,
    login: (formData.get('login') as string | null)?.trim() || undefined,
    credential: formData.get('credential'),
    credentialKind: credentialKindForPlatform(platform),
  };

  const parsed = connectTradingAccountInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }

  const adapter = createFixtureBrokerAdapter({
    behavior: pickFixtureBehavior(parsed.data.credential, parsed.data.server),
    providerAccountRef: parsed.data.login ?? undefined,
  });

  let result;
  try {
    result = await connectTradingAccount(adapter, parsed.data, lazyKmsMasterKeyProvider());
  } catch (err) {
    if (err instanceof ConnectInputValidationError) {
      return { fieldErrors: issuesToFieldErrors(err.issues) };
    }
    if (err instanceof KmsNotConfiguredError) {
      console.error(
        '[connectAccount] cannot complete a credentialed connect — KMS not configured:',
        err.message,
      );
      return {
        error: {
          code: 'CONNECT_KMS_NOT_CONFIGURED',
          user_message:
            "Broker connections aren't available yet — we're still setting up secure credential storage. Try manual mode instead.",
          retryable: false,
        },
      };
    }
    throw err;
  }

  if (!result.ok) {
    return connectFailureToState(result.code, result.userMessage, result.retryable);
  }

  // Module 01 §4.1 steps 7-10: create the trading_accounts row, default
  // day_rollover per platform class, store the credential. Two separate
  // direct-Postgres transactions (trading_accounts under the caller's
  // own `authenticated` role via `withUserConnection`, account_credentials
  // under `service_role` via `withServiceRoleConnection` — ADR 0005 /
  // ADR 0006), not one cross-role transaction: holding a single pg
  // client across two different `SET LOCAL ROLE` contexts mid-transaction
  // is possible but fragile to reason about correctly (role-dependent
  // RLS re-evaluation semantics), whereas a plain compensating delete on
  // failure is simple and easy to verify. If the credential insert fails
  // after the account insert succeeded, delete the orphaned
  // trading_accounts row rather than leaving a connected-looking account
  // with no stored credential.
  let accountId: string;
  try {
    const inserted = await insertTradingAccount({
      userId: user.id,
      label: defaultLabelForPlatform(platform),
      platform,
      providerRef: result.handle.providerAccountRef,
      server: parsed.data.server ?? null,
      baseCurrency: defaultBaseCurrencyForPlatform(platform),
      dayRollover: defaultDayRolloverForPlatform(platform),
      capabilities: result.capabilities,
    });
    accountId = inserted.id;
  } catch (err) {
    if (err instanceof DuplicateAccountError) {
      return {
        error: {
          code: 'CONNECT_DUPLICATE_ACCOUNT',
          user_message: err.message,
          retryable: false,
        },
      };
    }
    console.error('[connectAccount] failed to insert trading_accounts row:', err);
    return {
      error: {
        code: 'CONNECT_INTERNAL',
        user_message: 'Something went wrong saving your account. Please try again.',
        retryable: true,
      },
    };
  }

  try {
    await insertAccountCredential({
      accountId,
      userId: user.id,
      credentialKind: parsed.data.credentialKind,
      encrypted: result.encrypted,
    });
  } catch (err) {
    console.error(
      '[connectAccount] credential insert failed after account insert succeeded — deleting the orphaned trading_accounts row:',
      err,
    );
    await deleteTradingAccount(user.id, accountId).catch((cleanupErr) => {
      console.error('[connectAccount] orphan cleanup itself failed:', cleanupErr);
    });
    return {
      error: {
        code: 'CONNECT_INTERNAL',
        user_message: 'Something went wrong saving your credential. Please try again.',
        retryable: true,
      },
    };
  }

  revalidatePath('/accounts');
  return { success: true, capabilities: result.capabilities };
}

/** Story 2.7 — no adapter call, no credential, no encryption. */
async function connectManualAccount(userId: string): Promise<AccountActionState> {
  try {
    await insertTradingAccount({
      userId,
      label: defaultLabelForPlatform('manual'),
      platform: 'manual',
      providerRef: null,
      server: null,
      baseCurrency: defaultBaseCurrencyForPlatform('manual'),
      dayRollover: defaultDayRolloverForPlatform('manual'),
      capabilities: { tier: 't0', history: false, openPositions: false, positionSnapshots: false, liveSession: false },
    });
  } catch (err) {
    if (err instanceof DuplicateAccountError) {
      return { error: { code: 'CONNECT_DUPLICATE_ACCOUNT', user_message: err.message, retryable: false } };
    }
    console.error('[connectManualAccount] failed to insert trading_accounts row:', err);
    return {
      error: {
        code: 'CONNECT_INTERNAL',
        user_message: 'Something went wrong saving your account. Please try again.',
        retryable: true,
      },
    };
  }

  revalidatePath('/accounts');
  return {
    success: true,
    capabilities: { tier: 't0', history: false, openPositions: false, positionSnapshots: false, liveSession: false },
    isManual: true,
  };
}

/**
 * Module 01 story 2.5. Redirect-with-error-code on failure (same
 * pattern as `signInWithGoogle` in app/(auth)/actions.ts) rather than
 * `useActionState`, since this is a plain per-card button, not a form
 * collecting input — see app/(app)/accounts/page.tsx's call site
 * (`<form action={disconnectAccount.bind(null, account.id)}>`).
 */
export async function disconnectAccount(accountId: string, _formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  try {
    await enforceRateLimit('disconnectAccount', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      redirect('/accounts?error=ACCOUNT_RATE_LIMITED');
    }
    throw err;
  }

  // Application-layer ownership check per ADR 0005 — trading_accounts
  // has working RLS-scoped reads, unlike account_credentials.
  const owned = await isAccountOwnedByUser(user.id, accountId);
  if (!owned) {
    redirect('/accounts?error=ACCOUNT_NOT_FOUND');
  }

  // Credential destroyed first (story 2.5: "Credential destroyed
  // immediately"), via the service-role path (ADR 0005/0006) — the only
  // write path that can reach this table at all for a specific account.
  await deleteAccountCredential(accountId);
  await markAccountDisconnected(user.id, accountId);

  revalidatePath('/accounts');
  redirect('/accounts');
}

// ---------------------------------------------------------------------
// Module 01 §2 stories 3.1-3.4 — "Account settings" (rename, rollover,
// prop-challenge label). Editing already-connected accounts, not the
// connect flow above.
// ---------------------------------------------------------------------

export interface AccountSettingsActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string };
  success?: boolean;
  account?: TradingAccountRow;
}

/**
 * `useActionState`-driven (same pattern as `connectAccount`), bound to
 * `accountId` from the settings page's form `action`. Ownership is
 * enforced two ways: `updateTradingAccountSettings`'s own `WHERE id = ...
 * AND user_id = ...`, itself running under `withUserConnection` so
 * `trading_accounts_owner`'s RLS policy re-checks the same predicate —
 * a caller can never edit another user's row no matter what `accountId`
 * is submitted, matching `disconnectAccount`'s established shape rather
 * than trusting the client-submitted id alone.
 */
export async function updateAccountSettings(
  accountId: string,
  _prevState: AccountSettingsActionState | undefined,
  formData: FormData,
): Promise<AccountSettingsActionState> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return {
      error: { code: 'ACCOUNT_SESSION_MISSING', user_message: 'Your session expired. Please sign in again.' },
    };
  }

  try {
    await enforceRateLimit('accountSettings', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return {
        error: {
          code: 'ACCOUNT_RATE_LIMITED',
          user_message: 'Too many attempts. Please wait a few minutes and try again.',
        },
      };
    }
    throw err;
  }

  const parsed = updateTradingAccountSettingsInputSchema.safeParse({
    label: formData.get('label'),
    dayRollover: formData.get('dayRollover'),
    accountKind: formData.get('accountKind'),
  });
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }

  const updated = await updateTradingAccountSettings(user.id, accountId, parsed.data);
  if (!updated) {
    return {
      error: { code: 'ACCOUNT_NOT_FOUND', user_message: "We couldn't find that account." },
    };
  }

  revalidatePath('/accounts');
  revalidatePath(`/accounts/${accountId}/settings`);
  return { success: true, account: updated };
}
