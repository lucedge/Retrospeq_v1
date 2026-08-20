/**
 * Module 01 §4.2 (story 4.2 "subscriber wants to manage billing") /
 * §10's dependency list ("billing provider"). PROGRESS.md "Infra gaps":
 * no billing provider account exists for this project. Per AGENTS.md
 * "When something needs the owner — never fake it, always flag it":
 * this file must fail loudly, naming exactly what's missing, never
 * silently no-op or redirect somewhere that only looks real.
 *
 * `subscriptions.provider_ref` (the column Module 01 §3.1 specs for
 * exactly this purpose) already exists in the schema and is read/
 * written correctly by `subscription-repository.ts` — this file is only
 * the "what do we do when a trader clicks the billing-portal link"
 * half, which has no real vendor to call yet.
 */

export class BillingNotConfiguredError extends Error {
  constructor() {
    super(
      'Billing is not connected for this environment yet — no billing provider ' +
        '(e.g. Stripe) account has been configured. See NEEDS_YOUR_INPUT.md.',
    );
    this.name = 'BillingNotConfiguredError';
  }
}

/**
 * Would return a real, short-lived billing-portal URL from the
 * configured provider (keyed off `subscriptions.provider_ref`) once one
 * exists. Throws unconditionally today — there is no vendor to call.
 * TODO(billing): replace this body with a real provider SDK call
 * (Stripe's `billingPortal.sessions.create`, or equivalent) once the
 * owner has created a billing-provider account — see
 * `NEEDS_YOUR_INPUT.md`. Never fall back to a fake/placeholder URL.
 */
export function getBillingPortalUrl(_userId: string, _providerRef: string | null): never {
  throw new BillingNotConfiguredError();
}
