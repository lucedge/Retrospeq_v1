import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSupabaseShadowRunRepository,
  ShadowHarnessNotConfiguredError,
} from '../repository';

/**
 * Mocks the Supabase client so the query-construction logic in
 * insert()/listByAnalytic() can be exercised without a live project.
 * This is a unit test of "does our code build the right call" — it is
 * explicitly NOT a claim that a real Supabase write or RLS policy was
 * verified (see shadow_runs.rls.test.ts for that honest gap).
 */
const { fromMock, createClientMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  createClientMock: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

/**
 * AGENTS.md "never fake it": no Supabase project exists for Retrospeq
 * yet. These tests assert the repository fails loudly and names exactly
 * what's missing, rather than silently returning a stub that would let a
 * caller believe a write succeeded.
 */
describe('createSupabaseShadowRunRepository', () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it('throws ShadowHarnessNotConfiguredError naming both missing env vars', () => {
    expect(() => createSupabaseShadowRunRepository()).toThrow(ShadowHarnessNotConfiguredError);

    try {
      createSupabaseShadowRunRepository();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowHarnessNotConfiguredError);
      const typed = err as ShadowHarnessNotConfiguredError;
      expect(typed.missing).toEqual(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    }
  });

  it('names only the one env var that is actually missing', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';

    try {
      createSupabaseShadowRunRepository();
      expect.unreachable();
    } catch (err) {
      const typed = err as ShadowHarnessNotConfiguredError;
      expect(typed.missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
    }
  });

  it('the error message and `missing` array carry only env var names, never values', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'super-secret-value';

    try {
      createSupabaseShadowRunRepository(); // SUPABASE_URL still missing
      expect.unreachable();
    } catch (err) {
      const typed = err as ShadowHarnessNotConfiguredError;
      expect(typed.message).not.toContain('super-secret-value');
      expect(typed.missing.join(',')).not.toContain('super-secret-value');
    }
  });
});

/**
 * Query-construction tests, with `@supabase/supabase-js` mocked (see the
 * comment at the top of the file). These verify insert()/listByAnalytic()
 * call the client correctly and surface its errors/data faithfully — not
 * that a real database accepted the write or enforced RLS.
 */
function makeFilterBuilder<T>(result: { data: T; error: unknown }) {
  const builder = {
    gte: vi.fn(() => makeFilterBuilder(result)),
    then: (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

describe('createSupabaseShadowRunRepository — query construction (mocked client)', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    fromMock.mockReset();
    createClientMock.mockReset();
    createClientMock.mockReturnValue({ from: fromMock });
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it('insert() calls .insert().select().single() on the "shadow_runs" table and returns the row', async () => {
    const row = {
      id: 'row-1',
      user_id: 'user-1',
      analytic_id: 'test.example',
      would_render: false,
      payload: {},
      gate_failures: null,
      computed_at: '2026-08-19T00:00:00Z',
    };
    const singleMock = vi.fn().mockResolvedValue({ data: row, error: null });
    const selectMock = vi.fn().mockReturnValue({ single: singleMock });
    const insertMock = vi.fn().mockReturnValue({ select: selectMock });
    fromMock.mockReturnValue({ insert: insertMock, select: vi.fn() });

    const repo = createSupabaseShadowRunRepository();
    const record = {
      user_id: 'user-1',
      analytic_id: 'test.example',
      would_render: false,
      payload: {},
      gate_failures: null,
    };
    const result = await repo.insert(record);

    expect(fromMock).toHaveBeenCalledWith('shadow_runs');
    expect(insertMock).toHaveBeenCalledWith(record);
    expect(result).toEqual(row);
  });

  it('insert() throws the Supabase error rather than returning a fabricated row', async () => {
    const dbError = new Error('constraint violation');
    const singleMock = vi.fn().mockResolvedValue({ data: null, error: dbError });
    const selectMock = vi.fn().mockReturnValue({ single: singleMock });
    const insertMock = vi.fn().mockReturnValue({ select: selectMock });
    fromMock.mockReturnValue({ insert: insertMock, select: vi.fn() });

    const repo = createSupabaseShadowRunRepository();
    await expect(
      repo.insert({
        user_id: 'user-1',
        analytic_id: 'test.example',
        would_render: false,
        payload: {},
        gate_failures: null,
      }),
    ).rejects.toBe(dbError);
  });

  it('listByAnalytic() filters by analytic_id and returns rows', async () => {
    const rows = [{ id: 'row-1' }];
    const eqMock = vi.fn().mockReturnValue(makeFilterBuilder({ data: rows, error: null }));
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    fromMock.mockReturnValue({ insert: vi.fn(), select: selectMock });

    const repo = createSupabaseShadowRunRepository();
    const result = await repo.listByAnalytic('test.example');

    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('analytic_id', 'test.example');
    expect(result).toEqual(rows);
  });

  it('listByAnalytic() applies a since filter via .gte(computed_at) when provided', async () => {
    const eqResult = makeFilterBuilder({ data: [], error: null });
    const eqMock = vi.fn().mockReturnValue(eqResult);
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    fromMock.mockReturnValue({ insert: vi.fn(), select: selectMock });

    const repo = createSupabaseShadowRunRepository();
    const since = new Date('2026-08-01T00:00:00Z');
    await repo.listByAnalytic('test.example', since);

    expect(eqResult.gte).toHaveBeenCalledWith('computed_at', since.toISOString());
  });

  it('listByAnalytic() throws the Supabase error rather than returning a fabricated empty list', async () => {
    const dbError = new Error('network error');
    const eqMock = vi.fn().mockReturnValue(makeFilterBuilder({ data: null, error: dbError }));
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    fromMock.mockReturnValue({ insert: vi.fn(), select: selectMock });

    const repo = createSupabaseShadowRunRepository();
    await expect(repo.listByAnalytic('test.example')).rejects.toBe(dbError);
  });

  it('listByAnalytic() returns an empty array (not null/undefined) when data is null', async () => {
    const eqMock = vi.fn().mockReturnValue(makeFilterBuilder({ data: null, error: null }));
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    fromMock.mockReturnValue({ insert: vi.fn(), select: selectMock });

    const repo = createSupabaseShadowRunRepository();
    const result = await repo.listByAnalytic('test.example');

    expect(result).toEqual([]);
  });
});
