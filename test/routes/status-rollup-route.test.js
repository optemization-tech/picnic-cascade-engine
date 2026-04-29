import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    getPage: vi.fn(),
    queryDatabase: vi.fn(),
    patchPage: vi.fn(),
    reportStatus: vi.fn(),
  },
  parseWebhookPayload: vi.fn(),
  computeStatusRollup: vi.fn(),
  normalizeTask: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    notion: {
      tokens: ['token-1'],
      commentTokens: [],
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
}));

vi.mock('../../src/engine/status-rollup.js', () => ({
  computeStatusRollup: mocks.computeStatusRollup,
}));

vi.mock('../../src/notion/properties.js', () => ({
  normalizeTask: mocks.normalizeTask,
}));

vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));

import { handleStatusRollup } from '../../src/routes/status-rollup.js';
import {
  STUDY_TASKS_PROPS as ST,
  STUDIES_PROPS as S,
} from '../../src/notion/property-names.js';

// Helpers to flush the fire-and-forget async chain (handler returns 200
// synchronously; processStatusRollup runs via flightTracker). We need enough
// microtask ticks for all awaited Notion fetches to resolve.
async function flushAsync(ticks = 6) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

describe('status-rollup route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true, pageId: 'page-1' });
  });

  // @behavior BEH-GUARD-IMPORT-MODE
  it('skips rollup side effects when study import mode is enabled', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task One',
      studyId: 'study-1',
    });
    mocks.mockClient.getPage
      .mockResolvedValueOnce({
        id: 'task-1',
        properties: {
          [ST.PARENT_TASK.name]: { id: ST.PARENT_TASK.id, type: 'relation', relation: [{ id: 'parent-1' }] },
          [ST.STUDY.name]:       { id: ST.STUDY.id,       type: 'relation', relation: [{ id: 'study-1' }] },
          [ST.SUBTASKS.name]:    { id: ST.SUBTASKS.id,    type: 'relation', relation: [] },
          [ST.TASK_NAME.name]:   { id: ST.TASK_NAME.id,   type: 'title',    title: [{ plain_text: 'Task One' }] },
        },
      })
      .mockResolvedValueOnce({
        id: 'study-1',
        properties: { [S.IMPORT_MODE.name]: { id: S.IMPORT_MODE.id, type: 'checkbox', checkbox: true } },
      });
    mocks.normalizeTask.mockReturnValue({
      id: 'task-1',
      name: 'Task One',
      parentId: 'parent-1',
      studyId: 'study-1',
    });

    const req = { body: { data: { id: 'task-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.queryDatabase).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
    expect(mocks.mockClient.reportStatus).not.toHaveBeenCalled();
  });

  // @behavior BEH-AUTOMATION-REPORTING
  it('reports to study Automation Reporting when async processing fails', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task One',
      studyId: 'study-1',
    });
    mocks.mockClient.getPage.mockRejectedValue(new Error('status route boom'));
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.computeStatusRollup.mockReturnValue('Done');
    mocks.normalizeTask.mockReturnValue({});

    const req = { body: { data: { id: 'task-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(res.status).toHaveBeenCalledWith(200);
    // After the consistency fix: error reportStatus is task-scoped (matches
    // date-cascade lifecycle pattern). Falls back to studyId only if
    // taskId is missing from the parsed payload.
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'task-1',
      'error',
      expect.stringContaining('Status roll-up failed for Task One'),
    );
  });
});

