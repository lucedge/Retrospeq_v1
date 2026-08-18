/**
 * Test-only stand-in analytics for exercising the harness's contract.
 * None of these are registered production analytics — the harness is
 * generic infrastructure and is tested as such, the same way a job-queue
 * library is tested with dummy jobs rather than real ones. Real
 * registrations (the edge engine, detection engine, `spec.weekday`) wait
 * on Module 02's confirmed trades, which don't exist yet — see
 * PROGRESS.md's decision log.
 */
import type { ShadowAnalytic } from '../types';

export interface DummyFact {
  value: number;
}

export const alwaysRenders: ShadowAnalytic<DummyFact> = {
  analytic_id: 'test.always_renders',
  compute: (facts) => ({
    would_render: true,
    payload: { n: facts.length },
    gate_failures: null,
  }),
};

export const neverRenders: ShadowAnalytic<DummyFact> = {
  analytic_id: 'test.never_renders',
  compute: (facts) => ({
    would_render: false,
    payload: { n: facts.length },
    gate_failures: ['sample'],
  }),
};

export const throwsOnCompute: ShadowAnalytic<DummyFact> = {
  analytic_id: 'test.throws',
  compute: () => {
    throw new Error('boom');
  },
};

/** Stands in for the weekday canary's guardrail without implementing its gates. */
export const permanentlyShadowExample: ShadowAnalytic<DummyFact> = {
  analytic_id: 'test.permanently_shadow',
  permanently_shadow: true,
  compute: (facts) => ({
    would_render: facts.length > 0,
    payload: { n: facts.length },
    gate_failures: null,
  }),
};
