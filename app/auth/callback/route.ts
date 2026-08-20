import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';

/**
 * Single exchange point for every Supabase Auth redirect flow that
 * hands back a PKCE `code`: Google OAuth (story 1.1), email
 * confirmation links (`emailRedirectTo` in signUpWithEmail), and
 * password-reset links (`redirectTo` in requestPasswordReset, which
 * appends `?next=/reset-password/confirm`).
 *
 * Deliberately outside the `(auth)` route group — Supabase's redirect
 * target must be a real, stable URL path
 * (`<origin>/auth/callback`), and a route group's parens are not part
 * of the URL, so placing it inside `(auth)/callback` would still
 * resolve to `/callback`, not `/auth/callback`; keeping this route at
 * its literal path avoids that ambiguity entirely.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  // Module 01 §7.2: this route is one of the "auth endpoints" the spec
  // means — every OAuth/email-confirmation/reset-link flow lands here
  // with an attacker-observable, replayable `code` param. Route Handler,
  // so the IP comes straight off `request.headers`, not `next/headers`
  // (see app/(auth)/actions.ts's `getClientIp` for the Server Action
  // equivalent, needed there only because Server Actions lack direct
  // request access).
  const forwardedFor = request.headers.get('x-forwarded-for');
  const ip = forwardedFor ? forwardedFor.split(',')[0].trim() : (request.headers.get('x-real-ip') ?? 'unknown');
  try {
    await enforceRateLimit('callback', ip);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return NextResponse.redirect(`${origin}/login?error=AUTH_RATE_LIMITED`);
    }
    throw err;
  }

  // Only ever follow a same-origin relative path from `next` — it is
  // attacker-influenceable (anyone can craft a link to this route with
  // an arbitrary `next` value), so treat it as untrusted input, not as
  // our own trusted redirect target.
  const rawNext = searchParams.get('next') ?? '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=AUTH_OAUTH_FAILED`);
}
