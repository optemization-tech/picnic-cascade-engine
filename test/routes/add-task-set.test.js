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

import { handleAddTaskSet } from '../../src/routes/add-task-set.js';

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
      'Import Mode': { checkbox: importMode },
      'Contract Sign Date': { date: { start: contractSignDate } },
      'Study Name (Internal)': { title: [{ text: { content: 'Test Study' } }] },
    },
  };
}

describe('add-task-set route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.copyBlocks.mockResolvedValue({ blocksWrittenCount: 0, pagesProcessed: 0, pagesSkipped: 0 });
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true, pageId: 'page-1' });
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
      { properties: { 'Task Name': { title: [{ text: { content: 'Data Delivery #1 — Review' } }] } } },
      { properties: { 'Task Name': { title: [{ text: { content: 'Data Delivery #2 — Review' } }] } } },
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
      { id: 'bp-1', properties: { 'Task Name': { title: [{ text: { content: 'Parent Task' } }] } } },
      { id: 'bp-2', properties: { 'Task Name': { title: [{ text: { content: 'Child Task' } }] } } },
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
      body?.properties?.['Import Mode']?.checkbox === false,
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
            'Task Name': { title: [{ text: { content: 'TLF' } }] },
            'Template Source ID': { rich_text: [{ plain_text: 'bp-tlf' }] },
          },
        },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf-2' },
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

      // Should rename to TLF #2 (1 existing + 1 = 2)
      expect(mocks.mockClient.patchPages).toHaveBeenCalledWith(
        [expect.objectContaining({
          taskId: 'prod-tlf-2',
          properties: {
            'Task Name': { title: [{ type: 'text', text: { content: 'TLF #2' } }] },
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
            'Task Name': { title: [{ type: 'text', text: { content: 'TLF #1' } }] },
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
            'Task Name': { title: [{ text: { content: 'TLF' } }] },
            'Template Source ID': { rich_text: [{ plain_text: 'bp-tlf' }] },
          },
        },
        {
          id: 'existing-tlf-2',
          properties: {
            'Task Name': { title: [{ text: { content: 'TLF #2' } }] },
            'Template Source ID': { rich_text: [{ plain_text: 'bp-tlf' }] },
          },
        },
        {
          id: 'existing-csr-1',
          properties: {
            'Task Name': { title: [{ text: { content: 'CSR' } }] },
            'Template Source ID': { rich_text: [{ plain_text: 'bp-csr' }] },
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
              'Task Name': { title: [{ type: 'text', text: { content: 'TLF #3' } }] },
            },
          }),
          expect.objectContaining({
            taskId: 'prod-csr-2',
            properties: {
              'Task Name': { title: [{ type: 'text', text: { content: 'CSR #2' } }] },
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
            'Task Name': { title: [{ text: { content: 'TLF' } }] },
            'Template Source ID': { rich_text: [{ text: { content: 'bp-tlf' } }] },
          },
        },
      ]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-tlf' }]);
      mocks.filterBlueprintSubtree.mockReturnValue([
        { level: 0, tasks: [{ _templateId: 'bp-tlf', _taskName: 'TLF' }], isLastLevel: true },
      ]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: { 'bp-tlf': 'prod-tlf-2' },
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

      // Should still count correctly via text.content fallback → TLF #2
      expect(mocks.mockClient.patchPages).toHaveBeenCalledWith(
        [expect.objectContaining({
          taskId: 'prod-tlf-2',
          properties: {
            'Task Name': { title: [{ type: 'text', text: { content: 'TLF #2' } }] },
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
        { properties: { 'Task Name': { title: [{ text: { content: 'Data Delivery #1 — Review' } }] } } },
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
});
