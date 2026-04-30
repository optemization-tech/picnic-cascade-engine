import { config } from '../config.js';
import { STUDIES_PROPS, STUDY_TASKS_PROPS, findById } from '../notion/property-names.js';
import {
  MIGRATED_STUDIES_PROP,
  MIGRATED_TASKS_DB_ID,
  MIGRATED_TASK_PROP,
  MIGRATED_TASK_PRODUCTION_RELATION_NAMES,
} from './constants.js';
import { relationIds } from './extract.js';
import { titlePlain, richTextPlain } from './extract.js';
import { parseMigrationThresholdsFromEnv } from './thresholds.js';
import { propertySchemaId, propertySchemaIdFirst } from './property-resolve.js';
import {
  buildStudyTaskNameIndex,
  resolveCascadeTwin,
  hasManualWorkstreamTag,
  contributorCompletionDate,
  isRepeatDeliveryRow,
  isCompletedRow,
} from './matcher.js';
import { normalizeAssigneeForOwner } from './normalize.js';

export class MigrateStudyGateError extends Error {
  /**
   * @param {string} message
   * @param {object} [details] Gate-specific metadata (must include `code`).
   * @param {string} [studyPageId] Production Study page id when known. Pre-resolution
   *   gates (e.g., `production_study_relation`) leave it undefined; the catch in
   *   `runMigrateStudyPipeline` then falls back to the Exported Studies row.
   */
  constructor(message, details = {}, studyPageId) {
    super(message);
    this.name = 'MigrateStudyGateError';
    this.details = details;
    this.studyPageId = studyPageId;
  }
}

function mergeCascadePatch(map, taskId, props) {
  const cur = map.get(taskId) || {};
  Object.assign(cur, props);
  map.set(taskId, cur);
}

function maxIsoDate(dates) {
  const valid = dates.filter(Boolean);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a >= b ? a : b));
}

function buildUserMaps(users) {
  const emailMap = new Map();
  const nameMap = new Map();
  for (const u of users) {
    if (u.type !== 'person' || !u.person) continue;
    const email = u.person.email?.toLowerCase?.();
    if (email) emailMap.set(email, u.id);
    const nm = normalizeAssigneeForOwner(u.name || '');
    if (nm && !nameMap.has(nm)) nameMap.set(nm, u.id);
  }
  return { emailMap, nameMap };
}

function resolveOwnerPeople(assigneeText, emailMap, nameMap) {
  const raw = String(assigneeText || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) {
    return emailMap.get(raw.toLowerCase()) || null;
  }
  const key = normalizeAssigneeForOwner(raw);
  return nameMap.get(key) || null;
}

/**
 * Loads context, computes planned PATCH shapes (no writes). Throws MigrateStudyGateError if gates fail.
 *
 * Entry point is the **Exported Studies row id** (the button lives on the
 * Exported Studies DB). The pipeline walks Exported Study → `Production Study`
 * → Production Study page, then runs the rest of the gates against the
 * Production Study (Import Mode, Contract Sign Date, Study Tasks query, etc.).
 *
 * @param {object} notionClient
 * @param {string} exportedStudyPageId  Exported Studies DB row id (`body.data.id` from the button)
 */
