import { describe, expect, it } from 'vitest';
import {
  confirmPasswordResetSchema,
  emailSchema,
  passwordSchema,
  requestPasswordResetSchema,
  signInSchema,
  signUpSchema,
} from '../schemas';

describe('emailSchema', () => {
  it('trims surrounding whitespace before validating format', () => {
    const result = emailSchema.safeParse('  trader@example.com  ');
    expect(result.success).toBe(true);
    expect(result.data).toBe('trader@example.com');
  });

  it('lower-cases the email', () => {
    const result = emailSchema.safeParse('Trader@Example.COM');
    expect(result.success).toBe(true);
    expect(result.data).toBe('trader@example.com');
  });

  it('trims AND lower-cases before the format check — a pasted email with trailing whitespace and mixed case is valid, not rejected', () => {
    const result = emailSchema.safeParse('  Trader@Example.COM  ');
    expect(result.success).toBe(true);
    expect(result.data).toBe('trader@example.com');
  });

  it('rejects a malformed email with the custom error message', () => {
    const result = emailSchema.safeParse('not-an-email');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Enter a valid email address.');
    }
  });

  it('rejects an empty string', () => {
    expect(emailSchema.safeParse('').success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('accepts an 8-character password (the floor)', () => {
    expect(passwordSchema.safeParse('12345678').success).toBe(true);
  });

  it('rejects a 7-character password with the custom message', () => {
    const result = passwordSchema.safeParse('1234567');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Password must be at least 8 characters.');
    }
  });

  it('rejects an empty password', () => {
    expect(passwordSchema.safeParse('').success).toBe(false);
  });
});

describe('signUpSchema', () => {
  it('accepts a valid email + password pair', () => {
    const result = signUpSchema.safeParse({ email: 'a@example.com', password: 'longenough' });
    expect(result.success).toBe(true);
  });

  it('rejects when the password is under 8 characters', () => {
    const result = signUpSchema.safeParse({ email: 'a@example.com', password: 'short' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.password?.[0]).toBe(
        'Password must be at least 8 characters.',
      );
    }
  });

  it('rejects when the email is malformed', () => {
    const result = signUpSchema.safeParse({ email: 'nope', password: 'longenough' });
    expect(result.success).toBe(false);
  });
});

describe('signInSchema — password only requires non-empty, not the 8-char signup floor', () => {
  it('accepts a short existing password (an old account may predate the 8-char floor)', () => {
    const result = signInSchema.safeParse({ email: 'a@example.com', password: 'ab' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty password with "Enter your password."', () => {
    const result = signInSchema.safeParse({ email: 'a@example.com', password: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.password?.[0]).toBe('Enter your password.');
    }
  });
});

describe('requestPasswordResetSchema', () => {
  it('accepts a valid email', () => {
    expect(requestPasswordResetSchema.safeParse({ email: 'a@example.com' }).success).toBe(true);
  });

  it('rejects a malformed email', () => {
    expect(requestPasswordResetSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });
});

describe('confirmPasswordResetSchema', () => {
  it('accepts an 8+ character password', () => {
    expect(confirmPasswordResetSchema.safeParse({ password: 'longenough' }).success).toBe(true);
  });

  it('rejects a sub-8-character password', () => {
    expect(confirmPasswordResetSchema.safeParse({ password: 'short' }).success).toBe(false);
  });
});
