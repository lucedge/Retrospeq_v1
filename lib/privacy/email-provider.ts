/**
 * Module 01 story 5.2's "confirmation email" (erasure) needs to send an
 * arbitrary, app-authored transactional email to an address — this is
 * NOT the same dependency as Supabase Auth's own mailer (which only ever
 * sends Auth-flow emails it generates itself: signup confirmation,
 * password reset — see `lib/auth/errors.ts`'s `AUTH_MAILER_UNAVAILABLE`
 * mapping and `NEEDS_YOUR_INPUT.md`'s existing entry for that). GoTrue's
 * admin API (`supabase.auth.admin.*`, checked directly against
 * `node_modules/@supabase/auth-js`'s shipped types before writing this
 * file) exposes no "send this arbitrary email" method at all.
 *
 * 00-foundation §10's dependency table lists "Email provider |
 * Transactional | Low | —" as its OWN row, separate from "Supabase | DB,
 * auth, storage" — confirming this is a genuinely distinct, not-yet-built
 * dependency (no Resend/SendGrid/Postmark/etc account or SDK configured
 * anywhere in this repo), not something already covered by the existing
 * Supabase Auth mailer gap. Per AGENTS.md "never fake it": this file
 * fails loudly, naming exactly what's missing, the same shape as
 * `lib/broker/envelope-encryption.ts`'s `KmsNotConfiguredError` and
 * `lib/entitlements/billing.ts`'s `BillingNotConfiguredError`.
 */

export class EmailProviderNotConfiguredError extends Error {
  constructor() {
    super(
      'No transactional email provider is configured for this environment yet ' +
        '(00-foundation §10 "Email provider" — a separate dependency from Supabase ' +
        "Auth's own mailer, which only sends Auth-flow emails it generates itself). " +
        'See NEEDS_YOUR_INPUT.md.',
    );
    this.name = 'EmailProviderNotConfiguredError';
  }
}

export interface TransactionalEmailProvider {
  send(to: string, subject: string, body: string): Promise<void>;
}

/**
 * Would return a real provider client once one is configured (an env var
 * naming the vendor plus its API key, none of which exist yet — see
 * PROGRESS.md "Infra gaps"). Throws unconditionally today.
 * TODO(email-provider): replace this body with a real SDK call once the
 * owner has created a transactional-email-provider account. Never fall
 * back to a no-op "pretend it sent" success.
 */
export function getTransactionalEmailProvider(): TransactionalEmailProvider {
  throw new EmailProviderNotConfiguredError();
}
