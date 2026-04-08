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
  enforceConstraints: vi.fn(),
  queryStudyTasks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
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

vi.mock('../../src/notion/client.js', () => ({
  NotionClient: vi.fn(() => mocks.mockClient),
}));

vi.mock('../../src/gates/guards.js', () => ({
  parseWebhookPayload: mocks.parseWebhookPayload,
  isImportMode: mocks.isImportMode,
  isFrozen: mocks.isFrozen,
}));

vi.mock('../../src/engine/classify.js', () => ({ classify: mocks.classify }));
vi.mock('../../src/engine/cascade.js', () => ({ runCascade: mocks.runCascade }));
vi.mock('../../src/engine/parent-subtask.js', () => ({ runParentSubtask: mocks.runParentSubtask }));
vi.mock('../../src/engine/constraints.js', () => ({ enforceConstraints: mocks.enforceConstraints }));
vi.mock('../../src/notion/queries.js', () => ({ queryStudyTasks: mocks.queryStudyTasks }));
vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
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

  it('exits early with no side effects when task status is frozen', async () => {
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

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
    expect(mocks.mockClient.reportStatus).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({ noActionReason: 'frozen_status' }),
    }));
  });

  it('applies Error 1 side effects with exact warning text', async () => {
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
    mocks.queryStudyTasks.mockResolvedValue([]);
    mocks.classify.mockReturnValue({
      skip: true,
      reason: 'Direct parent edit blocked - edit subtasks directly',
      cascadeMode: null,
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.request.mockResolvedValue({});

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
    });
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
      parentMode: 'case-a',
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'a', newStart: '2026-04-02', newEnd: '2026-04-03' }],
      movedTaskIds: ['a'],
      movedTaskMap: { a: { newStart: '2026-04-02', newEnd: '2026-04-03' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({
      updates: [{ taskId: 'parent-rollup', newStart: '2026-04-01', newEnd: '2026-04-03', _isRollUp: true }],
      parentMode: 'case-a',
      rolledUpStart: null,
      rolledUpEnd: null,
    });
    mocks.enforceConstraints.mockReturnValue({
      newStart: '2026-04-01',
      newEnd: '2026-04-02',
      constrained: false,
      merged: false,
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
    expect(mocks.mockClient.reportStatus).toHaveBeenNthCalledWith(
      1,
      'study-1',
      'info',
      'Cascade started for Source...',
      expect.any(Object),
    );
    expect(mocks.mockClient.reportStatus).toHaveBeenNthCalledWith(
      2,
      'study-1',
      'success',
      'Cascade complete for Source: push-right (3 task updates)',
      expect.any(Object),
    );
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
      summary: expect.stringContaining('Cascade failed'),
    }));
  });
});
