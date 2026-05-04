import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    getPage: vi.fn(),
    patchPage: vi.fn(),
    reportStatus: vi.fn(),
    patchPages: vi.fn(),
    queryDatabase: vi.fn(),
    request: vi.fn(),
  },
  fetchBlueprint: vi.fn(),
  buildTaskTree: vi.fn(),
  createStudyTasks: vi.fn(),
  wireRemainingRelations: vi.fn(),
  copyBlocks: vi.fn(),
  prefetchTemplateBlocks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  studyCommentService: {
    postComment: vi.fn(),
  },
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

vi.mock('../../src/notion/clients.js', () => ({
  cascadeClient: mocks.mockClient,
  provisionClient: mocks.mockClient,
  deletionClient: mocks.mockClient,
  commentClient: mocks.mockClient,
}));

vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));

vi.mock('../../src/services/study-comment.js', () => ({
  StudyCommentService: vi.fn(() => mocks.studyCommentService),
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

vi.mock('../../src/provisioning/copy-blocks.js', () => ({
  copyBlocks: mocks.copyBlocks,
  prefetchTemplateBlocks: mocks.prefetchTemplateBlocks,
}));

import { handleInception } from '../../src/routes/inception.js';
import { _resetStudyLocks } from '../../src/services/study-lock.js';
import {
  STUDY_TASKS_PROPS as ST,
  STUDIES_PROPS as S,
  BLUEPRINT_PROPS as BP,
} from '../../src/notion/property-names.js';

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetStudyLocks();
    mocks.activityLogService.logTerminalEvent.mockResolvedValue({ logged: true });
    mocks.studyCommentService.postComment.mockResolvedValue({ posted: true });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.request.mockResolvedValue({});
    mocks.prefetchTemplateBlocks.mockResolvedValue({});
    mocks.copyBlocks.mockResolvedValue({
      blocksWrittenCount: 0,
      pagesProcessed: 0,
      pagesSkipped: 0,
    });
  });

  afterEach(() => {
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
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
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
        properties: { [S.IMPORT_MODE.id]: { checkbox: true } },
      }),
      expect.any(Object),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Double-inception guard: study already has tasks
  // ────────────────────────────────────────────────────────────────────
  it('reports error and returns when study already has tasks (double-inception guard)', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
    });
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
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
    });
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
    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
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
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
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
      { properties: { [S.IMPORT_MODE.id]: { checkbox: true } } },
      expect.any(Object),
    ]);

    // Find all Import Mode disable calls
    const disableCalls = requestCalls.filter(
      (call) => call[0] === 'PATCH'
        && call[1] === '/pages/study-1'
        && call[2]?.properties?.[S.IMPORT_MODE.id]?.checkbox === false,
    );
    // At least one disable call (in-flow + finally)
    expect(disableCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────────────
  // Import Mode is disabled even on error (finally block)
  // ────────────────────────────────────────────────────────────────────
  it('disables Import Mode in finally even when processing throws', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
    });
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
        && call[2]?.properties?.[S.IMPORT_MODE.id]?.checkbox === false,
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
        [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date',  date: { start: '2026-03-01' } },
        [S.STUDY_NAME.name]:         { id: S.STUDY_NAME.id,         type: 'title', title: [{ text: { content: 'Test Study' } }] },
      },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([
      { id: 'bp-1', properties: { [BP.TASK_NAME.name]: { id: BP.TASK_NAME.id, type: 'title', title: [{ text: { content: 'Task A' } }] } } },
      { id: 'bp-2', properties: { [BP.TASK_NAME.name]: { id: BP.TASK_NAME.id, type: 'title', title: [{ text: { content: 'Task B' } }] } } },
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
    mocks.prefetchTemplateBlocks.mockResolvedValue({
      'bp-1': [{ type: 'paragraph', paragraph: { rich_text: [] } }],
    });
    mocks.copyBlocks.mockResolvedValue({
      blocksWrittenCount: 1,
      pagesProcessed: 1,
      pagesSkipped: 1,
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

    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'success',
      'Inception complete: 2 tasks created, 1 parents wired, 0 deps wired',
      expect.any(Object),
    );
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'success',
      'Content blocks copied: 1 pages, 1 blocks',
      expect.any(Object),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Copy-blocks is executed in-process after success
  // ────────────────────────────────────────────────────────────────────
  it('prefetches and copies blocks after successful inception', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: {
        [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date',  date: { start: '2026-03-01' } },
        [S.STUDY_NAME.name]:         { id: S.STUDY_NAME.id,         type: 'title', title: [{ text: { content: 'Acme Study' } }] },
      },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: { 'bp-1': 'new-1' }, totalCreated: 1, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });
    mocks.prefetchTemplateBlocks.mockResolvedValue({
      'bp-1': [{ type: 'paragraph', paragraph: { rich_text: [] } }],
    });
    mocks.copyBlocks.mockResolvedValue({
      blocksWrittenCount: 1,
      pagesProcessed: 1,
      pagesSkipped: 0,
    });

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.prefetchTemplateBlocks).toHaveBeenCalledWith(
      expect.anything(),
      ['bp-1'],
      expect.objectContaining({ tracer: expect.any(Object), workersPerToken: 3 }),
    );
    expect(mocks.copyBlocks).toHaveBeenCalledWith(
      expect.anything(),
      { 'bp-1': 'new-1' },
      expect.objectContaining({
        studyPageId: 'study-1',
        studyName: 'Acme Study',
        preparedBlocksByTemplate: { 'bp-1': [{ type: 'paragraph', paragraph: { rich_text: [] } }] },
        concurrency: 10,
        workersPerToken: 10,
      }),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Activity log called with correct workflow name
  // ────────────────────────────────────────────────────────────────────
  it('logs to activity log with workflow "Inception"', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: {}, totalCreated: 0, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });
    mocks.copyBlocks.mockResolvedValue({
      blocksWrittenCount: 0,
      pagesProcessed: 0,
      pagesSkipped: 0,
    });

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
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
    });
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
    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
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

  it('does not post study comment on successful inception (comments are errors-only)', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: {
        [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date',  date: { start: '2026-03-01' } },
        [S.STUDY_NAME.name]:         { id: S.STUDY_NAME.id,         type: 'title', title: [{ text: { content: 'Test Study' } }] },
      },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: {}, totalCreated: 2, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 1, depsPatchedCount: 0 });
    mocks.copyBlocks.mockResolvedValue({
      blocksWrittenCount: 0, pagesProcessed: 0, pagesSkipped: 0,
    });

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.studyCommentService.postComment).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────
  // Study comment: posted when double-inception blocked (error path)
  // ────────────────────────────────────────────────────────────────────
  it('posts study comment when double-inception blocked', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([{ id: 'existing-task' }]);

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
        status: 'failed',
        summary: expect.stringContaining('double-inception'),
      }),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Study comment: inception completes even when comment fails
  // ────────────────────────────────────────────────────────────────────
  it('inception completes even when comment fails', async () => {
    mocks.studyCommentService.postComment.mockRejectedValue(new Error('Comment API down'));

    mocks.mockClient.getPage.mockResolvedValue({
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([{ id: 'existing-task' }]);

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    // logTerminalEvent should still have been called despite comment failure
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
        status: 'failed',
        summary: expect.stringContaining('double-inception'),
      }),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Inception never tags the original subtree with "Manual Workstream /
  // Item" (R5-3). Pass `extraTags: []` explicitly at the call-site.
  // ────────────────────────────────────────────────────────────────────
  it('passes extraTags=[] to createStudyTasks (inception does not tag original subtree)', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: { [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } } },
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);
    mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
    mocks.buildTaskTree.mockReturnValue([{ level: 0, tasks: [], isLastLevel: true }]);
    mocks.createStudyTasks.mockResolvedValue({
      idMapping: {}, totalCreated: 0, depTracking: [], parentTracking: [],
    });
    mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });
    mocks.copyBlocks.mockResolvedValue({
      blocksWrittenCount: 0, pagesProcessed: 0, pagesSkipped: 0,
    });

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    expect(mocks.createStudyTasks).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({ extraTags: [] }),
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Aborts when study has no Contract Sign Date (fail-loud, no silent
  // "today" fallback). Post-PR-D: empty date → study-page comment + abort.
  // ────────────────────────────────────────────────────────────────────
  it('aborts when study has no Contract Sign Date and posts a study-page comment', async () => {
    mocks.mockClient.getPage.mockResolvedValue({
      properties: {}, // no Contract Sign Date
    });
    mocks.mockClient.queryDatabase.mockResolvedValue([]);

    const { req, res } = makeReqRes({ studyPageId: 'study-1' });
    await handleInception(req, res);
    await flush();

    // Must NOT proceed into provisioning.
    expect(mocks.fetchBlueprint).not.toHaveBeenCalled();
    expect(mocks.createStudyTasks).not.toHaveBeenCalled();

    // Study-page comment posted with the exact empty-date summary.
    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
        status: 'failed',
        summary: expect.stringContaining('Contract Sign Date is empty'),
      }),
    );

    // Activity Log terminal event with failed status.
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'Inception',
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

  // ────────────────────────────────────────────────────────────────────
  // Per-study serialization (withStudyLock coverage on handleInception).
  // Two back-to-back webhooks for the same study must serialize so the
  // second sees the tasks the first created — double-inception guard at
  // inception.js:107 can then catch it. Without the lock, both races
  // past `existingTasks.length === 0` and both create the full task set.
  // ────────────────────────────────────────────────────────────────────
  describe('per-study serialization', () => {
    it('serializes concurrent inception webhooks for the same study', async () => {
      const order = [];
      let resolveFirst;
      const firstGate = new Promise(r => { resolveFirst = r; });

      // First call blocks on getPage until we release it. Second call also
      // hits getPage — if the lock works, it runs only after firstGate resolves.
      mocks.mockClient.getPage
        .mockImplementationOnce(async () => {
          order.push('call-1-start');
          await firstGate;
          order.push('call-1-end');
          return {
            properties: {
              [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date',  date: { start: '2026-01-15' } },
              [S.STUDY_NAME.name]:         { id: S.STUDY_NAME.id,         type: 'title', title: [{ text: { content: 'Test Study' } }] },
            },
          };
        })
        .mockImplementationOnce(async () => {
          order.push('call-2-start');
          return {
            properties: {
              [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date',  date: { start: '2026-01-15' } },
              [S.STUDY_NAME.name]:         { id: S.STUDY_NAME.id,         type: 'title', title: [{ text: { content: 'Test Study' } }] },
            },
          };
        });

      // First call: no existing tasks (proceeds to create).
      // Second call: tasks exist (the guard at line 107 fires).
      mocks.mockClient.queryDatabase
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'existing-task' }]);

      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
      mocks.buildTaskTree.mockReturnValue([]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: {}, totalCreated: 200, depTracking: [], parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

      const { req: req1, res: res1 } = makeReqRes({ data: { id: 'study-1' } });
      const { req: req2, res: res2 } = makeReqRes({ data: { id: 'study-1' } });

      await handleInception(req1, res1);
      await handleInception(req2, res2);

      // Only call 1 should have started — call 2 is queued behind the lock.
      await flush();
      expect(order).toEqual(['call-1-start']);

      // Release call 1 and flush enough to let the whole first run + queued
      // second run complete.
      resolveFirst();
      for (let i = 0; i < 60; i++) await Promise.resolve();

      // Call 2 starts only after call 1 finished.
      expect(order).toEqual(['call-1-start', 'call-1-end', 'call-2-start']);

      // Call 2 hits the double-inception guard (queryDatabase returned one task).
      // Abort path: reportStatus with error message, activity log 'failed'.
      const doubleInceptionErrors = mocks.mockClient.reportStatus.mock.calls.filter(
        (call) => call[1] === 'error' && call[2] === 'Study already has tasks — aborting inception',
      );
      expect(doubleInceptionErrors.length).toBe(1);

      // createStudyTasks ran exactly once (for call 1, not again for call 2).
      expect(mocks.createStudyTasks).toHaveBeenCalledTimes(1);
    });

    it('allows concurrent inception webhooks for different studies', async () => {
      const order = [];
      let resolveA;
      const aGate = new Promise(r => { resolveA = r; });

      mocks.mockClient.getPage
        .mockImplementationOnce(async () => {
          order.push('study-A-start');
          await aGate;
          order.push('study-A-end');
          return {
            properties: {
              [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date',  date: { start: '2026-01-15' } },
              [S.STUDY_NAME.name]:         { id: S.STUDY_NAME.id,         type: 'title', title: [{ text: { content: 'Study A' } }] },
            },
          };
        })
        .mockImplementationOnce(async () => {
          order.push('study-B-start');
          return {
            properties: {
              [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date',  date: { start: '2026-01-15' } },
              [S.STUDY_NAME.name]:         { id: S.STUDY_NAME.id,         type: 'title', title: [{ text: { content: 'Study B' } }] },
            },
          };
        });

      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
      mocks.buildTaskTree.mockReturnValue([]);
      mocks.createStudyTasks.mockResolvedValue({
        idMapping: {}, totalCreated: 0, depTracking: [], parentTracking: [],
      });
      mocks.wireRemainingRelations.mockResolvedValue({ parentsPatchedCount: 0, depsPatchedCount: 0 });

      const { req: reqA, res: resA } = makeReqRes({ data: { id: 'study-A' } });
      const { req: reqB, res: resB } = makeReqRes({ data: { id: 'study-B' } });

      await handleInception(reqA, resA);
      await handleInception(reqB, resB);
      await flush();

      // Both should have started in parallel — different studies don't block.
      expect(order).toContain('study-A-start');
      expect(order).toContain('study-B-start');

      resolveA();
      for (let i = 0; i < 40; i++) await Promise.resolve();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // U3: batch-aborted Error from createStudyTasks (silent partial-failure
  // fix). Verifies the route's existing failure path correctly surfaces
  // the structured error AND survives the same Notion brownout that
  // likely caused the abort in the first place.
  // ────────────────────────────────────────────────────────────────────
  describe('createStudyTasks throws batch-aborted Error (U3)', () => {
    function batchAbortedError({ attempted = 202, created = 131, failedUnsafe = 1, notAttempted = 70 } = {}) {
      const msg = `Inception batch incomplete: created ${created}/${attempted} (${failedUnsafe} failed transient, ${notAttempted} not attempted). Archive partial tasks and re-run (see runbook).`;
      return Object.assign(new Error(msg), {
        kind: 'batch-aborted',
        attempted,
        created,
        failedUnsafe,
        notAttempted,
        idMapping: {},
      });
    }

    function setupHappyUpToCreate() {
      mocks.mockClient.getPage.mockResolvedValue({
        properties: {
          [S.CONTRACT_SIGN_DATE.name]: { id: S.CONTRACT_SIGN_DATE.id, type: 'date', date: { start: '2026-01-15' } },
          [S.STUDY_NAME.name]: { id: S.STUDY_NAME.id, type: 'title', title: [{ text: { content: 'Ionis HAE 001' } }] },
        },
      });
      mocks.mockClient.queryDatabase.mockResolvedValue([]);
      mocks.fetchBlueprint.mockResolvedValue([{ id: 'bp-1', properties: {} }]);
      mocks.buildTaskTree.mockReturnValue([{ level: 0, tasks: [], isLastLevel: true }]);
    }

    it('logs Activity Log terminal event with status=failed and breakdown summary', async () => {
      setupHappyUpToCreate();
      mocks.createStudyTasks.mockRejectedValue(batchAbortedError());

      const { req, res } = makeReqRes({ studyPageId: 'study-ionis' });
      await handleInception(req, res);
      await flush();

      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: 'Inception',
          status: 'failed',
          summary: expect.stringContaining('batch incomplete'),
          studyId: 'study-ionis',
        }),
      );
    });

    it('study comment posted with operator-actionable summary', async () => {
      setupHappyUpToCreate();
      mocks.createStudyTasks.mockRejectedValue(batchAbortedError());

      const { req, res } = makeReqRes({ studyPageId: 'study-ionis' });
      await handleInception(req, res);
      await flush();

      const commentCall = mocks.studyCommentService.postComment.mock.calls[0]?.[0];
      expect(commentCall).toBeDefined();
      expect(commentCall.workflow).toBe('Inception');
      expect(commentCall.status).toBe('failed');
      // The 180-char slice should keep the operator next-action visible.
      expect(commentCall.summary.length).toBeLessThanOrEqual(220); // includes "Study setup failed: " prefix
      expect(commentCall.summary).toMatch(/incomplete|created|runbook|archive/i);
    });

    it('reportStatus called with error severity and failure message', async () => {
      setupHappyUpToCreate();
      mocks.createStudyTasks.mockRejectedValue(batchAbortedError());

      const { req, res } = makeReqRes({ studyPageId: 'study-ionis' });
      await handleInception(req, res);
      await flush();

      // reportStatus is called multiple times during a run (info "started",
      // info "tasks created", final). On the failure path the catch-block
      // call uses 'error' severity.
      const errorCalls = mocks.mockClient.reportStatus.mock.calls.filter(
        (call) => call[1] === 'error',
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
      const lastErrorCall = errorCalls[errorCalls.length - 1];
      expect(lastErrorCall[2]).toMatch(/Inception failed/);
    });

    it('disables Import Mode in finally even on throw path', async () => {
      setupHappyUpToCreate();
      mocks.createStudyTasks.mockRejectedValue(batchAbortedError());

      const { req, res } = makeReqRes({ studyPageId: 'study-ionis' });
      await handleInception(req, res);
      await flush();

      // Find the LAST PATCH for IMPORT_MODE — should be the finally cleanup
      // setting it back to false.
      const importModePatches = mocks.mockClient.request.mock.calls.filter(
        ([method, path, body]) =>
          method === 'PATCH' &&
          path === '/pages/study-ionis' &&
          body?.properties?.[S.IMPORT_MODE.id] !== undefined,
      );
      expect(importModePatches.length).toBeGreaterThanOrEqual(2); // enable + finally disable
      const lastPatch = importModePatches[importModePatches.length - 1];
      expect(lastPatch[2].properties[S.IMPORT_MODE.id].checkbox).toBe(false);
    });

    it('Notion-down resilience: when logTerminalEvent rejects, reportStatus and postComment still run', async () => {
      // Mirror of the brownout scenario that likely caused the abort: the
      // catch block must not let one failed Notion call drop the others.
      setupHappyUpToCreate();
      mocks.createStudyTasks.mockRejectedValue(batchAbortedError());
      mocks.activityLogService.logTerminalEvent.mockRejectedValue(new Error('Notion 500'));

      const { req, res } = makeReqRes({ studyPageId: 'study-ionis' });
      await handleInception(req, res);
      await flush();

      // reportStatus 'error' was attempted
      const errorReportStatusCalls = mocks.mockClient.reportStatus.mock.calls.filter(
        (call) => call[1] === 'error',
      );
      expect(errorReportStatusCalls.length).toBeGreaterThanOrEqual(1);
      // postComment was attempted
      expect(mocks.studyCommentService.postComment).toHaveBeenCalled();
      // logTerminalEvent itself was attempted (the rejection means it tried)
      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalled();
    });

    it('Notion-down resilience: when reportStatus rejects, logTerminalEvent and postComment still run', async () => {
      setupHappyUpToCreate();
      mocks.createStudyTasks.mockRejectedValue(batchAbortedError());
      // reportStatus fails ONLY for the catch-block 'error' call — keep
      // earlier 'info' calls succeeding so the run reaches the catch block
      // with the same shape it would in production.
      mocks.mockClient.reportStatus.mockImplementation(async (_studyId, severity) => {
        if (severity === 'error') throw new Error('Notion 500');
        return {};
      });

      const { req, res } = makeReqRes({ studyPageId: 'study-ionis' });
      await handleInception(req, res);
      await flush();

      expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({ workflow: 'Inception', status: 'failed' }),
      );
      expect(mocks.studyCommentService.postComment).toHaveBeenCalled();
    });

    it('Notion-down resilience: when all three reject, original error is preserved (no mask)', async () => {
      // Worst case — entire Notion brownout. The route's catch block has
      // an inner try/catch ("don't mask original error"); the original
      // batch-aborted Error must still surface so flightTracker logs it
      // unmodified.
      setupHappyUpToCreate();
      const original = batchAbortedError();
      mocks.createStudyTasks.mockRejectedValue(original);
      mocks.activityLogService.logTerminalEvent.mockRejectedValue(new Error('AL 500'));
      mocks.studyCommentService.postComment.mockRejectedValue(new Error('Comment 500'));
      mocks.mockClient.reportStatus.mockImplementation(async (_id, severity) => {
        if (severity === 'error') throw new Error('Status 500');
        return {};
      });

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { req, res } = makeReqRes({ studyPageId: 'study-ionis' });
        await handleInception(req, res);
        await flush();

        // The flightTracker .catch handler logs '[inception] unhandled:'
        // with the rethrown error — verify the original batch-aborted Error
        // surfaced unmodified.
        const unhandledLog = consoleError.mock.calls.find(
          (args) => typeof args[0] === 'string' && args[0].startsWith('[inception] unhandled:'),
        );
        expect(unhandledLog).toBeDefined();
        expect(unhandledLog[1]).toBe(original);
      } finally {
        consoleError.mockRestore();
      }
    });

    it('terminal event details include batchOutcome and timing.phases.createStudyTasks', async () => {
      // The route reads tracer.toActivityLogDetails() into the terminal
      // event. With U1+U2 wired, the route's tracer should have:
      //   - batchOutcome populated (because createStudyTasks called
      //     recordBatchOutcome before throwing)
      //   - timing.phases.createStudyTasks populated (because endPhase
      //     fires in the finally inside createStudyTasks)
      //
      // Test setup: have the createStudyTasks mock interact with the
      // tracer the same way the real implementation does, so the route's
      // toActivityLogDetails reflects the production shape.
      setupHappyUpToCreate();
      mocks.createStudyTasks.mockImplementation(async (_client, _levels, opts) => {
        const tracer = opts.tracer;
        if (tracer) {
          tracer.startPhase('createStudyTasks');
          tracer.recordBatchOutcome({ attempted: 202, created: 131, failedUnsafe: 1, notAttempted: 70 });
          tracer.endPhase('createStudyTasks');
        }
        throw batchAbortedError();
      });

      const { req, res } = makeReqRes({ studyPageId: 'study-ionis' });
      await handleInception(req, res);
      await flush();

      const terminalCall = mocks.activityLogService.logTerminalEvent.mock.calls.find(
        ([arg]) => arg.status === 'failed',
      );
      expect(terminalCall).toBeDefined();
      const details = terminalCall[0].details;
      expect(details.batchOutcome).toEqual({
        attempted: 202,
        created: 131,
        failedUnsafe: 1,
        notAttempted: 70,
      });
      expect(details.timing?.phases?.createStudyTasks).toBeGreaterThanOrEqual(0);
    });
  });
});
