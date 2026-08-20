import { describe, expect, it, vi, beforeEach } from 'vitest';

const { createServiceRoleClientMock } = vi.hoisted(() => ({
  createServiceRoleClientMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: createServiceRoleClientMock,
}));

import { EXPORT_BUCKET, ensureExportBucketExists, uploadExportObject, createSignedExportUrl, deleteExportObject } from '../storage';

function fakeSupabase(overrides: Record<string, unknown> = {}) {
  const storage = {
    listBuckets: vi.fn().mockResolvedValue({ data: [], error: null }),
    createBucket: vi.fn().mockResolvedValue({ error: null }),
    from: vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ error: null }),
      createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x' }, error: null }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    })),
    ...overrides,
  };
  return { storage };
}

describe('lib/privacy/storage.ts', () => {
  beforeEach(() => {
    createServiceRoleClientMock.mockReset();
  });

  describe('ensureExportBucketExists', () => {
    it('creates the bucket when it does not exist yet', async () => {
      const supabase = fakeSupabase();
      createServiceRoleClientMock.mockReturnValue(supabase);

      await ensureExportBucketExists();

      expect(supabase.storage.listBuckets).toHaveBeenCalledTimes(1);
      expect(supabase.storage.createBucket).toHaveBeenCalledWith(EXPORT_BUCKET, { public: false });
    });

    it('is idempotent — does not attempt to create the bucket again if it already exists', async () => {
      const supabase = fakeSupabase({
        listBuckets: vi.fn().mockResolvedValue({ data: [{ name: EXPORT_BUCKET }], error: null }),
      });
      createServiceRoleClientMock.mockReturnValue(supabase);

      await ensureExportBucketExists();

      expect(supabase.storage.createBucket).not.toHaveBeenCalled();
    });

    it('tolerates a concurrent-create race ("already exists" error) rather than throwing', async () => {
      const supabase = fakeSupabase({
        createBucket: vi.fn().mockResolvedValue({ error: { message: 'Bucket already exists' } }),
      });
      createServiceRoleClientMock.mockReturnValue(supabase);

      await expect(ensureExportBucketExists()).resolves.toBeUndefined();
    });

    it('throws on a genuine createBucket failure', async () => {
      const supabase = fakeSupabase({
        createBucket: vi.fn().mockResolvedValue({ error: { message: 'permission denied' } }),
      });
      createServiceRoleClientMock.mockReturnValue(supabase);

      await expect(ensureExportBucketExists()).rejects.toThrow(/permission denied/);
    });

    it('throws on a listBuckets failure', async () => {
      const supabase = fakeSupabase({
        listBuckets: vi.fn().mockResolvedValue({ data: null, error: { message: 'network error' } }),
      });
      createServiceRoleClientMock.mockReturnValue(supabase);

      await expect(ensureExportBucketExists()).rejects.toThrow(/network error/);
    });
  });

  it('uploadExportObject uploads with the given content type and upsert:true', async () => {
    const uploadMock = vi.fn().mockResolvedValue({ error: null });
    const supabase = fakeSupabase();
    supabase.storage.from = vi.fn(() => ({ upload: uploadMock }));
    createServiceRoleClientMock.mockReturnValue(supabase);

    await uploadExportObject('u1/r1/export.json', '{"a":1}', 'application/json');

    expect(supabase.storage.from).toHaveBeenCalledWith(EXPORT_BUCKET);
    expect(uploadMock).toHaveBeenCalledWith('u1/r1/export.json', '{"a":1}', {
      contentType: 'application/json',
      upsert: true,
    });
  });

  it('uploadExportObject throws on a storage error', async () => {
    const supabase = fakeSupabase();
    supabase.storage.from = vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ error: { message: 'quota exceeded' } }),
    }));
    createServiceRoleClientMock.mockReturnValue(supabase);

    await expect(uploadExportObject('p', 'c', 'text/csv')).rejects.toThrow(/quota exceeded/);
  });

  it('createSignedExportUrl returns the signed URL', async () => {
    const supabase = fakeSupabase();
    createServiceRoleClientMock.mockReturnValue(supabase);

    const url = await createSignedExportUrl('u1/r1/export.json', 3600);
    expect(url).toBe('https://signed.example/x');
  });

  it('createSignedExportUrl throws when signing fails', async () => {
    const supabase = fakeSupabase();
    supabase.storage.from = vi.fn(() => ({
      createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
    }));
    createServiceRoleClientMock.mockReturnValue(supabase);

    await expect(createSignedExportUrl('missing', 3600)).rejects.toThrow(/not found/);
  });

  it('deleteExportObject removes the object', async () => {
    const removeMock = vi.fn().mockResolvedValue({ error: null });
    const supabase = fakeSupabase();
    supabase.storage.from = vi.fn(() => ({ remove: removeMock }));
    createServiceRoleClientMock.mockReturnValue(supabase);

    await deleteExportObject('u1/r1/export.json');
    expect(removeMock).toHaveBeenCalledWith(['u1/r1/export.json']);
  });
});
