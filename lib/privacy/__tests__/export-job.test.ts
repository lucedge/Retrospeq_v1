import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  createDataRequestMock,
  findActiveRequestMock,
  getDataRequestByIdMock,
  updateDataRequestStatusMock,
  recordAuditEventMock,
  buildExportBundleMock,
  tradingAccountsToCsvMock,
  ensureExportBucketExistsMock,
  uploadExportObjectMock,
  createSignedExportUrlMock,
} = vi.hoisted(() => ({
  createDataRequestMock: vi.fn(),
  findActiveRequestMock: vi.fn(),
  getDataRequestByIdMock: vi.fn(),
  updateDataRequestStatusMock: vi.fn(),
  recordAuditEventMock: vi.fn(),
  buildExportBundleMock: vi.fn(),
  tradingAccountsToCsvMock: vi.fn(),
  ensureExportBucketExistsMock: vi.fn(),
  uploadExportObjectMock: vi.fn(),
  createSignedExportUrlMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../data-requests-repository', () => ({
  createDataRequest: createDataRequestMock,
  findActiveRequest: findActiveRequestMock,
  getDataRequestById: getDataRequestByIdMock,
  updateDataRequestStatus: updateDataRequestStatusMock,
}));
vi.mock('../audit-repository', () => ({
  recordAuditEvent: recordAuditEventMock,
}));
vi.mock('../export', () => ({
  buildExportBundle: buildExportBundleMock,
  tradingAccountsToCsv: tradingAccountsToCsvMock,
}));
vi.mock('../storage', () => ({
  ensureExportBucketExists: ensureExportBucketExistsMock,
  uploadExportObject: uploadExportObjectMock,
  createSignedExportUrl: createSignedExportUrlMock,
}));

import { requestExport, runExportJob, DuplicateExportRequestError } from '../export-job';

const REQUEST = { id: 'req-1', user_id: 'user-1', kind: 'export', status: 'pending', requested_at: 't', completed_at: null, artifact_url: null, expires_at: null };

describe('runExportJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDataRequestByIdMock.mockResolvedValue(REQUEST);
    buildExportBundleMock.mockResolvedValue({ tradingAccounts: [] });
    tradingAccountsToCsvMock.mockReturnValue('id,label\n');
    createSignedExportUrlMock.mockImplementation(async (path: string) => `https://signed.example/${path}`);
    updateDataRequestStatusMock.mockResolvedValue(undefined);
    recordAuditEventMock.mockResolvedValue(undefined);
  });

  it('marks processing, builds+uploads the bundle, signs both files, and marks completed with a manifest', async () => {
    await runExportJob('req-1');

    expect(updateDataRequestStatusMock).toHaveBeenNthCalledWith(1, 'req-1', { status: 'processing' });
    expect(ensureExportBucketExistsMock).toHaveBeenCalledTimes(1);
    expect(uploadExportObjectMock).toHaveBeenCalledWith(
      'user-1/req-1/export.json',
      expect.any(String),
      'application/json',
    );
    expect(uploadExportObjectMock).toHaveBeenCalledWith('user-1/req-1/export.csv', 'id,label\n', 'text/csv');

    const finalCall = updateDataRequestStatusMock.mock.calls.at(-1);
    expect(finalCall![0]).toBe('req-1');
    expect(finalCall![1].status).toBe('completed');
    expect(finalCall![1].completedAt).toBeInstanceOf(Date);
    expect(finalCall![1].expiresAt).toBeInstanceOf(Date);
    const manifest = JSON.parse(finalCall![1].artifactUrl);
    expect(manifest.jsonUrl).toContain('export.json');
    expect(manifest.csvUrl).toContain('export.csv');

    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', actor: 'system', action: 'export_completed', target: 'req-1' }),
    );
  });

  it('throws if the row is not found', async () => {
    getDataRequestByIdMock.mockResolvedValue(null);
    await expect(runExportJob('missing')).rejects.toThrow(/not found/);
  });

  it('throws if the row is not an export request', async () => {
    getDataRequestByIdMock.mockResolvedValue({ ...REQUEST, kind: 'erasure' });
    await expect(runExportJob('req-1')).rejects.toThrow(/not an export request/);
  });

  it('marks failed and records export_failed on an upload error, then rethrows — never leaves the request stuck at "processing" silently', async () => {
    uploadExportObjectMock.mockRejectedValueOnce(new Error('storage down'));

    await expect(runExportJob('req-1')).rejects.toThrow('storage down');

    const finalCall = updateDataRequestStatusMock.mock.calls.at(-1);
    expect(finalCall![1]).toEqual({ status: 'failed' });
    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'export_failed', target: 'req-1' }),
    );
  });
});

describe('requestExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findActiveRequestMock.mockResolvedValue(null);
    createDataRequestMock.mockResolvedValue(REQUEST);
    getDataRequestByIdMock.mockResolvedValue({ ...REQUEST, status: 'completed' });
    buildExportBundleMock.mockResolvedValue({ tradingAccounts: [] });
    tradingAccountsToCsvMock.mockReturnValue('id,label\n');
    createSignedExportUrlMock.mockResolvedValue('https://signed.example/x');
  });

  it('creates a request, records export_requested, runs the job, and returns the completed row', async () => {
    const result = await requestExport('user-1');

    expect(createDataRequestMock).toHaveBeenCalledWith('user-1', 'export', null);
    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', actor: 'user', action: 'export_requested', target: 'req-1' }),
    );
    expect(result.status).toBe('completed');
  });

  it('throws DuplicateExportRequestError when a request is already pending/processing — never queues a second job', async () => {
    findActiveRequestMock.mockResolvedValue(REQUEST);

    await expect(requestExport('user-1')).rejects.toBeInstanceOf(DuplicateExportRequestError);
    expect(createDataRequestMock).not.toHaveBeenCalled();
  });
});
