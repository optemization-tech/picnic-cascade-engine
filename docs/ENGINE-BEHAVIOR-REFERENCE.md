# ENGINE-BEHAVIOR-REFERENCE

## Role of This Document
This is the code-era L2 technical behavior contract for the PicnicHealth cascade engine.

- L1 product source: Meg-confirmed behavior + reconciled requirements doc
- L2 technical source: this file
- L3 executable source: engine tests

If this file disagrees with L1, update this file and tests before changing implementation.

## Ownership
- Primary owner: Engineering maintainer of `picnic-cascade-engine` (currently Seb)
- Secondary owner: Tem (behavior reconciliation and product alignment)
- Approval requirement for behavior changes: product confirmation from Meg

## Required Sections
Keep this file updated with the sections below.

### 1) Behavior Matrix
Definitions:
- `startDelta` / `endDelta` are signed business-day deltas vs Reference dates.
- `upstream` means `Blocked by` edges.
- `downstream` means `Blocking` edges.
- Frozen statuses are `Done` and `N/A`.

| Edit Type | Trigger Condition | Cascade Mode | Scope of movement | Conflict Rule | Gap Policy | Expected Result Contract |
|---|---|---|---|---|---|---|
| Start-only left | `startDelta < 0 && endDelta == 0` | `start-left` | Upstream then downstream | Upstream moves if dependency conflict; downstream is retightened against current blocker ends | Upstream pull tightens schedule; downstream re-tightens to blocker adjacency | Source moves earlier, blockers are pulled earlier as needed, and reachable downstream dependents are re-tightened |
| Start-only right | `startDelta > 0 && endDelta == 0` | `pull-right` | Upstream first, then downstream conflict pass | ALL upstream blockers shift right by the same delta unconditionally; downstream moves only if conflict | ALL upstream gaps are preserved (no gap absorption); uniform shift for every upstream blocker | All upstream blockers shift right by delta preserving gaps; downstream only adjusts if source/upstream changes introduce conflicts |
| End-only left | `startDelta == 0 && endDelta < 0` | `pull-left` | Downstream only | Reachable downstream tasks shift by the full delta, then clamp to blocker constraints | Uniform left shift within the reachable downstream subgraph; tasks that cannot move left are left in place | End contraction pulls the downstream reachable set earlier while preserving duration and respecting blocker clamps |
| End-only right | `startDelta == 0 && endDelta > 0` | `push-right` | Downstream only | Downstream moves only if `task.start < nextBusinessDay(blocker.end)` | Conflict-only push (no blanket uniform shift) | Only conflicting downstream tasks move right enough to clear conflicts |
| Drag left | `startDelta < 0 && endDelta < 0` | `drag-left` | Connected component | No per-edge conflict pass; every reachable non-frozen task in the connected component translates by the same delta | Uniform translation across the connected component | Drag earlier shifts the connected component around the source left by a shared delta |
| Drag right | `startDelta > 0 && endDelta > 0` | `drag-right` | Connected component | No per-edge conflict pass; every reachable non-frozen task in the connected component translates by the same delta | Uniform translation across the connected component | Drag later shifts the connected component around the source right by a shared delta |
| Complete Freeze | Task status is frozen (`Done`/`N/A`) | N/A | Route + engine gates | Frozen tasks never move and are excluded from blocker constraints | N/A | Frozen tasks remain fixed while cascades continue around them where valid |
| Dep-edit | `Blocked by` relation edited by non-bot user (NOT a date delta) | `dep-edit` | Seed task + reachable downstream chain | Seed pushed/pulled to `nextBusinessDay(max(non-frozen blocker.end))`; downstream chain re-tightened against new positions via `tightenDownstreamFromSeed` | Tight (no gaps preserved); seed and downstream end up butt-to-butt against their respective blockers | Wiring or rewiring `Blocked by` enforces "start after predecessor end" upfront, eliminating the violation/gap that would otherwise persist until someone drags dates |

**Dep-edit cascade — special case:**
- Trigger fires on `Blocked by` edits, not on date deltas. The other 6 modes are date-driven (`signedBDDelta`-classified); dep-edit is dependency-graph-driven.
- Two semantic sub-cases (`violation` and `gap`) share the same engine logic — both compute seed.newStart = nextBD(max(non-frozen blocker.end)) and shift seed.end by the same delta, then propagate downstream via `tightenDownstreamFromSeed`. The Activity Log distinguishes them via `details.subcase`.
- Parent-task gating (BL-H5g): the cascade refuses to operate on tasks where `Subtask(s)` is non-empty, mirroring the parent-edge stripping invariant `runCascade` enforces for every other mode. Three-layer defense: Notion automation filter `Subtask(s) is empty`, route-level guard, helper-level early-return.
- No-op when seed is already tight (avoids Activity Log noise on idempotent triggers).
- Pre-existing violations on parallel sibling branches that share the seed's blocker are NOT fixed by this cascade — engine fixes only the touched subgraph (PR #66 simplification). Operators run `scripts/check-study-blocker-starts.js` to spot residual violations.



Parent guard:
- Any task with subtasks is blocked for direct date edits and produces a warning to edit subtasks directly.
- The Error 1 revert-and-warn flow runs **regardless of the parent's frozen status**. A `Done`/`N/A` parent whose dates are edited still has its dates reverted to Reference dates and the red "edit a subtask directly" warning posted. Implementation: the `isFrozen` guard runs AFTER `classify` so Error 1 fires first for top-level parent edits; non-Error-1 paths (leaves, middle-parent case-a) still short-circuit on frozen.

