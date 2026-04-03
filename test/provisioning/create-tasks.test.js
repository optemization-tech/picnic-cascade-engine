import { describe, it, expect, vi } from 'vitest';
import { createStudyTasks } from '../../src/provisioning/create-tasks.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal task object matching the shape produced by buildTaskTree().
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
      'Task Name': { title: [{ text: { content: name } }] },
      'Parent Task': { relation: parentId ? [{ id: parentId }] : [] },
      'Blocked by': { relation: blockedByIds.map((bid) => ({ id: bid })) },
      'SDate Offset': { number: sDateOffset },
      'EDate Offset': { number: eDateOffset },
      'Status': status ? { status: { name: status } } : { status: null },
      'Owner': { people: owner },
      'Tags': { multi_select: tags.map((t) => ({ name: t })) },
      'Milestone': { multi_select: milestone.map((m) => ({ name: m })) },
      'Owner Role': ownerRole ? { select: { name: ownerRole } } : { select: null },
      'External Visibility': externalVisibility ? { select: { name: externalVisibility } } : { select: null },
      'Task Instructions': { relation: taskInstructions.map((r) => ({ id: r })) },
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
        const templateId = body.properties?.['Template Source ID']?.rich_text?.[0]?.text?.content;
        const newId = createdPageIdFn ? createdPageIdFn(templateId, callCount) : `prod-${callCount}`;
        return {
          id: newId,
          properties: {
            'Template Source ID': {
              rich_text: [{ text: { content: templateId }, plain_text: templateId }],
            },
          },
        };
      }
      return {};
    }),
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
    expect(body.properties['Dates'].date.start).toBe('2026-03-30');
    expect(body.properties['Dates'].date.end).toBe('2026-04-06');
    expect(body.properties['Reference Start Date'].date.start).toBe('2026-03-30');
    expect(body.properties['Reference End Date'].date.start).toBe('2026-04-06');
  });

  it('uses business days (skips weekends)', async () => {
    // contractSignDate = 2026-03-30 (Mon)
    // SDate Offset = 5 -> 5 BDs = 2026-04-06 (Mon)
    // EDate Offset = 10 -> 10 BDs = 2026-04-13 (Mon)
    const levels = buildLevels([taskEntry('t1', 'Task 1', { sDateOffset: 5, eDateOffset: 10 })]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties['Dates'].date.start).toBe('2026-04-06');
    expect(body.properties['Dates'].date.end).toBe('2026-04-13');
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
    expect(body.properties['Dates'].date.start).toBe('2026-04-06'); // Mon (snapped)
    expect(body.properties['Dates'].date.end).toBe('2026-04-07'); // Tue (2 BDs from Sat)
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
    expect(body.properties['Task Name']).toBeDefined();
    expect(body.properties['Dates']).toBeDefined();
    expect(body.properties['Study']).toBeDefined();
    expect(body.properties['Template Source ID']).toBeDefined();
    expect(body.properties['Last Modified By System']).toBeDefined();
    expect(body.properties['Automation Reporting']).toBeDefined();

    // Optional properties should NOT be present when empty
    expect(body.properties['Status']).toBeUndefined();
    expect(body.properties['Owner']).toBeUndefined();
    expect(body.properties['Tags']).toBeUndefined();
    expect(body.properties['Milestone']).toBeUndefined();
    expect(body.properties['Owner Role']).toBeUndefined();
    expect(body.properties['External Visibility']).toBeUndefined();
    expect(body.properties['Task Instructions']).toBeUndefined();
    expect(body.properties['Blocked by']).toBeUndefined();
    expect(body.properties['Parent Task']).toBeUndefined();
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
    expect(body.properties['Status']).toEqual({ status: { name: 'Not Started' } });
    expect(body.properties['Owner']).toEqual({ people: [{ object: 'user', id: 'user-1' }] });
    expect(body.properties['Tags']).toEqual({ multi_select: [{ name: 'urgent' }, { name: 'launch' }] });
    expect(body.properties['Milestone']).toEqual({ multi_select: [{ name: 'Phase 1' }] });
    expect(body.properties['Owner Role']).toEqual({ select: { name: 'PM' } });
    expect(body.properties['External Visibility']).toEqual({ select: { name: 'Visible' } });
    expect(body.properties['Task Instructions']).toEqual({ relation: [{ id: 'instr-1' }] });
    expect(body.icon).toEqual({ type: 'emoji', emoji: '🚀' });
  });
});

// ── Skip tasks with null offsets ───────────────────────────────────────────

