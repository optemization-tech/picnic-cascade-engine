import { describe, it, expect, vi } from 'vitest';
import { createStudyTasks } from '../../src/provisioning/create-tasks.js';
import {
  STUDY_TASKS_PROPS as ST,
  BLUEPRINT_PROPS as BP,
} from '../../src/notion/property-names.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal task object matching the shape produced by buildTaskTree().
 *
 * Mock fixture is Blueprint-shaped — properties keyed by `.name`, with `.id`
 * embedded inside each value so production's `findById` resolves correctly.
 */
function taskEntry(id, name, {
  parentId = null,
  blockedByIds = [],
  sDateOffset = 0,
  eDateOffset = 5,
  icon = null,
  status = null,
  owner = [],
  tags = [],
  milestone = [],
  ownerRole = null,
  externalVisibility = null,
  taskInstructions = [],
} = {}) {
  return {
    id,
    _templateId: id,
    _templateParentId: parentId,
    _taskName: name,
    _templateIcon: icon,
    _templateBlockedBy: blockedByIds,
    properties: {
      [BP.TASK_NAME.name]:           { id: BP.TASK_NAME.id,           type: 'title',        title: [{ text: { content: name } }] },
      [BP.PARENT_TASK.name]:         { id: BP.PARENT_TASK.id,         type: 'relation',     relation: parentId ? [{ id: parentId }] : [] },
      [BP.BLOCKED_BY.name]:          { id: BP.BLOCKED_BY.id,          type: 'relation',     relation: blockedByIds.map((bid) => ({ id: bid })) },
      [BP.SDATE_OFFSET.name]:        { id: BP.SDATE_OFFSET.id,        type: 'number',       number: sDateOffset },
      [BP.EDATE_OFFSET.name]:        { id: BP.EDATE_OFFSET.id,        type: 'number',       number: eDateOffset },
      // Note: 'Status' is on Study Tasks, but Blueprint pages can carry one too;
      // production reads via STUDY_TASKS_PROPS.STATUS.id (id-keyed reshape), so embed `.id`.
      [ST.STATUS.name]:              status ? { id: ST.STATUS.id, type: 'status', status: { name: status } } : { id: ST.STATUS.id, type: 'status', status: null },
      [BP.OWNER.name]:               { id: BP.OWNER.id,               type: 'people',       people: owner },
      [BP.TAGS.name]:                { id: BP.TAGS.id,                type: 'multi_select', multi_select: tags.map((t) => ({ name: t })) },
      [BP.MILESTONE.name]:           { id: BP.MILESTONE.id,           type: 'multi_select', multi_select: milestone.map((m) => ({ name: m })) },
      [BP.OWNER_ROLE.name]:          { id: BP.OWNER_ROLE.id,          type: 'select',       select: ownerRole ? { name: ownerRole } : null },
      [BP.EXTERNAL_VISIBILITY.name]: { id: BP.EXTERNAL_VISIBILITY.id, type: 'select',       select: externalVisibility ? { name: externalVisibility } : null },
      // Task Instructions is not a renamed property and not currently in the
      // constants module's surface; leaving as bare string until follow-up adds it.
      'Task Instructions':           { relation: taskInstructions.map((r) => ({ id: r })) },
    },
  };
}

/**
 * Build levels array in the shape produced by buildTaskTree().
 */
function buildLevels(...levelDefs) {
  return levelDefs.map((tasks, i) => ({
    level: i,
    tasks,
    isLastLevel: i === levelDefs.length - 1,
  }));
}

/**
 * Create a mock client whose request() returns a fake Notion page with Template Source ID.
 * Keeps a log of all POST calls for assertion.
 *
 * After U2, production writes Template Source ID by `.id`, so the body
 * inspection looks up by `[ST.TEMPLATE_SOURCE_ID.id]`. The echo-response is
 * Notion-shaped (name-keyed with `.id` inside the value).
 */
