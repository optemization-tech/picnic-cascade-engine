import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    patchPages: vi.fn(),
    reportStatus: vi.fn(),
    request: vi.fn(),
  },
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  undoStore: {
    peek: vi.fn(),
    pop: vi.fn(),
  },
  studyCommentService: {
    postComment: vi.fn(),
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
  cascadeClient: mocks.mockClient,
  provisionClient: mocks.mockClient,
  deletionClient: mocks.mockClient,
  commentClient: mocks.mockClient,
}));

vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));

vi.mock('../../src/services/study-comment.js', () => ({
  StudyCommentService: vi.fn(() => mocks.studyCommentService),
}));

vi.mock('../../src/services/undo-store.js', () => ({
  undoStore: mocks.undoStore,
}));

vi.mock('../../src/services/cascade-queue.js', () => ({
  cascadeQueue: {
    enqueue: vi.fn((payload, parseFn, processFn) => {
      void processFn(payload).catch(() => {});
    }),
  },
}));

import { handleUndoCascade } from '../../src/routes/undo-cascade.js';

function makeReqRes(body = {}) {
  const req = { body };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return { req, res };
}

describe('undo-cascade route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValue({ updatedCount: 2 });
    mocks.mockClient.request.mockResolvedValue({});
    mocks.studyCommentService.postComment.mockResolvedValue({ posted: true });
  });

  it('returns 200 immediately', async () => {
    mocks.undoStore.peek.mockReturnValue(null);
    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('reports warning when no undo available', async () => {
    mocks.undoStore.peek.mockReturnValue(null);
    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'warning',
      'No recent cascade to undo (expired or already undone)',
    );
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'no_action' }),
    );
  });

  it('disables Import Mode on early-return (no undo entry)', async () => {
    mocks.undoStore.peek.mockReturnValue(null);
    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    const importModeCalls = mocks.mockClient.request.mock.calls.filter(
      ([method, path, body]) =>
        method === 'PATCH' &&
        path === '/pages/study-1' &&
        body?.properties?.['Import Mode']?.checkbox === false,
    );
    expect(importModeCalls).toHaveLength(1);
  });

  it('restores dates in a single patch batch without LMBS', async () => {
    mocks.undoStore.peek.mockReturnValue({
      cascadeId: 'c1',
      sourceTaskId: 'source',
      sourceTaskName: 'Source Task',
      cascadeMode: 'push-right',
      manifest: {
        'task-a': { oldStart: '2026-04-01', oldEnd: '2026-04-02', newStart: '2026-04-03', newEnd: '2026-04-04' },
        'task-b': { oldStart: '2026-04-05', oldEnd: '2026-04-06', newStart: '2026-04-07', newEnd: '2026-04-08' },
      },
      timestamp: Date.now(),
    });

    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    // Single patchPages call: restore dates (no pre-LMBS, no unlock)
    expect(mocks.mockClient.patchPages).toHaveBeenCalledTimes(1);

    const restoreCall = mocks.mockClient.patchPages.mock.calls[0][0];
    expect(restoreCall).toHaveLength(2);
    // Restore payload sorted by ascending start date (top-of-timeline first)
    expect(restoreCall[0].taskId).toBe('task-a'); // oldStart 2026-04-01
    expect(restoreCall[1].taskId).toBe('task-b'); // oldStart 2026-04-05
    const taskA = restoreCall.find((u) => u.taskId === 'task-a');
    expect(taskA.properties['Dates']).toEqual({ date: { start: '2026-04-01', end: '2026-04-02' } });
    expect(taskA.properties['Reference Start Date']).toEqual({ date: { start: '2026-04-01' } });
    expect(taskA.properties['Reference End Date']).toEqual({ date: { start: '2026-04-02' } });
    expect(taskA.properties['Last Modified By System']).toBeUndefined();

    // Success reported
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'success',
      'Undo complete: restored 2 tasks to pre-cascade dates',
    );
  });

  it('reports error when restore throws', async () => {
    mocks.undoStore.peek.mockReturnValue({
      cascadeId: 'c1',
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      cascadeMode: 'push-right',
      manifest: { 'task-a': { oldStart: '2026-04-01', oldEnd: '2026-04-02', newStart: '2026-04-03', newEnd: '2026-04-04' } },
      timestamp: Date.now(),
    });
    mocks.mockClient.patchPages.mockRejectedValueOnce(new Error('restore failed'));

    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      expect.stringContaining('restore failed'),
    );
  });

  it('logs activity entry on success with source task fields and timing', async () => {
    mocks.undoStore.peek.mockReturnValue({
      cascadeId: 'c1',
      sourceTaskId: 'source',
      sourceTaskName: 'Source Task',
      cascadeMode: 'push-right',
      manifest: { 'task-a': { oldStart: '2026-04-01', oldEnd: '2026-04-02', newStart: '2026-04-03', newEnd: '2026-04-04' } },
      timestamp: Date.now(),
    });

    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Undo Cascade',
        status: 'success',
        sourceTaskId: 'source',
        sourceTaskName: 'Source Task',
        cascadeMode: 'push-right',
        summary: 'Undo: push-right cascade for Source Task reversed (1 tasks restored)',
        details: expect.objectContaining({
          undoCascadeId: 'c1',
          restoredCount: 1,
          timing: expect.objectContaining({ totalMs: expect.any(Number) }),
        }),
      }),
    );
  });

  it('disables Import Mode after successful undo', async () => {
    mocks.undoStore.peek.mockReturnValue({
      cascadeId: 'c1',
      sourceTaskId: 'source',
      sourceTaskName: 'Source Task',
      cascadeMode: 'push-right',
      manifest: { 'task-a': { oldStart: '2026-04-01', oldEnd: '2026-04-02', newStart: '2026-04-03', newEnd: '2026-04-04' } },
      timestamp: Date.now(),
    });

    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    // Import Mode disabled in success path + finally = 2 calls
    const importModeCalls = mocks.mockClient.request.mock.calls.filter(
      ([method, path, body]) =>
        method === 'PATCH' &&
        path === '/pages/study-1' &&
        body?.properties?.['Import Mode']?.checkbox === false,
    );
    expect(importModeCalls).toHaveLength(2);
  });

  it('disables Import Mode even when patchPages throws', async () => {
    mocks.undoStore.peek.mockReturnValue({
      cascadeId: 'c1',
      sourceTaskId: 'source',
      sourceTaskName: 'Source Task',
      cascadeMode: 'push-right',
      manifest: { 'task-a': { oldStart: '2026-04-01', oldEnd: '2026-04-02', newStart: '2026-04-03', newEnd: '2026-04-04' } },
      timestamp: Date.now(),
    });
    mocks.mockClient.patchPages.mockRejectedValueOnce(new Error('restore failed'));

    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    // Even though patchPages threw, the finally block should disable Import Mode
    const importModeCalls = mocks.mockClient.request.mock.calls.filter(
      ([method, path, body]) =>
        method === 'PATCH' &&
        path === '/pages/study-1' &&
        body?.properties?.['Import Mode']?.checkbox === false,
    );
    expect(importModeCalls).toHaveLength(1);
  });

  it('posts comment with forceComment on no_action path', async () => {
    mocks.undoStore.peek.mockReturnValue(null);
    const { req, res } = makeReqRes({ data: { id: 'study-1', last_edited_by: { id: 'user-1', type: 'person' } } });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        forceComment: true,
        status: 'no_action',
        summary: expect.stringContaining('No recent cascade to undo'),
      }),
    );
  });

  it('posts comment on successful undo', async () => {
    mocks.undoStore.peek.mockReturnValue({
      manifest: {
        'task-1': { oldStart: '2026-01-01', oldEnd: '2026-01-02', newStart: '2026-02-01', newEnd: '2026-02-02' },
      },
      cascadeId: 'c1',
      sourceTaskName: 'Task One',
      cascadeMode: 'pull-left',
    });

    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Undo Cascade',
        status: 'success',
        studyId: 'study-1',
        sourceTaskName: 'Task One',
        summary: expect.stringContaining('1 task'),
      }),
    );
  });

  it('posts comment on failed undo', async () => {
    mocks.undoStore.peek.mockReturnValue({
      manifest: {
        'task-1': { oldStart: '2026-01-01', oldEnd: '2026-01-02', newStart: '2026-02-01', newEnd: '2026-02-02' },
      },
      cascadeId: 'c1',
      sourceTaskName: 'Task One',
      cascadeMode: 'pull-left',
    });
    mocks.mockClient.patchPages.mockRejectedValueOnce(new Error('patch exploded'));

    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Undo Cascade',
        status: 'failed',
        studyId: 'study-1',
        sourceTaskName: 'Task One',
        summary: expect.stringContaining('patch exploded'),
      }),
    );
  });

  it('undo completes even when comment fails', async () => {
    mocks.studyCommentService.postComment.mockRejectedValue(new Error('comment API down'));
    mocks.undoStore.peek.mockReturnValue(null);

    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'no_action' }),
    );
  });
});
