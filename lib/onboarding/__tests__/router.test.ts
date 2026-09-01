import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { resolveOnboardingDestination } from '../router';
import { ONBOARDING_STAGE_ORDER, type OnboardingPath, type OnboardingStage } from '../onboarding-state-repository';

// `router.ts` only ever imports `OnboardingStage`/`OnboardingPath` as
// TYPES from `onboarding-state-repository.ts` (erased at compile time),
// but this test file imports `ONBOARDING_STAGE_ORDER` as a real VALUE from
// that same module for its fast-check generator below, which pulls in
// that file's own `import 'server-only'` guard — mocked here the same way
// every other test in this repo that touches a `server-only`-guarded
// module does.
vi.mock('server-only', () => ({}));

/**
 * Module 08 (Onboarding & Home) §5.1/§5.6/§9 -- Slice 08b unit coverage
 * for the pure onboarding router. §10.1's own test-plan line ("Dashboard
 * state resolution is deterministic and total — every combination of
 * inputs yields exactly one state") applied here to the onboarding router
 * instead of the (not-yet-built) dashboard state machine.
 */

const ALL_PATHS: OnboardingPath[] = ['broker', 'manual'];

describe('resolveOnboardingDestination', () => {
  it('created -> /accounts/connect, regardless of path', () => {
    for (const path of ALL_PATHS) {
      expect(resolveOnboardingDestination('created', path)).toBe('/accounts/connect');
    }
  });

  it('account_connected -> /accounts (no fabricated import-progress screen)', () => {
    expect(resolveOnboardingDestination('account_connected', 'broker')).toBe('/accounts');
  });

  it('history_imported + broker -> /onboarding/hook', () => {
    expect(resolveOnboardingDestination('history_imported', 'broker')).toBe('/onboarding/hook');
  });

  it('history_imported + manual -> /rules/start directly, skipping the Hook screen', () => {
    expect(resolveOnboardingDestination('history_imported', 'manual')).toBe('/rules/start');
  });

  it('rules_calibrated / first_closeout / fields_introduced / complete -> /dashboard, regardless of path', () => {
    const postCalibrationStages: OnboardingStage[] = [
      'rules_calibrated',
      'first_closeout',
      'fields_introduced',
      'complete',
    ];
    for (const stage of postCalibrationStages) {
      for (const path of ALL_PATHS) {
        expect(resolveOnboardingDestination(stage, path)).toBe('/dashboard');
      }
    }
  });

  it('is total and deterministic — every real (stage, path) combination yields exactly one non-empty destination string, called twice always agrees', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ONBOARDING_STAGE_ORDER), fc.constantFrom(...ALL_PATHS), (stage, path) => {
        const first = resolveOnboardingDestination(stage, path);
        const second = resolveOnboardingDestination(stage, path);
        expect(first).toBe(second);
        expect(typeof first).toBe('string');
        expect(first.length).toBeGreaterThan(0);
      }),
    );
  });

  it('never routes a zero-history trader (manual path) through the Hook screen at any stage', () => {
    for (const stage of ONBOARDING_STAGE_ORDER) {
      expect(resolveOnboardingDestination(stage, 'manual')).not.toBe('/onboarding/hook');
    }
  });
});
