# Cascade Engine Rulebook

Extracted from code as of 2026-04-20. Source files under `src/`.

---

## 1. Cascade Modes

### 1.1 Mode Classification

Classification happens in `src/engine/classify.js`, function `computeCascadeMode()` (line 9).

| `startDelta` | `endDelta` | Mode |
|---|---|---|
| `0` | `> 0` | `push-right` |
| `0` | `< 0` | `pull-left` |
| `< 0` | `0` | `start-left` |
| `> 0` | `0` | `pull-right` |
| `> 0` | `> 0` | `drag-right` |
| `< 0` | `< 0` | `drag-left` |
| all other combos | | `null` (no cascade) |

Deltas are signed business-day differences computed in `parseWebhookPayload()` (`src/gates/guards.js` lines 53-66) via `signedBDDelta(refDate, newDate)`.

### 1.2 Drag Normalization

When both `startDelta` and `endDelta` are non-zero and same-sign, the end date is recalculated to preserve the original duration:

```
correctedEnd = addBusinessDays(newStart, originalDuration - 1)
endDelta = signedBDDelta(refEnd, correctedEnd)
```

This runs twice: first in `parseWebhookPayload()` (guards.js lines 61-66), then again in `classify()` during stale-ref correction (classify.js lines 114-119).

### 1.3 Stale Reference Correction

`classify()` (classify.js lines 87-123) detects when the webhook's reference dates differ from the DB's current reference dates. When stale:

1. Adopts DB reference dates as authoritative.
2. Recalculates deltas, but only for dates the user actually changed (preserves zero deltas to prevent a start-only edit from becoming a drag).
3. Re-runs drag normalization if both deltas are same-sign.
4. Reclassifies cascade mode.

Sets `staleRefCorrected: true` flag in the output.

> **Manual-task caveat.** This correction path is why the Notion-side `Fill out reference properties` automation (ENGINE-BEHAVIOR-REFERENCE §11) must NOT overwrite already-populated Reference dates. If it did, every PM edit on a manually-added task would leave DB `Reference == Dates`, stale-ref correction would adopt that, and the recomputed delta would be `0` — silent no-op. The bootstrap automation's `Fill Refs` view filter and/or conditional formula are what preserve the invariant.

---

## 2. Guards and Gates

The route orchestration in `src/routes/date-cascade.js` (`processDateCascade()`, lines 138-401) runs a sequential guard chain. Each guard either returns early (no cascade) or falls through to the next.

### 2.1 Payload Parse Gate

`parseWebhookPayload()` (guards.js lines 13-92) returns `{ skip: true }` if:
- No page ID in payload (line 21)
- No properties in payload (line 24)

### 2.2 Zero-Delta Skip

date-cascade.js lines 147-149. If `startDelta === 0 && endDelta === 0`, the route returns silently. No activity log entry is created.

### 2.3 Import Mode Gate

`isImportMode()` (guards.js line 94-96) checks `task.importMode === true`.

Import Mode is extracted from the webhook payload (guards.js lines 47-51) from either:
- A rollup (array or boolean type) on the `Import Mode` property
- A direct checkbox on the `Import Mode` property

When Import Mode is active, the route skips silently (date-cascade.js lines 151-154). No activity log entry.

### 2.4 Frozen Status Gate

`isFrozen()` (guards.js lines 98-100) returns true for status `Done` or `N/A`.

If the source task is frozen, the route logs a `no_action` terminal event with reason `frozen_status` (date-cascade.js lines 155-165).

### 2.5 Missing Dates Gate

If `parsed.hasDates` is false (the task has no Dates property set), logs `no_action` with reason `missing_dates` (date-cascade.js lines 166-175).

### 2.6 Missing Study Gate

If `parsed.studyId` is null, logs `no_action` with reason `missing_study` (date-cascade.js lines 176-185).

### 2.7 Classification Skip Gate

After `classify()` runs, if `classified.skip === true` or `classified.cascadeMode` is null/falsy:
- If reason is `Direct parent edit blocked`: calls `applyError1SideEffects()` which writes a warning to Automation Reporting and disables Import Mode (date-cascade.js lines 213-215, 105-119).
- Otherwise: reports a warning to the study page.
- Logs `no_action` terminal event.

### 2.8 Debounce Gate (CascadeQueue)

`src/services/cascade-queue.js` implements two-layer queuing:

**Layer 1 -- Per-task debounce** (lines 42-63):
- Default debounce window: 5000ms (configurable via `CASCADE_DEBOUNCE_MS` env var).
- When a new webhook arrives for the same task, the previous timer is cancelled and replaced.
- Bot-edited webhooks (`editedByBot === true`) are silently ignored as cascade echoes (line 46-49). This prevents infinite loops from the engine's own writes.

