import 'server-only';
import { z } from 'zod';
import type { AccountHandle, BrokerAdapter, BrokerCredentialInput, TierFlags } from './adapter';
import {
  BrokerAuthFailedError,
  BrokerCredentialTooPermissiveError,
  BrokerServerUnknownError,
  BrokerVendorUnavailableError,
} from './adapter';
import { encryptCredential, type EncryptedCredential, type MasterKeyProvider } from './envelope-encryption';

/**
 * Module 01 §4.1's connection flow, steps 2-6, as a pure-ish
 * orchestration function. Deliberately does NOT touch Postgres — no
 * `trading_accounts`/`account_credentials` INSERT happens here (steps
 * 7-10 are the call site's job, a future slice's Server Action), so this
 * stays testable without a live DB, per this task's brief.
 *
 * ```
 * 1. User submits platform + server + login + credential   (caller)
 * 2. Validate shape (no network call yet)                   <- this function, via Zod
 * 3. adapter.connect(credential)                             <- this function
 *      auth fails    -> CONNECT_AUTH_FAILED, nothing stored
 *      auth succeeds -> continue
 * 4. Read-only verification — MANDATORY, no bypass           <- enforced by
 *      (performed INSIDE adapter.connect() per its own          adapter.connect()'s
 *      interface contract — see adapter.ts's BrokerAdapter      own contract, with a
 *      doc comment)                                             defence-in-depth
 *                                                                 re-check here
 * 5. adapter.capabilities()                                  <- this function
 * 6. Encrypt (envelope, foundation §4.1) and store           <- this function encrypts;
 *                                                                 caller stores
 * 7-10. trading_accounts row, day_rollover default,          <- NOT this function
 *       enqueue import, audit log                               (call site's job)
 * ```
 *
 * Step 4 has no override anywhere in this call chain: if
 * `adapter.connect()` throws `BrokerCredentialTooPermissiveError`, or —
 * as a defence-in-depth backstop against a misbehaving adapter — returns
 * a handle with `verifiedReadonly !== true`, this function returns a
 * `CONNECT_CREDENTIAL_TOO_PERMISSIVE` failure and never calls
 * `encryptCredential`. The credential is discarded, not stored, not
 * logged (see `ConnectFailure`'s doc comment on why the failure result
 * never carries the credential value).
 */

// ---------------------------------------------------------------------
// Input validation (step 2) — reused client and server side per
// AGENTS.md "Zod schemas at every API/Server Action boundary."
// ---------------------------------------------------------------------

// `z.strictObject`, not `z.object` — flagged as a FAIL by
// retrospeq-security-reviewer (2026-08-20): plain `z.object()` silently
// *strips* unrecognized keys rather than rejecting them, which
// contradicts 00-foundation §4.2's explicit "reject unknown keys" and
// AGENTS.md's security-bar checklist, verbatim. Verified directly
// against this repo's zod@4.4.3: `z.object()` returns `success: true`
// with the extra key dropped; `z.strictObject()` returns `success:
// false` with an `unrecognized_keys` issue — see
// `lib/broker/__tests__/connect.test.ts`'s regression test for this.
export const connectTradingAccountInputSchema = z.strictObject({
  platform: z.enum(['mt4', 'mt5', 'ctrader', 'binance', 'bybit', 'manual']),
  server: z.string().min(1).max(200).optional(),
  login: z.string().min(1).max(100).optional(),
  // The secret itself. No further shape validation beyond non-empty —
  // this function must never branch on, log, or echo its contents.
  credential: z.string().min(1),
  credentialKind: z.enum(['investor_password', 'api_key', 'vendor_token']),
}) satisfies z.ZodType<BrokerCredentialInput>;

export type ConnectTradingAccountInput = z.infer<typeof connectTradingAccountInputSchema>;

/** Thrown when `connectTradingAccount`'s input fails shape validation
 *  (00-foundation §6.1's `validation` category — an inline field error
 *  at the call site, not one of the `integration`-category
 *  `ConnectFailure` codes below, which are broker-side outcomes). */
export class ConnectInputValidationError extends Error {
  readonly issues: z.ZodError['issues'];

  constructor(zodError: z.ZodError) {
    super(`Invalid trading-account connect input: ${zodError.issues.map((i) => i.message).join('; ')}`);
    this.name = 'ConnectInputValidationError';
    this.issues = zodError.issues;
  }
}

// ---------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------

export type ConnectFailureCode =
  | 'CONNECT_AUTH_FAILED'
  | 'CONNECT_CREDENTIAL_TOO_PERMISSIVE'
  | 'CONNECT_SERVER_UNKNOWN'
  | 'CONNECT_VENDOR_UNAVAILABLE';

/**
 * Never carries the credential value or any adapter-supplied detail
 * string that might embed it — `userMessage` is always one of Module 01
 * §9's fixed, pre-written strings, never adapter output passed through.
 * This is what makes "no credential in errors" (Module 01 §7.2)
 * mechanically true for this function rather than a convention someone
 * has to remember.
 */
export interface ConnectFailure {
  ok: false;
  code: ConnectFailureCode;
  userMessage: string;
  retryable: boolean;
}