export async function buildMigrationPlan(notionClient, exportedStudyPageId, { tracer } = {}) {
  const thresholds = parseMigrationThresholdsFromEnv();
  const warnings = [];

  const migratedStudyPage = await notionClient.getPage(exportedStudyPageId);
  const prodStudyIds = relationIds(migratedStudyPage.properties, MIGRATED_STUDIES_PROP.PRODUCTION_STUDY);
  if (prodStudyIds.length !== 1) {
    throw new MigrateStudyGateError(
      `Exported Studies row must have exactly one Production Study relation (found ${prodStudyIds.length}).`,
      { code: 'production_study_relation' },
    );
  }
  const studyPageId = prodStudyIds[0];

  const studyPage = await notionClient.getPage(studyPageId);

  const importOn = findById(studyPage, STUDIES_PROPS.IMPORT_MODE)?.checkbox === true;
  if (importOn) {
    throw new MigrateStudyGateError(
      '[Do Not Edit] Import Mode is already ON — resolve before migrating.',
      { code: 'import_mode_on' },
      studyPageId,
    );
  }

  const contractSignDate = findById(studyPage, STUDIES_PROPS.CONTRACT_SIGN_DATE)?.date?.start || null;
  if (!contractSignDate) {
    throw new MigrateStudyGateError(
      'Contract Sign Date is empty on the Study page.',
      { code: 'contract_sign_empty' },
      studyPageId,
    );
  }

  // Round-trip safety: the Production Study's `Exported Study` relation must
  // contain the Exported Studies row we were triggered from. Catches
  // misconfigured 1:1 wiring before any writes.
  const exportedStudyIdsOnStudy = findById(studyPage, STUDIES_PROPS.MIGRATED_STUDY)?.relation?.map((r) => r.id) || [];
  if (!exportedStudyIdsOnStudy.includes(exportedStudyPageId)) {
    throw new MigrateStudyGateError(
      'Production Study `Exported Study` relation does not point back to this Exported Studies row — wrong-study guard failed.',
      { code: 'exported_study_relation_mismatch' },
      studyPageId,
    );
  }
  if (exportedStudyIdsOnStudy.length !== 1) {
    throw new MigrateStudyGateError(
      `Production Study must have exactly one Exported Study relation (found ${exportedStudyIdsOnStudy.length}).`,
      { code: 'exported_study_relation_count' },
      studyPageId,
    );
  }
  const migratedStudyPageId = exportedStudyPageId;

  const mtDb = await notionClient.retrieveDatabase(MIGRATED_TASKS_DB_ID);
  const studyPropIdOnMigratedTasks = propertySchemaId(mtDb, MIGRATED_TASK_PROP.STUDY);
  const productionTaskPropId = propertySchemaIdFirst(mtDb, MIGRATED_TASK_PRODUCTION_RELATION_NAMES);
  if (!studyPropIdOnMigratedTasks || !productionTaskPropId) {
    throw new MigrateStudyGateError(
      'Could not resolve Migrated Tasks schema (Study / Production Task or Notion Task property ids).',
      { code: 'schema_migrated_tasks' },
      studyPageId,
    );
  }

  const migratedTasksRelCount = relationIds(migratedStudyPage.properties, MIGRATED_STUDIES_PROP.MIGRATED_TASKS).length;
  const migratedTaskPages = await notionClient.queryDatabase(
    MIGRATED_TASKS_DB_ID,
    {
      property: studyPropIdOnMigratedTasks,
      relation: { contains: migratedStudyPageId },
    },
    100,
    { tracer },
  );

  if (migratedTasksRelCount === 0) {
    throw new MigrateStudyGateError(
      'Migrated Studies row has empty Migrated Tasks relation.',
      { code: 'migrated_tasks_empty' },
      studyPageId,
    );
  }

  // Query uses `Study` → Exported Studies row (authoritative for which rows belong to this study).
  // Mismatches between query count and parent relation count are noted as warnings, not gates —
  // PMs reconcile via the Migration Support callout. "Match what we can" beats "block when counts
  // don't tally" for studies whose carryover is messy by nature.
  if (migratedTaskPages.length < migratedTasksRelCount) {
    warnings.push({
      category: 'migrated-tasks-relation-overfilled',
      queryCount: migratedTaskPages.length,
      relationCount: migratedTasksRelCount,
    });
  } else if (migratedTaskPages.length > migratedTasksRelCount) {
    warnings.push({
      category: 'migrated-tasks-relation-underfilled',
      queryCount: migratedTaskPages.length,
      relationCount: migratedTasksRelCount,
    });
  }

  const studyTaskPages = await notionClient.queryDatabase(
    config.notion.studyTasksDbId,
    {
      property: STUDY_TASKS_PROPS.STUDY.id,
      relation: { contains: studyPageId },
    },
    100,
    { tracer },
  );

  if (studyTaskPages.length < thresholds.minStudyTasks) {
    throw new MigrateStudyGateError(
      `Study Tasks count ${studyTaskPages.length} < minimum ${thresholds.minStudyTasks} (run Inception on the Production Study first).`,
      { code: 'study_tasks_low' },
      studyPageId,
    );
  }

  for (const mPage of migratedTaskPages) {
    const studyRel = relationIds(mPage.properties, MIGRATED_TASK_PROP.STUDY);
    if (!studyRel.includes(migratedStudyPageId)) {
      throw new MigrateStudyGateError(
        'carryover incomplete — a Migrated Task row is missing Study relation.',
        { code: 'carryover_study_missing' },
        studyPageId,
      );
    }
  }

  const users = await notionClient.listAllUsers({ tracer });
  const userMaps = buildUserMaps(users);

  const nameIndex = buildStudyTaskNameIndex(studyTaskPages);

  /** Resolved twin per migrated row — §4b uses strict milestone tag; §5a does not. */
  const resolutionByMigratedId = new Map();
  for (const mPage of migratedTaskPages) {
    const props = mPage.properties;
    const repeat = isRepeatDeliveryRow(props);
    const completed = isCompletedRow(props);
    const requireMilestoneTagForFallback = Boolean(completed && !repeat);
    const twin = resolveCascadeTwin({
      migratedProps: props,
      studyTaskPages,
      nameIndex,
      requireMilestoneTagForFallback,
      jaccardMin: thresholds.jaccardMin,
    });
    resolutionByMigratedId.set(mPage.id, { twin, repeat, completed, props });
  }

  let completedNonRepeatDenom = 0;
  let unmatchedCompletedNonRepeat = 0;
  let lowTierCount = 0;

  for (const { twin, repeat, completed } of resolutionByMigratedId.values()) {
    if (twin?.tier === 'low') lowTierCount += 1;
    if (completed && !repeat) {
      completedNonRepeatDenom += 1;
      if (!twin?.cascadeId || twin.ambiguous) unmatchedCompletedNonRepeat += 1;
    }
  }

  // Match-quality counters surface in the success summary so PMs can see scope of
  // manual reconciliation needed, but they no longer gate the run. "Match what we
  // can and call it a day" — PMs reconcile unmatched + low-confidence rows via
  // the Migration Support callout's curated dashboard views.
  const unmatchedRatio =
    completedNonRepeatDenom === 0 ? 0 : unmatchedCompletedNonRepeat / completedNonRepeatDenom;

  const collisionContributors = new Map();
  for (const mPage of migratedTaskPages) {
    const { twin, repeat, completed, props } = resolutionByMigratedId.get(mPage.id);
    if (!completed || repeat) continue;
    if (!twin?.cascadeId || twin.ambiguous) continue;
    if (!collisionContributors.has(twin.cascadeId)) collisionContributors.set(twin.cascadeId, []);
    collisionContributors.get(twin.cascadeId).push({
      migratedPageId: mPage.id,
      migratedProps: props,
      twinMeta: twin,
    });
  }

  const cascadeCompletionTargets = new Map();
  for (const [cascadeId, contributors] of collisionContributors.entries()) {
    const cascadePage = studyTaskPages.find((p) => p.id === cascadeId);
    if (cascadePage && hasManualWorkstreamTag(cascadePage.properties)) {
      warnings.push({ category: 'manual-skipped', cascadeId });
      continue;
    }
    const dates = contributors.map((c) => contributorCompletionDate(c.migratedProps));
    const dateCompleted = maxIsoDate(dates);
    cascadeCompletionTargets.set(cascadeId, {
      contributors,
      dateCompleted,
    });
  }

  const migratedPatches = [];
  const cascadePatches = new Map();
  const cascadeIdsMatched = new Set();

  function queueProductionTask(migratedPageId, cascadeId) {
    migratedPatches.push({
      taskId: migratedPageId,
      properties: {
        [productionTaskPropId]: { relation: [{ id: cascadeId }] },
      },
    });
    cascadeIdsMatched.add(cascadeId);
  }

  for (const [cascadeId, { dateCompleted }] of cascadeCompletionTargets.entries()) {
    const cascadePage = studyTaskPages.find((p) => p.id === cascadeId);
    if (!cascadePage || hasManualWorkstreamTag(cascadePage.properties)) continue;

    mergeCascadePatch(cascadePatches, cascadeId, {
      [STUDY_TASKS_PROPS.STATUS.id]: { status: { name: 'Done' } },
      [STUDY_TASKS_PROPS.MIGRATION_STATUS.id]: { select: { name: 'Asana-matched' } },
      [STUDY_TASKS_PROPS.DATE_COMPLETED.id]: { date: dateCompleted ? { start: dateCompleted } : null },
    });
  }

  for (const mPage of migratedTaskPages) {
    const { twin, repeat, completed, props } = resolutionByMigratedId.get(mPage.id);

    if (twin?.ambiguous) {
      warnings.push({ category: 'ambiguous-match', migratedPageId: mPage.id });
      continue;
    }
    if (!twin?.cascadeId) {
      if (completed && !repeat) warnings.push({ category: 'unmatched-completed-row', migratedPageId: mPage.id });
      else if (!repeat) warnings.push({ category: 'unmatched-future-row', migratedPageId: mPage.id });
      else warnings.push({ category: 'repeat-delivery-no-cascade-match', migratedPageId: mPage.id });
      continue;
    }

    const twinCascadePage = studyTaskPages.find((p) => p.id === twin.cascadeId);
    const skipProdLinkForManual =
      completed
      && !repeat
      && twinCascadePage
      && hasManualWorkstreamTag(twinCascadePage.properties);
    if (!skipProdLinkForManual) {
      queueProductionTask(mPage.id, twin.cascadeId);
    }

    const assignee = richTextPlain(props, MIGRATED_TASK_PROP.ASSIGNEE);
    const ownerId = resolveOwnerPeople(assignee, userMaps.emailMap, userMaps.nameMap);
    if (ownerId) {
      mergeCascadePatch(cascadePatches, twin.cascadeId, {
        [STUDY_TASKS_PROPS.OWNER.id]: { people: [{ id: ownerId }] },
      });
    }

    if (!completed || repeat) {
      mergeCascadePatch(cascadePatches, twin.cascadeId, {
        [STUDY_TASKS_PROPS.MIGRATION_STATUS.id]: { select: { name: 'Asana-matched' } },
      });
    }
  }

  for (const taskPage of studyTaskPages) {
    const ms = findById(taskPage, STUDY_TASKS_PROPS.MIGRATION_STATUS)?.select?.name;
    if (ms) continue;
    if (cascadeIdsMatched.has(taskPage.id)) continue;
    mergeCascadePatch(cascadePatches, taskPage.id, {
      [STUDY_TASKS_PROPS.MIGRATION_STATUS.id]: { select: { name: 'Blueprint-default' } },
    });
  }

  const summary = {
    studyPageId,
    migratedStudyPageId,
    migratedRows: migratedTaskPages.length,
    studyTasks: studyTaskPages.length,
    collisionTargets: [...collisionContributors.keys()].filter((id) => {
      const p = studyTaskPages.find((x) => x.id === id);
      return p && !hasManualWorkstreamTag(p.properties);
    }).length,
    warnings: warnings.length,
    cascadePatchCount: cascadePatches.size,
    migratedPatchCount: migratedPatches.length,
    completedNonRepeatDenom,
    unmatchedCompletedNonRepeat,
    unmatchedRatio,
    lowTierCount,
  };

  return {
    thresholds,
    studyPageId,
    migratedStudyPageId,
    contractSignDate,
    studyName: titlePlain(studyPage.properties, STUDIES_PROPS.STUDY_NAME.name),
    migratedPatches,
    cascadePatches,
    summary,
    warnings,
    collisionContributors,
  };
}

