import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { requireEnv } from './errors';

/**
 * Server-side Supabase client (Server Components, Server Actions, Route
 * Handlers) — cookie-backed session, RLS-scoped to the calling user via
 * their JWT. Never use this for background-job/service-role work; see
 * `lib/supabase/service.ts` for that.
 *
 * Per @supabase/ssr's own guidance: create a fresh client per request,
 * never share one across requests.
 *
 * `db.schema: 'retrospeq'` follows the precedent set in
 * `lib/analytics/shadow-harness/repository.ts` (docs/adr/0002) — this
 * project's tables live in a dedicated Postgres schema, not `public`.
 * Note: PostgREST (`.from(...)` calls through this client) only serves
 * schemas listed in the Supabase project's "Exposed schemas" dashboard
 * setting, which does not yet include `retrospeq` as of this writing
 * (see NEEDS_YOUR_INPUT.md / docs/adr/0002) — `supabase.auth.*` methods
 * are unaffected (they call the GoTrue API, not PostgREST), which is why
 * this module's auth Server Actions only ever call `supabase.auth.*`.
 */
export async function createClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = requireEnv([
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ]);

  const cookieStore = await cookies();

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    db: { schema: 'retrospeq' },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component, where cookies() is read-only.
          // Harmless as long as proxy.ts is refreshing the session on
          // every request (it is — see proxy.ts at the repo root).
        }
      },
    },
  });
}
