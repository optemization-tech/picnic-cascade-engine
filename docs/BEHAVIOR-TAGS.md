# BEHAVIOR-TAGS

This document is the canonical registry of `BEH-*` behavior IDs. Every ID listed here must be covered by at least one tagged test — the traceability check in `scripts/check-behavior-traceability.js` enforces this on every run.

For the behavior contract itself (governance matrix, cross-chain algorithm, changelog, webhook auth, graceful shutdown, startup sweep), see [`ENGINE-BEHAVIOR-REFERENCE.md`](./ENGINE-BEHAVIOR-REFERENCE.md). For implementation-level pseudocode and `file:line` references, see [`CASCADE-RULEBOOK.md`](./CASCADE-RULEBOOK.md).

## 1) Core Cascade Modes

- `BEH-MODE-PUSH-RIGHT`: End-only-right (`startDelta == 0`, `endDelta > 0`) pushes downstream dependents right only when their current start violates `nextBusinessDay(latest blocker end)`. Upstream tasks do not move.
- `BEH-MODE-START-LEFT`: Start-only-left (`startDelta < 0`, `endDelta == 0`) pulls upstream blockers left only on conflict. Downstream tasks do not move.
- `BEH-MODE-PULL-LEFT`: End-only-left (`startDelta == 0`, `endDelta < 0`) pulls downstream dependents left by the source's negative business-day delta, clamped against the latest non-frozen blocker. It does not move unrelated blocker chains.
- `BEH-MODE-PULL-RIGHT`: Start-only-right (`startDelta > 0`, `endDelta == 0`) pulls upstream blockers right by the same business-day delta, preserving upstream slack.
- `BEH-MODE-DRAG-LEFT`: Drag-left (`startDelta < 0`, `endDelta < 0`) shifts the whole dependency-connected graph left by the same business-day delta, excluding frozen tasks and stripped parent-level dependency edges.
- `BEH-MODE-DRAG-RIGHT`: Drag-right (`startDelta > 0`, `endDelta > 0`) shifts the whole dependency-connected graph right by the same business-day delta, with the same exclusions.

## 2) Cascade Graph Rules

- `BEH-ENDLEFT-ALL-DOWNSTREAM`: End-only-left can move multiple downstream tasks in one pass; each reachable downstream task moves left by up to the source delta and is clamped by its latest blocker.
- `BEH-PULLRIGHT-ALL-UPSTREAM`: Start-only-right shifts all reachable upstream blockers by the same business-day delta, even when there were gaps.
- `BEH-DRAG-LEFT-FANOUT`: Drag-left translates every reachable branch in a dependency fan-out by the same delta.
- `BEH-CROSSCHAIN-PROPAGATION`: Stationary cross-chain blockers clamp end-only-left movement; drag modes move the connected cross-chain graph instead of using a separate blocker-moving heuristic.
- `BEH-CROSSCHAIN-FIXEDPOINT`: A single cascade execution should converge to the mode-specific fixed point for the edited graph, or report unresolved residue after the safety cap.
- `BEH-SAFETY-CAP`: The iterative upstream pull for `start-left` has a hard safety cap.
- `BEH-RESIDUE-REPORTING`: If the safety cap is hit, unresolved residue is surfaced in diagnostics.
- `BEH-MONOTONIC-SAFETY`: Directional passes must move tasks monotonically in the intended direction within one execution.

## 3) Task And Parent Rules

- `BEH-COMPLETE-FREEZE`: Tasks with status `Done` or `N/A` never move during cascades and are ignored as blocking constraints.
- `BEH-BL-H5G`: Parent tasks do not participate in dependency-driven cascading; parent-level dependency edges are stripped before the engine runs.
- `BEH-PARENT-DIRECT-EDIT-BLOCK`: A top-level parent task cannot be directly date-edited; the classifier rejects that edit and the route reverts the parent back to its reference dates.
- `BEH-PARENT-SUBTASK-NULL-MODE-SEED-IN-TASKS`: `runParentSubtask` with `parentMode: null` correctly rolls up the seed task's parent when the seed is itself in `tasks` and `movedTaskMap` (the dep-edit case, distinct from the synthetic-source precedent).

## 4) Route And Automation Rules

- `BEH-GUARD-FREEZE`: Route guards skip cascades triggered from frozen tasks.
- `BEH-GUARD-IMPORT-MODE`: Route guards skip cascades while Import Mode is active.
- `BEH-DEBOUNCE-ECHO`: The cascade queue treats bot echo webhooks as debounced noise instead of user edits.
- `BEH-AUTOMATION-REPORTING`: Success, failure, and no-action outcomes are surfaced consistently in automation reporting and activity logs.

## 5) Dep-Edit Cascade

