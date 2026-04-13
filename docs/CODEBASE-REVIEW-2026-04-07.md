# PicnicHealth Cascade Engine — Full Codebase Review

**Date**: 2026-04-07
**Scope**: All 36 source files (~20.8k lines), 32 test files (~22.7k lines)
**Method**: 6 parallel reviewer agents (correctness, reliability, performance, security, maintainability, architecture)
**Branch**: `codex/notion-parallelism` (329 tests passing)

---

## P0 — Critical (fix before next deploy)

| # | Finding | Files | Reviewers |
|---|---------|-------|-----------|
| 1 | **No authentication on any webhook endpoint.** All 11 routes are publicly reachable at `picnic-cascade-engine-production.up.railway.app`. Anyone who knows a Notion page UUID can trigger deletions, inception, date shifts, or undo using the server's own API tokens. Notion page IDs are visible in shared URLs — they are not secrets. **Fix**: Add `X-Webhook-Secret` header check as Express middleware (~20 lines). Notion automations support custom headers. | `src/server.js:35-53` | Security, Architecture |
| 2 | **No graceful shutdown handler.** `SIGTERM` (every Railway deploy) kills in-flight cascades, drops debounce timers, and wipes UndoStore. Import Mode could be left ON (blocking all future cascades for that study). **Fix**: Add `SIGTERM` handler that drains the current queue item and disables Import Mode for in-flight studies (~30 lines). | `src/index.js:1-18` | Reliability, Architecture |

---

## P1 — High (should fix soon)

| # | Finding | Files | Reviewers |
|---|---------|-------|-----------|
| 3 | **`queryDatabase` returns `undefined` on cursor retry exhaustion.** The for-loop exits without a return statement after all 3 retry attempts. All callers (`.map()`, `.length`) crash with `TypeError: Cannot read properties of undefined`. **Fix**: Add `return [];` after the loop. | `src/notion/client.js:199` | Correctness, Reliability |
| 4 | **Frozen blocker ends ignored in constraint checks.** `conflictOnlyDownstream`, `gapPreservingDownstream`, `validateConstraints`, and `enforceConstraints` all skip frozen blockers when computing `earliestAllowed` (`if (isFrozen(blocker)) continue`). A Done task's end date should still constrain its dependents — the task just shouldn't be moved itself. This means a cascade can push a task *before* its Done blocker's end date, violating the core invariant `task.start >= nextBD(max(blocker.ends))`. **Fix**: Remove the frozen-blocker skip when *reading* blocker ends; keep the frozen check that prevents *writing* updates to frozen tasks. Requires design decision — the current behavior may be intentional. | `src/engine/cascade.js:92-96, :284-289, :543-546`, `src/engine/constraints.js:50-52` | Correctness |
| 5 | **No timeout on `fetch()` calls to Notion API.** `_requestWithSlot` uses native `fetch()` without `AbortSignal`. If Notion hangs (TCP established, no response), all 60 workers (20 tokens x 3 workers/token) block indefinitely, making the entire engine unresponsive. **Fix**: Add `AbortSignal.timeout(30000)` to fetch calls. | `src/notion/client.js:68` | Reliability |
| 6 | **`_throttleSlot` unbounded polling loop.** If `maxPerSecond` is 0 (misconfiguration) or clock skew corrupts timestamps, the `for(;;)` loop spins forever, starving the event loop. **Fix**: Add a max-iteration cap (e.g., 100) with a warning log. | `src/notion/client.js:42-56` | Reliability |
| 7 | **V1/V2 duplication: ~1,400 lines of near-identical code.** V2 routes (date-cascade: 376 lines, inception: 212 lines, add-task-set: 437 lines) are 80-90% identical to V1. V2 classify and create-tasks duplicate V1 verbatim. The V2 `createBatch` has already diverged — uses raw `Promise.all` instead of V1's worker pool. Bug fixes applied to V1 won't reach V2 unless manually ported. **Fix**: Extract shared code (`computeCascadeMode`, `buildTaskBody`, `accumulateIdMappings`, Import Mode lifecycle, route scaffolding). V2 becomes thin wrappers (~30-50 lines each). Cuts ~1,200 lines. | `src/v2/` (entire directory) | Maintainability, Architecture |
| 8 | **10 independent NotionClient instances** with independent rate-limit sliding windows. Two routes sharing the same token pool (e.g., `date-cascade` and `status-rollup` both use `config.notion.tokens`) can independently fire 9 req/s per token, doubling the actual rate and triggering 429s. **Fix**: Create 3 shared client singletons (one per pool) in `notion/clients.js`. Routes import from there. | `src/routes/*.js`, `src/v2/routes/*.js` | Maintainability, Architecture |
| 9 | **V2 `createBatch` bypasses rate limiting.** Uses `Promise.all(batch.map(client.request(...)))` instead of V1's `client.createPages()` which delegates to `runParallel` with per-token throttling. Fires entire batch simultaneously, risking 429 storms on larger studies. **Fix**: Use `client.createPages()` like V1. | `src/v2/provisioning/create-tasks.js:141-155` | Correctness, Performance |
| 10 | **Status rollup: 3 sequential Notion API calls** before any useful work. `getPage(task)` -> `getPage(study)` -> `Promise.all(parent, siblings)`. The study fetch could be parallelized with the task fetch, or Import Mode could be read from the webhook payload. Adds 200-600ms avoidable latency per status change. **Fix**: Restructure to parallel fetches. | `src/routes/status-rollup.js:24-31` | Performance |

