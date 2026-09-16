import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { formatDateTime, formatLongDate } from './format';
import { PrivacyToggle } from './PrivacyToggle';
import { getProfilePrivacy } from '@/lib/privacy/profile-repository';
import { listDataRequestsForUser, type DataRequestRow } from '@/lib/privacy/data-requests-repository';
import { getPendingErasureRequest } from '@/lib/privacy/erasure';
import { getActiveRestriction } from '@/lib/privacy/restriction';
import { devPrivacyToolsEnabled } from '@/lib/privacy/dev-tools-guard';
import type { ExportArtifactManifest } from '@/lib/privacy/export-job';
import {
  updateTelemetryOptOut,
  updateWeeklyReviewEmailOptOut,
  requestExportAction,
  requestErasureAction,
  cancelErasureAction,
  devExecuteErasureNowAction,
  requestRestrictionAction,
  liftRestrictionAction,
} from './actions';

/**
 * Module 01 §5.1 "Privacy screen": "export, delete, telemetry toggle,
 * session list, 2FA." Session list/2FA already live at `/security`
 * (stories 1.4/1.5) — this screen owns export/delete/telemetry (stories
 * 5.1/5.2/5.3/5.4) and links to `/security` for the rest, per that
 * screen's own dispatch note ("a future slice extends this same route").
 *
 * Built against frame 6.9 (`brand/docs/screens/account.html#6.9`):
 * "export and erasure with their pending states. Erasure is a
 * cooling-off with a cancel, not a red button." Each capability is one
 * `.settings__row` — a `.link` for the ones that start a request, a
 * `.switch` for the two standing preferences — and the state each
 * request is in is shown right under its own row, never as a banner at
 * the top. Restriction (story 5.3) and the weekly-email opt-out are
 * rows the frame doesn't draw but the product has; they use the same
 * two shapes rather than a parallel treatment.
 */

const ERROR_MESSAGES: Record<string, string> = {
  PRIVACY_RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
  PRIVACY_INVALID_INPUT: 'Something went wrong. Please try again.',
  EXPORT_IN_PROGRESS: 'Your export is already being prepared.',
  EXPORT_FAILED: "We couldn't prepare your export. Please try again shortly.",
  ERASURE_ALREADY_PENDING: 'A deletion request is already pending for this account.',
  ERASURE_NOT_CANCELABLE: 'This deletion request can no longer be canceled.',
  ERASURE_NOT_EXECUTABLE: 'This deletion request cannot be executed right now.',
  DEV_TOOL_DISABLED: 'That control is not available in this environment.',
  RESTRICTION_ALREADY_ACTIVE: 'Processing is already restricted for this account.',
  RESTRICTION_NOT_ACTIVE: 'There is no active restriction to lift.',
};

export default async function PrivacyPage(props: PageProps<'/privacy'>) {
  const searchParams = await props.searchParams;
  const errorCode = typeof searchParams.error === 'string' ? searchParams.error : undefined;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const [profile, dataRequests, pendingErasure, activeRestriction] = await Promise.all([
    getProfilePrivacy(user.id),
    listDataRequestsForUser(user.id),
    getPendingErasureRequest(user.id),
    getActiveRestriction(user.id),
  ]);

  const latestExport = dataRequests.find((r) => r.kind === 'export') ?? null;
  const telemetryOptedOut = profile?.telemetry_opt_out ?? false;
  const weeklyReviewEmailOptedOut = profile?.weekly_review_email_opt_out ?? false;

  return (
    <section className="privacy flex flex-col gap-4" aria-labelledby="privacy-h">
      <h1 id="privacy-h" className="rq-h1">
        Privacy
      </h1>

      {errorCode && (
        <div className="alert alert--blocking">
          <p role="alert">
            {ERROR_MESSAGES[errorCode] ?? 'Something went wrong. Please try again.'}
          </p>
        </div>
      )}
      {searchParams.telemetryUpdated === '1' && (
        <p className="hint" role="status">
          Telemetry preference updated.
        </p>
      )}
      {searchParams.weeklyReviewEmailUpdated === '1' && (
        <p className="hint" role="status">
          Weekly review email preference updated.
        </p>
      )}
      {searchParams.erasureCanceled === '1' && (
        <p className="hint" role="status">
          Deletion canceled. Your account is unaffected.
        </p>
      )}
      {searchParams.restrictionLifted === '1' && (
        <p className="hint" role="status">
          Restriction lifted.
        </p>
      )}

      <ExportSection latestExport={latestExport} />

      <PrivacyToggle
        action={updateTelemetryOptOut}
        inputId="telemetry-toggle"
        label="Telemetry"
        description="Anonymous usage events. Never trade data."
        on={!telemetryOptedOut}
      />

      {/* Module 06 §4.10 step 6 / Module 07 §5.6 — the one weekly email's
          minimal unsubscribe. */}
      <PrivacyToggle
        action={updateWeeklyReviewEmailOptOut}
        inputId="weekly-email-toggle"
        label="Weekly review email"
        description="One email a week, when your review is ready. The only one we send on a schedule."
        on={!weeklyReviewEmailOptedOut}
      />

      <RestrictionSection activeRestriction={activeRestriction} />

      <div className="settings__row">
        <span className="settings__label">
          <b>Sessions &amp; two-factor</b>
          <span>Managed on the Security screen.</span>
        </span>
        <Link href="/security" className="link">
          Open
        </Link>
      </div>

      <hr className="rq-hr" />

      <DeleteAccountSection pendingErasure={pendingErasure} />
    </section>
  );
}

