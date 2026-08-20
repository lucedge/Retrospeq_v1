import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getProfilePrivacy } from '@/lib/privacy/profile-repository';
import { listDataRequestsForUser, type DataRequestRow } from '@/lib/privacy/data-requests-repository';
import { getPendingErasureRequest } from '@/lib/privacy/erasure';
import { getActiveRestriction } from '@/lib/privacy/restriction';
import { devPrivacyToolsEnabled } from '@/lib/privacy/dev-tools-guard';
import type { ExportArtifactManifest } from '@/lib/privacy/export-job';
import {
  updateTelemetryOptOut,
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

  return (
    <section className="flex flex-col gap-8" aria-labelledby="privacy-h">
      <h1 id="privacy-h" className="rq-h1">
        Privacy
      </h1>

      {errorCode && (
        <p className="rq-sub" role="alert">
          {ERROR_MESSAGES[errorCode] ?? 'Something went wrong. Please try again.'}
        </p>
      )}
      {searchParams.telemetryUpdated === '1' && (
        <p className="rq-sub" role="status">
          Telemetry preference updated.
        </p>
      )}
      {searchParams.exportReady === '1' && (
        <p className="rq-sub" role="status">
          Your export is ready below.
        </p>
      )}
      {searchParams.erasureRequested === '1' && (
        <p className="rq-sub" role="status">
          Deletion requested — see below for the grace period.
        </p>
      )}
      {searchParams.erasureCanceled === '1' && (
        <p className="rq-sub" role="status">
          Deletion canceled. Your account is unaffected.
        </p>
      )}
      {searchParams.restrictionRequested === '1' && (
        <p className="rq-sub" role="status">
          Processing restricted for this account.
        </p>
      )}
      {searchParams.restrictionLifted === '1' && (
        <p className="rq-sub" role="status">
          Restriction lifted.
        </p>
      )}

      <div className="rq-well flex flex-col gap-3">
        <h2 className="rq-h2">Sessions &amp; two-factor authentication</h2>
        <p className="rq-sub">Manage active sessions and 2FA on the Security screen.</p>
        <Link href="/security" className="rq-btn rq-btn--ghost">
          Go to Security
        </Link>
      </div>

      <TelemetrySection optedOut={telemetryOptedOut} />

      <RestrictionSection activeRestriction={activeRestriction} />

      <ExportSection latestExport={latestExport} />

      <DeleteAccountSection pendingErasure={pendingErasure} />
    </section>
  );
}

function TelemetrySection({ optedOut }: { optedOut: boolean }) {
  return (
    <div className="rq-well flex flex-col gap-3" aria-labelledby="telemetry-h">
      <h2 id="telemetry-h" className="rq-h2">
        Telemetry
      </h2>
      <p className="rq-sub">
        {optedOut
          ? "You're opted out of product telemetry. We don't record page views or feature usage for this account."
          : 'Product telemetry (page views, feature usage) helps us improve Retrospeq. You can opt out at any time.'}
      </p>
      <form action={updateTelemetryOptOut}>
        <input type="hidden" name="optOut" value={optedOut ? 'false' : 'true'} />
        <button type="submit" className="rq-btn rq-btn--ghost">
          {optedOut ? 'Opt back in' : 'Opt out of telemetry'}
        </button>
      </form>
    </div>
  );
}

/**
 * Story 5.3, GDPR Article 18. A standing, reversible toggle — not a
 * grace-period flow like erasure, since restriction never destroys
 * anything. See `lib/privacy/restriction.ts`'s own doc comment for the
 * honest scope boundary on what "restricted" actually suspends today.
 */
function RestrictionSection({ activeRestriction }: { activeRestriction: DataRequestRow | null }) {
  return (
    <div className="rq-well flex flex-col gap-3" aria-labelledby="restriction-h">
      <h2 id="restriction-h" className="rq-h2">
        Restrict processing
      </h2>
      <p className="rq-sub">
        {activeRestriction
          ? 'Processing is currently restricted for this account.'
          : "Ask us to pause processing your data (beyond what's needed to keep your account itself running) without deleting anything."}
      </p>
      {activeRestriction ? (
        <form action={liftRestrictionAction}>
          <input type="hidden" name="requestId" value={activeRestriction.id} />
          <button type="submit" className="rq-btn rq-btn--ghost">
            Lift restriction
          </button>
        </form>
      ) : (
        <form action={requestRestrictionAction}>
          <button type="submit" className="rq-btn rq-btn--ghost">
            Restrict processing
          </button>
        </form>
      )}
    </div>
  );
}