describe('status-rollup parent-direct snap-back', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true, pageId: 'page-1' });
  });

  function setupParentDirectScenario({
    editedByBot = false,
    parentStatus = 'Done',
    childrenPages = [{ id: 'child-1', properties: {} }, { id: 'child-2', properties: {} }],
    rollupResult = 'In Progress',
    importMode = false,
  } = {}) {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      editedByBot,
      taskId: 'parent-1',
      taskName: 'Sites Planning',
      studyId: 'study-1',
    });
    mocks.mockClient.getPage
      .mockResolvedValueOnce({
        id: 'parent-1',
        properties: {
          [ST.STUDY.name]:     { id: ST.STUDY.id,     type: 'relation', relation: [{ id: 'study-1' }] },
          [ST.SUBTASKS.name]:  { id: ST.SUBTASKS.id,  type: 'relation', relation: [{ id: 'child-1' }, { id: 'child-2' }] },
          [ST.STATUS.name]:    { id: ST.STATUS.id,    type: 'status',   status: { name: parentStatus } },
          [ST.TASK_NAME.name]: { id: ST.TASK_NAME.id, type: 'title',    title: [{ plain_text: 'Sites Planning' }] },
        },
      })
      .mockResolvedValueOnce({
        id: 'study-1',
        properties: { [S.IMPORT_MODE.name]: { id: S.IMPORT_MODE.id, type: 'checkbox', checkbox: importMode } },
      });
    mocks.normalizeTask.mockImplementation((page) => {
      if (!page) return {};
      if (page.id === 'parent-1') {
        return { id: 'parent-1', name: 'Sites Planning', studyId: 'study-1', parentId: null };
      }
      return { id: page.id };
    });
    mocks.mockClient.queryDatabase.mockResolvedValueOnce(childrenPages);
    mocks.computeStatusRollup.mockReturnValue(rollupResult);
    mocks.mockClient.patchPage.mockResolvedValue({});
  }

  // @behavior BEH-PARENT-DIRECT-SNAPBACK
  it('snaps parent back to computed rollup when subtasks disagree', async () => {
    setupParentDirectScenario({
      parentStatus: 'Done',
      rollupResult: 'In Progress',
    });

    const req = { body: { data: { id: 'parent-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(mocks.mockClient.queryDatabase).toHaveBeenCalledWith(
      'db-study-tasks',
      { property: ST.PARENT_TASK.id, relation: { contains: 'parent-1' } },
      100,
    );
    expect(mocks.mockClient.patchPage).toHaveBeenCalledWith('parent-1', {
      [ST.STATUS.id]: { status: { name: 'In Progress' } },
    });
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Status Roll-Up',
        sourceTaskId: 'parent-1',
        sourceTaskName: 'Sites Planning',
        studyId: 'study-1',
        status: 'success',
        summary: expect.stringContaining('corrected'),
        details: expect.objectContaining({
          direction: 'parent-direct',
          oldStatus: 'Done',
          newStatus: 'In Progress',
          subtaskCount: 2,
        }),
      }),
    );
  });

  it('snaps parent forward to Done when all subtasks are Done', async () => {
    setupParentDirectScenario({
      parentStatus: 'Not started',
      rollupResult: 'Done',
    });

    const req = { body: { data: { id: 'parent-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(mocks.mockClient.patchPage).toHaveBeenCalledWith('parent-1', {
      [ST.STATUS.id]: { status: { name: 'Done' } },
    });
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          direction: 'parent-direct',
          oldStatus: 'Not started',
          newStatus: 'Done',
        }),
      }),
    );
  });

  it('does not patch when desired status already matches current', async () => {
    setupParentDirectScenario({
      parentStatus: 'In Progress',
      rollupResult: 'In Progress',
    });

    const req = { body: { data: { id: 'parent-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(mocks.mockClient.queryDatabase).toHaveBeenCalled();
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  // @behavior BEH-PARENT-DIRECT-BOT-ECHO-SKIP
  it('skips parent-direct branch when webhook is a bot-echo (editedByBot=true)', async () => {
    setupParentDirectScenario({
      editedByBot: true,
      parentStatus: 'Done',
      rollupResult: 'In Progress',
    });

    const req = { body: { data: { id: 'parent-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(mocks.mockClient.queryDatabase).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  // @behavior BEH-PARENT-DIRECT-STALE-RELATION
  it('skips parent-direct snap-back when children query returns empty (stale relation)', async () => {
    setupParentDirectScenario({
      parentStatus: 'Done',
      rollupResult: 'Not Started',
      childrenPages: [],
    });

    const req = { body: { data: { id: 'parent-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(mocks.mockClient.queryDatabase).toHaveBeenCalled();
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  it('snap-back runs on middle parent (has both parentId AND subtasks); grandparent rollup is not triggered', async () => {
    // A middle parent has its own parentId AND its own subtasks. Per the
    // plan, the parent-direct snap-back path runs on middle parents too --
    // the documented limitation is that the grandparent is NOT rolled up
    // as a follow-up (out of scope).
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      editedByBot: false,
      taskId: 'middle-parent',
      taskName: 'Middle Parent',
      studyId: 'study-1',
    });
    mocks.mockClient.getPage
      .mockResolvedValueOnce({
        id: 'middle-parent',
        properties: {
          [ST.STUDY.name]:       { id: ST.STUDY.id,       type: 'relation', relation: [{ id: 'study-1' }] },
          [ST.PARENT_TASK.name]: { id: ST.PARENT_TASK.id, type: 'relation', relation: [{ id: 'grandparent' }] },
          [ST.SUBTASKS.name]:    { id: ST.SUBTASKS.id,    type: 'relation', relation: [{ id: 'child-1' }] },
          [ST.STATUS.name]:      { id: ST.STATUS.id,      type: 'status',   status: { name: 'Done' } },
          [ST.TASK_NAME.name]:   { id: ST.TASK_NAME.id,   type: 'title',    title: [{ plain_text: 'Middle Parent' }] },
        },
      })
      .mockResolvedValueOnce({
        id: 'study-1',
        properties: { [S.IMPORT_MODE.name]: { id: S.IMPORT_MODE.id, type: 'checkbox', checkbox: false } },
      });
    mocks.normalizeTask.mockImplementation((page) => {
      if (!page) return {};
      if (page.id === 'middle-parent') {
        return {
          id: 'middle-parent',
          name: 'Middle Parent',
          studyId: 'study-1',
          parentId: 'grandparent', // has a parent
        };
      }
      return { id: page.id };
    });
    mocks.mockClient.queryDatabase.mockResolvedValueOnce([{ id: 'child-1', properties: {} }]);
    mocks.computeStatusRollup.mockReturnValue('In Progress');
    mocks.mockClient.patchPage.mockResolvedValue({});

    const req = { body: { data: { id: 'middle-parent' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    // The middle parent gets patched from Done -> In Progress
    expect(mocks.mockClient.patchPage).toHaveBeenCalledWith('middle-parent', {
      [ST.STATUS.id]: { status: { name: 'In Progress' } },
    });
    // The grandparent is NOT patched (scope boundary -- documented limitation)
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalledWith('grandparent', expect.anything());
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: 'middle-parent',
        details: expect.objectContaining({ direction: 'parent-direct' }),
      }),
    );
  });

  it('skips parent-direct branch when Import Mode is enabled on the study', async () => {
    setupParentDirectScenario({
      parentStatus: 'Done',
      rollupResult: 'In Progress',
      importMode: true,
    });

    const req = { body: { data: { id: 'parent-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(mocks.mockClient.queryDatabase).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
  });
});

describe('status-rollup leaf subtask -> parent rollup (existing behavior)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true, pageId: 'page-1' });
  });

  it('rolls up parent status when a leaf subtask changes', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      editedByBot: false,
      taskId: 'task-1',
      taskName: 'Task One',
      studyId: 'study-1',
    });
    mocks.mockClient.getPage
      .mockResolvedValueOnce({
        id: 'task-1',
        properties: {
          [ST.PARENT_TASK.name]: { id: ST.PARENT_TASK.id, type: 'relation', relation: [{ id: 'parent-1' }] },
          [ST.STUDY.name]:       { id: ST.STUDY.id,       type: 'relation', relation: [{ id: 'study-1' }] },
          [ST.SUBTASKS.name]:    { id: ST.SUBTASKS.id,    type: 'relation', relation: [] },
          [ST.TASK_NAME.name]:   { id: ST.TASK_NAME.id,   type: 'title',    title: [{ plain_text: 'Task One' }] },
        },
      })
      .mockResolvedValueOnce({
        id: 'study-1',
        properties: { [S.IMPORT_MODE.name]: { id: S.IMPORT_MODE.id, type: 'checkbox', checkbox: false } },
      })
      .mockResolvedValueOnce({
        id: 'parent-1',
        properties: {
          [ST.STATUS.name]:    { id: ST.STATUS.id,    type: 'status', status: { name: 'Not started' } },
          [ST.TASK_NAME.name]: { id: ST.TASK_NAME.id, type: 'title',  title: [{ plain_text: 'Parent One' }] },
        },
      });
    mocks.normalizeTask.mockImplementation((page) => {
      if (!page) return {};
      if (page.id === 'task-1') {
        return { id: 'task-1', name: 'Task One', parentId: 'parent-1', studyId: 'study-1' };
      }
      return { id: page.id, status: 'Done' };
    });
    mocks.mockClient.queryDatabase.mockResolvedValueOnce([
      { id: 'task-1', properties: {} },
      { id: 'sibling-1', properties: {} },
    ]);
    mocks.computeStatusRollup.mockReturnValue('Done');
    mocks.mockClient.patchPage.mockResolvedValue({});

    const req = { body: { data: { id: 'task-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(mocks.mockClient.patchPage).toHaveBeenCalledWith('parent-1', {
      [ST.STATUS.id]: { status: { name: 'Done' } },
    });
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: 'task-1',
        sourceTaskName: 'Task One',
        summary: expect.stringContaining('triggered by Task One'),
        details: expect.objectContaining({
          direction: 'subtask-triggered',
          parentId: 'parent-1',
        }),
      }),
    );
  });

  it('skips leaf branch when task has no parentId and no subtasks (free-floating)', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      editedByBot: false,
      taskId: 'task-1',
      studyId: 'study-1',
    });
    mocks.mockClient.getPage
      .mockResolvedValueOnce({
        id: 'task-1',
        properties: {
          [ST.STUDY.name]:    { id: ST.STUDY.id,    type: 'relation', relation: [{ id: 'study-1' }] },
          [ST.SUBTASKS.name]: { id: ST.SUBTASKS.id, type: 'relation', relation: [] },
        },
      })
      .mockResolvedValueOnce({
        id: 'study-1',
        properties: { [S.IMPORT_MODE.name]: { id: S.IMPORT_MODE.id, type: 'checkbox', checkbox: false } },
      });
    mocks.normalizeTask.mockReturnValue({
      id: 'task-1',
      parentId: null,
      studyId: 'study-1',
    });

    const req = { body: { data: { id: 'task-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await flushAsync();

    expect(mocks.mockClient.queryDatabase).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
  });
});