describe('createStudyTasks — null offset skipping', () => {
  it('skips tasks with null SDate Offset', async () => {
    const task = taskEntry('t1', 'Task 1');
    task.properties['SDate Offset'] = { number: null };
    const levels = buildLevels([task]);
    const client = mockClient();

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(client.postCalls).toHaveLength(0);
    expect(result.totalCreated).toBe(0);
  });

  it('skips tasks with null EDate Offset', async () => {
    const task = taskEntry('t1', 'Task 1');
    task.properties['EDate Offset'] = { number: null };
    const levels = buildLevels([task]);
    const client = mockClient();

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(client.postCalls).toHaveLength(0);
    expect(result.totalCreated).toBe(0);
  });

  it('creates tasks with valid offsets alongside skipped ones', async () => {
    const validTask = taskEntry('t1', 'Valid', { sDateOffset: 0, eDateOffset: 5 });
    const nullTask = taskEntry('t2', 'Null');
    nullTask.properties['SDate Offset'] = { number: null };

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

describe('createStudyTasks — inline dependency resolution', () => {
  it('resolves blocked-by when blocker was created in a previous level', async () => {
    // Level 0: blocker (t-blocker)
    // Level 1: dependent (t-dep) blocked by t-blocker
    const levels = buildLevels(
      [taskEntry('t-blocker', 'Blocker')],
      [taskEntry('t-dep', 'Dependent', { blockedByIds: ['t-blocker'] })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    // Dependent's body should include resolved Blocked by
    const depBody = client.postCalls[1];
    expect(depBody.properties['Blocked by']).toEqual({
      relation: [{ id: 'prod-t-blocker' }],
    });
    expect(result.depTracking).toHaveLength(0);
  });

  it('splits into resolved and unresolved when only some blockers are known', async () => {
    // Level 0: t-a is created
    // Level 1: t-dep blocked by [t-a, t-unknown]
    const levels = buildLevels(
      [taskEntry('t-a', 'Task A')],
      [taskEntry('t-dep', 'Dependent', { blockedByIds: ['t-a', 't-unknown'] })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    // Resolved blocker included in body
    const depBody = client.postCalls[1];
    expect(depBody.properties['Blocked by']).toEqual({
      relation: [{ id: 'prod-t-a' }],
    });

    // Unresolved tracked for WF-2 patching
    expect(result.depTracking).toHaveLength(1);
    expect(result.depTracking[0].templateId).toBe('t-dep');
    expect(result.depTracking[0].resolvedBlockedByIds).toEqual(['prod-t-a']);
    expect(result.depTracking[0].unresolvedBlockedByTemplateIds).toEqual(['t-unknown']);
  });

  it('tracks fully unresolved deps (blocker not yet created)', async () => {
    // Single level: t-dep blocked by t-missing (not in any level)
    const levels = buildLevels(
      [taskEntry('t-dep', 'Dependent', { blockedByIds: ['t-missing'] })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    // No Blocked by in body
    const body = client.postCalls[0];
    expect(body.properties['Blocked by']).toBeUndefined();

    // All unresolved
    expect(result.depTracking).toHaveLength(1);
    expect(result.depTracking[0].unresolvedBlockedByTemplateIds).toEqual(['t-missing']);
  });
});

// ── Inline parent resolution ───────────────────────────────────────────────

describe('createStudyTasks — inline parent resolution', () => {
  it('resolves parent when it was created in a previous level', async () => {
    const levels = buildLevels(
      [taskEntry('t-parent', 'Parent')],
      [taskEntry('t-child', 'Child', { parentId: 't-parent' })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    const childBody = client.postCalls[1];
    expect(childBody.properties['Parent Task']).toEqual({
      relation: [{ id: 'prod-t-parent' }],
    });
    expect(result.parentTracking).toHaveLength(0);
  });

  it('tracks unresolved parent for post-loop patching', async () => {
    // t-child has parent t-missing (not in any level)
    const levels = buildLevels(
      [taskEntry('t-child', 'Child', { parentId: 't-missing' })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties['Parent Task']).toBeUndefined();

    expect(result.parentTracking).toHaveLength(1);
    expect(result.parentTracking[0].templateId).toBe('t-child');
    expect(result.parentTracking[0].templateParentId).toBe('t-missing');
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
            'Template Source ID': {
              rich_text: [{ plain_text: 'tpl-x' }],
            },
          },
        };
      }),
    };

    const result = await createStudyTasks(client, levels, baseOptions);
    expect(result.idMapping).toEqual({ 'tpl-x': 'prod-x' });
  });
});

// ── Level-by-level progressive resolution ──────────────────────────────────

describe('createStudyTasks — level-by-level progressive resolution', () => {
  it('level 0 creates parents, level 1 resolves them as Parent Task', async () => {
    // 3 levels: root -> child -> grandchild
    const levels = buildLevels(
      [taskEntry('root', 'Root')],
      [taskEntry('child', 'Child', { parentId: 'root' })],
      [taskEntry('grandchild', 'Grandchild', { parentId: 'child' })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    // All 3 created
    expect(result.totalCreated).toBe(3);
    expect(Object.keys(result.idMapping)).toHaveLength(3);

    // Child should have resolved parent to Root
    const childBody = client.postCalls[1];
    expect(childBody.properties['Parent Task']).toEqual({
      relation: [{ id: 'prod-root' }],
    });

    // Grandchild should have resolved parent to Child
    const grandchildBody = client.postCalls[2];
    expect(grandchildBody.properties['Parent Task']).toEqual({
      relation: [{ id: 'prod-child' }],
    });

    // Nothing unresolved
    expect(result.parentTracking).toHaveLength(0);
    expect(result.depTracking).toHaveLength(0);
  });

  it('resolves deps progressively across levels', async () => {
    // Level 0: A (blocker)
    // Level 1: B (blocker, blocked by A), C (blocked by A)
    // Level 2: D (blocked by B and C)
    const levels = buildLevels(
      [taskEntry('a', 'Task A')],
      [
        taskEntry('b', 'Task B', { blockedByIds: ['a'] }),
        taskEntry('c', 'Task C', { blockedByIds: ['a'] }),
      ],
      [taskEntry('d', 'Task D', { blockedByIds: ['b', 'c'] })],
    );
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    // B body: Blocked by [prod-a]
    const bBody = client.postCalls[1];
    expect(bBody.properties['Blocked by']).toEqual({
      relation: [{ id: 'prod-a' }],
    });

    // D body: Blocked by [prod-b, prod-c]
    const dBody = client.postCalls[3];
    expect(dBody.properties['Blocked by']).toEqual({
      relation: [{ id: 'prod-b' }, { id: 'prod-c' }],
    });

    expect(result.depTracking).toHaveLength(0);
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
    // Level 0: t-a created
    // Level 0: t-b blocked by [t-a, t-ext1, t-ext2]
    // t-a resolves but t-ext1/t-ext2 are external (not in tree)
    const levels = buildLevels([
      taskEntry('t-a', 'Task A'),
      taskEntry('t-b', 'Task B', { blockedByIds: ['t-a', 't-ext1', 't-ext2'] }),
    ]);
    const client = mockClient({
      createdPageIdFn: (templateId) => `prod-${templateId}`,
    });

    const result = await createStudyTasks(client, levels, baseOptions);

    // t-a was created before t-b in the same batch, but since they are in
    // the same level, t-a's prod ID is NOT yet in idMapping when t-b's body
    // is built. So t-a will also be unresolved at build time.
    // (idMapping is only populated AFTER the batch completes.)
    expect(result.depTracking.length).toBeGreaterThan(0);
    const bTracking = result.depTracking.find((d) => d.templateId === 't-b');
    expect(bTracking).toBeDefined();
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
    expect(body.properties['Study']).toEqual({ relation: [{ id: 'study-001' }] });
  });

  it('sets parent database_id to studyTasksDbId', async () => {
    const levels = buildLevels([taskEntry('t1', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.parent).toEqual({ database_id: 'tasks-db-1' });
  });

  it('sets Last Modified By System to true', async () => {
    const levels = buildLevels([taskEntry('t1', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties['Last Modified By System']).toEqual({ checkbox: true });
  });

  it('sets Template Source ID to the template page ID', async () => {
    const levels = buildLevels([taskEntry('tpl-abc-123', 'Task 1')]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    expect(body.properties['Template Source ID']).toEqual({
      rich_text: [{ type: 'text', text: { content: 'tpl-abc-123' } }],
    });
  });

  it('sets Automation Reporting log entry with template ID and dates', async () => {
    const levels = buildLevels([taskEntry('abcdef12-xxxx', 'Task 1', { sDateOffset: 0, eDateOffset: 5 })]);
    const client = mockClient();

    await createStudyTasks(client, levels, baseOptions);

    const body = client.postCalls[0];
    const reportingText = body.properties['Automation Reporting'].rich_text[0].text.content;
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
    expect(body.properties['Owner']).toEqual({
      people: [
        { object: 'user', id: 'user-a' },
        { object: 'user', id: 'user-b' },
      ],
    });
  });
});

// ── Tracer integration ─────────────────────────────────────────────────────

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

describe('createStudyTasks — batching', () => {
  it('respects client.optimalBatchSize for parallel batches', async () => {
    // Create 5 tasks with a batchSize of 2 — should be 3 batches
    const tasks = Array.from({ length: 5 }, (_, i) =>
      taskEntry(`t${i}`, `Task ${i}`),
    );
    const levels = buildLevels(tasks);

    // Track timing of requests to verify batching
    const requestTimes = [];
    const client = {
      optimalBatchSize: 2,
      request: vi.fn(async (method, path, body) => {
        requestTimes.push(Date.now());
        const templateId = body.properties?.['Template Source ID']?.rich_text?.[0]?.text?.content;
        return {
          id: `prod-${templateId}`,
          properties: {
            'Template Source ID': { rich_text: [{ text: { content: templateId } }] },
          },
        };
      }),
    };

    const result = await createStudyTasks(client, levels, baseOptions);

    expect(result.totalCreated).toBe(5);
    expect(client.request).toHaveBeenCalledTimes(5);
  });
});