/**
 * What the call site should persist (steps 7-10 of Module 01 §4.1 —
 * `trading_accounts` row, `day_rollover` default, enqueue import, audit
 * log). `encrypted` is ready to write directly into
 * `account_credentials`'s ciphertext/wrapped_dek/iv/auth_tag/kms_key_id
 * columns; `capabilities` informs `trading_accounts.sync_tier`/
 * `capabilities`. This function does not perform that write.
 *
 * IMPORTANT for whoever writes that call site: the `account_credentials`
 * INSERT must go through the service-role client
 * (`lib/supabase/service.ts`), not the caller's own RLS-scoped session,
 * and must NOT chain `.select()`/use `RETURNING` — see
 * docs/adr/0005-account-credentials-writes-via-service-role.md for the
 * verified Postgres RLS behavior that makes both of those necessary
 * (not a style preference). The same applies to the eventual disconnect
 * flow's DELETE.
 */
export interface ConnectSuccess {
  ok: true;
  handle: AccountHandle;
  capabilities: TierFlags;
  encrypted: EncryptedCredential;
  /** Always `true` — a `ConnectSuccess` cannot exist otherwise. */
  verifiedReadonly: true;
}

export type ConnectResult = ConnectSuccess | ConnectFailure;

const USER_MESSAGES: Record<ConnectFailureCode, { message: string; retryable: boolean }> = {
  // Module 01 §9 error table, verbatim.
  CONNECT_AUTH_FAILED: {
    message: "Your broker didn't accept these details.",
    retryable: true,
  },
  CONNECT_CREDENTIAL_TOO_PERMISSIVE: {
    message: "That password can place trades. We didn't save it.",
    retryable: false,
  },
  CONNECT_SERVER_UNKNOWN: {
    message: "We couldn't find that server. Check the exact name in your terminal.",
    retryable: true,
  },
  CONNECT_VENDOR_UNAVAILABLE: {
    message: "We can't reach brokers right now. Your data is safe.",
    retryable: true,
  },
};

function failure(code: ConnectFailureCode): ConnectFailure {
  const { message, retryable } = USER_MESSAGES[code];
  return { ok: false, code, userMessage: message, retryable };
}

// ---------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------

/**
 * @param adapter A `BrokerAdapter` implementation. There is no default —
 *   callers must explicitly wire in either a real per-vendor adapter
 *   (none exists yet) or, for tests/dev, `createFixtureBrokerAdapter`
 *   from `fixture-adapter.ts` — never silently.
 * @param rawInput Unvalidated input from the caller (a Server Action's
 *   form data, in the eventual UI slice). Validated here via
 *   `connectTradingAccountInputSchema`.
 * @param masterKeyProvider Envelope-encryption master key access. In
 *   production this must be `createKmsMasterKeyProvider()`
 *   (`envelope-encryption.ts`), which throws `KmsNotConfiguredError`
 *   until a real external KMS exists — this function does not catch
 *   that error, it propagates, because there is no safe fallback.
 */
export async function connectTradingAccount(
  adapter: BrokerAdapter,
  rawInput: unknown,
  masterKeyProvider: MasterKeyProvider,
): Promise<ConnectResult> {
  const parsed = connectTradingAccountInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ConnectInputValidationError(parsed.error);
  }
  const credential = parsed.data;

  let handle: AccountHandle;
  try {
    // Steps 3-4: adapter.connect() performs auth AND the mandatory
    // read-only verification internally (see adapter.ts's BrokerAdapter
    // doc comment) — there is no separate call here to "skip."
    handle = await adapter.connect(credential);
  } catch (err) {
    if (err instanceof BrokerCredentialTooPermissiveError) {
      return failure('CONNECT_CREDENTIAL_TOO_PERMISSIVE');
    }
    if (err instanceof BrokerAuthFailedError) {
      return failure('CONNECT_AUTH_FAILED');
    }
    if (err instanceof BrokerServerUnknownError) {
      return failure('CONNECT_SERVER_UNKNOWN');
    }
    if (err instanceof BrokerVendorUnavailableError) {
      return failure('CONNECT_VENDOR_UNAVAILABLE');
    }
    // Anything else is an unmapped/unexpected adapter failure —
    // 00-foundation §6.1's `internal` category is the caller's
    // responsibility (generic message + incident id); this function
    // does not invent a code for a failure mode it doesn't recognise.
    throw err;
  }

  // Defence in depth (see this file's header comment): even if a
  // misbehaving adapter implementation returns a handle without
  // throwing, refuse to proceed unless it explicitly proved read-only.
  // Step 4 has no override — Module 01 §4.1.
  if (!handle.verifiedReadonly) {
    return failure('CONNECT_CREDENTIAL_TOO_PERMISSIVE');
  }

  // Step 5.
  const capabilities = await adapter.capabilities(handle);

  // Step 6: envelope-encrypt. Propagates KmsNotConfiguredError as-is
  // when no real KMS is wired in — never falls back to storing anything
  // in a lesser form.
  const encrypted = await encryptCredential(credential.credential, masterKeyProvider);

  return {
    ok: true,
    handle,
    capabilities,
    encrypted,
    verifiedReadonly: true,
  };
}
