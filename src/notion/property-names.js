/**
 * Notion property identity — single source of truth for the engine.
 *
 * Each constant is `{ name, id }`. Writes and filter clauses key by `.id`
 * (rename-immune at runtime — Notion preserves property IDs across renames).
 * Reads go through `findById(page, propDef)` — Notion's page response keys
 * properties by name, but every property value carries an `.id` field that's
 * stable across renames, so we iterate values and match on id.
 *
 * Property IDs are stored URL-encoded (matches what `/databases/{id}` returns;
 * no encode step at call sites). Verified 2026-04-28 that Notion's PATCH
 * endpoint accepts URL-encoded ids as `properties` keys (Step 0b spot-test).
 *
 * History: on 2026-04-28 Meg renamed 17 system-internal properties across
 * Study Tasks, Studies, and Study Blueprint to carry a `[Do Not Edit] ` prefix —
 * making the PM-protected surface area visually obvious in Notion. See
 * docs/plans/2026-04-28-001-refactor-property-names-constants-module-plan.md
 * for the full rename event + this module's role.
 *
 * Cross-DB ID coincidences (per-DB uniqueness, not global):
 *   - id `kQjP` appears in Study Tasks (Template Source ID) and Blueprint
 *     (Notion ID) — different properties in different DBs.
 *   - id `v%40v%3D` appears in Study Tasks (Owner — NOT renamed) and
 *     Blueprint ([Do Not Edit] Owner — renamed).
 */

/**
 * Recursively freeze every nested object. `Object.freeze` is shallow — without
 * this helper, `STUDY_TASKS_PROPS.REF_START.name = 'foo'` would silently succeed
 * and corrupt the singleton. Per ce-code-review #71 (P2 finding).
 */
function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

/**
 * Study Tasks DB (`40f23867-60c2-830e-aad6-8159ca69a8d6`).
 *
 * Renamed-to-prefixed (2026-04-28):
 *   REF_START, REF_END, TEMPLATE_SOURCE_ID, LMBS, PROCESSING_LOCK,
 *   IMPORT_MODE_ROLLUP, NOTIFY_ON_DONE, ID
 *
 * Note: Owner is NOT renamed in Study Tasks (only renamed in Blueprint).
 * The provisioning code that copies Owner from Blueprint to Study Tasks must
 * read BLUEPRINT_PROPS.OWNER and write STUDY_TASKS_PROPS.OWNER.
 */
