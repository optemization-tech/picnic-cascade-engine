# Cascade Engine Rulebook

Extracted from code as of 2026-04-07. Source files under `engine/src/`.

---

## 1. Cascade Modes

### 1.1 Mode Classification

Classification happens in `src/engine/classify.js`, function `computeCascadeMode()` (line 9).

| `startDelta` | `endDelta` | Mode |
|---|---|---|
| `0` | `> 0` | `push-right` |
| `0` | `< 0` | `pull-left` |
| `< 0` | `0` | `pull-left` |
| `> 0` | `0` | `pull-right` |
| `> 0` | `> 0` | `drag-right` |
| `< 0` | `< 0` | `pull-left` |
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

All mode dispatch happens in `runCascade()` (cascade.js lines 640-757).

### 3.1 Push-Right

**Trigger**: `startDelta === 0 && endDelta > 0` (end moved later, start unchanged).

**Behavior** (cascade.js lines 691-694):
1. Seeds = `{ sourceTaskId }`.
2. Runs `conflictOnlyDownstream(seeds, updatesMap, taskById)`.

**`conflictOnlyDownstream()`** (cascade.js lines 32-119):
1. **DFS reachability**: Walks downstream from seeds via `blockingIds` edges to find all reachable tasks.
2. **Topological sort**: Kahn's algorithm over reachable set.
3. **Effective ends map**: Seeds' ends come from `updatesMap` or `taskById`.
4. **Conflict-only push**: Processes tasks in topo order. For each non-seed, non-frozen task:
   - Computes `latestConstraint = max(nextBusinessDay(effectiveEnd))` across all non-frozen blockers that have effective ends.
   - If `task.start >= latestConstraint` -- no conflict, skip (line 105).
   - If conflict: `newStart = latestConstraint`, `newEnd = addBusinessDays(newStart, duration - 1)`.
   - Records update, sets `effectiveEnds[taskId]` for downstream propagation.

**Key property**: Only moves tasks that actually violate a blocker constraint. Does NOT shift tasks that have gaps from their blockers.

### 3.2 Pull-Left

**Trigger**: `(startDelta === 0 && endDelta < 0)` or `(startDelta < 0 && endDelta === 0)` or `(startDelta < 0 && endDelta < 0)`.

**Behavior** (cascade.js lines 697-718):

**Pass 1 -- Upstream pull** via `pullLeftUpstream()` (lines 128-194):
1. Bellman-Ford relaxation: BFS upstream from source via `blockedByIds` edges.
2. For each blocker: if `nextBusinessDay(blockerEffEnd) > effectiveStartD`, blocker finishes too late. Pull it earlier:
   - `newBlockerEnd = prevBusinessDay(effectiveStartD)`
   - `newBlockerStart = addBusinessDays(newBlockerEnd, -(duration - 1))`
