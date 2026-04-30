---
title: Fix dep-edit cascade so parent tasks roll up after their subtasks shift
type: fix
status: active
date: 2026-04-30
---

# Fix dep-edit cascade so parent tasks roll up after their subtasks shift

## Overview

`processDepEdit` in `src/routes/dep-edit.js` currently runs the leaf-level cascade (`tightenSeedAndDownstream`) and patches its updates directly, but never invokes `runParentSubtask`. As a result, when a `Blocked by` edit shifts a manually-inserted task set's subtasks (e.g., Draft v1 TLF and its downstream chain under TLF #3), the parent task's dates do not realign to span the moved subtasks. The date-cascade route already has the correct pattern — `src/routes/date-cascade.js` (≈ lines 367-378) calls `runParentSubtask({ ..., movedTaskIds, movedTaskMap })` after `runCascade` and merges parent updates into the patch payload. This plan mirrors that pattern in dep-edit.

The fix is bounded (single route file behavior change + matching tests + behavior-doc updates). The bug-driven core is the `runParentSubtask` invocation and merge; the operator-UX surface (roll-up message phrasing, success summary suffix, `rollUpTaskIds` audit field) is plan-imposed parity with date-cascade rather than strictly-minimal. Both halves go in together because they're cheap to land atomically and Meg-facing observability matters for cascade work. Touches a Meg-confirmed cascade contract, so it goes through the documented Compound Engineering plan/review/work/review flow.

---

## Problem Frame

