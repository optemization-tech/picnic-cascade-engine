import { describe, it, expect } from 'vitest';
import { fetchBlueprint, buildTaskTree, filterBlueprintSubtree } from '../../src/provisioning/blueprint.js';
import { BLUEPRINT_PROPS as BP } from '../../src/notion/property-names.js';

/**
 * Helper: build a minimal Notion page object resembling a Blueprint task.
 *
 * Mock fixtures key by `.name` (matches Notion's actual response shape) and
 * embed `.id` inside each value so production's `findById` resolves correctly.
 */
function blueprintPage(id, name, { parentId = null, blockedByIds = [], icon = null } = {}) {
  return {
    id,
    icon,
    properties: {
      [BP.TASK_NAME.name]:    { id: BP.TASK_NAME.id,    type: 'title',    title: [{ text: { content: name } }] },
      [BP.PARENT_TASK.name]:  { id: BP.PARENT_TASK.id,  type: 'relation', relation: parentId ? [{ id: parentId }] : [] },
      [BP.BLOCKED_BY.name]:   { id: BP.BLOCKED_BY.id,   type: 'relation', relation: blockedByIds.map((bid) => ({ id: bid })) },
      [BP.SDATE_OFFSET.name]: { id: BP.SDATE_OFFSET.id, type: 'number',   number: 0 },
      [BP.EDATE_OFFSET.name]: { id: BP.EDATE_OFFSET.id, type: 'number',   number: 0 },
    },
  };
}

// ── fetchBlueprint ──────────────────────────────────────────────────────────

describe('fetchBlueprint', () => {
  it('calls client.queryDatabase and returns raw pages', async () => {
    const pages = [blueprintPage('t1', 'Setup')];
    const calls = [];
    const client = {
      async queryDatabase(dbId, filter, pageSize) {
        calls.push({ dbId, filter, pageSize });
        return pages;
      },
    };

    const result = await fetchBlueprint(client, 'bp-db-1', {});
    expect(result).toEqual(pages);
    expect(calls).toHaveLength(1);
    expect(calls[0].dbId).toBe('bp-db-1');
    expect(calls[0].pageSize).toBe(100);
  });

  it('uses tracer when provided', async () => {
    const phases = [];
    const tracer = {
      startPhase(name) { phases.push(`start:${name}`); },
      endPhase(name) { phases.push(`end:${name}`); },
    };
    const client = {
      async queryDatabase() { return []; },
    };

    await fetchBlueprint(client, 'bp-db-1', { tracer });
    expect(phases).toEqual(['start:fetchBlueprint', 'end:fetchBlueprint']);
  });
});

// ── buildTaskTree ───────────────────────────────────────────────────────────

