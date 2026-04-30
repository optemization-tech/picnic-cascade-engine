import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    patchPages: vi.fn(),
  },
  parseWebhookPayload: vi.fn(),
  tightenSeedAndDownstream: vi.fn(),
  runParentSubtask: vi.fn(),
  queryStudyTasks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  studyCommentService: {
    postComment: vi.fn(),
  },
  cascadeQueueEnqueue: vi.fn((payload, _parseFn, processFn) => {
    void processFn(payload).catch(() => {});
  }),
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
}));

vi.mock('../../src/engine/cascade.js', () => ({
  tightenSeedAndDownstream: mocks.tightenSeedAndDownstream,
}));

vi.mock('../../src/engine/parent-subtask.js', () => ({
  runParentSubtask: mocks.runParentSubtask,
}));

vi.mock('../../src/notion/queries.js', () => ({
  queryStudyTasks: mocks.queryStudyTasks,
}));

vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));

vi.mock('../../src/services/study-comment.js', () => ({
  StudyCommentService: vi.fn(() => mocks.studyCommentService),
}));

vi.mock('../../src/services/cascade-queue.js', () => ({
  cascadeQueue: { enqueue: mocks.cascadeQueueEnqueue },
}));

import { handleDepEdit } from '../../src/routes/dep-edit.js';

function makeReqRes(body = {}) {
  return {
    req: { body },
    res: {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    },
  };
}

function happyParsed(overrides = {}) {
  return {
    skip: false,
    taskId: 'task-1',
    taskName: 'Test Task',
    studyId: 'study-1',
    triggeredByUserId: 'user-1',
    editedByBot: false,
    hasDates: true,
    hasSubtasks: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no parent rollups. Tests that exercise the rollup path override this.
  mocks.runParentSubtask.mockReturnValue({ updates: [], rollUpCount: 0 });
  mocks.cascadeQueueEnqueue.mockImplementation((payload, _parseFn, processFn) => {
    void processFn(payload).catch(() => {});
  });
});

