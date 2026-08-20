import { z } from 'zod';

// Shared client/server boundary schemas (00-foundation §4.2: "Validate
// every payload against a schema at the boundary (Zod)"). Imported by
// both the Server Actions in app/(auth)/actions.ts and, where a client
// component wants inline validation before submit, the same object —
// one source of truth, not a parallel client-side copy.

// Trim + lower-case BEFORE the email-format check (not after — see the
// `.pipe()` ordering; a bare `z.email().trim()` validates the format
// against the untrimmed input, which rejects a pasted email with
// trailing whitespace instead of cleaning it).
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address.' }));

// 00-foundation §4.2 + this slice's task brief: "Supabase's own minimum
// is fine, don't over-engineer a custom policy." Supabase Auth enforces
// its own configured minimum server-side (default 6, this project has
// not raised it) and returns a `weak_password` error with `reasons` if
// unmet — see lib/auth/errors.ts. This client-side floor is deliberately
// a little stricter (8) as a UX nicety only; the server-side Supabase
// check is the actual authority, not this schema.
export const passwordSchema = z
  .string()
  .min(8, { error: 'Password must be at least 8 characters.' });

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: 'Enter your password.' }),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const requestPasswordResetSchema = z.object({
  email: emailSchema,
});
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const confirmPasswordResetSchema = z.object({
  password: passwordSchema,
});
export type ConfirmPasswordResetInput = z.infer<typeof confirmPasswordResetSchema>;
