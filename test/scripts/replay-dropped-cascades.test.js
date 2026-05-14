import { describe, it, expect, vi } from 'vitest';
import {
  datesDiverge,
  isTaskFrozen,
  findConnectedComponents,
  pickSeed,
  synthesizeWebhookPayload,
  classifyWebhookResponse,
  diagnoseStudy,
  pollActivityLog,
  run,
} from '../../scripts/replay-dropped-cascades.js';
import {
  STUDY_TASKS_PROPS as ST,
  ACTIVITY_LOG_PROPS as AL,
} from '../../src/notion/property-names.js';
import { parseWebhookPayload } from '../../src/gates/guards.js';

// ─── Fixture builders ───────────────────────────────────────────────────────

function makeTask({
  id,
  name = 'Task',
  refStart = '2026-04-01',
  refEnd = '2026-04-02',
  datesStart = '2026-04-01',
  datesEnd = '2026-04-02',
  status = 'Not Started',
  blockedBy = [],
  blocking = [],
  studyId = 'study-1',
  lastEditedTime = '2026-05-12T10:00:00.000Z',
} = {}) {
  return {
    id,
    last_edited_time: lastEditedTime,
    properties: {
      [ST.TASK_NAME.name]:  { id: ST.TASK_NAME.id,  type: 'title',    title: [{ text: { content: name }, plain_text: name }] },
      [ST.DATES.name]:      { id: ST.DATES.id,      type: 'date',     date: { start: datesStart, end: datesEnd } },
      [ST.REF_START.name]:  { id: ST.REF_START.id,  type: 'date',     date: { start: refStart } },
      [ST.REF_END.name]:    { id: ST.REF_END.id,    type: 'date',     date: { start: refEnd } },
      [ST.STATUS.name]:     { id: ST.STATUS.id,     type: 'status',   status: { name: status } },
      [ST.STUDY.name]:      { id: ST.STUDY.id,      type: 'relation', relation: [{ id: studyId }] },
      [ST.BLOCKED_BY.name]: { id: ST.BLOCKED_BY.id, type: 'relation', relation: blockedBy.map((bid) => ({ id: bid })) },
      [ST.BLOCKING.name]:   { id: ST.BLOCKING.id,   type: 'relation', relation: blocking.map((bid) => ({ id: bid })) },
      [ST.IMPORT_MODE_ROLLUP.name]: { id: ST.IMPORT_MODE_ROLLUP.id, type: 'rollup', rollup: { type: 'boolean', boolean: false } },
      [ST.PARENT_TASK.name]: { id: ST.PARENT_TASK.id, type: 'relation', relation: [] },
      [ST.SUBTASKS.name]: { id: ST.SUBTASKS.id, type: 'relation', relation: [] },
    },
  };
}

// ─── datesDiverge ───────────────────────────────────────────────────────────

describe('datesDiverge', () => {
  it('returns false when Reference matches Dates exactly', () => {
    const task = makeTask({ id: 't1', refStart: '2026-04-01', refEnd: '2026-04-05', datesStart: '2026-04-01', datesEnd: '2026-04-05' });
    expect(datesDiverge(task)).toBe(false);
  });

  it('returns true when Dates end is later than Reference end (the production case)', () => {
    const task = makeTask({ id: 't1', refStart: '2026-04-01', refEnd: '2026-04-05', datesStart: '2026-04-01', datesEnd: '2026-04-10' });
    expect(datesDiverge(task)).toBe(true);
  });

  it('returns true when Dates start is earlier than Reference start', () => {
    const task = makeTask({ id: 't1', refStart: '2026-04-05', refEnd: '2026-04-10', datesStart: '2026-04-01', datesEnd: '2026-04-10' });
    expect(datesDiverge(task)).toBe(true);
  });

  it('returns false when Reference is empty (not yet bootstrapped)', () => {
    const task = makeTask({ id: 't1', datesStart: '2026-04-01', datesEnd: '2026-04-05' });
    task.properties[ST.REF_START.name].date = null;
    task.properties[ST.REF_END.name].date = null;
    expect(datesDiverge(task)).toBe(false);
  });

  it('returns false when Dates is empty', () => {
    const task = makeTask({ id: 't1' });
    task.properties[ST.DATES.name].date = null;
    expect(datesDiverge(task)).toBe(false);
  });
});