describe('buildTaskTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildTaskTree([])).toEqual([]);
    expect(buildTaskTree(null)).toEqual([]);
    expect(buildTaskTree(undefined)).toEqual([]);
  });

  it('assigns root tasks to level 0', () => {
    const pages = [
      blueprintPage('r1', 'Root 1'),
      blueprintPage('r2', 'Root 2'),
    ];

    const tree = buildTaskTree(pages);
    expect(tree).toHaveLength(1);
    expect(tree[0].level).toBe(0);
    expect(tree[0].tasks).toHaveLength(2);
    expect(tree[0].isLastLevel).toBe(true);
    expect(tree[0].tasks[0]._taskName).toBe('Root 1');
    expect(tree[0].tasks[1]._taskName).toBe('Root 2');
  });

  it('assigns BFS levels: roots=0, children=1, grandchildren=2', () => {
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('child-a', 'Child A', { parentId: 'root' }),
      blueprintPage('child-b', 'Child B', { parentId: 'root' }),
      blueprintPage('grandchild', 'Grandchild', { parentId: 'child-a' }),
    ];

    const tree = buildTaskTree(pages);
    expect(tree).toHaveLength(3);

    expect(tree[0].level).toBe(0);
    expect(tree[0].tasks.map((t) => t._taskName)).toEqual(['Root']);
    expect(tree[0].isLastLevel).toBe(false);

    expect(tree[1].level).toBe(1);
    expect(tree[1].tasks.map((t) => t._taskName)).toContain('Child A');
    expect(tree[1].tasks.map((t) => t._taskName)).toContain('Child B');
    expect(tree[1].isLastLevel).toBe(false);

    expect(tree[2].level).toBe(2);
    expect(tree[2].tasks.map((t) => t._taskName)).toEqual(['Grandchild']);
    expect(tree[2].isLastLevel).toBe(true);
  });

  it('sets _templateId, _templateParentId, _level, _templateBlockedBy, _taskName, _templateIcon on each task', () => {
    const pages = [
      blueprintPage('root', 'Root', { icon: { type: 'emoji', emoji: '📋' } }),
      blueprintPage('child', 'Child', { parentId: 'root' }),
    ];

    const tree = buildTaskTree(pages);
    const root = tree[0].tasks[0];
    expect(root._templateId).toBe('root');
    expect(root._templateParentId).toBeNull();
    expect(root._level).toBe(0);
    expect(root._taskName).toBe('Root');
    expect(root._templateIcon).toEqual({ type: 'emoji', emoji: '📋' });
    expect(root._templateBlockedBy).toEqual([]);

    const child = tree[1].tasks[0];
    expect(child._templateId).toBe('child');
    expect(child._templateParentId).toBe('root');
    expect(child._level).toBe(1);
  });

  it('topologically sorts within a level: blockers before dependents', () => {
    // Three tasks at level 1: B blocks C, A is independent
    // Expected order after topo sort: A and B before C (B must precede C)
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('a', 'Task A', { parentId: 'root' }),
      blueprintPage('b', 'Task B', { parentId: 'root' }),
      blueprintPage('c', 'Task C', { parentId: 'root', blockedByIds: ['b'] }),
    ];

    const tree = buildTaskTree(pages);
    const level1 = tree[1];
    const names = level1.tasks.map((t) => t._taskName);

    // B must come before C
    const bIndex = names.indexOf('Task B');
    const cIndex = names.indexOf('Task C');
    expect(bIndex).toBeLessThan(cIndex);
  });

  it('handles chain of blockers at same level: D blocks C blocks B', () => {
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('b', 'Task B', { parentId: 'root', blockedByIds: ['c'] }),
      blueprintPage('c', 'Task C', { parentId: 'root', blockedByIds: ['d'] }),
      blueprintPage('d', 'Task D', { parentId: 'root' }),
    ];

    const tree = buildTaskTree(pages);
    const level1 = tree[1];
    const names = level1.tasks.map((t) => t._taskName);

    // D before C, C before B
    expect(names.indexOf('Task D')).toBeLessThan(names.indexOf('Task C'));
    expect(names.indexOf('Task C')).toBeLessThan(names.indexOf('Task B'));
  });

  it('falls back to original order when a cycle exists', () => {
    // A blocks B, B blocks A -- cycle
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('a', 'Task A', { parentId: 'root', blockedByIds: ['b'] }),
      blueprintPage('b', 'Task B', { parentId: 'root', blockedByIds: ['a'] }),
    ];

    const tree = buildTaskTree(pages);
    const level1 = tree[1];
    // Should not crash, should have both tasks (original order preserved)
    expect(level1.tasks).toHaveLength(2);
    expect(level1.tasks.map((t) => t._taskName)).toEqual(['Task A', 'Task B']);
  });

  it('ignores blocked-by relations across levels (only same-level topo sort)', () => {
    // child-b at level 1 is blocked-by grandchild at level 2 -- cross-level, should be ignored
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('child-a', 'Child A', { parentId: 'root' }),
      blueprintPage('child-b', 'Child B', { parentId: 'root', blockedByIds: ['grandchild'] }),
      blueprintPage('grandchild', 'Grandchild', { parentId: 'child-a' }),
    ];

    const tree = buildTaskTree(pages);
    // Should not crash; topo sort at level 1 ignores the cross-level dep
    expect(tree).toHaveLength(3);
    expect(tree[1].tasks).toHaveLength(2);
  });

  it('returns empty array when all tasks have parents but no root exists', () => {
    // All tasks have parent relations pointing to non-existent tasks
    const pages = [
      blueprintPage('a', 'Task A', { parentId: 'missing-parent' }),
      blueprintPage('b', 'Task B', { parentId: 'missing-parent' }),
    ];

    const tree = buildTaskTree(pages);
    expect(tree).toEqual([]);
  });

  it('handles task name from plain_text fallback', () => {
    const page = {
      id: 't1',
      icon: null,
      properties: {
        [BP.TASK_NAME.name]:   { id: BP.TASK_NAME.id,   type: 'title',    title: [{ plain_text: 'Fallback Name' }] },
        [BP.PARENT_TASK.name]: { id: BP.PARENT_TASK.id, type: 'relation', relation: [] },
        [BP.BLOCKED_BY.name]:  { id: BP.BLOCKED_BY.id,  type: 'relation', relation: [] },
      },
    };

    const tree = buildTaskTree([page]);
    expect(tree[0].tasks[0]._taskName).toBe('Fallback Name');
  });

  it('uses "Untitled" when task name is empty', () => {
    const page = {
      id: 't1',
      icon: null,
      properties: {
        [BP.TASK_NAME.name]:   { id: BP.TASK_NAME.id,   type: 'title',    title: [] },
        [BP.PARENT_TASK.name]: { id: BP.PARENT_TASK.id, type: 'relation', relation: [] },
        [BP.BLOCKED_BY.name]:  { id: BP.BLOCKED_BY.id,  type: 'relation', relation: [] },
      },
    };

    const tree = buildTaskTree([page]);
    expect(tree[0].tasks[0]._taskName).toBe('Untitled');
  });
});

