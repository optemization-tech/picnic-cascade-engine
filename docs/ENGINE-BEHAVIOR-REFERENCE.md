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
| Start-only left | `startDelta < 0 && endDelta == 0` | `pull-left` | Upstream then downstream | Upstream moves if dependency conflict; downstream is re-evaluated against blockers | Upstream pull tightens schedule; downstream preserves relative shift then clamps to blockers | Source moves earlier, blockers are pulled earlier as needed, and resulting chain remains dependency-valid |
| Start-only right | `startDelta > 0 && endDelta == 0` | `pull-right` | Upstream first, then downstream conflict pass | ALL upstream blockers shift right by the same delta unconditionally; downstream moves only if conflict | ALL upstream gaps are preserved (no gap absorption); uniform shift for every upstream blocker | All upstream blockers shift right by delta preserving gaps; downstream only adjusts if source/upstream changes introduce conflicts |
| End-only left | `startDelta == 0 && endDelta < 0` | `pull-left` | Upstream then downstream | Same as pull-left | ALL downstream tasks shift by the full delta (uniform gap-preserving cascade); no conflict-only filtering | End contraction uniformly pulls all downstream tasks earlier, preserving inter-task gaps and dependency validity |
| End-only right | `startDelta == 0 && endDelta > 0` | `push-right` | Downstream only | Downstream moves only if `task.start < nextBusinessDay(blocker.end)` | Conflict-only push (no blanket uniform shift) | Only conflicting downstream tasks move right enough to clear conflicts |
| Drag left | `startDelta < 0 && endDelta < 0` | `pull-left` | Upstream then downstream | Upstream moves if dependency conflict (start-left behavior); ALL downstream tasks shift by the full delta unconditionally (end-left behavior) | Upstream: conflict-only; Downstream: uniform gap-preserving cascade (matches end-only left) | Drag earlier pulls upstream blockers as needed for conflicts and uniformly shifts all downstream tasks preserving gaps |
| Drag right | `startDelta > 0 && endDelta > 0` | `drag-right` | Upstream then downstream conflict pass | ALL upstream blockers shift right by the same delta unconditionally (start-right behavior); downstream moves only if conflict (end-right behavior) | Upstream: uniform gap-preserving shift (matches start-only right); Downstream: conflict-only push | Drag later uniformly shifts all upstream blockers right preserving gaps and resolves any downstream conflicts |
| Complete Freeze | Task status is frozen (`Done`/`N/A`) | N/A | Route + engine gates | Frozen tasks never move and are excluded from blocker constraints | N/A | Frozen tasks remain fixed while cascades continue around them where valid |

Parent guard:
- Top-level parents with subtasks are blocked for direct rightward parent edits (`push-right`/`pull-right`) and produce a warning to edit subtasks directly.

### 2) Cross-Chain Propagation Contract
1. Apply source edit to the in-memory graph using webhook dates as authoritative.
2. Run mode-specific propagation:
   - `push-right`: downstream conflict pass.
   - `pull-left`: iterative upstream relaxation, then uniform gap-preserving downstream pass.
   - `pull-right`/`drag-right`: uniform gap-preserving upstream pass, then downstream conflict pass.
3. Recompute effective starts/ends against blockers and business-day constraints.
4. **Cross-chain conflict propagation** (graph-wide cascade): When a uniform gap-preserving shift moves a task that participates in dependency edges in a _different_ chain, and that movement creates a conflict with an unmoved task in that other chain, the engine must continue cascading through the other chain using the same mode-specific rules. This is not limited to a single dependency chain -- the cascade is graph-wide. The engine must traverse all cross-chain edges introduced by each movement pass until no new conflicts remain or the safety cap is reached.
5. Enforce safety caps for iterative paths (`pull-left` upstream max iterations, cross-chain cascade max iterations) and track monotonic behavior.
6. Emit diagnostics (`capReached`, `unresolvedResidue`) and classify terminal status:
   - `success` when objective completed without unresolved safety residue.
   - `failed` when cap is hit with unresolved residue or runtime error.

### 2b) Provisioning Guards & Behavior

