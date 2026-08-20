import { test, expect } from '@playwright/test';
import { deleteAuthUserByEmail, uniqueTestEmail } from './helpers';

/**
 * Module 01 §7.4 E2E: "Sign-up -> connect -> first import -> dashboard"
 * is the module's full core flow, but connect/import belong to Module
 * 02 (not built in this slice) — this suite covers the slice actually
 * shipped (stories 1.1-1.3: email/Google signup, sign-in, sign-out,
 * password reset) against the real, running dev server + real Supabase
 * Auth project (.env.local), per this task's brief. Screenshots saved
 * to tmp/dev-screenshots/ (gitignored) and read back per AGENTS.md "UI
 * self-verification" — captured here via `page.screenshot()`, not the
 * separate CLI form, since these flows need interaction first.
 */

const TEST_PASSWORD = 'Retrospeq-E2E-Pass-1234!';
const createdEmails: string[] = [];

test.afterAll(async () => {
  for (const email of createdEmails) {
    await deleteAuthUserByEmail(email).catch(() => {});
  }
});

test('signup happy path — empty state, then "check your email" (mailer_autoconfirm is off on this project)', async ({
  page,
}) => {
  const email = uniqueTestEmail('signup-happy');
  createdEmails.push(email);

  await page.goto('/signup');
  await expect(page.locator('h1')).toHaveText('Create your account');
  await page.screenshot({ path: 'tmp/dev-screenshots/signup-empty.png' });

  // Exactly one *primary* (filled) .rq-btn on this view — the design
  // system's "one .rq-btn per view" rule (retrospeq-design-system/
  // brand/README.md) is about primary emphasis, not the shared base
  // class: `.rq-btn--ghost` is the sanctioned secondary companion
  // (see brand/css/components.css's own comment), which is exactly
  // what "Continue with Google" uses here — confirmed once rather than
  // per-test.
  await expect(page.locator('button.rq-btn:not(.rq-btn--ghost):not(.rq-btn--equal)')).toHaveCount(
    1,
  );
  await expect(page.locator('button.rq-btn--ghost')).toHaveCount(1);

  await page.fill('#email', email);
  await page.fill('#password', TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.locator('h1')).toHaveText('Check your email', { timeout: 10_000 });
  await expect(page.locator('body')).toContainText('Check your email to confirm your account');
  await page.screenshot({ path: 'tmp/dev-screenshots/signup-success.png' });
});

test('signup with an already-registered email shows the mapped error, not a raw vendor string', async ({
  page,
}) => {
  const email = uniqueTestEmail('signup-dupe');
  createdEmails.push(email);

  // First signup — establishes the account.
  await page.goto('/signup');
  await page.fill('#email', email);
  await page.fill('#password', TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('h1')).toHaveText('Check your email', { timeout: 10_000 });

  // Second signup with the same email — the actual case under test.
  await page.goto('/signup');
  await page.fill('#email', email);
  await page.fill('#password', TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // See the sign-in test below for why this is scoped to `form
  // p[role="alert"]` rather than a bare `[role="alert"]`.
  const alert = page.locator('form p[role="alert"]');
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert).toContainText('An account already exists for that email');
  await page.screenshot({ path: 'tmp/dev-screenshots/signup-existing-email-error.png' });
});

test('sign-in with invalid credentials shows a plain "email or password isn\'t right" message', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.locator('h1')).toHaveText('Sign in');
  await page.screenshot({ path: 'tmp/dev-screenshots/login-empty.png' });

  await page.fill('#email', uniqueTestEmail('never-registered'));
  await page.fill('#password', 'some-wrong-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Scoped to the form's own error paragraph, not `[role="alert"]` alone —
  // that also matches Next.js's built-in route-announcer div
  // (`#__next-route-announcer__`), which every app-router page carries
  // for a11y route-change announcements and which also happens to be
  // `role="alert"`. A bare `[role="alert"]` locator is a strict-mode
  // violation the moment that div exists, which is always.
  const alert = page.locator('form p[role="alert"]');
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert).toContainText("That email or password isn't right.");
  await page.screenshot({ path: 'tmp/dev-screenshots/login-invalid-credentials-error.png' });
});

test('password reset request returns the identical response for an existing vs a non-existent email (no enumeration)', async ({
  page,
}) => {
  const existingEmail = uniqueTestEmail('reset-existing');
  createdEmails.push(existingEmail);

  // Create a real account first so "existing" is genuine, not assumed.
  await page.goto('/signup');
  await page.fill('#email', existingEmail);
  await page.fill('#password', TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('h1')).toHaveText('Check your email', { timeout: 10_000 });

  await page.goto('/reset-password');
  await expect(page.locator('h1')).toHaveText('Reset your password');
  await page.screenshot({ path: 'tmp/dev-screenshots/reset-password-empty.png' });
  await page.fill('#email', existingEmail);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.locator('h1')).toHaveText('Check your email', { timeout: 10_000 });
  const existingMessage = await page.locator('body').textContent();

  await page.goto('/reset-password');
  await page.fill('#email', uniqueTestEmail('reset-nonexistent'));
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.locator('h1')).toHaveText('Check your email', { timeout: 10_000 });
  const nonexistentMessage = await page.locator('body').textContent();
  await page.screenshot({ path: 'tmp/dev-screenshots/reset-password-success.png' });

  expect(existingMessage).toBe(nonexistentMessage);
  expect(existingMessage).toContain('If an account exists for that email');
});

test('reset-password/confirm renders its empty state (design-system screenshot check)', async ({
  page,
}) => {
  // Reached in production only via a real emailed link exchanged by
  // /auth/callback — direct navigation here has no active recovery
  // session, so the *form* still renders (this page has no server-side
  // gate of its own; the update itself will fail without a session,
  // which is exercised by unit coverage of confirmPasswordReset's error
  // path via mapAuthError, not by a live click here).
  await page.goto('/reset-password/confirm');
  await expect(page.locator('h1')).toHaveText('Choose a new password');
  await page.screenshot({ path: 'tmp/dev-screenshots/reset-password-confirm-empty.png' });
});