// ── filterBlueprintSubtree ──────────────────────────────────────────────────

describe('filterBlueprintSubtree', () => {
  it('returns empty array for empty inputs', () => {
    expect(filterBlueprintSubtree([], ['foo'])).toEqual([]);
    expect(filterBlueprintSubtree(null, ['foo'])).toEqual([]);
    expect(filterBlueprintSubtree([blueprintPage('a', 'A')], [])).toEqual([]);
    expect(filterBlueprintSubtree([blueprintPage('a', 'A')], null)).toEqual([]);
  });

  it('returns only the matched parent and its descendants', () => {
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('a', 'Task A', { parentId: 'root' }),
      blueprintPage('b', 'Task B', { parentId: 'root' }),
      blueprintPage('a1', 'Task A1', { parentId: 'a' }),
      blueprintPage('b1', 'Task B1', { parentId: 'b' }),
    ];

    const result = filterBlueprintSubtree(pages, ['Task A']);
    const allNames = result.flatMap((lvl) => lvl.tasks.map((t) => t._taskName));

    expect(allNames).toContain('Task A');
    expect(allNames).toContain('Task A1');
    expect(allNames).not.toContain('Task B');
    expect(allNames).not.toContain('Task B1');
    expect(allNames).not.toContain('Root');
  });

  it('assigns levels relative to matched roots (root=0)', () => {
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('a', 'Task A', { parentId: 'root' }),
      blueprintPage('a1', 'Task A1', { parentId: 'a' }),
      blueprintPage('a1x', 'Task A1x', { parentId: 'a1' }),
    ];

    const result = filterBlueprintSubtree(pages, ['Task A']);
    expect(result).toHaveLength(3);
    expect(result[0].level).toBe(0);
    expect(result[0].tasks[0]._taskName).toBe('Task A');
    expect(result[1].level).toBe(1);
    expect(result[1].tasks[0]._taskName).toBe('Task A1');
    expect(result[2].level).toBe(2);
    expect(result[2].tasks[0]._taskName).toBe('Task A1x');
    expect(result[2].isLastLevel).toBe(true);
  });

  it('supports multiple parent names', () => {
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('a', 'Task A', { parentId: 'root' }),
      blueprintPage('b', 'Task B', { parentId: 'root' }),
      blueprintPage('a1', 'Task A1', { parentId: 'a' }),
      blueprintPage('b1', 'Task B1', { parentId: 'b' }),
    ];

    const result = filterBlueprintSubtree(pages, ['Task A', 'Task B']);
    const allNames = result.flatMap((lvl) => lvl.tasks.map((t) => t._taskName));

    expect(allNames).toContain('Task A');
    expect(allNames).toContain('Task A1');
    expect(allNames).toContain('Task B');
    expect(allNames).toContain('Task B1');
    // Root is not matched by name so should not be included
    expect(allNames).not.toContain('Root');
  });

  it('returns empty when no names match', () => {
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('a', 'Task A', { parentId: 'root' }),
    ];

    const result = filterBlueprintSubtree(pages, ['Nonexistent']);
    expect(result).toEqual([]);
  });

  it('uses first match when duplicate task names exist', () => {
    const pages = [
      blueprintPage('root', 'Root'),
      blueprintPage('a1', 'Dup Name', { parentId: 'root' }),
      blueprintPage('a2', 'Dup Name', { parentId: 'root' }),
      blueprintPage('child-of-a1', 'Child 1', { parentId: 'a1' }),
      blueprintPage('child-of-a2', 'Child 2', { parentId: 'a2' }),
    ];

    const result = filterBlueprintSubtree(pages, ['Dup Name']);
    const allNames = result.flatMap((lvl) => lvl.tasks.map((t) => t._taskName));

    // Should match first "Dup Name" (a1) and its child
    expect(allNames).toContain('Dup Name');
    expect(allNames).toContain('Child 1');
    // a2 and its child should not be included
    expect(allNames).not.toContain('Child 2');
  });
});
