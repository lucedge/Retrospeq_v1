import 'server-only';

/**
 * Module 01 story 5.2's "confirmation email" (erasure) needs to send an
 * arbitrary, app-authored transactional email to an address — this is
 * NOT the same dependency as Supabase Auth's own mailer (which only ever
 * sends Auth-flow emails it generates itself: signup confirmation,
 * password reset — see `lib/auth/errors.ts`'s `AUTH_MAILER_UNAVAILABLE`
 * mapping and `docs/infra-gaps.md`'s Auth-mailer entry, resolved
 * separately via Resend SMTP). GoTrue's admin API
 * (`supabase.auth.admin.*`) exposes no "send this arbitrary email"
 * method at all.
 *
 * 00-foundation §10's dependency table lists "Email provider |
 * Transactional | Low | —" as its OWN row, separate from "Supabase | DB,
 * auth, storage" — a genuinely distinct dependency.
 *
 * As of 2026-09-14 this IS wired to a real provider: Resend
 * (`RESEND_API_KEY` + `EMAIL_FROM`, owner-created account, sender domain
 * `notifications.retrospeq.com` verified). Plain `fetch` against
 * Resend's REST API — no SDK dependency, smaller supply-chain surface
 * for something that holds a live API key. `getTransactionalEmailProvider`
 * still throws `EmailProviderNotConfiguredError` (never a no-op "pretend
 * it sent" success) whenever either env var is missing or `EMAIL_FROM`
 * doesn't look like an address — the same "never fake it" shape as
 * `lib/broker/envelope-encryption.ts`'s `KmsNotConfiguredError` and
 * `lib/entitlements/billing.ts`'s `BillingNotConfiguredError`. Env is
 * read lazily, at call time, not at module load — so tests (and a
 * misconfigured deploy) see a real, current failure, not a stale one
 * cached from process start.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 20_000;
const DEFAULT_FROM_NAME = 'Retrospeq';

// Deliberately permissive (not full RFC 5322) — this only needs to catch
// obviously-wrong configuration/input (a name, a blank string, a
// multi-line pasted header), not validate exhaustively. Resend itself is
// the final authority on deliverability.
const EMAIL_ADDRESS_RE = /^[^\s@<>()[\]:;,]+@[^\s@<>()[\]:;,]+\.[^\s@<>()[\]:;,]+$/;

export class EmailProviderNotConfiguredError extends Error {
  /** Which env var(s) are missing or invalid — empty when constructed
   *  with no detail (kept optional so existing callers/tests that throw
   *  `new EmailProviderNotConfiguredError()` with no args keep working). */
  readonly missing: string[];

  constructor(missing: string[] = [], reason?: string) {
    super(
      'No transactional email provider is configured for this environment yet ' +
        '(00-foundation §10 "Email provider" — a separate dependency from Supabase ' +
        "Auth's own mailer, which only sends Auth-flow emails it generates itself)." +
        (missing.length > 0 ? ` Missing or invalid: ${missing.join(', ')}.` : '') +
        (reason ? ` ${reason}.` : '') +
        ' Set RESEND_API_KEY and EMAIL_FROM in .env.local (see .env.local.example) — ' +
        'never falls back to a no-op "pretend it sent" success.',
    );
    this.name = 'EmailProviderNotConfiguredError';
    this.missing = missing;
  }
}

/** Non-2xx response from Resend. Carries the HTTP status and, when
 *  Resend returned a JSON error body, its `name`/`message` — never the
 *  API key, never the recipient address or body (those aren't part of
 *  this error at all). */
export class EmailSendFailedError extends Error {
  readonly status: number;

  constructor(status: number, providerDetail?: string) {
    super(
      `Resend rejected the email send: HTTP ${status}${providerDetail ? ` — ${providerDetail}` : ''}.`,
    );
    this.name = 'EmailSendFailedError';
    this.status = status;
  }
}

export interface TransactionalEmailProvider {
  send(to: string, subject: string, body: string): Promise<void>;
}

function assertSendableInput(to: string, subject: string, body: string): void {
  if (!EMAIL_ADDRESS_RE.test(to)) {
    throw new Error('Email recipient does not look like a valid email address.');
  }
  if (/[\r\n]/.test(subject)) {
    // CR/LF in a header field is header-injection territory (extra
    // Bcc/To lines) — reject before it ever reaches the wire.
    throw new Error('Email subject must not contain line breaks.');
  }
  if (subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error(
      `Email subject must be 1-${MAX_SUBJECT_LENGTH} characters (got ${subject.length}).`,
    );
  }
  if (body.length === 0 || body.length > MAX_BODY_LENGTH) {
    throw new Error(`Email body must be 1-${MAX_BODY_LENGTH} characters (got ${body.length}).`);
  }
}

class ResendEmailProvider implements TransactionalEmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fromHeader: string,
  ) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    assertSendableInput(to, subject, body);

    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: this.fromHeader, to: [to], subject, text: body }),
        // No automatic retries — callers on this path (erasure's
        // confirmation email) are best-effort and a retry could double-send.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error / timeout — never include `this.apiKey` here.
      throw new Error(
        `Could not reach Resend to send the email: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      let providerDetail: string | undefined;
      try {
        const payload = (await response.json()) as { name?: string; message?: string };
        providerDetail = [payload.name, payload.message].filter(Boolean).join(': ') || undefined;
      } catch {
        // Resend's error body wasn't JSON (or was empty) — the HTTP
        // status alone is still informative enough to throw on.
      }
      throw new EmailSendFailedError(response.status, providerDetail);
    }
  }
}

/**
 * Returns a real Resend-backed provider, or throws
 * `EmailProviderNotConfiguredError` naming exactly which env var is
 * missing/invalid. Never returns a working-looking stub.
 */
export function getTransactionalEmailProvider(): TransactionalEmailProvider {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new EmailProviderNotConfiguredError(['RESEND_API_KEY']);
  }

  const from = process.env.EMAIL_FROM?.trim();
  if (!from) {
    throw new EmailProviderNotConfiguredError(['EMAIL_FROM']);
  }
  if (!EMAIL_ADDRESS_RE.test(from)) {
    throw new EmailProviderNotConfiguredError(
      ['EMAIL_FROM'],
      `EMAIL_FROM ("${from}") does not look like a valid email address`,
    );
  }

  const fromName = process.env.EMAIL_FROM_NAME?.trim() || DEFAULT_FROM_NAME;
  return new ResendEmailProvider(apiKey, `${fromName} <${from}>`);
}