// ─── isTaskFrozen ───────────────────────────────────────────────────────────

describe('isTaskFrozen', () => {
  it('returns true for Status=Done', () => {
    expect(isTaskFrozen(makeTask({ id: 't1', status: 'Done' }))).toBe(true);
  });

  it('returns true for Status=N/A', () => {
    expect(isTaskFrozen(makeTask({ id: 't1', status: 'N/A' }))).toBe(true);
  });

  it('returns false for Status=Not Started', () => {
    expect(isTaskFrozen(makeTask({ id: 't1', status: 'Not Started' }))).toBe(false);
  });

  it('returns false for Status=In Progress', () => {
    expect(isTaskFrozen(makeTask({ id: 't1', status: 'In Progress' }))).toBe(false);
  });
});

// ─── findConnectedComponents ────────────────────────────────────────────────

describe('findConnectedComponents', () => {
  it('returns one component per isolated task (no relations)', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c' })];
    const components = findConnectedComponents(tasks);
    expect(components).toHaveLength(3);
  });

  it('groups linked tasks into a single component', () => {
    const tasks = [
      makeTask({ id: 'a', blocking: ['b'] }),
      makeTask({ id: 'b', blockedBy: ['a'], blocking: ['c'] }),
      makeTask({ id: 'c', blockedBy: ['b'] }),
    ];
    const components = findConnectedComponents(tasks);
    expect(components).toHaveLength(1);
    expect(components[0].map((t) => t.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('separates independent chains into different components (the multi-chain case)', () => {
    const tasks = [
      // Chain 1: regulatory
      makeTask({ id: 'reg-1', blocking: ['reg-2'] }),
      makeTask({ id: 'reg-2', blockedBy: ['reg-1'] }),
      // Chain 2: delivery
      makeTask({ id: 'del-1', blocking: ['del-2'] }),
      makeTask({ id: 'del-2', blockedBy: ['del-1'] }),
    ];
    const components = findConnectedComponents(tasks);
    expect(components).toHaveLength(2);
    const ids = components.map((c) => c.map((t) => t.id).sort());
    expect(ids).toContainEqual(['reg-1', 'reg-2']);
    expect(ids).toContainEqual(['del-1', 'del-2']);
  });

  it('symmetrizes one-way relations (Blocked-by without Blocking still connects)', () => {
    // Notion's dual-sync can drift; we treat relations as undirected.
    const tasks = [
      makeTask({ id: 'a' }),  // no Blocking
      makeTask({ id: 'b', blockedBy: ['a'] }),
    ];
    const components = findConnectedComponents(tasks);
    expect(components).toHaveLength(1);
  });
});

// ─── pickSeed ───────────────────────────────────────────────────────────────

describe('pickSeed', () => {
  it('picks the most recently edited task', () => {
    const tasks = [
      makeTask({ id: 'a', lastEditedTime: '2026-05-10T10:00:00.000Z' }),
      makeTask({ id: 'b', lastEditedTime: '2026-05-12T10:00:00.000Z' }),
      makeTask({ id: 'c', lastEditedTime: '2026-05-11T10:00:00.000Z' }),
    ];
    expect(pickSeed(tasks).id).toBe('b');
  });

  it('tie-breaks on largest Reference→Dates delta when last_edited_time ties', () => {
    const tasks = [
      makeTask({ id: 'small', lastEditedTime: '2026-05-12T10:00:00.000Z', refEnd: '2026-04-02', datesEnd: '2026-04-04' }), // 2-day delta
      makeTask({ id: 'big',   lastEditedTime: '2026-05-12T10:00:00.000Z', refEnd: '2026-04-02', datesEnd: '2026-04-20' }), // 18-day delta
    ];
    expect(pickSeed(tasks).id).toBe('big');
  });

  it('tertiary tie-break on alphabetical task id when both timestamp and delta tie', () => {
    const tasks = [
      makeTask({ id: 'zzz', lastEditedTime: '2026-05-12T10:00:00.000Z', refEnd: '2026-04-02', datesEnd: '2026-04-04' }),
      makeTask({ id: 'aaa', lastEditedTime: '2026-05-12T10:00:00.000Z', refEnd: '2026-04-02', datesEnd: '2026-04-04' }),
    ];
    expect(pickSeed(tasks).id).toBe('aaa');
  });

  it('skips frozen tasks (Done/N/A) and picks the next non-frozen', () => {
    const tasks = [
      makeTask({ id: 'frozen', lastEditedTime: '2026-05-12T10:00:00.000Z', status: 'Done' }),
      makeTask({ id: 'active', lastEditedTime: '2026-05-10T10:00:00.000Z', status: 'In Progress' }),
    ];
    expect(pickSeed(tasks).id).toBe('active');
  });

  it('returns null when all tasks are frozen', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'Done' }),
      makeTask({ id: 'b', status: 'N/A' }),
    ];
    expect(pickSeed(tasks)).toBe(null);
  });
});