---

## P2 — Medium (fix when convenient)

| # | Finding | Files | Reviewers |
|---|---------|-------|-----------|
| 11 | **Undo snapshot type mismatch.** `preSnapshot` stores Date objects for non-source tasks but YYYY-MM-DD strings for the source task. Undo writes both into Notion — Date objects serialize to ISO timestamps (`2026-01-05T00:00:00.000Z`), not date-only strings. May cause Notion to misinterpret Reference Start/End Date properties. **Fix**: Normalize all snapshot values to YYYY-MM-DD strings via `formatDate()`. | `src/routes/date-cascade.js:196-204` | Correctness |
| 12 | **`computeCascadeMode` returns null for opposing-sign deltas** (startDelta>0 + endDelta<0, or startDelta<0 + endDelta>0). These are valid user edits (duration change from one side while the other moves opposite). The cascade silently does nothing — no warning, no activity log explaining why. **Fix**: Design decision — either map these to an existing mode or add explicit "unsupported edit" reporting. | `src/engine/classify.js:16` | Correctness |
| 13 | **Import Mode race in inception.** `disableImportMode` runs in `Promise.all` alongside `copyBlocks`. If copy-blocks writes trigger Notion automations, cascades fire immediately while blocks are still being written. Also: both the try body and the finally block disable Import Mode, wasting an API call on success. **Fix**: Disable Import Mode only after copy-blocks completes, or use the add-task-set pattern (fire-and-forget copy-blocks after disabling). | `src/routes/inception.js:144-166, :221-227` | Reliability, Architecture |
| 14 | **`_drainStudy` called without await, no unhandled rejection guard.** If `_drainStudy` itself throws (not the processFn, which is caught), `lock.running` stays true forever, permanently deadlocking that study's queue. **Fix**: Add `.catch()` on the `_drainStudy` call or wrap in try/catch. | `src/services/cascade-queue.js:79` | Reliability |
| 15 | **Unbounded in-memory queue (DoS vector).** No limits on debounce map size, per-study queue depth, or total study locks. An attacker can POST thousands of unique payloads to `/webhook/date-cascade`, exhausting memory. **Fix**: Add max queue size (e.g., 1000 debounce entries, 50 per study). Return 429 when exceeded. | `src/services/cascade-queue.js:1-145` | Security |
| 16 | **`runParallel` — one worker failure kills all.** `Promise.all` short-circuits on first error. For `patchPages` during a cascade, this means a partial update: some tasks have new dates, others retain old dates, creating an inconsistent dependency graph. **Fix**: Consider `Promise.allSettled` or per-item try/catch for batch operations where partial success is acceptable. | `src/notion/client.js:117-141` | Reliability, Architecture |
| 17 | **Second DB query in add-task-set for numbering** adds 2-5s latency. The pre-existing task count was already available from the first `existingTasks` query. The comment says eventual consistency requires re-querying, but numbering only needs pre-existing task counts. **Fix**: Use the first query's results for numbering. | `src/routes/add-task-set.js:379-411` | Performance |
| 18 | **Synced block resolution is sequential per page.** `resolveSyncedBlocks` first pass fetches each synced block source with `await` in a for-loop. If a template has 5 unique synced sources, they're fetched one at a time. **Fix**: Collect all unique fetchIds, fetch in parallel, then resolve. | `src/provisioning/copy-blocks.js:161-168` | Performance |
| 19 | **Notion property names scattered across 80+ occurrences in 15+ files.** `'Task Name'`, `'Blocked by'`, `'Reference Start Date'`, `'Import Mode'`, etc. appear as raw string literals everywhere. A Notion property rename requires global find-and-replace; missed occurrences fail silently (Notion returns null for unknown properties). **Fix**: Create a `PROPERTY_NAMES` constant map in `notion/schema.js`. | Multiple files | Maintainability |
| 20 | **`isFrozen`/`FROZEN_STATUSES` defined 3 times** with different implementations (Set.has in engine files, array.includes in guards.js). Adding a status like "Cancelled" requires editing 3 files. **Fix**: Move to a single shared `utils/status.js`. | `cascade.js:20-24`, `parent-subtask.js:10-14`, `guards.js:97-99` | Maintainability |
| 21 | **Kahn's topo sort implemented 5 times** across `cascade.js` (x3), `parent-subtask.js`, `blueprint.js`. ~120 lines of duplicated algorithm code. **Fix**: Extract `topoSort(nodeIds, getSuccessors)` utility. | Multiple files | Maintainability |
| 22 | **Self-referential localhost HTTP for copy-blocks** in 3 routes. Breaks behind load balancers or in multi-instance deployments. V1 inception correctly calls `copyBlocks()` directly — the correct pattern already exists. **Fix**: Direct function call with `setImmediate` for fire-and-forget semantics. | `add-task-set.js:424`, `v2/inception.js:137`, `v2/add-task-set.js:347` | Architecture |
| 23 | **Source task unconditionally added to patch set** even when no cascade or parent changes occurred and user's dates are already valid. Wastes an API call per edit and creates echo webhooks. **Fix**: Only include source in updates when dates actually changed. | `src/routes/date-cascade.js:273-295` | Correctness |
| 24 | **Case-A dep resolution only pushes right, never pulls left.** When a parent shifts left, subtasks shift left, but their downstream dependents keep unnecessary gaps. Asymmetric with push-right behavior. **Fix**: Design decision — may need gap-collapsing downstream pass for negative deltas. | `src/engine/parent-subtask.js:199-229` | Correctness |
| 25 | **Undo during active cascade creates data race.** If undo fires while a cascade is in the debounce window (not yet in the study lock), undo executes first, restoring old dates. The debounced cascade then fires and overwrites them. The undo entry is consumed, so the user loses their undo with no visible effect. | `src/routes/undo-cascade.js:38-62` | Reliability |
| 26 | **UndoStore lost on restart with no user feedback.** Meg gets "No recent cascade to undo" after a deploy with no explanation. **Fix**: Add a "restart detected" message or persist the last undo manifest to a Notion property. | `src/services/undo-store.js:1-57` | Architecture |
| 27 | **Status rollup not serialized via CascadeQueue.** Concurrent rollup webhooks for the same parent can race and write conflicting status values. Date cascades and undo are properly serialized; status rollup is not. | `src/routes/status-rollup.js:19-71` | Reliability |
| 28 | **Task set numbering relies on Notion eventual consistency with no retry.** Post-create numbering queries for freshly-created tasks. If Notion's index is slow, the query misses recently created pages, causing incorrect numbering. | `src/routes/add-task-set.js:379-388` | Architecture |
| 29 | **V2 date-cascade runs reportComplete + logTerminal sequentially** (not in `Promise.all` like V1). Adds 200-400ms unnecessary latency. Likely an oversight during the V2 fork. | `src/v2/routes/date-cascade.js:315-322` | Performance |

