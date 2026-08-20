import { afterEach, describe, expect, it } from 'vitest';
import { requireEnv, SupabaseNotConfiguredError } from '../errors';

/**
 * AGENTS.md "When something needs the owner — never fake it, always flag
 * it": every Supabase client factory in lib/supabase/ funnels through
 * `requireEnv`, which must throw loudly and name exactly what's missing
 * rather than let a client silently construct against `undefined`.
 */
describe('requireEnv / SupabaseNotConfiguredError', () => {
  const KEY_A = '__RETROSPEQ_TEST_VAR_A__';
  const KEY_B = '__RETROSPEQ_TEST_VAR_B__';

  afterEach(() => {
    delete process.env[KEY_A];
    delete process.env[KEY_B];
  });

  it('returns every requested var when all are present', () => {
    process.env[KEY_A] = 'value-a';
    process.env[KEY_B] = 'value-b';

    expect(requireEnv([KEY_A, KEY_B])).toEqual({ [KEY_A]: 'value-a', [KEY_B]: 'value-b' });
  });

  it('throws SupabaseNotConfiguredError when a var is missing', () => {
    process.env[KEY_A] = 'value-a';
    delete process.env[KEY_B];

    expect(() => requireEnv([KEY_A, KEY_B])).toThrow(SupabaseNotConfiguredError);
  });

  it('names exactly the missing var(s), never the ones that are set', () => {
    process.env[KEY_A] = 'value-a';
    delete process.env[KEY_B];

    try {
      requireEnv([KEY_A, KEY_B]);
      expect.unreachable('requireEnv should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SupabaseNotConfiguredError);
      const typed = err as SupabaseNotConfiguredError;
      expect(typed.missing).toEqual([KEY_B]);
      expect(typed.message).toContain(KEY_B);
      expect(typed.message).not.toContain(KEY_A);
    }
  });

  it('names every missing var when several are absent', () => {
    delete process.env[KEY_A];
    delete process.env[KEY_B];

    try {
      requireEnv([KEY_A, KEY_B]);
      expect.unreachable('requireEnv should have thrown');
    } catch (err) {
      const typed = err as SupabaseNotConfiguredError;
      expect(typed.missing).toEqual([KEY_A, KEY_B]);
    }
  });

  it('treats an empty string env var as missing, not as a valid (blank) value', () => {
    process.env[KEY_A] = '';

    expect(() => requireEnv([KEY_A])).toThrow(SupabaseNotConfiguredError);
  });

  it('never falls back to a placeholder value — throws rather than returning anything', () => {
    delete process.env[KEY_A];

    expect(() => requireEnv([KEY_A])).toThrow();
  });

  it('SupabaseNotConfiguredError carries the right name and points at .env.local.example', () => {
    const err = new SupabaseNotConfiguredError(['FOO', 'BAR']);
    expect(err.name).toBe('SupabaseNotConfiguredError');
    expect(err.missing).toEqual(['FOO', 'BAR']);
    expect(err.message).toContain('FOO, BAR');
    expect(err.message).toContain('.env.local.example');
  });
});
