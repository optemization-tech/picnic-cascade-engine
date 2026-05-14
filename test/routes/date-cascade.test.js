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
  queryStudyTasks: vi.fn(),
  activityLogService: {
    logTerminalEvent: vi.fn(),
  },
  undoStore: {
    save: vi.fn(),
  },
  studyCommentService: {
    postComment: vi.fn(),
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

vi.mock('../../src/notion/clients.js', () => ({
  cascadeClient: mocks.mockClient,
  provisionClient: mocks.mockClient,
  deletionClient: mocks.mockClient,
  commentClient: mocks.mockClient,
}));

vi.mock('../../src/gates/guards.js', () => ({
  parseWebhookPayload: mocks.parseWebhookPayload,
  isImportMode: mocks.isImportMode,
  isFrozen: mocks.isFrozen,
}));

vi.mock('../../src/engine/classify.js', () => ({ classify: mocks.classify }));
vi.mock('../../src/engine/cascade.js', () => ({ runCascade: mocks.runCascade }));
vi.mock('../../src/engine/parent-subtask.js', () => ({ runParentSubtask: mocks.runParentSubtask }));
vi.mock('../../src/notion/queries.js', () => ({ queryStudyTasks: mocks.queryStudyTasks }));
vi.mock('../../src/services/activity-log.js', () => ({
  ActivityLogService: vi.fn(() => mocks.activityLogService),
}));
vi.mock('../../src/services/study-comment.js', () => ({
  StudyCommentService: vi.fn(() => mocks.studyCommentService),
}));
vi.mock('../../src/services/undo-store.js', () => ({
  undoStore: mocks.undoStore,
}));
vi.mock('../../src/services/cascade-queue.js', () => ({
  cascadeQueue: {
    enqueue: vi.fn((payload, _parseFn, processFn) => {
      void processFn(payload).catch(() => {});
    }),
  },
}));

import { handleDateCascade } from '../../src/routes/date-cascade.js';
import {
  STUDY_TASKS_PROPS as ST,
  STUDIES_PROPS as S,
} from '../../src/notion/property-names.js';

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
    mocks.studyCommentService.postComment.mockResolvedValue({ posted: true });
  });

  // @behavior BEH-DATE-CASCADE-ZERO-DELTA-SILENT-ENGINE-SEED
  it('stays silent (no Activity Log, no banner) on zero delta when mentionable=false (engine-seed defensive path)', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task 1',
      studyId: 'study-1',
      startDelta: 0,
      endDelta: 0,
      mentionable: false,
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
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  // @behavior BEH-DATE-CASCADE-ZERO-DELTA-LEGACY-FALLBACK
  it('stays silent and emits webhook_actor_legacy_fallback when mentionable is undefined (legacy caller)', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task 1',
      studyId: 'study-1',
      startDelta: 0,
      endDelta: 0,
      mentionable: undefined,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((c) => {
      try { return JSON.parse(c[0]); } catch { return null; }
    }).filter(Boolean);
    expect(logged.some((e) => e.event === 'webhook_actor_legacy_fallback' && e.route === 'date-cascade')).toBe(true);
    consoleSpy.mockRestore();
  });

  // @behavior BEH-DATE-CASCADE-ZERO-DELTA-HUMAN-FEEDBACK
  it('emits Activity Log entry (no_shifts) and green banner on zero delta when mentionable=true (human-seed)', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task 1',
      studyId: 'study-1',
      startDelta: 0,
      endDelta: 0,
      mentionable: true,
      triggeredByUserId: 'user-1',
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.mockClient.patchPage.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'no_shifts',
        summary: expect.stringContaining('dates within tolerance'),
      }),
    );
    const [taskId, props] = mocks.mockClient.patchPage.mock.calls[0];
    expect(taskId).toBe('task-1');
    const bannerProp = Object.values(props).find((p) => p.rich_text);
    expect(bannerProp.rich_text[0].annotations.color).toBe('green_background');
    expect(bannerProp.rich_text[0].text.content).toContain('no change to propagate');
    expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
  });

  // @behavior BEH-DATE-CASCADE-ZERO-DELTA-LOOP-PREVENTION
  it('engine-seed echo on zero delta stays silent (loop-prevention regression-lock)', async () => {
    // After engine writes banner, Notion fires webhook back; classifier returns
    // mentionable=false; zero_delta_skip runs; no further writes.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task 1',
      studyId: 'study-1',
      startDelta: 0,
      endDelta: 0,
      mentionable: false,
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  it('absorbs patchPage failure in inner try/catch on zero delta — Activity Log written once, no silent queue swallow', async () => {
    // Verifies M-P1-2 fix: zero_delta Promise.all is wrapped in its own try/catch.
    // A transient patchPage rejection must not escape to the queue's error handler.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task 1',
      studyId: 'study-1',
      startDelta: 0,
      endDelta: 0,
      mentionable: true,
      triggeredByUserId: 'user-1',
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.mockClient.patchPage.mockRejectedValue(new Error('Notion 429'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    // logTerminalEvent resolved before patchPage rejected — exactly one entry.
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledTimes(1);
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'no_shifts' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[date-cascade] zero_delta feedback write failed'),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('snaps a weekend source edit forward before classification and patching', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      newStart: '2026-04-04',
      newEnd: '2026-04-04',
      refStart: '2026-04-03',
      refEnd: '2026-04-03',
      startDelta: 0,
      endDelta: 0,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'source', parentId: null }]);
    mocks.classify.mockImplementation((parsed) => {
      expect(parsed.newStart).toBe('2026-04-06');
      expect(parsed.newEnd).toBe('2026-04-06');
      expect(parsed.startDelta).toBe(1);
      expect(parsed.endDelta).toBe(1);
      return {
        skip: false,
        sourceTaskId: 'source',
        sourceTaskName: 'Source',
        newStart: parsed.newStart,
        newEnd: parsed.newEnd,
        refStart: '2026-04-03',
        refEnd: '2026-04-03',
        startDelta: parsed.startDelta,
        endDelta: parsed.endDelta,
        cascadeMode: 'drag-right',
        parentTaskId: null,
        parentMode: null,
      };
    });
    mocks.runCascade.mockReturnValue({
      updates: [],
      movedTaskIds: [],
      movedTaskMap: {},
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({
      updates: [],
      parentMode: null,
      rolledUpStart: null,
      rolledUpEnd: null,
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({ updatedCount: 1, taskIds: ['source'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(mocks.mockClient.patchPages).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: 'source',
        properties: expect.objectContaining({
          [ST.DATES.id]: { date: { start: '2026-04-06', end: '2026-04-06' } },
        }),
      }),
    ], expect.any(Object));
  });

  it('posts "Cascade queued" to the task on valid non-zero-delta webhooks', async () => {
    // Unit 3: immediate click feedback, scoped to parsed.taskId.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 2,
      endDelta: 2,
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    // Allow the fire-and-forget reportStatus microtask to settle.
    await Promise.resolve();

    const queuedCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade queued for Source'),
    );
    expect(queuedCalls).toHaveLength(1);
    expect(queuedCalls[0][0]).toBe('source'); // task-scoped, not study
  });

  it('skips "Cascade queued" for bot-echo webhooks', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 2,
      endDelta: 2,
      editedByBot: true, // bot echo
    });
    mocks.isImportMode.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await Promise.resolve();

    const queuedCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade queued'),
    );
    expect(queuedCalls).toHaveLength(0);
  });

  it('exits processDateCascade early on bot-echo with no Notion side effects', async () => {
    // Defense-in-depth: if a bot-echo bypasses the cascade-queue front-door
    // gate (e.g., a future code path that calls processDateCascade directly
    // without going through cascadeQueue.enqueue), processDateCascade must
    // still short-circuit before touching Notion. Mirrors processDepEdit:129.
    // Plan: docs/plans/2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md
    // (U1 step 4).
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      newStart: '2026-04-06',
      newEnd: '2026-04-06',
      refStart: '2026-04-03',
      refEnd: '2026-04-03',
      startDelta: 3,  // non-zero — would normally cascade
      endDelta: 3,
      editedByBot: true,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.queryStudyTasks).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.runCascade).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).not.toHaveBeenCalled();
  });

  it('skips "Cascade queued" when studyId is missing (prevents stuck banner)', async () => {
    // Without a studyId, processDateCascade returns at the missing_study
    // guard with no follow-up reportStatus -- leaving "queued" stuck on
    // the task's Automation Reporting field. Handler must suppress queued
    // in this case.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: null,
      hasDates: true,
      startDelta: 2,
      endDelta: 2,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await Promise.resolve();

    const queuedCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade queued'),
    );
    expect(queuedCalls).toHaveLength(0);
  });

  it('skips "Cascade queued" when Import Mode is enabled', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 2,
      endDelta: 2,
    });
    mocks.isImportMode.mockReturnValue(true);

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await Promise.resolve();

    const queuedCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade queued'),
    );
    expect(queuedCalls).toHaveLength(0);
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

  it('logs no_action for a frozen leaf task and skips the cascade (post-classify frozen check)', async () => {
    // After Unit 2, the isFrozen check runs AFTER classify so Error 1 can
    // still fire for frozen top-level parents. A frozen leaf classifies as
    // skip:false with a cascadeMode (e.g., push-right), then the post-
    // classify isFrozen branch logs no_action. queryStudyTasks is now
    // called (accepted trade-off) but "Cascade started" reportStatus is
    // suppressed for this path.
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
    // Non-empty so the empty-study safety guard doesn't fire first.
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'source' }]);
    mocks.classify.mockReturnValue({
      skip: false,
      cascadeMode: 'push-right',
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-01',
      newEnd: '2026-04-02',
      refStart: '2026-04-01',
      refEnd: '2026-04-01',
      startDelta: 0,
      endDelta: 1,
      parentTaskId: null,
      parentMode: null,
    });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.queryStudyTasks).toHaveBeenCalled();
    expect(mocks.classify).toHaveBeenCalled();
    // Unit 3: "Cascade queued" fires on the task's Automation Reporting
    // immediately (before the debounce), but "Cascade started" is suppressed
    // because the post-classify frozen check returns early.
    const reportStatusCalls = mocks.mockClient.reportStatus.mock.calls;
    const startedCalls = reportStatusCalls.filter(
      (args) => typeof args[2] === 'string' && args[2].includes('Cascade started'),
    );
    expect(startedCalls).toHaveLength(0);
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    expect(mocks.runCascade).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({ noActionReason: 'frozen_status' }),
    }));
  });

  it('frozen middle-parent (case-a) logs no_action without cascading', async () => {
    // A middle parent has both a parentId of its own AND its own subtasks.
    // classify returns skip:false with parentMode:'case-a' (Error 1 only
    // fires when !hasParent). If the middle parent is frozen, the post-
    // classify isFrozen branch should log no_action and NOT run cascade.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'middle-parent',
      taskName: 'Middle Parent',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 2,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(true);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'middle-parent' }]);
    mocks.classify.mockReturnValue({
      skip: false,
      cascadeMode: 'push-right',
      sourceTaskId: 'middle-parent',
      sourceTaskName: 'Middle Parent',
      newStart: '2026-05-01',
      newEnd: '2026-05-05',
      refStart: '2026-05-01',
      refEnd: '2026-05-03',
      startDelta: 0,
      endDelta: 2,
      parentTaskId: 'grandparent',
      parentMode: 'case-a',
    });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.queryStudyTasks).toHaveBeenCalled();
    expect(mocks.classify).toHaveBeenCalled();
    expect(mocks.runCascade).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({ noActionReason: 'frozen_status' }),
    }));
  });

  it('logs no_action when queryStudyTasks returns empty (stale studyId safety guard)', async () => {
    // If queryStudyTasks returns empty (stale studyId, racing deletion),
    // classify would compute hasSubtasksFromGraph=false and Error 1 would
    // never fire for a top-level parent edit. Safety guard short-circuits
    // with a no_action log instead of silently accepting the edit.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'orphan',
      taskName: 'Orphan Task',
      studyId: 'study-1',
      hasDates: true,
      startDelta: -1,
      endDelta: 0,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([]); // empty study

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.queryStudyTasks).toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled(); // short-circuited before classify
    expect(mocks.runCascade).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({ noActionReason: 'empty_study_tasks' }),
    }));
    // Empty-study guard clears the "Cascade queued" banner on the task
    // with a warning so the PM sees the no-action outcome instead of a
    // stuck pre-state message.
    const warningCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => args[0] === 'orphan' && args[1] === 'warning'
        && typeof args[2] === 'string' && args[2].includes('no tasks found'),
    );
    expect(warningCalls).toHaveLength(1);
  });

  it('fires Error 1 revert on a FROZEN top-level parent date edit and suppresses "Cascade started"', async () => {
    // The core Unit 2 scenario: Meg's Sites Planning (frozen) edit. Without
    // the guard reorder, isFrozen fires first and the edit is silently
    // swallowed. With the reorder, classify runs, Error 1 fires,
    // applyError1SideEffects reverts the parent, and no misleading
    // "Cascade started" message is posted (sequence: queued -> revert).
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'parent-1',
      taskName: 'Sites Planning',
      studyId: 'study-1',
      hasDates: true,
      startDelta: -2,
      endDelta: 0,
      refStart: '2026-05-06',
      refEnd: '2026-07-01',
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(true); // parent is Done -- frozen
    // Non-empty tasks so the empty-study-tasks safety guard doesn't fire
    // before classify gets a chance to return Error 1.
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'parent-1' }, { id: 'child-1' }]);
    mocks.classify.mockReturnValue({
      skip: true,
      reason: 'Direct parent edit blocked - edit subtasks directly',
      cascadeMode: null,
      sourceTaskId: 'parent-1',
      refStart: '2026-05-06',
      refEnd: '2026-07-01',
    });
    mocks.mockClient.request.mockResolvedValue({});
    mocks.mockClient.patchPage.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    // Error 1 must fire even though isFrozen === true
    expect(mocks.mockClient.request).toHaveBeenCalledWith(
      'PATCH',
      '/pages/study-1',
      expect.any(Object),
      expect.any(Object),
    );
    expect(mocks.mockClient.patchPage).toHaveBeenCalledWith(
      'parent-1',
      expect.objectContaining({
        [ST.DATES.id]: { date: { start: '2026-05-06', end: '2026-07-01' } },
      }),
      expect.any(Object),
    );
    // No "Cascade started" info message should have been posted
    const infoCalls = mocks.mockClient.reportStatus.mock.calls.filter(
      (args) => args[1] === 'info' && typeof args[2] === 'string' && args[2].includes('Cascade started'),
    );
    expect(infoCalls).toHaveLength(0);
    // Activity Log gets a no_action entry with Error 1 reason
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({
        noActionReason: expect.stringContaining('Direct parent edit blocked'),
      }),
    }));
  });

  it('applies Error 1 side effects, reverts the source task, and preserves the warning text', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: -1,
      endDelta: 0,
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    // Non-empty so the empty-study safety guard doesn't fire first.
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'source' }, { id: 'child-1' }]);
    mocks.classify.mockReturnValue({
      skip: true,
      reason: 'Direct parent edit blocked - edit subtasks directly',
      cascadeMode: null,
      sourceTaskId: 'source',
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.request.mockResolvedValue({});
    mocks.mockClient.patchPage.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.request).toHaveBeenCalledWith('PATCH', '/pages/study-1', {
      properties: {
        [S.IMPORT_MODE.id]: { checkbox: false },
        [S.AUTOMATION_REPORTING.id]: {
          rich_text: [{
            type: 'text',
            text: { content: '⚠️ This task has subtasks — edit a subtask directly to shift dates and trigger cascading.' },
            annotations: { bold: true, color: 'red' },
          }],
        },
      },
    }, expect.any(Object));
    expect(mocks.mockClient.patchPage).toHaveBeenCalledWith('source', expect.objectContaining({
      [ST.DATES.id]: { date: { start: '2026-04-01', end: '2026-04-02' } },
      [ST.REF_START.id]: { date: { start: '2026-04-01' } },
      [ST.REF_END.id]: { date: { start: '2026-04-02' } },
    }), expect.any(Object));
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
      parentMode: null,
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'a', newStart: '2026-04-02', newEnd: '2026-04-03' }],
      movedTaskIds: ['a'],
      movedTaskMap: { a: { newStart: '2026-04-02', newEnd: '2026-04-03' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({
      updates: [{ taskId: 'parent-rollup', newStart: '2026-04-01', newEnd: '2026-04-03', _isRollUp: true }],
      parentMode: null,
      rolledUpStart: null,
      rolledUpEnd: null,
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
    expect(patchPayload.every((u) => u.properties[ST.LMBS.id] === undefined)).toBe(true);
    // Patch payload sorted by ascending start date (top-of-timeline first)
    const starts = patchPayload.map((u) => u.properties[ST.DATES.id].date.start);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] >= starts[i - 1]).toBe(true);
    }
    // Unit 3: cascade lifecycle reportStatus writes now target the TASK
    // (not the study) so multi-task cascades don't overwrite each other's
    // states. Sequence for a normal cascade: queued -> started -> complete,
    // all scoped to parsed.taskId.
    expect(mocks.mockClient.reportStatus).toHaveBeenNthCalledWith(
      1,
      'source',
      'info',
      expect.stringContaining('Cascade queued for Source'),
    );
    expect(mocks.mockClient.reportStatus).toHaveBeenNthCalledWith(
      2,
      'source',
      'info',
      'Cascade started for Source...',
      expect.any(Object),
    );
    expect(mocks.mockClient.reportStatus).toHaveBeenNthCalledWith(
      3,
      'source',
      'success',
      'Cascade complete for Source: push-right (3 task updates)',
      expect.any(Object),
    );
  });

  it('normalizes Date-typed task start/end to YYYY-MM-DD strings in undo manifest', async () => {
    // Regression: 2026-04-13 production incident. normalizeTask returns Date objects for
    // t.start/t.end, and the undo manifest propagated them verbatim. The Undo Cascade sort
    // then called .localeCompare on a Date and threw. Here we prove the snapshot site
    // converts to strings before handing off to undoStore.save.
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    // Matches what normalizeTask actually produces: start/end are Date objects.
    mocks.queryStudyTasks.mockResolvedValue([
      {
        id: 'source',
        parentId: null,
        start: new Date('2026-04-01T00:00:00Z'),
        end: new Date('2026-04-02T00:00:00Z'),
      },
      {
        id: 'task-a',
        parentId: null,
        start: new Date('2026-04-05T00:00:00Z'),
        end: new Date('2026-04-06T00:00:00Z'),
      },
    ]);
    mocks.classify.mockReturnValue({
      skip: false,
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-01',
      newEnd: '2026-04-03',
      refStart: '2026-04-01',
      refEnd: '2026-04-03',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      parentTaskId: null,
      parentMode: null,
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'task-a', newStart: '2026-04-06', newEnd: '2026-04-07' }],
      movedTaskIds: ['task-a'],
      movedTaskMap: { 'task-a': { newStart: '2026-04-06', newEnd: '2026-04-07' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({ updates: [], parentMode: null, rolledUpStart: null, rolledUpEnd: null });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({ updatedCount: 2, taskIds: ['source', 'task-a'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.undoStore.save).toHaveBeenCalledTimes(1);
    const savedEntry = mocks.undoStore.save.mock.calls[0][1];
    const manifest = savedEntry.manifest;
    // The manifest must be string-typed for both oldStart and oldEnd on every entry —
    // otherwise Undo Cascade's sort (.localeCompare) blows up in production.
    for (const taskId of Object.keys(manifest)) {
      expect(typeof manifest[taskId].oldStart).toBe('string');
      expect(typeof manifest[taskId].oldEnd).toBe('string');
      expect(manifest[taskId].oldStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(manifest[taskId].oldEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(manifest['task-a'].oldStart).toBe('2026-04-05');
    expect(manifest['task-a'].oldEnd).toBe('2026-04-06');
  });

  it('does not post study comment on successful cascade (comments are errors-only)', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
      triggeredByUserId: 'user-abc',
      editedByBot: false,
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
      parentMode: null,
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'a', newStart: '2026-04-02', newEnd: '2026-04-03' }],
      movedTaskIds: ['a'],
      movedTaskMap: { a: { newStart: '2026-04-02', newEnd: '2026-04-03' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({ updates: [], parentMode: null, rolledUpStart: null, rolledUpEnd: null });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({ updatedCount: 2, taskIds: ['source', 'a'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.studyCommentService.postComment).not.toHaveBeenCalled();
  });

  it('posts study comment on failed cascade', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
      triggeredByUserId: 'user-abc',
      editedByBot: false,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockRejectedValue(new Error('db timeout'));
    mocks.mockClient.reportStatus.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.studyCommentService.postComment).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'Date Cascade',
      status: 'failed',
      studyId: 'study-1',
      sourceTaskName: 'Source',
      summary: expect.stringContaining('cascade failed'),
    }));
  });

  it('successful cascade logs activity without posting comment', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      startDelta: 0,
      endDelta: 1,
      triggeredByUserId: 'user-abc',
      editedByBot: false,
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
      parentMode: null,
    });
    mocks.runCascade.mockReturnValue({
      updates: [{ taskId: 'a', newStart: '2026-04-02', newEnd: '2026-04-03' }],
      movedTaskIds: ['a'],
      movedTaskMap: { a: { newStart: '2026-04-02', newEnd: '2026-04-03' } },
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({ updates: [], parentMode: null, rolledUpStart: null, rolledUpEnd: null });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValueOnce({ updatedCount: 2, taskIds: ['source', 'a'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    // logTerminalEvent should be called; postComment should NOT be called on success
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
    }));
    expect(mocks.studyCommentService.postComment).not.toHaveBeenCalled();
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
      summary: expect.stringContaining('cascade failed'),
    }));
  });

  // ─── Seed Reference writeback on no-shifts terminals ────────────────────
  //
  // Closes the cosmetic-residue gap discovered during the 2026-05-13 U6
  // backfill (PR #109 / pulse-log/05.13/001). When the cascade processes a
  // webhook and concludes there are no downstream shifts to make
  // (no_cascade_mode or zero_updates terminals), the seed's Reference now
  // gets written back to match Dates so the replay-dropped-cascades script's
  // divergence diagnose stops flagging the seed on every subsequent run.
  // Frozen seeds, Error 1 reverts, and the success path are explicitly
  // unaffected.

  it('writes Reference=Dates on seed for no_cascade_mode terminal (non-Error-1)', async () => {
    // Inputs use business-day dates so normalizeWeekendSourceDates doesn't
    // snap them — the assertion below is on the *post-snap* parsed.newStart/
    // newEnd, which equal the inputs when the inputs are already business days.
    // (Saturday inputs would snap forward and confuse the assertion.)
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      newStart: '2026-05-04',
      newEnd: '2026-05-08',
      refStart: '2026-05-04',
      refEnd: '2026-05-15',
      startDelta: 0,
      endDelta: -5,
      mentionable: true,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'source' }]);
    // skip:true + reason that does NOT match 'Direct parent edit blocked'
    // → non-Error-1 sub-case → writeback should fire.
    mocks.classify.mockReturnValue({
      skip: true,
      cascadeMode: null,
      reason: 'No cascade mode determined',
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPage.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    // No real cascade work
    expect(mocks.runCascade).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPages).not.toHaveBeenCalled();
    // The terminal still logs as no_action
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({ noActionReason: expect.stringContaining('No cascade mode') }),
    }));
    // The new behavior: Reference is written back to Dates on the seed.
    // Find the patchPage call that writes REF_START/REF_END (helper writes only those
    // two properties, distinguishing it from Error 1's bigger revert patch).
    const refAckCall = mocks.mockClient.patchPage.mock.calls.find(([, props]) =>
      props[ST.REF_START.id] && props[ST.REF_END.id] && !props[ST.DATES.id],
    );
    expect(refAckCall).toBeDefined();
    expect(refAckCall[0]).toBe('source');
    expect(refAckCall[1][ST.REF_START.id]).toEqual({ date: { start: '2026-05-04' } });
    expect(refAckCall[1][ST.REF_END.id]).toEqual({ date: { start: '2026-05-08' } });
    // AUTOMATION_REPORTING is intentionally NOT touched by the ack helper —
    // the reportStatus warning above is the user-visible message for this terminal.
    expect(refAckCall[1][ST.AUTOMATION_REPORTING.id]).toBeUndefined();
  });

  it('does NOT write Reference ack on Error 1 (Direct parent edit blocked) — applyError1SideEffects reverts instead', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'parent',
      taskName: 'Parent',
      studyId: 'study-1',
      hasDates: true,
      newStart: '2026-05-10',
      newEnd: '2026-05-15',
      refStart: '2026-05-01',
      refEnd: '2026-05-05',
      startDelta: 7,
      endDelta: 7,
      mentionable: true,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'parent' }]);
    mocks.classify.mockReturnValue({
      skip: true,
      cascadeMode: null,
      reason: 'Direct parent edit blocked - edit subtasks directly',
      sourceTaskId: 'parent',
      sourceTaskName: 'Parent',
      refStart: '2026-05-01',
      refEnd: '2026-05-05',
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPage.mockResolvedValue({});
    mocks.mockClient.request.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    // Error 1's revert writes BOTH Dates AND Reference (back to refStart/refEnd, not newStart/newEnd).
    const error1RevertCall = mocks.mockClient.patchPage.mock.calls.find(([, props]) =>
      props[ST.DATES.id] && props[ST.REF_START.id] && props[ST.REF_END.id],
    );
    expect(error1RevertCall).toBeDefined();
    expect(error1RevertCall[1][ST.REF_START.id]).toEqual({ date: { start: '2026-05-01' } });
    expect(error1RevertCall[1][ST.REF_END.id]).toEqual({ date: { start: '2026-05-05' } });
    // Our ack helper writes ONLY REF_START + REF_END (no DATES, no AUTOMATION_REPORTING).
    // There should be no such call — Error 1 owns the Reference write on this path.
    const refAckCall = mocks.mockClient.patchPage.mock.calls.find(([, props]) =>
      props[ST.REF_START.id] && props[ST.REF_END.id] && !props[ST.DATES.id]
        && !props[ST.AUTOMATION_REPORTING.id],
    );
    expect(refAckCall).toBeUndefined();
  });

  it('does NOT write Reference ack on frozen_status terminal (preserves engine invariant)', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'frozen-source',
      taskName: 'Frozen Source',
      studyId: 'study-1',
      hasDates: true,
      newStart: '2026-04-10',
      newEnd: '2026-04-15',
      refStart: '2026-04-01',
      refEnd: '2026-04-05',
      startDelta: 9,
      endDelta: 10,
      mentionable: true,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(true);
    mocks.queryStudyTasks.mockResolvedValue([{ id: 'frozen-source' }]);
    mocks.classify.mockReturnValue({
      skip: false,
      cascadeMode: 'push-right',
      sourceTaskId: 'frozen-source',
      sourceTaskName: 'Frozen Source',
      newStart: '2026-04-10',
      newEnd: '2026-04-15',
      refStart: '2026-04-01',
      refEnd: '2026-04-05',
      startDelta: 9,
      endDelta: 10,
      parentTaskId: null,
      parentMode: null,
    });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPage.mockResolvedValue({});

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'no_action',
      details: expect.objectContaining({ noActionReason: 'frozen_status' }),
    }));
    // No patchPage write that matches the ack signature (REF_START + REF_END only).
    const refAckCall = mocks.mockClient.patchPage.mock.calls.find(([, props]) =>
      props[ST.REF_START.id] && props[ST.REF_END.id] && !props[ST.DATES.id]
        && !props[ST.AUTOMATION_REPORTING.id],
    );
    expect(refAckCall).toBeUndefined();
  });

  it('success path still writes Reference via buildUpdateProperties (no behavior change)', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'source',
      taskName: 'Source',
      studyId: 'study-1',
      hasDates: true,
      newStart: '2026-04-10',
      newEnd: '2026-04-15',
      refStart: '2026-04-01',
      refEnd: '2026-04-05',
      startDelta: 9,
      endDelta: 10,
      mentionable: true,
    });
    mocks.isImportMode.mockReturnValue(false);
    mocks.isFrozen.mockReturnValue(false);
    mocks.queryStudyTasks.mockResolvedValue([
      { id: 'source' },
      { id: 'downstream' },
    ]);
    mocks.classify.mockReturnValue({
      skip: false,
      cascadeMode: 'push-right',
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-10',
      newEnd: '2026-04-15',
      refStart: '2026-04-01',
      refEnd: '2026-04-05',
      startDelta: 9,
      endDelta: 10,
      parentTaskId: null,
      parentMode: null,
    });
    // Cascade produces a downstream shift.
    mocks.runCascade.mockReturnValue({
      updates: [{
        taskId: 'downstream',
        taskName: 'Downstream',
        newStart: '2026-04-20',
        newEnd: '2026-04-25',
        newReferenceStartDate: '2026-04-20',
        newReferenceEndDate: '2026-04-25',
      }],
      movedTaskIds: ['downstream'],
      movedTaskMap: new Map([['downstream', { newStart: '2026-04-20', newEnd: '2026-04-25' }]]),
      diagnostics: {},
    });
    mocks.runParentSubtask.mockReturnValue({ updates: [] });
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.mockClient.patchPages.mockResolvedValue({ updatedCount: 2, taskIds: ['source', 'downstream'] });

    const { req, res } = makeReqRes({ payload: true });
    await handleDateCascade(req, res);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    // Success path: patchPages handles all updates (seed + downstream).
    expect(mocks.mockClient.patchPages).toHaveBeenCalled();
    // Confirm the success terminal fired (not no_action).
    expect(mocks.activityLogService.logTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
    }));
    // The ack helper should NOT have fired on the success path — buildUpdateProperties
    // already covers Reference writes via patchPages.
    const refAckCall = mocks.mockClient.patchPage.mock.calls.find(([, props]) =>
      props[ST.REF_START.id] && props[ST.REF_END.id] && !props[ST.DATES.id]
        && !props[ST.AUTOMATION_REPORTING.id],
    );
    expect(refAckCall).toBeUndefined();
  });
});
