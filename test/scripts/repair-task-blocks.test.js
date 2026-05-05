import { describe, it, expect, vi } from 'vitest';
import { diagnose, apply } from '../../scripts/repair-task-blocks.js';
import { STUDY_TASKS_PROPS, STUDIES_PROPS } from '../../src/notion/property-names.js';

const STUDY_ID = 'study-page-1';
const STUDY_TASKS_DB = 'study-tasks-db-1';
const BL_L16 = 'df123867-60c2-82fe-9c51-816ddf061fe9';

// ──────────────────────────────────────────────────────────────────────────
// Test fixtures and helpers
// ──────────────────────────────────────────────────────────────────────────

function makeTask({ id, taskName, templateId }) {
  return {
    id,
    properties: {
      [STUDY_TASKS_PROPS.TASK_NAME.id]: { id: STUDY_TASKS_PROPS.TASK_NAME.id, type: 'title', title: [{ plain_text: taskName }] },
      [STUDY_TASKS_PROPS.TEMPLATE_SOURCE_ID.id]: { id: STUDY_TASKS_PROPS.TEMPLATE_SOURCE_ID.id, type: 'rich_text', rich_text: [{ plain_text: templateId }] },
    },
  };
}

/**
 * Mock NotionClient. `bodyByPageId` controls what `GET /blocks/{id}/children`
 * returns: array of block stubs (length>0 = has content), [] = empty body.
 * `errorPageIds` triggers an error on the GET probe.
 */
function mockClient({ tasks = [], bodyByPageId = {}, errorPageIds = new Set(), patchErrors = {} } = {}) {
  const calls = { request: [], queryDatabase: [] };

  const client = {
    calls,
    queryDatabase: vi.fn(async (dbId, filter) => {
      calls.queryDatabase.push({ dbId, filter });
      return tasks;
    }),
    request: vi.fn(async (method, path, body) => {
      calls.request.push({ method, path, body });

      if (method === 'GET' && path.includes('/blocks/')) {
        const blockId = path.split('/blocks/')[1].split('/')[0];
        if (errorPageIds.has(blockId)) {
          const err = new Error(`probe error on ${blockId}`);
          err.status = 400;
          throw err;
        }
        return {
          results: bodyByPageId[blockId] || [],
          has_more: false,
          next_cursor: null,
        };
      }

      if (method === 'PATCH' && path.startsWith('/pages/')) {
        const pageId = path.replace('/pages/', '');
        if (patchErrors[pageId]) throw new Error(patchErrors[pageId]);
        return { id: pageId };
      }

      if (method === 'POST' && path === '/pages') {
        return { id: 'new-page-id' };
      }

      return {};
    }),
  };

  return client;
}

// ──────────────────────────────────────────────────────────────────────────
// diagnose()
// ──────────────────────────────────────────────────────────────────────────

