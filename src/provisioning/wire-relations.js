/**
 * wire-relations — post-creation patching of parent and dependency relations
 * that couldn't be resolved inline during task creation.
 *
 * Ported from n8n Code node in PH1 Inception WF-1: Create & Wire.
 *   "Build remaining patches" — merge WF-2 (parents) + WF-3 (deps) logic
 */

import { STUDY_TASKS_PROPS } from '../notion/property-names.js';

// ── main export ────────────────────────────────────────────────────────────

/**
 * Wire remaining parent and dependency relations via post-creation patches.
 *
 * Resolves template IDs to production IDs using the idMapping from createStudyTasks,
 * then patches the newly created pages with the correct relation properties.
 *
 * @param {import('../notion/client.js').NotionClient} client
 * @param {{ idMapping: Record<string, string>, depTracking: Array<{ templateId: string, resolvedBlockedByIds: string[], unresolvedBlockedByTemplateIds: string[] }>, parentTracking: Array<{ templateId: string, templateParentId: string }>, tracer?: import('../services/cascade-tracer.js').CascadeTracer }} options
 * @returns {Promise<{ parentsPatchedCount: number, depsPatchedCount: number }>}
 */
export async function wireRemainingRelations(client, { idMapping, depTracking, parentTracking, tracer }) {
  if (tracer) tracer.startPhase('wireRemainingRelations');

  const parentPatches = [];
  const depPatches = [];

  // ── Parent patches (from WF-2 logic) ──────────────────────────────────
  // Should be ~0 with inline BFS resolution, but handles edge cases
  for (const entry of parentTracking) {
    const newTaskId = idMapping[entry.templateId];
    const newParentId = idMapping[entry.templateParentId];
    if (!newTaskId || !newParentId) continue;

    parentPatches.push({
      taskId: newTaskId,
      properties: {
        [STUDY_TASKS_PROPS.PARENT_TASK.id]: { relation: [{ id: newParentId }] },
      },
    });
  }

  // ── Dep patches (from WF-3 logic) ─────────────────────────────────────
  // Same-level deps that couldn't resolve inline because blocker IDs didn't exist yet
  for (const dep of depTracking) {
    const unresolvedTemplateIds = dep.unresolvedBlockedByTemplateIds || [];
    if (unresolvedTemplateIds.length === 0) continue;

    const newTaskId = idMapping[dep.templateId];
    if (!newTaskId) continue;

    const newlyResolved = [];
    for (const bid of unresolvedTemplateIds) {
      const newId = idMapping[bid];
      if (newId) newlyResolved.push(newId);
    }
    if (newlyResolved.length === 0) continue;

    // Merge with already-set IDs from inline resolution, deduplicate
    const alreadySetIds = dep.resolvedBlockedByIds || [];
    const allIds = [...new Set([...alreadySetIds, ...newlyResolved])];

    depPatches.push({
      taskId: newTaskId,
      properties: {
        [STUDY_TASKS_PROPS.BLOCKED_BY.id]: { relation: allIds.map((id) => ({ id })) },
      },
    });
  }

  // ── Execute patches ───────────────────────────────────────────────────
  const allPatches = [...parentPatches, ...depPatches];

  if (allPatches.length > 0) {
    await client.patchPages(allPatches, {
      tracer,
      workersPerToken: 10,
    });
  }

  if (tracer) tracer.endPhase('wireRemainingRelations');

  return {
    parentsPatchedCount: parentPatches.length,
    depsPatchedCount: depPatches.length,
  };
}
