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

import { handleUndoCascade, parseUndoPayload } from '../../src/routes/undo-cascade.js';
import {
  STUDY_TASKS_PROPS as ST,
  STUDIES_PROPS as S,
} from '../../src/notion/property-names.js';

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
        body?.properties?.[S.IMPORT_MODE.id]?.checkbox === false,
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
    expect(taskA.properties[ST.DATES.id]).toEqual({ date: { start: '2026-04-01', end: '2026-04-02' } });
    expect(taskA.properties[ST.REF_START.id]).toEqual({ date: { start: '2026-04-01' } });
    expect(taskA.properties[ST.REF_END.id]).toEqual({ date: { start: '2026-04-02' } });
    expect(taskA.properties[ST.LMBS.id]).toBeUndefined();

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
        body?.properties?.[S.IMPORT_MODE.id]?.checkbox === false,
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
        body?.properties?.[S.IMPORT_MODE.id]?.checkbox === false,
    );
    expect(importModeCalls).toHaveLength(1);
  });

  it('does not post comment on no_action path (comments are errors-only)', async () => {
    mocks.undoStore.peek.mockReturnValue(null);
    const { req, res } = makeReqRes({ data: { id: 'study-1', last_edited_by: { id: 'user-1', type: 'person' } } });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.studyCommentService.postComment).not.toHaveBeenCalled();
  });

  it('does not post comment on successful undo (comments are errors-only)', async () => {
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

    expect(mocks.studyCommentService.postComment).not.toHaveBeenCalled();
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

describe('parseUndoPayload', () => {
  // The cascade-queue front-door bot-author gate keys on parsed.editedByBot.
  // parseUndoPayload must surface that field so undo-cascade benefits from
  // the gate. The route's stricter definition (button click → not bot, even
  // if last_edited_by.type === 'bot') must be preserved so legitimate undo
  // button presses are not silenced.
  // Plan: docs/plans/2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md (U1 step 5).

  it('returns editedByBot=true when payload.data.last_edited_by.type === "bot" and no source.user_id', () => {
    const parsed = parseUndoPayload({
      data: {
        studyId: 'study-1',
        last_edited_by: { type: 'bot' },
      },
    });
    expect(parsed.editedByBot).toBe(true);
    expect(parsed.studyId).toBe('study-1');
    expect(parsed.taskId).toBe('__undo__');
    expect(parsed.skip).toBe(false);
  });

  it('returns editedByBot=false when source.user_id is present (button click — not a bot edit)', () => {
    // Even though last_edited_by.type === 'bot', a button click carries
    // source.user_id (the actual clicker), so this is a legitimate undo.
    const parsed = parseUndoPayload({
      source: { user_id: 'user-123' },
      data: {
        studyId: 'study-1',
        last_edited_by: { type: 'bot' },
      },
    });
    expect(parsed.editedByBot).toBe(false);
  });

  it('returns editedByBot=false when last_edited_by.type !== "bot"', () => {
    const parsed = parseUndoPayload({
      data: {
        studyId: 'study-1',
        last_edited_by: { type: 'person' },
      },
    });
    expect(parsed.editedByBot).toBe(false);
  });

  it('returns editedByBot=false when last_edited_by is missing', () => {
    const parsed = parseUndoPayload({ data: { studyId: 'study-1' } });
    expect(parsed.editedByBot).toBe(false);
  });

  it('still returns the existing studyId/taskId/skip fields unchanged', () => {
    const parsed = parseUndoPayload({ studyId: 'study-2' });
    expect(parsed).toMatchObject({
      skip: false,
      taskId: '__undo__',
      studyId: 'study-2',
    });
  });
});
