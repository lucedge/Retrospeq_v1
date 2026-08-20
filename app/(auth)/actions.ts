'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  signUpSchema,
  signInSchema,
  requestPasswordResetSchema,
  confirmPasswordResetSchema,
} from '@/lib/auth/schemas';
import { mapAuthError, type AppAuthError } from '@/lib/auth/errors';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';

/**
 * Shared shape for every auth form's `useActionState`. `fieldErrors`
 * carries Zod's boundary-validation failures (00-foundation §4.2);
 * `error` carries a mapped Supabase failure (lib/auth/errors.ts) — kept
 * distinct so the UI can render "fix this field" vs "something the
 * server rejected" differently, even though both render as plain text
 * per the design system's no-colour-coding rule.
 */
export interface AuthActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: AppAuthError;
  success?: boolean;
  message?: string;
}

async function getOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('x-forwarded-host') ?? h.get('host');
  return `${proto}://${host}`;
}

/**
 * Module 01 story 1.1: "Account created, verification email sent,
 * onboarding entered. No trading credential requested at this stage."
 * The `retrospeq.profiles` row is created server-side by the
 * `handle_new_user` trigger (supabase/migrations/20260820010000_profiles.sql)
 * the moment `auth.users` gets the row — this action never inserts into
 * `profiles` itself.
 */
export async function signUpWithEmail(
  _prevState: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signUpSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    await enforceRateLimit('signup', await getClientIp(), parsed.data.email);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const supabase = await createClient();
  const origin = await getOrigin();

  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    return { error: mapAuthError(error) };
  }

  // If email confirmation is off for this Supabase project, signUp()
  // returns an active session immediately — go straight in rather than
  // telling someone who is already signed in to go check their email.
  if (data.session) {
    redirect('/');
  }

  return {
    success: true,
    message: 'Check your email to confirm your account before signing in.',
  };
}

export async function signInWithEmail(
  _prevState: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signInSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    await enforceRateLimit('signin', await getClientIp(), parsed.data.email);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: mapAuthError(error) };
  }

  redirect('/');
}

/**
 * Redirect-based OAuth kick-off (story 1.1's "sign up with ... Google").
 * Takes a `FormData` param (unused) so it can be wired directly as a
 * `<form action={signInWithGoogle}>` — same entry point serves both
 * "sign up" and "sign in" screens, since Supabase OAuth has no
 * meaningful distinction between the two (a first-time Google sign-in
 * creates the account via the same `handle_new_user` trigger).
 */
export async function signInWithGoogle(_formData: FormData): Promise<void> {
  try {
    await enforceRateLimit('oauthGoogle', await getClientIp());
  } catch (err) {
    redirect(`/login?error=${mapAuthError(err).code}`);
  }

  const supabase = await createClient();
  const origin = await getOrigin();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    redirect(`/login?error=${mapAuthError(error).code}`);
  }

  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/**
 * Story 1.3. Deliberately returns the same success message whether or
 * not the email belongs to an account — Supabase's own
 * `resetPasswordForEmail` already behaves this way (no error for an
 * unknown email), and the UI must not contradict that by branching on
 * it, which would reintroduce user enumeration.
 */
export async function requestPasswordReset(
  _prevState: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = requestPasswordResetSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Rate-limited identically regardless of whether the email belongs to
  // an account — same non-enumeration reasoning as the success path
  // below. An attacker probing many distinct emails is still bounded by
  // the per-IP rule even though each individual email never trips its
  // own bucket.
  try {
    await enforceRateLimit('resetRequest', await getClientIp(), parsed.data.email);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const supabase = await createClient();
  const origin = await getOrigin();

  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password/confirm`,
  });

  if (error) {
    return { error: mapAuthError(error) };
  }

  return {
    success: true,
    message: 'If an account exists for that email, a reset link is on its way.',
  };
}

/**
 * Runs on /reset-password/confirm, after app/auth/callback/route.ts has
 * already exchanged the emailed code for a recovery session — this
 * action only ever updates the password of whichever session is
 * currently active in the request's cookies, never a client-supplied
 * user id (00-foundation §3.2).
 */
export async function confirmPasswordReset(
  _prevState: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = confirmPasswordResetSchema.safeParse({ password: formData.get('password') });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    await enforceRateLimit('resetConfirm', await getClientIp());
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    return { error: mapAuthError(error) };
  }

  // Story 1.3: "all sessions invalidated on reset." Flagged by
  // retrospeq-qa (2026-08-20): `updateUser({ password })` alone is
  // NOT documented to revoke other sessions' refresh tokens — assuming
  // so was an unverified guess. Made explicit instead: `scope: 'others'`
  // (node_modules/@supabase/auth-js/dist/main/GoTrueClient.d.ts's own
  // doc comment) revokes every OTHER session's refresh token while
  // leaving this recovery session's own tokens alone — exactly "all
  // sessions invalidated" without disrupting the redirect below. Not
  // `signOut()`'s default `scope: 'global'`, which would also kill the
  // very session this call is running in, before the redirect completes.
  // Errors here are swallowed deliberately: the password change already
  // succeeded and is the primary security-relevant outcome; a transient
  // failure revoking OTHER sessions shouldn't block the user from
  // reaching the confirmation redirect, but is worth knowing about.
  const { error: signOutOthersError } = await supabase.auth.signOut({ scope: 'others' });
  if (signOutOthersError) {
    console.warn(
      '[confirmPasswordReset] failed to revoke other sessions after password reset:',
      signOutOthersError.message,
    );
  }

  redirect('/login?reset=success');
}
