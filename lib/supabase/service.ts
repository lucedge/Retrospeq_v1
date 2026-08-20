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
 *   - This module's own call sites must stay enumerable — Module 01
 *     §7.2's "service-role inventory" security test
 *     (`lib/supabase/__tests__/service-role-inventory.test.ts`) greps
 *     for `createServiceRoleClient(` call sites and fails on an
 *     unreviewed addition. Do not wrap this factory in a second
 *     indirection that would hide a call site from that grep.
 *
 * **This is not the only RLS-bypass mechanism in the repo.**
 * `lib/supabase/direct.ts`'s `withServiceRoleConnection` bypasses RLS
 * the same way, via a direct Postgres connection instead of PostgREST —
 * needed because PostgREST doesn't yet serve the `retrospeq` schema
 * (ADR 0003, ADR 0006; see NEEDS_YOUR_INPUT.md). The inventory test
 * above enumerates BOTH `createServiceRoleClient(` and
 * `withServiceRoleConnection(` call sites — if a third RLS-bypass
 * mechanism is ever added, that test must be extended to cover it too,
 * not left to silently under-count.
 *
 * No call site of THIS factory exists yet (Module 01's auth flows only
 * ever need the user's own session — see `lib/supabase/server.ts`; the
 * account-connection flow's service-role writes go through
 * `withServiceRoleConnection` instead, per the ADRs above). Exported now
 * because a downstream module reaching a schema PostgREST DOES serve
 * (or once the "Exposed schemas" dashboard gap closes) will want this
 * exact shape.
 */
/**
 * `@supabase/supabase-js`'s `SupabaseClient` constructor unconditionally
 * builds a `RealtimeClient` (`_initRealtimeClient`, called in the
 * constructor body regardless of whether any `.channel()` is ever used) —
 * verified directly against `node_modules/@supabase/supabase-js`'s
 * shipped source, not assumed. `RealtimeClient`'s own constructor then
 * unconditionally resolves a WebSocket constructor
 * (`websocket-factory.js`'s `getWebSocketConstructor()`), which throws
 * `Error: Node.js detected but native WebSocket not found` on this repo's
 * pinned Node 20.11.0 (global `WebSocket` first ships in Node 21+ behind
 * a flag, stable in 22+ — see PROGRESS.md "Infra gaps"). This is not
 * hypothetical: confirmed by calling `createServiceRoleClient()` for real
 * (not mocked) and observing the throw, while researching Module 01
 * stories 5.x's erasure flow (2026-08-21) — meaning this factory has been
 * broken for any REAL (non-test-mocked) call since it was introduced for
 * `lib/auth/mfa-admin.ts`, silently, because every existing test/
 * screenshot pass exercising it either mocked this module directly or
 * didn't happen to hit the one live code path that calls it for real.
 *
 * Fix: supply a harmless placeholder `realtime.transport` — this
 * satisfies the `options?.transport ?? getWebSocketConstructor()` check
 * (RealtimeClient.js) without ever needing a real WebSocket
 * implementation, which is safe precisely because nothing in this repo
 * ever calls `.channel()`/`.subscribe()` on a service-role client (only
 * `.auth.admin.*` / `.storage.*`, both plain REST under the hood) — the
 * placeholder class is never instantiated or connected, just referenced
 * to satisfy the nullish-coalescing check at construction time. Verified
 * directly: `.auth.admin.listUsers()` and `.storage.*` both succeed
 * end-to-end against the live project with this fix in place.
 */
class UnusedRealtimeTransportPlaceholder {}

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
    realtime: {
      transport: UnusedRealtimeTransportPlaceholder as never,
    },
  });
}
