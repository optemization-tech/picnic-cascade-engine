import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    patchPage: vi.fn(),
    reportStatus: vi.fn(),
    patchPages: vi.fn(),
    request: vi.fn(),
  },
  parseWebhookPayload: vi.fn(),
  isImportMode: vi.fn(),
  isFrozen: vi.fn(),
  classify: vi.fn(),
  runCascade: vi.fn(),
  runParentSubtask: vi.fn(),
  queryStudyTasks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  undoStore: {
    save: vi.fn(),
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
      studiesDbId: 'db-studies',
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

vi.mock('../../src/gates/guards.js', () => ({
  parseWebhookPayload: mocks.parseWebhookPayload,
  isImportMode: mocks.isImportMode,
  isFrozen: mocks.isFrozen,
}));

vi.mock('../../src/engine/classify.js', () => ({ classify: mocks.classify }));
vi.mock('../../src/engine/cascade.js', () => ({ runCascade: mocks.runCascade }));
vi.mock('../../src/engine/parent-subtask.js', () => ({ runParentSubtask: mocks.runParentSubtask }));
vi.mock('../../src/notion/queries.js', () => ({ queryStudyTasks: mocks.queryStudyTasks }));
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
    enqueue: vi.fn((payload, _parseFn, processFn) => {
      void processFn(payload).catch(() => {});
    }),
  },
}));

import { handleDateCascade } from '../../src/routes/date-cascade.js';

function makeReqRes(body = {}) {
  return {
    req: { body },
    res: {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    },
  };
}