function ExportSection({ latestExport }: { latestExport: DataRequestRow | null }) {
  const manifest: ExportArtifactManifest | null =
    latestExport?.status === 'completed' && latestExport.artifact_url
      ? (JSON.parse(latestExport.artifact_url) as ExportArtifactManifest)
      : null;

  const inProgress = latestExport?.status === 'pending' || latestExport?.status === 'processing';

  return (
    <div className="rq-well flex flex-col gap-3" aria-labelledby="export-h">
      <h2 id="export-h" className="rq-h2">
        Export your data
      </h2>
      <p className="rq-sub">
        A JSON and CSV bundle of everything Retrospeq has on this account, delivered by a
        short-lived link.
      </p>

      {manifest && (
        <div className="flex flex-col gap-2">
          <p className="rq-sub" role="status">
            Ready
            {latestExport?.expires_at && (
              <> — link expires <time dateTime={latestExport.expires_at}>{latestExport.expires_at}</time></>
            )}
            .
          </p>
          <div className="flex gap-2">
            <a href={manifest.jsonUrl} className="rq-btn rq-btn--ghost">
              Download JSON
            </a>
            <a href={manifest.csvUrl} className="rq-btn rq-btn--ghost">
              Download CSV
            </a>
          </div>
        </div>
      )}

      {inProgress && (
        <p className="rq-sub" role="status">
          Your export is being prepared.
        </p>
      )}

      {!inProgress && (
        <form action={requestExportAction}>
          {/* rq-btn--ghost, not the primary rq-btn — this screen has no
              single "main" action (telemetry/export/delete are peer,
              independent controls; README.md: "if a screen needs two
              primary actions, it's doing two jobs"). */}
          <button type="submit" className="rq-btn rq-btn--ghost">
            {manifest ? 'Request a new export' : 'Export my data'}
          </button>
        </form>
      )}
    </div>
  );
}

function DeleteAccountSection({ pendingErasure }: { pendingErasure: DataRequestRow | null }) {
  return (
    <div className="rq-well flex flex-col gap-3" aria-labelledby="delete-h">
      <h2 id="delete-h" className="rq-h2">
        Delete your account
      </h2>

      {pendingErasure ? (
        <>
          <p className="rq-sub" role="status">
            Deletion pending
            {pendingErasure.expires_at && (
              <>
                {' '}— your account and its data will be permanently deleted on{' '}
                <time dateTime={pendingErasure.expires_at}>{pendingErasure.expires_at}</time>
              </>
            )}
            . Until then, you can cancel.
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
            <div className="rq-well flex flex-col gap-2" data-testid="dev-erasure-tool">
              <p className="rq-sub">
                <strong>Dev only.</strong> Executes this deletion immediately, bypassing the
                7-day grace period. Never available outside development.
              </p>
              <form action={devExecuteErasureNowAction}>
                <input type="hidden" name="requestId" value={pendingErasure.id} />
                <button type="submit" className="rq-btn rq-btn--ghost">
                  Execute deletion now (dev only)
                </button>
              </form>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="rq-sub">
            Deleting your account permanently removes your connected accounts (credentials
            included), subscription, and recovery-code data. You have <strong>7 days</strong> to
            change your mind — cancel any time before then and nothing is removed. Once the 7 days
            pass, everything (starting with your stored credentials) is destroyed and this cannot
            be undone.
          </p>
          <form action={requestErasureAction}>
            {/* Deliberately rq-btn--ghost, never the primary — a
                destructive account-deletion action must never carry more
                visual weight than a neutral peer control (README.md's
                "one .rq-btn per view" + the rq-btn--equal ethics
                reasoning both point the same direction here). */}
            <button type="submit" className="rq-btn rq-btn--ghost">
              Delete my account
            </button>
          </form>
        </>
      )}
    </div>
  );
}