// ─── synthesizeWebhookPayload + parseWebhookPayload meta-test ───────────────

describe('synthesizeWebhookPayload', () => {
  it('produces a payload that parseWebhookPayload accepts (meta-test)', () => {
    const task = makeTask({ id: 'task-1', refStart: '2026-04-01', refEnd: '2026-04-05', datesStart: '2026-04-01', datesEnd: '2026-04-10' });
    const payload = synthesizeWebhookPayload(task, 'real-actor-uuid');
    const parsed = parseWebhookPayload(payload);
    expect(parsed.skip).toBe(false);
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.taskName).toBe('Task');
    expect(parsed.studyId).toBe('study-1');
    // The delta between Reference (04-05) and Dates (04-10) is 5 calendar days,
    // which the engine will translate to a business-day delta.
    expect(parsed.endDelta).not.toBe(0);
  });

  it('embeds last_edited_by with the supplied actor user id + type=person', () => {
    const task = makeTask({ id: 'task-1' });
    const payload = synthesizeWebhookPayload(task, 'actor-id-123');
    expect(payload.body.data.last_edited_by).toEqual({ id: 'actor-id-123', type: 'person' });
  });
});

// ─── classifyWebhookResponse ────────────────────────────────────────────────

describe('classifyWebhookResponse', () => {
  it('classifies 200 as applied', () => {
    expect(classifyWebhookResponse({ ok: true, status: 200, body: '' })).toEqual({ kind: 'applied' });
  });

  it('classifies 401 as auth_error (run-abort signal)', () => {
    expect(classifyWebhookResponse({ ok: false, status: 401, body: 'Unauthorized' })).toEqual({ kind: 'auth_error' });
  });

  it('classifies 403 as auth_error', () => {
    expect(classifyWebhookResponse({ ok: false, status: 403, body: 'Forbidden' })).toEqual({ kind: 'auth_error' });
  });

  it('classifies 500 as transient (operator-retry signal)', () => {
    expect(classifyWebhookResponse({ ok: false, status: 500, body: 'oops' })).toEqual({ kind: 'transient' });
  });

  it('classifies 400 as engine_error with truncated body', () => {
    const body = 'a'.repeat(500);
    const result = classifyWebhookResponse({ ok: false, status: 400, body });
    expect(result.kind).toBe('engine_error');
    expect(result.status).toBe(400);
    expect(result.body.length).toBe(200);
  });
});

// ─── diagnoseStudy ──────────────────────────────────────────────────────────

