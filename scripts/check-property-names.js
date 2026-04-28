#!/usr/bin/env node
/**
 * check-property-names — sanity validator for src/notion/property-names.js.
 *
 * Pings each Notion DB schema, walks every PROP constant group, looks up the
 * live property whose `id` matches `constant.id`, and asserts:
 *   - liveProperty.name === constant.name  (rename drift on the read surface)
 *   - liveProperty.type === expected type  (type drift in the live schema)
 *   - id resolves to a property at all     (constant points at deleted property)
 *
 * Per plan D2b: writes/filters/reads are now id-keyed via findById, so .name
 * field staleness is the only remaining rename-vulnerable surface in the
 * engine. This script catches that drift before deploy.
 *
 * Workspace sanity guard: at script start, fetch each DB and assert its
 * `title` matches the expected DB title. Prevents silent token-misconfig
 * false-passes (e.g., a token scoped to a different workspace where a
 * lookalike DB happens to satisfy the property-id checks).
 *
 * Exit 0 on full match. Exit 1 on any drift, with a stderr drift report.
 */

import { NotionClient } from '../src/notion/client.js';
import {
  STUDY_TASKS_PROPS,
  STUDIES_PROPS,
  BLUEPRINT_PROPS,
  ACTIVITY_LOG_PROPS,
} from '../src/notion/property-names.js';

// Load .env so we pick up NOTION_TOKEN_1 + DB IDs without requiring the user
// to source them manually. Mirrors src/config.js's dotenv loading shape.
if (process.env.NODE_ENV !== 'production') {
  const { config } = await import('dotenv');
  config();
}

// DB ids — sourced from .env where available, with hardcoded fallbacks for
// the Blueprint DB (which most local .env files don't carry today).
// Hardcoded fallbacks come straight from the plan's reference table; if they
// drift, the workspace sanity check below catches it via the title mismatch.
const STUDY_TASKS_DB_ID = process.env.STUDY_TASKS_DB_ID  || '40f2386760c2830eaad68159ca69a8d6';
const STUDIES_DB_ID     = process.env.STUDIES_DB_ID      || 'cad2386760c2836fa27d0131c25b6dcd';
const BLUEPRINT_DB_ID   = process.env.BLUEPRINT_DB_ID    || '8fe2386760c283e9a95d01ade939f5c2';
const ACTIVITY_LOG_DB_ID = process.env.ACTIVITY_LOG_DB_ID || 'f512386760c282269d66810554f3ec81';

/**
 * Type baseline — captured from the live schema as of 2026-04-28 per the plan's
 * Renamed Properties reference table + the {name,id} constants module. If a
 * type drifts from this baseline, the validator flags it; an operator either
 * re-baselines (because intentional schema change) or fixes the constant.
 *
 * Constants are stored as `{ name, id }` only (no .type) per plan D5; the
 * expected types live here so the constants module stays minimal. If a property
 * is added to a constants group, add its expected type here too.
 */
