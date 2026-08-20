import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseNotConfiguredError } from '../errors';

/**
 * lib/supabase/client.ts — the browser-side Supabase client factory.
 * `@supabase/ssr`'s `createBrowserClient` is mocked: this is a unit test
 * of "does our code call the SDK with the right config" (schema =
 * 'retrospeq', per docs/adr/0002; fails loudly via `requireEnv` when
 * unconfigured), not a claim that a real browser session was verified —
 * that would need an actual browser (see `tmp/dev-screenshots` E2E
 * coverage for the closest real-browser verification this repo has).
 */
const { createBrowserClientMock } = vi.hoisted(() => ({
  createBrowserClientMock: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: createBrowserClientMock,
}));

describe('lib/supabase/client.ts createClient()', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    createBrowserClientMock.mockReset();
    createBrowserClientMock.mockReturnValue({ marker: 'fake-browser-client' });
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  });

  it('calls createBrowserClient with the configured URL/key and the retrospeq schema', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';

    const { createClient } = await import('../client');
    const result = createClient();

    expect(createBrowserClientMock).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key-value',
      { db: { schema: 'retrospeq' } },
    );
    expect(result).toEqual({ marker: 'fake-browser-client' });
  });

  it('throws SupabaseNotConfiguredError instead of constructing a client against undefined env vars', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const { createClient } = await import('../client');
    expect(() => createClient()).toThrow(SupabaseNotConfiguredError);
    expect(createBrowserClientMock).not.toHaveBeenCalled();
  });
});