Status Roll-Up (parent-direct snap-back):
- When a PM directly edits a parent task's Status, the engine computes the parent's rollup from its own subtasks and patches back if the manual value disagrees. Behaves both directions: all-subtasks-Done drives parent to Done; any mismatch in either direction snaps parent to computed. Silent correction -- no Notion comment; audit trail lives in the Activity Log with summary prefix "Parent ... status corrected: ... (direct edit blocked)" and `details.direction = 'parent-direct'`. The existing leaf-subtask → parent rollup path is unchanged and logs with `details.direction = 'subtask-triggered'`.
- Echo-loop guard: parent-direct branch skips when `parsed.editedByBot === true` so the engine's own patch doesn't re-enter and amplify Notion reads.
- Stale-relation guard: if `Subtask(s)` relation claims children exist but the children query returns none (deleted pages), the branch returns without patching -- avoids silently snapping a Done parent to Not Started based on stale data.

### 2) Cross-Chain Propagation Contract
1. Apply source edit to the in-memory graph using webhook dates as authoritative.
2. Run mode-specific propagation:
   - `push-right`: downstream conflict pass.
   - `start-left`: iterative upstream relaxation, then downstream retightening from `{source} ∪ {upstream-moved tasks}`.
   - `pull-left`: uniform gap-preserving downstream pass from the source.
   - `pull-right`: uniform upstream shift, then downstream conflict pass from `{source} ∪ {upstream-moved tasks}`.
   - `drag-left` / `drag-right`: connected-component translation around the source.
3. Recompute effective starts/ends against blockers and business-day constraints within the reachable subgraph for the chosen mode.
4. There is no whole-graph validation sweep after mode dispatch. Unrelated pre-existing violations remain untouched.
5. Enforce safety caps for iterative upstream `start-left` paths and track monotonic behavior.
6. Emit diagnostics (`capReached`, `unresolvedResidue`) and classify terminal status:
   - `success` when objective completed without unresolved safety residue.
   - `failed` when cap is hit with unresolved residue or runtime error.

### 2b) Provisioning Guards & Behavior

**Double-inception guard:** Inception checks for existing tasks before proceeding. If the study already has tasks, inception aborts with an error message to Automation Reporting. No tasks are created. Import Mode is disabled in the finally block.

**Import Mode lifecycle:** The Notion button automation sets Import Mode = true before sending the webhook. The engine ensures it stays on during execution and always disables it in a finally block — even on abort or error.