const EXPECTED_TYPES = {
  STUDY_TASKS_PROPS: {
    TASK_NAME: 'title',
    ID: 'unique_id',
    STATUS: 'status',
    DATES: 'date',
    BLOCKED_BY: 'relation',
    BLOCKING: 'relation',
    PARENT_TASK: 'relation',
    SUBTASKS: 'relation',
    STUDY: 'relation',
    OWNER: 'people',
    OWNER_ROLE: 'select',
    TAGS: 'multi_select',
    MILESTONE: 'checkbox',
    EXTERNAL_VISIBILITY: 'checkbox',
    AUTOMATION_REPORTING: 'rich_text',
    ACTIVITY_LOG: 'relation',
    REF_START: 'date',
    REF_END: 'date',
    TEMPLATE_SOURCE_ID: 'rich_text',
    LMBS: 'checkbox',
    PROCESSING_LOCK: 'checkbox',
    IMPORT_MODE_ROLLUP: 'rollup',
    NOTIFY_ON_DONE: 'people',
    ASANA_TASK: 'rich_text',
    MIGRATION_STATUS: 'select',
    DATE_COMPLETED: 'date',
    STUDY_PHASE_ROLLUP: 'rollup',
    EXPORTED_COMPLETE_DATE: 'formula',
    EXPORTED_DUE_DATE: 'formula',
    EXPORTED_ASSIGNEE: 'formula',
    EXPORTED_ASSIGNEE_GROUP: 'formula',
    MATCH_CONFIDENCE: 'select',
    OVERDUE: 'formula',
    DURATION_BUSINESS_DAYS: 'formula',
    CONTRACT_END_FOR_ROLLUP: 'rollup',
    CONTRACT_SIGNED_FOR_ROLLUP: 'rollup',
    MISMATCH_TRIAGER: 'people',
    CREATED_TIME: 'created_time',
    CREATED_BY: 'created_by',
    LAST_EDITED_TIME: 'last_edited_time',
    LAST_EDITED_BY: 'last_edited_by',
  },
  STUDIES_PROPS: {
    STUDY_NAME: 'title',
    CONTRACT_SIGN_DATE: 'date',
    CONTRACT_END_DATE: 'date',
    IMPORT_MODE: 'checkbox',
    AUTOMATION_REPORTING: 'rich_text',
    CASCADE_QUEUE: 'rich_text',
    TASKS: 'relation',
    TASKS_COUNT: 'rollup',
    PHASE: 'formula',
    CUSTOMER: 'relation',
    EXTERNAL_STUDY_NAME: 'rich_text',
    STUDY_TYPE: 'select',
    STUDY_LEAD: 'people',
    PROJECT_PURPOSE: 'rich_text',
    PROJECT_STATUS: 'status',
    PROJECT_UPDATE: 'rich_text',
    STUDY_PORTAL_LINK: 'url',
    GDRIVE_FOLDER: 'url',
    IRB_OWNER: 'select',
    STUDY_LEVEL_IRB_VENDOR: 'select',
    SITES_IRB_VENDOR: 'select',
    SITES: 'checkbox',
    ANALYTICS: 'checkbox',
    TOTAL_ARR: 'rollup',
    TCV: 'rollup',
    CURRENT_CONTRACT_TERM: 'number',
    MIGRATED_STUDY: 'checkbox',
    CREATED_TIME: 'created_time',
    INITIAL_ACTIVATOR: 'button',
    REPEAT_DELIVERY_ADDER: 'button',
    ADDTL_TLF_ADDER: 'button',
    ADDTL_TLF_INSIGHTS_ADDER: 'button',
    ADDTL_TLF_CSR_ADDER: 'button',
    ADDTL_TLF_CSR_INSIGHTS_ADDER: 'button',
    ADDTL_ACTIVATE_SITE_ADDER: 'button',
    TASK_DELETER: 'button',
    CASCADE_UNDOER: 'button',
    CORE_STUDY_METADATA_ASSISTANT: 'button',
  },
  BLUEPRINT_PROPS: {
    TASK_NAME: 'title',
    START_DATE: 'date',
    END_DATE: 'date',
    PARENT_TASK: 'relation',
    SUBTASKS: 'relation',
    BLOCKED_BY: 'relation',
    BLOCKING: 'relation',
    OWNER_ROLE: 'select',
    TAGS: 'multi_select',
    MILESTONE: 'checkbox',
    EXTERNAL_VISIBILITY: 'checkbox',
    SDATE_OFFSET: 'number',
    EDATE_OFFSET: 'number',
    NOTION_ID: 'rich_text',
    OWNER: 'people',
    LAUNCHER: 'checkbox',
    LMBS: 'checkbox',
    NOTIFY_ON_DONE: 'people',
    DURATION: 'formula',
    START_DATE_MATCH: 'formula',
    END_DATE_MATCH: 'formula',
    LAST_EDITED_TIME: 'last_edited_time',
    LAST_EDITED_BY: 'last_edited_by',
  },
  ACTIVITY_LOG_PROPS: {
    ENTRY: 'title',
    SUMMARY: 'rich_text',
    DETAILS: 'rich_text',
    STATUS: 'status',
    WORKFLOW: 'select',
    TRIGGER_TYPE: 'select',
    CASCADE_MODE: 'select',
    EXECUTION_ID: 'rich_text',
    STUDY_TASKS: 'relation',
    STUDY: 'relation',
    TESTED_BY: 'people',
    DURATION_MS: 'number',
    DURATION_S: 'formula',
    ORIGINAL_DATES: 'rich_text',
    MODIFIED_DATES: 'rich_text',
    CREATED_TIME: 'created_time',
  },
};

// Each DB descriptor: id, expected title (workspace sanity), constants group,
// and the constants group label used in drift output.
const DB_DESCRIPTORS = [
  {
    label: 'STUDY_TASKS_PROPS',
    dbId: STUDY_TASKS_DB_ID,
    expectedTitle: 'Study Tasks',
    constants: STUDY_TASKS_PROPS,
  },
  {
    label: 'STUDIES_PROPS',
    dbId: STUDIES_DB_ID,
    expectedTitle: 'Studies',
    constants: STUDIES_PROPS,
  },
  {
    label: 'BLUEPRINT_PROPS',
    dbId: BLUEPRINT_DB_ID,
    expectedTitle: 'Study Blueprint',
    constants: BLUEPRINT_PROPS,
  },
  {
    label: 'ACTIVITY_LOG_PROPS',
    dbId: ACTIVITY_LOG_DB_ID,
    expectedTitle: 'Activity Log',
    constants: ACTIVITY_LOG_PROPS,
  },
];

