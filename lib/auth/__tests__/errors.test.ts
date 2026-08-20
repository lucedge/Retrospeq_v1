import { describe, expect, it } from 'vitest';
import {
  AuthApiError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
  AuthRetryableFetchError,
} from '@supabase/supabase-js';
import { mapAuthError } from '../errors';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';

/**
 * Every branch of lib/auth/errors.ts's `mapAuthError`, per this task's
 * brief: "every branch — weak password, invalid credentials, email
 * already registered, rate limited, oauth failed, session
 * missing/reset-link-invalid, unknown default case." One assertion group
 * per branch, checking code/category/retryable/user_message, plus that
 * `detail` never leaks anything beyond what the mapped error already
 * carries (00-foundation §9's "no vendor error string reaches the user"
 * is about `user_message`, not `detail` — `detail` is machine-only).
 */
describe('mapAuthError', () => {
  it('maps RateLimitExceededError (lib/rate-limit/) to AUTH_RATE_LIMITED, checked before any Supabase-specific branch', () => {
    const result = mapAuthError(new RateLimitExceededError('auth.signin', 'ip:203.0.113.4', 900));

    expect(result).toEqual({
      code: 'AUTH_RATE_LIMITED',
      category: 'integration',
      retryable: true,
      user_message: 'Too many attempts. Please wait a few minutes and try again.',
      detail: 'auth.signin:ip:203.0.113.4',
    });
  });

  it('maps AuthSessionMissingError to AUTH_RESET_LINK_INVALID', () => {
    const result = mapAuthError(new AuthSessionMissingError());

    expect(result).toEqual({
      code: 'AUTH_RESET_LINK_INVALID',
      category: 'validation',
      retryable: false,
      user_message: 'This link has expired or was already used. Request a new one.',
      detail: 'Auth session missing!',
    });
  });

  describe('AuthWeakPasswordError (thrown directly, e.g. from updateUser())', () => {
    it('describes each known weak-password reason', () => {
      const result = mapAuthError(
        new AuthWeakPasswordError('Password is too weak', 422, [
          'length',
          'characters',
          'pwned',
        ]),
      );

      expect(result.code).toBe('AUTH_WEAK_PASSWORD');
      expect(result.category).toBe('validation');
      expect(result.retryable).toBe(true);
      expect(result.user_message).toBe(
        'Choose a stronger password — make it longer, mix in more character types, avoid a password seen in a known data breach.',
      );
      expect(result.detail).toBe('Password is too weak');
    });

    it('falls back to a generic suggestion when reasons is empty', () => {
      const result = mapAuthError(new AuthWeakPasswordError('weak', 422, []));

      expect(result.user_message).toBe(
        'Choose a stronger password — try a longer or less predictable one.',
      );
    });

    it('passes through an unrecognised reason verbatim rather than dropping it', () => {
      // `describeWeakPasswordReasons` (lib/auth/errors.ts) accepts a plain
      // `string[]` at runtime and only labels the reasons it recognises,
      // falling back to the raw string otherwise — the SDK's own
      // `WeakPasswordReasons` type is narrower than that, so this cast
      // exercises a reason value the SDK doesn't currently define but the
      // app's own code is written to handle gracefully regardless.
      const reasons = ['some_new_reason'] as unknown as ConstructorParameters<
        typeof AuthWeakPasswordError
      >[2];
      const result = mapAuthError(new AuthWeakPasswordError('weak', 422, reasons));

      expect(result.user_message).toBe('Choose a stronger password — some_new_reason.');
    });
  });

  describe('AuthRetryableFetchError (found live, 2026-08-20: the shared dev project\'s mailer is currently unreachable)', () => {
    it('maps a mailer-dependent fetch failure to a named, retryable integration error, not the generic AUTH_INTERNAL fallback', () => {
      const result = mapAuthError(
        new AuthRetryableFetchError('Error sending confirmation email', 500),
      );

      expect(result).toEqual({
        code: 'AUTH_MAILER_UNAVAILABLE',
        category: 'integration',
        retryable: true,
        user_message: "We couldn't send that email right now. Please try again shortly.",
        detail: 'Error sending confirmation email',
      });
    });
  });

  describe('AuthApiError branches (by error.code)', () => {
    const cases: Array<{
      codes: string[];
      expectedCode: string;
      category: 'validation' | 'entitlement' | 'integration' | 'conflict' | 'internal';
      retryable: boolean;
      userMessage: string;
    }> = [
      {
        codes: ['invalid_credentials', 'user_not_found'],
        expectedCode: 'AUTH_INVALID_CREDENTIALS',
        category: 'validation',
        retryable: true,
        userMessage: "That email or password isn't right.",
      },
      {
        codes: ['email_exists', 'user_already_exists'],
        expectedCode: 'AUTH_EMAIL_ALREADY_REGISTERED',
        category: 'validation',
        retryable: false,
        userMessage: 'An account already exists for that email. Try signing in instead.',
      },
      {
        codes: ['email_not_confirmed'],
        expectedCode: 'AUTH_EMAIL_NOT_CONFIRMED',
        category: 'validation',
        retryable: false,
        userMessage: 'Confirm your email before signing in — check your inbox.',
      },
      {
        codes: ['weak_password'],
        expectedCode: 'AUTH_WEAK_PASSWORD',
        category: 'validation',
        retryable: true,
        userMessage: 'Choose a stronger password.',
      },
      {
        codes: ['over_email_send_rate_limit', 'over_request_rate_limit', 'over_sms_send_rate_limit'],
        expectedCode: 'AUTH_RATE_LIMITED',
        category: 'integration',
        retryable: true,
        userMessage: 'Too many attempts. Please wait a few minutes and try again.',
      },
      {
        codes: [
          'otp_expired',
          'flow_state_expired',
          'flow_state_not_found',
          'session_not_found',
          'reauth_nonce_missing',
        ],
        expectedCode: 'AUTH_RESET_LINK_INVALID',
        category: 'validation',
        retryable: false,
        userMessage: 'This link has expired or was already used. Request a new one.',
      },
      {
        codes: [
          'bad_oauth_state',
          'bad_oauth_callback',
          'oauth_provider_not_supported',
          'provider_disabled',
        ],
        expectedCode: 'AUTH_OAUTH_FAILED',
        category: 'integration',
        retryable: true,
        userMessage: "We couldn't complete sign-in with Google. Please try again.",
      },
      {
        codes: ['signup_disabled', 'email_provider_disabled'],
        expectedCode: 'AUTH_SIGNUP_UNAVAILABLE',
        category: 'integration',
        retryable: true,
        userMessage: 'Sign-up is temporarily unavailable. Please try again shortly.',
      },
      {
        codes: ['same_password'],
        expectedCode: 'AUTH_SAME_PASSWORD',
        category: 'validation',
        retryable: true,
        userMessage: 'Choose a different password than your current one.',
      },
    ];

    for (const { codes, expectedCode, category, retryable, userMessage } of cases) {
      for (const code of codes) {
        it(`maps AuthApiError code "${code}" to ${expectedCode}`, () => {
          const result = mapAuthError(new AuthApiError(`message for ${code}`, 400, code));

          expect(result.code).toBe(expectedCode);
          expect(result.category).toBe(category);
          expect(result.retryable).toBe(retryable);
          expect(result.user_message).toBe(userMessage);
          expect(result.detail).toBe(code);
        });
      }
    }

    it('falls back to AUTH_PROVIDER_ERROR for an unrecognised AuthApiError code', () => {
      const result = mapAuthError(new AuthApiError('vendor-specific text', 500, 'some_new_vendor_code'));

      expect(result).toEqual({
        code: 'AUTH_PROVIDER_ERROR',
        category: 'integration',
        retryable: true,
        user_message: 'Your request could not be completed. Please try again.',
        detail: 'some_new_vendor_code',
      });
      // No vendor error string reaches the user (00-foundation §9) — only `detail` carries it.
      expect(result.user_message).not.toContain('vendor-specific text');
    });

    it('falls back to the error message when AuthApiError.code is undefined', () => {
      const result = mapAuthError(new AuthApiError('raw vendor message', 500, undefined as unknown as string));

      expect(result.code).toBe('AUTH_PROVIDER_ERROR');
      expect(result.detail).toBe('raw vendor message');
    });
  });

  describe('unknown / non-Supabase errors — AUTH_INTERNAL fallback', () => {
    it('maps a plain Error to AUTH_INTERNAL, using its message as detail', () => {
      const result = mapAuthError(new Error('unexpected failure'));

      expect(result).toEqual({
        code: 'AUTH_INTERNAL',
        category: 'internal',
        retryable: true,
        user_message: 'Something went wrong on our end. Please try again.',
        detail: 'unexpected failure',
      });
    });

    it('maps a non-Error thrown value (e.g. a string) to AUTH_INTERNAL, stringifying it', () => {
      const result = mapAuthError('a raw string throw');

      expect(result.code).toBe('AUTH_INTERNAL');
      expect(result.detail).toBe('a raw string throw');
    });

    it('maps undefined/null to AUTH_INTERNAL without throwing', () => {
      expect(() => mapAuthError(undefined)).not.toThrow();
      expect(mapAuthError(null).code).toBe('AUTH_INTERNAL');
    });
  });
});