/**
 * Story 5.3, GDPR Article 18. A standing, reversible request — not a
 * grace-period flow like erasure, since restriction never destroys
 * anything. See `lib/privacy/restriction.ts`'s own doc comment for the
 * honest scope boundary on what "restricted" actually suspends today.
 */
function RestrictionSection({ activeRestriction }: { activeRestriction: DataRequestRow | null }) {
  return (
    <>
      <div className="settings__row">
        <span className="settings__label">
          <b>Restrict processing</b>
          <span>
            {activeRestriction
              ? 'Currently restricted for this account.'
              : 'Pause processing beyond what keeps your account running. Deletes nothing.'}
          </span>
        </span>
        {activeRestriction ? (
          <form action={liftRestrictionAction}>
            <input type="hidden" name="requestId" value={activeRestriction.id} />
            <button type="submit" className="link">
              Lift
            </button>
          </form>
        ) : (
          <form action={requestRestrictionAction}>
            <button type="submit" className="link">
              Request
            </button>
          </form>
        )}
      </div>
      {activeRestriction && (
        <p className="hint" role="status">
          Requested{' '}
          <time dateTime={activeRestriction.requested_at}>
            {formatDateTime(activeRestriction.requested_at) ?? activeRestriction.requested_at}
          </time>
          .
        </p>
      )}
    </>
  );
}

function ExportSection({ latestExport }: { latestExport: DataRequestRow | null }) {
  const manifest: ExportArtifactManifest | null =
    latestExport?.status === 'completed' && latestExport.artifact_url
      ? (JSON.parse(latestExport.artifact_url) as ExportArtifactManifest)
      : null;

  const inProgress = latestExport?.status === 'pending' || latestExport?.status === 'processing';
  const requestedAt = formatDateTime(latestExport?.requested_at);
  const expiresAt = formatDateTime(latestExport?.expires_at);

  return (
    <>
      <div className="settings__row">
        <span className="settings__label">
          <b>Export my data</b>
          <span>Trades, rules, evaluations, strategies — JSON + CSV.</span>
        </span>
        {inProgress ? (
          <span className="chip chip--muted">Preparing</span>
        ) : (
          <form action={requestExportAction}>
            <button type="submit" className="link">
              Request
            </button>
          </form>
        )}
      </div>

      {inProgress && (
        <p className="hint" role="status">
          Your export is being prepared
          {requestedAt ? ` — requested ${requestedAt}` : ''}.
        </p>
      )}

      {manifest && !inProgress && (
        <div className="finding finding--notice" data-confidence="confident">
          <p className="finding__statement" role="status">
            Your export is ready.
          </p>
          {/* No file size: nothing records one (`ExportArtifactManifest`
              is two URLs), and the frame's "2.1 MB" is not a number this
              screen may invent. */}
          <p className="finding__meta">
            {requestedAt ? `Requested ${requestedAt}. ` : ''}
            {expiresAt ? `Link valid until ${expiresAt}. ` : ''}
            <a href={manifest.jsonUrl} className="link">
              Download JSON
            </a>
            {' · '}
            <a href={manifest.csvUrl} className="link">
              Download CSV
            </a>
          </p>
        </div>
      )}
    </>
  );
}

function DeleteAccountSection({ pendingErasure }: { pendingErasure: DataRequestRow | null }) {
  const scheduledFor = formatLongDate(pendingErasure?.expires_at);

  return (
    <>
      <div className="settings__row">
        <span className="settings__label">
          <b>Delete my account</b>
          <span>Everything, permanently, after a 7-day cooling-off you can cancel.</span>
        </span>
        {pendingErasure ? (
          <span className="chip chip--attention">Pending</span>
        ) : (
          <form action={requestErasureAction}>
            {/* A `.link`, never a primary and never red: a destructive
                account-deletion action must not carry more visual weight
                than a neutral peer control (the `.rq-btn--equal` ethics
                reasoning points the same way). */}
            <button type="submit" className="link">
              Request
            </button>
          </form>
        )}
      </div>

      {pendingErasure ? (
        <div className="alert alert--blocking" role="status">
          <h2>
            {scheduledFor ? `Deletion scheduled for ${scheduledFor}` : 'Deletion scheduled'}
          </h2>
          <p>
            Cancel any time before then and nothing is removed. Once it runs, everything —
            starting with your stored credentials — is destroyed, and it can’t be undone.
          </p>
          <form action={cancelErasureAction}>
            <input type="hidden" name="requestId" value={pendingErasure.id} />
            {/* The one genuine primary on this screen, and only in this
                state: reassuring a trader out of an in-progress deletion
                is not the "recommend deletion" ethics problem
                rq-btn--equal exists to prevent — the opposite nudge is
                fine here. */}
            <button type="submit" className="rq-btn">
              Cancel deletion
            </button>
          </form>

          {devPrivacyToolsEnabled() && (
            <div className="flex flex-col gap-2" data-testid="dev-erasure-tool">
              <p className="hint">
                <strong>Dev only.</strong> Executes this deletion immediately, bypassing the
                7-day grace period. Never available outside development.
              </p>
              <form action={devExecuteErasureNowAction}>
                <input type="hidden" name="requestId" value={pendingErasure.id} />
                <button type="submit" className="link">
                  Execute deletion now (dev only)
                </button>
              </form>
            </div>
          )}
        </div>
      ) : (
        <p className="hint">
          Deleting your account permanently removes your connected accounts (credentials
          included), subscription, and recovery-code data. You have 7 days to change your mind.
        </p>
      )}
    </>
  );
}
