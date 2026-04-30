import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    reportStatus: vi.fn(),
    request: vi.fn(),
    getPage: vi.fn(),
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

import { handleMigrateStudy, resolveMigrateStudyLockId } from '../../src/routes/migrate-study.js';
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
    mocks.mockClient.getPage.mockResolvedValue({
      properties: {
        'Production Study': { type: 'relation', relation: [{ id: 'production-study-for-lock' }] },
      },
    });
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
    expect(mocks.mockClient.getPage).toHaveBeenCalledWith('exported-study-1');
    expect(mocks.runMigrateStudyPipeline).toHaveBeenCalled();
  });

  it('passes body.data.id (Exported Studies row id) through to the pipeline', async () => {
    const payload = { data: { id: 'exported-study-from-notion' }, source: { user_id: 'user-1' } };
    const { req, res } = makeReqRes(payload);
    await handleMigrateStudy(req, res);
    await flush();

    expect(mocks.mockClient.getPage).toHaveBeenCalledWith('exported-study-from-notion');
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

  it('emits tracer log to console.log on the success path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { req, res } = makeReqRes({ data: { id: 'exported-traced-success' } });
    await handleMigrateStudy(req, res);
    await flush();

    const tracerLogs = logSpy.mock.calls
      .map((call) => call[0])
      .filter((arg) => typeof arg === 'string' && arg.startsWith('{') && arg.includes('"cascadeId"'));
    expect(tracerLogs.length).toBe(1);
    expect(JSON.parse(tracerLogs[0])).toMatchObject({ totalDurationMs: expect.any(Number) });
    logSpy.mockRestore();
  });

  it('emits tracer log to console.log even when the pipeline rejects', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.runMigrateStudyPipeline.mockRejectedValueOnce(new Error('gate failed mid-pipeline'));
    const { req, res } = makeReqRes({ data: { id: 'exported-traced-failure' } });
    await handleMigrateStudy(req, res);
    await flush();

    const tracerLogs = logSpy.mock.calls
      .map((call) => call[0])
      .filter((arg) => typeof arg === 'string' && arg.startsWith('{') && arg.includes('"cascadeId"'));
    expect(tracerLogs.length).toBe(1);
    expect(JSON.parse(tracerLogs[0])).toMatchObject({ totalDurationMs: expect.any(Number) });
    logSpy.mockRestore();
  });

  it('still accepts body.studyPageId for back-compat with existing dry-run scripts', async () => {
    const { req, res } = makeReqRes({ studyPageId: 'legacy-id' });
    await handleMigrateStudy(req, res);
    await flush();

    expect(mocks.mockClient.getPage).toHaveBeenCalledWith('legacy-id');
    expect(mocks.runMigrateStudyPipeline).toHaveBeenCalled();
  });
});

describe('resolveMigrateStudyLockId', () => {
  it('returns Production Study id when Exported row has exactly one relation', async () => {
    const notion = {
      getPage: vi.fn().mockResolvedValue({
        properties: {
          'Production Study': { type: 'relation', relation: [{ id: 'prod-1' }] },
        },
      }),
    };
    await expect(resolveMigrateStudyLockId(notion, 'exp-1')).resolves.toBe('prod-1');
  });

  it('falls back to exported row id when Production Study relation count !== 1', async () => {
    const notion = {
      getPage: vi.fn().mockResolvedValue({
        properties: {
          'Production Study': { type: 'relation', relation: [] },
        },
      }),
    };
    await expect(resolveMigrateStudyLockId(notion, 'exp-1')).resolves.toBe('exp-1');
  });

  it('falls back when getPage throws', async () => {
    const notion = {
      getPage: vi.fn().mockRejectedValue(new Error('network')),
    };
    await expect(resolveMigrateStudyLockId(notion, 'exp-1')).resolves.toBe('exp-1');
  });
});
