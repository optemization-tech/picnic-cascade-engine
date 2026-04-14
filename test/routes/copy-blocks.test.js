import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    reportStatus: vi.fn(),
    request: vi.fn(),
  },
  copyBlocks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    notion: {
      tokens: ['token-1'],
      provisionTokens: ['prov-token-1'],
      studyTasksDbId: 'db-study-tasks',
      studiesDbId: 'db-studies',
      activityLogDbId: 'db-activity-log',
      blueprintDbId: 'db-blueprint',
    },
    port: 3000,
  },
}));

vi.mock('../../src/notion/clients.js', () => ({
  cascadeClient: mocks.mockClient,
  provisionClient: mocks.mockClient,
  deletionClient: mocks.mockClient,
  commentClient: mocks.mockClient,
}));

vi.mock('../../src/provisioning/copy-blocks.js', () => ({
  copyBlocks: mocks.copyBlocks,
}));

vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));

import { handleCopyBlocks } from '../../src/routes/copy-blocks.js';

function makeReqRes(body = {}) {
  const req = { body };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return { req, res };
}

describe('copy-blocks route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true, pageId: 'page-1' });
  });

  it('returns 200 immediately', async () => {
    const { req, res } = makeReqRes({});
    await handleCopyBlocks(req, res);
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('skips when idMapping is missing', async () => {
    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleCopyBlocks(req, res);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.copyBlocks).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  it('skips when idMapping is empty', async () => {
    const { req, res } = makeReqRes({ idMapping: {}, studyPageId: 'study-1' });
    await handleCopyBlocks(req, res);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.copyBlocks).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  it('skips when body is null', async () => {
    const req = { body: null };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handleCopyBlocks(req, res);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.copyBlocks).not.toHaveBeenCalled();
  });

  it('calls copyBlocks module and logs to activity log on success', async () => {
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.copyBlocks.mockResolvedValue({
      blocksWrittenCount: 42,
      pagesProcessed: 10,
      pagesSkipped: 2,
    });

    const { req, res } = makeReqRes({
      idMapping: { 'tmpl-1': 'prod-1', 'tmpl-2': 'prod-2' },
      studyPageId: 'study-1',
      studyName: 'Test Study',
    });

    await handleCopyBlocks(req, res);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.copyBlocks).toHaveBeenCalledWith(
      mocks.mockClient,
      { 'tmpl-1': 'prod-1', 'tmpl-2': 'prod-2' },
      expect.objectContaining({
        studyPageId: 'study-1',
        studyName: 'Test Study',
      }),
    );
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Copy Blocks',
        status: 'success',
        summary: expect.stringContaining('10 pages processed'),
      }),
    );
    // Reports progress and completion status
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'info',
      'Copying content blocks...',
      expect.any(Object),
    );
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'success',
      expect.stringContaining('10 pages'),
      expect.any(Object),
    );
  });

  it('reports error status when copyBlocks throws', async () => {
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.copyBlocks.mockRejectedValue(new Error('Notion API 500'));

    const { req, res } = makeReqRes({
      idMapping: { 'tmpl-1': 'prod-1' },
      studyPageId: 'study-1',
      studyName: 'Test Study',
    });

    await handleCopyBlocks(req, res);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      expect.stringContaining('Notion API 500'),
      expect.any(Object),
    );
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Copy Blocks',
        status: 'failed',
        summary: expect.stringContaining('Notion API 500'),
      }),
    );
  });
});
