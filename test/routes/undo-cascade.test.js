import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    patchBatch: vi.fn(),
    reportStatus: vi.fn(),
  },
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  undoStore: {
    pop: vi.fn(),
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

vi.mock('../../src/notion/client.js', () => ({
  NotionClient: vi.fn(() => mocks.mockClient),
}));

vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));

vi.mock('../../src/services/undo-store.js', () => ({
  undoStore: mocks.undoStore,
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
    mocks.mockClient.patchBatch.mockResolvedValue({ updatedCount: 2 });
  });

  it('returns 200 immediately', async () => {
    mocks.undoStore.pop.mockReturnValue(null);
    const { req, res } = makeReqRes({ studyId: 'study-1' });
    await handleUndoCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('reports warning when no undo available', async () => {
    mocks.undoStore.pop.mockReturnValue(null);
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

  it('restores dates in a single patch batch without LMBS', async () => {
    mocks.undoStore.pop.mockReturnValue({
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

    // Single patchBatch call: restore dates (no pre-LMBS, no unlock)
    expect(mocks.mockClient.patchBatch).toHaveBeenCalledTimes(1);

    const restoreCall = mocks.mockClient.patchBatch.mock.calls[0][0];
    expect(restoreCall).toHaveLength(2);
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
    mocks.undoStore.pop.mockReturnValue({
      cascadeId: 'c1',
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      cascadeMode: 'push-right',
      manifest: { 'task-a': { oldStart: '2026-04-01', oldEnd: '2026-04-02', newStart: '2026-04-03', newEnd: '2026-04-04' } },
      timestamp: Date.now(),
    });
    mocks.mockClient.patchBatch.mockRejectedValueOnce(new Error('restore failed'));

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

  it('logs activity entry on success', async () => {
    mocks.undoStore.pop.mockReturnValue({
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
        summary: 'Undo: push-right cascade for Source Task reversed (1 tasks restored)',
        details: expect.objectContaining({ undoCascadeId: 'c1', restoredCount: 1 }),
      }),
    );
  });
});
