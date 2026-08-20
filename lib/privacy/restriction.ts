import 'server-only';
import {
  createDataRequest,
  findActiveRequest,
  cancelDataRequest,
  type DataRequestRow,
} from './data-requests-repository';
import { recordAuditEvent } from './audit-repository';

/**
 * Module 01 story 5.3 — GDPR Article 18 "right to restriction of
 * processing," one of the five rights §5.3 requires be "implemented as
 * code paths." Flagged as a genuine gap by retrospeq-qa (2026-08-21):
 * `data_requests.kind` already included `'restriction'` in its check
 * constraint (the migration's own DDL groups it with export/erasure),
 * but nothing created, read, or canceled a row of that kind — an
 * unwired enum value is not a code path.
 *
 * Unlike erasure, restriction has no destructive execution step and no
 * grace period — it's a standing on/off state the trader controls
 * directly, not a one-shot job with a deadline. Reuses the exact same
 * `data_requests` machinery (`createDataRequest`/`findActiveRequest`/
 * `cancelDataRequest`) erasure/export already established, no new
 * schema or RLS needed: `status = 'pending'` means "restriction
 * currently in effect," `status = 'canceled'` means the trader lifted
 * it. `cancelDataRequest`'s existing `WHERE status = 'pending'` guard
 * (data-requests-repository.ts) already does exactly the right thing
 * here without any change.
 *
 * HONEST SCOPE BOUNDARY, same posture as erasure's own grace-period
 * comment: Module 02's sync worker and Module 05's analytics engine
 * don't exist in this repo yet, so "restrict processing" has nothing
 * running to actually suspend today. What's real and built here: the
 * request exists, is visible to the trader, and is a genuine toggle —
 * the two halves of this right that have anything to attach to yet.
 * Once Module 02/05 exist, their own code is what needs to check "is
 * this user's processing currently restricted" before running — that
 * enforcement point does not exist here because the thing it would
 * gate does not exist yet either.
 */

export class DuplicateRestrictionRequestError extends Error {
  readonly existing: DataRequestRow;
  constructor(existing: DataRequestRow) {
    super('Processing is already restricted for this account.');
    this.name = 'DuplicateRestrictionRequestError';
    this.existing = existing;
  }
}

export class RestrictionNotActiveError extends Error {
  constructor() {
    super('There is no active restriction to lift.');
    this.name = 'RestrictionNotActiveError';
  }
}

/** GDPR Article 18: puts the account into a standing "processing
 *  restricted" state — no grace period, no destructive side effect,
 *  reversible any time via `liftRestriction`. */
export async function requestRestriction(userId: string): Promise<DataRequestRow> {
  const existing = await findActiveRequest(userId, 'restriction');
  if (existing) {
    throw new DuplicateRestrictionRequestError(existing);
  }

  const request = await createDataRequest(userId, 'restriction', null);

  await recordAuditEvent({
    userId,
    actor: 'user',
    action: 'restriction_requested',
    target: request.id,
  });

  return request;
}

/** For the Privacy screen's "processing restricted" state. */
export async function getActiveRestriction(userId: string): Promise<DataRequestRow | null> {
  return findActiveRequest(userId, 'restriction');
}

/** Lifts a standing restriction — the trader's own choice, no waiting
 *  period (restriction, unlike erasure, is fully reversible with no
 *  data ever at risk, so there is nothing for a grace period to
 *  protect against here). */
export async function liftRestriction(userId: string, requestId: string): Promise<void> {
  const lifted = await cancelDataRequest(userId, requestId);
  if (!lifted) {
    throw new RestrictionNotActiveError();
  }

  await recordAuditEvent({
    userId,
    actor: 'user',
    action: 'restriction_lifted',
    target: requestId,
  });
}
