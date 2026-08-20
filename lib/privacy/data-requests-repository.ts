import 'server-only';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';

/**
 * Read/write access to `retrospeq.data_requests`
 * (supabase/migrations/20260821040000_audit_privacy.sql), per the RLS
 * shape reasoned through in docs/adr/0009-data-requests-rls-shape.md:
 * owner SELECT + owner INSERT (the initial "kick off a request" write),
 * every STATUS TRANSITION thereafter (processing/completed/failed/
 * canceled, `completed_at`, `artifact_url`) through the service role
 * only. `createDataRequest` is therefore the ONLY function here that
 * runs under `withUserConnection` — every other write goes through
 * `withServiceRoleConnection`.
 */

export type DataRequestKind = 'export' | 'erasure' | 'restriction';
export type DataRequestStatus = 'pending' | 'processing' | 'completed' | 'canceled' | 'failed';

export interface DataRequestRow {
  id: string;
  user_id: string;
  kind: DataRequestKind;
  status: DataRequestStatus;
  requested_at: string;
  completed_at: string | null;
  artifact_url: string | null;
  expires_at: string | null;
}

const COLUMNS =
  'id, user_id, kind, status, requested_at, completed_at, artifact_url, expires_at';

/** The one client-writable path — RLS-enforced (`data_requests_owner_insert`),
 *  not app-layer-trusted alone. `expiresAt` is the erasure grace-period
 *  deadline (7 days) at request time; export requests pass `null` here
 *  and get a real `expires_at` once the job completes
 *  (`updateDataRequestStatus`). */
export async function createDataRequest(
  userId: string,
  kind: DataRequestKind,
  expiresAt: Date | null,
): Promise<DataRequestRow> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<DataRequestRow>(
      `insert into retrospeq.data_requests (user_id, kind, expires_at)
       values ($1, $2, $3)
       returning ${COLUMNS}`,
      [userId, kind, expiresAt ? expiresAt.toISOString() : null],
    );
    return res.rows[0];
  });
}

export async function listDataRequestsForUser(userId: string): Promise<DataRequestRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<DataRequestRow>(
      `select ${COLUMNS}
         from retrospeq.data_requests
        where user_id = $1
        order by requested_at desc`,
      [userId],
    );
    return res.rows;
  });
}

/** Owner-scoped, RLS-enforced. Used by the Privacy screen and by
 *  `lib/privacy/erasure.ts`/`export-job.ts`'s own callers to look up "is
 *  there already a pending request of this kind" before creating a new
 *  one (§9's `EXPORT_IN_PROGRESS` — the same duplicate-guard applies to
 *  erasure by extension, since a second concurrent erasure request makes
 *  no sense either). */
export async function findActiveRequest(
  userId: string,
  kind: DataRequestKind,
): Promise<DataRequestRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<DataRequestRow>(
      `select ${COLUMNS}
         from retrospeq.data_requests
        where user_id = $1 and kind = $2 and status in ('pending', 'processing')
        order by requested_at desc
        limit 1`,
      [userId, kind],
    );
    return res.rows[0] ?? null;
  });
}

/** Service-role read by id, for the job functions
 *  (`export-job.ts`/`erasure.ts`) which run outside a user session — a
 *  future Vercel Cron invocation has no `userId` to scope
 *  `withUserConnection` to ahead of reading the row itself. Every caller
 *  MUST re-derive `user_id` from the returned row before doing anything
 *  else with it (00-foundation §3.2), never accept one from elsewhere. */
export async function getDataRequestById(requestId: string): Promise<DataRequestRow | null> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<DataRequestRow>(
      `select ${COLUMNS} from retrospeq.data_requests where id = $1`,
      [requestId],
    );
    return res.rows[0] ?? null;
  });
}

export interface UpdateDataRequestStatusInput {
  status: DataRequestStatus;
  completedAt?: Date | null;
  artifactUrl?: string | null;
  expiresAt?: Date | null;
}

/** The only place `status`/`completed_at`/`artifact_url`/`expires_at`
 *  change after creation — service role only, per the table's RLS shape.
 *  Undefined fields are left untouched (COALESCE against the existing
 *  value); pass `null` explicitly to clear a field. */
export async function updateDataRequestStatus(
  requestId: string,
  input: UpdateDataRequestStatusInput,
): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query(
      `update retrospeq.data_requests
          set status = $1,
              completed_at = case when $2::boolean then $3::timestamptz else completed_at end,
              artifact_url = case when $4::boolean then $5::text else artifact_url end,
              expires_at = case when $6::boolean then $7::timestamptz else expires_at end
        where id = $8`,
      [
        input.status,
        'completedAt' in input,
        input.completedAt ? input.completedAt.toISOString() : null,
        'artifactUrl' in input,
        input.artifactUrl ?? null,
        'expiresAt' in input,
        input.expiresAt ? input.expiresAt.toISOString() : null,
        requestId,
      ],
    );
  });
}

/** Owner-scoped cancel — RLS's own SELECT still applies for the read
 *  half of the check the caller does before calling this
 *  (`app/(app)/privacy/actions.ts`'s `cancelErasure`), but the actual
 *  UPDATE runs under the service role since no client UPDATE policy
 *  exists at all (see the migration). The `where status = 'pending'`
 *  guard means an already-executed or already-canceled request can never
 *  be "re-canceled" into a fresh pending-looking state. */
export async function cancelDataRequest(userId: string, requestId: string): Promise<boolean> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query(
      `update retrospeq.data_requests
          set status = 'canceled'
        where id = $1 and user_id = $2 and status = 'pending'`,
      [requestId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  });
}
