---
title: "feat: Post-flight duplicate sweep + weekly cadence + historical cleanup"
type: feat
status: active
date: 2026-04-20
revised: 2026-04-20 (post document-review)
origin: engine/docs/plans/2026-04-16-004-refactor-notion-client-idempotency-plan.md (superseded probe-based plan)
---

# PR E2 — Post-Flight Duplicate Sweep (with weekly cadence)

## Overview

Three layered safety nets for silent duplicate tasks:

1. **Per-run post-flight sweep.** After `createStudyTasks` finishes, wait a grace delay (≥30s, default 45s configurable via `SWEEP_GRACE_MS`), query the study's tasks, group by `Template Source ID`, archive any extras the engine didn't track. Runs for inception and add-task-set.
2. **Weekly full-workspace sweep.** Scheduled script that scans all active studies for latent duplicates (in case the per-run sweep missed any). Catches duplicates persisting from before PR E1 / PR E2 shipped AND any that slip through the grace window.
3. **One-time historical cleanup.** Single run of the full-workspace sweep on current state. Archives the estimated 5–20 existing duplicates across active studies.

Shipped as the third PR in the E0/E1/E2 sequence. Depends on PR E0 (shared `withStudyLock`) for race-safety.

## Problem Frame

PR E1 (path-based narrow retry) eliminates the dominant source of retry-after-commit duplicates. But narrow retry is preventive at our layer — it can't catch:

1. **Notion's own internal retries** between its edge and backend (documented).
2. **Ambiguous error classifications** that fall into our conservative `unsafe_retry` default but were actually safe.
3. **Unknown-unknowns** — any future duplicate-producing pathway.

The sweep is the safety net. It accepts that duplicates may transiently exist, and cleans them up deterministically.

Measured baseline (2026-04-20 investigation):
- 5.4% of success runs have retries → potential duplicate candidates.
- Concentrated in 200-task inceptions (~22% rate).
- Consistency experiment confirmed probes won't work — ≥30s grace delay required for reliable query visibility.
- Estimated 5–20 existing silent duplicates across active studies.

