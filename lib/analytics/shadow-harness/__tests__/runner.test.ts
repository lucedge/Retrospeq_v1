import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { uuidv7 } from 'uuidv7';
import { runShadowAnalytic, runShadowAnalyticBatch, ShadowComputeError } from '../runner';
import {
  alwaysRenders,
  neverRenders,
  throwsOnCompute,
  type DummyFact,
} from './fixtures';

describe('runShadowAnalytic', () => {
  it('persists a record even when would_render is false — shadow mode never renders, but it always records', () => {
    const userId = uuidv7();
    const record = runShadowAnalytic(neverRenders, userId, [{ value: 1 }]);

    expect(record.would_render).toBe(false);
    expect(record.user_id).toBe(userId);
    expect(record.analytic_id).toBe('test.never_renders');
    expect(record.gate_failures).toEqual(['sample']);
  });

  it('carries through a would_render:true result unchanged (there is no render path here to trigger)', () => {
    const userId = uuidv7();
    const record = runShadowAnalytic(alwaysRenders, userId, [{ value: 1 }, { value: 2 }]);

    expect(record.would_render).toBe(true);
    expect(record.payload).toEqual({ n: 2 });
  });

  it('re-throws a ShadowComputeError, naming the analytic and user, rather than fabricating a result', () => {
    const userId = uuidv7();

    expect(() => runShadowAnalytic(throwsOnCompute, userId, [])).toThrow(ShadowComputeError);

    try {
      runShadowAnalytic(throwsOnCompute, userId, []);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowComputeError);
      const shadowErr = err as ShadowComputeError;
      expect(shadowErr.analytic_id).toBe('test.throws');
      expect(shadowErr.user_id).toBe(userId);
      expect(shadowErr.cause).toBeInstanceOf(Error);
    }
  });

  it('is faithful to whatever compute() returns, for any facts array (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ value: fc.integer() })),
        fc.uuid(),
        fc.boolean(),
        (facts: DummyFact[], userId, wouldRender) => {
          const analytic = {
            analytic_id: 'test.property',
            compute: () => ({
              would_render: wouldRender,
              payload: { count: facts.length },
              gate_failures: wouldRender ? null : ['sample'],
            }),
          };
          const record = runShadowAnalytic(analytic, userId, facts);
          expect(record.would_render).toBe(wouldRender);
          expect(record.payload).toEqual({ count: facts.length });
          expect(record.user_id).toBe(userId);
          expect(record.analytic_id).toBe('test.property');
        },
      ),
    );
  });
});

describe('runShadowAnalyticBatch', () => {
  it('separates successes and failures instead of letting one user abort the batch', () => {
    const okUser = uuidv7();
    const badUser = uuidv7();
    const facts = new Map<string, DummyFact[]>([
      [okUser, [{ value: 1 }]],
      [badUser, [{ value: 2 }]],
    ]);

    // A mixed analytic: throws only for the "bad" user's facts.
    const mixed = {
      analytic_id: 'test.mixed',
      compute: (fs: DummyFact[]) => {
        if (fs.some((f) => f.value === 2)) throw new Error('nope');
        return { would_render: true, payload: {}, gate_failures: null };
      },
    };

    const { succeeded, failed } = runShadowAnalyticBatch(mixed, facts);

    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].user_id).toBe(okUser);
    expect(failed).toHaveLength(1);
    expect(failed[0].user_id).toBe(badUser);
    expect(failed[0]).toBeInstanceOf(ShadowComputeError);
  });
});
