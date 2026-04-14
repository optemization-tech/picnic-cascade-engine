---
title: "fix: Task set numbering off-by-one for non-repeat-delivery buttons"
type: fix
status: active
date: 2026-04-14
---

# fix: Task set numbering off-by-one for non-repeat-delivery buttons

## Overview

Non-repeat-delivery add-task-set buttons (TLF, CSR, Insights, Additional Site) produce incorrect numbering — the first additional instance gets `#3` instead of `#2`, and all subsequent numbers are similarly off by 1. The fix eliminates a redundant post-creation Notion query and uses the pre-creation task list for numbering, matching the pattern that already works correctly for repeat-delivery buttons.

## Problem Frame

When a user clicks an add-task-set button (e.g., "Additional TLF + Insights"), the engine creates new task instances and then numbers them by counting existing tasks with the same Template Source ID. The counting query runs **after** task creation (~20-30s later), by which time Notion has indexed the just-created tasks. The formula `count + 1` therefore includes the new task in the count, producing `2 + 1 = 3` instead of the correct `1 + 1 = 2`.

**Concrete reproduction** (from live testing):

| Button pressed | Expected TLF # | Actual TLF # |
|---|---|---|
| TLF + Insights (1st additional) | TLF #2 | TLF #3 |
| TLF only (2nd additional) | TLF #3 | TLF #4 |
| TLF + CSR (3rd additional) | TLF #4 | TLF #5 |

Same off-by-one for CSR and Insights Report. Data Delivery numbering is correct because it uses a different function (`resolveNextDeliveryNumber`) that reads pre-creation data.

## Requirements Trace

