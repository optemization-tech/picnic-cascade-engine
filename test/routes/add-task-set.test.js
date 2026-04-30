import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    getPage: vi.fn(),
    queryDatabase: vi.fn(),
    reportStatus: vi.fn(),
    request: vi.fn(),
    patchPages: vi.fn(),
  },
  fetchBlueprint: vi.fn(),
  buildTaskTree: vi.fn(),
  filterBlueprintSubtree: vi.fn(),
  createStudyTasks: vi.fn(),
  wireRemainingRelations: vi.fn(),
  copyBlocks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  studyCommentService: {
    postComment: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    notion: {
      tokens: ['token-1'],
      provisionTokens: ['prov-token-1'],
      studyTasksDbId: 'db-study-tasks',
      studiesDbId: 'db-studies',
      activityLogDbId: 'db-activity-log',
      blueprintDbId: 'db-blueprint',
    },
    port: 3000,
  },
}));

vi.mock('../../src/notion/clients.js', () => ({
  cascadeClient: mocks.mockClient,
  provisionClient: mocks.mockClient,
  deletionClient: mocks.mockClient,
  commentClient: mocks.mockClient,
}));

vi.mock('../../src/provisioning/blueprint.js', () => ({
  fetchBlueprint: mocks.fetchBlueprint,
  buildTaskTree: mocks.buildTaskTree,
  filterBlueprintSubtree: mocks.filterBlueprintSubtree,
}));

vi.mock('../../src/provisioning/create-tasks.js', () => ({
  createStudyTasks: mocks.createStudyTasks,
}));

vi.mock('../../src/provisioning/wire-relations.js', () => ({
  wireRemainingRelations: mocks.wireRemainingRelations,
}));

vi.mock('../../src/provisioning/copy-blocks.js', () => ({
  copyBlocks: mocks.copyBlocks,
}));

vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));

vi.mock('../../src/services/study-comment.js', () => ({
  StudyCommentService: vi.fn(() => mocks.studyCommentService),
}));

import { handleAddTaskSet } from '../../src/routes/add-task-set.js';
import { _resetStudyLocks } from '../../src/services/study-lock.js';
import {
  STUDY_TASKS_PROPS as ST,
  STUDIES_PROPS as S,
} from '../../src/notion/property-names.js';

/**
 * Flush microtasks to let the detached void promise chain settle.
 * Each await in processAddTaskSet needs a microtask tick to resolve.
 */