3. Takes the most aggressive (earliest) pull when a blocker is reachable via multiple paths.
4. Re-queues blockers for further upstream propagation (Bellman-Ford re-relaxation).
5. Safety cap: `MAX_ITER = 2000`. If exhausted with items remaining, returns `capReached: true` and `unresolvedResidue` list.
6. Tracks `monotonicSafe` flag (false if a blocker's optimal end is later than an already-recorded update).

**Between passes**: Collects `shiftedUpstreamIds` and saves `prePositions` for all tasks (line 708-714).

**Pass 2 -- Downstream gap-preserving shift** via `gapPreservingDownstream()` (lines 203-330):
1. Computes uniform BD delta (negative) from source's old end to new end.
2. BFS downstream from source + shifted upstream tasks via `blockingIds` edges.
3. Topological sort (Kahn's) over downstream set.
4. For each downstream task in topo order:
   - **Frozen skip**: frozen tasks are never moved (line 275).
   - **Stationary blocker guard (BL-H4g)** (lines 278-292): If the task has a blocker that was NOT moved by the cascade AND the task starts after `nextBusinessDay(blocker.end)` (i.e., there's a gap), the task is held in place. This preserves existing gaps from unmoved blockers.
   - Shifts start by `deltaBD`: `shiftedStart = addBusinessDays(originalStart, deltaBD)`.
   - **Blocker clamp**: Computes `earliestAllowed = max(nextBusinessDay(blockerEnd))` across all blockers (using updated positions). If `earliestAllowed > shiftedStart`, clamps to `earliestAllowed`.
   - **Left-only guard** (line 313): If `newStartD >= originalStart`, skip (never pushes right in this pass).
   - Preserves original duration.
   - **Mutates `taskById`** in-place (lines 319-320) so subsequent topo-order processing sees updated positions.

**Pass 3 -- Cross-chain frustration resolution** via `resolveCrossChainFrustrations()` (lines 387-525):
1. Fixed-point loop, max 5 rounds (configurable via `maxRounds`).
2. For each downstream task: checks if it was "frustrated" -- its current position is later than its desired position (`desiredStart = addBusinessDays(origStart, deltaBD)`).
3. **BL-H4g stationary blocker guard** applies here too (lines 429-440).
4. Skips if a frozen blocker prevents reaching the desired position (lines 448-455).
5. Finds the limiting non-frozen blocker (latest constraint past desired).
6. Shifts that blocker left: `neededEnd = prevBusinessDay(desiredStart)`.
7. Runs `pullLeftUpstream()` on the shifted blocker to resolve upstream conflicts created by the shift.
8. Re-validates: if the blocker was clamped by its own upstream, adjusts it (lines 492-505).
9. After each round: restores ALL downstream tasks to `prePositions` and re-runs `gapPreservingDownstream()` from scratch.
10. Exits when no blockers were shifted in a round (stable) or `maxRounds` reached.

### 3.3 Pull-Right

**Trigger**: `startDelta > 0 && endDelta === 0` (start moved later, end unchanged).

**Behavior** (cascade.js lines 721-727):

**Pass 1 -- Upstream shift** via `pullRightUpstream()` (lines 339-375):
1. BFS upstream from source via `blockedByIds` edges.
2. ALL upstream blockers are shifted right by `startDelta` BD unconditionally.
3. Uses ORIGINAL dates (not updatesMap dates) to prevent double-shifting when a blocker is reachable via multiple paths (bug 2A.2 fix, line 357-360).
4. Frozen tasks are skipped.
5. Once a blocker is recorded in updatesMap, it is NOT overwritten (first-write wins, line 362).

**Pass 2 -- Downstream conflict pass** (lines 724-727):
1. Seeds = `{ sourceTaskId } + all upstream tasks in updatesMap`.
2. Runs `conflictOnlyDownstream(seeds, updatesMap, taskById)` (same function as push-right).

**Key property**: ALL upstream blockers shift by the exact same delta, preserving all gaps. No adjacency check. No gap absorption. Meg-confirmed 2026-03-31.

### 3.4 Drag-Right

**Trigger**: `startDelta > 0 && endDelta > 0` (both start and end moved later).

**Behavior** (cascade.js lines 721-727): Identical to pull-right. Same two passes.

The distinction from pull-right is semantic (both deltas are positive vs. only start), but the engine handles them identically.

---

## 4. Cross-Cutting Rules

### 4.1 Frozen Task Semantics

**Definition**: `FROZEN_STATUSES = new Set(['Done', 'N/A'])` (cascade.js line 20, parent-subtask.js line 10, guards.js line 99).

**Rules**:
- Frozen tasks are never moved by any cascade pass (checked in `conflictOnlyDownstream` line 89, `pullLeftUpstream` line 155, `gapPreservingDownstream` line 275, `pullRightUpstream` line 355, `validateConstraints` line 570).
- Frozen blockers are excluded from constraint calculations in `conflictOnlyDownstream` (line 95), `enforceConstraints` (constraints.js line 53), and `validateConstraints` (line 577).
- Frozen blockers still participate in frustration detection: they can prevent a task from reaching its desired position (cascade.js lines 448-455), but the engine won't try to move them.
- Route-level: frozen source tasks trigger `no_action` (date-cascade.js line 155-165).

### 4.2 Parent Edge Stripping (BL-H5g)

`runCascade()` (cascade.js lines 651-670):
1. Identifies all parent IDs (tasks that have at least one child with `parentId` pointing to them).
2. For each parent: sets `blockedByIds = []` and `blockingIds = []`.
3. For all other tasks: filters out any parent IDs from their `blockedByIds` and `blockingIds`.

**Effect**: Parent tasks are invisible to the dependency graph during cascade. Dependencies flow only between leaf/subtask-level tasks.

### 4.3 Stationary Blocker Guard (BL-H4g)

Applied in `gapPreservingDownstream()` (cascade.js lines 278-292) and `resolveCrossChainFrustrations()` (lines 429-440).

A task is "held by a stationary blocker with a gap" when:
- The blocker was NOT moved by the cascade (not in `updatesMap` and not a seed).
- The blocker is NOT frozen.
- The task starts AFTER `nextBusinessDay(blocker.end)` (there's a gap between blocker end and task start).

**Effect**: The task is skipped entirely -- it doesn't shift left even though the uniform delta says it should. This preserves intentional gaps from unmoved blockers.

### 4.4 Blocker Constraint Formula

Used consistently across all passes:

```
earliestAllowed = max( nextBusinessDay(blocker.effectiveEnd) ) for all non-frozen blockers
task.start must be >= earliestAllowed
```

`nextBusinessDay()` always advances at least 1 calendar day to the next Mon-Fri (business-days.js lines 33-36).

### 4.5 Duration Preservation

All cascade movements preserve original task duration:
- `newEnd = addBusinessDays(newStart, duration - 1)` (cascade.js line 108, 315, etc.)
- Duration is computed as `countBDInclusive(start, end)` when not stored (minimum 1).

### 4.6 Weekend Snap Safety Net

`enforceConstraints()` (constraints.js lines 79-86): After all cascade and parent processing, if the final start date falls on a weekend, snaps it to the next business day and recalculates end from the snapped start while preserving duration.

### 4.7 Post-Cascade Constraint Validation

`validateConstraints()` (cascade.js lines 533-617):
1. Topological sort over ALL tasks (not just moved ones).
2. For each non-frozen task with predecessors: checks if `effectiveStart >= earliestAllowed`.
3. Violations are snapped forward (push-right) to the earliest allowed position.
4. Mutates `taskById` so downstream tasks in topo order see corrected positions.
5. Detects cycles: if topo sort is incomplete, sets `cycleDetected: true`.
6. Returns `fixedCount`, `fixedTaskIds`, `cycleDetected`.

Called after every mode dispatch in `runCascade()` (lines 736-743). Catches pre-existing violations and edge cases the mode-specific passes missed.

---

## 5. Parent/Subtask Rules

Implemented in `src/engine/parent-subtask.js`, function `runParentSubtask()` (lines 31-412).

### 5.1 Mode Detection

Detected in `classify()` (classify.js lines 58-62):
- `case-a`: Source task has subtasks (determined by checking if any task in allTasks has `parentId === sourceTaskId`).
- `case-b`: Source task has a parent (determined by `hasParent` flag from webhook).
- `null`: Neither.

### 5.2 Case A -- Parent Edited

**Guard**: Top-level parents with subtasks are blocked from `push-right` and `pull-right` modes (classify.js lines 65-82). Returns `skip: true` with reason `Direct parent edit blocked`.

**When allowed** (parent-subtask.js lines 76-255):
1. Finds all subtasks where `parentId === sourceTaskId`.
2. Computes "natural" start/end as min(subtask starts) / max(subtask ends).
3. Computes delta from natural dates to new webhook dates:
   - Both changed: `delta = signedBDDelta(naturalEnd, newEnd)`
   - End only changed: same
   - Start only changed: `delta = signedBDDelta(naturalStart, newStart)`
4. If `delta !== 0`: shifts ALL non-frozen subtasks by delta.
5. **Dependency resolution within subtasks**: After shifting, runs DFS + topo sort + conflict-only push-right on the shifted subtask set and their downstream dependents (lines 158-232). Same logic as `conflictOnlyDownstream` but inline.
6. **Roll-up**: Recomputes parent dates as `min(subtask starts)` / `max(subtask ends)` and records update (lines 235-254).

### 5.3 Case B -- Subtask Edited

parent-subtask.js lines 260-329:
1. Patches source task with new dates in `taskById`.
2. Finds all siblings (tasks with same `parentId`).
3. Computes parent roll-up: `min(sibling starts)` / `max(sibling ends)`.
4. If different from current parent dates, records an update for the parent.

### 5.4 Cascade Roll-Up

parent-subtask.js lines 334-382:
1. After cascade runs (separate from Case A/B), checks all tasks moved by the cascade (`movedTaskIds`).
2. For each moved task that has a `parentId` (excluding the source's own parent if Case B): collects the parent.
3. For each affected parent: recomputes dates from all children.
4. If changed, records roll-up update.

**Pre-applied dates** (lines 62-68): Before any roll-up computation, cascade-moved dates from `movedTaskMap` are applied to `taskById`. This prevents Case B from using stale sibling positions.

### 5.5 Case A Roll-Up Override in Constraints

`enforceConstraints()` (constraints.js lines 71-76): When `parentMode === 'case-a'` and `rolledUpStart`/`rolledUpEnd` are present, the roll-up dates override any other constraint result. The case-a roll-up is authoritative.

---

## 6. Constraint Enforcement

Implemented in `src/engine/constraints.js`, function `enforceConstraints()` (lines 14-102).

### 6.1 Inputs

- `task`: The source task with `taskId`, `newStart`, `newEnd`, `refStart`, `refEnd`.
- `cascadeResult`: Contains `movedTaskMap` (task positions after cascade).
- `parentResult`: Contains `parentMode`, `rolledUpStart`, `rolledUpEnd`.
- `allTasks`: Full task graph for blocker lookups.

### 6.2 Blocker Constraint on Source

constraints.js lines 41-68:
1. For each blocker of the source task (`blockedByIds`):
   - Uses cascade-moved end date if blocker was moved, otherwise DB end date.
   - Skips frozen blockers (`Done`/`N/A`).
   - Computes `candidate = nextBusinessDay(blockerEnd)`.
2. `earliestAllowed = max(all candidates)`.
3. If source's `newStart < earliestAllowed`: snaps start forward, recalculates end preserving original duration.
4. Sets `constrained: true`.

### 6.3 Case-A Merge

constraints.js lines 71-76: If `parentMode === 'case-a'`, the rolled-up start/end from the parent subtask resolver replace whatever the constraint enforcement produced. Sets `merged: true`.

### 6.4 Weekend Snap

constraints.js lines 79-86: If final start is not a business day, snaps to `nextBusinessDay()` and recomputes end preserving duration.

### 6.5 Execution Order in Route

date-cascade.js lines 259-272: Constraint enforcement runs AFTER both `runCascade()` and `runParentSubtask()`, receiving both results. It is the final date authority for the source task.

---

## 7. Edge Cases

### 7.1 Fan-In (Multiple Blockers)

When a task has multiple `blockedByIds`:
- `conflictOnlyDownstream`: Takes `max(nextBusinessDay(blocker.effectiveEnd))` across all blockers (cascade.js lines 92-102).
- `gapPreservingDownstream`: Same max-constraint logic (lines 297-309).
- `validateConstraints`: Same (lines 574-584).
- `enforceConstraints`: Same (constraints.js lines 44-56).

The task's start is governed by its latest-finishing non-frozen blocker.

### 7.2 Fan-Out (Multiple Dependents)

When a task has multiple `blockingIds`:
- All dependents are reachable via DFS (cascade.js line 40-42).
- Each is independently evaluated for conflict.
- No special fan-out logic needed -- topo sort handles propagation order.

### 7.3 Diamond DAGs

When a task is reachable via multiple paths through the dependency graph:

**In `pullRightUpstream()`**: Uses ORIGINAL dates (not updatesMap) to prevent double-shifting. First-write-wins prevents overwriting (cascade.js lines 357-362, 371-374). This was an explicit bug fix (comment: "bug 2A.2").

**In `conflictOnlyDownstream()`**: `effectiveEnds` map naturally handles diamonds because topo-order processing ensures all predecessors are resolved before dependents.

**In `pullLeftUpstream()`**: Bellman-Ford relaxation with re-queuing. Takes the most aggressive (earliest) pull (line 170). If a later path produces a less aggressive result, `monotonicSafe` is set to false (line 181).

### 7.4 Cross-Chain Frustration Resolution

When `gapPreservingDownstream()` shifts a task that is also blocked by tasks in a different chain, the blocker may prevent the task from reaching its desired position. `resolveCrossChainFrustrations()` (cascade.js lines 387-525) resolves this by:

1. Detecting frustrated tasks (current position > desired position).
2. Finding the limiting cross-chain blocker.
3. Shifting that blocker left + cascading through its upstream.
4. Restoring all downstream positions to pre-cascade state.
5. Re-running `gapPreservingDownstream()` from scratch.
6. Repeating until stable or 5 rounds.

### 7.5 Cycle Detection

`validateConstraints()` (cascade.js lines 564, 610-612): If the topological sort does not cover all tasks (`sorted.length < allIds.length`), cycles exist. Sets `cycleDetected: true` and `cycleMissedCount`. Tasks in cycles are not processed by validation (they never enter the topo order).

### 7.6 Safety Caps

| Cap | Location | Value | Effect |
|---|---|---|---|
| Bellman-Ford iterations | `pullLeftUpstream` line 133 | 2000 | Returns `capReached: true`, `unresolvedResidue` |
| Cross-chain rounds | `resolveCrossChainFrustrations` line 389 | 5 | Stops iterating; remaining frustrations unresolved |

When `capReached` is true, the terminal status is `failed` (date-cascade.js line 347).

### 7.7 Source Task Patching

`runCascade()` (cascade.js lines 677-679): The source task's dates in `taskById` are patched with webhook dates BEFORE mode dispatch. This ensures all downstream calculations see the user's intended dates, not stale DB dates.

### 7.8 Undo Capability

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
9. enforceConstraints()           -- source task constraint enforcement + case-a merge
10. Merge updates                 -- combine cascade + parent + constrained source
11. patchBatch()                  -- write all date updates to Notion
12. Report status                 -- write success summary to study page
13. Log terminal event            -- write activity log entry
14. Save undo manifest            -- store pre-cascade snapshot (15-min TTL)
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
| **Stationary blocker** | A blocker not moved by the current cascade (not in updatesMap, not a seed). |
| **Frustrated task** | A downstream task clamped by a cross-chain blocker, unable to reach its desired position. |
| **Roll-up** | Parent dates derived from `min(child starts)` / `max(child ends)`. |
| **Reference dates** | Stored `Reference Start Date` / `Reference End Date` -- the "before" snapshot for delta computation. |
| **Import Mode** | Study-level flag that suppresses cascading during bulk date imports. |
| **LMBS** | "Last Modified By System" -- debounce/echo detection in the cascade queue. |
