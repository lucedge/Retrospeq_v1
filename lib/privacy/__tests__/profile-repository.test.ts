import { describe, expect, it, vi } from 'vitest';

const { withUserConnectionMock } = vi.hoisted(() => ({ withUserConnectionMock: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

import { getProfilePrivacy, setTelemetryOptOut } from '../profile-repository';

describe('lib/privacy/profile-repository.ts', () => {
  it('getProfilePrivacy reads telemetry_opt_out/display_name under the owner-scoped connection', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ telemetry_opt_out: true, display_name: 'A' }] });
    withUserConnectionMock.mockImplementation(async (userId: string, fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );

    const result = await getProfilePrivacy('user-1');

    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(result).toEqual({ telemetry_opt_out: true, display_name: 'A' });
  });

  it('getProfilePrivacy returns null when no row exists', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );

    expect(await getProfilePrivacy('user-1')).toBeNull();
  });

  it('setTelemetryOptOut writes the boolean value, scoped to the caller', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );

    await setTelemetryOptOut('user-1', true);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('update retrospeq.profiles set telemetry_opt_out'),
      [true, 'user-1'],
    );
  });
});
