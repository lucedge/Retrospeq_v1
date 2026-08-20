import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './errors';

/**
 * Service-role Supabase client — bypasses RLS entirely (00-foundation
 * §3.2). Every rule below is load-bearing, not a style preference:
 *
 *   - `import 'server-only'` makes it a build error for this module to
 *     end up in a client bundle, not just a code-review convention.
 *   - Never construct this per-request from a value in the request body.
 *     Any function that accepts a `userId` here must receive it from an
 *     already-authenticated server context (a verified session, or a
 *     background job's own scope), never from client-supplied JSON.
 *   - Callers must filter every query explicitly on `user_id` — the
 *     service role does not do this for you, RLS is bypassed, not
 *     replaced by an equivalent check.
 *   - This module's own call sites must stay enumerable — 00-foundation
 *     §7.2's "service-role inventory" security test greps for
 *     `createServiceRoleClient(` call sites and fails on an unreviewed
 *     addition. Do not wrap this factory in a second indirection that
 *     would hide a call site from that grep.
 *
 * No call site exists yet in this slice (Module 01's signup/signin/
 * signout/reset flows only ever need the user's own session — see
 * `lib/supabase/server.ts`). Exported now because every downstream
 * module (sync workers, credential decryption, entitlement webhooks)
 * needs this exact shape.
 */
export function createServiceRoleClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv([
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);

  return createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: 'retrospeq' },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