export const STUDY_TASKS_PROPS = deepFreeze({
  // Title + identity
  TASK_NAME:           { name: 'Task Name',                                 id: 'title' },
  ID:                  { name: '[Do Not Edit] ID',                          id: 'mnjr' },

  // Engine-touched (non-renamed)
  STATUS:              { name: 'Status',                                    id: 'Fhy~' },
  DATES:               { name: 'Dates',                                     id: 'lX%5Co' },
  BLOCKED_BY:          { name: 'Blocked by',                                id: 'WVZD' },
  BLOCKING:            { name: 'Blocking',                                  id: 'V%5Cim' },
  PARENT_TASK:         { name: 'Parent Task',                               id: 'm%3C%3BR' },
  SUBTASKS:            { name: 'Subtask(s)',                                id: 'ZCt%7C' },
  STUDY:               { name: 'Study',                                     id: 'H%5Cc%3F' },
  OWNER:               { name: 'Owner',                                     id: 'v%40v%3D' },
  OWNER_ROLE:          { name: 'Owner Role',                                id: 'SVe%5E' },
  TAGS:                { name: 'Tags',                                      id: 'notion%3A%2F%2Ftasks%2Ftags_property' },
  MILESTONE:           { name: 'Milestone',                                 id: 'C%5ECt' },
  EXTERNAL_VISIBILITY: { name: 'External Visibility',                       id: '~h~J' },
  AUTOMATION_REPORTING:{ name: 'Automation Reporting',                      id: '%3Fj%60i' },
  ACTIVITY_LOG:        { name: 'Activity Log',                              id: 'MVlM' },

  // [Do Not Edit] family — renamed 2026-04-28
  REF_START:           { name: '[Do Not Edit] Reference Start Date',       id: 'Q%5E%7C%3C' },
  REF_END:             { name: '[Do Not Edit] Reference End Date',         id: 'UoNx' },
  TEMPLATE_SOURCE_ID:  { name: '[Do Not Edit] Template Source ID',         id: 'kQjP' },
  LMBS:                { name: '[Do Not Edit] Last Modified By System',    id: 'WZ%40%7C' },
  PROCESSING_LOCK:     { name: '[Do Not Edit] Processing Lock',            id: 'UyVG' },
  IMPORT_MODE_ROLLUP:  { name: '[Do Not Edit] Import Mode',                id: 'UAXj' },
  NOTIFY_ON_DONE:      { name: '[Do Not Edit] Notify on Done',             id: 'T%3Dkh' },

  // Asana / migration / display
  ASANA_TASK:          { name: 'Asana Task',                                id: '%3ADxU' },
  MIGRATION_STATUS:    { name: 'Migration Status',                          id: 'tnhr' },
  DATE_COMPLETED:      { name: 'Date Completed',                            id: 'q%3FKm' },

  // Rollups / formulas / system fields
  STUDY_PHASE_ROLLUP:        { name: 'Study Phase Rollup',                  id: 'AvI%3B' },
  EXPORTED_COMPLETE_DATE:    { name: 'Exported Complete Date',              id: 'EF%3CJ' },
  EXPORTED_DUE_DATE:         { name: 'Exported Due Date',                   id: 'Gj%5Df' },
  EXPORTED_ASSIGNEE:         { name: 'Exported Asignee',                    id: 'TmDh' },
  EXPORTED_ASSIGNEE_GROUP:   { name: 'Exported Assignee Group',             id: 'PuH%5B' },
  MATCH_CONFIDENCE:          { name: 'Match Confidence',                    id: 'Ej%3Dg' },
  OVERDUE:                   { name: 'Overdue',                             id: 'AZtl' },
  DURATION_BUSINESS_DAYS:    { name: 'Duration (Business Days)',            id: 'C~V%40' },
  CONTRACT_END_FOR_ROLLUP:   { name: 'Contract End Date (for Rollup)',      id: '%5Cy%5Db' },
  CONTRACT_SIGNED_FOR_ROLLUP:{ name: 'Contract Signed Date (for Rollup)',   id: 'j%3ExR' },
  MISMATCH_TRIAGER:          { name: 'Mismatch Triager',                    id: '%5BQ%7Dh' },
  CREATED_TIME:              { name: 'Created time',                        id: 'ARpp' },
  CREATED_BY:                { name: 'Created By',                          id: 'j%7B%3C%5B' },
  LAST_EDITED_TIME:          { name: 'Last edited time',                    id: 'HT~J' },
  LAST_EDITED_BY:            { name: 'Last edited by',                      id: '%3DhKS' },
});

/**
 * Studies DB (`cad23867-60c2-836f-a27d-0131c25b6dcd`).
 *
 * Renamed 2026-04-28: `Import Mode` → `[Do Not Edit] Import Mode`.
 * (Step 0a observed `Import Mode` in a transient un-renamed window; Tem confirmed
 * the canonical state is `[Do Not Edit] Import Mode` to match the Study Tasks
 * rollup name.)
 */
