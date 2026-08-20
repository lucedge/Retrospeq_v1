import 'server-only';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';

/**
 * Read/write access to `retrospeq.audit_log`
 * (supabase/migrations/20260821040000_audit_privacy.sql), per Module 01
 * §3.3's literal shape: "insert-only for the service role and
 * select-only for the owning user." Every writer in this codebase MUST
 * go through `recordAuditEvent` — there is no client-writable path by
 * design (see the migration's own comment), so a Server Action can never
 * accidentally bypass this and write directly.
 */

export type AuditActor = 'user' | 'system' | 'support';

export interface RecordAuditEventInput {
  /** The account the event is about. `null` only for a genuinely
   *  system-wide event with no single owning user (none exist in this
   *  slice yet, but the column itself is nullable per spec). */
  userId: string | null;
  actor: AuditActor;
  action: string;
  target?: string | null;
  /** Never credentials, TOTP secrets, or recovery codes — see the
   *  migration's own column comment. Callers in `lib/privacy/` only ever
   *  pass request ids, kinds, and counts, never secret material. */
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

/** The only writer for `audit_log` in this codebase — service role,
 *  per the table's RLS shape (no client INSERT policy exists at all). */
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query(
      `insert into retrospeq.audit_log (user_id, actor, action, target, metadata, ip_hash)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.userId,
        input.actor,
        input.action,
        input.target ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.ipHash ?? null,
      ],
    );
  });
}

export interface AuditLogRow {
  id: string;
  actor: AuditActor;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Owner-scoped read, genuinely RLS-enforced (the table's real SELECT
 *  policy) — not currently wired into any UI in this slice (Module 01
 *  §5.1's Privacy screen element list doesn't ask for a visible audit
 *  trail), but built for real since a future settings/security screen is
 *  a plausible near-term consumer and the read path is trivial once the
 *  table exists. */
export async function listAuditLogForUser(userId: string, limit = 50): Promise<AuditLogRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<AuditLogRow>(
      `select id, actor, action, target, metadata, created_at
         from retrospeq.audit_log
        where user_id = $1
        order by created_at desc
        limit $2`,
      [userId, limit],
    );
    return res.rows;
  });
}