**Repeat-delivery date copying:** When repeat-delivery creates a new delivery (e.g., #11), it copies dates from the latest existing delivery (#10) task-by-task, matched by task name (with the delivery number normalized to the target `#N`). This inherits any manual date adjustments. Name-matching is deliberate — the blueprint has multiple `Data Delivery #N` subtrees with unique `[Do Not Edit] Template Source ID` values, so TSID matching would be degenerate (always hits the blueprint source, never a production copy). See PR #18 rationale. Falls back to Contract Sign Date + Blueprint offset when no prior delivery exists.

**Blueprint-vs-in-study authority (Meg-confirmed 2026-04-22):** The Blueprint is the source of truth for STRUCTURE -- task names, dependencies, parent relationships, properties. Dates come from the PREVIOUS corresponding in-study task set when one exists, or from Blueprint offsets relative to Contract Sign Date when no previous exists. Implication: Blueprint offset edits do NOT retroactively propagate to studies that already have a prior task set; the next button press inherits from the (unchanged) previous in-study delivery's dates. Blueprint structural edits (renames, new tasks, dependency changes) DO propagate on every button press because Blueprint is fetched fresh each run (no process-level cache). To make Blueprint offset edits take effect in an existing study, the PM must manually correct the most-recent existing task set first, since that is what the next press will inherit from.

**Add-task-set fallback when seed group missing:** If the study has no existing corresponding task set (e.g., PM deleted the seed TLF group), the engine gracefully falls back to Blueprint-offset date computation relative to Contract Sign Date. `resolveTaskSetNumbers` / `resolveNextDeliveryNumber` both return `1` in this case; no override is populated; `create-tasks.js` computes dates from Blueprint SDate/EDate offsets. Verified for all button types (TLF variants, additional-site, repeat-delivery).

**Copy-blocks scope:** Add-task-set only passes newly created task IDs to copy-blocks, not the full idMapping (which includes existing tasks seeded for dependency resolution).

**Copy-blocks append fidelity:** Template bodies are shallow-fetched (page-direct children only) then normalized for `PATCH /blocks/{page}/children`. Inline **`rich_text` mentions** that round-trip poorly from Notion reads — notably **`link_preview`** — are flattened to **`text`** (+ hyperlink when a URL exists); other mention shapes may become minimal placeholder text so the append batch is not rejected as a whole. **`table` / `table_row` blocks are omitted** until a future change hydrates nested rows/cells (otherwise append fails with missing `children`). When tables are dropped, the engine emits a structured console line `copy_blocks_skipped_block` with `reason: table_requires_hydration`. Plan reference: `docs/plans/2026-04-29-003-fix-copy-blocks-append-validation-plan.md`. `Owner` is renamed only in Blueprint; Study Tasks' `Owner` keeps its original name. The provisioning code reads `[Do Not Edit] Owner` from Blueprint and writes `Owner` to Study Tasks. The per-DB property-name constants enforce this by construction.

### 3) Module Mapping
Map each behavior to concrete modules/functions:
- `src/engine/classify.js`
  - `computeCascadeMode()`
  - `classify()`
- `src/engine/cascade.js`
  - `runCascade()` — dispatches the 6 date-edit modes
  - `tightenSeedAndDownstream()` — dep-edit cascade orchestrator (mirrors `runCascade`'s parent-edge stripping; calls `tightenDownstreamFromSeed` for chain-wide propagation)
  - `conflictOnlyDownstream()`
  - `pullLeftUpstream()`
  - `tightenDownstreamFromSeed()`
  - `gapPreservingDownstream()`
  - `pullRightUpstream()`
  - `shiftConnectedComponent()`
- `src/engine/parent-subtask.js`
  - `runParentSubtask()` (Case B roll-up and cascade roll-up)
- `src/routes/date-cascade.js`
  - `processDateCascade()` (orchestration and terminal status semantics)
  - `buildActivityDetails()` (diagnostics mapping)
- `src/routes/dep-edit.js`
  - `processDepEdit()` (orchestration for the dep-edit cascade; reuses `cascadeQueue` for 5s debounce + per-study FIFO; silent no-op when `tightenSeedAndDownstream` returns `subcase: 'no-op'`)
- `src/utils/business-days.js`
  - `signedBDDelta()`, `nextBusinessDay()`, `addBusinessDays()`, `countBDInclusive()`, `isBusinessDay()`

### 4) Data Contracts
Document payload and return contracts:
- Route input payload schema
- Engine input shape
- Engine output shape (`updates`, moved maps, summaries, diagnostics)
- Reporting payload shape

#### 4.1 ActivityLogEvent (code-era)
Terminal activity log entries are emitted by the route/orchestration layer and written directly to Notion.

```json
{
  "workflow": "date-cascade",
  "status": "success | no_action | failed",
  "triggerType": "api | automation | unknown",
  "executionId": "string",
  "timestamp": "ISO-8601 string",
  "cascadeMode": "string",
  "sourceTaskId": "string",
  "sourceTaskName": "string",
  "studyId": "string",
  "triggeredByUserId": "string | null",
  "summary": "string (<= 2000 chars)",
  "details": {
    "parentMode": "string | null",
    "movement": {
      "updatedCount": "number",
      "movedTaskIds": ["string"],
      "startDeltaBusinessDays": "number | null",
      "endDeltaBusinessDays": "number | null"
    },
    "sourceDates": {
      "originalStart": "YYYY-MM-DD | null",
      "originalEnd": "YYYY-MM-DD | null",
      "modifiedStart": "YYYY-MM-DD | null",
      "modifiedEnd": "YYYY-MM-DD | null"
    },
    "crossChain": {
      "capHit": "boolean",
      "residueCount": "number",
      "residueExamples": [
        {
          "taskId": "string",
          "reason": "string"
        }
      ],
      "clampedEdges": [
        {
          "fromTaskId": "string",
          "toTaskId": "string"
        }
      ]
    },
    "error": {
      "errorCode": "string | null",
      "errorMessage": "string | null",
      "phase": "string | null"
    }
  }
}
```

#### 4.1b Status Roll-Up event shape

Status Roll-Up events have a distinct shape from Date Cascade events. Two subtypes exist, distinguished by `details.direction`:

```json
{
  "workflow": "Status Roll-Up",
  "status": "success | no_action | failed",
  "triggerType": "Automation",
  "cascadeMode": "status-rollup",
  "executionId": "string | null",
  "timestamp": "ISO-8601 string",
  "triggeredByUserId": "string | null",
  "editedByBot": "boolean",
  "sourceTaskId": "string",
  "sourceTaskName": "string",
  "studyId": "string",
  "summary": "Parent <name> status <corrected: <old> -> <new>|-> <new>> (<direct edit blocked>|<triggered by <child>>)",
  "details": {
    "parentId": "string",
    "parentName": "string",
    "oldStatus": "string",
    "newStatus": "string",
    "subtaskCount": "number",
    "direction": "parent-direct | subtask-triggered",
    "timing": { "totalMs": "number" }
  }
}
```

Direction semantics:
- `"parent-direct"`: PM edited the parent's Status directly; engine recomputed from children and snapped back. `sourceTaskId` is the parent itself.
- `"subtask-triggered"`: A leaf subtask's Status changed; engine rolled up to the parent. `sourceTaskId` is the child that triggered the rollup. `details.parentId` names the parent that was patched.

#### 4.2 Notion mapping contract
- Summary goes in Notion `Summary` property.
- Workflow metadata goes in properties (`Workflow`, `Status`, `Cascade Mode`, `Trigger Type`, `Execution ID`, `Duration (ms)`, `Original Dates` (range), `Modified Dates` (range), task/study relations).
- Expanded diagnostics (`details`) go in page body blocks, not in properties.

#### 4.3 Terminal status semantics
- `success`: Intended cascade objective completed and no safety cap residue remains.
- `no_action`: Route completed without date movement due to valid no-op state (gates, unchanged dates, blocked mode, etc.).
- `failed`: Execution error, or unresolved residue that violates cross-chain safety policy after cap.

Do not classify a run as success only because the process completed. Status reflects cascade outcome quality, not transport/execution completion.

#### 4.4 Cascade lifecycle states (task-scoped Automation Reporting)

Cascade lifecycle messages are written to the EDITED TASK's `Automation Reporting` field, not the study's. The study field is shared across all cascades in a study; writing lifecycle states there would overwrite other tasks' states in multi-task workflows.

Normal cascade:
1. `info` "Cascade queued for <task> — starting in ~5s..." — posted synchronously in the webhook handler before the 5s debounce fires. Gives PMs immediate click feedback.
2. `info` "Cascade started for <task>..." — posted after classify confirms the cascade will run (not Error 1, not frozen short-circuit).
3. `success` "Cascade complete for <task>: <mode> (N task updates)" — posted after patches land.

Alternate terminal states:
- Error 1 (direct parent edit): queued → red "Parent date edit reverted — edit a subtask directly to shift dates and trigger cascading" (on the task) + red study-level `DIRECT_PARENT_WARNING` banner. The intermediate "Cascade started" is SUPPRESSED for this path.
- Frozen leaf / middle-parent case-a frozen: queued → silence (no further lifecycle messages; Activity Log records `no_action` with reason `frozen_status`).
- Zero-delta / Import Mode / bot-echo / invalid payload: NO "Cascade queued" is posted. The handler filters these before the queued write.
- Runtime error during processing: queued → red "Cascade failed for <task>: <message>" on the task.

Study-level `Automation Reporting` writes reserved for:
- Error 1 study-level red banner (`DIRECT_PARENT_WARNING`).
- Import Mode operations (add-task-set start/end, inception, deletion).
- Add-task-set success/error summaries.
- Copy-blocks progress.

### 5) Invariants
Non-negotiable safety invariants:
- Complete Freeze semantics:
  - Frozen tasks (`Done`, `N/A`) never move during cascades and are excluded from blocker constraints.
- No recursive anti-loop regressions:
  - System-written date changes must be gated through LMBS and unlock flow; route must avoid infinite webhook loops.
- Date math is business-day-only:
  - Delta computation and directional shifts use business-day utilities only.
- Reachability-bounded propagation:
  - Each cascade mode operates on its explicit reachable seed set or connected component. The engine does not run a whole-graph post-pass to repair unrelated violations.
- Determinism for identical input:
  - Engine outputs (`updates`, `movedTaskMap`, `diagnostics`) are deterministic for identical task graph and payload input.

### 6) Test Coverage Mapping
Link each behavior row and invariant to tests under `engine/test`:

Behavior rows:
- Start-only left / Start-only right / End-only right / Complete Freeze:
  - `test/engine/cascade.test.js`
- End-only left / Drag left / Drag right:
  - `test/engine/cascade-full-chain.test.js`
- End-only right:
  - `test/engine/cascade.test.js`
- Complete Freeze:
  - `test/engine/cascade.test.js`
  - `test/routes/date-cascade.test.js`

Cross-chain and safety:
- `test/engine/cascade-full-chain.test.js`
- `test/verify/blocker-starts.test.js`

Parent/subtask:
- `test/engine/parent-subtask.test.js`

Business-day utilities:
- `test/utils/business-days.test.js`

Classification and orchestration:
- `test/engine/classify.test.js`
- `test/routes/date-cascade.test.js`

Every behavior row in Section 1 must remain mapped to at least one active test file.

### 7) Webhook Authentication

All `/webhook/*` endpoints require a shared-secret header. `GET /health` is exempt so infrastructure health checks always succeed.

- Header: `x-webhook-secret` (HTTP headers are case-insensitive)
- Env var: `WEBHOOK_SECRET`
- Middleware: `src/middleware/webhook-auth.js`
- Registration: `app.use('/webhook', webhookAuth)` in `src/server.js` — covers all 7 webhook endpoints (`/date-cascade`, `/status-rollup`, `/inception`, `/add-task-set`, `/copy-blocks`, `/deletion`, `/undo-cascade`)
- Comparison: `crypto.timingSafeEqual` on equal-length buffers; unequal lengths reject without a timing oracle
- Unset env var → fail-open (auth disabled; local-dev convenience; startup log prints `Auth: disabled`)
- Set env var + missing or wrong header → `401 {"error":"Unauthorized"}`
- Set env var + correct header → request proceeds

Production: `WEBHOOK_SECRET` is set on Railway (`picnic-cascade-engine-production`). All 6 Notion automation webhooks (date change, status change, Activate Plan, Add Task Set, Nuke/Delete, Undo Cascade) carry the matching `x-webhook-secret` header as of 2026-04-12.

### 8) Graceful Shutdown

On `SIGTERM` or `SIGINT`, the process drains in-flight work and exits cleanly before Railway sends `SIGKILL`.

- Signals: `SIGTERM`, `SIGINT`
- Handler: `src/index.js:37-52` (`shutdown(signal)`)
- Idempotent: a `shuttingDown` flag prevents double-drain on repeated signals
- Drain: `await Promise.all([cascadeQueue.drain(), flightTracker.drain(8000)])` — both run in parallel with a shared 8 s wall-clock cap
- `CascadeQueue.drain()`: finishes debounced per-study workers (`src/services/cascade-queue.js`)
- `FlightTracker.drain(8000)`: awaits all fire-and-forget webhook handlers currently registered (`src/services/flight-tracker.js`); tracked handlers are `inception`, `add-task-set`, `copy-blocks`, `deletion`, `status-rollup`
- Exit code: always `0` — drain errors are logged via `console.error` but not propagated, so Railway sees a clean shutdown
- Railway grace period: ~10 s from `SIGTERM` before `SIGKILL`; the 8 s drain cap leaves ~2 s of headroom

### 9) Startup Import Mode Sweep

On process start, the engine clears any `[Do Not Edit] Import Mode = true` studies left over from prior crashes, OOMs, or `SIGKILL` events that skipped graceful shutdown.

- Module: `src/startup/import-mode-sweep.js` (`sweepStuckImportMode(client, studiesDbId)`)
- Invocation: inside an async IIFE after `app.listen()` resolves, in `src/index.js:27-33` — the listen callback does not await it, so the server accepts webhooks immediately while the sweep runs in parallel
- Token pool: uses `provisionTokens` when configured, otherwise falls back to `tokens`
- Query: `Studies` DB filtered on `[Do Not Edit] Import Mode = true` (filter clause keys by property `.id`, so the renamed property still resolves)
- Patch: sets `[Do Not Edit] Import Mode = false` per stuck study
- Error tolerance: failures are caught inside the IIFE — the server never crashes because of sweep errors; structured log `{event: 'import_mode_sweep', studiesFound, studiesReset}` is emitted on completion
- Rationale: Import Mode is a guard flag that suppresses cascades during bulk provisioning; if a study is left stuck `true`, Notion edits to that study silently no-op until a human clears it. The sweep is a safety net that removes that operational burden

### 10) Concurrency Model

See [CONCURRENCY-MODEL.md](CONCURRENCY-MODEL.md) for the full concurrency documentation: per-study FIFO queuing (CascadeQueue), debounce, Import Mode lifecycle, LMBS echo prevention, per-study serialization via `withStudyLock` (covers both add-task-set and inception — since PR E0), graceful shutdown, and the multi-replica migration warning.

### 11) Manual Task Support & Reference Date Bootstrap

**Scope extension (2026-04-24).** PMs can manually add tasks to a study's Study Tasks DB and wire `Blocked by` / `Blocking` dependencies by hand. The cascade engine is contracted to behave identically on manually-added tasks as on engine-provisioned tasks.

#### Reference Date contract

Every cascade classifies deltas via `signedBDDelta(Reference, Dates)`. Two properties must be populated on a task for the engine to compute a non-zero delta:
- `[Do Not Edit] Reference Start Date`
- `[Do Not Edit] Reference End Date`

If either is missing, `src/notion/properties.js:30-31` falls back to the current `Dates` value, producing `delta = 0` and a silent skip at the Zero-Delta gate (`src/routes/date-cascade.js:147-149`).

**Engine-side Reference writes (in sync):**
- **Inception / add-task-set:** `src/provisioning/create-tasks.js:97-98` writes `Reference = initial computed Dates` on page creation.
- **Successful cascade:** `src/routes/date-cascade.js:174-175` updates Reference to the new Dates for every moved task, keeping Reference aligned for the next cascade.
- **Error 1 revert:** `src/routes/date-cascade.js:159-160` restores Reference alongside the reverted Dates.
- **Undo cascade:** `src/routes/undo-cascade.js:61-62` restores Reference from the undo manifest.

Manually-added tasks have no engine-side creation path — Reference must be bootstrapped externally.

#### Bootstrap mechanism — `Fill out reference properties` Notion automation

Configured on the Study Tasks database (Notion-side, not code):

| Field | Value |
|---|---|
| Name | `Fill out reference properties` |
| Scope | View `Fill Refs` — filtered to non-bot / non-automation-created pages whose Reference still needs to be populated |
| Triggers | `Dates is edited` (primary). `Page added` may also be wired. |
| Actions | `Set [Do Not Edit] Reference Start Date` ← formula of `Dates.start`; `Set [Do Not Edit] Reference End Date` ← formula of `Dates.end` |
| Status | Active |

#### Critical invariant — do NOT overwrite already-populated Reference

The automation MUST NOT clobber Reference on a task whose Reference is already populated. If it did, the following sequence would silently break cascading on every subsequent PM edit of a manual task:

1. PM edits Dates from A → B. Notion sends the "When Dates changes" webhook with `{Reference: A, Dates: B}`, `delta = B-A`.
2. `Fill Refs` automation fires on the same edit and writes `Reference = B` to Notion.
3. Engine begins classify at t+5s (after debounce). `classify()` in `src/engine/classify.js:87-123` runs stale-reference correction: compares webhook Reference (A) vs. DB Reference (B), adopts DB Reference as authoritative.
4. Recomputed delta against `Reference = B, Dates = B` → `delta = 0` → no cascade. Silent.

**Valid enforcement mechanisms (either, or both in combination):**
- **View filter approach** — `Fill Refs` excludes pages where Reference is already populated (e.g., filter: `[Do Not Edit] Reference Start Date is empty` OR `[Do Not Edit] Reference End Date is empty`). Automation only ever fires on pages that need bootstrapping.
- **Conditional formula approach** — `My value` formula returns existing Reference when populated, otherwise `Dates.start`/`Dates.end`. Idempotent — safe to re-fire.

The current implementation relies on a view-filter scope (`Fill Refs`) targeting non-bot / non-automation-created pages. Whoever modifies the automation or the view must preserve the bootstrap-not-overwrite guarantee.

#### Bot-created page exclusion

The `Fill Refs` view must also exclude pages created by the Notion integration bots (inception, add-task-set, undo-cascade writers). Without this, the engine's own Reference writes during cascade would re-trigger the automation and race with the post-cascade Reference PATCH. Typical filter element: `Created by != <integration bot user(s)>`.

#### Expected lifecycle for a manually-added task

1. PM creates a new page in Study Tasks DB (Dates may be empty initially).
2. PM sets Dates for the first time.
3. `Fill Refs` automation fires → Reference Start/End populated = Dates Start/End.
4. PM wires `Blocked by` / `Blocking` dependencies as needed. No engine involvement required.
5. Subsequent PM edits of Dates fire the "When Dates changes" webhook. The engine reads populated Reference from the webhook payload and DB; delta is non-zero; cascade runs.
6. Post-cascade Reference sync (`src/routes/date-cascade.js:174-175`) keeps Reference aligned with the new Dates. The `Fill Refs` automation no longer fires for this page (its view filter excludes pages with populated Reference and/or its formula short-circuits).

#### Dependency wiring

Manually-wired `Blocked by` / `Blocking` relations are consumed unchanged by `queryStudyTasks` and the engine's graph walk — no bootstrap needed.

Parent-level edges are still stripped by `runCascade()` (see Section 1 Parent guard). If a PM wires a dependency from a parent task to another parent, the engine silently ignores that edge. The guard applies equally to manually- and engine-created tasks.

#### Dep-edit cascade — fires on `Blocked by` edits (2026-04-27)

PMs can wire or rewire a task's `Blocked by` relation manually. When they do, the rule "every task starts after its predecessor's end" should be enforced upfront — without waiting for someone to drag a date.

**Notion-side automation:** `Dep Edit Cascade` watches the `Blocked by` property on Study Tasks DB. Filters mirror the manual-task pattern — `Last edited by ≠ <bot integration users>`, `[Do Not Edit] Reference Start Date is not empty` (matches the `Fill Refs` precedent above), `Subtask(s) is empty` (parent-task exclusion per BL-H5g). Watches `Blocked by` only — NOT `Blocking` — to avoid Notion's dual-sync double-fire.

**Engine-side handler:** [`src/routes/dep-edit.js`](../src/routes/dep-edit.js) → [`src/engine/cascade.js#tightenSeedAndDownstream`](../src/engine/cascade.js) → [`src/engine/parent-subtask.js#runParentSubtask`](../src/engine/parent-subtask.js) (parent roll-up). Inherits 5s debounce + per-study FIFO via `cascadeQueue`, plus the `editedByBot` short-circuit at the route layer.

**Behavior:** the seed is tightened to `nextBusinessDay(max(non-frozen blocker.end))`, end shifts by the same delta, and the downstream chain re-validates against the new positions via `tightenDownstreamFromSeed`. After leaf cascading, `runParentSubtask({ ..., parentMode: null, movedTaskIds, movedTaskMap })` rolls up each affected parent's dates to `min(child starts) / max(child ends)` (CASCADE-RULEBOOK §5.4). This mirrors the date-cascade pipeline so a manually-inserted task set's parent stays aligned with its now-shifted subtasks after a Blocked-by edit on a leaf. See Section 1 Behavior Matrix for the full row.

**Reuse of the `[Do Not Edit] Reference Start Date is not empty` filter** is critical for the same reason as `Fill Refs`: if the new automation fires on a manual task whose Reference is still empty, the cascade would compute `delta = 0` against the empty Reference and silently no-op. Filtering at the Notion automation layer prevents this and matches the bootstrap-then-cascade lifecycle above.

#### Failure modes

| Condition | Symptom | Resolution |
|---|---|---|
| Automation disabled or `Fill Refs` view missing/misfiltered | Reference stays empty on manual tasks; first edit yields `delta = 0`; cascade silently no-ops | Re-enable the automation; verify the view still matches manually-added pages |
| Automation overwrites already-populated Reference | Every subsequent manual-task edit yields `delta = 0` after stale-ref correction; cascades silently no-op | Tighten the view filter (`[Do Not Edit] Reference Start Date is empty`) or guard the action formulas with an `if Reference is empty` conditional |
| `Fill Refs` view includes bot-created tasks | Engine's Reference writes during cascade re-trigger the automation; race with the post-cascade Reference PATCH | Add `Created by != <integration bot user(s)>` to the view filter |
| Manual task created without Dates | No cascade expected; Reference remains empty until Dates is set | On first Dates set, the automation bootstraps Reference and the lifecycle proceeds normally |

#### L1 source

2026-04-24 Tem → Meg conversation extending scope to manual task support. Update this line with the Meg-confirmation Slack/Notion citation once posted.

## Change Protocol
For every behavior change:
1. Update L1 statement
2. Update this file
3. Add/update tests
4. Update code
5. Record decision in pulse log

## Changelog

### 2026-04-30 — Dep-edit cascade rolls up parent dates (Meg Apr 30 report)

`processDepEdit` now invokes `runParentSubtask({ ..., parentMode: null, movedTaskIds, movedTaskMap })` after `tightenSeedAndDownstream` and merges the resulting parent updates into the patch payload. Mirrors the date-cascade route's pipeline (date-cascade.js:367-378) so a manually-inserted task set's parent re-aligns to its now-shifted subtasks after a Blocked-by edit on a leaf — without this step, leaf cascading shifted subtasks but the parent date stayed put.

`parentMode = null` deliberately skips the case-a/case-b branches inside `runParentSubtask` (the dep-edit seed is always a leaf — parent-task seeds short-circuit upstream), running only the §5.4 "Cascade Roll-Up" pass. Activity Log gains `details.rollUpCount` and `details.rollUpTaskIds`; the success summary appends a `, N parent roll-up(s)` clause when parents moved.

Resolves the 2026-04-30 Meg Slack thread on "Manual Workstream / Item" tasks: button-added TLF #3 + Repeat Delivery #3, then Draft v1 TLF wired as `Blocked by` Data Delivery #3 — subtasks shifted, parent TLF #3 didn't follow. CASCADE-RULEBOOK §3.7 step 3 and §5.4 updated.

### 2026-04-28 — `[Do Not Edit]` property rename across Study Tasks / Studies / Study Blueprint

Plan: `docs/plans/2026-04-28-001-refactor-property-names-constants-module-plan.md`.

Meg renamed every engine-internal/system Notion property to carry a `[Do Not Edit] ` prefix (Study Tasks: `Reference Start Date`, `Reference End Date`, `Template Source ID`, `Last Modified By System`, `Processing Lock`, `Import Mode` rollup, `Notify on Done`, `ID`; Studies: `Import Mode` checkbox; Study Blueprint: `SDate Offset`, `EDate Offset`, `Notion ID`, `Owner`, `Launcher`, `Last Modified By System`, `Notify on Done`, `Duration`). Notion preserved property IDs across the rename.

No behavior change. Engine source flips to ID-keyed reads/writes/filters via a centralized `src/notion/property-names.js` constants module so future renames don't break runtime resolution. This document updated everywhere a renamed property is named in prose, filter text, or action formulas (Sections 1, 9, 11). Historical changelog entries retain the old names where they describe behavior at the time of that PR.

**Owner asymmetry:** `Owner` is renamed only in Blueprint; Study Tasks' `Owner` keeps its original name. The provisioning code reads `[Do Not Edit] Owner` from Blueprint and writes `Owner` to Study Tasks (see Section 2b — Provisioning Guards & Behavior).

### 2026-04-27 — Dep-edit cascade (`/webhook/dep-edit`)

Plan: `docs/plans/2026-04-27-001-feat-dep-edit-cascade-plan.md`.

New cascade trigger that fires when a Study Task's `Blocked by` relation is edited by a non-bot user. Two semantic sub-cases (violation, gap) share the same engine logic — both compute `seed.newStart = nextBD(max(non-frozen blocker.end))` and propagate downstream chain-wide via the existing `tightenDownstreamFromSeed`. Activity Log distinguishes the sub-cases via `details.subcase`.

Behavior matrix (§1) gains a 7th row (`Dep-edit`) noting the trigger is dependency-graph-driven, not delta-driven. Module Mapping (§3) lists the new `tightenSeedAndDownstream` helper and `processDepEdit` route. Section 11 (Manual Task Support) adds a sub-section explaining the new automation reuses the `[Do Not Edit] Reference Start Date is not empty` filter precedent and the `Subtask(s) is empty` filter (BL-H5g parent-task exclusion).

Resolves Meg's 2026-04-24 manual subtask test report (`34c2386760c2803382ccdd9497460150`). Q1 (date-drag enforcement) and Q2 (chain-wide vs seed-only) confirmed at the 2026-04-27 New Features Review: dep-wire only, chain-wide.

### 2026-04-24 — Manual task support & Reference date bootstrap documented

New Section 11 captures the scope extension that allows PMs to manually add tasks + wire `Blocked by` / `Blocking` dependencies and still have the cascade engine behave identically. Documents the Notion-side `Fill out reference properties` automation that bootstraps `[Do Not Edit] Reference Start Date` / `[Do Not Edit] Reference End Date` on manually-created pages via the `Fill Refs` view, and — critically — the invariant that the automation must not overwrite already-populated Reference values (otherwise `classify()`'s stale-reference correction would recompute `delta = 0` on every subsequent edit and silently no-op all manual-task cascades). Also documents expected lifecycle, failure modes, and the bot-created-page exclusion that prevents races with the engine's own Reference writes.

No code change. L1 capture of a Notion-side mechanism the engine's behavior now depends on.

### 2026-04-22 — Meg Apr 21 feedback batch

Plan: `docs/plans/2026-04-22-001-fix-meg-apr21-feedback-plan.md`.

Behavior changes:
- **Status Roll-Up (new parent-direct branch):** when a PM directly edits a parent task's Status, the engine recomputes the parent's rollup from its own subtasks and patches back if they disagree (both directions). Silent correction; Activity Log distinguishes parent-direct (`"status corrected: X -> Y (direct edit blocked)"`, `details.direction = 'parent-direct'`) from the existing subtask-triggered rollup (`"status -> Y (triggered by <child>)"`, `details.direction = 'subtask-triggered'`). Includes `editedByBot` echo-loop skip and a stale-relation guard for empty children queries.
- **Date Cascade (guard reorder):** `isFrozen` moved AFTER `classify` so Error 1 (direct parent edit revert) fires for frozen top-level parents too. Net cost: frozen-leaf edits now trigger a `queryStudyTasks` fetch (previously a zero-I/O log); accepted trade-off. "Cascade started" reportStatus is SUPPRESSED for Error 1 paths so the PM sees queued → revert-warn without a misleading intermediate state.
- **Cascade lifecycle reporting switched to task-scoped.** New "Cascade queued" pre-state + all lifecycle reportStatus writes (queued, started, complete, failed, no-updates, no-cascade-mode warning) target the edited task's `Automation Reporting` field rather than the study's. Multi-task cascades in the same study no longer overwrite each other's states. Study-level reporting still used for Error 1 banner, Import Mode operations, and add-task-set/inception/deletion/copy-blocks summaries.
- **Add Task Set fallback:** verified (no code change) that when a study has no existing corresponding task set, every button type (TLF variants, additional-site, repeat-delivery) falls back to Blueprint-offset date computation from Contract Sign Date. Documented in Section 2b including the Blueprint-vs-in-study authority model (structure from Blueprint, dates from previous in-study task set, Blueprint offset edits do not retroactively propagate).

Bug 3 (Repeat Delivery "button running off something old"): confirmed as intentional design, no code change. The `latestDates` override reads from the previous in-study delivery's date values (inheriting manual adjustments), so Blueprint offset edits only propagate to studies with no prior delivery. Documented in Section 2b.

### 2026-04-20 — Doc resync with current cascade implementation

Sections 1, 2, 3, 5, and 6 were updated to match the current engine:
- `start-left` is its own mode again
- `pull-left` is documented as a single downstream pass
- `pull-right` is documented as a two-pass upstream-shift plus downstream-conflict mode
- drag modes are connected-component translations, not composed left/right hybrids
- the contract now describes reachability-bounded propagation instead of a graph-wide fixed-point sweep
- parent/subtask docs no longer describe the deleted `case-a` parent-edit path

### 2026-04-16 — PR C: repeat-delivery rename-aware date-copy lookup

**Section 2b correction (this doc):** the "Repeat-delivery date copying" row previously claimed matching was by `[Do Not Edit] Template Source ID`. That was aspirational and never true in code — PR #18 deliberately moved *from* TSID *to* name-based matching because the blueprint has 9 separate `Data Delivery #N` subtrees with unique TSIDs, making TSID matching degenerate (always hits the blueprint source, never a production copy). Row now documents name-matching with delivery-number normalization.

**Code fix (`src/routes/add-task-set.js`):** the `latestDates` build loop now normalizes keys from `#N` (existing production delivery) to `#${nextNum}` (the target delivery being created). `applyDeliveryNumbering` rewrites `task._taskName` from `#1` → `#${nextNum}` *before* the override lookup, so unnormalized keys missed and the new delivery fell through to the blueprint-offset formula. Meg's 2026-04-16 reproduction showed `Data Delivery #3` starting Dec 7 while `Repeat QC` ended Dec 8 — Delivery before QC ended. After the fix, `Data Delivery #${nextNum}` inherits the previous delivery's manually shifted dates correctly.

### 2026-04-16 — PR B: code aligned with `start-left` behavior-matrix row

Previously the dispatch ran `pullLeftUpstream` only, producing downstream gaps when a source task's upstream blockers moved. Added `tightenDownstreamFromSeed` downstream pass seeded from `{source} ∪ {upstream-moved tasks}`. No behavior change to the other modes. Closes spec-vs-code drift flagged on Meg's 2026-04-16 live test (Draft ICF / Internal Revisions / Client Review R1 repro; Activity Log event `3442386760c281799d85fea88ef5abf7`). Section 1 row for `start-left` already correctly specified "Upstream then downstream — downstream re-evaluated against blockers"; no table edit needed.

### 2026-04-12 — PR #43 merged (webhook auth, graceful shutdown, startup sweep)

New operational sections 7, 8, and 9 added to this document. Changes:

- **Webhook authentication** (new Section 7): `x-webhook-secret` header + `WEBHOOK_SECRET` env var + `timingSafeEqual` comparison. Fail-open when env var unset for local dev. `GET /health` exempt. Production cutover: 2026-04-12, all 6 Notion automations updated.
- **Graceful shutdown** (new Section 8): `SIGTERM`/`SIGINT` handler drains `CascadeQueue` + `FlightTracker` in parallel with an 8 s cap; Railway sends `SIGKILL` after ~10 s. `FlightTracker` tracks fire-and-forget webhook handlers so in-flight work is not lost during Railway redeploys.
- **Startup Import Mode sweep** (new Section 9): async IIFE after `app.listen()` clears stuck `[Do Not Edit] Import Mode = true` studies. Safety net for crashes/OOMs that bypassed graceful shutdown.

### 2026-03-31 — Meg-confirmed behavior corrections (confirmed by Meg and Seb)

**End-only left** (row updated): Downstream cascade is now defined as a uniform gap-preserving shift for ALL downstream tasks, not conflict-only with clamps. Every downstream task moves by the full delta, preserving inter-task gaps.

**Start-only right** (row updated): ALL upstream blockers shift right by the same delta unconditionally, with gaps always preserved. No adjacency checks or gap absorption. Every upstream blocker moves regardless of whether it was tight/adjacent.

**Pull-right upstream behavior** (Section 2, step 2 updated): Upstream pass for `pull-right`/`drag-right` is now explicitly a uniform gap-preserving shift. No gap absorption.

**Drag left / Drag right** (historical note): This entry reflected an older decomposition model. The current contract above supersedes it: both drag modes are documented as connected-component translations.

**Cross-chain conflict propagation** (historical note): This entry reflected an older graph-wide fixed-point contract. The current contract above supersedes it: propagation is reachability-bounded and there is no whole-graph validation sweep.
