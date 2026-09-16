import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 06 §4.10 step 6 — the Vercel Cron entry point's auth gate.
 *
 * The job itself is tested live (`lib/review/__tests__/weekly-job.live.
 * test.ts`); what is tested here is the only thing this file adds: an
 * unauthenticated HTTP surface that can mail every trader. Every branch
 * asserts the job was NOT invoked unless the caller proved it holds the
 * secret.
 */
const runJobMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/review/weekly-job', () => ({
  runWeeklyReviewNotificationJobForAllUsers: runJobMock,
}));

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  runJobMock.mockReset().mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
  vi.restoreAllMocks();
});

function request(authorization?: string): Request {
  return new Request('https://app.retrospeq.com/api/cron/weekly-review', {
    headers: authorization ? { authorization } : {},
  });
}

describe('GET /api/cron/weekly-review', () => {
  it('refuses to run at all when CRON_SECRET is unset — never runs unauthenticated', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('../route');
    const res = await GET(request('Bearer anything'));
    expect(res.status).toBe(503);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it('refuses when CRON_SECRET is blank (a set-but-empty env var is not a secret)', async () => {
    process.env.CRON_SECRET = '   ';
    const { GET } = await import('../route');
    const res = await GET(request('Bearer    '));
    expect(res.status).toBe(503);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it('401s a request with no Authorization header', async () => {
    process.env.CRON_SECRET = 'real-secret-value';
    const { GET } = await import('../route');
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it('401s a wrong secret, and a right secret with the wrong scheme', async () => {
    process.env.CRON_SECRET = 'real-secret-value';
    const { GET } = await import('../route');
    expect((await GET(request('Bearer not-the-secret'))).status).toBe(401);
    expect((await GET(request('Basic real-secret-value'))).status).toBe(401);
    expect((await GET(request('real-secret-value'))).status).toBe(401);
    expect(runJobMock).not.toHaveBeenCalled();
  });

  it('runs the real batch job for a correctly authenticated cron request, and tallies outcomes', async () => {
    process.env.CRON_SECRET = 'real-secret-value';
    runJobMock.mockResolvedValue([
      { userId: 'u1', result: { status: 'sent' } },
      { userId: 'u2', result: { status: 'caught_up' } },
      { userId: 'u3', result: { status: 'sent' } },
      { userId: 'u4', result: { status: 'send_failed', error: 'provider 422' } },
    ]);
    const { GET } = await import('../route');
    const res = await GET(request('Bearer real-secret-value'));

    expect(res.status).toBe(200);
    expect(runJobMock).toHaveBeenCalledTimes(1);
    // No caller-supplied input reaches the job — it takes none.
    expect(runJobMock.mock.calls[0]).toHaveLength(0);
    await expect(res.json()).resolves.toEqual({
      users: 4,
      tally: { sent: 2, caught_up: 1, send_failed: 1 },
      failed: 1,
    });
  });

  it('surfaces a whole-batch failure as a 500, never a silent success', async () => {
    process.env.CRON_SECRET = 'real-secret-value';
    runJobMock.mockRejectedValue(new Error('pool exhausted'));
    const { GET } = await import('../route');
    const res = await GET(request('Bearer real-secret-value'));
    expect(res.status).toBe(500);
  });
});
