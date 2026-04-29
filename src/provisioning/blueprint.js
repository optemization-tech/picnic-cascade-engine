/**
 * Blueprint — reads the Blueprint Notion DB and builds a BFS-leveled task tree
 * with topological ordering within each level (Kahn's algorithm).
 *
 * Ported from n8n Code nodes in PH1 Inception WF-1: Create & Wire.
 */

import { BLUEPRINT_PROPS, findById } from '../notion/property-names.js';

/**
 * Fetch all Blueprint tasks from the Notion database (paginated).
 *
 * @param {import('../notion/client.js').NotionClient} client
 * @param {string} blueprintDbId
 * @param {{ tracer?: import('../services/cascade-tracer.js').CascadeTracer }} options
 * @returns {Promise<object[]>} raw Notion page objects
 */
export async function fetchBlueprint(client, blueprintDbId, { tracer } = {}) {
  if (tracer) tracer.startPhase('fetchBlueprint');
  const results = await client.queryDatabase(blueprintDbId, undefined, 100, { tracer });
  if (tracer) tracer.endPhase('fetchBlueprint');
  return results;
}

/**
 * Parse a single Notion blueprint page into internal task fields.
 */
function parseTask(page) {
  const parentRelation = findById(page, BLUEPRINT_PROPS.PARENT_TASK)?.relation || [];
  const parentId = parentRelation.length > 0 ? parentRelation[0].id : null;
  const blockedByRelation = findById(page, BLUEPRINT_PROPS.BLOCKED_BY)?.relation || [];
  const blockedByIds = blockedByRelation.map((r) => r.id);
  const taskNameProp = findById(page, BLUEPRINT_PROPS.TASK_NAME);
  const taskName =
    taskNameProp?.title?.[0]?.text?.content ||
    taskNameProp?.title?.[0]?.plain_text ||
    'Untitled';

  return {
    ...page,
    _templateId: page.id,
    _templateParentId: parentId,
    _taskName: taskName,
    _templateIcon: page.icon || null,
    _templateBlockedBy: blockedByIds,
  };
}

/**
 * Build a BFS-leveled task tree with topological ordering within each level.
 *
 * Algorithm (faithfully ported from n8n Code node):
 *  1. Parse all blueprint tasks, extract id/parent/blocked-by/name/icon
 *  2. Root tasks (no parent) -> level 0, their children -> level 1, etc. (BFS queue)
 *  3. Within each level, Kahn's topological sort orders blockers before dependents
 *  4. Cycle fallback: if topo sort doesn't cover all tasks at a level, keep original order
 *  5. Output: one object per level with { level, tasks[], isLastLevel }
 *
 * @param {object[]} blueprintTasks - raw Notion page objects from fetchBlueprint
 * @returns {Array<{ level: number, tasks: object[], isLastLevel: boolean }>}
 */
export function buildTaskTree(blueprintTasks) {
  if (!blueprintTasks || blueprintTasks.length === 0) {
    return [];
  }

  // Parse all tasks and build lookup maps
  const taskById = {};
  const childrenByParentId = {};

  for (const page of blueprintTasks) {
    const task = parseTask(page);
    taskById[task._templateId] = task;

    if (task._templateParentId) {
      if (!childrenByParentId[task._templateParentId]) {
        childrenByParentId[task._templateParentId] = [];
      }
      childrenByParentId[task._templateParentId].push(task._templateId);
    }
  }

  // Find root tasks (no parent)
  const rootTaskIds = Object.keys(taskById).filter((id) => !taskById[id]._templateParentId);
  if (rootTaskIds.length === 0) {
    return [];
  }

  // BFS to assign levels
  const tasksByLevel = {};
  const queue = rootTaskIds.map((id) => ({ id, level: 0 }));

  while (queue.length > 0) {
    const { id, level } = queue.shift();
    if (!tasksByLevel[level]) {
      tasksByLevel[level] = [];
    }
    const task = taskById[id];
    task._level = level;
    tasksByLevel[level].push(task);
    const children = childrenByParentId[id] || [];
    for (const childId of children) {
      queue.push({ id: childId, level: level + 1 });
    }
  }

  // Topological sort within each level based on Blocked by relations
  // Ensures blockers are created before dependents, enabling inline dep resolution
  for (const level of Object.keys(tasksByLevel)) {
    const tasks = tasksByLevel[level];
    const levelTaskIds = new Set(tasks.map((t) => t._templateId));

    // Build adjacency: for each task, which same-level tasks block it?
    const inDegree = {};
    const dependents = {}; // blockerId -> [dependentIds]
    for (const task of tasks) {
      inDegree[task._templateId] = 0;
      dependents[task._templateId] = [];
    }

    for (const task of tasks) {
      for (const blockerId of task._templateBlockedBy) {
        if (levelTaskIds.has(blockerId)) {
          inDegree[task._templateId]++;
          dependents[blockerId].push(task._templateId);
        }
      }
    }

    // Kahn's algorithm
    const sorted = [];
    const ready = [];
    for (const task of tasks) {
      if (inDegree[task._templateId] === 0) {
        ready.push(task._templateId);
      }
    }

    while (ready.length > 0) {
      const id = ready.shift();
      sorted.push(id);
      for (const depId of dependents[id]) {
        inDegree[depId]--;
        if (inDegree[depId] === 0) {
          ready.push(depId);
        }
      }
    }

    // If sorted doesn't contain all tasks, there's a cycle -- fall back to original order
    if (sorted.length === tasks.length) {
      const taskLookup = {};
      for (const task of tasks) {
        taskLookup[task._templateId] = task;
      }
      tasksByLevel[level] = sorted.map((id) => taskLookup[id]);
    }
    // else: cycle detected, keep original order
  }

  const levels = Object.keys(tasksByLevel)
    .map(Number)
    .sort((a, b) => a - b);

  return levels.map((level) => ({
    level,
    tasks: tasksByLevel[level],
    isLastLevel: level === levels[levels.length - 1],
  }));
}

