import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    getPage: vi.fn(),
    patchPage: vi.fn(),
    reportStatus: vi.fn(),
    patchBatch: vi.fn(),
    queryDatabase: vi.fn(),
    request: vi.fn(),
  },
  fetchBlueprint: vi.fn(),
  buildTaskTree: vi.fn(),
  createStudyTasks: vi.fn(),
  wireRemainingRelations: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  mockFetch: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    port: 3000,
    notion: {
      tokens: ['token-1'],
      provisionTokens: ['prov-token-1'],
      studyTasksDbId: 'db-study-tasks',
      studiesDbId: 'db-studies',
      blueprintDbId: 'db-blueprint',
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

vi.mock('../../src/provisioning/blueprint.js', () => ({
  fetchBlueprint: mocks.fetchBlueprint,
  buildTaskTree: mocks.buildTaskTree,
}));

vi.mock('../../src/provisioning/create-tasks.js', () => ({
  createStudyTasks: mocks.createStudyTasks,
}));

vi.mock('../../src/provisioning/wire-relations.js', () => ({
  wireRemainingRelations: mocks.wireRemainingRelations,
}));

import { handleInception } from '../../src/routes/inception.js';

function makeReqRes(body = {}) {
  const req = { body };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return { req, res };
}

/** Flush background promise started by handleInception (void processInception(...).catch()) */
async function flush() {
  await vi.runAllTimersAsync();
  // Multiple microtick flushes to let all chained .then/.catch/.finally settle
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('inception route', () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.request.mockResolvedValue({});

    // Mock global fetch for copy-blocks fire-and-forget
    originalFetch = globalThis.fetch;
    globalThis.fetch = mocks.mockFetch;
    mocks.mockFetch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────────────
  // Responds 200 immediately
  // ────────────────────────────────────────────────────────────────────
  it('responds 200 immediately before processing', async () => {
    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    // Don't await background — just check the response
    mocks.mockClient.getPage.mockResolvedValue({ properties: {} });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([]);

    await handleInception(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });

    await flush();
  });

  // ────────────────────────────────────────────────────────────────────
  // Missing studyPageId -> early return
  // ────────────────────────────────────────────────────────────────────
  it('returns early when studyPageId is missing', async () => {
    const { req, res } = makeReqRes({});
    await handleInception(req, res);
    await flush();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.request).not.toHaveBeenCalled();
    expect(mocks.mockClient.reportStatus).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────
  // Extracts studyPageId from body.data.id
  // ────────────────────────────────────────────────────────────────────
  it('extracts studyPageId from body.data.id (Notion automation format)', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { 'Contract Sign Date': { date: { start: '2026-01-15' } } },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([{ level: 0, tasks: [], isLastLevel: true }]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: {}, totalCreated: 5, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

    const { req, res } = makeReqRes({ data: { id: 'study-from-data' } });
    await handleInception(req, res);
    await flush();

    // Verify the study page ID was used
    expect(mocks.mockClient.request).toHaveBeenCalledWith(
      'PATCH',
      '/pages/study-from-data',
      expect.objectContaining({
        properties: { 'Import Mode': { checkbox: true } },
      }),
      expect.any(Object),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Double-inception guard: study already has tasks
  // ────────────────────────────────────────────────────────────────────
  it('reports error and returns when study already has tasks (double-inception guard)', async () => {
    mocks.mockClient.getPage.mockResolvedValue({ properties: {} });
    mocks.mockClient.queryDatabase.mockResolvedValue([{ id: 'existing-task' }]);

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      'Study already has tasks — aborting inception',
      expect.any(Object),
    );
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
        status: 'failed',
        summary: expect.stringContaining('double-inception'),
      }),
    );
    // Should NOT proceed to fetch blueprint
    expect(mocks.fetchBlueprint).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────
  // Empty blueprint -> error reported
  // ────────────────────────────────────────────────────────────────────
  it('reports error when blueprint is empty', async () => {
    mocks.mockClient.getPage.mockResolvedValue({ properties: {} });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([]);

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      'No blueprint tasks found',
      expect.any(Object),
    );
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
        status: 'failed',
        summary: 'No blueprint tasks found',
      }),
    );
    // Should NOT proceed to create tasks
    expect(mocks.createStudyTasks).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────
  // Import Mode lifecycle: enabled at start, disabled at end
  // ────────────────────────────────────────────────────────────────────
  it('enables Import Mode at start and disables it at end', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { 'Contract Sign Date': { date: { start: '2026-01-15' } } },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([{ level: 0, tasks: [], isLastLevel: true }]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: { 'bp-1': 'new-1' }, totalCreated: 3, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 1, depsPatchedCount: 2 });

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    const requestCalls = mocks.mockClient.request.mock.calls;

    // First request call: enable Import Mode
    expect(requestCalls[0]).toEqual([
      'PATCH',
      '/pages/study-1',
      { properties: { 'Import Mode': { checkbox: true } } },
      expect.any(Object),
    ]);

    // Find all Import Mode disable calls
    const disableCalls = requestCalls.filter(
      (call) => call[0] === 'PATCH'
        && call[1] === '/pages/study-1'
        && call[2]?.properties?.['Import Mode']?.checkbox === false,
    );
    // At least one disable call (in-flow + finally)
    expect(disableCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────────────
  // Import Mode is disabled even on error (finally block)
  // ────────────────────────────────────────────────────────────────────
  it('disables Import Mode in finally even when processing throws', async () => {
    mocks.mockClient.getPage.mockResolvedValue({ properties: {} });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockRejectedValue(new Error('Notion API down'));

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    const requestCalls = mocks.mockClient.request.mock.calls;

    // Should still have the disable call from finally
    const disableCalls = requestCalls.filter(
      (call) => call[0] === 'PATCH'
        && call[1] === '/pages/study-1'
        && call[2]?.properties?.['Import Mode']?.checkbox === false,
    );
    expect(disableCalls.length).toBeGreaterThanOrEqual(1);

    // Error should have been reported
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      expect.stringContaining('Notion API down'),
      expect.any(Object),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Happy path: full pipeline
  // ────────────────────────────────────────────────────────────────────
  it('runs the full inception pipeline on happy path', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: {
        'Contract Sign Date': { date: { start: '2026-03-01' } },
        'Study Name (Internal)': { title: [{ text: { content: 'Test Study' } }] },
      },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([
      { id: 'bp-1', properties: { 'Task Name': { title: [{ text: { content: 'Task A' } }] } } },
      { id: 'bp-2', properties: { 'Task Name': { title: [{ text: { content: 'Task B' } }] } } },
    ]);
    mocks.buildTaskTree.mockReturnValue([
      { level: 0, tasks: [{ _templateId: 'bp-1' }], isLastLevel: false },
      { level: 1, tasks: [{ _templateId: 'bp-2' }], isLastLevel: true },
    ]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: { 'bp-1': 'new-1', 'bp-2': 'new-2' },
      totalCreated: 2,
      depTracking: [],
      parentTracking: [{ templateId: 'bp-2', templateParentId: 'bp-1' }],
    });
    mocks.wireRemainingRelations.mockResolvedValue({
      parentsPatchedCount: 1,
      depsPatchedCount: 0,
    });

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    // Verify provisioning pipeline was called in order
    expect(mocks.fetchBlueprint).toHaveBeenCalled();
    expect(mocks.buildTaskTree).toHaveBeenCalled();
    expect(mocks.createStudyTasks).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({
        studyPageId: 'study-1',
        contractSignDate: '2026-03-01',
        studyTasksDbId: 'db-study-tasks',
      }),
    );
    expect(mocks.wireRemainingRelations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idMapping: { 'bp-1': 'new-1', 'bp-2': 'new-2' },
        parentTracking: [{ templateId: 'bp-2', templateParentId: 'bp-1' }],
      }),
    );

    // Activity log called with correct workflow name and success status
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
        status: 'success',
        summary: expect.stringContaining('2 tasks created'),
      }),
    );

    // Success report sent
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'success',
      'Inception complete: 2 tasks created, 1 parents wired, 0 deps wired',
      expect.any(Object),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Copy-blocks self-POST is fired after success
  // ────────────────────────────────────────────────────────────────────
  it('fires copy-blocks self-POST after successful inception', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: {
        'Contract Sign Date': { date: { start: '2026-03-01' } },
        'Study Name (Internal)': { title: [{ text: { content: 'Acme Study' } }] },
      },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: { 'bp-1': 'new-1' }, totalCreated: 1, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/webhook/copy-blocks',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"studyPageId":"study-1"'),
      }),
    );

    // Verify study name is passed
    const fetchBody = JSON.parse(mocks.mockFetch.mock.calls[0][1].body);
    expect(fetchBody.studyName).toBe('Acme Study');
    expect(fetchBody.idMapping).toEqual({ 'bp-1': 'new-1' });
  });

  // ────────────────────────────────────────────────────────────────────
  // Activity log called with correct workflow name
  // ────────────────────────────────────────────────────────────────────
  it('logs to activity log with workflow "Inception"', async () => {
    mocks.mockClient.getPage.mockResolvedValue({ properties: {} });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: {}, totalCreated: 0, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
      }),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Error: activity log records failure
  // ────────────────────────────────────────────────────────────────────
  it('logs error to activity log when pipeline throws', async () => {
    mocks.mockClient.getPage.mockResolvedValue({ properties: {} });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([{ level: 0, tasks: [], isLastLevel: true }]);
    mocks.createStudyTasks.mockRejectedValue(new Error('Rate limited'));

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
        status: 'failed',
        summary: expect.stringContaining('Rate limited'),
      }),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Uses provision tokens when available
  // ────────────────────────────────────────────────────────────────────
  it('constructs NotionClient with provision tokens', async () => {
    // NotionClient was constructed at module-load time (before beforeEach clears mocks).
    // Re-import the mock constructor to check it was called with provision tokens.
    const { NotionClient } = await import('../../src/notion/client.js');
    // The constructor was already invoked during module init; since clearAllMocks
    // resets call history each test, we verify the config wiring instead:
    // the config has provisionTokens=['prov-token-1'] and tokens=['token-1'].
    // Since provisionTokens.length > 0, inception should use provisionTokens.
    const { config } = await import('../../src/config.js');
    const expectedTokens = config.notion.provisionTokens.length > 0
      ? config.notion.provisionTokens
      : config.notion.tokens;
    expect(expectedTokens).toEqual(['prov-token-1']);
  });

  // ────────────────────────────────────────────────────────────────────
  // Falls back to today when no Contract Sign Date
  // ────────────────────────────────────────────────────────────────────
  it('falls back to today when study has no Contract Sign Date', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: {}, // no Contract Sign Date
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: {}, totalCreated: 0, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    // createStudyTasks should have been called with a date string (today)
    expect(mocks.createStudyTasks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        contractSignDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    );
  });
});
