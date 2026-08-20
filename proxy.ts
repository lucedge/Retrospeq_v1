import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Named `proxy.ts`, not `middleware.ts` — Next.js 16 deprecated and
// renamed the `middleware.js` file convention to `proxy.js`
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// Behaviour is identical to the old middleware convention; only the
// file/export name changed. Per AGENTS.md's opening instruction, this
// was verified against this repo's actual installed Next.js docs
// rather than assumed from training data.
//
// Job: refresh the Supabase session cookie on every request per
// Module 01 story 1.2 ("stay signed in across sessions ... refresh
// token rotation"). @supabase/ssr's own docs mandate this — without it,
// Server Components lose the ability to write refreshed cookies (they
// can only read them), and a session that needed a refresh silently
// stops working.
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Fail open on the proxy specifically (not the app's auth boundary):
  // an unconfigured Supabase project must not turn every route into a
  // 500 before the app even renders its own "not configured" state.
  // Server Actions and Route Handlers still hit `requireEnv` in
  // lib/supabase/server.ts and throw loudly there.
  if (!supabaseUrl || !supabaseAnonKey) {
    return supabaseResponse;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    db: { schema: 'retrospeq' },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // Required by @supabase/ssr's own docs: calling getUser() (not just
  // getSession()) is what triggers the token-refresh round trip and
  // guarantees the refreshed cookie actually gets written above before
  // any downstream render reads a stale one.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Skip static assets, image optimisation, and the brand asset
    // folder — none of these read the session.
    '/((?!_next/static|_next/image|favicon.ico|brand/).*)',
  ],
};