describe('diagnoseStudy', () => {
  it('reports zero divergent when all tasks have aligned Reference and Dates', async () => {
    const client = {
      queryDatabase: vi.fn().mockResolvedValue([
        makeTask({ id: 'a' }),
        makeTask({ id: 'b' }),
      ]),
    };
    const report = await diagnoseStudy({ client, studyTasksDbId: 'db-1', studyPageId: 'study-1', studyName: 'Test' });
    expect(report.divergentCount).toBe(0);
    expect(report.components).toEqual([]);
  });

  it('reports 3 divergent tasks across 2 chains (the multi-chain case)', async () => {
    const client = {
      queryDatabase: vi.fn().mockResolvedValue([
        // Chain 1: 2 divergent tasks (linked)
        makeTask({ id: 'reg-1', blocking: ['reg-2'], datesEnd: '2026-04-10' }), // divergent
        makeTask({ id: 'reg-2', blockedBy: ['reg-1'], datesEnd: '2026-04-15' }), // divergent
        // Chain 2: 1 divergent task (linked to non-divergent)
        makeTask({ id: 'del-1', blocking: ['del-2'] }), // aligned
        makeTask({ id: 'del-2', blockedBy: ['del-1'], datesEnd: '2026-04-12' }), // divergent
        // Unrelated aligned task
        makeTask({ id: 'iso-1' }),
      ]),
    };
    const report = await diagnoseStudy({ client, studyTasksDbId: 'db-1', studyPageId: 'study-1', studyName: 'Multi-chain' });
    expect(report.divergentCount).toBe(3);
    expect(report.components).toHaveLength(2);
  });

  it('marks a component as skipped:all_frozen_component when all divergent tasks are frozen', async () => {
    const client = {
      queryDatabase: vi.fn().mockResolvedValue([
        makeTask({ id: 'a', datesEnd: '2026-04-10', status: 'Done' }), // divergent + frozen
        makeTask({ id: 'b', blockedBy: ['a'], datesEnd: '2026-04-15', status: 'N/A' }), // divergent + frozen
      ]),
    };
    const report = await diagnoseStudy({ client, studyTasksDbId: 'db-1', studyPageId: 'study-1', studyName: 'All frozen' });
    expect(report.divergentCount).toBe(2);
    expect(report.components).toHaveLength(1);
    expect(report.components[0].skipped).toBe('all_frozen_component');
    expect(report.components[0].seedTaskId).toBe(null);
  });
});

// ─── run() — pre-flight env-var checks ──────────────────────────────────────

describe('run() pre-flight env validation', () => {
  it('exits 3 with missing_webhook_secret when --apply but no WEBHOOK_SECRET', async () => {
    const result = await run({
      apply: true,
      confirmNotified: true,
      env: { BACKFILL_ACTOR_USER_ID: 'actor-id' },
      clientFactory: async () => { throw new Error('should not reach client'); },
    });
    expect(result.exitCode).toBe(3);
    expect(result.error.code).toBe('missing_webhook_secret');
  });

  it('exits 3 with missing_backfill_actor when --apply but no BACKFILL_ACTOR_USER_ID', async () => {
    const result = await run({
      apply: true,
      confirmNotified: true,
      env: { WEBHOOK_SECRET: 'secret' },
      clientFactory: async () => { throw new Error('should not reach client'); },
    });
    expect(result.exitCode).toBe(3);
    expect(result.error.code).toBe('missing_backfill_actor');
  });

  it('exits 3 with missing_notification_confirmation when --apply but not --confirm-notified', async () => {
    const result = await run({
      apply: true,
      confirmNotified: false,
      env: { WEBHOOK_SECRET: 'secret', BACKFILL_ACTOR_USER_ID: 'actor-id' },
      clientFactory: async () => { throw new Error('should not reach client'); },
    });
    expect(result.exitCode).toBe(3);
    expect(result.error.code).toBe('missing_notification_confirmation');
  });

  it('does NOT validate env vars in diagnose-only mode (read-only is always safe)', async () => {
    const result = await run({
      apply: false,
      env: {},
      clientFactory: async () => ({
        queryDatabase: vi.fn().mockResolvedValue([makeTask({ id: 'a' })]),
      }),
      studyFilter: 'study-1',
    });
    expect(result.exitCode).toBe(2); // no divergence
  });
});

// ─── run() — diagnose-only end-to-end ───────────────────────────────────────

