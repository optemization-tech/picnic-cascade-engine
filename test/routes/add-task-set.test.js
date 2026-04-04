import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    getPage: vi.fn(),
    queryDatabase: vi.fn(),
    reportStatus: vi.fn(),
    request: vi.fn(),
  },
  fetchBlueprint: vi.fn(),
  buildTaskTree: vi.fn(),
  filterBlueprintSubtree: vi.fn(),
  createStudyTasks: vi.fn(),
  wireRemainingRelations: vi.fn(),
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

vi.mock('../../src/notion/client.js', () => ({
  NotionClient: vi.fn(() => mocks.mockClient),
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
  let savedFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    savedFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true, pageId: 'page-1' });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.request.mockResolvedValue({});
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
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

    // Fires copy-blocks self-POST
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/webhook/copy-blocks',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('prod-1'),
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
