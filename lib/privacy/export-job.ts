import 'server-only';
import {
  createDataRequest,
  findActiveRequest,
  getDataRequestById,
  updateDataRequestStatus,
  type DataRequestRow,
} from './data-requests-repository';
import { recordAuditEvent } from './audit-repository';
import { buildExportBundle, tradingAccountsToCsv } from './export';
import { ensureExportBucketExists, uploadExportObject, createSignedExportUrl } from './storage';

/**
 * Module 01 story 5.1's job orchestration — Storage upload, signed URL,
 * `data_requests` status transitions, audit events. Deliberately
 * separate from `export.ts`'s pure(ish) bundle-assembly logic, per this
 * slice's own dispatch note (see that file's header comment).
 *
 * RUNS SYNCHRONOUSLY inside the Server Action today
 * (`app/(app)/privacy/actions.ts`'s `requestExport`), not queued — this
 * repo has no background-job infrastructure yet (PROGRESS.md "Infra
 * gaps": no Vercel Cron/queue deployed) and, per this slice's own
 * dispatch, the real dataset this project can export right now is tiny
 * (profile + a handful of trading-account rows, no `fills`/`trades` —
 * Module 02 doesn't exist). §11's "< 5 min p95" performance budget is
 * trivially met at this data volume. **This will need to become
 * async/queued once Module 02 adds real trade-volume data** — `runExportJob`
 * is written as a single callable function taking only a `requestId` for
 * exactly that reason: a future queue worker can call it unchanged, no
 * rework needed at the call-site boundary, only at whatever schedules it.
 */

export const EXPORT_RETENTION_DAYS = 30; // §8: "Export delivery ... 30 days hard"
const EXPORT_SIGNED_URL_SECONDS = EXPORT_RETENTION_DAYS * 24 * 60 * 60;

/** Stored (JSON-encoded) in `data_requests.artifact_url` — see that
 *  column's own migration comment for why one text column holds two
 *  URLs. */
export interface ExportArtifactManifest {
  jsonUrl: string;
  csvUrl: string;
}

export class DuplicateExportRequestError extends Error {
  readonly existing: DataRequestRow;
  constructor(existing: DataRequestRow) {
    super('An export is already being prepared for this account.');
    this.name = 'DuplicateExportRequestError';
    this.existing = existing;
  }
}

/**
 * Story 5.1's entry point. §9's `EXPORT_IN_PROGRESS` ("Duplicate
 * request ... Your export is already being prepared ... No [retry]") —
 * a second request while one is still `pending`/`processing` is
 * rejected rather than queued twice.
 */
export async function requestExport(userId: string): Promise<DataRequestRow> {
  const existing = await findActiveRequest(userId, 'export');
  if (existing) {
    throw new DuplicateExportRequestError(existing);
  }

  const request = await createDataRequest(userId, 'export', null);
  await recordAuditEvent({
    userId,
    actor: 'user',
    action: 'export_requested',
    target: request.id,
  });

  await runExportJob(request.id);

  const completed = await getDataRequestById(request.id);
  return completed ?? request;
}

/**
 * The actual bundle-build + upload + sign + status-transition sequence.
 * Idempotent-ish in the sense that a re-run against an already-completed
 * request simply re-uploads and re-signs (harmless — `upsert: true` on
 * the Storage write) rather than erroring, matching 00-foundation
 * §1.2's "every job must be idempotent" posture even though this isn't
 * wired to a real scheduler yet.
 */
export async function runExportJob(requestId: string): Promise<void> {
  const request = await getDataRequestById(requestId);
  if (!request) {
    throw new Error(`[export-job] data_requests row ${requestId} not found`);
  }
  if (request.kind !== 'export') {
    throw new Error(`[export-job] data_requests row ${requestId} is not an export request`);
  }

  await updateDataRequestStatus(requestId, { status: 'processing' });

  try {
    const bundle = await buildExportBundle(request.user_id);
    const csv = tradingAccountsToCsv(bundle);

    await ensureExportBucketExists();

    const jsonPath = `${request.user_id}/${requestId}/export.json`;
    const csvPath = `${request.user_id}/${requestId}/export.csv`;

    await uploadExportObject(jsonPath, JSON.stringify(bundle, null, 2), 'application/json');
    await uploadExportObject(csvPath, csv, 'text/csv');

    const [jsonUrl, csvUrl] = await Promise.all([
      createSignedExportUrl(jsonPath, EXPORT_SIGNED_URL_SECONDS),
      createSignedExportUrl(csvPath, EXPORT_SIGNED_URL_SECONDS),
    ]);

    const manifest: ExportArtifactManifest = { jsonUrl, csvUrl };
    const completedAt = new Date();
    const expiresAt = new Date(completedAt.getTime() + EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await updateDataRequestStatus(requestId, {
      status: 'completed',
      completedAt,
      artifactUrl: JSON.stringify(manifest),
      expiresAt,
    });

    await recordAuditEvent({
      userId: request.user_id,
      actor: 'system',
      action: 'export_completed',
      target: requestId,
    });
  } catch (err) {
    console.error(`[export-job] failed for request ${requestId}:`, err);
    await updateDataRequestStatus(requestId, { status: 'failed' }).catch((updateErr) => {
      console.error(`[export-job] also failed to mark request ${requestId} as failed:`, updateErr);
    });
    await recordAuditEvent({
      userId: request.user_id,
      actor: 'system',
      action: 'export_failed',
      target: requestId,
      metadata: { error: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
    throw err;
  }
}