**Bug as Meg reported it (2026-04-30 morning Slack):** Add a task set via the "Additional Task Set Creation" button (e.g., TLF #3 with subtasks Draft v1 TLF, Internal Review & Revisions, …, TLF Delivery). Add Repeat Delivery #3 the same way. Wire Draft v1 TLF (the first subtask of TLF #3) as `Blocked by` Data Delivery #3. Result: subtasks move correctly, but parent TLF #3 stays at its original dates.

Meg's expectation, confirmed in thread: *"all parent adjustments to dates - so like parents always respond after the subtasks shift so that they align with earliest subtask start and latest subtask end."*

**Root cause:** `processDepEdit` calls `tightenSeedAndDownstream` (leaf cascade) and patches the result. The §5.4 "Cascade Roll-Up" pass that exists in `src/engine/parent-subtask.js` (lines 306-352) — which recomputes `min(child starts) / max(child ends)` for each parent of a moved task — is never invoked from this route. The 2026-04-27 dep-edit plan (`docs/plans/2026-04-27-001-feat-dep-edit-cascade-plan.md`) documented parent EXCLUSION (BL-H5g — parents can't be cascade triggers/blockers) but never addressed parent ROLL-UP after leaf shifts. It was an omission, not an explicit decision.

**Why parent rollup is consistent with BL-H5g:** Parents stay invisible to the dependency graph (no `blockedByIds`/`blockingIds` participation). Roll-up is a separate post-cascade pass that recomputes parent date *fields* from already-moved subtask dates — orthogonal to the dependency-edge invariant.

---

## Requirements Trace

- R1. After a successful dep-edit cascade that moves at least one subtask of a parent, the parent's `Dates` and `[Do Not Edit] Reference Start/End Date` properties realign to `min(child starts) / max(child ends)` from the post-cascade child positions.
- R2. The fix mirrors date-cascade's existing pipeline (parse → leaf cascade → parent rollup → merge → patch → log) so a Blocked-by edit produces the same parent-alignment behavior as a date drag.
- R3. Activity Log records the rollup count and rolled-up task IDs in `details` so operators can audit which parents moved without parsing every patch row.
- R4. PMs reading a parent task's `Automation Reporting` field can distinguish a roll-up from a leaf shift — the rollup row uses a roll-up-flavored message.
- R5. The fix preserves all existing dep-edit invariants: parent-task seed exclusion, parent-edge stripping (BL-H5g), bot-echo skip, frozen-task semantics, no-op silent path.
- R6. Behavior contract docs (CASCADE-RULEBOOK §3.7 step list and §5.4, ENGINE-BEHAVIOR-REFERENCE §11 dep-edit subsection + changelog) and BEHAVIOR-TAGS.md are updated so the next operator finds the documented behavior matches the code.

---

## Scope Boundaries

- This plan does not change `runParentSubtask`'s logic, signature, or tests for the existing case-a/case-b paths.
- This plan does not change `tightenSeedAndDownstream`'s logic, signature, or tests.
- This plan does not change the Notion-side `Dep Edit Cascade` automation (filters, trigger, watched property).
- This plan does not change date-cascade's pipeline.
- The Activity Log rollup fields (`rollUpCount`, `rollUpTaskIds`) are forensics-only — not lifted into `ActivityLogService.detailLines()` for bullet rendering. That lift, if needed later, is a separate change.
- This plan does not change cascade queue (debounce, FIFO) or the `editedByBot` guard.

### Deferred to Follow-Up Work

- **Multi-level parent roll-up (grandparents and above).** `runParentSubtask`'s cascade-roll-up pass walks one level: it adds each moved task's `parentId` to `affectedParentIds`, but the parent updates it emits are not added back into `movedTaskIds` for further processing. Date-cascade has the same one-level limitation today. **Tradeoff to be aware of:** before this fix, in a hypothetical 3-level study (e.g., "TLF" > "TLF #3" > "Draft v1 TLF"), all parents stayed *uniformly* stale — internally consistent. After this fix, the immediate parent (TLF #3) rolls up but the grandparent (TLF) stays stale, producing a *mismatched* state where the grandparent's dates don't span TLF #3's new range. This is a partial improvement, not a regression, but the failure mode is more visible. We don't currently know whether PicnicHealth has 3-level hierarchies in production (predominant pattern is 2-level: parent task set with leaf subtasks). If a Meg report shows a grandparent not realigning, address it as a separate plan that fixes both routes simultaneously.

---

## Context & Research

### Relevant Code and Patterns

- **Pipeline to mirror:** `src/routes/date-cascade.js` — specifically the leaf cascade → parent rollup → merge → patch sequence (≈ lines 352-410, 432-483). Key shape: `runParentSubtask({ ..., movedTaskIds: cascadeResult.movedTaskIds, movedTaskMap: cascadeResult.movedTaskMap })`, then a Map-keyed merge of `cascadeResult.updates` and `parentResult.updates`, then `patchPages(patchPayload)`, then `logTerminalEvent({ ..., parentResult? })`.
- **Roll-up helper:** `src/engine/parent-subtask.js` — `runParentSubtask(...)`. With `parentMode: null`, lines 98 (case-a) and 230 (case-b) are skipped; the always-on cascade-roll-up block at lines 306-352 runs. Pre-application of `movedTaskMap` to `taskById` at lines 83-90 ensures parent recomputes use post-cascade child positions. Output updates carry `_isRollUp: true` and a `_reportingMsg` (line 354-359, format `"❇️ Roll-up: dates set to {start} — {end}"`).
- **Existing test that exercises the exact path:** `test/engine/parent-subtask.test.js:116-142` (`'rolls up affected parents from movedTaskIds/movedTaskMap'`). Calls `runParentSubtask` with `parentMode: null`, `parentTaskId: null`, a synthetic `sourceTaskId` not in tasks, and `movedTaskIds`/`movedTaskMap` from a fictional cascade. Verifies the parent rolls up to the expected min/max range. This is the contract dep-edit will rely on.
- **Mocking pattern for route tests:** `test/routes/date-cascade.test.js` lines 14-15, 53-54 — `vi.hoisted` block declares `runParentSubtask: vi.fn()` and `vi.mock('../../src/engine/parent-subtask.js', () => ({ runParentSubtask: mocks.runParentSubtask }))`. Dep-edit's existing test file (`test/routes/dep-edit.test.js`) already follows the same `vi.hoisted` + `vi.mock` shape for `tightenSeedAndDownstream`.
- **`buildUpdateProperties` reporting-message fallback:** `src/routes/date-cascade.js` line 180 — `update._reportingMsg || \`❇️ ${cascadeMode || 'cascade'}: dates shifted (triggered by ${sourceTaskName})\``. Roll-up rows from `runParentSubtask` carry the right `_reportingMsg`; leaf rows from `tightenSeedAndDownstream` do not (so the fallback fires). Dep-edit's current `buildUpdateProperties` (line 85-100) hard-codes the message — needs the same fallback.
- **Activity Log shape conventions:** `src/services/activity-log.js` `detailLines()` (lines 24-74) reads `details.movement.updatedCount`, `details.crossChain.*`, `details.sourceDates.*`, `details.error.*`, `details.timing.*`, `details.retryStats.*`, `details.narrowRetrySuppressed`. Existing dep-edit forensics-only fields (`subcase`, `reason`, `downstreamCount`, `cycleDetected`, `cycleTaskIds`) are top-level scalars and intentionally NOT in `detailLines()` — see comment at `src/routes/dep-edit.js` lines 55-58. New rollup fields follow the same forensics-only convention.
- **Failure-path threading:** `src/routes/dep-edit.js` line 110 hoists `result` outside the `try` so the catch's `logTerminalEvent` includes cascade context if `patchPages` throws. The same pattern needs to extend to `parentResult` for consistent failure rows.
- **Behavior-tag registration:** `docs/BEHAVIOR-TAGS.md` lists every `BEH-*` ID; tests carry plain-text `BEH-*` references (convention: `// @behavior BEH-...` on the `it(...)` line). `scripts/check-behavior-traceability.js` regex-matches both surfaces (no AST parsing — any test-file occurrence counts). `npm run test:ci` runs traceability before vitest, so missing tags fail CI early.

### Institutional Learnings

- **Activity Log shape must match `detailLines()` readers** — pulse log `pulse-log/04.27/003-dep-edit-cascade-engine-implementation.md`, commit `f337a06`. Dep-edit shipped initially with a flat `details` shape; review pass found `detailLines()` couldn't render bullets because it expects nested sub-objects (`movement.updatedCount`, etc.). The current dep-edit `buildActivityDetails` was reshaped to match. New rollup fields must not regress this — keep `movement`, `sourceDates`, `crossChain`, `error` nested; keep new forensics scalars top-level alongside existing `subcase`/`downstreamCount`.
- **Failure-path context preservation** — same pulse log + commit `f337a06`. When `patchPages` throws after the cascade has computed updates, the catch-block's `logTerminalEvent` must thread `result` so the failure row shows `subcase`/`movedTaskIds`/`movement.updatedCount` instead of `null`. The same threading needs to extend to `parentResult` after this fix.
- **BL-H5g parent-edge stripping is orthogonal to parent rollup.** Rollup operates on the parent's *date fields*, not on graph edges. Parents remain invisible to the cascade graph; rollup just recomputes their dates from already-moved children. (Source: CASCADE-RULEBOOK §4.2 + §5.4; 04.27 plan D6.)

### External References

- None. The pattern is fully established in this codebase — date-cascade.js demonstrates the exact orchestration. No external best-practice research adds value here.

---

## Key Technical Decisions

- **D1: Pass `parentMode: null` to `runParentSubtask`** (vs adding a new mode like `'cascade-rollup-only'`). With `parentMode: null`, the case-a (line 98) and case-b (line 230) blocks are skipped; only the cascade-roll-up section (lines 306-352) runs. Adding a new mode would force a `runParentSubtask` modification and force the date-cascade case-a/case-b paths to keep mapping `parentMode` values they don't recognize. **Justification rests on a line-by-line trace, not on a cited test.** `parent-subtask.test.js:116` exercises `parentMode: null` but uses a synthetic `sourceTaskId: 'source'` not present in tasks — dep-edit's case (seed IS in tasks list, IS in movedTaskMap, has a parentId) is structurally different. Walked the cascade-roll-up loop for dep-edit's actual case: line 311's `if (task.parentId === sourceTaskId) continue;` correctly does NOT fire (the seed's `parentId` ≠ the seed's id), so `affectedParentIds.add(seed.parentId)` executes as expected. To close the missing-test gap, U1 adds a direct unit test in `parent-subtask.test.js` for this exact case (see U1 test scenarios).
- **D2: Reuse `runParentSubtask` rather than extract the cascade-rollup pass into its own helper.** Extraction would create two call sites with subtle differences (case-b never runs in dep-edit; case-b's source-task taskById patch is implicit in dep-edit because `movedTaskMap` is pre-applied at line 83-90). KISS — minimize blast radius and keep the rollup contract in one helper. If a future change demands a single-purpose rollup helper, extract it then.
- **D3: Multi-level rollup is out of scope.** `runParentSubtask`'s cascade-roll-up walks one parent level. Date-cascade has the same limitation today. Fixing both routes simultaneously is a separate plan if a grandparent regression surfaces.
- **D4: `buildUpdateProperties` uses `update._reportingMsg ||` fallback** (mirroring date-cascade.js line 180). Roll-up rows carry the right message from `runParentSubtask` (`"❇️ Roll-up: dates set to {start} — {end}"`); leaf rows have no `_reportingMsg` and fall back to dep-edit's hardcoded `"❇️ dep-edit {subcase}: dates shifted (triggered by {seed})"`. PMs see distinguishable messages without a separate code branch on `_isRollUp`.
- **D5: New Activity Log fields are top-level scalars** (`details.rollUpCount`, `details.rollUpTaskIds`). Matches the existing dep-edit forensics convention (`subcase`, `downstreamCount` are top-level). `details.movement.updatedCount`, however, is bumped to include parent-rollup updates so the rendered Activity Log bullet count is accurate (since `movement.updatedCount` IS read by `detailLines()`). U1 also extends `activity-log.js`'s JSON-strip list to include `rollUpTaskIds` so the field doesn't push timing/retry data off the end of Notion's 2000-char block limit (precedent: `movement.movedTaskIds` is already stripped at `src/services/activity-log.js:78-84`).

---

## Open Questions

### Resolved During Planning

- *Should we use `parentMode: 'case-b'` and compute `parentTaskId` from the seed?* — No (D1). `parentMode: null` is simpler, has direct test precedent, and produces the same net result for the seed's own parent because the cascade-roll-up loop at line 306+ adds the seed's `parentId` to `affectedParentIds` regardless. The case-b-only path duplicates work that the cascade-roll-up already handles.
- *Should the rollup pass run on no-op subcase?* — No. If `subcase === 'no-op'`, `result.movedTaskIds` is empty; `runParentSubtask` would produce zero parent updates anyway. Keep the existing silent-no-op early return at dep-edit.js line 165 unchanged so we don't regress the "no Activity Log noise on already-tight chains" property.
- *Should the rollup pass run when `result.updates.length === 0` but subcase is violation/gap (defensive case)?* — No. The existing line 180-191 short-circuits this with a `no_action` log. Don't change that path.
- *Should `movement.movedTaskIds` include parent IDs?* — No. The semantic distinction matters: `movement.movedTaskIds` historically tracks the cascade-graph leaves the engine moved. Parents are emitted by a separate post-cascade pass. Add new field `details.rollUpTaskIds` for the parent IDs.

### Deferred to Implementation

- Whether to also write `Reference Start/End` on parent rollup rows or only `Dates`. Plan answer: write all three (consistent with leaf shape and date-cascade; `runParentSubtask` already populates `newReferenceStartDate`/`newReferenceEndDate` on rollup updates).

---

## Implementation Units

- U1. **Add parent rollup pass to `processDepEdit` (route + tests, test-first)**

**Goal:** Extend `processDepEdit` to invoke `runParentSubtask({ ..., parentMode: null, movedTaskIds, movedTaskMap })` after the leaf cascade, merge parent updates into the patch payload, and surface rollup metadata in the Activity Log and success summary. Where date-cascade's pipeline already supports the same step (orchestration, merge, success-path log shape), follow it. Where dep-edit needs net-new behavior that date-cascade doesn't have (threading `parentResult` through the failure-path log so failure rows preserve rollup context), add it explicitly — that's a dep-edit improvement, not a mirror.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** none

**Files:**
- Modify: `src/routes/dep-edit.js`
- Modify: `src/services/activity-log.js` (extend JSON-strip list)
- Modify: `test/routes/dep-edit.test.js`
- Modify: `test/engine/dep-edit-cascade.test.js`
- Modify: `test/engine/parent-subtask.test.js` (close the missing direct-unit-test gap)

**Approach:**
- Import `runParentSubtask` from `../engine/parent-subtask.js` at the top of `dep-edit.js`.
- Hoist `let parentResult = null;` outside the `try` block, alongside the existing `let result = null;` at dep-edit.js:110. This is what makes the catch-block threading work — same pattern as `result`.
- After the existing leaf cascade and the `subcase === 'no-op'` / zero-updates short-circuits, call `runParentSubtask` with: `sourceTaskId = parsed.taskId`, `sourceTaskName = parsed.taskName`, `newStart`/`newEnd` from `result.movedTaskMap?.[parsed.taskId]` (true defensive coding — `tightenSeedAndDownstream` always inserts the seed into `movedTaskMap` for `subcase ∈ {violation, gap}`, so the value will resolve under current code; chaining future-proofs against refactors of the no-op short-circuit), `parentTaskId: null`, `parentMode: null`, `movedTaskIds: result.movedTaskIds || []`, `movedTaskMap: result.movedTaskMap || {}`, `tasks: allTasks`.
- Merge updates with a `Map` keyed on `taskId`. Match date-cascade.js:391-393's order — insert leaf updates first, then parent updates (so parents would win on collision). In practice no collision can occur because parents are stripped from the cascade graph at `src/engine/cascade.js:528-538`, so `result.updates` cannot contain a parent ID. The merge order is documentation of intent (parents-after-leaves matches the pipeline), not load-bearing for correctness.
- Map `mergedUpdates` to a `patchPayload` using `buildUpdateProperties(u, parsed.taskName, result.subcase)`.
- Update `buildUpdateProperties` to use `update._reportingMsg || \`❇️ dep-edit ${subcase}: dates shifted (triggered by ${sourceTaskName})\`` (mirrors date-cascade.js line 180). This way roll-up rows carry the canonical roll-up message from `runParentSubtask` while leaf rows keep the existing dep-edit phrasing.
- Update `buildActivityDetails` signature from `({ parsed, result, error, noActionReason })` to `({ parsed, result, parentResult, error, noActionReason })` (add `parentResult` to the destructured params). Bump `movement.updatedCount` to `(result?.updates?.length ?? 0) + (parentResult?.updates?.length ?? 0)` so `detailLines()` renders the merged total. Add top-level `rollUpCount: parentResult?.rollUpCount ?? 0` (use the helper's existing return field rather than recomputing from `updates.length` — single source of truth) and `rollUpTaskIds: (parentResult?.updates || []).map(u => u.taskId)`. Do not nest under `movement` or `crossChain`.
- Extend `src/services/activity-log.js`'s `buildChildren` JSON-strip list (currently strips `movement.movedTaskIds` at lines 78-84) to also strip `rollUpTaskIds`. Otherwise a deeply-nested study can push the rendered JSON block past Notion's 2000-char limit and clip timing/retry data.
- Update `logTerminalEvent` signature to accept and forward `parentResult` to `buildActivityDetails`.
- Update the success summary to append a parent-roll-up clause when `parentResult.updates.length > 0` (e.g., `, N parent roll-up(s)`). Keep the existing `+M downstream` prefix unchanged for continuity. Exact phrasing is a small UX call ce:work makes when writing — single sentence, lowercase, after the downstream count.
- Thread `parentResult` through the `catch` block's `logTerminalEvent` call (alongside the already-hoisted `result`) so failure rows preserve rollup context. **Note:** date-cascade does NOT thread `parentResult` through its catch block today — this is a net-new improvement specific to dep-edit, not a mirror of existing behavior. If parity with date-cascade is desired later, that's a separate plan.

**Execution note:** Test-first. Write the failing route-level tests for the rollup integration and the Activity Log shape changes, then make them pass. The existing parent-subtask.test.js:116 covers the helper contract; we're verifying the route correctly invokes and merges.

**Patterns to follow:**
- `src/routes/date-cascade.js` lines 352-410 (leaf cascade → runParentSubtask → merge), line 180 (`_reportingMsg` fallback), lines 432-483 (patch + log).
- `test/routes/date-cascade.test.js` lines 14-15, 53-54 (vi.hoisted + vi.mock for runParentSubtask).
- `test/routes/dep-edit.test.js` existing structure for `vi.hoisted`, `happyParsed`, `makeReqRes`, `await new Promise((r) => setImmediate(r))`.
- `test/engine/parent-subtask.test.js:116-142` ("rolls up affected parents from movedTaskIds/movedTaskMap") — direct contract reference.

**Test scenarios:**
- **Happy path (route, mocked helpers).** Webhook for a leaf with a parent → `tightenSeedAndDownstream` returns 2 leaf updates with non-empty `movedTaskMap` → `runParentSubtask` returns 1 parent update with `_isRollUp: true` and a `_reportingMsg`. Assert: `runParentSubtask` was called with `parentMode: null`, `parentTaskId: null`, `movedTaskIds`/`movedTaskMap` from the cascade result, `tasks: allTasks`. Assert: `patchPages` payload contains all 3 rows (2 leaves + 1 parent). Assert: Activity Log details include `rollUpCount: 1`, `rollUpTaskIds: ['parent-1']`, `movement.updatedCount: 3`. Assert: success summary contains `parent roll-up`. Tag: `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP`.
- **No-parent leaf.** Webhook for a leaf with no `parentId` → `runParentSubtask` returns `{ updates: [] }`. Assert: patch payload contains only leaf rows; no parent row; `rollUpCount: 0`; success summary does NOT contain `parent roll-up`. Tag: `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-NONE`.
- **No-op subcase.** `tightenSeedAndDownstream` returns `subcase: 'no-op'` → `runParentSubtask` is never called (silent no-op preserved). Assert: `runParentSubtask` mock has zero calls; no Activity Log entry. Tag: `BEH-DEP-EDIT-ROUTE-NOOP-SKIPS-ROLLUP`.
- **Activity Log shape.** Assert: `details.movement` stays a sub-object with `updatedCount` reading the merged total; `details.rollUpCount` and `details.rollUpTaskIds` are top-level scalars; existing forensics fields (`subcase`, `downstreamCount`, `cycleDetected`) remain top-level. Tag: `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-LOG`.
- **Failure-path context preservation.** When `patchPages` throws after `tightenSeedAndDownstream` and `runParentSubtask` have computed updates, the catch's `logTerminalEvent` includes both `result` (existing) and `parentResult` (new). Assert: failure row's `details.rollUpCount` reflects what was computed, not 0. Tag: `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-FAILURE-CONTEXT`.
- **Critical scenario (engine integration test, real helpers).** Manually-inserted task set fixture: TLF parent + 4 subtasks in a tight intra-set chain (Draft v1 TLF → Internal Review → Client Review → TLF Delivery), plus an external Data Delivery task placed after the TLF window. Wire Data Delivery as `Blocked by` on Draft v1 TLF. Run `tightenSeedAndDownstream` then `runParentSubtask` with `parentMode: null` against the original `tasks` array (not a post-cascade mutated copy — `runParentSubtask` re-applies `movedTaskMap` itself at parent-subtask.js:83-90). Assert: subtasks shift forward by the violation delta; parent TLF rolls up to span `min(child starts) / max(child ends)` — and the new parent dates differ from the original. **This is the only test that exercises the seed-with-parentId case end-to-end with real helpers.** Reproduces Meg Apr 30 exactly. Tag: `BEH-DEP-EDIT-PARENT-ROLLUP-INTEGRATION`.
- **Direct unit test (parent-subtask.test.js, real helper).** Closes the gap that `parent-subtask.test.js:116` left — that test uses a synthetic `sourceTaskId` not in tasks. Add a new test that puts the source task IN the tasks list with a `parentId`, includes the source in `movedTaskIds` and `movedTaskMap` (mirroring what `tightenSeedAndDownstream` produces for dep-edit's seed), passes `parentMode: null` and `parentTaskId: null`, and asserts the source's parent appears in `result.updates` with `_isRollUp: true` and the expected min/max dates. This is cheaper, faster, and more focused than the integration test for catching future regressions of line 311's guard semantics. Tag: `BEH-PARENT-SUBTASK-NULL-MODE-SEED-IN-TASKS`.
- **Edge case (engine integration test).** Top-level leaves (no `parentId`) with a violation. `runParentSubtask` with `parentMode: null` emits zero parent updates. Tag: `BEH-DEP-EDIT-PARENT-ROLLUP-NO-PARENT`.

**Verification:**
- Targeted suites pass: `npm test -- --run test/routes/dep-edit.test.js test/engine/dep-edit-cascade.test.js test/engine/parent-subtask.test.js`.
- Full suite passes: `npm test`.
- Traceability passes: `npm run test:traceability` (with new BEH-* tags landed in U2).

---

- U2. **Update behavior docs and register new BEH-* tags**

**Goal:** Bring `docs/CASCADE-RULEBOOK.md`, `docs/ENGINE-BEHAVIOR-REFERENCE.md`, and `docs/BEHAVIOR-TAGS.md` into agreement with U1's code so the next operator finds documented behavior matches what the engine does.

**Requirements:** R6

**Dependencies:** U1

**Files:**
- Modify: `docs/CASCADE-RULEBOOK.md`
- Modify: `docs/ENGINE-BEHAVIOR-REFERENCE.md`
- Modify: `docs/BEHAVIOR-TAGS.md`

**Approach:**
- **CASCADE-RULEBOOK.md §3.7 ("Dep-Edit"):** add a new step 3 ("Roll up parents via `runParentSubtask({ ..., parentMode: null, movedTaskIds, movedTaskMap, tasks })`") between the existing seed-tighten step and the apply-or-skip step. Renumber the apply-or-skip step from 3 → 4. Update its prose to mention merged leaf+parent updates and the new `details.rollUpCount` / `details.rollUpTaskIds` Activity Log fields.
- **CASCADE-RULEBOOK.md §5.4 ("Cascade Roll-Up"):** add a paragraph clarifying that both date-cascade and dep-edit invoke this pass. date-cascade passes a `parentMode` from `classify()` (case-a, case-b, or null); dep-edit always passes `parentMode = null` because its seed is guaranteed to be a leaf. Both reach the same Cascade Roll-Up section because the gate is `movedTaskIds.length > 0`, not `parentMode`. Note the Meg Apr 30 origin so a future reader sees why this paragraph exists.
- **CASCADE-RULEBOOK.md §5.4 (frozen-parent caveat):** add a one-line note that the cascade-roll-up pass does NOT skip frozen parents — a Done/N-A parent whose children moved will have its `Dates`/`Reference` rewritten by the rollup. This is pre-existing engine behavior (parent-subtask.js:333-350 has no `isFrozen(parent)` check), shared by both routes; this plan does not change it. If product later decides Done parents should be immutable, that's a cross-route change for both date-cascade and dep-edit.
- **ENGINE-BEHAVIOR-REFERENCE.md §11 ("Manual Task Support — Dep-edit cascade subsection"):** extend the engine-side handler chain to `dep-edit.js → cascade.js#tightenSeedAndDownstream → parent-subtask.js#runParentSubtask`. Add a sentence to the Behavior paragraph: "After leaf cascading, `runParentSubtask({ ..., parentMode: null })` rolls up each affected parent's dates (CASCADE-RULEBOOK §5.4). Mirrors date-cascade's pipeline so manually-inserted task sets stay aligned after a Blocked-by edit on a leaf."
- **ENGINE-BEHAVIOR-REFERENCE.md Changelog:** add a 2026-04-30 entry summarizing the fix, the parentMode=null choice, the Activity Log additions, and the Meg origin. Cross-reference the rulebook sections updated.
- **BEHAVIOR-TAGS.md §5 ("Dep-Edit Cascade") under the Route subsection:** add the new BEH-* IDs introduced in U1 with one-line descriptions: `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP`, `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-NONE`, `BEH-DEP-EDIT-ROUTE-NOOP-SKIPS-ROLLUP`, `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-LOG`, `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-FAILURE-CONTEXT`, `BEH-DEP-EDIT-PARENT-ROLLUP-INTEGRATION`, `BEH-DEP-EDIT-PARENT-ROLLUP-NO-PARENT`.
- **BEHAVIOR-TAGS.md §3 ("Task And Parent Rules"):** add `BEH-PARENT-SUBTASK-NULL-MODE-SEED-IN-TASKS` — `runParentSubtask` with `parentMode: null` correctly rolls up the seed task's parent when the seed is itself in `tasks` and `movedTaskMap` (the dep-edit case, distinct from the synthetic-source precedent at `parent-subtask.test.js:116`).

**Patterns to follow:**
- 2026-04-27 dep-edit changelog entry in ENGINE-BEHAVIOR-REFERENCE.md as a tone/length reference.
- BEHAVIOR-TAGS.md §5 existing one-line description style for dep-edit route tags.
- CASCADE-RULEBOOK.md numbered-step style in §3.7 for the new step 3 insertion.

**Test scenarios:**
- Test expectation: none — pure documentation. Traceability is enforced separately by `npm run test:traceability`, which validates BEHAVIOR-TAGS.md ↔ test-file plain-text matching. U1's tests carry the new BEH-* IDs; U2 registers them.

**Verification:**
- `npm run test:traceability` passes after both U1 and U2 land — no orphan tags (in tests but not in docs) and no missing tags (in docs but not in tests).
- Manual: re-read CASCADE-RULEBOOK §3.7 and §5.4 plus ENGINE-BEHAVIOR-REFERENCE §11; confirm an operator coming in cold can derive the U1 code shape from the docs alone.

---

## System-Wide Impact

- **Interaction graph:** `runParentSubtask` is now invoked from two routes (date-cascade.js, dep-edit.js). The helper is unchanged, so all existing callers stay correct. The new dep-edit invocation passes `parentMode: null` — a path already covered by `parent-subtask.test.js:116`.
- **Error propagation:** `parentResult` is hoisted alongside `result` so the catch block can include it in the failure Activity Log row. Without this, failure rows from a `patchPages` throw lose the rollup context computed before the throw.
- **State lifecycle risks:** None new. `runParentSubtask` mutates an internal `taskById`; it does not write to Notion. Only the merged `patchPayload` reaches `notionClient.patchPages`. The existing per-study FIFO + 5s debounce in `cascadeQueue` continues to serialize dep-edit work alongside date-cascade work for the same study.
- **API surface parity:** Route → engine helper → patch → Activity Log → study comment surface is identical between date-cascade and dep-edit after this fix. Both routes now produce parent rollups with the same shape.
- **Integration coverage:** The U1 engine integration test (Meg Apr 30 fixture) is the cross-layer scenario unit tests alone won't prove. Route-level mocked tests verify orchestration shape; engine integration test verifies real helpers compose correctly.
- **Unchanged invariants:**
  - BL-H5g parent-edge stripping (parents stay invisible to the cascade graph) — unchanged.
  - Parent-task seed exclusion (`hasSubtasks` short-circuit at dep-edit.js:133) — unchanged.
  - Bot-echo guard (`editedByBot` short-circuit at dep-edit.js:115) — unchanged.
  - Frozen-task semantics for **subtasks** (frozen seed/blocker/downstream don't move) — unchanged; `runParentSubtask`'s subtask-shift paths already check `isFrozen`. **Note for completeness:** the cascade-roll-up pass does NOT skip frozen *parents* — a Done parent whose children moved gets its `Dates` rewritten by the rollup. This is pre-existing behavior shared by both routes (parent-subtask.js:333-350 has no `isFrozen(parent)` check); this plan does not change it.
  - Silent no-op path (already-tight chains, no effective blockers) — unchanged. The new rollup call is gated behind the leaf cascade producing updates.
  - `runParentSubtask` signature, semantics for case-a/case-b, and existing tests — unchanged.
  - date-cascade pipeline — unchanged.
  - Notion automation (filters, watched property, trigger) — unchanged. The parent rollup writes `Dates` on a parent task; the Date Cascade Notion automation watches `Dates` and is filtered by `Last edited by ≠ <bot integration users>`. This is the same situation that exists today for date-cascade's own parent-rollup writes — not a net-new write surface.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **Activity Log shape regresses the f337a06 fix** (empty bullets when `detailLines()` can't find expected sub-objects). | Keep `movement`, `sourceDates`, `crossChain`, `error` nested. Bump `movement.updatedCount` to merged total — `detailLines()` already reads it. New rollup fields are top-level forensics scalars (matching existing `subcase`/`downstreamCount`); not adding new sub-objects that detailLines doesn't read. U1 test scenario explicitly asserts the shape. |
| **Failure-path rollup context is lost** when `patchPages` throws after `runParentSubtask` computes updates. | Hoist `parentResult` alongside `result` outside the `try`. Thread it into the catch's `logTerminalEvent`. U1 test scenario covers this. |
| **Multi-level rollup gap** — grandparent of a moved subtask doesn't roll up. | Out of scope (D3); same limitation as date-cascade. Document in "Deferred to Follow-Up Work". If a Meg report surfaces it, fix both routes simultaneously in a follow-up plan. |
| **`movement.movedTaskIds` semantic ambiguity** if it includes parent rollup IDs. | Decided in Open Questions: `movement.movedTaskIds` stays as cascade-graph leaves only; parent IDs go into the new `rollUpTaskIds` field. Preserves the historical meaning of the field for any downstream consumer. |
| **Test suite drift** — fixture builders or behavior-tag conventions change between U1 plan-time and ce:work execution. | Plan references the canonical builders (`task()` from `test/fixtures/cascade-tasks.js`) and the existing `vi.hoisted` mocking pattern by file path + line. ce:work re-reads them before writing tests. |
| **Commit/PR text accidentally references the closed superseded PR #87.** | ce:work writes a fresh commit message and PR description referencing Meg's Slack thread + this plan. PR #87 is closed-superseded; do not link or quote from it. |

---

## Documentation / Operational Notes

- **Pulse log:** ce:work writes the next available ordinal in `engagements/picnic-health/pulse-log/04.30/`. Capture actual changes, verification trail (test counts, traceability), and the post-deploy smoke-test result.
- **Post-deploy smoke test:** On a sandbox study, replicate Meg's repro: button-add a TLF task set, button-add a Repeat Delivery, wire the TLF's first leaf subtask as `Blocked by` the Repeat Delivery's leaf. Confirm in Notion that the parent TLF rolls up to span the now-shifted subtasks. Confirm Activity Log row has `details.rollUpCount: 1` and the parent's Automation Reporting message is the roll-up-flavored phrasing.
- **Notion-automation re-entry verification (post-deploy):** When the rollup writes `Dates` on the parent, the Date Cascade Notion automation watches that property. The `Last edited by ≠ <bot integration users>` filter is the line of defense (same situation that already exists for date-cascade's own parent-rollup writes — not net-new risk). After the smoke test, verify no spurious Date Cascade Activity Log row appeared for the parent task. If one did, the bot-edit filter is misconfigured and the fix is the same for both routes.
- **Rollback plan:** revert the merge commit. The fix is additive — reverting restores the prior (broken) behavior without leaving stale data, since the new rollup pass only emits writes when the leaf cascade also emits writes, and parent dates simply revert to whatever they were before the merge.

---

## Sources & References

- **Meg Slack thread (origin):** PicnicHealth #cascade-engine, 2026-04-30 morning — Meg → Tem on parent task not following shifted subtasks after a button-added task set was wired with a dependency.
- **Pulse log (investigation context, not authoritative):** `engagements/picnic-health/pulse-log/04.30/005-dep-edit-parent-rollup-fix.md` — written for the closed PR #87; superseded by this plan.
- **Closed PR (superseded):** #87 — closed deliberately to restart under the proper plan/review/work/review flow. Informational only; this plan stands alone, no claims load-bear on the closed-PR diff.
- **Prior dep-edit plan:** `docs/plans/2026-04-27-001-feat-dep-edit-cascade-plan.md` — established the dep-edit cascade route, parent-task exclusion (D6 / BL-H5g), and the `tightenSeedAndDownstream` helper. Did not address parent rollup.
- **Pattern reference:** `src/routes/date-cascade.js` lines 352-410, 432-483 — leaf cascade → parent rollup → merge → patch.
- **Helper contract:** `src/engine/parent-subtask.js` lines 53-90 (entry + `movedTaskMap` pre-application), 306-352 (cascade-roll-up section), 354-381 (output shape).
- **Test precedent for `parentMode: null`:** `test/engine/parent-subtask.test.js:116-142` (`'rolls up affected parents from movedTaskIds/movedTaskMap'`).
- **Activity Log shape conventions:** `src/services/activity-log.js` lines 24-74 (`detailLines()`).
- **Behavior-tag mechanism:** `docs/BEHAVIOR-TAGS.md` + `scripts/check-behavior-traceability.js`.
