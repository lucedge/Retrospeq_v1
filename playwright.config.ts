import { defineConfig } from '@playwright/test';
import './e2e/helpers'; // loads .env.local into process.env (Playwright doesn't)

/**
 * E2E against the real dev server + shared dev Supabase project.
 *
 * `webServer` reuses an already-running `next dev` on :3000 (the normal
 * case during a slice) and starts one otherwise, with the fail-closed
 * rate-limit bypass on so a full run doesn't trip Module 01 §7.2's
 * sign-in throttle (docs/adr/0042). Prefer `npm run e2e:changed` (1–3
 * spec files for the routes a change touched) over the full suite.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
    env: { RETROSPEQ_E2E_RATE_LIMIT_BYPASS: 'true' },
  },
});