/**
 * Filter a blueprint to only include subtrees rooted at the given parent task names.
 * Used by the add-task-set route to create a subset of the blueprint.
 *
 * @param {object[]} blueprintTasks - raw Notion page objects from fetchBlueprint
 * @param {string[]} parentTaskNames - task names to match as subtree roots
 * @returns {Array<{ level: number, tasks: object[], isLastLevel: boolean }>}
 */
export function filterBlueprintSubtree(blueprintTasks, parentTaskNames) {
  if (!blueprintTasks || blueprintTasks.length === 0 || !parentTaskNames || parentTaskNames.length === 0) {
    return [];
  }

  // Parse all tasks
  const taskById = {};
  const childrenByParentId = {};

  for (const page of blueprintTasks) {
    const task = parseTask(page);
    taskById[task._templateId] = task;

    if (task._templateParentId) {
      if (!childrenByParentId[task._templateParentId]) {
        childrenByParentId[task._templateParentId] = [];
      }
      childrenByParentId[task._templateParentId].push(task._templateId);
    }
  }

  // Match parent task names (first match by name)
  const matchedRootIds = [];
  const usedNames = new Set();
  for (const name of parentTaskNames) {
    if (usedNames.has(name)) continue;
    const match = Object.values(taskById).find((t) => t._taskName === name);
    if (match) {
      matchedRootIds.push(match._templateId);
      usedNames.add(name);
    }
  }

  if (matchedRootIds.length === 0) {
    return [];
  }

  // BFS from matched parents to collect entire subtrees
  const collectedIds = new Set();
  const queue = [...matchedRootIds];

  while (queue.length > 0) {
    const id = queue.shift();
    if (collectedIds.has(id)) continue;
    collectedIds.add(id);
    const children = childrenByParentId[id] || [];
    for (const childId of children) {
      queue.push(childId);
    }
  }

  // Filter to only collected tasks and build tree from them
  const filteredTasks = Array.from(collectedIds).map((id) => taskById[id]);

  // Re-run BFS for level assignment starting from matched roots (level 0)
  const tasksByLevel = {};
  const levelQueue = matchedRootIds.map((id) => ({ id, level: 0 }));
  const visited = new Set();

  while (levelQueue.length > 0) {
    const { id, level } = levelQueue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    if (!tasksByLevel[level]) {
      tasksByLevel[level] = [];
    }
    const task = taskById[id];
    task._level = level;
    tasksByLevel[level].push(task);

    const children = childrenByParentId[id] || [];
    for (const childId of children) {
      if (collectedIds.has(childId)) {
        levelQueue.push({ id: childId, level: level + 1 });
      }
    }
  }

  const levels = Object.keys(tasksByLevel)
    .map(Number)
    .sort((a, b) => a - b);

  return levels.map((level) => ({
    level,
    tasks: tasksByLevel[level],
    isLastLevel: level === levels[levels.length - 1],
  }));
}