describe('handleDepEdit', () => {
  describe('happy path', () => {
    // @behavior BEH-DEP-EDIT-ROUTE-VIOLATION
    it('runs the cascade and logs Activity Log on a violation', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1' }, { id: 'task-2' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'violation',
        updates: [
          { taskId: 'task-1', taskName: 'Test Task', newStart: '2026-04-06', newEnd: '2026-04-07' },
          { taskId: 'task-2', taskName: 'Downstream', newStart: '2026-04-08', newEnd: '2026-04-09' },
        ],
        movedTaskIds: ['task-1', 'task-2'],
        downstreamCount: 1,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });
      mocks.mockClient.patchPages.mockResolvedValue({ updatedCount: 2 });

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });

      // wait a tick for the async processFn invoked by the mocked cascadeQueue
      await new Promise((r) => setImmediate(r));

      expect(mocks.queryStudyTasks).toHaveBeenCalled();
      expect(mocks.tightenSeedAndDownstream).toHaveBeenCalledWith({
        seedTaskId: 'task-1',
        tasks: [{ id: 'task-1' }, { id: 'task-2' }],
      });
      expect(mocks.mockClient.patchPages).toHaveBeenCalled();
      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: 'Dep Edit Cascade',
          cascadeMode: 'dep-edit',
          status: 'success',
          details: expect.objectContaining({ subcase: 'violation', downstreamCount: 1 }),
        }),
      );
    });

    // @behavior BEH-DEP-EDIT-ROUTE-GAP
    it('runs the cascade and logs Activity Log on a gap', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'gap',
        updates: [{ taskId: 'task-1', taskName: 'Test Task', newStart: '2026-04-01', newEnd: '2026-04-02' }],
        movedTaskIds: ['task-1'],
        downstreamCount: 0,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });
      mocks.mockClient.patchPages.mockResolvedValue({ updatedCount: 1 });

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          details: expect.objectContaining({ subcase: 'gap' }),
        }),
      );
    });
  });

  describe('no-op paths (no Activity Log noise)', () => {
    // @behavior BEH-DEP-EDIT-ROUTE-NOOP-SILENT
    it('skips Activity Log entirely on already-tight no-op', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'no-op',
        reason: 'already-tight',
        updates: [],
        movedTaskIds: [],
        downstreamCount: 0,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
      expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
    });

    // @behavior BEH-DEP-EDIT-ROUTE-NOOP-SKIPS-ROLLUP
    it('skips runParentSubtask entirely when subcase=no-op (silent path preserved)', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'no-op',
        reason: 'already-tight',
        updates: [],
        movedTaskIds: [],
        downstreamCount: 0,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.runParentSubtask).not.toHaveBeenCalled();
    });
  });

  describe('parent rollup (cascade-roll-up pass)', () => {
    // @behavior BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP
    it('calls runParentSubtask with parentMode=null and merges parent updates into the patch', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      const allTasks = [
        { id: 'task-1', parentId: 'parent-1' },
        { id: 'task-2', parentId: 'parent-1' },
        { id: 'parent-1' },
      ];
      mocks.queryStudyTasks.mockResolvedValue(allTasks);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'violation',
        updates: [
          { taskId: 'task-1', taskName: 'Test Task', newStart: '2026-04-06', newEnd: '2026-04-07' },
          { taskId: 'task-2', taskName: 'Sibling', newStart: '2026-04-08', newEnd: '2026-04-09' },
        ],
        movedTaskIds: ['task-1', 'task-2'],
        movedTaskMap: {
          'task-1': { newStart: '2026-04-06', newEnd: '2026-04-07' },
          'task-2': { newStart: '2026-04-08', newEnd: '2026-04-09' },
        },
        downstreamCount: 1,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });
      mocks.runParentSubtask.mockReturnValue({
        updates: [
          {
            taskId: 'parent-1',
            taskName: 'Parent 1',
            newStart: '2026-04-06',
            newEnd: '2026-04-09',
            newReferenceStartDate: '2026-04-06',
            newReferenceEndDate: '2026-04-09',
            _isRollUp: true,
            _reportingMsg: '❇️ Roll-up: dates set to 2026-04-06 — 2026-04-09',
          },
        ],
        rollUpCount: 1,
      });
      mocks.mockClient.patchPages.mockResolvedValue({ updatedCount: 3 });

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      // runParentSubtask invoked with parentMode=null and the cascade's moved data
      expect(mocks.runParentSubtask).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceTaskId: 'task-1',
          parentTaskId: null,
          parentMode: null,
          movedTaskIds: ['task-1', 'task-2'],
          movedTaskMap: expect.objectContaining({ 'task-1': expect.any(Object) }),
          tasks: allTasks,
        }),
      );

      // Patch payload merges leaf + parent updates
      expect(mocks.mockClient.patchPages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ taskId: 'task-1' }),
          expect.objectContaining({ taskId: 'task-2' }),
          expect.objectContaining({ taskId: 'parent-1' }),
        ]),
      );
    });

    // @behavior BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-LOG
    it('records rollUpCount and rollUpTaskIds in the Activity Log details and bumps movement.updatedCount', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1', parentId: 'parent-1' }, { id: 'parent-1' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'violation',
        updates: [{ taskId: 'task-1', taskName: 'Test Task', newStart: '2026-04-06', newEnd: '2026-04-07' }],
        movedTaskIds: ['task-1'],
        movedTaskMap: { 'task-1': { newStart: '2026-04-06', newEnd: '2026-04-07' } },
        downstreamCount: 0,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });
      mocks.runParentSubtask.mockReturnValue({
        updates: [
          { taskId: 'parent-1', taskName: 'Parent 1', newStart: '2026-04-06', newEnd: '2026-04-07', _isRollUp: true },
        ],
        rollUpCount: 1,
      });
      mocks.mockClient.patchPages.mockResolvedValue({ updatedCount: 2 });

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          summary: expect.stringContaining('parent roll-up'),
          details: expect.objectContaining({
            rollUpCount: 1,
            rollUpTaskIds: ['parent-1'],
            // movement.updatedCount reflects merged total (1 leaf + 1 parent = 2)
            movement: expect.objectContaining({ updatedCount: 2 }),
            // Existing forensics scalars stay top-level
            subcase: 'violation',
            downstreamCount: 0,
          }),
        }),
      );
    });

    // @behavior BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-NONE
    it('emits no parent updates and no rollup phrasing when no moved subtask has a parent', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'gap',
        updates: [{ taskId: 'task-1', taskName: 'Test Task', newStart: '2026-04-01', newEnd: '2026-04-02' }],
        movedTaskIds: ['task-1'],
        movedTaskMap: { 'task-1': { newStart: '2026-04-01', newEnd: '2026-04-02' } },
        downstreamCount: 0,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });
      mocks.runParentSubtask.mockReturnValue({ updates: [], rollUpCount: 0 });
      mocks.mockClient.patchPages.mockResolvedValue({ updatedCount: 1 });

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      // Patch contains only the leaf row
      const callArgs = mocks.mockClient.patchPages.mock.calls[0][0];
      expect(callArgs).toHaveLength(1);
      expect(callArgs[0]).toMatchObject({ taskId: 'task-1' });
      // Activity Log records rollUpCount=0; success summary has no "parent roll-up" phrase
      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.not.stringContaining('parent roll-up'),
          details: expect.objectContaining({ rollUpCount: 0, rollUpTaskIds: [] }),
        }),
      );
    });

    // @behavior BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-FAILURE-CONTEXT
    it('preserves parent-rollup context on the failure-path Activity Log row when patchPages throws', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1', parentId: 'parent-1' }, { id: 'parent-1' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'violation',
        updates: [{ taskId: 'task-1', taskName: 'Test Task', newStart: '2026-04-06', newEnd: '2026-04-07' }],
        movedTaskIds: ['task-1'],
        movedTaskMap: { 'task-1': { newStart: '2026-04-06', newEnd: '2026-04-07' } },
        downstreamCount: 0,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });
      mocks.runParentSubtask.mockReturnValue({
        updates: [
          { taskId: 'parent-1', taskName: 'Parent 1', newStart: '2026-04-06', newEnd: '2026-04-07', _isRollUp: true },
        ],
        rollUpCount: 1,
      });
      mocks.mockClient.patchPages.mockRejectedValue(new Error('Notion 502'));

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          details: expect.objectContaining({
            // Failure row preserves rollup context computed before patchPages threw
            rollUpCount: 1,
            rollUpTaskIds: ['parent-1'],
            subcase: 'violation',
          }),
        }),
      );
    });
  });

  describe('early-return guards (defense in depth vs Notion filter)', () => {
    // @behavior BEH-DEP-EDIT-ROUTE-EDITED-BY-BOT
    it('skips when editedByBot=true (does not call queryStudyTasks)', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed({ editedByBot: true }));

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
      expect(mocks.tightenSeedAndDownstream).not.toHaveBeenCalled();
      expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
    });

    // @behavior BEH-DEP-EDIT-ROUTE-NO-DATES
    it('skips when hasDates=false', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed({ hasDates: false }));

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
    });

    // @behavior BEH-DEP-EDIT-ROUTE-PARENT-TASK
    it('skips when hasSubtasks=true (parent task)', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed({ hasSubtasks: true }));

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
    });

    // @behavior BEH-DEP-EDIT-ROUTE-MISSING-STUDY
    it('skips when studyId is missing', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed({ studyId: null }));

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
    });

    // @behavior BEH-DEP-EDIT-ROUTE-PARSE-SKIP
    it('skips when parseWebhookPayload returns skip=true (malformed payload)', async () => {
      mocks.parseWebhookPayload.mockReturnValue({ skip: true, reason: 'no-page-id' });

      const { req, res } = makeReqRes({ malformed: true });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
      expect(mocks.tightenSeedAndDownstream).not.toHaveBeenCalled();
      expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
      expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    // @behavior BEH-DEP-EDIT-ROUTE-ERROR
    it('logs error to Activity Log and posts study comment when patchPages throws', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'violation',
        updates: [{ taskId: 'task-1', taskName: 'Test Task', newStart: '2026-04-06', newEnd: '2026-04-07' }],
        movedTaskIds: ['task-1'],
        downstreamCount: 0,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });
      mocks.mockClient.patchPages.mockRejectedValue(new Error('Notion 502'));

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
        expect.objectContaining({ workflow: 'Dep Edit Cascade', status: 'failed' }),
      );
    });

    // @behavior BEH-DEP-EDIT-ROUTE-FAILURE-PRESERVES-CONTEXT
    it('failure-path Activity Log preserves cascade result context (subcase, movement)', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed({ refStart: '2026-04-01', refEnd: '2026-04-02' }));
      mocks.queryStudyTasks.mockResolvedValue([{ id: 'task-1' }, { id: 'task-2' }]);
      mocks.tightenSeedAndDownstream.mockReturnValue({
        subcase: 'violation',
        updates: [
          { taskId: 'task-1', taskName: 'Test Task', newStart: '2026-04-06', newEnd: '2026-04-07' },
          { taskId: 'task-2', taskName: 'Downstream', newStart: '2026-04-08', newEnd: '2026-04-09' },
        ],
        movedTaskIds: ['task-1', 'task-2'],
        downstreamCount: 1,
        diagnostics: { cycleDetected: false, cycleTaskIds: [] },
      });
      mocks.mockClient.patchPages.mockRejectedValue(new Error('Notion 502'));

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      // Without result threading, details would show subcase: null and updatedCount: 0
      // even though the cascade actually computed work that the patch failed to apply.
      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          details: expect.objectContaining({
            subcase: 'violation',
            downstreamCount: 1,
            movement: expect.objectContaining({ updatedCount: 2, movedTaskIds: ['task-1', 'task-2'] }),
          }),
        }),
      );
    });

    // @behavior BEH-DEP-EDIT-ROUTE-QUERY-REJECT
    it('logs error and posts study comment when queryStudyTasks throws', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockRejectedValue(new Error('Notion 503 — service unavailable'));

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.tightenSeedAndDownstream).not.toHaveBeenCalled();
      expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
        expect.objectContaining({ workflow: 'Dep Edit Cascade', status: 'failed' }),
      );
    });

    // @behavior BEH-DEP-EDIT-ROUTE-EMPTY-STUDY
    it('skips when queryStudyTasks returns empty (stale studyId or racing deletion)', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([]);

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);
      await new Promise((r) => setImmediate(r));

      expect(mocks.tightenSeedAndDownstream).not.toHaveBeenCalled();
      expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
    });
  });

  describe('webhook contract', () => {
    // @behavior BEH-DEP-EDIT-ROUTE-200-IMMEDIATE
    it('returns 200 immediately before processing', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());
      mocks.queryStudyTasks.mockResolvedValue([]);

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    // @behavior BEH-DEP-EDIT-ROUTE-ENQUEUE
    it('enqueues via cascadeQueue (gets debounce + per-study FIFO)', async () => {
      mocks.parseWebhookPayload.mockReturnValue(happyParsed());

      const { req, res } = makeReqRes({ source: { id: 'task-1' } });
      await handleDepEdit(req, res);

      expect(mocks.cascadeQueueEnqueue).toHaveBeenCalledTimes(1);
      expect(mocks.cascadeQueueEnqueue).toHaveBeenCalledWith(
        req.body,
        expect.any(Function), // parseWebhookPayload
        expect.any(Function), // processDepEdit
      );
    });
  });
});