Engine helper (`tightenSeedAndDownstream`):
- `BEH-DEP-EDIT-VIOLATION`: When the seed's blocker ends after the seed's current start, the seed pushes right to `nextBusinessDay(blocker.end)` with duration preserved.
- `BEH-DEP-EDIT-GAP`: When the seed's blocker ends well before the seed's current start, the seed pulls left to `nextBusinessDay(blocker.end)` with duration preserved.
- `BEH-DEP-EDIT-CHAIN-WIDE`: After the seed is tightened, the full reachable downstream chain re-validates against the new positions via `tightenDownstreamFromSeed`.
- `BEH-DEP-EDIT-FAN-IN`: When the seed has multiple blockers, `seed.newStart` is computed from the maximum non-frozen blocker end.
- `BEH-DEP-EDIT-NOOP-ALREADY-TIGHT`: When `nextBusinessDay(max blocker.end) === seed.start`, the helper returns `subcase: 'no-op'` and writes nothing.
- `BEH-DEP-EDIT-NOOP-NO-EFFECTIVE-BLOCKERS`: When the seed has no blockers (or all blockers are frozen), the helper returns `subcase: 'no-op'`.
- `BEH-DEP-EDIT-NOOP-SEED-FROZEN`: A frozen seed never moves; the helper returns `subcase: 'no-op'`.
- `BEH-DEP-EDIT-NOOP-SEED-NOT-FOUND`: A seed task ID not present in the supplied `tasks` list returns `subcase: 'no-op'`.
- `BEH-DEP-EDIT-NOOP-SEED-NO-DATES`: A seed with `start: null` or `end: null` returns `subcase: 'no-op'` with `reason: 'seed-no-dates'`.
- `BEH-DEP-EDIT-MIXED-BLOCKERS-STALE`: When the seed's `blockedByIds` contains a mix of valid and stale (non-existent) task IDs, only the valid blockers contribute to `max(blocker.end)`.
- `BEH-DEP-EDIT-MIXED-BLOCKERS-NO-END`: When some blockers have no `end` date, they are excluded from the `max(blocker.end)` reduction; valid blockers still contribute.
- `BEH-DEP-EDIT-FROZEN-BLOCKER-EXCLUDED`: Frozen blockers are excluded from the `max(blocker.end)` computation.
- `BEH-DEP-EDIT-FROZEN-DOWNSTREAM-SKIPPED`: Frozen downstream tasks are skipped during chain-wide tightening.
- `BEH-DEP-EDIT-PARENT-SEED-EXCLUDED`: Parent tasks (with non-empty `Subtask(s)`) refuse to act as cascade triggers; the helper short-circuits with `reason: 'parent-task'`.
- `BEH-DEP-EDIT-PARENT-BLOCKER-STRIPPED`: Parent-task blockers are stripped from leaf seeds before the cascade runs (mirrors `runCascade`'s BL-H5g invariant).
- `BEH-DEP-EDIT-CYCLE-DIAGNOSTICS`: When the dependency graph contains a cycle, the helper returns gracefully with `diagnostics.cycleDetected = true`.
- `BEH-DEP-EDIT-MEG-APR24-T1`: Reproduces the Apr 24 worked example: Reiterate Draft (7/14–7/27) wired as blocker for IIR (start 7/14) → IIR snaps to 7/28.
- `BEH-DEP-EDIT-FULL-CHAIN-VIOLATION`: On the realistic 200-task fixture, an artificially extended blocker followed by `tightenSeedAndDownstream` leaves the seed's moved subtree gap-clean.
- `BEH-DEP-EDIT-FULL-CHAIN-GAP`: On the realistic fixture, an artificially shortened blocker followed by `tightenSeedAndDownstream` leaves the seed's moved subtree gap-clean (parallel siblings out of scope, R-4).
- `BEH-DEP-EDIT-FULL-CHAIN-FROZEN-DOWNSTREAM`: Frozen downstream tasks remain in the original positions even when reachable from the seed.
- `BEH-DEP-EDIT-FULL-CHAIN-NON-REACHABLE-UNCHANGED`: Tasks unreachable from the seed via `blockingIds` BFS are unchanged.

Route (`processDepEdit` in `src/routes/dep-edit.js`):
- `BEH-DEP-EDIT-ROUTE-VIOLATION`: Webhook → cascade runs → `patchPages` writes the seed and downstream → Activity Log records `cascadeMode: 'dep-edit'` with `details.subcase: 'violation'`.
- `BEH-DEP-EDIT-ROUTE-GAP`: Same flow as violation but `details.subcase: 'gap'`.
- `BEH-DEP-EDIT-ROUTE-NOOP-SILENT`: When the helper returns `subcase: 'no-op'`, the route writes nothing and skips Activity Log entirely (avoids noise on idempotent triggers).
- `BEH-DEP-EDIT-ROUTE-EDITED-BY-BOT`: `parsed.editedByBot === true` short-circuits before any Notion read or Activity Log write (defense-in-depth alongside Notion automation filter and `cascadeQueue` echo guard).
- `BEH-DEP-EDIT-ROUTE-NO-DATES`: `parsed.hasDates === false` short-circuits.
- `BEH-DEP-EDIT-ROUTE-PARENT-TASK`: `parsed.hasSubtasks === true` short-circuits (parent-task exclusion at the route layer).
- `BEH-DEP-EDIT-ROUTE-MISSING-STUDY`: Missing `studyId` short-circuits.
- `BEH-DEP-EDIT-ROUTE-EMPTY-STUDY`: `queryStudyTasks` returning empty (stale `studyId` or racing deletion) short-circuits before calling the helper.
- `BEH-DEP-EDIT-ROUTE-PARSE-SKIP`: `parseWebhookPayload` returning `skip: true` (malformed payload — no page id, no properties) short-circuits before any guard chain.
- `BEH-DEP-EDIT-ROUTE-ERROR`: A `patchPages` failure logs an error to Activity Log and posts a study comment.
- `BEH-DEP-EDIT-ROUTE-FAILURE-PRESERVES-CONTEXT`: When `patchPages` throws after `tightenSeedAndDownstream` has computed updates, the failure Activity Log row preserves the cascade context (`subcase`, `movement.updatedCount`, `movedTaskIds`) so operators can diagnose what the cascade attempted to write.
- `BEH-DEP-EDIT-ROUTE-QUERY-REJECT`: A `queryStudyTasks` rejection (Notion 5xx, network timeout) logs an error to Activity Log and posts a study comment without invoking the helper or attempting writes.
- `BEH-DEP-EDIT-ROUTE-200-IMMEDIATE`: The route replies `200 {ok: true}` before any async work begins.
- `BEH-DEP-EDIT-ROUTE-ENQUEUE`: The route enqueues via `cascadeQueue.enqueue(payload, parseFn, processFn)` — inheriting 5s debounce + per-study FIFO.
- `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP`: After `tightenSeedAndDownstream`, the route invokes `runParentSubtask({ ..., parentMode: null, movedTaskIds, movedTaskMap })` and merges parent roll-up updates into the patch payload (CASCADE-RULEBOOK §5.4).
- `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-LOG`: Activity Log details surface top-level `rollUpCount` and `rollUpTaskIds`; `movement.updatedCount` reflects merged leaf+parent total; the success summary appends `, N parent roll-up(s)` when parents moved.
- `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-NONE`: When no moved subtask has a parent, no parent rows appear in the patch payload, `rollUpCount === 0`, and the success summary does not contain a "parent roll-up" phrase.
- `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-FAILURE-CONTEXT`: When `patchPages` throws after `tightenSeedAndDownstream` and `runParentSubtask` have computed updates, the failure-path Activity Log row preserves rollup context (`rollUpCount`, `rollUpTaskIds`) alongside the cascade context.
- `BEH-DEP-EDIT-ROUTE-PARENT-ROLLUP-HELPER-THROWS`: When `runParentSubtask` itself throws (e.g., malformed taskById), `parentResult` stays null but the failure-path Activity Log row still preserves the leaf cascade context (`subcase`, `movement.movedTaskIds`, `movement.updatedCount: leaf only`). `patchPages` is not called.
- `BEH-DEP-EDIT-ROUTE-NOOP-SKIPS-ROLLUP`: When `subcase === 'no-op'`, the route returns silently before invoking `runParentSubtask` (preserves the no-Activity-Log-noise property and avoids redundant work).
- `BEH-DEP-EDIT-PARENT-ROLLUP-INTEGRATION`: End-to-end with real `tightenSeedAndDownstream` + `runParentSubtask`: a manually-inserted task-set parent rolls up to span its now-shifted subtasks after a Blocked-by edit on a leaf (Meg Apr 30 repro).
- `BEH-DEP-EDIT-PARENT-ROLLUP-NO-PARENT`: Top-level leaves (no `parentId`) emit no parent updates from the cascade-roll-up pass.

## 6) Status Roll-Up

Engine helper (`computeStatusRollup`):
- `BEH-STATUS-ROLLUP-PARTIAL-DONE`: When at least one child status is `Done` (or `N/A`) but not all children are complete and none are `In Progress`, the helper returns `In Progress` instead of `Not Started`. Both route branches in `src/routes/status-rollup.js` (parent-direct snap-back and subtask-triggered roll-up) inherit this rule via the shared helper.

## 7) Current Known Gaps

- V1 parent `case-a` now drags connected dependencies with shifted subtasks, but it still infers a single delta from the parent envelope. It does not yet classify parent edits into distinct start-left, end-left, and drag modes.
- V2 still has no `parentMode`. Its parent fan-out recomputes direct subtask offsets from the moved parent's start date and does not drag dependency-connected tasks beyond those subtasks.
