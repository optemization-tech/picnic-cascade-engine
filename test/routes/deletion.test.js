import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    reportStatus: vi.fn(),
    request: vi.fn(),
  },
  deleteStudyTasks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  studyCommentService: {
    postComment: vi.fn(),
  },
  flightTracker: {
    track: vi.fn((p) => p),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    notion: {
      tokens: ['token-1'],
      studyTasksDbId: 'db-study-tasks',
      activityLogDbId: 'db-activity-log',
    },
  },
}));

vi.mock('../../src/notion/clients.js', () => ({
  deletionClient: mocks.mockClient,
  commentClient: mocks.mockClient,
}));

vi.mock('../../src/provisioning/deletion.js', () => ({
  deleteStudyTasks: mocks.deleteStudyTasks,
}));

vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));

vi.mock('../../src/services/study-comment.js', () => ({
  StudyCommentService: vi.fn(() => mocks.studyCommentService),
}));

vi.mock('../../src/services/flight-tracker.js', () => ({
  flightTracker: mocks.flightTracker,
}));

vi.mock('../../src/services/cascade-tracer.js', () => ({
  CascadeTracer: vi.fn(() => ({
    set: vi.fn(),
    cascadeId: 'tracer-id-1',
    toConsoleLog: vi.fn(() => '{}'),
    toActivityLogDetails: vi.fn(() => ({})),
  })),
}));

import { handleDeletion } from '../../src/routes/deletion.js';

function makeReqRes(body = {}) {
  const req = { body };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return { req, res };
}

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('deletion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true });
    mocks.studyCommentService.postComment.mockResolvedValue({ posted: true });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.deleteStudyTasks.mockResolvedValue({ archivedCount: 3 });
  });

  it('returns 200 immediately', async () => {
    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleDeletion(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('skips when studyId is missing', async () => {
    const { req, res } = makeReqRes({});
    await handleDeletion(req, res);
    await flush();

    expect(mocks.deleteStudyTasks).not.toHaveBeenCalled();
  });

  it('logs success activity with correct fields', async () => {
    const { req, res } = makeReqRes({ studyId: 'study-1', source: { user_id: 'user-abc', type: 'person' } });
    await handleDeletion(req, res);
    await flush();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Deletion',
        status: 'success',
        summary: expect.stringContaining('archived 3'),
      }),
    );
  });

  it('passes mentionable=true when source.user_id identifies a person clicker', async () => {
    const { req, res } = makeReqRes({
      studyId: 'study-1',
      source: { user_id: 'user-xyz', type: 'person' },
    });
    await handleDeletion(req, res);
    await flush();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mentionable: true, triggeredByUserId: 'user-xyz' }),
    );
  });

  it('passes mentionable=false when last_edited_by type is bot', async () => {
    const { req, res } = makeReqRes({
      studyId: 'study-1',
      data: { last_edited_by: { id: 'bot-111', type: 'bot' } },
    });
    await handleDeletion(req, res);
    await flush();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mentionable: false, editedByBot: true }),
    );
  });

  it('passes mentionable to logTerminalEvent in error path', async () => {
    mocks.deleteStudyTasks.mockRejectedValueOnce(new Error('archive failed'));

    const { req, res } = makeReqRes({
      studyId: 'study-1',
      source: { user_id: 'user-xyz', type: 'person' },
    });
    await handleDeletion(req, res);
    await flush();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Deletion',
        status: 'failed',
        mentionable: true,
        triggeredByUserId: 'user-xyz',
      }),
    );
  });

  it('passes mentionable to postComment in error path', async () => {
    mocks.deleteStudyTasks.mockRejectedValueOnce(new Error('archive failed'));

    const { req, res } = makeReqRes({
      studyId: 'study-1',
      source: { user_id: 'user-xyz', type: 'person' },
    });
    await handleDeletion(req, res);
    await flush();

    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Deletion',
        status: 'failed',
        mentionable: true,
      }),
    );
  });
});
