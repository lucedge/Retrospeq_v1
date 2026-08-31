import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout, ActionTimeoutError } from '../with-timeout';

/**
 * Module 04 Slice 10e bug-fix pass (2026-08-31) — deterministic regression
 * coverage for the hard-cap-swap "stuck in Swapping… forever" bug the
 * independent tester found (PROGRESS.md, search "REAL BUG: the hard-cap
 * swap gets stuck"). The tester's own reproduction depended on a
 * timing-dependent dev-server artifact (probabilistic, not guaranteed to
 * reproduce on any given run) — this file proves the FIX mechanism itself
 * closes the underlying gap deterministically, with no dependence on that
 * artifact reproducing at all: a promise that deliberately never resolves
 * or rejects (constructed with an executor that calls neither `resolve`
 * nor `reject`, the exact shape of a truly hung network call) is raced
 * against `withTimeout` using vitest's fake timers, so no real wall-clock
 * wait is needed either.
 */

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with ActionTimeoutError once the deadline elapses, for a promise that NEVER settles', async () => {
    // Deliberately hung: neither resolve nor reject ever called, matching a genuinely stuck network stream.
    const neverSettles = new Promise<string>(() => {});

    const raced = withTimeout(neverSettles, 15_000);
    // Attach the assertion before advancing time, so the rejection is
    // observed as soon as it happens rather than raced against fake-timer
    // flushing order.
    const assertion = expect(raced).rejects.toBeInstanceOf(ActionTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('does NOT reject before the deadline — a promise that resolves at 14.9s beats a 15s timeout', async () => {
    let resolveLate!: (v: string) => void;
    const resolvesJustInTime = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });

    const raced = withTimeout(resolvesJustInTime, 15_000);

    await vi.advanceTimersByTimeAsync(14_900);
    resolveLate('made it');
    await vi.advanceTimersByTimeAsync(200); // past the original deadline

    await expect(raced).resolves.toBe('made it');
  });

  it('propagates the ORIGINAL rejection reason, not a timeout, when the promise rejects before the deadline', async () => {
    const originalError = new Error('genuine server rejection');
    let rejectEarly!: (err: unknown) => void;
    const rejectsEarly = new Promise<string>((_resolve, reject) => {
      rejectEarly = reject;
    });

    const raced = withTimeout(rejectsEarly, 15_000);
    const assertion = expect(raced).rejects.toBe(originalError);

    await vi.advanceTimersByTimeAsync(1_000);
    rejectEarly(originalError);
    await assertion;
  });

  it('clears its own deadline timer once the promise settles, leaving zero pending timers behind', async () => {
    const resolvesImmediately = Promise.resolve('done');
    await withTimeout(resolvesImmediately, 15_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