describe('run() diagnose-only', () => {
  it('returns exit 2 when no studies have divergence', async () => {
    const result = await run({
      apply: false,
      env: {},
      clientFactory: async () => ({
        queryDatabase: vi.fn().mockResolvedValue([
          makeTask({ id: 'a' }),
          makeTask({ id: 'b' }),
        ]),
      }),
      studyFilter: 'study-1',
    });
    expect(result.exitCode).toBe(2);
    expect(result.state).toBe('no_divergence');
  });

  it('returns exit 0 + diagnose report when divergence found', async () => {
    const result = await run({
      apply: false,
      env: {},
      clientFactory: async () => ({
        queryDatabase: vi.fn().mockResolvedValue([
          makeTask({ id: 'a', datesEnd: '2026-04-10' }), // divergent
        ]),
      }),
      studyFilter: 'study-1',
    });
    expect(result.exitCode).toBe(0);
    expect(result.state).toBe('diagnose_only');
    expect(result.studies).toHaveLength(1);
    expect(result.studies[0].divergentCount).toBe(1);
  });
});

// ─── run() — apply end-to-end (mocked fetch) ────────────────────────────────

describe('run() apply mode', () => {
  it('aborts the whole run on 401 from engine', async () => {
    const divergentTask = makeTask({ id: 'a', datesEnd: '2026-04-10' });
    const result = await run({
      apply: true,
      confirmNotified: true,
      env: { WEBHOOK_SECRET: 'bad-secret', BACKFILL_ACTOR_USER_ID: 'actor-id' },
      clientFactory: async () => ({
        queryDatabase: vi.fn().mockResolvedValue([divergentTask]),
        getPage: vi.fn().mockResolvedValue(divergentTask),
      }),
      studyFilter: 'study-1',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }),
    });
    // Auth failure is exit 3 (usage/config) per the documented exit code
    // table — operator must fix WEBHOOK_SECRET before re-running. Distinct
    // from exit 1 (partial apply failure) so agents can route differently.
    expect(result.exitCode).toBe(3);
    expect(result.state).toBe('auth_error');
    expect(result.error.code).toBe('webhook_auth_failed');
  });

  it('reports partial state when some replays fail (non-auth error)', async () => {
    const divergentTask = makeTask({ id: 'a', datesEnd: '2026-04-10' });
    const result = await run({
      apply: true,
      confirmNotified: true,
      env: { WEBHOOK_SECRET: 'secret', BACKFILL_ACTOR_USER_ID: 'actor-id' },
      clientFactory: async () => ({
        queryDatabase: vi.fn().mockResolvedValue([divergentTask]),
        getPage: vi.fn().mockResolvedValue(divergentTask),
      }),
      studyFilter: 'study-1',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'engine rejected payload',
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.state).toBe('partial');
  }, 10_000); // 5s throttle between components → may take a few seconds

  it('reports success when all components apply cleanly', async () => {
    const divergentTask = makeTask({ id: 'a', datesEnd: '2026-04-10' });
    const result = await run({
      apply: true,
      confirmNotified: true,
      env: { WEBHOOK_SECRET: 'secret', BACKFILL_ACTOR_USER_ID: 'actor-id' },
      clientFactory: async () => ({
        queryDatabase: vi.fn().mockResolvedValue([divergentTask]),
        getPage: vi.fn().mockResolvedValue(divergentTask),
      }),
      studyFilter: 'study-1',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.state).toBe('success');
    expect(result.components[0].outcome).toBe('applied');
  }, 10_000);
});

// ─── pollActivityLog ────────────────────────────────────────────────────────