---

## P3 — Low (nice to have)

| # | Finding | Files |
|---|---------|-------|
| 30 | `normalizeTask` retains full `notionPage` object — doubles in-memory footprint per cascade (~1-2MB for 174 tasks). Engine modules never access it. | `src/notion/properties.js:33` |
| 31 | `array.shift()` in topo sort is O(n), making sort O(V^2). Negligible at 174 tasks, measurable at 500+. Use index pointer. | `src/engine/cascade.js:46-71` (+ 4 other locations) |
| 32 | Three modules independently rebuild `taskById` maps from `allTasks` — 2 redundant passes of object construction + Date parsing + `countBDInclusive` per cascade. | `cascade.js`, `parent-subtask.js:42-58`, `constraints.js:26-37` |
| 33 | Business day delta and `countBDInclusive` use day-stepping loops instead of closed-form (full weeks * 5 + remainder). Called in 6+ places per cascade. | `src/engine/cascade.js:213-219`, `src/utils/business-days.js:73-81` |
| 34 | Error reporting in catch blocks retries against a failing Notion API. If Notion is the reason the cascade failed, error reporting adds ~48s of dead retry time. | `src/routes/date-cascade.js:393-413` (all routes) |
| 35 | `parseDate('garbage')` returns Invalid Date (not null). `isBusinessDay(Invalid Date)` returns `true` because `NaN !== 0 && NaN !== 6`. Latent bug — currently safe because all inputs come from Notion's date format. | `src/utils/business-days.js:11-14` |
| 36 | Dead import `dotenvConfig` in config.js. Startup banner in index.js lists 7 endpoints but server.js registers 11 (missing undo-cascade + 3 V2 endpoints). | `src/config.js:1`, `src/index.js:10-17` |
| 37 | `CascadeTracer.wrapAsync`, `UndoStore.has()`/`.size`, `processOnePage.studyName` param — defined but never used in production code. | `cascade-tracer.js:34`, `undo-store.js:41-46`, `copy-blocks.js:243` |
| 38 | Error messages in Activity Log and Automation Reporting expose internal DB structure, field names, and request details. Sanitize before writing to user-visible properties. | `src/services/activity-log.js:57-68` |
| 39 | Inception runs `copyBlocks` in-process, blocking `disableImportMode` for ~40-60s. Add-task-set correctly uses fire-and-forget. Inconsistent pattern. | `src/routes/inception.js:155-166` |
| 40 | `_throttleSlot` rebuilds filtered timestamp array on every iteration. Under sustained load (15 workers contending), thousands of short-lived arrays per second. Use ring buffer. | `src/notion/client.js:40-56` |
| 41 | Synced block resolution limited to 2 levels of nesting. A synced block 3 levels deep would be included as raw `synced_block` and fail on append. | `src/provisioning/copy-blocks.js:162-194` |
| 42 | `applyError1SideEffects` sets `Import Mode = false` on the study. If inception/add-task-set is concurrently running with Import Mode ON, this prematurely disables it. | `src/routes/date-cascade.js:105-119` |

