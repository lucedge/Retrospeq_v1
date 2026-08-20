import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFactorsMock, deleteFactorMock, createServiceRoleClientMock } = vi.hoisted(() => ({
  listFactorsMock: vi.fn(),
  deleteFactorMock: vi.fn(),
  createServiceRoleClientMock: vi.fn(),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: createServiceRoleClientMock,
}));
vi.mock('server-only', () => ({}));

import { unenrollAllFactorsForUser } from '../mfa-admin';

beforeEach(() => {
  listFactorsMock.mockReset();
  deleteFactorMock.mockReset();
  createServiceRoleClientMock.mockReset();
  createServiceRoleClientMock.mockReturnValue({
    auth: { admin: { mfa: { listFactors: listFactorsMock, deleteFactor: deleteFactorMock } } },
  });
});

describe('unenrollAllFactorsForUser', () => {
  it('deletes every factor returned by listFactors, scoped to the given user', async () => {
    listFactorsMock.mockResolvedValue({
      data: { factors: [{ id: 'factor-1' }, { id: 'factor-2' }] },
      error: null,
    });
    deleteFactorMock.mockResolvedValue({ data: { id: 'factor-1' }, error: null });

    await unenrollAllFactorsForUser('user-1');

    expect(listFactorsMock).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(deleteFactorMock).toHaveBeenCalledTimes(2);
    expect(deleteFactorMock).toHaveBeenCalledWith({ id: 'factor-1', userId: 'user-1' });
    expect(deleteFactorMock).toHaveBeenCalledWith({ id: 'factor-2', userId: 'user-1' });
  });

  it('does nothing (no delete calls) when the user has no factors', async () => {
    listFactorsMock.mockResolvedValue({ data: { factors: [] }, error: null });
    await unenrollAllFactorsForUser('user-1');
    expect(deleteFactorMock).not.toHaveBeenCalled();
  });

  it('throws a named error when listFactors itself fails, never silently proceeding', async () => {
    listFactorsMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(unenrollAllFactorsForUser('user-1')).rejects.toThrow(/listFactors failed/);
    expect(deleteFactorMock).not.toHaveBeenCalled();
  });

  it('throws a named error when a deleteFactor call fails, never faking success for the remaining factors', async () => {
    listFactorsMock.mockResolvedValue({
      data: { factors: [{ id: 'factor-1' }, { id: 'factor-2' }] },
      error: null,
    });
    deleteFactorMock.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });

    await expect(unenrollAllFactorsForUser('user-1')).rejects.toThrow(/deleteFactor\(factor-1\) failed/);
  });
});