**Layer 2 -- Per-study serialization** (lines 66-124):
- After debounce fires, the job is enqueued to a study-specific FIFO queue.
- Only one cascade runs per study at a time.
- Subsequent cascades for the same study wait until the current one completes.

**Bypass conditions** (lines 30-39): Payloads that can't be parsed, are marked `skip`, or lack `taskId`/`studyId` skip the queue and go directly to `processDateCascade()`.

---

## 3. Per-Mode Behavior

All mode dispatch happens in `runCascade()` in `src/engine/cascade.js`.

### 3.1 Push-Right

**Trigger**: `startDelta === 0 && endDelta > 0` (end moved later, start unchanged).

**Behavior**:
1. Seeds = `{ sourceTaskId }`.
2. Runs `conflictOnlyDownstream(seeds, updatesMap, taskById)`.

**`conflictOnlyDownstream()`**:
1. **DFS reachability**: Walks downstream from seeds via `blockingIds` edges to find all reachable tasks.
2. **Topological sort**: Kahn's algorithm over reachable set.
3. **Effective ends map**: Seeds' ends come from `updatesMap` or `taskById`.
4. **Conflict-only push**: Processes tasks in topo order. For each non-seed, non-frozen task:
   - Computes `latestConstraint = max(nextBusinessDay(effectiveEnd))` across all non-frozen blockers that have effective ends.
   - If `task.start >= latestConstraint` -- no conflict, skip.
   - If conflict: `newStart = latestConstraint`, `newEnd = addBusinessDays(newStart, duration - 1)`.
   - Records update, sets `effectiveEnds[taskId]` for downstream propagation.

**Key property**: Only moves tasks that actually violate a blocker constraint. Does NOT shift tasks that have gaps from their blockers.

### 3.2 Pull-Left

**Trigger**: `startDelta === 0 && endDelta < 0` (end moved earlier, start unchanged).

**Behavior**:
1. Runs `gapPreservingDownstream(sourceTaskId, refEnd, newEnd, updatesMap, taskById)`.
2. Computes a uniform negative business-day delta from the source end contraction.
3. Walks downstream from the source via `blockingIds`.
4. Topologically processes reachable downstream tasks.
5. For each reachable non-frozen task:
   - computes `shiftedStart = addBusinessDays(originalStart, deltaBD)`
   - computes `earliestAllowed = max(nextBusinessDay(blockerEnd))` across all blockers, using `updatesMap` when a blocker already moved and `taskById` otherwise
   - clamps to `earliestAllowed` if the uniform shift would violate a blocker
   - skips the task if the result would not move it left
   - preserves duration and mutates `taskById` so later downstream tasks see the updated position

**Key property**: This is a single downstream pass. There is no stationary-blocker guard and no cross-chain fixed-point reprocessing step in the current code.

### 3.3 Start-Left

**Trigger**: `startDelta < 0 && endDelta === 0` (start moved earlier, end unchanged).

**Behavior**:

**Pass 1 -- Upstream pull** via `pullLeftUpstream()`:
1. Bellman-Ford relaxation upstream via `blockedByIds`.
2. Pulls blockers earlier when they finish too late for the moved task.
3. Takes the most aggressive pull when a blocker is reachable by multiple paths.
4. Re-queues blockers for further upstream propagation.
5. Emits `iterations`, `capReached`, `unresolvedResidue`, and `monotonicSafe`.

**Pass 2 -- Downstream tightening** via `tightenDownstreamFromSeed()`:
1. Seeds = `{ sourceTaskId } ∪ { upstream-moved task IDs }`.
2. Walks downstream from those seeds via `blockingIds`.
3. Topologically processes reachable downstream tasks.
4. For each reachable non-frozen task, tightens it to `nextBusinessDay(max(non-frozen blocker end))` with duration preserved.

**Key property**: `start-left` is now explicitly a two-pass mode: upstream conflict resolution, then downstream retightening.

### 3.4 Pull-Right

**Trigger**: `startDelta > 0 && endDelta === 0` (start moved later, end unchanged).

**Behavior**:

**Pass 1 -- Upstream shift** via `pullRightUpstream()`:
1. BFS upstream from source via `blockedByIds` edges.
2. ALL upstream blockers are shifted right by `startDelta` BD unconditionally.
3. Uses ORIGINAL dates (not updatesMap dates) to prevent double-shifting when a blocker is reachable via multiple paths.
4. Frozen tasks are skipped.
5. Once a blocker is recorded in updatesMap, it is NOT overwritten (first-write wins).

