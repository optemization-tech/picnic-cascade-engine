---
title: 'refactor: centralize Notion property names after [Do Not Edit] rename'
type: refactor
status: active
date: 2026-04-28
---

# refactor: centralize Notion property names after [Do Not Edit] rename

## Overview

On 2026-04-28 (~14:31–14:35 CST) Meg renamed 17 distinct properties across the Study Tasks, Studies, and Study Blueprint Notion databases — every engine-internal/system property now carries a `[Do Not Edit] ` prefix (e.g., `Reference Start Date` → `[Do Not Edit] Reference Start Date`). This was a coordinated, intentional rename to make the PM-protected surface area visually obvious in Notion.

The cascade engine reads and writes Notion properties by **name** in 11 source files, ~10 test files, and 2 scripts. Notion preserved property IDs across the rename (rename-in-place), so PATCH-by-name now silently fails validation while a PATCH-by-id would still resolve. Today the engine's hot paths — inception, date-cascade, status-rollup, dep-edit, undo-cascade — all break against live Notion until names are updated.

This refactor centralizes every Notion property in a single constants module (`src/notion/property-names.js`) where each constant carries both `{ name, id }`. Notion's API accepts property IDs (not just names) in `PATCH` payloads and `query`/`filter` clauses, so **writes and filter clauses are refactored to key by `.id`** and become rename-immune at the source level. Reads from `page.properties` continue to key by name (Notion's read responses are name-keyed) and source `.name` from the same constants. A CI-able validator pings the live schema and asserts every constant's `.name` still resolves to the property whose `.id` matches — surfacing future rename drift before it ships. End state: writes + filters are immune to rename; reads remain vulnerable but caught mechanically before deploy.

---

## Problem Frame

**Trigger:** 24 property name changes across 3 Notion DBs, all in place (property IDs preserved). Coordinated with Meg; intentional and final.

**Failure mode in the current code:** every read like `props['Reference Start Date']?.date?.start` returns `undefined`; every write like `{ 'Reference Start Date': { date: { start } } }` fails Notion's property-name validation (HTTP 400). Affected engine surfaces:

- **Inception** — Blueprint reads of `SDate Offset` / `EDate Offset` / `Owner` / `Notion ID` return `undefined` → new tasks land with null dates, no owner, no template-source ID. Writes of `Reference Start Date` / `Reference End Date` / `Last Modified By System` / `Template Source ID` 400 out.
- **Date cascade** — Reference reads silently fail → stale-ref correction at `classify.js:87-123` recomputes `delta = 0` and silently no-ops every cascade. Import Mode rollup miss → cascades fire during inception.
- **Status rollup** — Import Mode read on Studies fails → rollup fires during bulk operations it should ignore.
- **Add-task-set** — Template Source ID read fails → numbering and dedup logic breaks.
- **Undo cascade** — restores Reference dates by old name → 400.
- **Dep-edit (shipped today)** — writes Reference dates by old name → 400.
- **Startup Import Mode sweep** — `queryDatabase` filter clause `{ property: 'Import Mode', ... }` no longer matches → stuck-mode studies never get cleared.

**Why this is the right scope:**
- We are pre-production. We can pause Meg's testing for a few hours, ship, smoke-test, resume.
- Pure name-mapping refactor — no behavior change. Existing test suite (553 tests) remains the regression net.
- This is the second time properties have bitten us at the source-code level (cf. Slack 2026-03-06 "Automation issues" → "Automation Reporting" rename caused the activate button to silently break). A constants module + validator turns the next Meg-rename into a known-knowable event.

**Constraint:** Cross-repo. Engine source + tests + engine docs live in the `picnic-cascade-engine` repo. Database schema docs + PM-facing docs + migration prompts + foundational status docs live in the client-side PicnicHealth folder (parent of the engine repo on disk via symlink).

---

## Requirements Trace