function collectTokens() {
  const tokens = [];
  if (process.env.NOTION_TOKEN) tokens.push(process.env.NOTION_TOKEN);
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`NOTION_TOKEN_${i}`];
    if (token) tokens.push(token);
  }
  return [...new Set(tokens)];
}

function extractDbTitle(database) {
  const titleArr = database?.title || [];
  return titleArr.map((chunk) => chunk?.plain_text || '').join('').trim();
}

const tokens = collectTokens();
if (tokens.length === 0) {
  console.error('Missing NOTION_TOKEN_1 (cascade pool). Set it in .env or in the shell.');
  process.exit(1);
}

const client = new NotionClient({ tokens });

const drifts = [];

function recordDrift(kind, label, key, detail) {
  drifts.push({ kind, label, key, detail });
}

for (const descriptor of DB_DESCRIPTORS) {
  const { label, dbId, expectedTitle, constants } = descriptor;

  let database;
  try {
    database = await client.request('GET', `/databases/${dbId}`);
  } catch (err) {
    console.error(`[${label}] failed to fetch DB ${dbId}: ${err?.message || err}`);
    process.exit(1);
  }

  // Workspace sanity check. If the title doesn't match, the token is likely
  // scoped to the wrong workspace or the DB id has drifted; either way, we
  // bail before any property-level drift report (which would be misleading).
  const liveTitle = extractDbTitle(database);
  if (liveTitle !== expectedTitle) {
    console.error(
      `[${label}] workspace sanity FAIL: db ${dbId} title is '${liveTitle}', expected '${expectedTitle}'. `
      + 'Token may be scoped to a different workspace, or the DB id changed. '
      + 'Aborting before property-level checks to avoid misleading drift output.'
    );
    process.exit(1);
  }
  console.error(`[${label}] DB title OK: '${liveTitle}'`);

  const liveProps = database.properties || {};

  // Build an id -> live property entry index. Notion keys liveProps by name,
  // but the value carries the rename-stable .id; we want to look up by id.
  const liveById = new Map();
  for (const liveValue of Object.values(liveProps)) {
    if (liveValue && liveValue.id) {
      liveById.set(liveValue.id, liveValue);
    }
  }

  for (const [key, def] of Object.entries(constants)) {
    const live = liveById.get(def.id);
    if (!live) {
      recordDrift('missing', label, key, {
        constantName: def.name,
        constantId: def.id,
        message: 'constant points at deleted property (no live property has this id)',
      });
      continue;
    }
    if (live.name !== def.name) {
      recordDrift('name', label, key, {
        constantName: def.name,
        liveName: live.name,
        constantId: def.id,
      });
    }
    const expectedType = EXPECTED_TYPES[label]?.[key];
    if (expectedType && live.type !== expectedType) {
      recordDrift('type', label, key, {
        constantName: def.name,
        constantId: def.id,
        expectedType,
        liveType: live.type,
      });
    }
  }
}

if (drifts.length === 0) {
  console.error('OK: every constant resolves to a live property with matching name + type.');
  process.exit(0);
}

console.error(`FAIL: ${drifts.length} drift${drifts.length === 1 ? '' : 's'} detected.\n`);
for (const drift of drifts) {
  const path = `${drift.label}.${drift.key}`;
  if (drift.kind === 'missing') {
    console.error(
      `  [missing] ${path}: ${drift.detail.message}\n`
      + `      constant.name = '${drift.detail.constantName}'\n`
      + `      constant.id   = '${drift.detail.constantId}'`
    );
  } else if (drift.kind === 'name') {
    console.error(
      `  [name]    ${path}: rename drift\n`
      + `      constant.name = '${drift.detail.constantName}'\n`
      + `      live.name     = '${drift.detail.liveName}'\n`
      + `      shared id     = '${drift.detail.constantId}'`
    );
  } else if (drift.kind === 'type') {
    console.error(
      `  [type]    ${path}: type drift\n`
      + `      constant.name = '${drift.detail.constantName}'\n`
      + `      expected type = '${drift.detail.expectedType}'\n`
      + `      live type     = '${drift.detail.liveType}'\n`
      + `      shared id     = '${drift.detail.constantId}'`
    );
  }
}

process.exit(1);