async function flush(n = 20) {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

function makeReqRes(body = {}, headers = {}) {
  const req = { body, headers };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return { req, res };
}

function mockStudyPage({ importMode = false, contractSignDate = '2026-01-15' } = {}) {
  return {
    id: 'study-1',
    properties: {
      [S.IMPORT_MODE.name]:        { id: S.IMPORT_MODE.id,        type: 'checkbox', checkbox: importMode },
      [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date',     date: { start: contractSignDate } },
      [S.STUDY_NAME.name]:         { id: S.STUDY_NAME.id,         type: 'title',    title: [{ text: { content: 'Test Study' } }] },
    },
  };
}

describe('add-task-set route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetStudyLocks();
    mocks.copyBlocks.mockResolvedValue({ blocksWrittenCount: 0, pagesProcessed: 0, pagesSkipped: 0 });
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true, pageId: 'page-1' });
    mocks.studyCommentService.postComment.mockResolvedValue({ posted: true });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.request.mockResolvedValue({});
  });

  it('returns 200 immediately', async () => {
    const { req, res } = makeReqRes({}, {});
    await handleAddTaskSet(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('skips when studyPageId is missing', async () => {
    const { req, res } = makeReqRes(
      {},
      { 'x-button-type': 'repeat-delivery', 'x-parent-task-names': 'Data Delivery' },
    );
    await handleAddTaskSet(req, res);
    await flush();

    expect(mocks.mockClient.getPage).not.toHaveBeenCalled();
    expect(mocks.fetchBlueprint).not.toHaveBeenCalled();
  });

  it('skips when buttonType is missing', async () => {
    const { req, res } = makeReqRes(
      { data: { id: 'study-1' } },
      { 'x-parent-task-names': 'Data Delivery' },
    );
    await handleAddTaskSet(req, res);
    await flush();

    expect(mocks.mockClient.getPage).not.toHaveBeenCalled();
    expect(mocks.fetchBlueprint).not.toHaveBeenCalled();
  });

  it('extracts button type and parent task names from headers', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1' }]);
    mocks.filterBlueprintSubtree.mockReturnValue([
      { level: 0, tasks: [{ _templateId: 'bp-1', _taskName: 'Data Delivery #1' }], isLastLevel: true },
    ]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: { 'bp-1': 'prod-1' },
      totalCreated: 1,
      depTracking: [],
      parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({
      parentsPatchedCount: 0,
      depsPatchedCount: 0,
    });

    const { req, res } = makeReqRes(
      { data: { id: 'study-1' } },
      { 'x-button-type': 'additional-site', 'x-parent-task-names': 'Site Setup, Data Delivery' },
    );

    await handleAddTaskSet(req, res);
    await flush();

    expect(mocks.filterBlueprintSubtree).toHaveBeenCalledWith(
      [{ id: 'bp-1' }],
      ['Site Setup', 'Data Delivery'],
    );
  });

  it('proceeds even when Import Mode is already active (Notion automation sets it before webhook)', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage({ importMode: true }));

    const { req, res } = makeReqRes(
      { data: { id: 'study-1' } },
      { 'x-button-type': 'repeat-delivery', 'x-parent-task-names': 'Data Delivery' },
    );

    await handleAddTaskSet(req, res);
    await flush();

    expect(res.status).toHaveBeenCalledWith(200);
    // Should proceed to fetch blueprint (Import Mode ON is expected from Notion automation)
    expect(mocks.fetchBlueprint).toHaveBeenCalled();
  });

  it('resolves delivery numbering for repeat-delivery button', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
    // Existing tasks with delivery numbers
    mocks.mockClient.queryDatabase.mockResolvedValue([
      { properties: { [ST.TASK_NAME.name]: { id: ST.TASK_NAME.id, type: 'title', title: [{ text: { content: 'Data Delivery #1 — Review' } }] } } },
      { properties: { [ST.TASK_NAME.name]: { id: ST.TASK_NAME.id, type: 'title', title: [{ text: { content: 'Data Delivery #2 — Review' } }] } } },
    ]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1' }]);
    const filteredTask = { _templateId: 'bp-1', _taskName: 'Data Delivery #1', _templateBlockedBy: [] };
    mocks.filterBlueprintSubtree.mockReturnValue([
      { level: 0, tasks: [filteredTask], isLastLevel: true },
    ]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: { 'bp-1': 'prod-1' },
      totalCreated: 1,
      depTracking: [],
      parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({
      parentsPatchedCount: 0,
      depsPatchedCount: 0,
    });

    const { req, res } = makeReqRes(
      { data: { id: 'study-1' } },
      { 'x-button-type': 'repeat-delivery', 'x-parent-task-names': 'Data Delivery' },
    );

    await handleAddTaskSet(req, res);
    await flush();

    // Task name should have been updated to #3 (max existing is #2)
    expect(filteredTask._taskName).toBe('Data Delivery #3');
  });

  it('happy path: creates tasks, wires relations, fires copy-blocks', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
    mocks.fetchBlueprint.mockResolvedValue([
      { id: 'bp-1', properties: { [ST.TASK_NAME.name]: { id: ST.TASK_NAME.id, type: 'title', title: [{ text: { content: 'Parent Task' } }] } } },
      { id: 'bp-2', properties: { [ST.TASK_NAME.name]: { id: ST.TASK_NAME.id, type: 'title', title: [{ text: { content: 'Child Task' } }] } } },
    ]);
    mocks.filterBlueprintSubtree.mockReturnValue([
      { level: 0, tasks: [{ _templateId: 'bp-1', _taskName: 'Parent Task' }], isLastLevel: false },
      { level: 1, tasks: [{ _templateId: 'bp-2', _taskName: 'Child Task' }], isLastLevel: true },
    ]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: { 'bp-1': 'prod-1', 'bp-2': 'prod-2' },
      totalCreated: 2,
      depTracking: [],
      parentTracking: [{ templateId: 'bp-2', templateParentId: 'bp-1' }],
    });
    mocks.wireRemainingRelations.mockResolvedValue({
      parentsPatchedCount: 1,
      depsPatchedCount: 0,
    });

    const { req, res } = makeReqRes(
      { data: { id: 'study-1' } },
      { 'x-button-type': 'additional-site', 'x-parent-task-names': 'Parent Task' },
    );

    await handleAddTaskSet(req, res);
    await flush();

    // Creates tasks
    expect(mocks.createStudyTasks).toHaveBeenCalledWith(
      mocks.mockClient,
      expect.any(Array),
      expect.objectContaining({
        studyPageId: 'study-1',
        contractSignDate: '2026-01-15',
        studyTasksDbId: 'db-study-tasks',
      }),
    );

    // Wires relations
    expect(mocks.wireRemainingRelations).toHaveBeenCalledWith(
      mocks.mockClient,
      expect.objectContaining({
        idMapping: { 'bp-1': 'prod-1', 'bp-2': 'prod-2' },
      }),
    );

    // Fires copy-blocks directly (no self-HTTP)
    expect(mocks.copyBlocks).toHaveBeenCalledWith(
      mocks.mockClient,
      expect.objectContaining({ 'bp-1': 'prod-1', 'bp-2': 'prod-2' }),
      expect.objectContaining({
        studyPageId: 'study-1',
        studyName: 'Test Study',
      }),
    );

    // Logs to activity log
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Add Task Set',
        status: 'success',
        summary: expect.stringContaining('2 tasks created'),
      }),
    );

    // Reports success
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'success',
      expect.stringContaining('Add Task Set complete'),
      expect.any(Object),
    );
  });

  it('disables Import Mode in finally block even when error occurs', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
    mocks.fetchBlueprint.mockRejectedValue(new Error('blueprint fetch failed'));

    const { req, res } = makeReqRes(
      { data: { id: 'study-1' } },
      { 'x-button-type': 'tlf-csr', 'x-parent-task-names': 'TLF' },
    );

    await handleAddTaskSet(req, res);
    await flush();

    // Import Mode was enabled, then should be disabled in finally
    const patchCalls = mocks.mockClient.request.mock.calls.filter(
      ([method, path]) => method === 'PATCH' && path.includes('/pages/study-1'),
    );

    // At least: enable Import Mode + disable in finally
    const importModeDisableCalls = patchCalls.filter(([, , body]) =>
      body?.properties?.[S.IMPORT_MODE.id]?.checkbox === false,
    );
    expect(importModeDisableCalls.length).toBeGreaterThanOrEqual(1);

    // Error should be reported
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      expect.stringContaining('blueprint fetch failed'),
      expect.any(Object),
    );
  });

  it('accepts studyPageId from body.studyPageId fallback', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1' }]);
    mocks.filterBlueprintSubtree.mockReturnValue([
      { level: 0, tasks: [{ _templateId: 'bp-1', _taskName: 'Task' }], isLastLevel: true },
    ]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: { 'bp-1': 'prod-1' },
      totalCreated: 1,
      depTracking: [],
      parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({
      parentsPatchedCount: 0,
      depsPatchedCount: 0,
    });

    const { req, res } = makeReqRes(
      { studyPageId: 'study-alt' },
      { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
    );

    await handleAddTaskSet(req, res);
    await flush();

    expect(mocks.mockClient.getPage).toHaveBeenCalledWith('study-alt');
  });

  describe('task set numbering (non-repeat-delivery)', () => {
    it('assigns #2 when one existing task matches the template ID', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      // Pre-creation query returns 1 existing TLF with matching Template Source ID
      mocks.mockClient.queryDatabase.mockResolvedValue([
        {
          id: 'existing-tlf-1',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ text: { content: 'TLF' } }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-tlf' }] },
          },
        },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }, { id: 'bp-child' }]);
      // Multi-task subtree — TLF has a child (Draft TLF, Internal Review, etc.
      // in the real blueprint). Multi-task subtrees bypass the single-leaf
      // duplicate guard in Unit 3, so this test covers the numbering path.
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: false },
        { level: 1, tasks: [{ _templateId: 'bp-child', _taskName: 'Draft TLF' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf-2', 'bp-child': 'prod-child-2' },
        totalCreated: 2,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });
      mocks.mockClient.patchPages.mockResolvedValue([]);

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
      );

      await handleAddTaskSet(req, res);
      await flush();

      // Should rename to TLF #2 (1 existing + 1 = 2)
      expect(mocks.mockClient.patchPages).toHaveBeenCalledWith(
        [expect.objectContaining({
          taskId: 'prod-tlf-2',
          properties: {
            [ST.TASK_NAME.id]: { title: [{ type: 'text', text: { content: 'TLF #2' } }] },
          },
        })],
        expect.any(Object),
      );
    });

    it('assigns #1 when no existing tasks match the template ID', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      // No existing tasks with matching TSID
      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf-1' },
        totalCreated: 1,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });
      mocks.mockClient.patchPages.mockResolvedValue([]);

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
      );

      await handleAddTaskSet(req, res);
      await flush();

      // Should rename to TLF #1 (0 existing + 1 = 1)
      expect(mocks.mockClient.patchPages).toHaveBeenCalledWith(
        [expect.objectContaining({
          taskId: 'prod-tlf-1',
          properties: {
            [ST.TASK_NAME.id]: { title: [{ type: 'text', text: { content: 'TLF #1' } }] },
          },
        })],
        expect.any(Object),
      );
    });

    it('assigns independent numbers to multiple level-0 parents', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      // 2 existing TLFs, 1 existing CSR
      mocks.mockClient.queryDatabase.mockResolvedValue([
        {
          id: 'existing-tlf-1',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ text: { content: 'TLF' } }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-tlf' }] },
          },
        },
        {
          id: 'existing-tlf-2',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ text: { content: 'TLF #2' } }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-tlf' }] },
          },
        },
        {
          id: 'existing-csr-1',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ text: { content: 'CSR' } }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-csr' }] },
          },
        },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }, { id: 'bp-csr' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        {
          level: 0,
          tasks: [
            { _templateId: 'bp-tlf', _taskName: 'TLF' },
            { _templateId: 'bp-csr', _taskName: 'CSR' },
          ],
          isLastLevel: true,
        },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf-3', 'bp-csr': 'prod-csr-2' },
        totalCreated: 2,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });
      mocks.mockClient.patchPages.mockResolvedValue([]);

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'tlf-csr', 'x-parent-task-names': 'TLF,CSR' },
      );

      await handleAddTaskSet(req, res);
      await flush();

      // TLF should be #3 (2 existing), CSR should be #2 (1 existing)
      expect(mocks.mockClient.patchPages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: 'prod-tlf-3',
            properties: {
              [ST.TASK_NAME.id]: { title: [{ type: 'text', text: { content: 'TLF #3' } }] },
            },
          }),
          expect.objectContaining({
            taskId: 'prod-csr-2',
            properties: {
              [ST.TASK_NAME.id]: { title: [{ type: 'text', text: { content: 'CSR #2' } }] },
            },
          }),
        ]),
        expect.any(Object),
      );
    });

    it('counts existing tasks using text.content TSID fallback', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      // Template Source ID provided via text.content (not plain_text)
      mocks.mockClient.queryDatabase.mockResolvedValue([
        {
          id: 'existing-tlf-1',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ text: { content: 'TLF' } }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ text: { content: 'bp-tlf' } }] },
          },
        },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }, { id: 'bp-child' }]);
      // Multi-task subtree — bypasses the single-leaf duplicate guard so we
      // exercise the TSID text.content fallback in the numbering path.
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: false },
        { level: 1, tasks: [{ _templateId: 'bp-child', _taskName: 'Draft TLF' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf-2', 'bp-child': 'prod-child-2' },
        totalCreated: 2,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });
      mocks.mockClient.patchPages.mockResolvedValue([]);

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
      );

      await handleAddTaskSet(req, res);
      await flush();

      // Should still count correctly via text.content fallback → TLF #2
      expect(mocks.mockClient.patchPages).toHaveBeenCalledWith(
        [expect.objectContaining({
          taskId: 'prod-tlf-2',
          properties: {
            [ST.TASK_NAME.id]: { title: [{ type: 'text', text: { content: 'TLF #2' } }] },
          },
        })],
        expect.any(Object),
      );
    });

    it('does not issue a second queryDatabase call after task creation', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf-1' },
        totalCreated: 1,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });
      mocks.mockClient.patchPages.mockResolvedValue([]);

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
      );

      await handleAddTaskSet(req, res);
      await flush();

      // queryDatabase should be called exactly once (the pre-creation fetch)
      expect(mocks.mockClient.queryDatabase).toHaveBeenCalledTimes(1);
    });

    it('does not call patchPages for repeat-delivery buttons', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      mocks.mockClient.queryDatabase.mockResolvedValue([
        { properties: { [ST.TASK_NAME.name]: { id: ST.TASK_NAME.id, type: 'title', title: [{ text: { content: 'Data Delivery #1 — Review' } }] } } },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-dd' }]);
      const filteredTask = { _templateId: 'bp-dd', _taskName: 'Data Delivery #1', _templateBlockedBy: [] };
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [filteredTask], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-dd': 'prod-dd-2' },
        totalCreated: 1,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'repeat-delivery', 'x-parent-task-names': 'Data Delivery' },
      );

      await handleAddTaskSet(req, res);
      await flush();

      // Repeat-delivery uses applyDeliveryNumbering (in-place rename), NOT patchPages
      expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    });
  });

  describe('repeat-delivery date copying (rename-aware)', () => {
    // Regression fixture for the Meg Apr 16 bug: DD#2 has manually shifted
    // dates (different from blueprint-offset formula). Firing repeat-delivery
    // must produce DD#3 whose Delivery task inherits DD#2's shifted dates —
    // not fall back to the formula. applyDeliveryNumbering rewrites
    // "Data Delivery #2" → "Data Delivery #3" *before* latestDates lookup, so
    // latestDates keys must be normalized to match the rename target.

    // DD#2 parent task id
    const parentId = 'dd2-parent-id';

    // DD#2 child dates — manually shifted LEFT by 10 BD from the formula,
    // so they are impossible to hit by coincidence of blueprint-offset math.
    // Delivery: 2027-11-23 → 2027-11-23 (formula would produce 2027-12-07).
    // Repeat QC:    2027-10-26 → 2027-11-22 (contiguous ending day before Delivery).
    const SHIFTED_DELIVERY_START = '2027-11-23';
    const SHIFTED_DELIVERY_END = '2027-11-23';
    const SHIFTED_QC_START = '2027-10-26';
    const SHIFTED_QC_END = '2027-11-22';
    const SHIFTED_PARENT_START = '2027-10-26';
    const SHIFTED_PARENT_END = '2027-11-23';

    function makeDD2ExistingTasks() {
      return [
        // DD#2 parent ("Data Delivery #2 Activities")
        {
          id: parentId,
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ text: { content: 'Data Delivery #2 Activities' }, plain_text: 'Data Delivery #2 Activities' }] },
            [ST.DATES.name]:              { id: ST.DATES.id,              type: 'date',      date: { start: SHIFTED_PARENT_START, end: SHIFTED_PARENT_END } },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-dd2-parent' }] },
          },
        },
        // Delivery task — name contains "#2", this is the task that gets
        // renamed by applyDeliveryNumbering and exposes the bug.
        {
          id: 'dd2-delivery-id',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ text: { content: 'Data Delivery #2' }, plain_text: 'Data Delivery #2' }] },
            [ST.DATES.name]:              { id: ST.DATES.id,              type: 'date',      date: { start: SHIFTED_DELIVERY_START, end: SHIFTED_DELIVERY_END } },
            [ST.PARENT_TASK.name]:        { id: ST.PARENT_TASK.id,        type: 'relation',  relation: [{ id: parentId }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-delivery' }] },
          },
        },
        // Repeat QC — no "#N" in the name, lookup already worked pre-fix.
        {
          id: 'dd2-qc-id',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ text: { content: 'Repeat QC' }, plain_text: 'Repeat QC' }] },
            [ST.DATES.name]:              { id: ST.DATES.id,              type: 'date',      date: { start: SHIFTED_QC_START, end: SHIFTED_QC_END } },
            [ST.PARENT_TASK.name]:        { id: ST.PARENT_TASK.id,        type: 'relation',  relation: [{ id: parentId }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-qc' }] },
          },
        },
      ];
    }

    function makeBlueprintFilteredLevels() {
      // Blueprint template tasks — the "#N" in the Delivery name is the placeholder
      // applyDeliveryNumbering rewrites. Parent carries its own "#N" too.
      const parentTask = {
        _templateId: 'bp-dd-parent',
        _taskName: 'Data Delivery #1 Activities',
        _templateBlockedBy: [],
      };
      const deliveryTask = {
        _templateId: 'bp-delivery',
        _taskName: 'Data Delivery #1',
        _templateParentId: 'bp-dd-parent',
        _templateBlockedBy: [],
      };
      const qcTask = {
        _templateId: 'bp-qc',
        _taskName: 'Repeat QC',
        _templateParentId: 'bp-dd-parent',
        _templateBlockedBy: [],
      };
      return {
        parentTask,
        deliveryTask,
        qcTask,
        levels: [
          { level: 0, tasks: [parentTask], isLastLevel: false },
          { level: 1, tasks: [deliveryTask, qcTask], isLastLevel: true },
        ],
      };
    }

    it('DD#3 Delivery inherits DD#2 shifted dates (even though applyDeliveryNumbering renamed #2 → #3)', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      mocks.mockClient.queryDatabase.mockResolvedValue(makeDD2ExistingTasks());
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-dd-parent' }, { id: 'bp-delivery' }, { id: 'bp-qc' }]);

      const { parentTask, deliveryTask, qcTask, levels } = makeBlueprintFilteredLevels();
      mocks.filterBlueprintSubtree.mockReturnValue(levels);

      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-dd-parent': 'prod-p3', 'bp-delivery': 'prod-d3', 'bp-qc': 'prod-q3' },
        totalCreated: 3,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'repeat-delivery', 'x-parent-task-names': 'Data Delivery' },
      );

      await handleAddTaskSet(req, res);
      await flush();

      // applyDeliveryNumbering rewrites #1 → #3 (next after #2).
      expect(deliveryTask._taskName).toBe('Data Delivery #3');

      // Core regression assertion — Delivery inherits DD#2's SHIFTED dates,
      // not blueprint-offset fallback. Pre-fix, latestDates was keyed by
      // "Data Delivery #2" but the lookup used "Data Delivery #3" → miss →
      // no override → formula fallback.
      expect(deliveryTask._overrideStartDate).toBe(SHIFTED_DELIVERY_START);
      expect(deliveryTask._overrideEndDate).toBe(SHIFTED_DELIVERY_END);

      // QC inherits too (no "#N" in name — worked pre-fix; guards against regression).
      expect(qcTask._overrideStartDate).toBe(SHIFTED_QC_START);
      expect(qcTask._overrideEndDate).toBe(SHIFTED_QC_END);

      // Parent inherits via the __parent__ special case in add-task-set.js.
      expect(parentTask._overrideStartDate).toBe(SHIFTED_PARENT_START);
      expect(parentTask._overrideEndDate).toBe(SHIFTED_PARENT_END);

      // Ordering invariant: Delivery start must come AFTER QC end (Meg Apr 16 bug
      // was Delivery-before-QC-ended). Asserted on the override values that
      // downstream create-tasks.js will write.
      expect(deliveryTask._overrideStartDate > qcTask._overrideEndDate).toBe(true);
    });

    it('falls back to formula when DD#N does not exist (e.g., first repeat creating DD#1)', async () => {
      // No existing Data Delivery tasks — resolveNextDeliveryNumber returns 1.
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-delivery' }]);

      const deliveryTask = {
        _templateId: 'bp-delivery',
        _taskName: 'Data Delivery #1',
        _templateBlockedBy: [],
      };
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [deliveryTask], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-delivery': 'prod-d1' },
        totalCreated: 1,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'repeat-delivery', 'x-parent-task-names': 'Data Delivery' },
      );

      await handleAddTaskSet(req, res);
      await flush();

      // No prior DD → no override applied → create-tasks.js uses blueprint-offset formula.
      expect(deliveryTask._overrideStartDate).toBeUndefined();
      expect(deliveryTask._overrideEndDate).toBeUndefined();
    });
  });

  it('attributes button click to source.user_id, not data.last_edited_by', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
    mocks.fetchBlueprint.mockResolvedValue([]);

    const { req, res } = makeReqRes(
      {
        source: { user_id: 'button-clicker' },
        data: {
          id: 'study-1',
          last_edited_by: { id: 'page-editor', type: 'person' },
        },
      },
      { 'x-button-type': 'elite', 'x-parent-task-names': 'Elite Tasks' },
    );

    await handleAddTaskSet(req, res);
    await flush();

    // Comment should @-mention the button clicker, not the page editor
    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeredByUserId: 'button-clicker',
        editedByBot: false,
      }),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Aborts when study has no Contract Sign Date (fail-loud, no silent
  // "today" fallback). Post-PR-D: empty date → study-page comment + abort.
  // ────────────────────────────────────────────────────────────────────
  it('aborts when study has no Contract Sign Date and posts a study-page comment', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage({ contractSignDate: null }));
    // Even if blueprint and subtree are healthy, empty date must short-circuit.
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1' }]);
    mocks.filterBlueprintSubtree.mockReturnValue([
      { level: 0, tasks: [{ _templateId: 'bp-1', _taskName: 'TLF' }], isLastLevel: true },
    ]);

    const { req, res } = makeReqRes(
      { data: { id: 'study-1' } },
      { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
    );
    await handleAddTaskSet(req, res);
    await flush();

    // Must NOT proceed into provisioning.
    expect(mocks.createStudyTasks).not.toHaveBeenCalled();

    // Study-page comment posted with the exact empty-date summary.
    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Add Task Set',
        status: 'failed',
        summary: expect.stringContaining('Contract Sign Date is empty'),
      }),
    );

    // Activity Log terminal event with failed status.
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Add Task Set',
        status: 'failed',
        summary: expect.stringContaining('Contract Sign Date is empty'),
      }),
    );

    // reportStatus fired with error.
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      expect.stringContaining('Contract Sign Date is empty'),
      expect.any(Object),
    );

    // Import Mode reset via the `finally` block.
    const disableCalls = mocks.mockClient.request.mock.calls.filter(
      (call) => call[0] === 'PATCH'
        && call[1] === '/pages/study-1'
        && call[2]?.properties?.[S.IMPORT_MODE.id]?.checkbox === false,
    );
    expect(disableCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('reports failure when no matching blueprint subtree is found', async () => {
    mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1' }]);
    mocks.filterBlueprintSubtree.mockReturnValue([]);

    const { req, res } = makeReqRes(
      { data: { id: 'study-1' } },
      { 'x-button-type': 'additional-site', 'x-parent-task-names': 'Nonexistent Task' },
    );

    await handleAddTaskSet(req, res);
    await flush();

    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      expect.stringContaining('No matching blueprint tasks'),
      expect.any(Object),
    );
    expect(mocks.createStudyTasks).not.toHaveBeenCalled();
  });

  describe('TLF intra-set blocker wiring (Meg 2a)', () => {
    it.each([
      ['tlf-only'],
      ['tlf-csr'],
      ['tlf-insights'],
      ['tlf-insights-csr'],
    ])(
      'preserves Internal Review blocker edge to Draft v1 TLF for %s',
      async (buttonType) => {
        mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
        mocks.mockClient.queryDatabase.mockResolvedValue([]);
        mocks.fetchBlueprint.mockResolvedValue([
          { id: 'bp-tlf' },
          { id: 'bp-draft-v1' },
          { id: 'bp-iir' },
        ]);
        const draftV1Child = {
          _templateId: 'bp-draft-v1',
          _taskName: 'Draft v1 TLF',
          _templateParentId: 'bp-tlf',
          _templateBlockedBy: ['bp-outside-placeholder'],
        };
        const iirChild = {
          _templateId: 'bp-iir',
          _taskName: 'Internal Review & Revisions of Draft TLF',
          _templateParentId: 'bp-tlf',
          _templateBlockedBy: ['bp-draft-v1'],
        };
        mocks.filterBlueprintSubtree.mockReturnValue([
          { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: false },
          { level: 1, tasks: [draftV1Child, iirChild], isLastLevel: true },
        ]);
        mocks.createStudyTasks.mockImplementation(async (client, levels) => {
          const flat = levels.flatMap((lvl) => lvl.tasks);
          expect(flat.find((t) => t._templateId === 'bp-draft-v1')._templateBlockedBy).toEqual([]);
          expect(flat.find((t) => t._templateId === 'bp-iir')._templateBlockedBy).toEqual(['bp-draft-v1']);
          return {
            idMapping: { 'bp-tlf': 'prod-tlf', 'bp-draft-v1': 'prod-d1', 'bp-iir': 'prod-iir' },
            totalCreated: 3,
            depTracking: [{
              templateId: 'bp-iir',
              resolvedBlockedByIds: [],
              unresolvedBlockedByTemplateIds: ['bp-draft-v1'],
            }],
            parentTracking: [],
          };
        });
        mocks.wireRemainingRelations.mockResolvedValue({
          parentsPatchedCount: 0,
          depsPatchedCount: 1,
        });

        const { req, res } = makeReqRes(
          { data: { id: 'study-1' } },
          { 'x-button-type': buttonType, 'x-parent-task-names': 'TLF' },
        );
        await handleAddTaskSet(req, res);
        await flush();

        expect(draftV1Child._templateBlockedBy).toEqual([]);
        expect(iirChild._templateBlockedBy).toEqual(['bp-draft-v1']);
      },
    );
  });

  describe('Manual Workstream / Item tag (extraTags)', () => {
    function setupTlfCreateMocks() {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }, { id: 'bp-child' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: false },
        { level: 1, tasks: [{ _templateId: 'bp-child', _taskName: 'Draft TLF' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf', 'bp-child': 'prod-child' },
        totalCreated: 2,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });
    }

    it.each([
      ['tlf-only'],
      ['tlf-csr'],
      ['tlf-insights'],
      ['tlf-insights-csr'],
    ])('passes extraTags=["Manual Workstream / Item"] for buttonType=%s', async (buttonType) => {
      setupTlfCreateMocks();

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': buttonType, 'x-parent-task-names': 'TLF' },
      );
      await handleAddTaskSet(req, res);
      await flush();

      expect(mocks.createStudyTasks).toHaveBeenCalledWith(
        mocks.mockClient,
        expect.any(Array),
        expect.objectContaining({
          extraTags: ['Manual Workstream / Item'],
        }),
      );
    });

    it('passes extraTags=[] for buttonType=additional-site', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-site' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-site', _taskName: 'New Site' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-site': 'prod-site' },
        totalCreated: 1,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'additional-site', 'x-parent-task-names': 'New Site' },
      );
      await handleAddTaskSet(req, res);
      await flush();

      expect(mocks.createStudyTasks).toHaveBeenCalledWith(
        mocks.mockClient,
        expect.any(Array),
        expect.objectContaining({ extraTags: [] }),
      );
    });

    it('passes extraTags=[] for buttonType=repeat-delivery', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-dd' }]);
      const deliveryTask = { _templateId: 'bp-dd', _taskName: 'Data Delivery #1', _templateBlockedBy: [] };
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [deliveryTask], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-dd': 'prod-dd' },
        totalCreated: 1,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'repeat-delivery', 'x-parent-task-names': 'Data Delivery' },
      );
      await handleAddTaskSet(req, res);
      await flush();

      expect(mocks.createStudyTasks).toHaveBeenCalledWith(
        mocks.mockClient,
        expect.any(Array),
        expect.objectContaining({ extraTags: [] }),
      );
    });
  });

  describe('single-leaf duplicate guard', () => {
    it('aborts and posts a comment when a single-leaf non-repeat template already exists', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      mocks.mockClient.queryDatabase.mockResolvedValue([
        {
          id: 'existing-leaf',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ plain_text: 'Final Delivery Retrieval Wrap-Up Window' }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-leaf' }] },
          },
        },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-leaf' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-leaf', _taskName: 'Final Delivery Retrieval Wrap-Up Window' }], isLastLevel: true },
      ]);

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'additional-site', 'x-parent-task-names': 'Final Delivery Retrieval Wrap-Up Window' },
      );
      await handleAddTaskSet(req, res);
      await flush();

      // Guard fires — no creation.
      expect(mocks.createStudyTasks).not.toHaveBeenCalled();

      // Comment mentions the existing task's name.
      expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: 'Add Task Set',
          status: 'failed',
          summary: expect.stringContaining("'Final Delivery Retrieval Wrap-Up Window'"),
        }),
      );

      // Activity Log terminal event.
      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: 'Add Task Set',
          status: 'failed',
          summary: expect.stringContaining('already exists'),
        }),
      );

      // reportStatus fired with error.
      expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
        'study-1',
        'error',
        expect.stringContaining('already exists'),
        expect.any(Object),
      );

      // Import Mode reset via the `finally` block.
      const disableCalls = mocks.mockClient.request.mock.calls.filter(
        (call) => call[0] === 'PATCH'
          && call[1] === '/pages/study-1'
          && call[2]?.properties?.[S.IMPORT_MODE.id]?.checkbox === false,
      );
      expect(disableCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT fire on single-leaf non-repeat when the template is not yet in the study', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      // No existing tasks with matching TSID — guard must not fire.
      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-leaf' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-leaf', _taskName: 'Wrap-Up Window' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-leaf': 'prod-leaf-1' },
        totalCreated: 1,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'additional-site', 'x-parent-task-names': 'Wrap-Up Window' },
      );
      await handleAddTaskSet(req, res);
      await flush();

      // Normal flow runs.
      expect(mocks.createStudyTasks).toHaveBeenCalled();
      // No duplicate-guard comment posted on the happy path (errors-only behavior).
      expect(mocks.studyCommentService.postComment).not.toHaveBeenCalledWith(
        expect.objectContaining({ summary: expect.stringContaining('already exists') }),
      );
    });

    it('does NOT fire on repeat-delivery even when the blueprint slot maps to an existing task', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      // Existing Data Delivery #1 with matching TSID — repeat-delivery must
      // still proceed because its flow is "always create the next one."
      mocks.mockClient.queryDatabase.mockResolvedValue([
        {
          id: 'existing-dd1',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ plain_text: 'Data Delivery #1 — Review' }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-dd' }] },
          },
        },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-dd' }]);
      const deliveryTask = { _templateId: 'bp-dd', _taskName: 'Data Delivery #1', _templateBlockedBy: [] };
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [deliveryTask], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-dd': 'prod-dd-2' },
        totalCreated: 1,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'repeat-delivery', 'x-parent-task-names': 'Data Delivery' },
      );
      await handleAddTaskSet(req, res);
      await flush();

      // Repeat-delivery proceeds — creation happens, numbering bumps to #2.
      expect(mocks.createStudyTasks).toHaveBeenCalled();
      expect(deliveryTask._taskName).toBe('Data Delivery #2');
    });

    it('does NOT fire on multi-task (numbered) subtrees even when one template matches', async () => {
      mocks.mockClient.getPage.mockResolvedValue(mockStudyPage());
      // Existing TLF#1 exists. New TLF#2 subtree has multiple tasks →
      // isSingleLeaf is false → guard skipped, strip-before-create runs.
      mocks.mockClient.queryDatabase.mockResolvedValue([
        {
          id: 'existing-tlf-1',
          properties: {
            [ST.TASK_NAME.name]:          { id: ST.TASK_NAME.id,          type: 'title',     title: [{ plain_text: 'TLF' }] },
            [ST.TEMPLATE_SOURCE_ID.name]: { id: ST.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: 'bp-tlf' }] },
          },
        },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }, { id: 'bp-child' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: false },
        { level: 1, tasks: [{ _templateId: 'bp-child', _taskName: 'Draft TLF' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf-2', 'bp-child': 'prod-child-2' },
        totalCreated: 2,
        depTracking: [],
        parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({
        parentsPatchedCount: 0,
        depsPatchedCount: 0,
      });

      const { req, res } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
      );
      await handleAddTaskSet(req, res);
      await flush();

      // Full numbered-set flow runs; guard did not abort.
      expect(mocks.createStudyTasks).toHaveBeenCalled();
    });
  });

  describe('per-study serialization', () => {
    it('serializes concurrent calls for the same study', async () => {
      const order = [];
      let resolveFirst;
      const firstGate = new Promise(r => { resolveFirst = r; });

      // First call blocks on getPage until we release it
      mocks.mockClient.getPage
        .mockImplementationOnce(async () => {
          order.push('call-1-start');
          await firstGate;
          order.push('call-1-end');
          return mockStudyPage();
        })
        .mockImplementationOnce(async () => {
          order.push('call-2-start');
          return mockStudyPage();
        });

      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([]);

      const { req: req1, res: res1 } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
      );
      const { req: req2, res: res2 } = makeReqRes(
        { data: { id: 'study-1' } },
        { 'x-button-type': 'tlf-csr', 'x-parent-task-names': 'TLF' },
      );

      // Fire both concurrently
      await handleAddTaskSet(req1, res1);
      await handleAddTaskSet(req2, res2);

      // Only call 1 should have started — call 2 is queued behind the lock
      await flush();
      expect(order).toEqual(['call-1-start']);

      // Release call 1
      resolveFirst();
      await flush(40);

      // Call 2 should start only after call 1 finished
      expect(order).toEqual(['call-1-start', 'call-1-end', 'call-2-start']);
    });

    it('allows concurrent calls for different studies', async () => {
      const order = [];
      let resolveFirst;
      const firstGate = new Promise(r => { resolveFirst = r; });

      mocks.mockClient.getPage
        .mockImplementationOnce(async () => {
          order.push('study-A-start');
          await firstGate;
          order.push('study-A-end');
          return mockStudyPage();
        })
        .mockImplementationOnce(async () => {
          order.push('study-B-start');
          return mockStudyPage();
        });

      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([]);

      const { req: reqA, res: resA } = makeReqRes(
        { data: { id: 'study-A' } },
        { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
      );
      const { req: reqB, res: resB } = makeReqRes(
        { data: { id: 'study-B' } },
        { 'x-button-type': 'tlf-only', 'x-parent-task-names': 'TLF' },
      );

      await handleAddTaskSet(reqA, resA);
      await handleAddTaskSet(reqB, resB);
      await flush();

      // Both should have started — different studies don't block each other
      expect(order).toContain('study-A-start');
      expect(order).toContain('study-B-start');

      resolveFirst();
      await flush(40);
    });
  });
});