---

## Testing Gaps

| Priority | Gap |
|----------|-----|
| **High** | V2 provisioning has **zero tests** — `test/v2/provisioning/` directory is empty. The divergent `createBatch` is completely untested. |
| **High** | V2 inception and add-task-set routes have **no tests** — only `v2/routes/date-cascade.test.js` exists. |
| **High** | No test for `queryDatabase` returning `undefined` on 3x cursor invalidation. |
| **High** | No test for frozen-blocker constraint enforcement (invariant #2 violation). |
| **Medium** | No test for `computeCascadeMode` with opposing-sign deltas (startDelta>0 + endDelta<0). |
| **Medium** | No test for undo cascade Date vs string type handling in manifest. |
| **Medium** | No load test for concurrent multi-study webhooks or `_throttleSlot` throughput under contention. |
| **Medium** | No test for `_throttleSlot` under clock skew or zero `maxPerSecond`. |
| **Medium** | No test for `runParallel` partial failure behavior (one item fails, others succeed). |
| **Medium** | No test for concurrent undo + debounced cascade race condition. |
| **Low** | No integration test for Import Mode stuck-on scenario (process crash between enable and finally). |
| **Low** | V1 deletion route handler has no route-level test (only the provisioning module is tested). |

---

## Top 5 Recommendations for Seb's Handoff

### 1. Add webhook authentication (~20 lines)
Single `X-Webhook-Secret` header check as Express middleware. Blocks the entire P0 attack surface. Notion automations support custom headers — update each automation to include the secret.

### 2. Add SIGTERM handler (~30 lines)
Drain the current queue item, disable Import Mode for in-flight studies, log dropped debounce timers. Prevents the silent-data-corruption class of deploy-time bugs.

### 3. Fix `queryDatabase` return (1 line)
Add `return [];` after the cursor retry for-loop in `client.js:199`. Prevents TypeError crashes on cursor exhaustion.

### 4. Extract V1/V2 shared code (biggest maintainability win)
Export `computeCascadeMode`, `buildTaskBody`, `accumulateIdMappings`, Import Mode lifecycle, and route scaffolding from V1. V2 imports them and overrides only what differs. Cuts ~1,200 lines and eliminates the "fix in one, forget the other" class of bugs.

### 5. Centralize NotionClient instances (1 new file)
Create `notion/clients.js` exporting `cascadeClient`, `provisionClient`, `deletionClient`. Routes import from there. Fixes rate-limit coordination, reduces constructor-change surface from 10 files to 1.

---

## Architectural Strengths

The review also surfaced genuine strengths worth preserving:

- **Pure-functional engine layer** — `cascade.js`, `classify.js`, `constraints.js`, `parent-subtask.js` have zero I/O. This yields 329 tests running in ~2s with no external mocking — an excellent testability story.
- **Clean layering** — engine -> notion -> routes -> services. Dependency graph is acyclic.
- **Comprehensive observability** — `CascadeTracer` captures per-phase timing, retry stats, and metadata. Activity Log creates a full audit trail in Notion.
- **Robust debounce + FIFO queue** — `CascadeQueue` correctly serializes per-study while debouncing per-task. Handles the rapid-fire webhook pattern well.
- **Defensive Import Mode lifecycle** — finally blocks ensure Import Mode is disabled even on error. The pattern is correct (just needs the SIGTERM gap addressed).
- **Minimal dependencies** — express + dotenv only. No ORM, no framework bloat. Easy to audit and maintain.
