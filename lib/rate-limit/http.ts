import { headers } from 'next/headers';

/**
 * Best-effort client IP for rate limiting (lib/rate-limit/). Vercel sets
 * `x-forwarded-for` on every request; `x-real-ip` is a common fallback
 * behind other proxies. Server Actions have no direct access to the
 * request socket, only `headers()`. Falls back to a fixed key in local
 * dev (no proxy in front), which means all local traffic shares one
 * bucket — acceptable there, never true in any real deployment.
 *
 * Extracted from app/(auth)/actions.ts (2026-08-20) so the Module 01
 * stories 2.x account Server Actions (app/(app)/accounts/actions.ts) can
 * reuse it instead of duplicating it — same repo-reuse-before-duplicate
 * check AGENTS.md asks of every slice.
 */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwardedFor = h.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return h.get('x-real-ip') ?? 'unknown';
}