export const STUDIES_PROPS = deepFreeze({
  STUDY_NAME:           { name: 'Study Name (Internal)',                    id: 'title' },
  CONTRACT_SIGN_DATE:   { name: 'Contract Sign Date',                       id: 'KUl%5D' },
  CONTRACT_END_DATE:    { name: 'Contract End Date',                        id: 'f%5Bxi' },
  IMPORT_MODE:          { name: '[Do Not Edit] Import Mode',                id: '%3FhIH' },
  AUTOMATION_REPORTING: { name: 'Automation Reporting',                     id: '%5BJmF' },
  CASCADE_QUEUE:        { name: 'Cascade Queue',                            id: 'KK%3FA' },
  TASKS:                { name: 'Tasks',                                    id: 'x%3D%3BN' },
  TASKS_COUNT:          { name: 'Tasks Count',                              id: 'P%7D%5Cj' },
  PHASE:                { name: 'Phase',                                    id: 'b%7C%40%3A' },

  // Customer / metadata
  CUSTOMER:             { name: 'Customer',                                 id: '%3BkZU' },
  EXTERNAL_STUDY_NAME:  { name: 'External Study Name',                      id: 'm%5D%3CO' },
  STUDY_TYPE:           { name: 'Study Type',                               id: '%5Cx~D' },
  STUDY_LEAD:           { name: 'Study Lead',                               id: 'lZ%3A%3B' },
  PROJECT_PURPOSE:      { name: 'Project Purpose',                          id: '%3A%5Dkb' },
  PROJECT_STATUS:       { name: 'Project Status',                           id: 'H%3Ba%3F' },
  PROJECT_UPDATE:       { name: 'Project Update',                           id: 'keaO' },
  STUDY_PORTAL_LINK:    { name: 'Study Portal Link',                        id: '%3ExII' },
  GDRIVE_FOLDER:        { name: 'Gdrive Folder',                            id: 'J_sj' },
  IRB_OWNER:            { name: 'IRB Owner',                                id: 'DBGa' },
  STUDY_LEVEL_IRB_VENDOR:{ name: 'Study-Level IRB Vendor',                  id: 'FQcy' },
  SITES_IRB_VENDOR:     { name: 'Sites IRB Vendor',                         id: '%7CMgY' },
  SITES:                { name: 'Sites?',                                   id: 'DV%7B%3B' },
  ANALYTICS:            { name: 'Analytics?',                               id: 'bX%3F%3B' },
  TOTAL_ARR:            { name: 'Total ARR',                                id: 'WIfE' },
  TCV:                  { name: 'TCV (incl. pass-through)',                 id: 'xcW%5E' },
  CURRENT_CONTRACT_TERM:{ name: 'Current Contract Term (Months)',           id: '%5Bp~r' },
  // PM-facing display name. The Studies DB property was renamed from
  // `Migrated Study` → `Exported Study` while shipping the migrate-study
  // webhook (the button lives on the Exported Studies DB row). Internal
  // constant key stays MIGRATED_STUDY to minimize the rename blast radius;
  // reads are id-keyed via findById, so display rename is rename-immune.
  MIGRATED_STUDY:       { name: 'Exported Study',                            id: 'rNDd' },
  CREATED_TIME:         { name: 'Created time',                             id: 'vr%5Eh' },

  // Buttons (engine doesn't write these but they're part of the surface)
  INITIAL_ACTIVATOR:               { name: 'Initial Activator',             id: 'mvPw' },
  REPEAT_DELIVERY_ADDER:           { name: 'Repeat Delivery Adder',         id: 'm%3F%3B%3B' },
  ADDTL_TLF_ADDER:                 { name: 'Addtl. TLF Adder',              id: 'UDH%40' },
  ADDTL_TLF_INSIGHTS_ADDER:        { name: 'Addtl. TLF + Insights Adder ',  id: 'Fom%60' },
  ADDTL_TLF_CSR_ADDER:             { name: 'Addtl. TLF + CSR Adder',        id: 'VUU%3B' },
  ADDTL_TLF_CSR_INSIGHTS_ADDER:    { name: 'Addtl. TLF + CSR + Insights Adder', id: '%5By%40b' },
  ADDTL_ACTIVATE_SITE_ADDER:       { name: 'Addtl. Activate Site Adder',    id: 'hii~' },
  TASK_DELETER:                    { name: 'Task Deleter',                  id: 'UUyW' },
  CASCADE_UNDOER:                  { name: 'Cascade Undo-er',               id: 'shj%3A' },
  CORE_STUDY_METADATA_ASSISTANT:   { name: 'Core Study Metadata Assistant', id: '%3Dz%5CS' },
});

/**
 * Study Blueprint DB (`8fe23867-60c2-83e9-a95d-01ade939f5c2`).
 *
 * Renamed-to-prefixed (2026-04-28):
 *   SDATE_OFFSET, EDATE_OFFSET, NOTION_ID, OWNER, LAUNCHER, LMBS,
 *   NOTIFY_ON_DONE, DURATION
 *
 * Critical asymmetry: OWNER is renamed here (Blueprint) but NOT in Study Tasks.
 * Provisioning copies Owner from Blueprint → Study Tasks; per-DB grouping
 * keeps the asymmetry obvious by construction.
 */
