import { createBrowserClient } from '@supabase/ssr';
import { requireEnv } from './errors';

/**
 * Browser-side Supabase client, for Client Components only (OAuth
 * redirect kick-off, client-side auth state if a component needs it).
 * Uses the anon key — same RLS-scoping story as `lib/supabase/server.ts`,
 * just cookie-managed by the browser instead of `next/headers`.
 */
export function createClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = requireEnv([
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ]);

  return createBrowserClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    db: { schema: 'retrospeq' },
  });
}