**Pass 2 -- Downstream conflict pass**:
1. Seeds = `{ sourceTaskId } + all upstream tasks in updatesMap`.
2. Runs `conflictOnlyDownstream(seeds, updatesMap, taskById)` (same function as push-right).

**Key property**: `pull-right` is also a two-pass mode: shift reachable upstream blockers right, then retighten reachable downstream dependents that now conflict.

### 3.5 Drag-Left

**Trigger**: `startDelta < 0 && endDelta < 0`.

**Behavior**:
1. Runs `shiftConnectedComponent(sourceTaskId, startDelta, updatesMap, taskById, [sourceTaskId])`.
2. Collects the connected component around the source by walking both `blockedByIds` and `blockingIds`.
3. Shifts every reachable non-frozen task except the source by the same delta.

**Key property**: This is a whole-connected-component translation, not a composed start-left plus pull-left sequence.

### 3.6 Drag-Right

**Trigger**: `startDelta > 0 && endDelta > 0` (both start and end moved later).

**Behavior**:
1. Runs the same `shiftConnectedComponent()` path as drag-left, using a positive delta.
2. Shifts every reachable non-frozen task except the source by the same delta.

The distinction from drag-left is the direction of the shared translation.

---

## 4. Cross-Cutting Rules

### 4.1 Frozen Task Semantics

**Definition**: `FROZEN_STATUSES = new Set(['Done', 'N/A'])` (cascade.js line 20, parent-subtask.js line 10, guards.js line 99).

**Rules**:
- Frozen tasks are never moved by any cascade pass (checked in `conflictOnlyDownstream`, `pullLeftUpstream`, `gapPreservingDownstream`, `tightenDownstreamFromSeed`, `pullRightUpstream`, and `shiftConnectedComponent`).
- Frozen blockers are excluded from blocker calculations in the mode-specific cascade passes.
- Route-level: frozen source tasks trigger `no_action` (date-cascade.js line 155-165).

### 4.2 Parent Edge Stripping (BL-H5g)

`runCascade()`:
1. Identifies all parent IDs (tasks that have at least one child with `parentId` pointing to them).
2. For each parent: sets `blockedByIds = []` and `blockingIds = []`.
3. For all other tasks: filters out any parent IDs from their `blockedByIds` and `blockingIds`.

**Effect**: Parent tasks are invisible to the dependency graph during cascade. Dependencies flow only between leaf/subtask-level tasks.

### 4.3 Blocker Constraint Formula

Used consistently across all passes:

```
earliestAllowed = max( nextBusinessDay(blocker.effectiveEnd) ) for all non-frozen blockers
task.start must be >= earliestAllowed
```

`nextBusinessDay()` always advances at least 1 calendar day to the next Mon-Fri (business-days.js lines 33-36).

### 4.4 Duration Preservation

All cascade movements preserve original task duration:
- `newEnd = addBusinessDays(newStart, duration - 1)`
- Duration is computed as `countBDInclusive(start, end)` when not stored (minimum 1).

---

## 5. Parent/Subtask Rules

Implemented in `src/engine/parent-subtask.js`, function `runParentSubtask()`.

### 5.1 Mode Detection

Detected in `classify()`:
- `case-b`: Source task has a parent and does not itself have subtasks.
- `null`: Otherwise.

### 5.2 Direct Parent Edit Block

Any task that has subtasks is blocked from direct date editing in `classify()`. The route treats that as `skip: true`, applies Error 1 side effects, and reverts the source task to its reference dates.

### 5.3 Case B -- Subtask Edited

1. Patches source task with new dates in `taskById`.
2. Finds all siblings (tasks with same `parentId`).
3. Computes parent roll-up: `min(sibling starts)` / `max(sibling ends)`.
4. If different from current parent dates, records an update for the parent.

### 5.4 Cascade Roll-Up

1. After cascade runs, checks all moved tasks and collects their parent IDs.
2. Also includes `parentTaskId` when `case-b` is active.
3. For each affected parent: recomputes dates from all children.
4. If changed, records a roll-up update.

**Pre-applied dates** (lines 62-68): Before any roll-up computation, cascade-moved dates from `movedTaskMap` are applied to `taskById`. This prevents Case B from using stale sibling positions.

---

## 7. Edge Cases

### 7.1 Fan-In (Multiple Blockers)

When a task has multiple `blockedByIds`:
- `conflictOnlyDownstream`: Takes `max(nextBusinessDay(blocker.effectiveEnd))` across all blockers.
- `gapPreservingDownstream`: Same max-constraint logic (lines 297-309).

The task's start is governed by its latest-finishing non-frozen blocker.

### 7.2 Fan-Out (Multiple Dependents)