/**
 * Executes batched PATCH operations from a built plan.
 */
export async function applyMigrationPlan(notionClient, plan, { tracer } = {}) {
  const { migratedPatches, cascadePatches } = plan;

  const merged = [];
  for (const u of migratedPatches) merged.push(u);
  for (const [taskId, properties] of cascadePatches.entries()) {
    merged.push({ taskId, properties });
  }

  const chunkSize = 10;
  for (let i = 0; i < merged.length; i += chunkSize) {
    const slice = merged.slice(i, i + chunkSize);
    await notionClient.patchPages(slice, { tracer });
    if (i + chunkSize < merged.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { patched: merged.length };
}

/**
 * Full webhook pipeline: plan (dry-run gates) → Import Mode ON → apply →
 * reporting → Import Mode OFF in `finally`.
 *
 * `body.data.id` is the **Exported Studies** row id (button lives there).
 * Status reporting + Import Mode toggle target the resolved **Production
 * Study** page, since that's where PMs see automation status. Failures
 * before resolution (no payload id, getPage error) report nowhere — best we
 * can do is surface the throw to the route's flightTracker logger.
 */
export async function runMigrateStudyPipeline(body, notionClient, {
  tracer,
  studyCommentService,
  triggeredByUserId,
  editedByBot,
  studyNameFallback,
}) {
  const exportedStudyPageId = body?.data?.id || body?.exportedStudyPageId || body?.studyPageId;
  if (!exportedStudyPageId) {
    console.warn('[migrate-study] no exportedStudyPageId in payload, skipping');
    return { skipped: true };
  }

  let studyName = studyNameFallback || null;
  let studyPageId = null;
  let importModeArm = false;

  try {
    const plan = await buildMigrationPlan(notionClient, exportedStudyPageId, { tracer });
    studyName = plan.studyName || studyName;
    studyPageId = plan.studyPageId;

    if (tracer?.set) tracer.set('study_id', studyPageId);

    await notionClient.reportStatus(
      studyPageId,
      'info',
      `Migrate Study: gate passed — applying ~${plan.summary.migratedPatchCount + plan.summary.cascadePatchCount} patches…`,
      { tracer },
    );

    await notionClient.request(
      'PATCH',
      `/pages/${studyPageId}`,
      {
        properties: { [STUDIES_PROPS.IMPORT_MODE.id]: { checkbox: true } },
      },
      { tracer },
    );
    importModeArm = true;

    const applyResult = await applyMigrationPlan(notionClient, plan, { tracer });

    const unmatchedPct = (plan.summary.unmatchedRatio * 100).toFixed(1);
    const msg = `Migrate Study complete — migrated PATCHes: ${plan.summary.migratedPatchCount}, cascade PATCHes: ${plan.summary.cascadePatchCount}, total ops: ${applyResult.patched}. Unmatched completed: ${plan.summary.unmatchedCompletedNonRepeat}/${plan.summary.completedNonRepeatDenom} (${unmatchedPct}%); low-confidence matches: ${plan.summary.lowTierCount}. PMs reconcile remaining rows via the Migration Support callout.`;
    await notionClient.reportStatus(studyPageId, 'success', msg, { tracer });

    return { ok: true, plan, applyResult };
  } catch (err) {
    const summaryText = err instanceof MigrateStudyGateError
      ? String(err.message).slice(0, 200)
      : String(err.message || err).slice(0, 200);
    const gateCode = err?.details?.code || 'unhandled';

    // Three-tier fallback: prefer the Production Study id carried on the gate
    // error (set after Production Study resolution inside buildMigrationPlan),
    // then the outer `studyPageId` (set on success-path partial failures), then
    // the Exported Studies row id (only the pre-resolution `production_study_relation`
    // gate ends up here, since it fires before Production Study is known).
    const reportTarget = err?.studyPageId || studyPageId || exportedStudyPageId;

    await Promise.all([
      notionClient
        .reportStatus(reportTarget, 'error', `Migrate Study aborted: ${summaryText}`, { tracer })
        .catch((reportErr) =>
          console.warn(
            `[migrate-study] reportStatus failed on ${reportTarget} (gate=${gateCode}):`,
            reportErr?.message || reportErr,
          ),
        ),
      studyCommentService
        .postComment({
          workflow: 'Migrate Study',
          status: 'failed',
          studyId: reportTarget,
          sourceTaskName: studyName,
          triggeredByUserId,
          editedByBot,
          summary: `Migrate Study aborted: ${summaryText}`,
        })
        .catch((commentErr) =>
          console.warn(
            `[migrate-study] postComment failed on ${reportTarget} (gate=${gateCode}):`,
            commentErr?.message || commentErr,
          ),
        ),
    ]);

    throw err;
  } finally {
    if (importModeArm && studyPageId) {
      try {
        await notionClient.request(
          'PATCH',
          `/pages/${studyPageId}`,
          {
            properties: { [STUDIES_PROPS.IMPORT_MODE.id]: { checkbox: false } },
          },
          { tracer },
        );
      } catch (cleanupError) {
        console.warn('[migrate-study] failed to disable Import Mode in finally:', cleanupError.message);
      }
    }
  }
}