- R1. Non-repeat-delivery task set numbering must assign sequential numbers starting from `#2` (inception's original is implicitly `#1`)
- R2. No redundant Notion API query after task creation (eliminates 2-5s latency per Finding #17 from codebase review)
- R3. Regression test covering the numbering path (`.cursorrules` mandate: every bug fix includes a regression test)

## Scope Boundaries

- Repeat-delivery numbering (`resolveNextDeliveryNumber`) is NOT affected — it already works correctly
- No changes to `createStudyTasks`, `wireRemainingRelations`, or any provisioning module
- No changes to the rename/patch logic itself — only the data source feeding it

## Context & Research

### Relevant Code and Patterns

- `src/routes/add-task-set.js:19-36` — `resolveNextDeliveryNumber`: the correct pattern (uses pre-creation `existingTasks`)
- `src/routes/add-task-set.js:59-79` — `resolveTaskSetNumbers`: the buggy caller's data source is wrong, but the function logic is sound
- `src/routes/add-task-set.js:386-418` — post-create numbering block: the fresh query + call site
- `src/routes/add-task-set.js:144-168` — pre-creation `existingTasks` fetch (already in scope for the fix)
- `test/routes/add-task-set.test.js:184-217` — delivery numbering test (pattern to follow for the new test)

### Institutional Learnings

- **Codebase review Findings #17 and #28** (`docs/CODEBASE-REVIEW-2026-04-07.md`): Both identified this exact issue — the redundant query adds latency and relies on Notion eventual consistency with no retry
- **Stale reference correction pattern** (`src/engine/classify.js:85-105`): The codebase already prefers authoritative/pre-fetched data over re-queried data when freshness matters

## Key Technical Decisions

- **Use pre-creation `existingTasks` instead of fresh post-creation query**: The `existingTasks` array (line 168) is fetched before any tasks are created. Since per-study serialization (5s debounce + FIFO queue) prevents concurrent add-task-set operations on the same study, this data is guaranteed to be accurate. `count + 1` then gives the correct next number.
- **Remove the fresh query entirely**: It served no purpose that the pre-creation data doesn't already serve. Removing it also fixes the 2-5s latency penalty flagged in Finding #17.
- **Test `resolveTaskSetNumbers` as a pure function + test the integration path**: The function is already pure — unit testing it directly gives precise coverage. An integration-level test verifying `patchPages` receives correct rename data covers the full path.

## Open Questions

### Resolved During Planning

- **Q: Could the fresh query serve any purpose the pre-creation data doesn't?** No. `resolveTaskSetNumbers` only needs the count of pre-existing tasks per Template Source ID. The just-created tasks share template IDs with the blueprint entries already in `filteredLevels` — counting them is the bug, not a feature.
- **Q: What about concurrent add-task-set operations?** Per-study FIFO queue prevents this. Only one add-task-set runs at a time per study.

### Deferred to Implementation

- None. The fix is fully scoped.

## Implementation Units

- [ ] **Unit 1: Fix numbering data source and remove redundant query**

  **Goal:** Use pre-creation `existingTasks` for numbering instead of fresh post-creation query. Remove the unnecessary query.

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Modify: `src/routes/add-task-set.js`

  **Approach:**
  - On line 397, replace `freshTasks` with `existingTasks` (already in scope from line 168)
  - Remove the fresh `queryDatabase` call (lines 390-395) and the `freshTasks` variable
  - Remove the stale comment at lines 284-286 ("Task set numbering is applied AFTER task creation... because Notion's database query has eventual consistency") — this comment described the old (wrong) rationale
  - Update the comment at lines 385-386 to explain the correct approach: numbering uses pre-creation data because we only need the count of tasks that existed before this operation
  - Keep the `tracer.startPhase('applyTaskSetNumbering')` / `endPhase` — the rename logic stays in place

  **Patterns to follow:**
  - `resolveNextDeliveryNumber(existingTasks)` call on line 222 — same pattern of using pre-creation data

  **Test scenarios:**
  - Happy path: Given 1 existing TLF task (from inception) and `filteredLevels` with 1 TLF parent, `resolveTaskSetNumbers` returns `{ templateId => 2 }`, and `patchPages` is called with `"TLF #2"` rename
  - Multiple parents: Given 1 existing TLF and 1 existing CSR, and `filteredLevels` with both TLF and CSR parents, each gets `#2` independently
  - No existing tasks: Given 0 existing tasks matching any template ID, numbering returns `#1`
  - Multiple existing instances: Given 3 existing TLF tasks and `filteredLevels` with a TLF parent, numbering returns `#4`
  - No second queryDatabase call: After task creation + wiring, `queryDatabase` is NOT called again (only the initial pre-creation call)

  **Verification:**
  - `npm run test:ci` — all existing tests pass, no regressions
  - New regression test passes
  - Live test: press "Additional TLF only" button on a study with 1 existing TLF → new task named "TLF #2" (not "TLF #3")

- [ ] **Unit 2: Add regression tests for task set numbering**

  **Goal:** Cover the non-repeat-delivery numbering path with both unit and integration tests.

  **Requirements:** R3

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `test/routes/add-task-set.test.js`

  **Approach:**
  - Add a `describe('task set numbering')` block
  - Test `resolveTaskSetNumbers` behavior through the route handler by verifying `patchPages` receives the correct rename properties
  - Mock `queryDatabase` to return pre-existing tasks with Template Source IDs, verify the rename call uses the correct `#N`
  - Verify `queryDatabase` is called exactly once (the pre-creation call), NOT twice (which would indicate the fresh query still exists)

  **Patterns to follow:**
  - Existing delivery numbering test (line 184-217): mock setup pattern, `flush()` usage, assertion on task name mutation
  - Happy path test (line 219-293): mock setup for full flow through to `patchPages`

  **Test scenarios:**
  - Happy path: `queryDatabase` returns 1 task with matching TSID → `patchPages` called with `"TaskName #2"`
  - Edge case: `queryDatabase` returns 0 tasks with matching TSID → `patchPages` called with `"TaskName #1"`
  - Edge case: Multiple level-0 parents with different existing counts → each gets independent numbering
  - Integration: `queryDatabase` is called exactly 1 time (pre-creation only, no fresh post-creation query)
  - Edge case: Repeat-delivery button does NOT trigger `patchPages` rename (numbering handled by `applyDeliveryNumbering` instead)

  **Verification:**
  - All new tests pass
  - `npm run test:ci` — full suite passes

## System-Wide Impact

- **Interaction graph:** Only the add-task-set route is affected. No other routes call `resolveTaskSetNumbers`. No callbacks, middleware, or observers involved.
- **Error propagation:** No change — the rename logic's error handling is unchanged.
- **API surface parity:** The Notion rename `patchPages` call is unchanged — only the number it receives changes.
- **Unchanged invariants:** Repeat-delivery numbering (`resolveNextDeliveryNumber`), task creation, relation wiring, copy-blocks, Import Mode lifecycle — all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Pre-creation query misses tasks from a prior concurrent operation | Per-study FIFO queue prevents this. Only one operation runs at a time per study. |
| Existing mis-numbered tasks in production | This fix prevents future mis-numbering. Existing `#3`/`#4`/etc. names from testing can be manually corrected or will be overwritten on next undo + re-creation. |

## Sources & References

- **Codebase review**: `docs/CODEBASE-REVIEW-2026-04-07.md` Findings #17 and #28
- Related code: `src/routes/add-task-set.js:resolveTaskSetNumbers`, `resolveNextDeliveryNumber`
- Related test: `test/routes/add-task-set.test.js`