describe('date-cascade route safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true, pageId: 'page-1' });
    mocks.studyCommentService.postComment.mockResolvedValue({ posted: true });
  });

  it('returns early on zero delta without side effects', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task 1',
      studyId: 'study-1',
      startDelta: 0,
      endDelta: 0,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
    expect(mocks.mockClient.reportStatus).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  it('snaps a weekend source edit forward before classification and patching', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      newStart: '2026-04-04',
      newEnd: '2026-04-04',
      refStart: '2026-04-03',
      refEnd: '2026-04-03',
      startDelta: 0,
      endDelta: 0,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'source', parentId: null }]);
    mocks.classify.mockImplementation((parsed) => {
      expect(parsed.newStart).toBe('2026-04-06');
      expect(parsed.newEnd).toBe('2026-04-06');
      expect(parsed.startDelta).toBe(1);
      expect(parsed.endDelta).toBe(1);
      return {
        skip: false,
        sourceTaskId: 'source',
        sourceTaskName: 'Source',
        newStart: parsed.newStart,
        newEnd: parsed.newEnd,
        refStart: '2026-04-03',
        refEnd: '2026-04-03',
        startDelta: parsed.startDelta,
        endDelta: parsed.endDelta,
        cascadeMode: 'drag-right',
        parentTaskId: null,
        parentMode: null,
      };
    });
    mocks.runCascade.mockReturnValue({
      updates: [],
      movedTaskIds: [],
      movedTaskMap: {},
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({
      updates: [],
      parentMode: null,
      rolledUpStart: null,
      rolledUpEnd: null,
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({ updatedCount: 1, taskIds: ['source'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(mocks.mockClient.patchPages).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: 'source',
        properties: expect.objectContaining({
          Dates: { date: { start: '2026-04-06', end: '2026-04-06' } },
        }),
      }),
    ], expect.any(Object));
  });

  it('posts "Cascade queued" to the task on valid non-zero-delta webhooks', async () => {
    // Unit 3: immediate click feedback, scoped to parsed.taskId.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 2,
      endDelta: 2,
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    // Allow the fire-and-forget reportStatus microtask to settle.
    await Promise.resolve();

    const queuedCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade queued for Source'),
    );
    expect(queuedCalls).toHaveLength(1);
    expect(queuedCalls[0][0]).toBe('source'); // task-scoped, not study
  });

  it('skips "Cascade queued" for bot-echo webhooks', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 2,
      endDelta: 2,
      editedByBot: true, // bot echo
    });
    mocks.isImportMode.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await Promise.resolve();

    const queuedCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade queued'),
    );
    expect(queuedCalls).toHaveLength(0);
  });

  it('skips "Cascade queued" when Import Mode is enabled', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 2,
      endDelta: 2,
    });
    mocks.isImportMode.mockReturnValue(true);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await Promise.resolve();

    const queuedCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade queued'),
    );
    expect(queuedCalls).toHaveLength(0);
  });

  it('exits early with no side effects when import mode is enabled', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
    });
    mocks.isImportMode.mockReturnValue(true);
    mocks.isFrozen.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
    expect(mocks.mockClient.reportStatus).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  it('logs no_action for a frozen leaf task and skips the cascade (post-classify frozen check)', async () => {
    // After Unit 2, the isFrozen check runs AFTER classify so Error 1 can
    // still fire for frozen top-level parents. A frozen leaf classifies as
    // skip:false with a cascadeMode (e.g., push-right), then the post-
    // classify isFrozen branch logs no_action. queryStudyTasks is now
    // called (accepted trade-off) but "Cascade started" reportStatus is
    // suppressed for this path.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(true);
    mocks.queryStudyTasks.mockResolvedValue([]);
    mocks.classify.mockReturnValue({
      skip: false,
      cascadeMode: 'push-right',
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-01',
      newEnd: '2026-04-02',
      refStart: '2026-04-01',
      refEnd: '2026-04-01',
      startDelta: 0,
      endDelta: 1,
      parentTaskId: null,
      parentMode: null,
    });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.queryStudyTasks).toHaveBeenCalled();
    expect(mocks.classify).toHaveBeenCalled();
    // Unit 3: "Cascade queued" fires on the task's Automation Reporting
    // immediately (before the debounce), but "Cascade started" is suppressed
    // because the post-classify frozen check returns early.
    const reportStatusCalls = mocks.mockClient.reportStatus.mock.calls;
    const startedCalls = reportStatusCalls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade started'),
    );
    expect(startedCalls).toHaveLength(0);
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    expect(mocks.runCascade).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({ noActionReason: 'frozen_status' }),
    }));
  });

  it('fires Error 1 revert on a FROZEN top-level parent date edit and suppresses "Cascade started"', async () => {
    // The core Unit 2 scenario: Meg's Sites Planning (frozen) edit. Without
    // the guard reorder, isFrozen fires first and the edit is silently
    // swallowed. With the reorder, classify runs, Error 1 fires,
    // applyError1SideEffects reverts the parent, and no misleading
    // "Cascade started" message is posted (sequence: queued -> revert).
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'parent-1',
      taskName: 'Sites Planning',
      studyId: 'study-1',
      hasDates: true,
      startDelta: -2,
      endDelta: 0,
      refStart: '2026-05-06',
      refEnd: '2026-07-01',
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(true); // parent is Done -- frozen
    mocks.queryStudyTasks.mockResolvedValue([]);
    mocks.classify.mockReturnValue({
      skip: true,
      reason: 'Direct parent edit blocked - edit subtasks directly',
      cascadeMode: null,
      sourceTaskId: 'parent-1',
      refStart: '2026-05-06',
      refEnd: '2026-07-01',
    });
    mocks.mockClient.request.mockResolvedValue({});
    mocks.mockClient.patchPage.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    // Error 1 must fire even though isFrozen === true
    expect(mocks.mockClient.request).toHaveBeenCalledWith(
      'PATCH',
      '/pages/study-1',
      expect.any(Object),
      expect.any(Object),
    );
    expect(mocks.mockClient.patchPage).toHaveBeenCalledWith(
      'parent-1',
      expect.objectContaining({
        Dates: { date: { start: '2026-05-06', end: '2026-07-01' } },
      }),
      expect.any(Object),
    );
    // No "Cascade started" info message should have been posted
    const infoCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => args[1] === 'info' && typeof args[2] === 'string' && args[2].includes('Cascade started'),
    );
    expect(infoCalls).toHaveLength(0);
    // Activity Log gets a no_action entry with Error 1 reason
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({
        noActionReason: expect.stringContaining('Direct parent edit blocked'),
      }),
    }));
  });

  it('applies Error 1 side effects, reverts the source task, and preserves the warning text', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: -1,
      endDelta: 0,
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([]);
    mocks.classify.mockReturnValue({
      skip: true,
      reason: 'Direct parent edit blocked - edit subtasks directly',
      cascadeMode: null,
      sourceTaskId: 'source',
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.request.mockResolvedValue({});
    mocks.mockClient.patchPage.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.request).toHaveBeenCalledWith('PATCH', '/pages/study-1', {
      properties: {
        'Import Mode': { checkbox: false },
        'Automation Reporting': {
          rich_text: [{
            type: 'text',
            text: { content: '⚠️ This task has subtasks — edit a subtask directly to shift dates and trigger cascading.' },
            annotations: { bold: true, color: 'red' },
          }],
        },
      },
    }, expect.any(Object));
    expect(mocks.mockClient.patchPage).toHaveBeenCalledWith('source', expect.objectContaining({
      'Dates': { date: { start: '2026-04-01', end: '2026-04-02' } },
      'Reference Start Date': { date: { start: '2026-04-01' } },
      'Reference End Date': { date: { start: '2026-04-02' } },
    }), expect.any(Object));
  });

  it('patches updates once and reports success', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'source', parentId: null }]);
    mocks.classify.mockReturnValue({
      skip: false,
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-01',
      newEnd: '2026-04-02',
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      parentTaskId: null,
      parentMode: null,
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'a', newStart: '2026-04-02', newEnd: '2026-04-03' }],
      movedTaskIds: ['a'],
      movedTaskMap: { a: { newStart: '2026-04-02', newEnd: '2026-04-03' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({
      updates: [{ taskId: 'parent-rollup', newStart: '2026-04-01', newEnd: '2026-04-03', _isRollUp: true }],
      parentMode: null,
      rolledUpStart: null,
      rolledUpEnd: null,
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({
      updatedCount: 3,
      taskIds: ['a', 'parent-rollup', 'source'],
    });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.patchPages).toHaveBeenCalledTimes(1);
    expect(mocks.mockClient.patchPages).toHaveBeenCalledWith([
      expect.objectContaining({ taskId: 'parent-rollup' }),
      expect.objectContaining({ taskId: 'source' }),
      expect.objectContaining({ taskId: 'a' }),
    ], expect.any(Object));
    const patchPayload = mocks.mockClient.patchPages.mock.calls[0][0];
    expect(patchPayload.every((u) => u.properties['Last Modified By System'] === undefined)).toBe(true);
    // Patch payload sorted by ascending start date (top-of-timeline first)
    const starts = patchPayload.map((u) => u.properties['Dates'].date.start);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] >= starts[i - 1]).toBe(true);
    }
    // Unit 3: cascade lifecycle reportStatus writes now target the TASK
    // (not the study) so multi-task cascades don't overwrite each other's
    // states. Sequence for a normal cascade: queued -> started -> complete,
    // all scoped to parsed.taskId.
    expect(mocks.mockClient.reportStatus).toHaveBeenNthCalledWith(
      1,
      'source',
      'info',
      expect.stringContaining('Cascade queued for Source'),
    );
    expect(mocks.mockClient.reportStatus).toHaveBeenNthCalledWith(
      2,
      'source',
      'info',
      'Cascade started for Source...',
      expect.any(Object),
    );
    expect(mocks.mockClient.reportStatus).toHaveBeenNthCalledWith(
      3,
      'source',
      'success',
      'Cascade complete for Source: push-right (3 task updates)',
      expect.any(Object),
    );
  });

  it('normalizes Date-typed task start/end to YYYY-MM-DD strings in undo manifest', async () => {
    // Regression: 2026-04-13 production incident. normalizeTask returns Date objects for
    // t.start/t.end, and the undo manifest propagated them verbatim. The Undo Cascade sort
    // then called .localeCompare on a Date and threw. Here we prove the snapshot site
    // converts to strings before handing off to undoStore.save.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    // Matches what normalizeTask actually produces: start/end are Date objects.
    mocks.queryStudyTasks.mockResolvedValue([
      {
        id: 'source',
        parentId: null,
        start: new Date('2026-04-01T00:00:00Z'),
        end: new Date('2026-04-02T00:00:00Z'),
      },
      {
        id: 'task-a',
        parentId: null,
        start: new Date('2026-04-05T00:00:00Z'),
        end: new Date('2026-04-06T00:00:00Z'),
      },
    ]);
    mocks.classify.mockReturnValue({
      skip: false,
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-01',
      newEnd: '2026-04-03',
      refStart: '2026-04-01',
      refEnd: '2026-04-03',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      parentTaskId: null,
      parentMode: null,
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'task-a', newStart: '2026-04-06', newEnd: '2026-04-07' }],
      movedTaskIds: ['task-a'],
      movedTaskMap: { 'task-a': { newStart: '2026-04-06', newEnd: '2026-04-07' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({ updates: [], parentMode: null, rolledUpStart: null, rolledUpEnd: null });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({ updatedCount: 2, taskIds: ['source', 'task-a'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.undoStore.save).toHaveBeenCalledTimes(1);
    const savedEntry = mocks.undoStore.save.mock.calls[0][1];
    const manifest = savedEntry.manifest;
    // The manifest must be string-typed for both oldStart and oldEnd on every entry —
    // otherwise Undo Cascade's sort (.localeCompare) blows up in production.
    for (const taskId of Object.keys(manifest)) {
      expect(typeof manifest[taskId].oldStart).toBe('string');
      expect(typeof manifest[taskId].oldEnd).toBe('string');
      expect(manifest[taskId].oldStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(manifest[taskId].oldEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(manifest['task-a'].oldStart).toBe('2026-04-05');
    expect(manifest['task-a'].oldEnd).toBe('2026-04-06');
  });

  it('does not post study comment on successful cascade (comments are errors-only)', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
      triggeredByUserId: 'user-abc',
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'source', parentId: null }]);
    mocks.classify.mockReturnValue({
      skip: false,
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-01',
      newEnd: '2026-04-02',
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      parentTaskId: null,
      parentMode: null,
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'a', newStart: '2026-04-02', newEnd: '2026-04-03' }],
      movedTaskIds: ['a'],
      movedTaskMap: { a: { newStart: '2026-04-02', newEnd: '2026-04-03' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({ updates: [], parentMode: null, rolledUpStart: null, rolledUpEnd: null });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({ updatedCount: 2, taskIds: ['source', 'a'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.studyCommentService.postComment).not.toHaveBeenCalled();
  });

  it('posts study comment on failed cascade', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
      triggeredByUserId: 'user-abc',
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockRejectedValue(new Error('db timeout'));
    mocks.mockClient.reportStatus.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'Date Cascade',
      status: 'failed',
      studyId: 'study-1',
      sourceTaskName: 'Source',
      summary: expect.stringContaining('cascade failed'),
    }));
  });

  it('successful cascade logs activity without posting comment', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
      triggeredByUserId: 'user-abc',
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'source', parentId: null }]);
    mocks.classify.mockReturnValue({
      skip: false,
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-01',
      newEnd: '2026-04-02',
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      parentTaskId: null,
      parentMode: null,
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'a', newStart: '2026-04-02', newEnd: '2026-04-03' }],
      movedTaskIds: ['a'],
      movedTaskMap: { a: { newStart: '2026-04-02', newEnd: '2026-04-03' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({ updates: [], parentMode: null, rolledUpStart: null, rolledUpEnd: null });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({ updatedCount: 2, taskIds: ['source', 'a'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    // logTerminalEvent should be called; postComment should NOT be called on success
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
    }));
    expect(mocks.studyCommentService.postComment).not.toHaveBeenCalled();
  });

  it('logs failure when processing throws', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockRejectedValue(new Error('boom'));
    mocks.mockClient.reportStatus.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      summary: expect.stringContaining('cascade failed'),
    }));
  });
});