describe('diagnose', () => {
  it('classifies tasks correctly across all categories', async () => {
    const tasks = [
      makeTask({ id: 't-ok', taskName: 'Task OK', templateId: 'tpl-with-content' }),
      makeTask({ id: 't-empty', taskName: 'Task missing body', templateId: 'tpl-with-content-2' }),
      makeTask({ id: 't-bl-l16', taskName: 'Task BL-L16', templateId: BL_L16 }),
      makeTask({ id: 't-empty-tpl', taskName: 'Task with empty template', templateId: 'tpl-no-content' }),
    ];
    const client = mockClient({
      tasks,
      bodyByPageId: {
        // Tasks
        't-ok': [{ type: 'paragraph' }], // has content
        't-empty': [],
        't-bl-l16': [],
        't-empty-tpl': [],
        // Templates
        'tpl-with-content': [{ type: 'paragraph' }],
        'tpl-with-content-2': [{ type: 'paragraph' }],
        'tpl-no-content': [],
        // BL_L16 template not probed (skip-list catches first)
      },
    });

    const result = await diagnose({ client, studyPageId: STUDY_ID, studyTasksDbId: STUDY_TASKS_DB });

    expect(result.totals).toEqual({
      tasksFound: 4,
      presentOk: 1,
      missingBody: 1,
      knownBrokenSkip: 1,
      emptyTemplateSkip: 1,
      probeErrors: 0,
    });
    expect(result.repairList).toEqual([
      { taskId: 't-empty', templateId: 'tpl-with-content-2', taskName: 'Task missing body' },
    ]);
    expect(result.knownBrokenSkips[0].templateId).toBe(BL_L16);
  });

  it('queries the correct study and DB', async () => {
    const client = mockClient({ tasks: [] });
    await diagnose({ client, studyPageId: STUDY_ID, studyTasksDbId: STUDY_TASKS_DB });

    expect(client.calls.queryDatabase).toHaveLength(1);
    expect(client.calls.queryDatabase[0].dbId).toBe(STUDY_TASKS_DB);
    expect(client.calls.queryDatabase[0].filter.and[0].relation.contains).toBe(STUDY_ID);
    expect(client.calls.queryDatabase[0].filter.and[1].rich_text.is_not_empty).toBe(true);
  });

  it('records probe errors as a separate category instead of throwing', async () => {
    const tasks = [
      makeTask({ id: 't-empty', taskName: 'Empty', templateId: 'tpl-broken' }),
    ];
    const client = mockClient({
      tasks,
      bodyByPageId: { 't-empty': [] },
      errorPageIds: new Set(['tpl-broken']),
    });

    const result = await diagnose({ client, studyPageId: STUDY_ID, studyTasksDbId: STUDY_TASKS_DB });

    expect(result.totals.probeErrors).toBe(1);
    expect(result.probeErrors[0].error).toContain('probe error');
    expect(result.repairList).toHaveLength(0);
  });

  it('skips empty-template tasks (legitimate, not a failure)', async () => {
    const tasks = [
      makeTask({ id: 't-empty', taskName: 'Empty', templateId: 'tpl-no-content' }),
    ];
    const client = mockClient({
      tasks,
      bodyByPageId: { 't-empty': [], 'tpl-no-content': [] },
    });

    const result = await diagnose({ client, studyPageId: STUDY_ID, studyTasksDbId: STUDY_TASKS_DB });

    expect(result.totals.emptyTemplateSkip).toBe(1);
    expect(result.totals.missingBody).toBe(0);
  });

  it('respects custom knownBrokenTemplateIds set', async () => {
    const customBroken = new Set(['custom-broken-tpl']);
    const tasks = [
      makeTask({ id: 't-1', taskName: 'Custom broken', templateId: 'custom-broken-tpl' }),
    ];
    const client = mockClient({
      tasks,
      bodyByPageId: { 't-1': [] },
    });

    const result = await diagnose({
      client,
      studyPageId: STUDY_ID,
      studyTasksDbId: STUDY_TASKS_DB,
      knownBrokenTemplateIds: customBroken,
    });

    expect(result.totals.knownBrokenSkip).toBe(1);
    expect(result.knownBrokenSkips[0].templateId).toBe('custom-broken-tpl');
  });

  it('handles empty study (no tasks)', async () => {
    const client = mockClient({ tasks: [] });
    const result = await diagnose({ client, studyPageId: STUDY_ID, studyTasksDbId: STUDY_TASKS_DB });

    expect(result.totals.tasksFound).toBe(0);
    expect(result.repairList).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// apply()
// ──────────────────────────────────────────────────────────────────────────

describe('apply', () => {
  function fakeActivityLog() {
    return { logTerminalEvent: vi.fn(async () => ({ logged: true, pageId: 'al-1' })) };
  }

  it('toggles Import Mode on, calls copyBlocks, toggles off, writes Activity Log on success', async () => {
    const client = mockClient();
    const fakeAL = fakeActivityLog();
    const fakeCopyBlocks = vi.fn(async (_client, idMapping) => ({
      blocksWrittenCount: 5,
      pagesProcessed: 1,
      pagesSkipped: 0,
    }));

    const repairList = [{ taskId: 'task-1', templateId: 'tpl-1', taskName: 'Task 1' }];
    const { copyResult, runError } = await apply({
      client,
      studyPageId: STUDY_ID,
      studyName: 'Study A',
      repairList,
      activityLogService: fakeAL,
      executionId: 'exec-1',
      copyBlocksFn: fakeCopyBlocks,
    });

    expect(runError).toBeNull();
    expect(copyResult.blocksWrittenCount).toBe(5);

    // Import Mode on -> off (two PATCHes on study page)
    const studyPatches = client.calls.request.filter((c) => c.method === 'PATCH' && c.path === `/pages/${STUDY_ID}`);
    expect(studyPatches).toHaveLength(2);
    expect(studyPatches[0].body.properties[STUDIES_PROPS.IMPORT_MODE.id].checkbox).toBe(true);
    expect(studyPatches[1].body.properties[STUDIES_PROPS.IMPORT_MODE.id].checkbox).toBe(false);

    // copyBlocks called with idMapping built from repairList
    expect(fakeCopyBlocks).toHaveBeenCalledOnce();
    const [, idMapping, opts] = fakeCopyBlocks.mock.calls[0];
    expect(idMapping).toEqual({ 'tpl-1': 'task-1' });
    expect(opts.studyPageId).toBe(STUDY_ID);
    expect(opts.studyName).toBe('Study A');

    // Activity Log written with success
    expect(fakeAL.logTerminalEvent).toHaveBeenCalledOnce();
    const logEvent = fakeAL.logTerminalEvent.mock.calls[0][0];
    expect(logEvent.workflow).toBe('Copy Blocks');
    expect(logEvent.status).toBe('success');
    expect(logEvent.triggerType).toBe('Manual');
    expect(logEvent.studyId).toBe(STUDY_ID);
    expect(logEvent.summary).toContain('1 pages processed');
    expect(logEvent.details.script).toBe('repair-task-blocks');
    expect(logEvent.details.attempted).toBe(1);
  });

  it('clears Import Mode in finally even when copyBlocks throws', async () => {
    const client = mockClient();
    const fakeAL = fakeActivityLog();
    const fakeCopyBlocks = vi.fn(async () => {
      throw new Error('copyBlocks crashed');
    });

    const { runError } = await apply({
      client,
      studyPageId: STUDY_ID,
      studyName: 'Study A',
      repairList: [{ taskId: 'task-1', templateId: 'tpl-1', taskName: 'T' }],
      activityLogService: fakeAL,
      executionId: 'exec-1',
      copyBlocksFn: fakeCopyBlocks,
    });

    expect(runError?.message).toBe('copyBlocks crashed');

    // Import Mode still cleared
    const studyPatches = client.calls.request.filter((c) => c.method === 'PATCH' && c.path === `/pages/${STUDY_ID}`);
    expect(studyPatches).toHaveLength(2);
    expect(studyPatches[1].body.properties[STUDIES_PROPS.IMPORT_MODE.id].checkbox).toBe(false);

    // Activity Log written with failed status + error details
    expect(fakeAL.logTerminalEvent).toHaveBeenCalledOnce();
    const logEvent = fakeAL.logTerminalEvent.mock.calls[0][0];
    expect(logEvent.status).toBe('failed');
    expect(logEvent.details.error.errorMessage).toContain('copyBlocks crashed');
  });

  it('builds idMapping correctly for multiple tasks', async () => {
    const client = mockClient();
    const fakeAL = fakeActivityLog();
    const fakeCopyBlocks = vi.fn(async () => ({ blocksWrittenCount: 0, pagesProcessed: 3, pagesSkipped: 0 }));

    await apply({
      client,
      studyPageId: STUDY_ID,
      studyName: 'Study A',
      repairList: [
        { taskId: 'task-a', templateId: 'tpl-a', taskName: 'A' },
        { taskId: 'task-b', templateId: 'tpl-b', taskName: 'B' },
        { taskId: 'task-c', templateId: 'tpl-c', taskName: 'C' },
      ],
      activityLogService: fakeAL,
      executionId: 'exec-1',
      copyBlocksFn: fakeCopyBlocks,
    });

    const [, idMapping] = fakeCopyBlocks.mock.calls[0];
    expect(idMapping).toEqual({
      'tpl-a': 'task-a',
      'tpl-b': 'task-b',
      'tpl-c': 'task-c',
    });
  });

  it('records attemptedTaskIds in Activity Log details', async () => {
    const client = mockClient();
    const fakeAL = fakeActivityLog();
    const fakeCopyBlocks = vi.fn(async () => ({ blocksWrittenCount: 1, pagesProcessed: 1, pagesSkipped: 1 }));

    await apply({
      client,
      studyPageId: STUDY_ID,
      studyName: 'Study A',
      repairList: [
        { taskId: 'task-a', templateId: 'tpl-a', taskName: 'A' },
        { taskId: 'task-b', templateId: 'tpl-b', taskName: 'B' },
      ],
      activityLogService: fakeAL,
      executionId: 'exec-1',
      copyBlocksFn: fakeCopyBlocks,
    });

    const logEvent = fakeAL.logTerminalEvent.mock.calls[0][0];
    expect(logEvent.details.attemptedTaskIds).toEqual(['task-a', 'task-b']);
    expect(logEvent.details.pagesSkipped).toBe(1);
  });
});