**Double-inception guard:** Inception checks for existing tasks before proceeding. If the study already has tasks, inception aborts with an error message to Automation Reporting. No tasks are created. Import Mode is disabled in the finally block.

**Import Mode lifecycle:** The Notion button automation sets Import Mode = true before sending the webhook. The engine ensures it stays on during execution and always disables it in a finally block — even on abort or error.

**Repeat-delivery date copying:** When repeat-delivery creates a new delivery (e.g., #11), it copies dates from the latest existing delivery (#10) task-by-task, matched by task name (with the delivery number normalized to the target `#N`). This inherits any manual date adjustments. Name-matching is deliberate — the blueprint has multiple `Data Delivery #N` subtrees with unique Template Source IDs, so TSID matching would be degenerate (always hits the blueprint source, never a production copy). See PR #18 rationale. Falls back to Contract Sign Date + offset if no prior delivery exists.

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
  - `gapPreservingDownstream()`
  - `pullRightUpstream()`
- `src/engine/parent-subtask.js`
  - `runParentSubtask()` (Case A parent shift, Case B roll-up, cascade roll-up)
- `src/engine/constraints.js`
  - `enforceConstraints()` (source clamping + case-a merge + weekend snap)
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
- `success`: Intended cascade objective completed and safety constraints satisfied.
- `no_action`: Route completed without date movement due to valid no-op state (gates, unchanged dates, blocked mode, etc.).
- `failed`: Execution error, or unresolved residue that violates cross-chain safety policy after cap.

Do not classify a run as success only because the process completed. Status reflects cascade outcome quality, not transport/execution completion.

### 5) Invariants
Non-negotiable safety invariants:
- Dependency validity after cascade:
  - No non-frozen dependent may start before the next business day after its effective blocker end.
- Complete Freeze semantics:
  - Frozen tasks (`Done`, `N/A`) never move during cascades and are excluded from blocker constraints.
- No recursive anti-loop regressions:
  - System-written date changes must be gated through LMBS and unlock flow; route must avoid infinite webhook loops.
- Date math is business-day-only:
  - Delta computation, pushes/pulls, and constraint snaps use business-day utilities only.
- Cross-chain cascade completeness:
  - When a cascade moves a task that has dependencies in other chains, and that movement creates conflicts in those chains, the engine must continue cascading through all affected chains until no unresolved conflicts remain or the safety cap is reached. Cascades are graph-wide, not single-chain.
- Determinism for identical input:
  - Engine outputs (`updates`, `movedTaskMap`, `diagnostics`) are deterministic for identical task graph and payload input.

### 6) Test Coverage Mapping
Link each behavior row and invariant to tests under `engine/test`:

Behavior rows:
- Start-only left / End-only left / Drag left:
  - `engine/test/engine/cascade.test.js` (`pull-left` scenarios)
- Start-only right / Drag right:
  - `engine/test/engine/cascade.test.js` (`pull-right` and `drag-right` scenarios)
- End-only right:
  - `engine/test/engine/cascade.test.js` (`push-right` scenarios)
- Complete Freeze:
  - `engine/test/engine/cascade.test.js` (frozen-task scenarios)
  - `engine/test/routes/date-cascade.test.js` (route-level frozen gate)

Cross-chain and safety:
- `engine/test/engine/cascade-safety.test.js` (cap, residue, monotonic safety)

Parent/subtask:
- `engine/test/engine/parent-subtask.test.js` (Case A, Case B, roll-up)

Constraints + business-day:
- `engine/test/engine/constraints.test.js`
- `engine/test/utils/business-days.test.js`

Classification and orchestration:
- `engine/test/engine/classify.test.js`
- `engine/test/routes/date-cascade.test.js`

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

See [CONCURRENCY-MODEL.md](CONCURRENCY-MODEL.md) for the full concurrency documentation: per-study FIFO queuing (CascadeQueue), debounce, Import Mode lifecycle, LMBS echo prevention, withStudyLock (add-task-set serialization), graceful shutdown, and the multi-replica migration warning.

### 11) Duplicate Prevention

The engine's create path (POST `/pages`) is not idempotent at Notion's side — a retry-after-commit creates a second page with the same payload. This produces "silent duplicates": the engine thinks it succeeded once, but two tasks exist in the database with the same `Template Source ID`. Three layered safety nets address this, sequenced as PR E0 / E1 / E2:

**Layer 1 — Shared study lock (PR E0).** `withStudyLock(studyId, fn)` (in `src/services/study-lock.js`) is shared across inception and add-task-set. Same-study operations serialize through a module-level Promise chain; different studies run in parallel. Necessary foundation for L2 and L3 — without the lock, the post-flight sweep could race with a concurrent create on the same study.

**Layer 2 — Path-based narrow retry (PR E1).** `_requestWithSlot` classifies non-GET Notion endpoints by `method + path` into `idempotent`, `non_idempotent`, or `block_append`. Non-idempotent endpoints (notably POST `/pages`) skip the retry loop on ambiguous failures (transient network errors where the server may have committed). This eliminates the dominant source of client-side retry-after-commit duplicates. `archivePage` (PATCH `/pages/:id` with top-level `archived`) is classified as idempotent; archiving an already-archived page is a server-side no-op, so normal retries apply.

**Layer 3 — Post-flight + weekly sweep (PR E2).** After `createStudyTasks` completes in inception / add-task-set, `duplicateSweep.run({studyPageId, trackedIds, tsids, tracer, notionClient, studyTasksDbId})` waits `config.sweepGraceMs` (default 45s, configurable via `SWEEP_GRACE_MS` env var) for Notion's query index to catch up with recent writes, then queries all tasks in the study via a single `Study contains X` filter, groups by `Template Source ID`, and archives any extras whose page IDs are not in `trackedIds`. `trackedIds` is derived from `createStudyTasks.idMapping` at the call site — no change to the function signature. Runs under `withStudyLock` coverage; the 45s grace extends lock hold time by 45-80s per provisioning run. Different studies unaffected. Webhook response (`res.status(200)`) is acknowledged immediately — only the async worker (tracked by `flightTracker`) is delayed, so no webhook-layer timeout. Sweep failure is non-fatal — errors land in tracer counters and flow through Activity Log details.

**Weekly workspace sweep (`scripts/sweep-all-studies.js`).** Scheduled script — Railway Cron or GitHub Actions — catches duplicates that slipped past the 45s grace window (rare) AND any pre-E2 backlog. Dry-run by default; `--archive` executes after operator review. Keep-rule: prefer fully-wired pages, fall back to earliest `created_time`. Flags pages with non-empty comments, non-bot `last_edited_by`, or non-default `Status` — flagged pages are skipped, require manual resolution.

**Observable signals:** `retryStats` (all endpoints — existing), `narrowRetrySuppressed` (PR E1 — retries the classifier skipped), `sweepDuplicatesFound / sweepDuplicatesArchived / sweepDuplicatesFailed / sweepQueryFailed` (PR E2). Sweep details in Activity Log body include the archived page IDs (up to 50 per run) for support un-archive if ever needed.

**For future maintainers:** when adding a new non-GET Notion endpoint, update PR E1's path-based classifier in `src/notion/client.js` to the correct category. Default (`idempotent`) retries as today; if the endpoint is actually non-idempotent or block-append, duplicates will slip through until the weekly sweep catches them. Not zero-cost — bounded by the sweep cadence.

## Change Protocol
For every behavior change:
1. Update L1 statement
2. Update this file
3. Add/update tests
4. Update code
5. Record decision in pulse log

## Changelog

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

**Drag left / Drag right** (rows updated): Decomposed into their constituent behaviors. Drag left = start-left (upstream conflict-only) + end-left (all downstream always, gap-preserving). Drag right = start-right (all upstream always, gap-preserving) + end-right (downstream conflict-only).

**Cross-chain conflict propagation** (new rule, Section 2 step 4 + new invariant): When a gap-preserving shift moves a task that has dependencies in a different chain and creates a conflict with an unmoved task in that other chain, the engine must continue cascading through the other chain. Cascades are graph-wide, not single-chain. Added corresponding invariant in Section 5.