**Why a weekly cadence (added post document-review):** the per-run sweep is scoped to the TSIDs created by that run. If a duplicate slips past the 45s grace window (rare but possible given the consistency experiment's small n=48 sample), it persists forever in the DB because the next run's sweep only looks at its own TSIDs. A weekly workspace-wide sweep catches these stragglers. Also covers any duplicates from pre-E1 code paths that aren't in the historical cleanup.

## Requirements Trace

- **R2-1.** After `createStudyTasks` returns successfully, initiate a post-flight sweep for the study + operation.
- **R2-2.** Sweep waits `SWEEP_GRACE_MS` (env-configurable, default 45000, min 30000 per empirical data + safety margin) before querying.
- **R2-3.** Sweep query strategy: **single query on `Study = X`** fetching all tasks in the study (paginated). Client-side group-by `Template Source ID`. Compare against the engine's own created-pages list. No per-TSID Notion queries — scales independently of batch size.
- **R2-4.** Keep-rule: engine's own created-page list (derived from `createStudyTasks` return) is authoritative. Any page in Notion with a matching TSID whose page ID is NOT in that list is a duplicate — archive it.
- **R2-5.** Archive via a new `client.archivePage(pageId)` method that wraps `PATCH /pages/:id` with `{archived: true}` (top-level, not under `properties`). Existing `patchPage` is not reusable because it always wraps args under `{properties: ...}`.
- **R2-6.** Sweep runs inside `withStudyLock` coverage (from PR E0's shared lock). No concurrent writes to the same study during sweep.
- **R2-7.** Telemetry: sweep emits tracer counters `sweepDuplicatesFound`, `sweepDuplicatesArchived`, `sweepDuplicatesFailed`, `sweepQueryFailed`. **Also records the archived page IDs** in tracer details so support can trace back if a sweep archives something important.
- **R2-8.** Sweep failure is non-fatal to the run. Creates succeeded; cleanup is best-effort. Logged + recorded in tracer.
- **R2-9. Weekly scheduled sweep** (`scripts/sweep-all-studies.js`) scans all active studies for duplicates. Runs via cron (or Railway scheduler). Dry-run by default; emails/comments a report for operator review if duplicates found.
- **R2-10. One-time historical cleanup.** Same script, manual run, `--archive` flag. Operator reviews dry-run first, then executes.
- **R2-11.** `ENGINE-BEHAVIOR-REFERENCE.md` gains a "Duplicate Prevention" section documenting the three-layer architecture (narrow retry + per-run sweep + weekly sweep). Pulse log entry for 2026-04-20.
- **R2-12.** Copy-blocks is NOT swept. Block-level duplicate detection is structurally harder; narrow retry + existing skip-on-error is the copy-blocks strategy.

## Scope Boundaries

- **No change** to create paths beyond adding a post-flight call. `createStudyTasks` return shape is unchanged; the caller derives `trackedIds` and `tsids` from the existing `idMapping` return field.
- **No change** to cascade engine, Activity Log emission rules (sweep just adds counters + archived-ID list), study-comment flow, copy-blocks.
- **No change** to error-handling discipline — sweep failure doesn't fail the run.
- **Not in scope:** real-time observability dashboards, alerting thresholds.
- **Not in scope:** block-append duplicate cleanup. See R2-12.
- **Not in scope:** sweep running for deletion or undo-cascade routes. Those paths don't create pages.
- **Not in scope:** `archivePage()` method being used by other callers. It's a new method solely for the sweep service.

## Context & Research

### Relevant Code and Patterns

- `engine/src/provisioning/create-tasks.js:257-262` — `createStudyTasks` current return shape: `{ idMapping, totalCreated, depTracking, parentTracking }`. `idMapping` is `{[templateSourceId]: newPageId}`. The sweep derives `trackedIds` and `tsids` from this at the call site. No change to the function signature.
- `engine/src/routes/inception.js` — post-`createStudyTasks` is where the sweep call inserts. **After** the wiring step and **after** copy-blocks fires (copy-blocks is async fire-and-forget). Placing the sweep after wiring means the keep-rule operates on fully-wired pages; placing after copy-blocks means the sweep doesn't interfere with the copy step.
- `engine/src/routes/add-task-set.js` — same pattern.
- `engine/src/notion/client.js:157-159` — `patchPage(pageId, properties, {tracer})` always wraps under `{properties: ...}`. Does NOT work for archive (archive is a top-level field). Need to add `archivePage(pageId)` that calls `request('PATCH', '/pages/:id', {archived: true})` directly.
- `engine/src/notion/client.js:178-215` — `queryDatabase` with filter. The sweep uses a `Study` relation filter (single condition, simple). Paginated if study has >100 tasks.
- `engine/src/services/cascade-tracer.js` — telemetry accumulation.
- `engine/scripts/migrate-relative-offsets.js` — existing one-off script pattern. Raw fetch + single token. Model for the historical/weekly sweep scripts.
- `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` — new "Duplicate Prevention" section lives here.
- `engine/src/config.js` — env-var plumbing. `SWEEP_GRACE_MS` joins the existing constants.

### Institutional Learnings

- **Consistency experiment (2026-04-16)** — max observed visibility lag 15.4s. 45s grace = ~3× margin over observed max. Sample size n=48 is thin; weekly sweep covers the p99/p99.9 stragglers.
- **PR #56 (withStudyLock)** — add-task-set is already under the lock. PR E0 extends to inception AND extracts to shared service so per-run sweeps from both routes share coordination.
- **Activity Log retry rate (2026-04-20)** — 5.4% baseline. Post-E1, expected to drop substantially. Sweep frequency expected: low (residue only). Telemetry confirms post-deploy.
- **Historical duplicate estimate** — 5–20 across active studies. One-time cleanup manageable.
- **Document-review findings (2026-04-20)** — identified: `createStudyTasks` return shape mismatch (fixed via idMapping derivation), `patchPage` signature can't archive (fixed via new `archivePage` method), per-TSID queries would be slow (fixed via `Study = X` + client-side filter), scope-limited sweep leaves persistent misses (fixed via weekly cadence), grace delay test env needs explicit 0-override (documented).

### External References

- [Notion API `PATCH /pages/{id}`](https://developers.notion.com/reference/patch-page) — `archived` is a top-level field.
- [Notion filter — relation contains](https://developers.notion.com/reference/post-database-query-filter) — supports `Study contains studyId` query.

## Key Technical Decisions

- **Derive trackedIds + tsids from `idMapping`, don't change `createStudyTasks`.** `idMapping` is `{[TSID]: pageId}` — exactly the data the sweep needs, just in a different shape. One-line derivation at the call site: `const trackedIds = new Set(Object.values(idMapping)); const tsids = Object.keys(idMapping);`. No API surface change.
- **New `archivePage(pageId)` method on NotionClient.** Existing `patchPage` always wraps under `{properties: ...}` which rejects top-level `archived`. Add a dedicated method; mirrors `deletion.js:29-32`'s direct raw call.
- **Single `Study = X` query, client-side TSID filter.** Notion's filter spec doesn't support `rich_text IN [...]`. 200 per-TSID queries would cost ~5-10s on top of the sweep. A single relation-filter query (paginated) returns all tasks in the study in 1-2 API calls. Client-side groups by TSID. Fastest + simplest.
- **Sweep placement: AFTER wiring + AFTER copy-blocks fires.** Wiring happens before the sweep so duplicates that were never wired are easy to identify. Copy-blocks fires fire-and-forget — its response doesn't gate the sweep. Sweep operates purely on task creation outputs, not block content.
- **`SWEEP_GRACE_MS` in `config.js`, not `process.env.*` in the service.** Matches the pattern from `config.cascadeDebounceMs` (line 32). Makes test-harness overrides clean and keeps env-var touching centralized.
- **Sweep holds `withStudyLock` throughout** — grace delay + query + archives. PR E0's extraction to a shared service ensures this coordination is cross-route-safe.
- **Record archived page IDs in tracer details.** Not just counter values — the IDs themselves. Lets support un-archive a mistakenly-archived page if the keep-rule turns out to be wrong in a specific case. Per document-review finding F6.
- **Weekly cadence is a scheduled script, not a cron inside the engine.** Easier to reason about, easier to pause/adjust. Set up via Railway Cron or an external scheduler. Out-of-band from the main request-path infrastructure.
- **Historical script and weekly script share code.** Same `scripts/sweep-all-studies.js`. `--dry-run` (default) prints a report. `--archive` executes. Manual for historical; scheduled for weekly.
- **Historical keep-rule is different from per-run keep-rule.** Historical has no engine-tracked list (retroactive). Falls back to: keep the task whose `Parent Task` / `Blocked by` / `Blocking` relations are wired; among duplicates all-wired or all-unwired, fall back to earliest `created_time`; among ties, emit a warning and include in dry-run report for manual resolution. **Dry-run mandatory. Operator approval required before `--archive` runs.**
- **User-edit protection for historical script.** If a duplicate has comments OR `last_edited_by != engine-bot` OR non-default status, flag in dry-run and skip archiving (manual resolution only). Per document-review finding F10.

## Open Questions

### Resolved During Planning

- **`createStudyTasks` return shape** — derive from existing `idMapping` field. No function change.
- **Archive method** — add `archivePage(pageId)` to NotionClient. New method, not `patchPage`.
- **Query strategy** — single `Study = X` query + client-side filter.
- **Grace delay** — 45s default via `config.sweepGraceMs`, env-configurable via `SWEEP_GRACE_MS`. Min 30s.
- **Sweep placement relative to copy-blocks** — after copy-blocks fires (fire-and-forget); sweep doesn't wait for copy-blocks.
- **User-edit protection** — historical script flags + skips pages with comments / non-engine-bot edits / non-default status.
- **Tracer records archived page IDs** — yes, in tracer details.
- **Test `SWEEP_GRACE_MS = 0`** — set in test harness setup (per-test override). Document in the service's test file.

### Deferred to Implementation

- **Exact test harness mechanism for `SWEEP_GRACE_MS = 0`** — likely a `vi.mock` on `config.js` or passing an explicit param to `duplicateSweep.run()` in tests. Implementer picks.
- **Weekly sweep scheduling mechanism** — Railway Cron if available, GitHub Actions scheduled workflow, or external cron. Decide post-merge based on ops preference.
- **Dry-run report format** — JSON + human-readable summary. Exact shape decided at implementation.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
// In inception.js / add-task-set.js, after createStudyTasks + wiring + copy-blocks fire:

const { idMapping } = await createStudyTasks(...)
const trackedIds = new Set(Object.values(idMapping))
const tsids = Object.keys(idMapping)

await duplicateSweep.run({ studyPageId, trackedIds, tsids, tracer })

// Then: Activity Log success emission, user-facing completion.

// In duplicate-sweep.js:

async function run({ studyPageId, trackedIds, tsids, tracer }) {
  await sleep(config.sweepGraceMs)

  const allStudyTasks = await queryAllStudyTasks(studyPageId)  // paginated
  const byTsid = groupBy(allStudyTasks, t => t.properties['Template Source ID'])

  const tsidsToCheck = new Set(tsids)
  for (const [tsid, tasks] of byTsid) {
    if (!tsidsToCheck.has(tsid)) continue  // skip TSIDs not from this run
    if (tasks.length <= 1) continue

    for (const task of tasks) {
      if (trackedIds.has(task.id)) continue  // canonical — keep
      tracer.recordSweepDuplicateFound({tsid, pageId: task.id})
      try {
        await client.archivePage(task.id)
        tracer.recordSweepDuplicateArchived({tsid, archivedId: task.id})
      } catch (err) {
        tracer.recordSweepDuplicateFailed({tsid, targetId: task.id, err})
      }
    }
  }
}

// In client.js (new method):
async archivePage(pageId, {tracer} = {}) {
  return this.request('PATCH', `/pages/${pageId}`, {archived: true}, {tracer})
}
```

## Implementation Units

- [ ] **Unit 1: Add `archivePage(pageId)` to NotionClient**

**Goal:** New method for archiving pages. `patchPage` can't do this because it wraps args under `{properties: ...}`.

**Requirements:** R2-5.

**Dependencies:** None.

**Files:**
- Modify: `engine/src/notion/client.js`
- Test: `engine/test/notion/client.test.js`

**Approach:**
- Add method: `async archivePage(pageId, {tracer} = {}) { return this.request('PATCH', `/pages/${pageId}`, {archived: true}, {tracer}) }`.
- Routes through the standard request path. PATCH to `/pages/:id` is classified as **idempotent** by PR E1's classifier (it's a page-level update, not a block-append). Retries apply normally — good, because archive is idempotent at Notion's side (archiving an already-archived page is a no-op).

**Patterns to follow:**
- Existing `patchPage` at `client.js:157-159` — similar shape.
- `deletion.js:29-32` — already does the same raw PATCH pattern for archive.

**Test scenarios:**
- **Happy — archive a page:** `client.archivePage('page-id-X')` calls PATCH `/pages/page-id-X` with body `{archived: true}`.
- **Happy — archive an already-archived page:** idempotent; returns success.
- **Edge — archive a non-existent page:** 404 surfaces as `non_retryable` per PR E1's classifier. Propagates to caller.
- **Edge — archive a page we don't have permission for:** 403; non_retryable.

**Verification:**
- `npm run test:ci` passes. Method present and tested.

- [ ] **Unit 2: Create `duplicate-sweep` service**

**Goal:** Encapsulate sweep logic. Testable in isolation.

**Requirements:** R2-1, R2-2, R2-3, R2-4, R2-6, R2-7, R2-8.

**Dependencies:** PR E0 (shared `withStudyLock`) merged. Unit 1 (`archivePage`).

**Files:**
- Create: `engine/src/services/duplicate-sweep.js`
- Create: `engine/test/services/duplicate-sweep.test.js`
- Modify: `engine/src/config.js` (add `sweepGraceMs`)

**Approach:**
- Export `run({ studyPageId, trackedIds, tsids, tracer, notionClient })`. `notionClient` is injected for testability.
- Waits `config.sweepGraceMs` (default 45000).
- Queries Notion for all tasks in `studyPageId` via `notionClient.queryDatabase(studyTasksDbId, {filter: {property: 'Study', relation: {contains: studyPageId}}})`. Paginates as needed.
- Groups results by `Template Source ID` (rich_text property).
- For each TSID in the run's `tsids`: if more than one task has that TSID, the extras (IDs not in `trackedIds`) are archived via `client.archivePage`.
- Records counters + archived page IDs in tracer.
- Wrapped in try/catch; top-level sweep failure (e.g., query fails) is recorded but not thrown.
- Add `sweepGraceMs` to `config.js` following the existing `cascadeDebounceMs` pattern.

**Patterns to follow:**
- `engine/src/services/cascade-tracer.js` for tracer integration.
- `engine/src/config.js` existing env-var constants.

**Test scenarios:**
- **Happy — no duplicates:** query returns exactly trackedIds. Zero archives. Tracer: no emissions.
- **Happy — one duplicate:** query returns trackedIds + 1 extra. Extra archived. Tracer: `sweepDuplicatesFound: 1, sweepDuplicatesArchived: 1`, archived ID recorded.
- **Happy — multiple TSIDs with duplicates:** 3 TSIDs, each with 1 extra. All 3 archived.
- **Edge — duplicate's ID happens to be in trackedIds** (shouldn't, but): not archived. Defensive.
- **Edge — TSID not in `tsids` parameter** (a stale DB entry from a different run): skipped. Not this sweep's concern.
- **Error — query fails:** caught. Tracer records `sweepQueryFailed: 1`. Function returns; caller unaffected.
- **Error — archive fails for one:** recorded as `sweepDuplicatesFailed: 1`. Others succeed.
- **Edge — empty `tsids` array:** function returns without querying.
- **Edge — paginated study (>100 tasks):** all pages fetched; all tasks considered.
- **Edge — `sweepGraceMs = 0` in test:** no delay; test completes fast.

**Verification:**
- `npm run test:ci` passes. Sweep service has branch coverage.

- [ ] **Unit 3: Wire sweep into inception handler**

**Goal:** Inception's success path invokes the sweep before returning.

**Requirements:** R2-1, R2-6.

**Dependencies:** Unit 2, PR E0.

**Files:**
- Modify: `engine/src/routes/inception.js`
- Test: `engine/test/routes/inception.test.js`

**Approach:**
- After `createStudyTasks` + wiring + copy-blocks fire (async), derive `trackedIds` and `tsids` from the `idMapping` return field.
- Call `duplicateSweep.run(...)` within the existing `withStudyLock` coverage (inherited from PR E0).
- Sweep's tracer counters flow through existing Activity Log body rendering.
- Sweep failure doesn't affect success reporting.

**Patterns to follow:**
- Existing success-path flow in `inception.js`.

**Test scenarios:**
- **Happy — clean inception:** sweep clean. Activity Log reports success. No sweep-related fields in body.
- **Happy — inception with one simulated duplicate** (mock the query to return an extra): sweep archives. Activity Log body shows `sweepDuplicatesArchived: 1` + archived ID.
- **Edge — sweep fails:** inception still reports success. Activity Log body shows `sweepQueryFailed: 1`.

**Verification:**
- `npm run test:ci` passes.

- [ ] **Unit 4: Wire sweep into add-task-set handler**

**Goal:** Add-task-set's success path invokes the sweep.

**Requirements:** R2-1, R2-6.

**Dependencies:** Unit 2.

**Files:**
- Modify: `engine/src/routes/add-task-set.js`
- Test: `engine/test/routes/add-task-set.test.js`

**Approach:**
- Same as Unit 3, applied to add-task-set.
- Already under `withStudyLock` (from PR #56 / PR E0's shared extraction).

**Patterns to follow:** Unit 3.

**Test scenarios:** Unit 3 scenarios applied to add-task-set.

**Verification:** `npm run test:ci` passes.

- [ ] **Unit 5: Historical + weekly sweep script (`scripts/sweep-all-studies.js`)**

**Goal:** One script that can run manually (historical cleanup) or scheduled (weekly).

**Requirements:** R2-9, R2-10.

**Dependencies:** Unit 1 (`archivePage`).

**Files:**
- Create: `engine/scripts/sweep-all-studies.js`

**Approach:**
- Raw fetch + single token (mirror `migrate-relative-offsets.js`). Avoids NotionClient's complexity for a standalone script.
- Queries Studies DB for active studies. Paginates.
- For each study, queries Study Tasks DB filtered by `Study relation contains studyId`. Groups by TSID.
- Identifies TSIDs with >1 tasks. Applies keep-rule:
  - Prefer fully-wired (`Parent Task` + `Blocked by` + `Blocking` all populated where the template would have had relations).
  - Fall back to earliest `created_time`.
  - Skip + flag pages with: non-empty comments, `last_edited_by != engine-bot`, or non-default `Status`. Manual resolution required.
- Dry-run (default) emits a JSON + human-readable report listing: `(studyId, studyName, tsid, canonical_id, duplicate_ids[], keep_reason, flags)`.
- `--archive` flag: executes archives for non-canonical IDs, skipping flagged ones.
- `--study-id X` flag: scope to a single study (for debugging).

**Patterns to follow:**
- `engine/scripts/migrate-relative-offsets.js` — script structure.

**Test scenarios:** Test expectation: none — one-off script. Manually verified in dry-run mode before `--archive`.

**Verification:**
- Dry-run on a known-clean study: empty report.
- Dry-run on the orphan from Meg's Apr 16 test (already archived manually): clean.
- Dry-run on all active studies → operator reviews → `--archive` executes.
- Post-archive dry-run: empty.

**Execution note:**
- **Historical run:** Tem or Seb runs manually post-merge. Dry-run first, archive on confirmation.
- **Weekly cadence:** schedule via Railway Cron or GitHub Actions. Report sent to Slack channel or via study-comment on flagged studies. Exact scheduling mechanism decided post-merge.

- [ ] **Unit 6: L2 documentation + pulse log**

**Goal:** Document the three-layer duplicate prevention architecture.

**Requirements:** R2-11.

**Dependencies:** Units 1-4 merged.

**Files:**
- Modify: `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md`
- Create: `clients/picnic-health/pulse-log/04.20/NNN-pr-e-narrow-retry-and-sweep.md`

**Approach:**
- In `ENGINE-BEHAVIOR-REFERENCE.md`, new section "Duplicate Prevention" (probably §11 after §10 Concurrency Model). Documents:
  - The bug: retry-after-commit creates silent duplicates.
  - The three-layer fix: PR E0 (shared `withStudyLock`) + PR E1 (path-based narrow retry) + PR E2 (per-run sweep + weekly cadence).
  - Observable signals: `retryStats`, `narrowRetrySuppressed`, `sweepDuplicatesFound/Archived/Failed`.
  - Historical cleanup script path.
  - Reminder for future authors: when adding a new non-idempotent endpoint, update the path-table in PR E1's classifier.
- Pulse log: narrative of the re-investigation, the corrections (Investigation #1, then the probe-based plan), the consistency experiment, the retry-rate measurement, and the final three-layer architecture.

**Patterns to follow:**
- Existing §7, §8, §9, §10 of `ENGINE-BEHAVIOR-REFERENCE.md`.
- Existing pulse log format.

**Test scenarios:** Test expectation: none — docs-only.

**Verification:**
- Tem reviews docs. Grep for consistency.

- [ ] **Unit 7: Seb-review-friendly comment on Issue #61**

**Goal:** Seb is inheriting code ownership. Leave a short pointer on Issue #61 (Bug α) linking the PR E0/E1/E2 chain.

**Requirements:** Operational hygiene.

**Dependencies:** PR E0/E1/E2 open as PRs.

**Files:**
- GitHub comment on [issue #61](https://github.com/optemization-tech/picnic-cascade-engine/issues/61).

**Approach:**
- Short comment: pointers to the three PRs, a 1-paragraph narrative of the re-investigation, and a note that PR E0/E1/E2 are orthogonal to Bug α but touch the same client layer.

**Patterns to follow:**
- Existing GitHub comment style in this repo.

**Test scenarios:** Test expectation: none.

## System-Wide Impact

- **Interaction graph:** new service called from inception and add-task-set handlers. No other touches. Tracer integration piggybacks on existing shape. New `archivePage` method on NotionClient.
- **Error propagation:** sweep failures swallowed into tracer counters. Provisioning success flow unchanged.
- **State lifecycle risks:** sweep holds `withStudyLock` for ~45-80s extra per provisioning run. Same-study operations queue normally. Different studies run in parallel unchanged.
- **API surface parity:** no external changes. Activity Log body gains optional fields. New internal `archivePage` method.
- **Integration coverage:** unit tests per service + route. Integration: full inception with a mocked duplicate, sweep catches, Activity Log reflects, user sees success.
- **Unchanged invariants:** cascade engine, study-comment flow, Import Mode lifecycle, withStudyLock semantics (PR E0), all other route behaviors, PR E1's path-based classification (archive PATCH is idempotent → retries normally).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Per-run sweep misses a duplicate (grace delay too short for extreme lag) | Weekly scheduled sweep (Unit 5) catches persistent stragglers. Historical cleanup handles pre-E2 backlog. |
| `withStudyLock` held for 80+s — webhook timeout risk or user experience degradation | Lock is per-study; different studies unaffected. Webhook response is acknowledged immediately (`res.status(200)`); the lock + sweep happen in the async worker tracked by `flightTracker`. User sees Activity Log success arrive ~45s later than today but no webhook-layer timeout. Document this in pulse log. |
| Historical script archives user-edited page by mistake | User-edit protection (non-empty comments / non-engine last_edited_by / non-default status → skip + flag). Dry-run mandatory. Operator approval required before `--archive`. |
| Sweep telemetry in tracer lost on process crash | Tracer is in-process. On crash, telemetry is lost for that run. Weekly sweep eventually catches what crashed runs missed. Accept. |
| Future developer adds a new POST endpoint and forgets to update PR E1's classifier | PR E1's default is `idempotent` → retries as today. Silent duplicates from that path get caught by E2's weekly sweep. Not zero-cost (persist for up to a week), but bounded. PR E2 Unit 6's docs reminder helps. |
| Weekly sweep itself could mis-archive under race with live operations | Weekly sweep runs outside of request-path. If a live inception is in progress on a study the script is examining, the script's `last_edited_by != engine-bot` check may catch false positives (since the engine-bot is actively editing). Safer: weekly sweep can check `withStudyLock` state (via shared service) and skip studies currently locked. Defer to implementation time. |
| User-edit protection flag-check is fragile (status/comments checks could false-positive) | Flags trigger manual resolution, not silent behavior. Operator reviews dry-run. Worst case: manual sweep takes longer. Not a data-loss path. |
| `SWEEP_GRACE_MS = 0` in test env not enforced globally | Per-test override via vi.mock or explicit param. Document in the service's test file. CI won't balloon because tests always override. |

## Documentation / Operational Notes

- Post-merge: observe `sweepDuplicatesFound/Archived` telemetry on first ~20 provisioning runs. Frequency near 0 means narrow retry is catching everything; non-zero means residual cases exist and the weekly sweep's value is proven.
- Historical cleanup: run by Tem or Seb manually post-merge. Pulse log captures count.
- Weekly scheduled sweep: set up post-merge via Railway Cron or GitHub Actions. Report sent to Slack or pulse log.
- Env var `SWEEP_GRACE_MS` added to Railway config (explicit default 45000 — documents the tuning).
- No feature flag. Ships with PR E0 + E1 on the 3-PR sequence.
- Railway auto-deploys on merge.

## Sources & References

- **Superseded plan:** `engine/docs/plans/2026-04-16-004-refactor-notion-client-idempotency-plan.md`.
- **Consistency experiment:** 2026-04-16 investigation (conversation log).
- **Retry-rate measurement:** 2026-04-20 investigation (conversation log).
- **Document-review findings (2026-04-20):** identified `createStudyTasks` return shape mismatch, `patchPage` signature gap, query strategy, persistent-miss recovery (→ weekly sweep), archived ID tracking, user-edit protection. All addressed in this revision.
- **Sequenced plans:** PR E0 (`2026-04-20-001-fix-inception-with-study-lock-plan.md`) — shared lock prerequisite. PR E1 (`2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md`) — preventive layer.
- **Related shipped:** PR #56 (withStudyLock on add-task-set), PR #62 (single-leaf duplicate guard stays as belt-and-suspenders), PR #43 (retry timeout envelope).
- **Issue #61** — Bug α to Seb; orthogonal but related surface.
- **Related code:**
  - `engine/src/provisioning/create-tasks.js` — returns `idMapping`; sweep derives trackedIds + tsids from it.
  - `engine/src/routes/inception.js`, `engine/src/routes/add-task-set.js` — sweep call sites.
  - `engine/src/notion/client.js` — new `archivePage` method.
  - `engine/src/services/cascade-tracer.js` — telemetry.
  - `engine/src/config.js` — new `sweepGraceMs`.
  - `engine/scripts/migrate-relative-offsets.js` — script pattern reference for Unit 5.
