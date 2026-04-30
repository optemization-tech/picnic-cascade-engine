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
import { jaccardTokens, normalizeName, stripParenSegment, stripStudyPrefix } from './normalize.js';

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
 * Collect the set of cascade Milestone option labels actually used in this study.
 * Inputs to title-based milestone inference.
 */
export function collectCascadeMilestoneOptions(studyTaskPages) {
  const set = new Set();
  const mp = STUDY_TASKS_PROPS.MILESTONE.name;
  for (const page of studyTaskPages) {
    for (const m of multiSelectNames(page.properties, mp)) {
      if (m) set.add(m);
    }
  }
  return set;
}

/**
 * Infer a cascade Milestone canonical label from a task title by substring match
 * against the live cascade Milestone options. Used when a Migrated Task is tagged
 * `Task Type Tags ⊇ {Milestone}` but the source `Milestone` select is empty —
 * carryover often misses populating this field, so we read the title instead.
 *
 * Returns the longest matching option to prefer specific over generic
 * (e.g., "First Site Activated" beats "Last Site Activated" if both substring-match,
 * since longest-match wins).
 */
export function inferMilestoneFromTitle(title, milestoneOptions) {
  if (!title || !milestoneOptions || milestoneOptions.size === 0) return null;
  const t = title.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const opt of milestoneOptions) {
    const optLower = opt.toLowerCase();
    const escaped = optLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(t) && opt.length > bestLen) {
      best = opt;
      bestLen = opt.length;
    }
  }
  return best;
}

/**
 * Match migrated row to cascade task (migrate-study §4b / §5a + optional Jaccard low tier).
 *
 * `studyName` and `cascadeMilestoneOptions` enable two practical extensions:
 *   - `studyName` is stripped from the leading position of every source title
 *     before any tier runs (handles `🔶 Alexion PNH PLEDGE External Kickoff`).
 *   - When a row is `Task Type Tags ⊇ {Milestone}` but the source `Milestone`
 *     select is empty (carryover gap), the matcher infers the canonical
 *     milestone from the (stripped) title via `cascadeMilestoneOptions`.
 *
 * @returns {{ cascadeId: string, source: string, tier: string } | null | { ambiguous: boolean }}
 */
export function resolveCascadeTwin({
  migratedProps,
  studyTaskPages,
  nameIndex,
  requireMilestoneTagForFallback,
  jaccardMin,
  studyName,
  cascadeMilestoneOptions,
}) {
  const prodIds = productionTaskRelationIds(migratedProps);
  if (prodIds.length >= 1) {
    return { cascadeId: prodIds[0], source: 'pre-filled', tier: 'prefilled' };
  }

  const rawName = titlePlain(migratedProps, MIGRATED_TASK_PROP.NAME);
  const stripped = studyName ? stripStudyPrefix(rawName, studyName) : rawName;
  const n = normalizeName(stripped);

  let lookup = resolveNameIndexLookup(nameIndex, n);
  if (lookup.kind === 'one') {
    return { cascadeId: lookup.id, source: 'name-matched', tier: 'high' };
  }
  if (lookup.kind === 'many') {
    return { ambiguous: true };
  }

  const parenKey = stripParenSegment(stripped);
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
  const inferredMilestone =
    !milestoneSelect && tags.includes('Milestone') && cascadeMilestoneOptions
      ? inferMilestoneFromTitle(stripped, cascadeMilestoneOptions)
      : null;

  const useMilestoneFallback =
    (!requireMilestoneTagForFallback || tags.includes('Milestone'))
    && (milestoneSelect || inferredMilestone);

  if (useMilestoneFallback) {
    const canonical = milestoneSelect ? mapSourceMilestone(milestoneSelect) : inferredMilestone;
    if (canonical) {
      const ids = filterTasksByCanonicalMilestone(studyTaskPages, canonical);
      if (ids.length === 1) {
        const source = inferredMilestone ? 'milestone-inferred' : 'milestone-fallback';
        return { cascadeId: ids[0], source, tier: 'medium' };
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
    const score = jaccardTokens(stripped, tn);
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
      const score = jaccardTokens(stripped, tn);
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
