import { STUDY_TASKS_PROPS } from '../notion/property-names.js';
import { MIGRATED_TASK_PROP, MIGRATED_TASK_PRODUCTION_RELATION_NAMES } from './constants.js';
import {
  titlePlain,
  multiSelectNames,
  selectName,
  relationIds,
  checkbox,
  dateStart,
} from './extract.js';
import { mapSourceMilestone } from './vocabulary.js';
import { jaccardTokens, normalizeName, stripParenSegment } from './normalize.js';

function productionTaskRelationIds(properties) {
  for (const name of MIGRATED_TASK_PRODUCTION_RELATION_NAMES) {
    const ids = relationIds(properties, name);
    if (ids.length >= 1) return ids;
  }
  return [];
}

/**
 * Build normalized-name → task id or array of ids when duplicate names exist.
 * @param {object[]} studyTaskPages
 * @returns {Map<string, string | string[]>}
 */
export function buildStudyTaskNameIndex(studyTaskPages) {
  const map = new Map();
  const propName = STUDY_TASKS_PROPS.TASK_NAME.name;
  for (const page of studyTaskPages) {
    const raw = titlePlain(page.properties, propName);
    const key = normalizeName(raw);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, page.id);
    } else {
      const cur = map.get(key);
      if (Array.isArray(cur)) cur.push(page.id);
      else map.set(key, [cur, page.id]);
    }
  }
  return map;
}

function resolveNameIndexLookup(map, key) {
  const v = map.get(key);
  if (!v) return { kind: 'none' };
  if (Array.isArray(v)) {
    if (v.length === 1) return { kind: 'one', id: v[0] };
    return { kind: 'many', ids: v };
  }
  return { kind: 'one', id: v };
}

export function filterTasksByCanonicalMilestone(studyTaskPages, canonical) {
  if (!canonical) return [];
  const mp = STUDY_TASKS_PROPS.MILESTONE.name;
  return studyTaskPages
    .filter((p) => (multiSelectNames(p.properties, mp)).includes(canonical))
    .map((p) => p.id);
}

/**
 * Match migrated row to cascade task (migrate-study §4b / §5a + optional Jaccard low tier).
 * @returns {{ cascadeId: string, source: string, tier: string } | null | { ambiguous: boolean }}
 */
export function resolveCascadeTwin({
  migratedProps,
  studyTaskPages,
  nameIndex,
  requireMilestoneTagForFallback,
  jaccardMin,
}) {
  const prodIds = productionTaskRelationIds(migratedProps);
  if (prodIds.length >= 1) {
    return { cascadeId: prodIds[0], source: 'pre-filled', tier: 'prefilled' };
  }

  const rawName = titlePlain(migratedProps, MIGRATED_TASK_PROP.NAME);
  const n = normalizeName(rawName);

  let lookup = resolveNameIndexLookup(nameIndex, n);
  if (lookup.kind === 'one') {
    return { cascadeId: lookup.id, source: 'name-matched', tier: 'high' };
  }
  if (lookup.kind === 'many') {
    return { ambiguous: true };
  }

  const parenKey = stripParenSegment(rawName);
  if (parenKey && parenKey !== n) {
    lookup = resolveNameIndexLookup(nameIndex, parenKey);
    if (lookup.kind === 'one') {
      return { cascadeId: lookup.id, source: 'name-matched', tier: 'medium' };
    }
    if (lookup.kind === 'many') {
      return { ambiguous: true };
    }
  }

  const tags = multiSelectNames(migratedProps, MIGRATED_TASK_PROP.TASK_TYPE_TAGS);
  const milestoneSelect = selectName(migratedProps, MIGRATED_TASK_PROP.MILESTONE);
  const useMilestoneFallback =
    (!requireMilestoneTagForFallback || tags.includes('Milestone')) && milestoneSelect;

  if (useMilestoneFallback) {
    const canonical = mapSourceMilestone(milestoneSelect);
    if (canonical) {
      const ids = filterTasksByCanonicalMilestone(studyTaskPages, canonical);
      if (ids.length === 1) {
        return { cascadeId: ids[0], source: 'milestone-fallback', tier: 'medium' };
      }
      if (ids.length > 1) {
        return { ambiguous: true };
      }
    }
  }

  let bestId = null;
  let bestScore = 0;
  const propName = STUDY_TASKS_PROPS.TASK_NAME.name;
  for (const page of studyTaskPages) {
    const tn = titlePlain(page.properties, propName);
    const score = jaccardTokens(rawName, tn);
    if (score > bestScore) {
      bestScore = score;
      bestId = page.id;
    }
  }

  if (bestId && bestScore >= jaccardMin) {
    let tie = false;
    for (const page of studyTaskPages) {
      if (page.id === bestId) continue;
      const tn = titlePlain(page.properties, propName);
      const score = jaccardTokens(rawName, tn);
      if (score >= jaccardMin && Math.abs(score - bestScore) < 1e-9) {
        tie = true;
        break;
      }
    }
    if (!tie) {
      return { cascadeId: bestId, source: 'low-tier', tier: 'low' };
    }
  }

  return null;
}

export function hasManualWorkstreamTag(properties) {
  return multiSelectNames(properties, STUDY_TASKS_PROPS.TAGS.name).includes('Manual Workstream / Item');
}

export function contributorCompletionDate(migratedProps) {
  const dc = dateStart(migratedProps, MIGRATED_TASK_PROP.DATE_COMPLETED);
  if (dc) return dc;
  return dateStart(migratedProps, MIGRATED_TASK_PROP.DUE_DATE);
}

export function isRepeatDeliveryRow(migratedProps) {
  return selectName(migratedProps, MIGRATED_TASK_PROP.MILESTONE) === 'Repeat Delivery';
}

export function isCompletedRow(migratedProps) {
  return checkbox(migratedProps, MIGRATED_TASK_PROP.COMPLETED);
}
