import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    reportStatus: vi.fn(),
    request: vi.fn(),
  },
  runMigrateStudyPipeline: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    port: 3000,
    notion: {
      tokens: ['token-1'],
      provisionTokens: ['prov-token-1'],
      studyTasksDbId: 'db-study-tasks',
      studiesDbId: 'db-studies',
      activityLogDbId: 'db-activity-log',
    },
  },
}));

vi.mock('../../src/notion/clients.js', () => ({
  provisionClient: mocks.mockClient,
  commentClient: mocks.mockClient,
}));

vi.mock('../../src/services/study-comment.js', () => ({
  StudyCommentService: vi.fn(() => ({ postComment: vi.fn().mockResolvedValue({}) })),
}));

vi.mock('../../src/migration/migrate-study-service.js', () => ({
  runMigrateStudyPipeline: mocks.runMigrateStudyPipeline,
}));

import { handleMigrateStudy } from '../../src/routes/migrate-study.js';
import { _resetStudyLocks } from '../../src/services/study-lock.js';

function makeReqRes(body = {}) {
  const req = { body };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return { req, res };
}

async function flush() {
  await vi.runAllTimersAsync();
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('migrate-study route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetStudyLocks();
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.runMigrateStudyPipeline.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('responds 200 immediately before processing', async () => {
    const { req, res } = makeReqRes({ data: { id: 'exported-study-1' } });
    await handleMigrateStudy(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });

    await flush();
    expect(mocks.runMigrateStudyPipeline).toHaveBeenCalled();
  });

  it('passes body.data.id (Exported Studies row id) through to the pipeline', async () => {
    const payload = { data: { id: 'exported-study-from-notion' }, source: { user_id: 'user-1' } };
    const { req, res } = makeReqRes(payload);
    await handleMigrateStudy(req, res);
    await flush();

    expect(mocks.runMigrateStudyPipeline).toHaveBeenCalledWith(
      payload,
      mocks.mockClient,
      expect.objectContaining({
        triggeredByUserId: 'user-1',
      }),
    );
  });

  it('does not call pipeline when payload id is missing (early skip)', async () => {
    const { req, res } = makeReqRes({});
    await handleMigrateStudy(req, res);
    await flush();

    expect(mocks.runMigrateStudyPipeline).not.toHaveBeenCalled();
  });

  it('propagates pipeline rejection without crashing the HTTP handler', async () => {
    mocks.runMigrateStudyPipeline.mockRejectedValueOnce(new Error('gate failed'));
    const { req, res } = makeReqRes({ data: { id: 'exported-x' } });
    await handleMigrateStudy(req, res);
    await expect(flush()).resolves.toBeUndefined();

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still accepts body.studyPageId for back-compat with existing dry-run scripts', async () => {
    const { req, res } = makeReqRes({ studyPageId: 'legacy-id' });
    await handleMigrateStudy(req, res);
    await flush();

    expect(mocks.runMigrateStudyPipeline).toHaveBeenCalled();
  });
});
