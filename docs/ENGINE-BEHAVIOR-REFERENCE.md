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

**Repeat-delivery date copying:** When repeat-delivery creates a new delivery (e.g., #11), it copies dates from the latest existing delivery (#10) task-by-task, matched by task name (with the delivery number normalized to the target `#N`). This inherits any manual date adjustments. Name-matching is deliberate — the blueprint has multiple `Data Delivery #N` subtrees with unique Template Source IDs, so TSID matching would be degenerate (always hits the blueprint source, never a production copy). See PR #18 rationale. Falls back to Contract Sign Date + Blueprint offset when no prior delivery exists.

**Blueprint-vs-in-study authority (Meg-confirmed 2026-04-22):** The Blueprint is the source of truth for STRUCTURE -- task names, dependencies, parent relationships, properties. Dates come from the PREVIOUS corresponding in-study task set when one exists, or from Blueprint offsets relative to Contract Sign Date when no previous exists. Implication: Blueprint offset edits do NOT retroactively propagate to studies that already have a prior task set; the next button press inherits from the (unchanged) previous in-study delivery's dates. Blueprint structural edits (renames, new tasks, dependency changes) DO propagate on every button press because Blueprint is fetched fresh each run (no process-level cache). To make Blueprint offset edits take effect in an existing study, the PM must manually correct the most-recent existing task set first, since that is what the next press will inherit from.

**Add-task-set fallback when seed group missing:** If the study has no existing corresponding task set (e.g., PM deleted the seed TLF group), the engine gracefully falls back to Blueprint-offset date computation relative to Contract Sign Date. `resolveTaskSetNumbers` / `resolveNextDeliveryNumber` both return `1` in this case; no override is populated; `create-tasks.js` computes dates from Blueprint SDate/EDate offsets. Verified for all button types (TLF variants, additional-site, repeat-delivery).

**Copy-blocks scope:** Add-task-set only passes newly created task IDs to copy-blocks, not the full idMapping (which includes existing tasks seeded for dependency resolution).

### 3) Module Mapping
Map each behavior to concrete modules/functions:
- `src/engine/classify.js`
  - `computeCascadeMode()`
  - `classify()`
- `src/engine/cascade.js`
  - `runCascade()`
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

On process start, the engine clears any `Import Mode = true` studies left over from prior crashes, OOMs, or `SIGKILL` events that skipped graceful shutdown.

- Module: `src/startup/import-mode-sweep.js` (`sweepStuckImportMode(client, studiesDbId)`)
- Invocation: inside an async IIFE after `app.listen()` resolves, in `src/index.js:27-33` — the listen callback does not await it, so the server accepts webhooks immediately while the sweep runs in parallel
- Token pool: uses `provisionTokens` when configured, otherwise falls back to `tokens`
- Query: `Studies` DB filtered on `Import Mode = true`
- Patch: sets `Import Mode = false` per stuck study
- Error tolerance: failures are caught inside the IIFE — the server never crashes because of sweep errors; structured log `{event: 'import_mode_sweep', studiesFound, studiesReset}` is emitted on completion
- Rationale: Import Mode is a guard flag that suppresses cascades during bulk provisioning; if a study is left stuck `true`, Notion edits to that study silently no-op until a human clears it. The sweep is a safety net that removes that operational burden

### 10) Concurrency Model

See [CONCURRENCY-MODEL.md](CONCURRENCY-MODEL.md) for the full concurrency documentation: per-study FIFO queuing (CascadeQueue), debounce, Import Mode lifecycle, LMBS echo prevention, per-study serialization via `withStudyLock` (covers both add-task-set and inception — since PR E0), graceful shutdown, and the multi-replica migration warning.

## Change Protocol
For every behavior change:
1. Update L1 statement
2. Update this file
3. Add/update tests
4. Update code
5. Record decision in pulse log

## Changelog

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

**Section 2b correction (this doc):** the "Repeat-delivery date copying" row previously claimed matching was by Template Source ID. That was aspirational and never true in code — PR #18 deliberately moved *from* TSID *to* name-based matching because the blueprint has 9 separate `Data Delivery #N` subtrees with unique TSIDs, making TSID matching degenerate (always hits the blueprint source, never a production copy). Row now documents name-matching with delivery-number normalization.

**Code fix (`src/routes/add-task-set.js`):** the `latestDates` build loop now normalizes keys from `#N` (existing production delivery) to `#${nextNum}` (the target delivery being created). `applyDeliveryNumbering` rewrites `task._taskName` from `#1` → `#${nextNum}` *before* the override lookup, so unnormalized keys missed and the new delivery fell through to the blueprint-offset formula. Meg's 2026-04-16 reproduction showed `Data Delivery #3` starting Dec 7 while `Repeat QC` ended Dec 8 — Delivery before QC ended. After the fix, `Data Delivery #${nextNum}` inherits the previous delivery's manually shifted dates correctly.

### 2026-04-16 — PR B: code aligned with `start-left` behavior-matrix row

Previously the dispatch ran `pullLeftUpstream` only, producing downstream gaps when a source task's upstream blockers moved. Added `tightenDownstreamFromSeed` downstream pass seeded from `{source} ∪ {upstream-moved tasks}`. No behavior change to the other modes. Closes spec-vs-code drift flagged on Meg's 2026-04-16 live test (Draft ICF / Internal Revisions / Client Review R1 repro; Activity Log event `3442386760c281799d85fea88ef5abf7`). Section 1 row for `start-left` already correctly specified "Upstream then downstream — downstream re-evaluated against blockers"; no table edit needed.

### 2026-04-12 — PR #43 merged (webhook auth, graceful shutdown, startup sweep)

New operational sections 7, 8, and 9 added to this document. Changes:

- **Webhook authentication** (new Section 7): `x-webhook-secret` header + `WEBHOOK_SECRET` env var + `timingSafeEqual` comparison. Fail-open when env var unset for local dev. `GET /health` exempt. Production cutover: 2026-04-12, all 6 Notion automations updated.
- **Graceful shutdown** (new Section 8): `SIGTERM`/`SIGINT` handler drains `CascadeQueue` + `FlightTracker` in parallel with an 8 s cap; Railway sends `SIGKILL` after ~10 s. `FlightTracker` tracks fire-and-forget webhook handlers so in-flight work is not lost during Railway redeploys.
- **Startup Import Mode sweep** (new Section 9): async IIFE after `app.listen()` clears stuck `Import Mode = true` studies. Safety net for crashes/OOMs that bypassed graceful shutdown.

### 2026-03-31 — Meg-confirmed behavior corrections (confirmed by Meg and Seb)

**End-only left** (row updated): Downstream cascade is now defined as a uniform gap-preserving shift for ALL downstream tasks, not conflict-only with clamps. Every downstream task moves by the full delta, preserving inter-task gaps.

**Start-only right** (row updated): ALL upstream blockers shift right by the same delta unconditionally, with gaps always preserved. No adjacency checks or gap absorption. Every upstream blocker moves regardless of whether it was tight/adjacent.

**Pull-right upstream behavior** (Section 2, step 2 updated): Upstream pass for `pull-right`/`drag-right` is now explicitly a uniform gap-preserving shift. No gap absorption.

**Drag left / Drag right** (historical note): This entry reflected an older decomposition model. The current contract above supersedes it: both drag modes are documented as connected-component translations.

**Cross-chain conflict propagation** (historical note): This entry reflected an older graph-wide fixed-point contract. The current contract above supersedes it: propagation is reachability-bounded and there is no whole-graph validation sweep.
