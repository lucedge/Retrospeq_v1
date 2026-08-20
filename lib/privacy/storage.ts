import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service';

/**
 * Module 01 story 5.1: "JSON + CSV bundle by signed URL." 00-foundation
 * §1 names Supabase Storage as this project's object-storage choice.
 * Uses `createServiceRoleClient()` (`lib/supabase/service.ts`) — verified
 * directly against the live shared dev project (2026-08-21, while
 * building this slice) that `.storage.*` calls work correctly through
 * this factory now that its `realtime.transport` placeholder fix is in
 * place (see that file's own doc comment); no separate raw-fetch client
 * is needed here.
 *
 * The export bucket is created lazily, idempotently, and via CODE — not
 * a Supabase-dashboard manual step. Verified directly (2026-08-21): a
 * Storage bucket IS creatable via the service-role key's REST API
 * (`POST /storage/v1/bucket`), same authority level as every other
 * service-role call in this repo, no owner/dashboard action required.
 * `ensureExportBucketExists` tolerates the bucket already existing
 * (idempotent, matches 00-foundation §1.2's "every job must be
 * idempotent" even though this isn't a scheduled job) rather than
 * treating a second call as an error.
 */

export const EXPORT_BUCKET = 'retrospeq-data-exports';

/** Idempotent — safe to call before every export job run, not just once
 *  at deploy time (no deploy-time migration hook exists for Storage
 *  buckets in this repo, unlike SQL migrations). */
export async function ensureExportBucketExists(): Promise<void> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.storage.listBuckets();
  if (error) {
    throw new Error(`[privacy/storage] listBuckets failed: ${error.message}`);
  }
  if (data.some((bucket) => bucket.name === EXPORT_BUCKET)) return;

  const { error: createError } = await supabase.storage.createBucket(EXPORT_BUCKET, {
    public: false,
  });
  // A concurrent caller may have created it between the list and this
  // call — Supabase Storage returns a 409-shaped error naming the bucket
  // as already existing; treat that as success, anything else as real.
  if (createError && !/already exists/i.test(createError.message)) {
    throw new Error(`[privacy/storage] createBucket failed: ${createError.message}`);
  }
}

export async function uploadExportObject(
  path: string,
  content: string,
  contentType: 'application/json' | 'text/csv',
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.storage.from(EXPORT_BUCKET).upload(path, content, {
    contentType,
    upsert: true,
  });
  if (error) {
    throw new Error(`[privacy/storage] upload failed for "${path}": ${error.message}`);
  }
}

/** Signed URLs are short-lived per 00-foundation §4.4's "signed
 *  short-lived URLs for read" screenshot-upload principle, applied here
 *  by the same reasoning even though this is export data rather than a
 *  screenshot — `expiresInSeconds` should never exceed the request's own
 *  `expires_at` (30-day hard cap, §8 quality benchmark), but the caller
 *  (`export-job.ts`) is responsible for that; this function just signs
 *  whatever window it's given. */
export async function createSignedExportUrl(
  path: string,
  expiresInSeconds: number,
): Promise<string> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.storage
    .from(EXPORT_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data) {
    throw new Error(`[privacy/storage] createSignedUrl failed for "${path}": ${error?.message}`);
  }
  return data.signedUrl;
}

/** Not currently called by anything in this slice (nothing deletes an
 *  export bundle early) — exported for completeness against
 *  00-foundation §5.5's retention rules and any future cleanup job, so
 *  the storage module has a full CRUD surface rather than a partial one
 *  a later slice would have to add here anyway. */
export async function deleteExportObject(path: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.storage.from(EXPORT_BUCKET).remove([path]);
  if (error) {
    throw new Error(`[privacy/storage] delete failed for "${path}": ${error.message}`);
  }
}