- R1. Every engine read/write/filter that referenced a renamed property now resolves correctly against the live Notion DB schema. Existing 553-test suite continues to pass without behavioral changes.
- R2. Every property reference in source, tests, and scripts is sourced from a single module (`src/notion/property-names.js`). No bare property-name string literals remain in the engine codebase.
- R3. Each constant carries both the property name and the Notion property ID. **Writes and filter clauses key by `.id`** (rename-immune at runtime). Reads key by `.name` (Notion's read response is name-keyed). Both surfaces import from the same constants module so a name update propagates everywhere with one diff.
- R4. A CI-able validator script asserts every PROP constant's `.name` still resolves to a real property of the expected type on the live Notion DB, **using `.id` as the stable lookup key**. After a future rename, the validator fails loudly with "constant `.name` ≠ live name" and the constants get updated; reads (the only rename-vulnerable surface) are guarded by this check before deploy.
- R5. Engine repo docs (`docs/ENGINE-BEHAVIOR-REFERENCE.md`, `docs/CASCADE-RULEBOOK.md`, `docs/CONCURRENCY-MODEL.md`, `docs/TESTING-REFERENCE.md`) reflect the current property names so future contributors don't anchor on the old names.
- R6. Client-folder docs that PMs and operators actually consult (`resources/notion/DATABASE-SCHEMA.md`, `resources/notion/DATABASE-GROUNDING-MAP.md`, `resources/docs/01–04`, `resources/migration/prompts/*`) reflect the current property names.
- R7. Every Notion automation that referenced a renamed property in a filter, formula, or action payload is identified and fixed in the Notion UI; the engine deploys cleanly and successfully runs an end-to-end smoke test against Meg's test study.
- R8. The rename event and its mitigation are captured in the foundational record (`foundational/STATUS.md` update + `foundational/DECISIONS.md` entry + a 04.28 pulse log).

---

## Scope Boundaries

**In scope:**
- All 17 renamed properties across Study Tasks, Studies, and Study Blueprint DBs (full list under § Renamed Properties below).
- All non-renamed property names that the engine references (Task Name, Status, Dates, Blocked by, Blocking, Parent Task, Subtask(s), Owner on Study Tasks, Study, Tasks, Contract Sign Date, Automation Reporting, Cascade Queue, Tags, Milestone, External Visibility, Owner Role) — pulled into the constants module too, so the module is the *complete* property surface and tomorrow's "we noticed `Cascade Queue` is also a system field" doesn't reintroduce string drift.
- The 9 source files, ~10 test files, 2 scripts where these names appear.
- Engine repo docs (`docs/*.md`) excluding historical plan/code-review snapshots.
- Client-folder authoritative docs (`resources/notion/`, `resources/docs/`, `resources/migration/prompts/`, `foundational/STATUS.md`, `foundational/BACKLOG.md`).
- Notion automation inventory + UI fix list (manual application by Tem).
- A CI-able validator script + a one-time deploy smoke test.

**Out of scope:**
- Any cascade behavior change. This is a name-only refactor.
- The `[Do Not Edit] ID` unique_id rename — engine uses Notion page UUIDs everywhere; the friendly ID is display-only and not referenced in code.
- Owner Role select option names, Cascade Mode select option names, Tags multi-select option names — these are option *values*, not property names, and the engine doesn't depend on their text changing.
- The n8n workflow manifest (`foundational/workflow-manifest.json` and `clients/picnic-health/integrations/n8n/`) — n8n is deactivated and the manifest is documentation of the legacy system.

### Deferred to Follow-Up Work

- Historical engine plan docs (`docs/plans/*.md` from before this date) — left as-is. Plans are snapshots of past decisions; rewriting them would erase history. If anyone re-reads them, they'll cross-reference to current docs.
- Historical code-review docs (`docs/CODEBASE-REVIEW-2026-04-07.md`, `docs/CODEBASE-REVIEW-2026-04-13.md`) — same rationale.
- `resources/engine-docs/N8N-ENGINE-REFERENCE.md` — legacy doc, n8n is being shut down. Update only if a future operator says they're consulting it.
- `resources/design/2026-03-30-cascade-engine-code-port-design.md` — historical design doc.
- `resources/ops/LESSONS-LEARNED.md` — single line; can be updated opportunistically.
- A more aggressive future safety net: switch every Notion read/write to use property *IDs* via `Page.properties[id]` lookup (Notion supports it). This would make name renames irrelevant entirely. Big enough refactor to live in its own plan.

---

## Renamed Properties (Reference Table)

For every implementer reading this plan: this is the authoritative list of renames as of 2026-04-28.

### Study Tasks DB (`40f23867-60c2-830e-aad6-8159ca69a8d6`)

| Old name | New name | Notion property ID | Type |
|---|---|---|---|
| Reference Start Date | `[Do Not Edit] Reference Start Date` | `Q^\|<` | date |
| Reference End Date | `[Do Not Edit] Reference End Date` | `UoNx` | date |
| Template Source ID | `[Do Not Edit] Template Source ID` | `kQjP` | rich_text |
| Last Modified By System | `[Do Not Edit] Last Modified By System` | `WZ@\|` | checkbox |
| Processing Lock | `[Do Not Edit] Processing Lock` | `UyVG` | checkbox |
| Import Mode | `[Do Not Edit] Import Mode` | `UAXj` | rollup (from Study) |
| Notify on Done | `[Do Not Edit] Notify on Done` | `T=kh` | people |
| ID | `[Do Not Edit] ID` | `mnjr` | unique_id (display-only, not used by engine) |

### Studies DB (`cad23867-60c2-836f-a27d-0131c25b6dcd`)

| Old name | New name | Notion property ID | Type |
|---|---|---|---|
| Import Mode | `[Do Not Edit] Import Mode` | `%3FhIH` | checkbox |

### Study Blueprint DB (`8fe23867-60c2-83e9-a95d-01ade939f5c2`)

| Old name | New name | Notion property ID | Type |
|---|---|---|---|
| SDate Offset | `[Do Not Edit] SDate Offset` | `osBG` | number |
| EDate Offset | `[Do Not Edit] EDate Offset` | `{`FY` | number |
| Notion ID | `[Do Not Edit] Notion ID` | `kQjP` | rich_text |
| Owner | `[Do Not Edit] Owner` | `v@v=` | people (Blueprint only — Study Tasks Owner unchanged) |
| Launcher | `[Do Not Edit] Launcher` | `n]z?` | checkbox |
| Last Modified By System | `[Do Not Edit] Last Modified By System` | `}~Dj` | checkbox |
| Notify on Done | `[Do Not Edit] Notify on Done` | `U\PO` | people |
| Duration | `[Do Not Edit] Duration` | `ZAh@` | formula |

### Activity Log DB (`f5123867-60c2-8226-9d66-810554f3ec81`)

No renames.

**Critical asymmetry:** `Owner` is renamed in Blueprint but **not** in Study Tasks. The provisioning code that copies Owner from Blueprint to Study Tasks must read `[Do Not Edit] Owner` from the Blueprint and write `Owner` to Study Tasks. The constants module makes this clear via per-DB grouping.

---

## Context & Research

### Relevant Code and Patterns

- `src/notion/properties.js` — current home of `normalizeTask()`, the single read-side normalization for Study Tasks. All Reference, Import Mode, dependency, and parent reads pass through here. Natural neighbor for the new constants module to import from.
- `src/notion/queries.js` — `queryStudyTasks()` filters by `Study` (not renamed). Pattern: filter clauses use `{ property: 'Name', ... }` shape with bare strings.
- `src/notion/client.js` — Notion API wrapper. Property reads/writes go through here; no name-string awareness inside the client itself.
- `src/gates/guards.js` — guard clauses for Import Mode and LMBS echo prevention. Reads both rollup form (Study Tasks) and checkbox form (Studies).
- `src/provisioning/create-tasks.js` — provisioning hot path that reads from Blueprint (`SDate Offset`, `EDate Offset`, `Owner`, etc.) and writes to Study Tasks (`Reference Start Date`, `Template Source ID`, `Owner`, etc.). Cross-DB read/write — best illustration of why per-DB grouping matters.
- `src/startup/import-mode-sweep.js` — example of `property` key inside a query filter clause (`{ property: 'Import Mode', checkbox: { equals: true } }`). Filter clauses are also rename-affected.
- `src/routes/*.js` — every route handler builds property-write payloads inline. Mass replace target.

### Patterns from Recent Plans

- The 2026-04-22 Meg-Apr-21 feedback batch (`docs/plans/2026-04-22-001-fix-meg-apr21-feedback-plan.md`) introduced the pattern of "single PR, multiple commits per fix" for batched-but-distinct concerns. This plan adopts the same shape — one PR with logical commit boundaries per implementation unit.
- The 2026-04-27 dep-edit plan (`docs/plans/2026-04-27-001-feat-dep-edit-cascade-plan.md`) introduced the runbook pattern for Notion-UI changes Tem applies post-merge (Unit 3.1). This plan reuses that pattern for the automation inventory (U8 below).
- The 2026-04-16-002 rename-aware lookup plan (`docs/plans/2026-04-16-002-fix-repeat-delivery-rename-aware-lookup-plan.md`) had to handle Meg renaming a *task* name during repeat-delivery. Property renames are the same kind of human edit, on a different surface; same lesson — pin to a stable identifier (there: TSID; here: property ID).

### Institutional Learnings

`docs/solutions/` does not exist in the engine repo. Cross-session learnings live in pulse logs and `foundational/INCIDENTS.md`. Two relevant prior incidents:

- **2026-03-06 — "Automation issues" → "Automation Reporting" property rename.** Tem renamed a property; Activate Study Template button silently broke because a Code node referenced the old name. Fix: rename in code. *Lesson:* property renames cascade silently across surfaces; no validation surface caught it.
- **CLAUDE.md "Property renames = workflow audit" rule.** Already-codified rule from past incidents: "When renaming a Notion DB property, ALWAYS grep all n8n workflow Code nodes for the old name BEFORE renaming." This plan extends the discipline to engine code + adds a CI-able mechanical check.

### External References

- Notion API: property updates by name vs. property ID (https://developers.notion.com/reference/page-property-values). Property IDs are stable across renames; property names are mutable. Both are accepted as keys in `properties` payloads (PATCH page) and as values for the `property` field in filter clauses. Page-response `properties` objects are keyed by name only (the `id` field lives inside each value). **This plan adopts ID-keyed writes + filters** (rename-immune) and keeps name-keyed reads (with constants + validator catching name drift before deploy).

---

## Key Technical Decisions

- **D1. Centralize property references in `src/notion/property-names.js`.** Single module; per-DB grouped exports (`STUDY_TASKS_PROPS`, `STUDIES_PROPS`, `BLUEPRINT_PROPS`, `ACTIVITY_LOG_PROPS`). No bare property-name string literals or property-id literals survive in the engine codebase after this refactor. Rationale: matches Notion's data model (each property belongs to a DB) and makes the Owner asymmetry obvious by construction.

- **D2. Constants store `{ name, id }` objects, not bare strings.** Each constant is `{ name: '[Do Not Edit] Reference Start Date', id: 'Q%5E%7C%3C' }`. The `.id` is stored in the form Notion's API returns it (URL-encoded). Implementer verifies in U1 whether Notion's PATCH/filter endpoints expect URL-encoded or raw form; both forms appear to be accepted but the URL-encoded form matches what the API returns and avoids re-encoding at call sites.

- **D2b. Everything keys by `.id` — *the load-bearing decision.*** All three surfaces — PATCH page properties, filter clauses, page-response reads — go through the property `.id`, making the engine fully rename-immune at runtime. Notion's API treats the surfaces slightly differently, but the constants module hides the asymmetry:
  - **PATCH page properties** — accepts either `properties[name]` or `properties[id]`. We use `.id` directly: `properties: { [REF_START.id]: { date: { ... } } }`.
  - **Database query filter clauses** — `{ property: name | id }`. We use `.id`: `{ property: REF_START.id, ... }`.
  - **Page response `properties` object** — keyed by name only; `id` lives inside each value. We use the `findById(page, propDef)` helper, which iterates `Object.values(page.properties)` and matches on `.id`. The helper is exported from `src/notion/property-names.js` and is the *required* read pattern at every call site.

  After this refactor, a future Meg rename of any property in the constants module is invisible to the engine at runtime — every surface continues to resolve via property ID. The validator (D5) becomes a sanity check that catches type drift and `.name` field staleness in the constants, not the load-bearing safety net for engine correctness.

  **Carve-out — cross-DB writers.** `NotionClient.reportStatus(pageId, ...)` is the only writer called polymorphically across Study Tasks and Studies page IDs (it writes the `Automation Reporting` property, which exists in both DBs). Because `STUDY_TASKS_PROPS.AUTOMATION_REPORTING.id` ≠ `STUDIES_PROPS.AUTOMATION_REPORTING.id`, an ID-keyed write would 400 against the wrong DB. `reportStatus` is the only documented exception to D2b: it writes by name (`'Automation Reporting'`) rather than by id. The exception is contained in one helper; every other writer is DB-scoped and uses `.id` per the rule above.

- **D3. Tests import the same constants as production code.** Mock fixtures mirror Notion's actual response shape: `{ properties: { [REF_START.name]: { id: REF_START.id, type: 'date', date: {...} } } }`. Read assertions key by `.name`; write-side spy assertions (e.g., `expect(patchCall.properties).toMatchObject({ [REF_START.id]: { date: {...} } })`) key by `.id` to match prod. A single rename caught by the validator → constants update → both prod and tests pick up the new name from the same import.

- **D4. Filter clauses use `.id`** (sub-decision of D2b). The known site is `src/startup/import-mode-sweep.js:22`. Same treatment for any newly-discovered filter sites during U2.

- **D5. Validator script is a Node ESM script in `scripts/`, idempotent, exits non-zero on drift.** Pings each DB via `client.request('GET', '/databases/{dbId}')`, walks each `*_PROPS` group, looks up the live property whose ID matches `constant.id`, asserts `liveProperty.name === constant.name` and `liveProperty.type === expectedType`. Fails loudly on any mismatch (name drift, ID drift, type drift, or missing property). CI can run it as a smoke test before deploys; humans run it post-rename to confirm constants are aligned. Detects exactly the class of breakage the read sites are still vulnerable to.

- **D6. Plan and code-review historical docs are not rewritten.** They're snapshots of decisions made at a point in time. A future reader cross-references current docs; rewriting historical docs to match new names erases the trail. The current authoritative docs (`docs/ENGINE-BEHAVIOR-REFERENCE.md`, `docs/CASCADE-RULEBOOK.md`, `resources/notion/DATABASE-SCHEMA.md`) are the rewrite targets.

- **D7. Notion automation updates are a manual UI runbook, not API-scripted.** The Notion API surface for automation filters/actions is not exposed for write; UI-only. Tem applies the runbook (U8) post-merge.

- **D8. Engine docs and client-folder docs are updated together in the same PR cycle.** Engine docs (`docs/*.md`) ship in the engine PR; client-folder docs (`resources/`, `foundational/`) ship as a sibling commit on the client-folder side (no PR, local edits). The `engine/docs/` files that are symlinked into `resources/engine-docs/` need a single edit and propagate.

---

## Open Questions

### Resolved During Planning

- **Q: Use property names or property IDs in the constants module?** A: Both, in `{ name, id }` shape per constant (D2). Writes and filters key by `.id` (rename-immune); reads key by `.name` (response is name-keyed); validator catches name drift on the read surface (D2b/D5).
- **Q: Single plan covering both repos, or two plans?** A: Single plan in `engine/docs/plans/`, with a dedicated unit for client-folder docs and a dedicated unit for the manual Notion automation runbook. Matches dep-edit plan precedent.
- **Q: Update n8n workflow manifest?** A: No (D1 in scope, deferred indefinitely). n8n is deactivated.
- **Q: Update historical plan docs?** A: No (D6).

### Deferred to Implementation

- **Property ID encoding form.** Whether to store the URL-encoded form (`Q%5E%7C%3C`) or the raw form (`Q^|<`) in constants. The Notion API response returns URL-encoded. Best plan: store the encoded form (matches what comes back from the API; avoids re-encoding at call sites). Implementer verifies in U1 by spot-checking that `client.patchPage` accepts `properties[encodedId]: {...}` and `queryDatabase` filters accept `{ property: encodedId, ... }`. If the raw form is required somewhere, document it in U1 with a `decode()` helper.
- **`findById` helper exposure.** Whether to expose `findById(page, propDef)` as a top-level export or only use it internally. Implementer decides during U2 based on how often the helper helps vs. clutters call sites.
- **Validator output format on drift.** Plain stderr text with the offending constant + live property name should be enough for U5; if a future operator wants JSON for CI parsing, that's a separate concern.
- **Smoke test sequencing.** U9 lists each automation type in order — implementer adjusts based on Meg's test-study state at smoke-test time.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Module shape

```js
// src/notion/property-names.js (sketch)
// Each constant: { name, id }. ID stored URL-encoded as Notion returns it.
// Writes + filters use .id (rename-immune); reads use .name (response is name-keyed).

export const STUDY_TASKS_PROPS = Object.freeze({
  TASK_NAME:           { name: 'Task Name',           id: 'title' },
  STATUS:              { name: 'Status',              id: 'Fhy~' },
  DATES:               { name: 'Dates',               id: 'lX%5Co' },
  BLOCKED_BY:          { name: 'Blocked by',          id: 'WVZD' },
  BLOCKING:            { name: 'Blocking',            id: 'V%5Cim' },
  PARENT_TASK:         { name: 'Parent Task',         id: 'm%3C%3BR' },
  SUBTASKS:            { name: 'Subtask(s)',          id: 'ZCt%7C' },
  STUDY:               { name: 'Study',               id: 'H%5Cc%3F' },
  OWNER:               { name: 'Owner',               id: 'v%40v%3D' },
  OWNER_ROLE:          { name: 'Owner Role',          id: 'SVe%5E' },
  TAGS:                { name: 'Tags',                id: 'notion%3A%2F%2Ftasks%2Ftags_property' },
  MILESTONE:           { name: 'Milestone',           id: 'C%5ECt' },
  EXTERNAL_VISIBILITY: { name: 'External Visibility', id: '~h~J' },
  AUTOMATION_REPORTING:{ name: 'Automation Reporting', id: '%3Fj%60i' },
  // [Do Not Edit] family — renamed 2026-04-28
  REF_START:           { name: '[Do Not Edit] Reference Start Date',   id: 'Q%5E%7C%3C' },
  REF_END:             { name: '[Do Not Edit] Reference End Date',     id: 'UoNx' },
  TEMPLATE_SOURCE_ID:  { name: '[Do Not Edit] Template Source ID',     id: 'kQjP' },
  LMBS:                { name: '[Do Not Edit] Last Modified By System', id: 'WZ%40%7C' },
  PROCESSING_LOCK:     { name: '[Do Not Edit] Processing Lock',        id: 'UyVG' },
  IMPORT_MODE_ROLLUP:  { name: '[Do Not Edit] Import Mode',            id: 'UAXj' },
  NOTIFY_ON_DONE:      { name: '[Do Not Edit] Notify on Done',         id: 'T%3Dkh' },
});

export const STUDIES_PROPS = Object.freeze({
  STUDY_NAME:           { name: 'Study Name (Internal)', id: 'title' },
  CONTRACT_SIGN_DATE:   { name: 'Contract Sign Date',    id: 'KUl%5D' },
  AUTOMATION_REPORTING: { name: 'Automation Reporting',  id: '%5BJmF' },
  CASCADE_QUEUE:        { name: 'Cascade Queue',         id: 'KK%3FA' },
  TASKS:                { name: 'Tasks',                 id: 'x%3D%3BN' },
  // [Do Not Edit] family
  IMPORT_MODE:          { name: '[Do Not Edit] Import Mode', id: '%3FhIH' },
});

export const BLUEPRINT_PROPS = Object.freeze({
  TASK_NAME:           { name: 'Task Name',           id: 'title' },
  // ... non-renamed siblings ...
  // [Do Not Edit] family — note Owner asymmetry: Blueprint owner is renamed, Study Tasks owner is not.
  SDATE_OFFSET:        { name: '[Do Not Edit] SDate Offset',          id: 'osBG' },
  EDATE_OFFSET:        { name: '[Do Not Edit] EDate Offset',          id: '%7B%60FY' },
  NOTION_ID:           { name: '[Do Not Edit] Notion ID',             id: 'kQjP' },
  OWNER:               { name: '[Do Not Edit] Owner',                 id: 'v%40v%3D' },
  LAUNCHER:            { name: '[Do Not Edit] Launcher',              id: 'n%5Dz%3F' },
  LMBS:                { name: '[Do Not Edit] Last Modified By System', id: '%7D~Dj' },
  NOTIFY_ON_DONE:      { name: '[Do Not Edit] Notify on Done',        id: 'U%5CPO' },
  DURATION:            { name: '[Do Not Edit] Duration',              id: 'ZAh%40' },
});

export const ACTIVITY_LOG_PROPS = Object.freeze({
  // No renames; included so the module is the full property surface.
  ENTRY: { name: 'Entry', id: 'title' },
  // ... etc ...
});

// Required helper for ID-keyed reads. Used at every read site (D2b).
// Notion's page response keys properties by name, but the .id field on each value
// is rename-stable — iterate values and match on id to get rename-immunity on reads.
export function findById(page, propDef) {
  return Object.values(page?.properties || {}).find(p => p.id === propDef.id);
}
```

### Read pattern (id-keyed via helper — *rename-immune*)

```js
// All read sites go through findById to match on .id, not the response's name-key:
const refStart = findById(page, STUDY_TASKS_PROPS.REF_START)?.date?.start;
const importMode = findById(study, STUDIES_PROPS.IMPORT_MODE)?.checkbox === true;
```

### Write pattern (id-keyed — *rename-immune*)

```js
// PATCH page properties using property IDs:
const properties = {
  [STUDY_TASKS_PROPS.REF_START.id]: { date: { start: refStart } },
  [STUDY_TASKS_PROPS.REF_END.id]:   { date: { start: refEnd } },
  [STUDY_TASKS_PROPS.LMBS.id]:      { checkbox: true },
};
await client.patchPage(pageId, { properties });

// Exception per D2b: reportStatus is the only cross-DB writer (writes
// 'Automation Reporting' to either Study Tasks or Studies pages). It keeps
// name-keyed writes because both DBs share the property name but not the id.
async function reportStatus(pageId, level, message) {
  return client.patchPage(pageId, {
    properties: { 'Automation Reporting': { rich_text: buildReportingText(level, message) } },
  });
}
```

### Filter-clause pattern (id-keyed — *rename-immune*)

```js
// queryDatabase / queryDataSource filters also accept property IDs:
const filter = { property: STUDIES_PROPS.IMPORT_MODE.id, checkbox: { equals: true } };
```

### Validator shape

```js
// scripts/check-property-names.js (sketch)
// For each DB: retrieveDatabase(dbId). For each constant in the matching *_PROPS group:
//   - Look up the live property whose id matches constant.id
//   - Assert liveProp.name === constant.name (catches rename drift)
//   - Assert liveProp.type === expectedType (catches type drift, e.g. date → formula)
//   - If no live property has that id: report "constant points at deleted property"
// Exit 0 if all green; exit 1 with detailed report otherwise.
// Detects exactly the class of failure that ID-based writes/filters DON'T protect against:
// the read surface remains name-vulnerable, and the validator is the catch.
```

---

## Implementation Units

- U1. **Property-name constants module**

**Goal:** Create `src/notion/property-names.js` exporting `STUDY_TASKS_PROPS`, `STUDIES_PROPS`, `BLUEPRINT_PROPS`, and `ACTIVITY_LOG_PROPS` per D1/D2. Optionally export a `readProp(page, propDef)` helper. No call-site refactoring in this unit — pure introduction.

**Requirements:** R2, R3.

**Dependencies:** None.

**Files:**
- Create: `src/notion/property-names.js`

**Approach:**

- **Step 0a — Re-fetch live property IDs.** Call `client.request('GET', `/databases/${dbId}`)` for each of Study Tasks, Studies, Study Blueprint, Activity Log. Dump the full property list (name, id, type) for each DB to `pulse-log/04.28/001-property-rename-investigation.md`. Cross-reference against the plan's Renamed Properties tables and the HLT module sketch — if any IDs differ (the plan was authored without round-tripping the IDs), update the plan inline before populating the constants file. Particularly verify the suspected-duplicate IDs (`kQjP` shared between `STUDY_TASKS_PROPS.TEMPLATE_SOURCE_ID` and `BLUEPRINT_PROPS.NOTION_ID`; `v%40v%3D` shared between both Owner constants) are real and not authoring errors.
- **Step 0b — API spot-test (single smoke check, not a ceremony).** Notion's API accepts property IDs in PATCH and filter clauses per their public docs (cited in External References). Trust the docs but spot-test once: PATCH a throwaway test page in Study Tasks DB with `properties: { '<encoded-id>': { ... } }` (URL-encoded form, since that's what the API returns), confirm persistence by reading back. If it fails, the encoding form is wrong — try the raw form. Document the result in 1-2 lines in the investigation pulse log. No need to also verify filter clauses with curl; the U2 refactor will exercise them in tests, and any encoding mismatch surfaces there. Skip type-by-type verification (date / checkbox / rich_text) — the API contract is uniform across types.
- Per-DB exports as `Object.freeze({ ... })` to prevent accidental mutation at runtime.
- Each constant is `{ name, id }`. Comment block at the top of each DB group captures the renamed-from history.
- Include all properties the engine touches, not only renamed ones (D1 scope decision).
- Export `findById(page, propDef)` as a top-level helper (no longer optional — required by D2b after the read-pattern flip).

**Patterns to follow:**
- Existing constants/config split: `src/config.js` is config-from-env; `src/notion/property-names.js` is schema constants. Keep the boundary clean.

**Test scenarios:**
- Test expectation: minimal — a single test asserting every constant has both `.name` and `.id` defined and that no two constants in the same DB share a name. This is a structural sanity check, not behavior.
- File: `test/notion/property-names.test.js`.

**Verification:**
- Module imports cleanly in isolation.
- Structural sanity test passes.
- Greppable: `grep -r "STUDY_TASKS_PROPS" src/` returns one line (the module itself).

---

- U2. **Refactor engine source to use constants**

**Goal:** Replace every bare property-name string in `src/` with the corresponding constant. **Everything keys by `.id` per D2b** — reads use `findById(page, propDef)`, writes use `[propDef.id]` computed keys, filter clauses use `propDef.id`. Single discipline; no read/write asymmetry to remember. The only exception is `NotionClient.reportStatus` (cross-DB writer; carve-out documented in D2b).

**Requirements:** R1, R2, R3, R4 (validator focus).

**Dependencies:** U1.

**Files:**
- Modify: `src/notion/properties.js` — `normalizeTask()` reads via `findById`.
- Modify: `src/notion/queries.js` — `queryStudyTasks()` filter clause uses `.id` for `property:` field.
- Modify: `src/provisioning/deletion.js` — filter clause `{ property: 'Study', relation: { contains: studyId } }` at line 14 flips to `.id`.
- Modify: `src/gates/guards.js` — Reference reads + Import Mode rollup/checkbox reads via `findById`.
- Modify: `src/provisioning/create-tasks.js` — Blueprint reads via `findById(page, BLUEPRINT_PROPS.*)`; Study Tasks writes via `{ [STUDY_TASKS_PROPS.*.id]: { ... } }`. The Owner asymmetry is contained inside the per-DB constants (`BLUEPRINT_PROPS.OWNER` vs `STUDY_TASKS_PROPS.OWNER`); call sites just pick the matching constant.
- Modify: `src/routes/date-cascade.js` — Reference reads via `findById`, writes via `.id`; Import Mode disable via `.id`; LMBS reads via `findById`.
- Modify: `src/routes/dep-edit.js` — Reference writes use `.id`.
- Modify: `src/routes/inception.js` — Import Mode start/end on Studies use `.id`.
- Modify: `src/routes/add-task-set.js` — Template Source ID reads via `findById`, writes via `.id`; Import Mode start/end via `.id`.
- Modify: `src/routes/undo-cascade.js` — Reference restores write by `.id`; Import Mode resets by `.id`.
- Modify: `src/routes/status-rollup.js` — Studies Import Mode read via `findById`.
- Modify: `src/startup/import-mode-sweep.js` — Filter `property:` field uses `.id`; PATCH write uses `.id`.
- Modify: `src/services/activity-log.js` — Activity Log writes 13 property names by bare string today (`Entry`, `Summary`, `Details`, `Status`, `Workflow`, `Trigger Type`, `Cascade Mode`, `Execution ID`, `Study Tasks`, `Tested by`, `Duration (ms)`, `Original Dates`, `Modified Dates`); writes flip to `.id` per D2b. (Activity Log itself has no renames, but R2 demands no bare strings remain anywhere.)
- Modify: `src/notion/client.js` — `reportStatus()` is the documented D2b carve-out: cross-DB writer that keeps name-keyed writes for `'Automation Reporting'` (the only property whose name happens to be identical across Study Tasks and Studies, but whose IDs differ). Inline-document the exception.
- Test: existing test suite continues to pass after U3 lands. No new test files in this unit.

**Approach:**
- Land as one PR with logical commit boundaries (e.g., one commit per file or one commit per route). Per-file commits keep `git blame` cleaner.
- **The discipline (single rule):** every property reference goes through a `*_PROPS` constant. Reads → `findById(page, PROPS.X)`. Writes → `[PROPS.X.id]: { ... }` computed key. Filters → `{ property: PROPS.X.id, ... }`. No name-keyed access anywhere except the documented `reportStatus` carve-out.
- During refactor, watch for the **Owner asymmetry** in `create-tasks.js`: reads from Blueprint use `BLUEPRINT_PROPS.OWNER` (renamed); writes to Study Tasks use `STUDY_TASKS_PROPS.OWNER` (unchanged). Easy place to confuse — per-DB grouping is the constructive guard.
- **Step 0c — Verify reportStatus uniqueness empirically (before refactor).** Before flipping write sites to `.id`, grep for all helpers that take a `pageId`-shaped parameter and write properties: `grep -rE "patchPage\([^)]*pageId" src/` plus any wrapper that takes a polymorphic page parameter. Confirm `NotionClient.reportStatus` is the only result; if any other helper also takes a polymorphic pageId across DBs, document it as a sibling carve-out in D2b or refactor to take an explicit DB context. The greppable check at end-of-U2 (`grep -rE "properties\s*:\s*\{\s*'[^']+'\s*:" src/`) confirms only one bare-string write site survives — but Step 0c is the *empirical* check that there isn't a second polymorphic helper hiding.
- **For routes that read 3+ properties per page across N>50 pages** (inception's Blueprint walk, status-rollup parent-collection sweep, add-task-set numbering loop, normalizeTask in batch-query loops), reshape `page.properties` into an id-keyed map once at function entry — `Object.fromEntries(Object.values(page.properties).map(p => [p.id, p]))` — and read from the map in the loop instead of calling `findById` repeatedly. `findById` does an `Object.values + .find` on every call (O(n) per access); the reshape is O(n) once and O(1) per subsequent read. JavaScript handles a 245-task × 5-prop × 30-property linear scan (~37K comparisons) in single-digit milliseconds, so this is a micro-optimization, not a correctness fix — but it costs one line and removes a future-perf footgun.
- After refactor, `grep -rE "properties\s*:\s*\{\s*'[^']+'\s*:" src/` should return zero hits except the `reportStatus` carve-out (write-side bare strings gone). And `grep -rE "page\.properties\[\s*'[^']+'\s*\]" src/` should return zero hits (read-side bare strings gone). And `grep -rE "property\s*:\s*'[^']+'" src/` should return zero hits (filter-side bare strings gone).

**Execution note:** Run the existing test suite continuously during the refactor. The 553 existing tests are the regression net. Tests will start failing as source flips to constants but tests still hold old strings; that's expected and self-corrected when U3 lands.

**Patterns to follow:**
- Existing import patterns in `src/routes/*.js` — keep imports terse, e.g., `import { STUDY_TASKS_PROPS as ST, STUDIES_PROPS as S } from '../notion/property-names.js';` if it cleans up call sites.

**Test scenarios:**
- Test expectation: none in this unit (no new tests). Verification is "existing tests pass after U3 lands."

**Verification:**
- After U2 alone: greppable checks above return zero hits in `src/`.
- After U2+U3: `npm test` reports 553 passing (unchanged).
- Manual sanity: spot-read 2-3 modified routes; the read/write/filter discipline is consistent.

---

- U3. **Refactor tests to use constants**

**Goal:** Every test fixture, mock, and assertion now imports the same constants module as production code (D3). Tests and source share a single source of truth for property identity.

**Requirements:** R1, R2, R3.

**Dependencies:** U1, U2.

**Files:**
- Modify: `test/gates/guards.test.js`
- Modify: `test/notion/client.test.js`
- Modify: `test/notion/properties.test.js`
- Modify: `test/provisioning/blueprint.test.js`
- Modify: `test/provisioning/create-tasks.test.js`
- Modify: `test/routes/add-task-set.test.js`
- Modify: `test/routes/date-cascade.test.js`
- Modify: `test/routes/inception.test.js`
- Modify: `test/routes/status-rollup-route.test.js`
- Modify: `test/routes/undo-cascade.test.js`
- Modify: `test/startup/import-mode-sweep.test.js`
- Modify: `test/engine/dep-edit-cascade.test.js` (verify if it has property-name strings)
- Modify: `test/cascade-full-chain/*.test.js` (if applicable)
- Modify: `test/fixtures/*.js` if any test helpers construct property maps

**Approach:**
- **Mock fixtures:** mirror Notion's actual response shape — `{ properties: { [REF_START.name]: { id: REF_START.id, type: 'date', date: { start: '2026-01-01' } } } }`. Keying by `.name` matches what Notion's actual response shape looks like; production reads via `findById` find the property by `.id` regardless of the key. Tests double as documentation that the response uses name keys but the engine doesn't depend on that.
- **Spy assertions (write-side):** because production now writes by `.id`, write-side spy assertions check the ID-keyed shape — `expect(patchCall.properties).toMatchObject({ [STUDY_TASKS_PROPS.REF_START.id]: { date: { start: ... } } })`. Renaming a property → constants update → assertion still resolves to the same key.
- **Spy assertions (`reportStatus` carve-out):** assertions for `reportStatus` calls expect name-keyed payload (`{ 'Automation Reporting': { rich_text: ... } }`) since reportStatus is the documented exception.
- Test helpers (`task()` and friends in `test/fixtures/cascade-tasks.js` etc.) get the same treatment.
- The `'Import Mode'` string is tricky — it's both a property name (now renamed) and an English phrase appearing in test descriptions/comments. Review hits one by one; only refactor where it's a key/value, not where it's a comment or test name.
- Greppable check after refactor: same trio of greps from U2, applied to `test/`. Should return zero hits for property-key bare strings (excepting the `reportStatus` carve-out).

**Test scenarios:**
- The existing test scenarios remain unchanged. This unit only changes how property identity is referenced inside tests, not what's tested.

**Verification:**
- `npm test` reports 553 passing.
- Greppable checks return zero hits in `test/`.

---

- U4. **Refactor scripts to use constants**

**Goal:** Same treatment for `scripts/migrate-relative-offsets.js` and `scripts/verify-inception.js`.

**Requirements:** R1, R2.

**Dependencies:** U1.

**Files:**
- Modify: `scripts/migrate-relative-offsets.js` — reads `SDate Offset` and `EDate Offset` from Blueprint (now renamed); writes the non-renamed `Relative SDate Offset` / `Relative EDate Offset`. Reads flip to `BLUEPRINT_PROPS.SDATE_OFFSET.name` / `BLUEPRINT_PROPS.EDATE_OFFSET.name`.
- Modify: `scripts/verify-inception.js` — reads `Reference Start Date`, `Reference End Date`, `Template Source ID`, and `Last Modified By System` (all renamed). Reads flip to `STUDY_TASKS_PROPS.*.name`. The LMBS-not-set assertion in particular currently false-flags every task post-rename until this update lands.
- Modify: any other `scripts/*.js` flagged by `grep -rln "Reference Start Date|Reference End Date|Template Source ID|Last Modified By System|Processing Lock|SDate Offset|EDate Offset|Notion ID" scripts/` at implementation time.

**Approach:**
- Scripts are single-file Node entrypoints; import the constants module relative to `src/`.
- Test scripts manually by running them against the test study post-deploy.

**Test scenarios:**
- Test expectation: none — scripts are operator tools, manually verified at runtime.

**Verification:**
- Run `node scripts/verify-inception.js <test-study-id>` against the test study post-deploy (part of U9 smoke test); script completes successfully.

---

- U5. **CI-able validator script**

**Goal:** Ship `scripts/check-property-names.js` that pings each DB schema via `client.request('GET', '/databases/{dbId}')`, verifies every constant in `src/notion/property-names.js` resolves to a real property whose `name` matches the constant's `.name` and whose `id` matches the constant's `.id`. Exits 0 on full match, exits 1 with a precise drift report otherwise (D5).

**Requirements:** R3, R4.

**Dependencies:** U1.

**Files:**
- Create: `scripts/check-property-names.js`
- Modify: `package.json` (add `"check:property-names": "node scripts/check-property-names.js"` script)
- Modify: `README.md` or an existing developer doc to document how to run the validator (one short paragraph)

**Approach:**
- Script imports each `*_PROPS` group + the matching `dbId` from config.
- For each constant: look up `liveDb.properties` for the entry whose ID matches `constant.id`. Compare `liveProperty.name` to `constant.name`. Mismatch = report it (e.g., `STUDY_TASKS_PROPS.REF_START expected name '[Do Not Edit] Reference Start Date', live name 'Reference Start Date'`). Missing live property = report it (`constant points at id 'X' which no longer exists`).
- Surface property-type drift too (e.g., a property changed type from `date` to `formula`) — cheap to add and useful as a cross-check.
- Reads use the cascade pool token (or a dedicated read-only token if available); zero writes.

**Patterns to follow:**
- Existing `scripts/check-study-blocker-starts.js` — operator-tool shape, minimal arg parsing, fail-loud on drift.

**Test scenarios:**
- Happy path: validator runs against current Notion state and exits 0.
- Drift detection: locally invert one constant's `.name` (temporary edit) and confirm the validator exits 1 with a clear message identifying the offending constant. Revert.
- Missing-property detection: locally edit one constant's `.id` to something nonsense (`'XXXX'`) and confirm the validator exits 1 with a clear message. Revert.

**Verification:**
- Validator passes against live Notion at the time of merge.
- Drift cases above produce expected error output.
- `npm run check:property-names` works as documented.

---

- U6. **Update engine repo docs**

**Goal:** Update authoritative engine docs to reflect the renamed property names. Historical/snapshot docs stay frozen per D6.

**Requirements:** R5.

**Dependencies:** None (parallelizable with U2/U3/U4/U5).

**Files:**
- Modify: `docs/ENGINE-BEHAVIOR-REFERENCE.md` (~11 hits — Sections 1, 7, 9, 11)
- Modify: `docs/CASCADE-RULEBOOK.md` (3 hits)
- Modify: `docs/CONCURRENCY-MODEL.md`
- Modify: `docs/TESTING-REFERENCE.md`
- Modify: `docs/BEHAVIOR-TAGS.md` if any tag-description text references old names
- **Do NOT modify:** `docs/plans/*.md` (historical snapshots per D6); `docs/CODEBASE-REVIEW-2026-04-07.md`, `docs/CODEBASE-REVIEW-2026-04-13.md` (historical snapshots per D6); `docs/brainstorms/meg-apr-16-feedback-batch-requirements.md` (frozen requirements artifact).

**Approach:**
- Find/replace each renamed property name with its new `[Do Not Edit] ` form.
- Add a "renamed 2026-04-28" footnote in the changelog section of `ENGINE-BEHAVIOR-REFERENCE.md`.
- Do **not** touch `docs/plans/*.md` or `docs/CODEBASE-REVIEW-*.md` (D6).
- Do **not** touch `docs/brainstorms/meg-apr-16-feedback-batch-requirements.md` (frozen artifact).

**Test scenarios:**
- Test expectation: none — pure docs.

**Verification:**
- `grep -rE "'?(Reference Start Date|Reference End Date|Template Source ID|Last Modified By System|Processing Lock|SDate Offset|EDate Offset|Notion ID)'?" docs/` (excluding `docs/plans/`, `docs/brainstorms/`, `docs/CODEBASE-REVIEW-*.md`) returns zero hits.
- Each modified doc still reads coherently — no orphan references to old names that would confuse a new reader.

---

- U7. **Update client-folder docs (cross-repo)**

**Goal:** Mirror the rename in client-folder docs that PMs and operators consult. Cross-repo: these files live in the PicnicHealth client folder, parent of the engine repo on disk.

**Requirements:** R6, R8 (foundational status update).

**Dependencies:** None.

**Files (cross-repo — paths shown relative to the PicnicHealth client folder, NOT the engine repo):**
- Modify: `resources/notion/DATABASE-SCHEMA.md` (12 hits — primary reference doc; update first)
- Modify: `resources/notion/DATABASE-GROUNDING-MAP.md` (3 hits)
- Modify: `resources/docs/01-how-the-system-works.md` (2 hits — Meg-facing PM doc, double-check tone)
- Modify: `resources/docs/02-user-guide.md` (1 hit)
- Modify: `resources/docs/03-admin-guide.md` (1 hit)
- Modify: `resources/docs/04-migration-support.md` (1 hit)
- Modify: `resources/migration/prompts/migrate-study.md` (verify hit count)
- Modify: `resources/migration/prompts/00-shared-csv-and-matching.md` (verify)
- Modify: `resources/migration/prompts/generate-migration-summary.md` (verify)
- Modify: `resources/migration/prompts/backfill-production-task.md` (verify)
- Modify: `foundational/STATUS.md` — current state line + new line documenting the 04.28 rename event
- Modify: `foundational/BACKLOG.md` — if any backlog item references old property names, update; otherwise no-op

**Approach:**
- `DATABASE-SCHEMA.md` is the canonical source PMs and engineers consult. Update its tables first; rest of the docs reference back to it.
- For PM-facing docs (`resources/docs/01–04`), preserve tone and reading flow — these were written for non-technical readers.
- `foundational/STATUS.md`: add a current-state bullet for 2026-04-28 documenting the `[Do Not Edit] ` rename + the engine refactor that lands with it.
- `foundational/DECISIONS.md`: add an entry for "2026-04-28 — Adopt property-name constants module" with rationale.

**Test scenarios:**
- Test expectation: none — pure docs.

**Verification:**
- `grep -rE "'?(Reference Start Date|Reference End Date|Template Source ID|Last Modified By System|Processing Lock|SDate Offset|EDate Offset|Notion ID)'?" resources/notion/ resources/docs/ resources/migration/prompts/ foundational/STATUS.md` returns zero hits.
- `DATABASE-SCHEMA.md`'s "Last updated" header bumped to 2026-04-28.

---

- U8. **Notion automation inventory + UI runbook**

**Goal:** Inventory every Notion automation that referenced a renamed property in a filter clause, formula expression, or action payload. Apply the fixes manually in Notion's automation UI per the runbook below. Confirm each automation is green post-fix.

**Requirements:** R7.

**Dependencies:** None for inventory; U2 deployment is a sibling concern.

**Files:**
- Pulse log captures the runbook execution: `pulse-log/04.28/<NNN>-property-rename-automation-fixes.md` (cross-repo, in client folder).

**Approach:**

The Notion API does not expose automation filter/action configuration for read or write. UI-only. Tem applies the runbook below; agents cannot.

**Runbook — Notion automations to verify and (likely) fix:**

| # | Database | Automation | Likely-affected reference | What to update |
|---|---|---|---|---|
| 1 | Study Tasks DB | "When Dates changes" | LMBS check in filter (`Last Modified By System ≠ true`) | Replace with `[Do Not Edit] Last Modified By System` |
| 2 | Study Tasks DB | "When Status changes" | LMBS check (same) | Same |
| 3 | Study Tasks DB | "Fill out reference properties" (Fill Refs view) | Action: `Set Reference Start Date` ← formula; `Set Reference End Date` ← formula | Repoint to `[Do Not Edit] Reference Start Date` / `[Do Not Edit] Reference End Date` |
| 4 | Study Tasks DB | "Dep Edit Cascade" (just shipped today) | Filter: `Reference Start Date is not empty`; `Subtask(s) is empty` (latter unaffected) | Repoint Reference filter |
| 5 | Studies DB | Initial Activator button | Webhook payload action — does it set Import Mode? | Repoint to `[Do Not Edit] Import Mode` if so |
| 6 | Studies DB | Each Add-Task-Set button (6 types) | Same Import Mode question | Same |
| 7 | Studies DB | Task Deleter button | Same | Same |
| 8 | Studies DB | Cascade Undo-er button | Same | Same |
| 9 | Study Tasks DB | "Fill Refs" view filter | Filter: `Reference Start Date is empty OR Reference End Date is empty` | Repoint both |

**For each automation:**
1. Open in Notion UI.
2. Inspect filter, formula, and action payload for old property names.
3. Replace with new names.
4. Save.
5. Tick off in the pulse log; capture screenshot if the change is non-obvious.

**Test scenarios:**
- Test expectation: live verification per U9 smoke test below.

**Verification:**
- Each automation is saved without errors.
- Smoke test (U9) exercises each automation type successfully.

---

- U9. **Smoke test + close the loop**

**Goal:** Deploy the engine refactor + apply U8 automation fixes, then run an end-to-end smoke test against Meg's most recent test study to confirm the cascade engine works against live Notion. Update foundational record + Slack Meg.

**Requirements:** R7, R8.

**Dependencies:** U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8 (full chain). **U8 (Tem's Notion UI runbook) must be signed off in the pulse log before U9 step 1 runs** — without U8, the Notion automations still reference renamed property names and every smoke test below will fail end-to-end even though the engine is green.

**Files:**
- Create: `pulse-log/04.28/<NNN>-property-rename-refactor.md` (cross-repo, client folder)
- Modify: `foundational/STATUS.md` — update current-state with the deployed refactor
- Modify: `foundational/DECISIONS.md` — add the 2026-04-28 decision entry per D7 in U7

**Approach:**

After PR merges and Railway redeploys:

0. **Confirm U8 automation fixes are applied in Notion UI** — review Tem's pulse log entry against the U8 runbook table; every row checked off. If not, stop and complete U8 before continuing.
1. Run validator: `npm run check:property-names` → expect green.
2. Run script: `node scripts/verify-inception.js <test-study-id>` → expect green.
3. Pick a fresh test study (or have Meg create one — current is `Meg-Test-4-28-3502386760c280c3b707c1a95f5924c2`).
4. Smoke test each automation type:
   - **Inception** — press Initial Activator on a fresh study with Contract Sign Date set. Expect ~245 tasks created, all dates populated, Reference Start/End populated, no error in Automation Reporting.
   - **Add task set** — press Repeat Delivery Adder. Expect new delivery #N tasks, dates copied from prior delivery, Template Source ID set.
   - **Date cascade** — edit a task's Dates. Expect cascade fires, downstream tasks shift, Activity Log row written, Reference Start/End updated. Check Railway logs: no 400s on property writes.
   - **Status rollup** — mark a subtask Done. Expect parent status doesn't roll up if other subtasks pending; rolls up when all subtasks Done.
   - **Undo cascade** — press Cascade Undo-er. Expect previous Reference dates restored, Activity Log row reflects undo.
   - **Dep-edit (shipped today)** — wire a new `Blocked by` relation as a non-bot user. Expect Reference dates stay aligned; Activity Log row with `Cascade Mode = dep-edit`.
   - **Deletion** — on a throwaway test study, press Task Deleter. Expect all tasks archived, no orphans.
5. Pulse log captures pass/fail for each.
6. Slack Meg: "Property rename adjustment shipped — ready for testing again."

**Test scenarios:**
- Each smoke-test step above is a behavior assertion; pass/fail recorded in the pulse log.

**Verification:**
- All 7 automation types pass smoke test.
- Validator green.
- Pulse log + DECISIONS entry written.
- Slack Meg sent.

---

## System-Wide Impact

- **Interaction graph:** Every Notion automation that fires a webhook depends on a property-name match in its UI configuration (Notion automation UI doesn't expose ID-keyed configuration). The runbook in U8 enumerates each known case; agents rely on Tem to apply UI changes.
- **Error propagation — engine surfaces:** Post-refactor, every read/write/filter is ID-keyed (D2b) and rename-immune at runtime. The only exception is `reportStatus` (cross-DB writer keeping name-keyed writes for `'Automation Reporting'`). The validator (U5) catches name drift in the constants file as a sanity check, but engine correctness no longer depends on the validator firing — a Meg-rename mid-day continues to work via property ID resolution until the constants `.name` field is updated for documentation purposes.
- **Error propagation — automation surfaces:** Until U8 is applied, the engine can be green while individual automations silently fail in the Notion UI. U9 smoke test exercises each automation end-to-end and surfaces any U8 misses.
- **State lifecycle risks:** Pre-production status means no live PM data is at stake. The smoke test runs on Meg's test study, which is disposable.
- **API surface parity:** Engine routes are the only "API surface." Every route handler is touched in U2; no surface is left unmaintained.
- **Integration coverage:** `dep-edit` shipped today and has its own integration tests; the property-name refactor touches it. U9 smoke test exercises the path Meg flagged broken yesterday.
- **Unchanged invariants:** Cascade behavior (BL-Hng rules, fan-in/fan-out, parent-edge stripping, Complete Freeze, Import Mode gating) is **explicitly unchanged** by this refactor. The 553 existing tests guard this assertion. If any test fails for a reason other than "constant value mismatch" — and tests are kept structurally identical, only the property identity layer changes — that is a regression and stops the refactor.
- **Rename-resilience future:** After this plan ships, the next Meg-rename of any property still in the constants module is invisible to the running engine — every surface (reads via `findById`, writes via `[id]`, filters via `id`) keeps resolving by property ID through the rename window. The constants' `.name` field becomes documentation drift until updated; the validator (U5) flags this as a CI failure on the next deploy and the constant gets a one-line update. No production downtime.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Missed read-site reference in a less-grepped corner (a read site still using bare strings means it bypasses `findById` and re-introduces rename vulnerability) | Greppable check in U2 verification (`page\.properties\[\s*'[^']+'\s*\]` returns zero hits); smoke test (U9) exercises every route end-to-end. |
| `reportStatus` carve-out drifts to other writers ("we needed another cross-DB writer, copied the carve-out pattern, never documented") | Document the carve-out inline in `reportStatus` and in D2b. Greppable check in U2 verification: only one bare-string write site (`reportStatus`) should remain. |
| Notion API actually requires raw (non-URL-encoded) property IDs in some surface, contrary to assumption | Resolved during U1 by spot-testing PATCH and filter with both forms; if raw form needed, add a `decode()` helper or store raw form in constants. Captured as a deferred-to-implementation question. |
| Notion UI filter/action references not all caught by the U8 runbook table | Runbook is a starting list; smoke test (U9) exercises each automation type and surfaces misses. |
| `Owner` asymmetry (Blueprint renamed, Study Tasks not) introduces a subtle bug at U2 implementation time | Per-DB grouping in constants makes the asymmetry explicit by construction. Test fixtures in U3 mirror it. |
| Validator script (U5) relies on a Notion read token; misconfigured env vars during CI could mask drift detection | Script fails loud (exits 1) on missing tokens. CI run logs this clearly. |
| Plan grew during execution into "let's also refactor X" — scope creep | Scope Boundaries are explicit; default is "out of scope, file as new ticket." `ce-work` discipline. |
| n8n workflow deactivated but not yet shut down | n8n was confirmed deactivated 2026-04-07 (per `STATUS.md`). Risk effectively zero. |
| Property IDs themselves change (extremely rare in Notion — happens only on property *recreation*, not rename) | Validator detects this as "constant points at deleted property." Recovery: re-fetch the new ID from the live DB, update the constant. |
| ID-keyed write payload accepted by Notion but silently no-ops if the form is wrong | Smoke test (U9) verifies every route writes successfully against live Notion. The Activity Log row + downstream date change is the empirical proof. |

---

## Documentation / Operational Notes

- **Single PR for engine work.** Engine units U1–U6 land in one PR (`refactor: centralize Notion property names + validator`). Per-unit commits inside the PR keep history readable.
- **Sibling commit on the client-folder side.** U7 lands as a separate commit in the client folder (no PR — client folder is a working dir, not a github repo).
- **U8 runbook is operator-driven.** Agents document what to do; Tem clicks the buttons.
- **U9 smoke test is the ship gate.** PR merge + Railway redeploy + automation fixes + smoke pass = done.
- **Slack Meg post-smoke.** Re-enable testing flow. Meg has been blocked since the rename; closing the loop is part of the deliverable.

---

## Sources & References

- **Investigation pulse log:** to be created — `pulse-log/04.28/001-property-rename-investigation.md` (cross-repo)
- **Database schema (current):** `resources/notion/DATABASE-SCHEMA.md` (cross-repo, will be updated by U7)
- **Recent dep-edit plan (precedent for runbook pattern + cross-system unit):** `docs/plans/2026-04-27-001-feat-dep-edit-cascade-plan.md`
- **Engine behavior contract:** `docs/ENGINE-BEHAVIOR-REFERENCE.md`
- **Status snapshot (pre-rename):** `foundational/STATUS.md` (cross-repo)
- **Live Notion DBs (validator inputs):**
  - Study Tasks: `40f23867-60c2-830e-aad6-8159ca69a8d6`
  - Studies: `cad23867-60c2-836f-a27d-0131c25b6dcd`
  - Study Blueprint: `8fe23867-60c2-83e9-a95d-01ade939f5c2`
  - Activity Log: `f5123867-60c2-8226-9d66-810554f3ec81`
- **Notion API reference (property updates):** https://developers.notion.com/reference/page-property-values
- **Prior incident (rename surfaces silent break):** `foundational/INCIDENTS.md` (cross-repo) and Slack 2026-03-06 thread on "Automation issues" → "Automation Reporting"
- **CLAUDE.md rule:** "Property renames = workflow audit. When renaming a Notion DB property, ALWAYS grep all n8n workflow Code nodes for the old name BEFORE renaming." (extended here to engine code + validator-mechanized)

---

## Deferred / Open Questions

### From 2026-04-28 review

The doc-review pass surfaced these items. The 6 high-impact items (2 P0 + 4 P1) were resolved inline (see commit history). The items below were appended to Open Questions per Tem's review-time decision; they should be revisited during implementation or in a follow-up review pass.

#### P2 — worth resolving during implementation

- **Filter clauses for `Study` / `Parent Task` relations span 4+ sites not just import-mode-sweep** *(ce-feasibility, anchor 75)*. D4 calls out `import-mode-sweep.js:22` but the same `{ property: 'Study', relation: { contains: ... } }` pattern appears in `src/notion/queries.js:8`, `src/routes/inception.js:58`, `src/routes/add-task-set.js:149`, `src/routes/status-rollup.js:53/113`. **Suggested fix:** during U2, enumerate the full known-site list inline as each file is touched; the discipline is the same (filter `property:` field uses `.id`).
- **Problem Frame overstates what's broken — engine doesn't actually read/write LMBS / Processing Lock / Notify on Done / Notion ID** *(ce-feasibility, anchor 100)*. Greps confirm engine source has zero references to these in `src/`; only `scripts/verify-inception.js` reads LMBS. The Problem Frame failure-mode bullets should narrow to: writes that 400 are Reference Start/End Date and Template Source ID; reads that return undefined are SDate/EDate Offset, Owner (Blueprint), Import Mode rollup. Adds clarity for future readers about what failure surface this plan was actually responding to.
- **Scope reconsideration: hotfix-only path was not weighed against the full refactor** *(ce-product-lens root + ce-scope-guardian × 4 dependents, anchor 75)*. Pre-production with Meg blocked, the validator has overlap with the U9 smoke test, and U6/U7 doc updates are no-behavior-change. An alternative phasing: hotfix-first (rename strings, ship in ~30 min, unblock Meg) → constants module + validator + non-renamed properties + docs as a separate hardening PR. The plan's "Why this is the right scope" section argues for *some* refactor but doesn't compare against this cheaper path. **Defer rationale:** Tem's already chosen the long-term path (per /ce-plan question 2); revisit only if implementation time substantially exceeds estimate.
  - Sub: **Non-renamed properties pulled into constants module without proportional justification** — could narrow U1 to renamed properties only, file rest in a follow-up.
  - Sub: **U5 CI-able validator duplicates U9 smoke test coverage** — could ship validator script without CI wiring (`package.json` + README), defer CI integration to a hardening PR.
  - Sub: **U6 / U7 doc updates on the U9 critical path** — could ship as parallel commits, not as gating dependencies.
  - Sub: **R4 (validator) framed as ship-gate requirement vs. hardening** — could reclassify as P1/P2 priority rather than P0 ship-gate.
- **Validator only checks declared constants — schema additions go undetected** *(ce-adversarial, anchor 75)*. If Meg adds a new property to Study Tasks DB tomorrow, the engine won't know and the validator won't flag it. **Suggested fix:** extend U5's validator to also report "live properties not declared in constants" as a warning (not failure — many additions may be intentionally engine-irrelevant). Adds a single grep-style cross-check.
- **Smoke test pass criteria don't explicitly verify writes persisted** *(ce-adversarial, anchor 75)*. U9's pass criteria are observational (e.g., "downstream tasks shift," "no error in Automation Reporting"). If Notion silently no-ops an unknown-key PATCH, the smoke could pass while the property write fails. **Suggested fix:** for each smoke-test step, add a "verify by reading back" substep — after Inception, GET a Study Task page and confirm Reference Start Date is set on the page (not just observable downstream).

#### P3 / FYI — useful context, lower priority

- **Terminology drift: "reflect" vs "mirror" used interchangeably for doc updates** *(ce-coherence, anchor 50)*. R6 says "reflect"; U7 Approach says "mirror." Standardize on "reflect."
- **`resources/ops/LESSONS-LEARNED.md` deferral rationale ambiguous** *(ce-coherence, anchor 50)*. The "single line; can be updated opportunistically" framing leaves the implementer guessing whether it's in scope or out. Either move to U7 Files with a clear instruction or reword the deferral.
- **"Cascade pool token" jargon undefined in U5** *(ce-coherence, anchor 50)*. The term appears nowhere else in the plan. Add a one-line reference: "see `src/config.js` and `scripts/check-study-blocker-starts.js` for the token-injection pattern."
- **`Object.freeze` may trip Jest mocks if any test attempts module-level constant override** *(ce-adversarial, anchor 50)*. Verify during U1 by grepping tests for `STUDY_TASKS_PROPS.X = ...` patterns; if any exist, drop `Object.freeze` or rewrite the test.
- **Validator depends on right token + right workspace; misconfigured token pointing at wrong workspace passes silently** *(ce-adversarial, anchor 50)*. Cheap mitigation: at script start, log the DB title from `client.retrieveDatabase().title` and assert it matches expected. Prevents silent token-misconfig false-passes.
- **Validator framed as "CI-able" but CI integration not actually wired in U5** *(ce-product-lens, anchor 50)*. The npm script is added but no GitHub Actions / Railway pre-deploy hook ships. Either extend U5 to wire CI (better long-term protection) or downgrade language from "CI-able" to "operator tool."
- **Per-DB grouping is a new abstraction; flat-module-with-namespaced-names alternative not weighed** *(ce-scope-guardian, anchor 50)*. Acknowledge in D1 that a flat module was considered and rejected because of the Owner asymmetry. ACTIVITY_LOG_PROPS with one entry could be omitted without affecting any requirement.
- **Identity bet: engine becomes "system with elaborate property-name scaffolding"** *(ce-product-lens, anchor 50, same-persona collapse)*. After this plan ships, every new Notion-touching feature must extend `*_PROPS`. Future contributors must reach for the constants module reflexively or the discipline breaks. Worth a brief "house rule" doc for handoff to Seb.
- **Constants-module shape vs typed-wrapper alternative not considered** *(ce-product-lens, anchor 50, same-persona collapse)*. Alternative abstraction: thin typed wrapper around `client.patchPage` taking a property-definition object (e.g., `client.setProperty(pageId, REF_START, value)`) — hides the asymmetry from call sites entirely. Higher cost up front; cleaner ergonomics long-term. Worth a paragraph in D1 acknowledging the alternative and why per-DB constants won.
- **Path dependency: per-DB grouping creates extension friction for every future Notion-touching feature** *(ce-product-lens, anchor 50)*. Trade-off acknowledgment: every new property adds a constants edit. Compounding direction depends on rename frequency vs. feature add rate.

### From 2026-04-28 round 2 review

The round 2 reviewers caught new tradeoffs introduced *by* round 1's edits. The 3 P1 cluster findings (Step 0b ceremony, reportStatus uniqueness empirical check, findById hot-loop reshape) were resolved inline. These items were appended for implementer awareness:

#### P2 — surface during implementation

- **`findById` call-site ergonomics regression unexamined** *(ce-product-lens, anchor 75)*. Every read site flipped from `page.properties[name]?.date?.start` to `findById(page, propDef)?.date?.start`. More verbose; performs O(n) iteration vs O(1) hash lookup; adds a helper future contributors must know about. The Step 0c reshape note in U2 mitigates the perf concern in hot loops; the ergonomic concern remains. Worth a paragraph in D2b acknowledging the trade — name-keyed reads + validator was a viable alternative the plan didn't explicitly weigh.
- **`findById` returning undefined silently is a debuggability regression** *(ce-adversarial, anchor 75)*. Bad constant (e.g., `.id` no longer matches a live property) returns undefined from every call site silently. Mitigation: add a dev-mode assertion to `findById` that throws or `console.warn`s when no property matches the `.id`. Or wire the validator to run as a pre-commit hook for tighter discovery loop.
- **Truncated payloads / webhook-first reads not addressed by the findById flip** *(ce-adversarial, anchor 75)*. Engine has webhook payload-first patterns (per CLAUDE.md). `findById` against a truncated webhook payload that only includes touched properties (not full page response) returns undefined for properties not in the snapshot. The U2 refactor should audit each read site for full-page-response vs payload-snapshot input; for snapshots, either refetch the page (extra GET, note in commit) or document a per-site carve-out.
- **ACTIVITY_LOG_PROPS group serves completeness, not R1** *(ce-scope-guardian, anchor 75)*. Activity Log has zero renames; the group exists only to satisfy "module is the complete property surface" (D1). Could defer to a follow-up hardening PR. If kept in scope, the HLT sketch's `// ... etc ...` ellipsis is incomplete — implementer needs the full 13-property enumeration (Entry, Summary, Details, Status, Workflow, Trigger Type, Cascade Mode, Execution ID, Study Tasks, Tested by, Duration (ms), Original Dates, Modified Dates) before U2 touches `activity-log.js`.

#### P3 — house-rule observations

- **Step 0a/0b establishes "verify-empirically-before-coding" discipline as new norm** *(ce-product-lens, anchor 75)*. Trimmed in round 2 to a single spot-test, but Step 0a's ID re-fetch + investigation pulse log discipline is still in place. Worth naming explicitly as a house rule (or inheriting an existing one) so future plans either adopt the discipline deliberately or know they're allowed to skip it.
- **Validator role ambiguous after read-flip — load-bearing or sanity check?** *(ce-product-lens, anchor 75)*. D2b says sanity check; R4 still frames it as primary requirement at the same level as R1-R3; U5 still ships full unit; U9 step 1 still gates smoke on validator green. Either downgrade R4's priority, downscope U5 (drop drift/missing-property test scenarios for a thinner script), or explicitly state "validator stays full-strength as documentation hygiene even though correctness no longer requires it."
- **`reportStatus` carve-out greppable check is one-time, not persistent** *(ce-scope-guardian, anchor 50)*. Round 2's Step 0c covers pre-refactor verification. Long-term, adding `check:write-discipline` as a `package.json` script (running the same grep) would convert the one-time check into a persistent invariant and prevent future drift. Cheap; defer to a hardening PR.