function mockClient({ createdPageIdFn } = {}) {
  let callCount = 0;
  const postCalls = [];

  const client = {
    optimalBatchSize: 50,
    postCalls,
    request: vi.fn(async (method, path, body) => {
      if (method === 'POST' && path === '/pages') {
        postCalls.push(body);
        callCount++;
        // Echo back Template Source ID so content-based join works
        const templateId = body.properties?.[ST.TEMPLATE_SOURCE_ID.id]?.rich_text?.[0]?.text?.content;
        const newId = createdPageIdFn ? createdPageIdFn(templateId, callCount) : `prod-${callCount}`;
        return {
          id: newId,
          properties: {
            [ST.TEMPLATE_SOURCE_ID.name]: {
              id: ST.TEMPLATE_SOURCE_ID.id,
              type: 'rich_text',
              rich_text: [{ text: { content: templateId }, plain_text: templateId }],
            },
          },
        };
      }
      return {};
    }),
    createPages: vi.fn(async (pageBodies) => Promise.all(
      pageBodies.map((pageBody) => client.request('POST', '/pages', pageBody)),
    )),
  };

  return client;
}

/** Standard options for createStudyTasks */
const baseOptions = {
  studyPageId: 'study-001',
  contractSignDate: '2026-03-30', // Monday
  blueprintDbId: 'bp-db-1',
  studyTasksDbId: 'tasks-db-1',
};

// ── Date calculation ───────────────────────────────────────────────────────

describe('createStudyTasks — date calculation', () => {
  it('calculates start/end dates from contract sign date + offsets (business days)', async () => {
    // contractSignDate = 2026-03-30 (Mon)
    // SDate Offset = 0 -> 2026-03-30 (Mon)
    // EDate Offset = 5 -> 5 business days forward -> 2026-04-06 (Mon)
    const levels = buildLevels([taskEntry('t1', 'Task 1', { sDateOffset: 0, eDateOffset: 5 })]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties[ST.DATES.id].date.start).toBe('2026-03-30');
    expect(body.properties[ST.DATES.id].date.end).toBe('2026-04-06');
    expect(body.properties[ST.REF_START.id].date.start).toBe('2026-03-30');
    expect(body.properties[ST.REF_END.id].date.start).toBe('2026-04-06');
  });

  it('uses business days (skips weekends)', async () => {
    // contractSignDate = 2026-03-30 (Mon)
    // SDate Offset = 5 -> 5 BDs = 2026-04-06 (Mon)
    // EDate Offset = 10 -> 10 BDs = 2026-04-13 (Mon)
    const levels = buildLevels([taskEntry('t1', 'Task 1', { sDateOffset: 5, eDateOffset: 10 })]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties[ST.DATES.id].date.start).toBe('2026-04-06');
    expect(body.properties[ST.DATES.id].date.end).toBe('2026-04-13');
  });

  it('snaps zero-offset weekend to next business day', async () => {
    // contractSignDate = 2026-04-04 (Saturday)
    // SDate Offset = 0 -> snaps to next business day = 2026-04-06 (Mon)
    // EDate Offset = 2 -> 2 BDs forward from Sat = 2026-04-07 (Tue)
    const levels = buildLevels([taskEntry('t1', 'Task 1', { sDateOffset: 0, eDateOffset: 2 })]);
    const client = mockClient();

    await createStudyTasks(client, levels, {
      ...baseOptions,
      contractSignDate: '2026-04-04', // Saturday
    });

    const body = client.postCalls[0];
    expect(body.properties[ST.DATES.id].date.start).toBe('2026-04-06'); // Mon (snapped)
    expect(body.properties[ST.DATES.id].date.end).toBe('2026-04-07'); // Tue (2 BDs from Sat)
  });
});

// ── Null stripping ─────────────────────────────────────────────────────────

