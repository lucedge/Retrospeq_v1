import {
  isAuthApiError,
  isAuthWeakPasswordError,
  isAuthSessionMissingError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';

/**
 * 00-foundation §6.1's error taxonomy shape, applied to authentication.
 * The foundation doc's own `category` enum (validation | entitlement |
 * integration | conflict | internal) is reused as-is rather than
 * inventing an "auth" category — every auth failure below is a shape of
 * one of those five, chosen per the closest UI treatment in §6.1's
 * table (e.g. wrong password -> `validation` -> inline field error, no
 * toast; OAuth provider outage -> `integration` -> named and retryable).
 *
 * `detail` never contains the submitted password or a raw Supabase
 * error string shown to the user — see AGENTS.md / Module 01 §9 "No
 * vendor error string ever reaches the user."
 */
export interface AppAuthError {
  code: string;
  category: 'validation' | 'entitlement' | 'integration' | 'conflict' | 'internal';
  retryable: boolean;
  user_message: string;
  /** Machine-readable detail for logs/telemetry — never shown raw to the user. */
  detail?: string;
}

/**
 * Maps a thrown Supabase Auth error (or a Zod validation failure, or
 * anything else) to the app's stable error shape. Single entry point —
 * every Server Action in app/(auth)/actions.ts funnels its catch block
 * through this, so no call site invents its own ad hoc message.
 */
export function mapAuthError(error: unknown): AppAuthError {
  // Module 01 §7.2's mandatory app-level throttle (lib/rate-limit/) —
  // checked BEFORE any Supabase call, so this is deliberately the first
  // branch. Same code/message as Supabase's own `over_email_send_rate_limit`
  // below: from the trader's point of view "too many attempts" reads the
  // same regardless of which layer caught it.
  if (error instanceof RateLimitExceededError) {
    return {
      code: 'AUTH_RATE_LIMITED',
      category: 'integration',
      retryable: true,
      user_message: 'Too many attempts. Please wait a few minutes and try again.',
      detail: `${error.scope}:${error.identifier}`,
    };
  }

  // Thrown by e.g. `updateUser()` on the reset-password/confirm flow
  // when no recovery session is active — the reset link expired, was
  // already used, or the user landed on the page directly.
  if (isAuthSessionMissingError(error)) {
    return {
      code: 'AUTH_RESET_LINK_INVALID',
      category: 'validation',
      retryable: false,
      user_message: 'This link has expired or was already used. Request a new one.',
      detail: error.message,
    };
  }

  if (isAuthWeakPasswordError(error)) {
    return {
      code: 'AUTH_WEAK_PASSWORD',
      category: 'validation',
      retryable: true,
      user_message: 'Choose a stronger password — ' + describeWeakPasswordReasons(error.reasons),
      detail: error.message,
    };
  }

  // Found while writing this module's E2E tests (retrospeq-tester,
  // 2026-08-20): GoTrue can fail a mailer-dependent call (signUp,
  // resetPasswordForEmail) with `AuthRetryableFetchError` — e.g. "Error
  // sending confirmation email" when the project's email provider is
  // unreachable/misconfigured — which is a distinct class from
  // `AuthApiError` and was previously falling through to the generic
  // `AUTH_INTERNAL` fallback below. That produced a non-actionable
  // "Something went wrong on our end" message for what is, per
  // 00-foundation §6.1, a named `integration` failure ("Named,
  // actionable, never generic"), not an unexpected internal one — and
  // it is retryable (the mailer outage is transient), unlike most of
  // this function's other `validation`-category branches.
  if (isAuthRetryableFetchError(error)) {
    return {
      code: 'AUTH_MAILER_UNAVAILABLE',
      category: 'integration',
      retryable: true,
      user_message: "We couldn't send that email right now. Please try again shortly.",
      detail: error.message,
    };
  }

  if (isAuthApiError(error)) {
    switch (error.code) {
      case 'invalid_credentials':
      case 'user_not_found':
        return {
          code: 'AUTH_INVALID_CREDENTIALS',
          category: 'validation',
          retryable: true,
          user_message: "That email or password isn't right.",
          detail: error.code,
        };

      case 'email_exists':
      case 'user_already_exists':
        return {
          code: 'AUTH_EMAIL_ALREADY_REGISTERED',
          category: 'validation',
          retryable: false,
          user_message: 'An account already exists for that email. Try signing in instead.',
          detail: error.code,
        };

      case 'email_not_confirmed':
        return {
          code: 'AUTH_EMAIL_NOT_CONFIRMED',
          category: 'validation',
          retryable: false,
          user_message: 'Confirm your email before signing in — check your inbox.',
          detail: error.code,
        };

      case 'weak_password':
        return {
          code: 'AUTH_WEAK_PASSWORD',
          category: 'validation',
          retryable: true,
          user_message: 'Choose a stronger password.',
          detail: error.code,
        };

      case 'over_email_send_rate_limit':
      case 'over_request_rate_limit':
      case 'over_sms_send_rate_limit':
        return {
          code: 'AUTH_RATE_LIMITED',
          category: 'integration',
          retryable: true,
          user_message: 'Too many attempts. Please wait a few minutes and try again.',
          detail: error.code,
        };

      case 'otp_expired':
      case 'flow_state_expired':
      case 'flow_state_not_found':
      case 'session_not_found':
      case 'reauth_nonce_missing':
        return {
          code: 'AUTH_RESET_LINK_INVALID',
          category: 'validation',
          retryable: false,
          user_message: 'This link has expired or was already used. Request a new one.',
          detail: error.code,
        };

      case 'bad_oauth_state':
      case 'bad_oauth_callback':
      case 'oauth_provider_not_supported':
      case 'provider_disabled':
        return {
          code: 'AUTH_OAUTH_FAILED',
          category: 'integration',
          retryable: true,
          user_message: "We couldn't complete sign-in with Google. Please try again.",
          detail: error.code,
        };

      case 'signup_disabled':
      case 'email_provider_disabled':
        return {
          code: 'AUTH_SIGNUP_UNAVAILABLE',
          category: 'integration',
          retryable: true,
          user_message: 'Sign-up is temporarily unavailable. Please try again shortly.',
          detail: error.code,
        };

      case 'same_password':
        return {
          code: 'AUTH_SAME_PASSWORD',
          category: 'validation',
          retryable: true,
          user_message: 'Choose a different password than your current one.',
          detail: error.code,
        };

      default:
        return {
          code: 'AUTH_PROVIDER_ERROR',
          category: 'integration',
          retryable: true,
          user_message: 'Your request could not be completed. Please try again.',
          detail: error.code ?? error.message,
        };
    }
  }

  return {
    code: 'AUTH_INTERNAL',
    category: 'internal',
    retryable: true,
    user_message: 'Something went wrong on our end. Please try again.',
    detail: error instanceof Error ? error.message : String(error),
  };
}

function describeWeakPasswordReasons(reasons: string[]): string {
  if (reasons.length === 0) return 'try a longer or less predictable one.';
  const labels: Record<string, string> = {
    length: 'make it longer',
    characters: 'mix in more character types',
    pwned: 'avoid a password seen in a known data breach',
  };
  return reasons.map((r) => labels[r] ?? r).join(', ') + '.';
}
