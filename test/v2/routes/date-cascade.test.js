import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    patchPage: vi.fn(),
    reportStatus: vi.fn(),
    patchBatch: vi.fn().mockResolvedValue({ updatedCount: 0 }),
    request: vi.fn(),
  },
  parseWebhookPayload: vi.fn(),
  isImportMode: vi.fn(),
  isFrozen: vi.fn(),
  classify: vi.fn(),
  runCascade: vi.fn(),
  enforceConstraints: vi.fn(),
  computeSubtaskUpdates: vi.fn(),
  queryStudyTasks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn().mockResolvedValue({ logged: true }),
  },
}));

vi.mock('../../../src/config.js', () => ({
  config: {
    notion: {
      tokens: ['token-1'],
      studyTasksDbId: 'db-study-tasks',
      studiesDbId: 'db-studies',
      activityLogDbId: 'db-activity-log',
    },
  },
}));

vi.mock('../../../src/notion/client.js', () => ({
  NotionClient: vi.fn(() => mocks.mockClient),
}));

vi.mock('../../../src/gates/guards.js', () => ({
  parseWebhookPayload: mocks.parseWebhookPayload,
  isImportMode: mocks.isImportMode,
  isFrozen: mocks.isFrozen,
}));

vi.mock('../../../src/v2/engine/classify.js', () => ({ classify: mocks.classify }));
vi.mock('../../../src/engine/cascade.js', () => ({ runCascade: mocks.runCascade }));
vi.mock('../../../src/engine/constraints.js', () => ({ enforceConstraints: mocks.enforceConstraints }));
vi.mock('../../../src/v2/engine/subtask-fanout.js', () => ({ computeSubtaskUpdates: mocks.computeSubtaskUpdates }));
vi.mock('../../../src/notion/queries.js', () => ({ queryStudyTasks: mocks.queryStudyTasks }));
vi.mock('../../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));
vi.mock('../../../src/services/cascade-queue.js', () => ({
  cascadeQueue: {
    enqueue: vi.fn((payload, _parseFn, processFn) => {
      void processFn(payload).catch(() => {});
    }),
  },
}));

import { handleDateCascade } from '../../../src/v2/routes/date-cascade.js';

function makeReqRes(body = {}) {
  return {
    req: { body },
    res: { status: vi.fn().mockReturnThis(), json: vi.fn() },
  };
}

function baseParsed(overrides = {}) {
  return {
    skip: false,
    taskId: 'parent-1',
    taskName: 'Protocol',
    studyId: 'study-1',
    hasDates: true,
    startDelta: 0,
    endDelta: 2,
    newStart: '2027-03-17',
    newEnd: '2027-04-16',
    refStart: '2027-03-15',
    refEnd: '2027-04-14',
    executionId: 'exec-1',
    triggeredByUserId: 'user-1',
    ...overrides,
  };
}

describe('V2 date-cascade route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.mockClient.patchBatch.mockResolvedValue({ updatedCount: 3 });
    mocks.mockClient.reportStatus.mockResolvedValue({});
  });

  it('returns 200 immediately', async () => {
    mocks.parseWebhookPayload.mockReturnValue({ skip: true });
    const { req, res } = makeReqRes({});
    await handleDateCascade(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('skips on zero delta', async () => {
    mocks.parseWebhookPayload.mockReturnValue(baseParsed({ startDelta: 0, endDelta: 0 }));
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);

    const { req, res } = makeReqRes({});
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
    expect(mocks.mockClient.reportStatus).not.toHaveBeenCalled();
  });

  it('skips on import mode', async () => {
    mocks.parseWebhookPayload.mockReturnValue(baseParsed());
    mocks.isImportMode.mockReturnValue(true);

    const { req, res } = makeReqRes({});
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
  });

  it('logs no_action for frozen task', async () => {
    mocks.parseWebhookPayload.mockReturnValue(baseParsed());
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(true);

    const { req, res } = makeReqRes({});
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'no_action', workflow: 'V2 Date Cascade' }),
    );
  });

  it('runs full V2 pipeline: cascade + subtask fan-out + single patch batch', async () => {
    const parsed = baseParsed();
    mocks.parseWebhookPayload.mockReturnValue(parsed);
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);

    const allTasks = [
      { id: 'parent-1', parentId: null, name: 'Protocol', blockedByIds: [], blockingIds: ['parent-2'], status: '', refStart: '2027-03-15', refEnd: '2027-04-14' },
      { id: 'parent-2', parentId: null, name: 'Data Model', blockedByIds: ['parent-1'], blockingIds: [], status: '', refStart: '2027-04-15', refEnd: '2027-05-15' },
      { id: 'sub-1', parentId: 'parent-1', name: 'Sub 1', relativeSoff: 0, relativeEoff: 10 },
      { id: 'sub-2', parentId: 'parent-1', name: 'Sub 2', relativeSoff: 5, relativeEoff: 20 },
      { id: 'sub-3', parentId: 'parent-2', name: 'Sub 3', relativeSoff: 0, relativeEoff: 15 },
    ];
    mocks.queryStudyTasks.mockResolvedValue(allTasks);

    mocks.classify.mockReturnValue({
      skip: false,
      sourceTaskId: 'parent-1',
      sourceTaskName: 'Protocol',
      newStart: '2027-03-17',
      newEnd: '2027-04-16',
      refStart: '2027-03-15',
      refEnd: '2027-04-14',
      startDelta: 0,
      endDelta: 2,
      cascadeMode: 'push-right',
      staleRefCorrected: false,
    });

    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'parent-2', taskName: 'Data Model', newStart: '2027-04-17', newEnd: '2027-05-17' }],
      movedTaskMap: { 'parent-2': { newStart: '2027-04-17', newEnd: '2027-05-17' } },
      movedTaskIds: ['parent-2'],
      summary: 'push-right: 1 task moved',
      diagnostics: {},
    });

    mocks.computeSubtaskUpdates.mockReturnValue({
      updates: [
        { taskId: 'sub-1', taskName: 'Sub 1', newStart: '2027-03-17', newEnd: '2027-03-31' },
        { taskId: 'sub-2', taskName: 'Sub 2', newStart: '2027-03-24', newEnd: '2027-04-14' },
        { taskId: 'sub-3', taskName: 'Sub 3', newStart: '2027-04-17', newEnd: '2027-05-08' },
      ],
    });

    mocks.enforceConstraints.mockReturnValue({
      taskId: 'parent-1',
      newStart: '2027-03-17',
      newEnd: '2027-04-16',
      constrained: false,
      merged: false,
    });

    const { req, res } = makeReqRes({});
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    const cascadeCall = mocks.runCascade.mock.calls[0][0];
    expect(cascadeCall.tasks).toHaveLength(2);
    expect(mocks.computeSubtaskUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        movedParentIds: expect.arrayContaining(['parent-1', 'parent-2']),
      }),
    );
    expect(mocks.mockClient.patchBatch).toHaveBeenCalledTimes(1);
    const patchPayload = mocks.mockClient.patchBatch.mock.calls[0][0];
    expect(patchPayload.every((u) => u.properties['Last Modified By System'] === undefined)).toBe(true);
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'V2 Date Cascade',
        status: 'success',
      }),
    );
  });

  it('reports failure when async processing throws', async () => {
    mocks.parseWebhookPayload.mockReturnValue(baseParsed());
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockRejectedValue(new Error('boom'));
    mocks.mockClient.reportStatus.mockResolvedValue({});

    const { req, res } = makeReqRes({});
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      expect.stringContaining('V2 Cascade failed for Protocol'),
      expect.any(Object),
    );
  });
});
