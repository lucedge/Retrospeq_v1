import { describe, expect, it, vi } from 'vitest';

const { withServiceRoleConnectionMock } = vi.hoisted(() => ({
  withServiceRoleConnectionMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/direct', () => ({
  withServiceRoleConnection: withServiceRoleConnectionMock,
}));

import { hashEmail, recordErasureTombstone } from '../tombstone-repository';

describe('hashEmail', () => {
  it('is a stable sha256 hex digest', () => {
    const hash = hashEmail('Trader@Example.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is case- and whitespace-insensitive — same email hashes identically regardless of casing', () => {
    expect(hashEmail('Trader@Example.com')).toBe(hashEmail('  trader@example.com  '));
  });

  it('different emails hash differently', () => {
    expect(hashEmail('a@example.com')).not.toBe(hashEmail('b@example.com'));
  });

  it('never returns the raw email', () => {
    const email = 'trader@example.com';
    expect(hashEmail(email)).not.toBe(email);
  });
});

describe('recordErasureTombstone', () => {
  it('inserts the hashed email (never the raw address) and the request id, via the service role', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );

    await recordErasureTombstone('Trader@Example.com', 'request-id-123');

    expect(withServiceRoleConnectionMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('insert into retrospeq.erasure_tombstones'),
      [hashEmail('Trader@Example.com'), 'request-id-123'],
    );
    // The raw email is never a query parameter.
    const params = queryMock.mock.calls[0][1] as string[];
    expect(params).not.toContain('Trader@Example.com');
  });
});
