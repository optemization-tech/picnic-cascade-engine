---
title: "fix: Shutdown reliability — flight tracker, Import Mode sweep, drainStudy guard, self-HTTP elimination"
type: fix
status: completed
date: 2026-04-11
origin: pulse-log/04.11/003-pr43-reliability-fixes-and-ideation.md
reviewed: 2026-04-11
---

# fix: Shutdown reliability — flight tracker, Import Mode sweep, drainStudy guard, self-HTTP elimination

## Overview

Make all in-flight async work visible to the SIGTERM shutdown handler, add a startup safety net for stuck Import Mode, fix the `_drainStudy` deadlock bug, and eliminate the self-HTTP copy-blocks pattern that breaks during shutdown. All changes target the `fix/codebase-audit-p0-p1-p3` branch (PR #43).

## Prerequisites

This plan builds on the `fix/codebase-audit-p0-p1-p3` branch (PR #43), which provides:
- `CascadeQueue.drain()` with 8s timeout (not on main)
- SIGTERM/SIGINT handlers in `src/index.js` (not on main)
- Timeout retry cap and cursor exhaustion throw in `src/notion/client.js`

All implementation units assume these exist on the working branch.

## Problem Frame

PR #43 added a SIGTERM handler that drains `cascadeQueue`, but 7 other fire-and-forget async paths (inception, add-task-set, copy-blocks, deletion, status-rollup, and V2 variants) are invisible to shutdown. The worst failure: SIGTERM during inception leaves Import Mode stuck ON permanently, blocking all future cascades for that study.

Secondary issues discovered during ideation:
- `_drainStudy` has an unguarded async call that can permanently deadlock a study's queue
- Three routes use `fetch(localhost)` for copy-blocks, which fails after `server.close()` during shutdown
- No startup recovery for stuck Import Mode from prior crashes/OOM/SIGKILL

## Requirements Trace

- R1. SIGTERM waits for all in-flight async work (not just cascadeQueue) before exiting
- R2. Import Mode stuck ON from any cause (crash, OOM, SIGKILL) self-heals on next boot
- R3. `_drainStudy` cannot permanently deadlock a study's queue
- R4. Copy-blocks works during shutdown (no self-HTTP dependency on server socket)

## Scope Boundaries

- Not routing inception/add-task-set through CascadeQueue (that's the WorkQueue idea — deferred)
- Not adding a shutdown-aware request gate middleware (edge case, lost webhooks downside)
- Not persisting UndoStore (separate concern, lower severity)
- Not changing V2 route behavior beyond self-HTTP elimination + flight tracker wiring

## Context & Research

### Relevant Code and Patterns

**Fire-and-forget pattern** — every route handler follows:
```
res.status(200).json({ ok: true });
void processX(req.body).catch(err => console.error(...));
```
7 handlers use this pattern. 3 more go through `cascadeQueue.enqueue()`.

**Import Mode lifecycle** — 6 routes enable/disable it: V1 + V2 inception and add-task-set, plus `date-cascade.js:applyError1SideEffects`. All have `finally` blocks but SIGTERM can kill the process before `finally` runs.

**Self-HTTP copy-blocks** — 3 routes use `fetch(localhost/webhook/copy-blocks)`. V1 inception already calls `copyBlocks()` directly from `src/provisioning/copy-blocks.js` — this is the correct pattern.

**Existing services** — `CascadeQueue`, `UndoStore`, `CascadeTracer`, `ActivityLogService` all follow the singleton pattern with module-level export.

### Institutional Learnings

- Codebase review findings #2 (SIGTERM), #14 (`_drainStudy`), #22 (self-HTTP) directly map to this plan
- The `finally` blocks for Import Mode are correct but insufficient — SIGTERM during `await` kills the process before `finally` executes
- BEH-GUARD-IMPORT-MODE: route guards skip cascades while Import Mode is active

## Key Technical Decisions

- **Flight tracker is a thin promise Set, not a queue**: Minimal coupling — handlers don't change their logic, just register their promise. No serialization, no debouncing. CascadeQueue stays as-is for date cascades.
- **Startup sweep runs after `app.listen()`**: Server accepts traffic while sweeping — the sweep is defensive cleanup, not a prerequisite for operation.
- **Self-HTTP replaced with direct `copyBlocks()` call**: Follow V1 inception pattern. The copy-blocks HTTP endpoint stays for external callers.
- **Drain timeout shared at 8s (best-effort)**: `flightTracker.drain(8000)` runs in parallel with `cascadeQueue.drain()` (which has its own 8s timeout). Railway gives ~10s. Both drains run concurrently so wall-clock max is ~8s. **Timeout behavior:** if drain times out (e.g. inception runs 30-60s), shutdown proceeds immediately — the process exits with in-flight work abandoned. This is deliberate: Railway's SIGKILL at ~10s makes longer waits pointless. The startup Import Mode sweep (R2) catches any stuck state on next boot. This is best-effort drain, not guaranteed completion.

## Open Questions

### Resolved During Planning

- **Should flight tracker track CascadeQueue work too?** No — `cascadeQueue.drain()` already handles those. Flight tracker covers the other 7 handlers.
- **Should startup sweep block server startup?** No — run after listen. Studies can operate normally even with Import Mode temporarily on; the sweep fixes it within seconds.
- **What token pool for the startup sweep?** Provision tokens (with cascade tokens as fallback), matching the inception/add-task-set pattern.

### Deferred to Implementation

- Exact error message format for sweep log entries (match existing logging conventions when implementing)
- Whether V2 routes need `copyBlocks` imported from `../../provisioning/copy-blocks.js` or `../provisioning/copy-blocks.js` (depends on directory depth — check at implementation time)

## Implementation Units

- [x] **Unit 1: FlightTracker service**

**Goal:** Create a new service that tracks in-flight promises and provides a drain mechanism for graceful shutdown.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `src/services/flight-tracker.js`
- Test: `test/services/flight-tracker.test.js`

**Approach:**
- Export a `FlightTracker` class with `track(promise, label)` and `drain(timeoutMs)` methods
- `track()` adds the promise to an internal Set, auto-removes on settle (both resolve and reject)
- `drain()` returns a Promise that resolves when all tracked promises settle, or rejects at timeout
- Use `Promise.allSettled()` inside drain so one rejection doesn't abort the wait
- Export a singleton `flightTracker` instance (same pattern as `cascadeQueue`)
- Include `getStats()` returning `{ activeCount, labels }` for observability

**Patterns to follow:**
- `src/services/cascade-queue.js` — singleton export pattern, `getStats()`, `drain()` with timeout
- `src/services/undo-store.js` — simple Map-based service pattern

**Test scenarios:**
- Happy path: tracked promise resolves -> removed from set, drain resolves immediately
- Happy path: tracked promise rejects -> removed from set (not leaked), drain resolves
- Happy path: drain with no active flights resolves immediately
- Edge case: drain timeout fires before tracked promise settles -> drain resolves, promise still running
- Edge case: multiple promises tracked, some resolve before drain, some during -> drain waits for all
- Integration: track + drain interleaved — track during drain still waits for new promise
- Happy path: getStats returns accurate count and labels

**Verification:**
- All tests pass
- FlightTracker can be imported and used as a singleton

---

- [x] **Unit 2: _drainStudy error boundary**

**Goal:** Prevent permanent study queue deadlock from unguarded `_drainStudy` throw.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/services/cascade-queue.js`
- Test: `test/services/cascade-queue.test.js`

**Approach (layered defense):**
- **Belt (outer `.catch()`):** Add `.catch()` on the `_drainStudy(studyId)` call at line 83. This catches any synchronous throw or early rejection *before* the while loop body starts. The catch handler resets `lock.running = false`, deletes the study lock, and logs the error.
- **Suspenders (inner `try/finally`):** Wrap the `while` loop body in `_drainStudy` with a try/finally that guarantees `lock.running = false` and `this._studyLocks.delete(studyId)` even on unexpected throws *inside* the loop but above the existing `processFn` catch (lines 105-108). Currently unreachable since `processFn` errors are caught, but guards against future code changes adding throwable calls inside the loop.
- Both fixes together ensure no throw path — current or future — can permanently deadlock a study's queue.

**Patterns to follow:**
- Existing error handling pattern in `_drainStudy` (try/catch around `processFn` at line 105-108)

**Test scenarios:**
- Error path: `_drainStudy` throws before entering while loop -> lock.running resets to false, study lock deleted
- Error path: unguarded throw inside while loop but outside processFn catch -> lock.running resets, subsequent enqueue works
- Integration: after _drainStudy error, a new enqueue for the same study processes normally (no deadlock)

**Verification:**
- Existing cascade-queue tests still pass
- New tests prove lock recovery after error

---

- [x] **Unit 3: Eliminate self-HTTP copy-blocks pattern**

**Goal:** Replace `fetch(localhost/webhook/copy-blocks)` with direct `copyBlocks()` function call in all 3 call sites.

**Requirements:** R4

**Dependencies:** None (can be done before or after flight tracker, but will be wired to flight tracker in Unit 4)

**Files:**
- Modify: `src/routes/add-task-set.js` (lines 424-445 — remove selfUrl + fetch, replace with direct call)
- Modify: `src/v2/routes/inception.js` (lines 137-146 — same replacement)
- Modify: `src/v2/routes/add-task-set.js` (lines 347-356 — same replacement)
- Reference: `src/routes/inception.js` (lines 155-166 — the correct pattern to follow)

**Approach:**
- Import `copyBlocks` (and `prefetchTemplateBlocks` if needed) from `provisioning/copy-blocks.js` in each file
- Replace the `fetch(selfUrl, ...)` call with a direct `copyBlocks(notionClient, idMapping, { studyPageId, studyName, tracer })` call
- For V1 add-task-set: the `fetch(selfUrl)` call is currently an arm of `await Promise.all([disableImportMode, fetch(...), activityLog])`. The current fetch resolves immediately (HTTP request is fire-and-forget to the copy-blocks endpoint). A direct `copyBlocks()` call would block 10-60s inside the Promise.all, delaying Import Mode disable and activity logging. **Fix:** extract copyBlocks from the Promise.all entirely. After the Promise.all completes, fire `void copyBlocks(...).catch(...)` as a standalone fire-and-forget call.
- For V2 inception and V2 add-task-set: the call is bare fire-and-forget — replace with direct call, `.catch()` for error logging
- **Important:** do NOT pass `preparedBlocksByTemplate` to copyBlocks (unlike V1 inception which prefetches blocks in parallel). The self-HTTP path never prefetched — it sent `{ idMapping, studyPageId, studyName }` and let copyBlocks fetch blocks on-demand via `processOnePage()`. The direct call should match this behavior: `copyBlocks(notionClient, idMapping, { studyPageId, studyName, tracer })`.
- Remove the `selfUrl` variable from all 3 files
- The `/webhook/copy-blocks` HTTP endpoint stays for any external callers

**Patterns to follow:**
- `src/routes/inception.js:155-166` — V1 inception's direct `copyBlocks()` call with notionClient, idMapping, and options

**Test scenarios:**
- Happy path: add-task-set calls copyBlocks directly (verify no HTTP self-call in test)
- Happy path: V2 inception calls copyBlocks directly
- Happy path: V2 add-task-set calls copyBlocks directly
- Error path: copyBlocks error in fire-and-forget mode logs warning but doesn't crash the parent operation

**Verification:**
- No `localhost` or `selfUrl` references remain in add-task-set.js, v2/inception.js, or v2/add-task-set.js (grep confirms)
- Existing route tests still pass

---

- [x] **Unit 4: Wire flight tracker into handlers and shutdown**

**Goal:** Register all fire-and-forget async work with the flight tracker, and update the SIGTERM handler to drain it.

**Requirements:** R1

**Dependencies:** Unit 1 (FlightTracker service), Unit 3 (self-HTTP elimination — so copy-blocks promises are direct calls that can be tracked). **Note:** Unit 3 modifies the same route files, so line numbers below reflect the state *after* Unit 3. Search for the `void processX(req.body).catch(...)` pattern rather than relying on exact line numbers.

**Files:**
- Modify: `src/routes/inception.js` (line 234 — wrap processInception promise)
- Modify: `src/routes/add-task-set.js` (line 524 — wrap processAddTaskSet promise)
- Modify: `src/routes/copy-blocks.js` (line 114 — wrap processCopyBlocks promise)
- Modify: `src/routes/deletion.js` (line 99 — wrap processDeletion promise)
- Modify: `src/routes/status-rollup.js` (line 76 — wrap processStatusRollup promise)
- Modify: `src/v2/routes/inception.js` (line 211 — wrap processInception promise)
- Modify: `src/v2/routes/add-task-set.js` (line 436 — wrap processAddTaskSet promise)
- Modify: `src/index.js` (update SIGTERM handler to drain both cascadeQueue and flightTracker)
- Test: `test/services/flight-tracker.test.js` (integration test for shutdown sequence)

**Approach:**
- In each handler, change `void processX(req.body).catch(...)` to `flightTracker.track(processX(req.body).catch(...), 'inception')` (the `.catch()` stays to prevent unhandled rejections — `track()` adds drain visibility)
- Import `flightTracker` singleton in each route file
- In `src/index.js`, update the shutdown function to: `await Promise.all([cascadeQueue.drain(), flightTracker.drain(8000)])`
- The two drains run in parallel — cascadeQueue handles debounced cascades, flightTracker handles everything else

**Patterns to follow:**
- Existing `cascadeQueue.enqueue()` import pattern in route files
- `src/index.js` existing shutdown handler structure

**Test scenarios:**
- Integration: SIGTERM with active flight-tracked inception -> drain waits for inception to finish
- Integration: SIGTERM with no active flights -> drain resolves immediately (fast shutdown)
- Happy path: each handler registers its promise with the correct label
- Edge case: handler's processX rejects -> flight tracker still removes it from active set (no leak)

**Verification:**
- All route handlers import and use flightTracker
- SIGTERM handler drains both queues
- Full test suite passes

---

- [x] **Unit 5: Startup Import Mode sweep**

**Goal:** On server boot, query for studies with Import Mode stuck ON and disable it. Safety net for crashes, OOM, SIGKILL.

**Requirements:** R2

**Dependencies:** None (independent of Units 1-4)

**Files:**
- Modify: `src/index.js` (add sweep after `app.listen()`)
- Test: `test/startup/import-mode-sweep.test.js`

**Approach:**
- After `app.listen()` callback fires, run an async sweep:
  1. Create a NotionClient using provision tokens (with cascade tokens as fallback)
  2. Query `config.notion.studiesDbId` with filter `{ property: 'Import Mode', checkbox: { equals: true } }`
  3. For each result, PATCH `Import Mode: false` and log a warning
  4. Catch and log any errors — sweep failure must not crash the server
- The sweep is non-blocking — server accepts webhooks while it runs
- Log structured JSON: `{ event: 'import_mode_sweep', studiesReset: N }` on completion, or `{ event: 'import_mode_sweep_error', error: ... }` on failure

**Patterns to follow:**
- `src/notion/client.js:queryDatabase()` for paginated DB queries
- `src/routes/inception.js:35-37` for the Import Mode PATCH payload
- Structured JSON logging convention used throughout the codebase

**Test scenarios:**
- Happy path: no stuck studies -> sweep completes, logs `studiesReset: 0`
- Happy path: 2 stuck studies -> both patched to false, logs `studiesReset: 2`
- Error path: Notion API error during query -> logs error, server continues running
- Error path: Notion API error during one PATCH -> continues patching remaining studies, logs partial success
- Edge case: `studiesDbId` query returns empty results -> sweep completes cleanly

**Verification:**
- Server starts successfully with and without stuck Import Mode studies
- Sweep errors don't prevent server from accepting traffic

## System-Wide Impact

- **Interaction graph:** The flight tracker touches all 7 fire-and-forget handlers. The self-HTTP elimination touches 3 files. The startup sweep runs once on boot. All are additive — no existing behavior changes.
- **Error propagation:** Flight tracker's `drain()` uses `Promise.allSettled()` — individual handler failures don't block shutdown. Startup sweep catches its own errors and never crashes the server.
- **State lifecycle risks:** The flight tracker is a Set of promises — no persistent state, no cleanup needed beyond drain. Import Mode sweep is idempotent (disabling an already-disabled checkbox is a no-op PATCH).
- **Unchanged invariants:** CascadeQueue behavior is unchanged. Route handler business logic is unchanged — only the promise tracking wrapper and copy-blocks invocation method change. The `/webhook/copy-blocks` HTTP endpoint remains available for external callers.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Startup sweep races with a legitimately-running inception | Single-instance Railway deployment — no overlap between deploys. **Narrower same-process race:** sweep runs after `app.listen()`, so an inception webhook could arrive during the sweep's Notion query. If the sweep then PATCHes Import Mode off for a study that inception just turned on, inception loses its protection. Accepted risk: inception is rare, deploy restarts are rarer, and inception's finally block re-disables Import Mode regardless. |
| 8s drain timeout too short for inception (30-60s) | Startup sweep on next boot catches it. This is the belt-and-suspenders design. |
| Flight tracker adds import to every route file | One-line import + one-line change per handler. Minimal coupling. |
| Self-HTTP elimination changes add-task-set Promise.all structure | V1 inception already uses the direct call pattern — proven approach |

## Sources & References

- Origin: `pulse-log/04.11/003-pr43-reliability-fixes-and-ideation.md`
- Codebase review findings #2, #14, #22: `docs/CODEBASE-REVIEW-2026-04-07.md`
- PR #43: `fix/codebase-audit-p0-p1-p3` branch
- V1 inception direct copy-blocks pattern: `src/routes/inception.js:155-166`