export const BLUEPRINT_PROPS = deepFreeze({
  TASK_NAME:           { name: 'Task Name',                                 id: 'title' },

  // Engine-touched (non-renamed)
  START_DATE:          { name: 'Start Date',                                id: '%5BlKj' },
  END_DATE:            { name: 'End Date',                                  id: 'k~H%7D' },
  PARENT_TASK:         { name: 'Parent Task',                               id: 'm%3C%3BR' },
  SUBTASKS:            { name: 'Subtask(s)',                                id: 'ZCt%7C' },
  BLOCKED_BY:          { name: 'Blocked by',                                id: 'WVZD' },
  BLOCKING:            { name: 'Blocking',                                  id: 'V%5Cim' },
  OWNER_ROLE:          { name: 'Owner Role',                                id: 'SVe%5E' },
  TAGS:                { name: 'Tags',                                      id: 'notion%3A%2F%2Ftasks%2Ftags_property' },
  MILESTONE:           { name: 'Milestone',                                 id: 'C%5ECt' },
  EXTERNAL_VISIBILITY: { name: 'External Visibility',                       id: '~h~J' },

  // [Do Not Edit] family — renamed 2026-04-28
  SDATE_OFFSET:        { name: '[Do Not Edit] SDate Offset',                id: 'osBG' },
  EDATE_OFFSET:        { name: '[Do Not Edit] EDate Offset',                id: '%7B%60FY' },
  NOTION_ID:           { name: '[Do Not Edit] Notion ID',                   id: 'kQjP' },
  OWNER:               { name: '[Do Not Edit] Owner',                       id: 'v%40v%3D' },
  LAUNCHER:            { name: '[Do Not Edit] Launcher',                    id: 'n%5Dz%3F' },
  LMBS:                { name: '[Do Not Edit] Last Modified By System',    id: '%7D~Dj' },
  NOTIFY_ON_DONE:      { name: '[Do Not Edit] Notify on Done',             id: 'U%5CPO' },
  DURATION:            { name: '[Do Not Edit] Duration',                    id: 'ZAh%40' },

  // Match formulas (not engine-touched but part of surface)
  START_DATE_MATCH:    { name: 'Start Date Match',                          id: '%3Bals' },
  END_DATE_MATCH:      { name: 'End Date Match',                            id: 'uJql' },

  // System
  LAST_EDITED_TIME:    { name: 'Last edited time',                          id: 'MRPY' },
  LAST_EDITED_BY:      { name: 'Last edited by',                            id: '%5C%3EOX' },
});

/**
 * Activity Log DB (`f5123867-60c2-8226-9d66-810554f3ec81`).
 *
 * No renames; included for full property surface (R2 from plan).
 */
export const ACTIVITY_LOG_PROPS = deepFreeze({
  ENTRY:           { name: 'Entry',                                          id: 'title' },
  SUMMARY:         { name: 'Summary',                                        id: 'AI%3A%7B' },
  DETAILS:         { name: 'Details',                                        id: 'wXQq' },
  STATUS:          { name: 'Status',                                         id: 'oBeX' },
  WORKFLOW:        { name: 'Workflow',                                       id: 'prUv' },
  TRIGGER_TYPE:    { name: 'Trigger Type',                                   id: 'Zh%3Dn' },
  CASCADE_MODE:    { name: 'Cascade Mode',                                   id: 'dKXm' },
  EXECUTION_ID:    { name: 'Execution ID',                                   id: 'uZw%5D' },
  STUDY_TASKS:     { name: 'Study Tasks',                                    id: 'dJUC' },
  STUDY:           { name: 'Study',                                          id: 'etPu' },
  TESTED_BY:       { name: 'Tested by',                                      id: '%3DY%5E%3B' },
  DURATION_MS:     { name: 'Duration (ms)',                                  id: 'DFmg' },
  DURATION_S:      { name: 'Duration (s)',                                   id: 'BNpU' },
  ORIGINAL_DATES:  { name: 'Original Dates',                                 id: 'AMn%3C' },
  MODIFIED_DATES:  { name: 'Modified Dates',                                 id: '%3F%5Db%40' },
  CREATED_TIME:    { name: 'Created time',                                   id: 'nSt%3C' },
});

/**
 * Required helper for ID-keyed reads.
 *
 * Notion's page response keys properties by name (the `properties` object
 * shape is `{ [name]: { id, type, ...value } }`). Iterating values and
 * matching on the value's `.id` field gives us rename-immunity on reads —
 * because property IDs survive a Notion property rename in place.
 *
 * @param {object} page  Notion page object (`page.properties` should be name-keyed)
 * @param {{ id: string }} propDef  one of the constants from this module
 * @returns the matching property value, or undefined if no property has that id
 *           or if `page` / `page.properties` is missing
 */
export function findById(page, propDef) {
  if (!page || !page.properties || !propDef || !propDef.id) return undefined;
  return Object.values(page.properties).find((p) => p && p.id === propDef.id);
}
