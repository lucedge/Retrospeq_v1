import { defineConfig } from '@playwright/test';

/**
 * Module 01 §7.4 E2E coverage, run against a manually-started `next dev`
 * server (see PROGRESS.md test-report notes for the exact port — Next.js
 * picks the next free port when 3000 is occupied). No `webServer` block:
 * this repo's dev server needs `.env.local` (real Supabase project
 * credentials), and starting/stopping it per test run is the tester's
 * job, done explicitly, not implicitly by Playwright.
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
});