describe('pollActivityLog', () => {
  // Activity Log entries returned by Notion's queryDatabase are keyed by
  // property NAME in the `properties` object (Notion's response shape), even
  // when the filter is sent by .id. That's why our makeEntry helper keys by
  // AL.STATUS.name / AL.SUMMARY.name, matching what the script reads back.
  function makeEntry({
    id = 'log-1',
    status = 'Success',
    summary = 'Cascade completed',
    createdTime = '2026-05-13T21:15:30.000Z',
  } = {}) {
    return {
      id,
      created_time: createdTime,
      properties: {
        [AL.STATUS.name]: { id: AL.STATUS.id, type: 'status', status: { name: status } },
        [AL.SUMMARY.name]: { id: AL.SUMMARY.id, type: 'rich_text', rich_text: [{ plain_text: summary }] },
      },
    };
  }

  it('queries Activity Log with the correct property + filter shapes', async () => {
    // Regression: this filter was previously { property: 'Source Task ID',
    // rich_text: { equals: ... } } which produced Notion 400s in production
    // (no such property). Now keyed by ACTIVITY_LOG_PROPS.STUDY_TASKS.id
    // with relation/contains, matching how the engine writes the same
    // property in src/services/activity-log.js.
    const queryMock = vi.fn().mockResolvedValue([makeEntry()]);
    await pollActivityLog({
      client: { queryDatabase: queryMock },
      activityLogDbId: 'log-db',
      studyPageId: 'study-1',
      sourceTaskId: 'task-1',
      startedAt: '2026-05-13T21:14:00.000Z',
      timeoutMs: 1000,
      intervalMs: 10,
      sleepImpl: async () => {},
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith('log-db', {
      and: [
        { property: AL.WORKFLOW.id, select: { equals: 'Date Cascade' } },
        { property: AL.STUDY_TASKS.id, relation: { contains: 'task-1' } },
        { timestamp: 'created_time', created_time: { on_or_after: '2026-05-13T21:14:00.000Z' } },
      ],
    });
  });

  it("returns the entry's status lowercased + snake-cased, with summary text", async () => {
    const result = await pollActivityLog({
      client: { queryDatabase: vi.fn().mockResolvedValue([
        makeEntry({ status: 'No Shifts', summary: 'Nothing to shift' }),
      ]) },
      activityLogDbId: 'log-db',
      sourceTaskId: 'task-1',
      timeoutMs: 1000,
      intervalMs: 10,
      sleepImpl: async () => {},
    });
    expect(result).toEqual({ status: 'no_shifts', summary: 'Nothing to shift' });
  });

  it('picks the most-recent entry when Notion returns matches out of order', async () => {
    const older = makeEntry({ id: 'a', status: 'Failed', summary: 'old', createdTime: '2026-05-13T21:10:00.000Z' });
    const newer = makeEntry({ id: 'b', status: 'Success', summary: 'new', createdTime: '2026-05-13T21:15:00.000Z' });
    const result = await pollActivityLog({
      client: { queryDatabase: vi.fn().mockResolvedValue([older, newer]) },
      activityLogDbId: 'log-db',
      sourceTaskId: 'task-1',
      timeoutMs: 1000,
      intervalMs: 10,
      sleepImpl: async () => {},
    });
    expect(result).toEqual({ status: 'success', summary: 'new' });
  });

  it('falls back to select.name when Status is a select (legacy schema variant)', async () => {
    // The engine writes Status as a `status`-type property today, but
    // pollActivityLog accepts both `status` and `select` shapes for
    // forward/back compatibility. Lock that fallback in.
    const entry = makeEntry();
    entry.properties[AL.STATUS.name] = { type: 'select', select: { name: 'Success' } };
    const result = await pollActivityLog({
      client: { queryDatabase: vi.fn().mockResolvedValue([entry]) },
      activityLogDbId: 'log-db',
      sourceTaskId: 'task-1',
      timeoutMs: 1000,
      intervalMs: 10,
      sleepImpl: async () => {},
    });
    expect(result.status).toBe('success');
  });

  it('throws an error with code=poll_timeout when no entries appear before deadline', async () => {
    const queryMock = vi.fn().mockResolvedValue([]);
    await expect(pollActivityLog({
      client: { queryDatabase: queryMock },
      activityLogDbId: 'log-db',
      sourceTaskId: 'task-1',
      timeoutMs: 50,
      intervalMs: 10,
      sleepImpl: async () => {},
    })).rejects.toMatchObject({ code: 'poll_timeout' });
    expect(queryMock).toHaveBeenCalled();
  });
});
