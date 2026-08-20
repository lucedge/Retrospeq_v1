import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseNotConfiguredError } from '../errors';

/**
 * lib/supabase/server.ts — the cookie-backed server client factory used
 * by every Server Action / Route Handler in this slice. `@supabase/ssr`
 * and `next/headers` are mocked: a unit test of "does our code wire the
 * cookie adapter and schema option correctly," not a claim that a real
 * Next.js request context was exercised (Playwright E2E against the dev
 * server is what actually exercises that).
 */
const { createServerClientMock, cookiesMock, cookieStore } = vi.hoisted(() => {
  const store = {
    getAll: vi.fn(() => [{ name: 'sb-access-token', value: 'fake' }]),
    set: vi.fn(),
  };
  return {
    createServerClientMock: vi.fn(),
    cookiesMock: vi.fn(async () => store),
    cookieStore: store,
  };
});
vi.mock('@supabase/ssr', () => ({
  createServerClient: createServerClientMock,
}));
vi.mock('next/headers', () => ({
  cookies: cookiesMock,
}));

describe('lib/supabase/server.ts createClient()', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    createServerClientMock.mockReset();
    createServerClientMock.mockReturnValue({ marker: 'fake-server-client' });
    cookieStore.getAll.mockClear();
    cookieStore.set.mockClear();
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  });

  it('creates a server client scoped to the retrospeq schema, wired to the cookie store', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';

    const { createClient } = await import('../server');
    const result = await createClient();

    expect(createServerClientMock).toHaveBeenCalledTimes(1);
    const [url, key, options] = createServerClientMock.mock.calls[0];
    expect(url).toBe('https://example.supabase.co');
    expect(key).toBe('anon-key-value');
    expect(options.db).toEqual({ schema: 'retrospeq' });
    expect(result).toEqual({ marker: 'fake-server-client' });

    // The cookie adapter's getAll() delegates to the real cookie store.
    expect(options.cookies.getAll()).toEqual([{ name: 'sb-access-token', value: 'fake' }]);
  });

  it('setAll() writes every cookie to the store via cookieStore.set', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';

    const { createClient } = await import('../server');
    await createClient();
    const options = createServerClientMock.mock.calls.at(-1)?.[2];

    options.cookies.setAll([
      { name: 'a', value: '1', options: { path: '/' } },
      { name: 'b', value: '2', options: { path: '/' } },
    ]);

    expect(cookieStore.set).toHaveBeenCalledWith('a', '1', { path: '/' });
    expect(cookieStore.set).toHaveBeenCalledWith('b', '2', { path: '/' });
  });

  it('setAll() swallows the "read-only in a Server Component" error instead of throwing', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
    cookieStore.set.mockImplementationOnce(() => {
      throw new Error('Cookies can only be modified in a Server Action or Route Handler');
    });

    const { createClient } = await import('../server');
    await createClient();
    const options = createServerClientMock.mock.calls.at(-1)?.[2];

    expect(() =>
      options.cookies.setAll([{ name: 'a', value: '1', options: {} }]),
    ).not.toThrow();
  });

  it('throws SupabaseNotConfiguredError instead of constructing a client against undefined env vars', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const { createClient } = await import('../server');
    await expect(createClient()).rejects.toThrow(SupabaseNotConfiguredError);
    expect(createServerClientMock).not.toHaveBeenCalled();
  });
});