When a task has multiple `blockingIds`:
- All dependents are reachable via DFS (cascade.js line 40-42).
- Each is independently evaluated for conflict.
- No special fan-out logic needed -- topo sort handles propagation order.

### 7.3 Diamond DAGs

When a task is reachable via multiple paths through the dependency graph:

**In `pullRightUpstream()`**: Uses ORIGINAL dates (not updatesMap) to prevent double-shifting. First-write-wins prevents overwriting. This was an explicit bug fix (comment: "bug 2A.2").

**In `conflictOnlyDownstream()`**: `effectiveEnds` map naturally handles diamonds because topo-order processing ensures all predecessors are resolved before dependents.

**In `pullLeftUpstream()`**: Bellman-Ford relaxation with re-queuing. Takes the most aggressive (earliest) pull. If a later path produces a less aggressive result, `monotonicSafe` is set to false.

### 7.4 Reachability Scope

Mode-specific passes operate on reachable subgraphs, not a whole-graph fixed-point sweep:
- `conflictOnlyDownstream()` walks downstream from its seed set.
- `gapPreservingDownstream()` walks downstream from the source task.
- `tightenDownstreamFromSeed()` walks downstream from `{source} ∪ {upstream-moved tasks}`.
- `shiftConnectedComponent()` walks the connected component around the source using both upstream and downstream edges.

### 7.5 Safety Caps

| Cap | Location | Value | Effect |
|---|---|---|---|
| Bellman-Ford iterations | `pullLeftUpstream` | 2000 | Returns `capReached: true`, `unresolvedResidue` |

When `capReached` is true, the terminal status is `failed` (date-cascade.js line 347).

### 7.6 Source Task Patching

`runCascade()`: The source task's dates in `taskById` are patched with webhook dates BEFORE mode dispatch. This ensures all downstream calculations see the user's intended dates, not stale DB dates.

### 7.7 Undo Capability

`src/services/undo-store.js`: After a successful cascade, a pre-snapshot of all affected task dates is saved (date-cascade.js lines 359-379). The undo manifest maps `taskId -> { oldStart, oldEnd, newStart, newEnd }`. TTL is 15 minutes. One undo per study (latest cascade wins).

---

## 8. Route Orchestration Pipeline

`processDateCascade()` in `src/routes/date-cascade.js` (lines 138-401):

```
1. parseWebhookPayload()          -- extract task edit from Notion webhook
2. Guard chain:
   a. zero-delta skip             -- silent return
   b. import-mode skip            -- silent return
   c. frozen-status skip          -- logged no_action
   d. missing-dates skip          -- logged no_action
   e. missing-study skip          -- logged no_action
3. queryStudyTasks()              -- fetch full task graph for the study
4. Pre-snapshot for undo          -- capture all task dates before cascade
5. classify()                     -- determine cascade mode, parent mode, handle stale refs
6. Classification skip gate       -- logged no_action (or Error 1 side effects)
7. runCascade()                   -- execute mode-specific cascade algorithm
8. runParentSubtask()             -- execute parent/subtask resolution
9. Merge updates                  -- combine cascade + parent results and keep source edit authoritative
10. patchBatch()                  -- write all date updates to Notion
11. Report status                 -- write success summary to study page
12. Log terminal event            -- write activity log entry
13. Save undo manifest            -- store pre-cascade snapshot (15-min TTL)
```

### 8.1 HTTP Response Timing

`handleDateCascade()` (date-cascade.js lines 404-407): Responds `200 OK` immediately, then enqueues the payload into the cascade queue for async processing. The webhook caller does not wait for cascade completion.

### 8.2 Error Handling

date-cascade.js lines 380-401: Errors are caught, reported to the study page (`reportStatus` with error), logged as `failed` terminal event, then re-thrown.

---

## 9. Definitions Quick Reference

| Term | Definition |
|---|---|
| **Business day (BD)** | Monday through Friday, UTC. `isBusinessDay()` checks `getUTCDay() !== 0 && !== 6`. |
| **Frozen** | Task with status `Done` or `N/A`. Never moved; excluded from blocker constraints. |
| **Blocked by** | Upstream dependency edge. Task cannot start before `nextBD(blocker.end)`. |
| **Blocking** | Downstream dependency edge. Inverse of Blocked by. |
| **Seed** | Task(s) whose changes initiate a cascade pass. |
| **Roll-up** | Parent dates derived from `min(child starts)` / `max(child ends)`. |
| **Reference dates** | Stored `Reference Start Date` / `Reference End Date` -- the "before" snapshot for delta computation. |
| **Import Mode** | Study-level flag that suppresses cascading during bulk date imports. |
| **LMBS** | "Last Modified By System" -- debounce/echo detection in the cascade queue. |
