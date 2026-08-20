import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseNotConfiguredError } from '../errors';

/**
 * lib/supabase/service.ts — the RLS-bypassing service-role client
 * factory (00-foundation §3.2). `server-only` throws unconditionally
 * when its `default` export condition resolves (true under plain Node,
 * which is what `react-server`-aware bundlers avoid at build time —
 * see node_modules/server-only/package.json's `exports` map), so it
 * must be mocked here the same way `@supabase/supabase-js` is; this is
 * a unit test of "does this factory construct the client with the right
 * config and never accept a smuggled default," not a live-network claim.
 */
const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

describe('lib/supabase/service.ts createServiceRoleClient()', () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    createClientMock.mockReset();
    createClientMock.mockReturnValue({ marker: 'fake-service-client' });
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it('constructs the client scoped to the retrospeq schema, with auth persistence disabled', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-value';

    const { createServiceRoleClient } = await import('../service');
    const result = createServiceRoleClient();

    expect(createClientMock).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'service-role-key-value',
      {
        db: { schema: 'retrospeq' },
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );
    expect(result).toEqual({ marker: 'fake-service-client' });
  });

  it('throws SupabaseNotConfiguredError instead of constructing a client against undefined env vars', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { createServiceRoleClient } = await import('../service');
    expect(() => createServiceRoleClient()).toThrow(SupabaseNotConfiguredError);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('names only the missing var when one of the two is set', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { createServiceRoleClient } = await import('../service');
    try {
      createServiceRoleClient();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SupabaseNotConfiguredError);
      expect((err as SupabaseNotConfiguredError).missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
    }
  });
});