describe('createStudyTasks — null stripping', () => {
  it('omits optional properties when they are empty/null', async () => {
    const levels = buildLevels([taskEntry('t1', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    // Required properties are always present
    expect(body.properties[ST.TASK_NAME.id]).toBeDefined();
    expect(body.properties[ST.DATES.id]).toBeDefined();
    expect(body.properties[ST.STUDY.id]).toBeDefined();
    expect(body.properties[ST.TEMPLATE_SOURCE_ID.id]).toBeDefined();
    // Automation Reporting is written id-keyed in create-tasks (only client.reportStatus is the by-name carve-out).
    expect(body.properties[ST.AUTOMATION_REPORTING.id]).toBeDefined();

    // Optional properties should NOT be present when empty
    expect(body.properties[ST.STATUS.id]).toBeUndefined();
    expect(body.properties[ST.OWNER.id]).toBeUndefined();
    expect(body.properties[ST.TAGS.id]).toBeUndefined();
    expect(body.properties[ST.MILESTONE.id]).toBeUndefined();
    expect(body.properties[ST.OWNER_ROLE.id]).toBeUndefined();
    expect(body.properties[ST.EXTERNAL_VISIBILITY.id]).toBeUndefined();
    expect(body.properties['Task Instructions']).toBeUndefined();
    expect(body.properties[ST.BLOCKED_BY.id]).toBeUndefined();
    expect(body.properties[ST.PARENT_TASK.id]).toBeUndefined();
  });

  it('includes optional properties when they have values', async () => {
    const levels = buildLevels([
      taskEntry('t1', 'Task 1', {
        status: 'Not Started',
        owner: [{ id: 'user-1' }],
        tags: ['urgent', 'launch'],
        milestone: ['Phase 1'],
        ownerRole: 'PM',
        externalVisibility: 'Visible',
        taskInstructions: ['instr-1'],
        icon: { type: 'emoji', emoji: '🚀' },
      }),
    ]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties[ST.STATUS.id]).toEqual({ status: { name: 'Not Started' } });
    expect(body.properties[ST.OWNER.id]).toEqual({ people: [{ object: 'user', id: 'user-1' }] });
    expect(body.properties[ST.TAGS.id]).toEqual({ multi_select: [{ name: 'urgent' }, { name: 'launch' }] });
    expect(body.properties[ST.MILESTONE.id]).toEqual({ multi_select: [{ name: 'Phase 1' }] });
    expect(body.properties[ST.OWNER_ROLE.id]).toEqual({ select: { name: 'PM' } });
    expect(body.properties[ST.EXTERNAL_VISIBILITY.id]).toEqual({ select: { name: 'Visible' } });
    expect(body.properties['Task Instructions']).toEqual({ relation: [{ id: 'instr-1' }] });
    expect(body.icon).toEqual({ type: 'emoji', emoji: '🚀' });
  });
});

// ── Skip tasks with null offsets ───────────────────────────────────────────

describe('createStudyTasks — null offset skipping', () => {
  it('skips tasks with null SDate Offset', async () => {
    const task = taskEntry('t1', 'Task 1');
    task.properties[BP.SDATE_OFFSET.name] = { id: BP.SDATE_OFFSET.id, type: 'number', number: null };
    const levels = buildLevels([task]);
    const client = mockClient();

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(client.postCalls).toHaveLength(0);
    expect(result.totalCreated).toBe(0);
  });

  it('skips tasks with null EDate Offset', async () => {
    const task = taskEntry('t1', 'Task 1');
    task.properties[BP.EDATE_OFFSET.name] = { id: BP.EDATE_OFFSET.id, type: 'number', number: null };
    const levels = buildLevels([task]);
    const client = mockClient();

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(client.postCalls).toHaveLength(0);
    expect(result.totalCreated).toBe(0);
  });

  it('creates tasks with valid offsets alongside skipped ones', async () => {
    const validTask = taskEntry('t1', 'Valid', { sDateOffset: 0, eDateOffset: 5 });
    const nullTask = taskEntry('t2', 'Null');
    nullTask.properties[BP.SDATE_OFFSET.name] = { id: BP.SDATE_OFFSET.id, type: 'number', number: null };

    const levels = buildLevels([validTask, nullTask]);
    const client = mockClient();

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(client.postCalls).toHaveLength(1);
    expect(result.totalCreated).toBe(1);
    expect(result.idMapping).toHaveProperty('t1');
    expect(result.idMapping).not.toHaveProperty('t2');
  });
});

// ── Inline dependency resolution ───────────────────────────────────────────

describe('createStudyTasks — dependency tracking', () => {
  it('tracks blueprint-to-blueprint blockers for the later patch phase', async () => {
    const levels = buildLevels(
      [taskEntry('t-blocker', 'Blocker')],
      [taskEntry('t-dep', 'Dependent', { blockedByIds: ['t-blocker'] })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    const depBody = client.postCalls[1];
    expect(depBody.properties[ST.BLOCKED_BY.id]).toBeUndefined();
    expect(result.depTracking).toEqual([
      {
        templateId: 't-dep',
        resolvedBlockedByIds: [],
        unresolvedBlockedByTemplateIds: ['t-blocker'],
      },
    ]);
  });

  it('still writes blockers inline when they come from existingIdMapping', async () => {
    const levels = buildLevels([
      taskEntry('t-dep', 'Dependent', { blockedByIds: ['existing-task', 'missing-task'] }),
    ]);
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, {
      ...baseOptions,
      existingIdMapping: { 'existing-task': 'prod-existing-task' },
    });

    const depBody = client.postCalls[0];
    expect(depBody.properties[ST.BLOCKED_BY.id]).toEqual({
      relation: [{ id: 'prod-existing-task' }],
    });
    expect(result.depTracking).toEqual([
      {
        templateId: 't-dep',
        resolvedBlockedByIds: ['prod-existing-task'],
        unresolvedBlockedByTemplateIds: ['missing-task'],
      },
    ]);
  });

  it('tracks fully unresolved deps when no mapping exists yet', async () => {
    const levels = buildLevels([
      taskEntry('t-dep', 'Dependent', { blockedByIds: ['t-missing'] }),
    ]);
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties[ST.BLOCKED_BY.id]).toBeUndefined();
    expect(result.depTracking).toEqual([
      {
        templateId: 't-dep',
        resolvedBlockedByIds: [],
        unresolvedBlockedByTemplateIds: ['t-missing'],
      },
    ]);
  });
});

// ── Parent tracking ────────────────────────────────────────────────────────

describe('createStudyTasks — parent tracking', () => {
  it('tracks blueprint-to-blueprint parents for the later patch phase', async () => {
    const levels = buildLevels(
      [taskEntry('t-parent', 'Parent')],
      [taskEntry('t-child', 'Child', { parentId: 't-parent' })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    const childBody = client.postCalls[1];
    expect(childBody.properties[ST.PARENT_TASK.id]).toBeUndefined();
    expect(result.parentTracking).toEqual([
      {
        templateId: 't-child',
        templateParentId: 't-parent',
      },
    ]);
  });

  it('writes parent inline when it already exists in existingIdMapping', async () => {
    const levels = buildLevels([
      taskEntry('t-child', 'Child', { parentId: 'existing-parent' }),
    ]);
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, {
      ...baseOptions,
      existingIdMapping: { 'existing-parent': 'prod-existing-parent' },
    });

    const body = client.postCalls[0];
    expect(body.properties[ST.PARENT_TASK.id]).toEqual({
      relation: [{ id: 'prod-existing-parent' }],
    });
    expect(result.parentTracking).toEqual([]);
  });
});

// ── Content-based ID accumulation ──────────────────────────────────────────

describe('createStudyTasks — content-based ID accumulation', () => {
  it('builds idMapping from Template Source ID on created pages', async () => {
    const levels = buildLevels([
      taskEntry('tpl-aaa', 'Task A'),
      taskEntry('tpl-bbb', 'Task B'),
    ]);
    const client = mockClient({
      createdPageIdFn: (templateId) => `new-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(result.idMapping).toEqual({
      'tpl-aaa': 'new-tpl-aaa',
      'tpl-bbb': 'new-tpl-bbb',
    });
    expect(result.totalCreated).toBe(2);
  });

  it('uses plain_text fallback when text.content is not available', async () => {
    const levels = buildLevels([taskEntry('tpl-x', 'Task X')]);
    const client = {
      optimalBatchSize: 50,
      postCalls: [],
      request: vi.fn(async (method, path, body) => {
        client.postCalls.push(body);
        return {
          id: 'prod-x',
          properties: {
            [ST.TEMPLATE_SOURCE_ID.name]: {
              id: ST.TEMPLATE_SOURCE_ID.id,
              type: 'rich_text',
              rich_text: [{ plain_text: 'tpl-x' }],
            },
          },
        };
      }),
    };
    client.createPages = vi.fn(async (pageBodies) => Promise.all(
      pageBodies.map((pageBody) => client.request('POST', '/pages', pageBody)),
    ));

    const result = await createStudyTasks(client, levels, baseOptions);
    expect(result.idMapping).toEqual({ 'tpl-x': 'prod-x' });
  });
});

// ── Global create pass ─────────────────────────────────────────────────────

describe('createStudyTasks — global create pass', () => {
  it('creates every task in one client createPages call across multiple levels', async () => {
    const levels = buildLevels(
      [taskEntry('root', 'Root')],
      [taskEntry('child', 'Child', { parentId: 'root' })],
      [taskEntry('grandchild', 'Grandchild', { parentId: 'child' })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(result.totalCreated).toBe(3);
    expect(client.createPages).toHaveBeenCalledTimes(1);
    expect(client.postCalls).toHaveLength(3);
    expect(Object.keys(result.idMapping)).toHaveLength(3);
    expect(result.parentTracking).toEqual([
      { templateId: 'child', templateParentId: 'root' },
      { templateId: 'grandchild', templateParentId: 'child' },
    ]);
  });
});

// ── depTracking and parentTracking output ──────────────────────────────────

describe('createStudyTasks — tracking output', () => {
  it('returns correct shape with empty levels', async () => {
    const client = mockClient();

    const result = await createStudyTasks(client, [], baseOptions);

    expect(result).toEqual({
      idMapping: {},
      totalCreated: 0,
      depTracking: [],
      parentTracking: [],
    });
  });

  it('accumulates depTracking only for unresolved deps', async () => {
    // t-b depends on one new blueprint task and two external IDs.
    // None of them are available inline, so all three should be tracked for the
    // later patch phase.
    const levels = buildLevels([
      taskEntry('t-a', 'Task A'),
      taskEntry('t-b', 'Task B', { blockedByIds: ['t-a', 't-ext1', 't-ext2'] }),
    ]);
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(result.depTracking.length).toBeGreaterThan(0);
    const bTracking = result.depTracking.find((d) => d.templateId === 't-b');
    expect(bTracking).toBeDefined();
    expect(bTracking.unresolvedBlockedByTemplateIds).toContain('t-a');
    expect(bTracking.unresolvedBlockedByTemplateIds).toContain('t-ext1');
    expect(bTracking.unresolvedBlockedByTemplateIds).toContain('t-ext2');
  });

  it('accumulates parentTracking only for unresolved parents', async () => {
    // Level 0: t-orphan has parent t-external (not in tree)
    // Level 0: t-root has no parent
    const levels = buildLevels([
      taskEntry('t-root', 'Root'),
      taskEntry('t-orphan', 'Orphan', { parentId: 't-external' }),
    ]);
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(result.parentTracking).toHaveLength(1);
    expect(result.parentTracking[0]).toEqual({
      templateId: 't-orphan',
      templateParentId: 't-external',
    });
  });
});

// ── Core property mapping ──────────────────────────────────────────────────

describe('createStudyTasks — property mapping', () => {
  it('sets Study relation to studyPageId', async () => {
    const levels = buildLevels([taskEntry('t1', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties[ST.STUDY.id]).toEqual({ relation: [{ id: 'study-001' }] });
  });

  it('sets parent database_id to studyTasksDbId', async () => {
    const levels = buildLevels([taskEntry('t1', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.parent).toEqual({ database_id: 'tasks-db-1' });
  });

  it('sets Template Source ID to the template page ID', async () => {
    const levels = buildLevels([taskEntry('tpl-abc-123', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties[ST.TEMPLATE_SOURCE_ID.id]).toEqual({
      rich_text: [{ type: 'text', text: { content: 'tpl-abc-123' } }],
    });
  });

  it('sets Automation Reporting log entry with template ID and dates', async () => {
    const levels = buildLevels([taskEntry('abcdef12-xxxx', 'Task 1', { sDateOffset: 0, eDateOffset: 5 })]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    // Automation Reporting is written id-keyed in create-tasks (the by-name carve-out is client.reportStatus).
    const reportingText = body.properties[ST.AUTOMATION_REPORTING.id].rich_text[0].text.content;
    expect(reportingText).toContain('Inception v4');
    expect(reportingText).toContain('abcdef12'); // first 8 chars of template ID
    expect(reportingText).toContain('2026-03-30');
    expect(reportingText).toContain('2026-04-06');
  });

  it('maps Owner people correctly with object/id shape', async () => {
    const levels = buildLevels([
      taskEntry('t1', 'Task 1', { owner: [{ id: 'user-a' }, { id: 'user-b' }] }),
    ]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties[ST.OWNER.id]).toEqual({
      people: [
        { object: 'user', id: 'user-a' },
        { object: 'user', id: 'user-b' },
      ],
    });
  });
});

// ── Tracer integration ─────────────────────────────────────────────────────

describe('createStudyTasks — extraTags merging', () => {
  it('merges extraTags into the page body Tags property', async () => {
    const levels = buildLevels([taskEntry('t1', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, {
      ...baseOptions,
      extraTags: ['Manual Workstream / Item'],
    });

    const body = client.postCalls[0];
    expect(body.properties[ST.TAGS.id]).toEqual({
      multi_select: [{ name: 'Manual Workstream / Item' }],
    });
  });

  it('preserves blueprint tags alongside extraTags', async () => {
    const levels = buildLevels([
      taskEntry('t1', 'Task 1', { tags: ['blueprint-a', 'blueprint-b'] }),
    ]);
    const client = mockClient();

    await createStudyTasks(client, levels, {
      ...baseOptions,
      extraTags: ['Manual Workstream / Item'],
    });

    const body = client.postCalls[0];
    expect(body.properties[ST.TAGS.id]).toEqual({
      multi_select: [
        { name: 'blueprint-a' },
        { name: 'blueprint-b' },
        { name: 'Manual Workstream / Item' },
      ],
    });
  });

  it('dedups when blueprint tag coincides with an extraTag', async () => {
    const levels = buildLevels([
      taskEntry('t1', 'Task 1', { tags: ['Manual Workstream / Item', 'other'] }),
    ]);
    const client = mockClient();

    await createStudyTasks(client, levels, {
      ...baseOptions,
      extraTags: ['Manual Workstream / Item'],
    });

    const body = client.postCalls[0];
    // "Manual Workstream / Item" appears exactly once, not twice.
    expect(body.properties[ST.TAGS.id]).toEqual({
      multi_select: [
        { name: 'Manual Workstream / Item' },
        { name: 'other' },
      ],
    });
  });

  it('omits Tags property when both blueprint tags and extraTags are empty', async () => {
    const levels = buildLevels([taskEntry('t1', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, { ...baseOptions, extraTags: [] });

    const body = client.postCalls[0];
    expect(body.properties[ST.TAGS.id]).toBeUndefined();
  });

  it('defaults extraTags to [] when omitted from options (no regression on existing callers)', async () => {
    const levels = buildLevels([
      taskEntry('t1', 'Task 1', { tags: ['only-blueprint'] }),
    ]);
    const client = mockClient();

    // Omit extraTags entirely — baseOptions doesn't include it.
    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties[ST.TAGS.id]).toEqual({
      multi_select: [{ name: 'only-blueprint' }],
    });
  });

  it('applies extraTags to every task in the subtree', async () => {
    const levels = buildLevels(
      [taskEntry('t-root', 'Root')],
      [taskEntry('t-child', 'Child', { parentId: 't-root' })],
      [taskEntry('t-grandchild', 'Grandchild', { parentId: 't-child' })],
    );
    const client = mockClient();

    await createStudyTasks(client, levels, {
      ...baseOptions,
      extraTags: ['Manual Workstream / Item'],
    });

    expect(client.postCalls).toHaveLength(3);
    for (const body of client.postCalls) {
      expect(body.properties[ST.TAGS.id]).toEqual({
        multi_select: [{ name: 'Manual Workstream / Item' }],
      });
    }
  });
});

describe('createStudyTasks — contractSignDate validation', () => {
  it('throws when contractSignDate is undefined (defense in depth for future callers)', async () => {
    const client = mockClient();
    const { contractSignDate, ...optsWithoutDate } = baseOptions;

    await expect(
      createStudyTasks(client, [], optsWithoutDate),
    ).rejects.toThrow(/contractSignDate is required/);
  });

  it('throws when contractSignDate is null', async () => {
    const client = mockClient();

    await expect(
      createStudyTasks(client, [], { ...baseOptions, contractSignDate: null }),
    ).rejects.toThrow(/contractSignDate is required/);
  });

  it('throws when contractSignDate is empty string', async () => {
    const client = mockClient();

    await expect(
      createStudyTasks(client, [], { ...baseOptions, contractSignDate: '' }),
    ).rejects.toThrow(/contractSignDate is required/);
  });
});

describe('createStudyTasks — tracer', () => {
  it('calls tracer startPhase/endPhase', async () => {
    const phases = [];
    const tracer = {
      startPhase(name) { phases.push(`start:${name}`); },
      endPhase(name) { phases.push(`end:${name}`); },
    };
    const client = mockClient();

    await createStudyTasks(client, [], { ...baseOptions, tracer });

    expect(phases).toEqual(['start:createStudyTasks', 'end:createStudyTasks']);
  });
});

// ── Batching ───────────────────────────────────────────────────────────────

describe('createStudyTasks — parallel page creation', () => {
  it('creates every page through the client parallel creation path', async () => {
    // Create 5 tasks with a batchSize of 2 — should be 3 batches
    const tasks = Array.from({ length: 5 }, (_, i) =>
      taskEntry(`t${i}`, `Task ${i}`),
    );
    const levels = buildLevels(tasks);

    const client = {
      optimalBatchSize: 2,
      request: vi.fn(async (method, path, body) => {
        const templateId = body.properties?.[ST.TEMPLATE_SOURCE_ID.id]?.rich_text?.[0]?.text?.content;
        return {
          id: `prod-${templateId}`,
          properties: {
            [ST.TEMPLATE_SOURCE_ID.name]: {
              id: ST.TEMPLATE_SOURCE_ID.id,
              type: 'rich_text',
              rich_text: [{ text: { content: templateId } }],
            },
          },
        };
      }),
    };
    client.createPages = vi.fn(async (pageBodies) => Promise.all(
      pageBodies.map((pageBody) => client.request('POST', '/pages', pageBody)),
    ));

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(result.totalCreated).toBe(5);
    expect(client.createPages).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledTimes(5);
  });
});
