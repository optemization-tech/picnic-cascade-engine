---
title: "fix: Meg 2026-04-21 feedback batch — parent status/date handling, cascade UX, add-task-set fallback"
type: fix
status: active
date: 2026-04-22
deepened: 2026-04-22
origin: "Notion page Response to Meg's Report 4/21 (3492386760c280b59159e785ee80cc0f)"
---

# fix: Meg 2026-04-21 feedback batch

## Overview

Meg's live testing on 2026-04-21 after PR #66 (γ cascade fix) shipped surfaced five issues. This plan implements the fixes Meg + Tem aligned on over 2026-04-22 via the consolidated Notion response page. Five units: two bug fixes (parent STATUS snap-back, parent DATE revert when frozen), one UX improvement (cascade queued pre-state), one safety net (add-task-set fallback when seed group deleted), and docs. Pre-production — no data migration or backward-compat concerns.

## Problem Frame

Five items Meg reported on 2026-04-21 Slack thread, consolidated in the Notion response page with Meg's answers captured as inline comments on 2026-04-22:

1. **Parent STATUS to DONE (Bug 1)** — PM manually sets parent Status=Done while subtasks incomplete. Engine silently accepts. No Activity Log entry. Status-rollup route short-circuits on parent-direct edits.
2. **Parent DATE edits swallowed when frozen (Bug 2)** — PM edits a Done parent's dates. Engine's `isFrozen` guard in date-cascade route fires before classify, skipping the Error 1 revert-and-warn flow that normally runs for top-level parent date edits.
3. **Repeat Delivery dates still wrong after Blueprint fix (Bug 3)** — The `latestDates` override copies the previous in-study delivery's dates. Meg's Blueprint fix doesn't propagate because the override reads from the study's previous delivery, not Blueprint offsets. Meg's design intent (confirmed 2026-04-22): dates inherit from previous task set in the study; fall back to Blueprint offsets only if no previous task set exists. **Matches current engine behavior — no code change required for Bug 3.** Unit 5 documents this explicitly so future readers understand why Blueprint offset fixes don't retroactively fix existing deliveries.
4. **"Cascade started" flash (Bug 4)** — The 5s debounce means "Cascade started" only appears right before "complete" on short cascades. PMs see nothing for seconds after clicking, then a flicker.
5. **Deleted first TLF group → button fallback (Bug 5)** — PM deletes the seed TLF group and presses an Add TLF button. Currently the button may error or produce bad output because the button's numbering and filter logic depend on an existing group. Needs graceful fallback to Blueprint defaults (first-instance creation like inception).

## Requirements Trace

- **R1** — Parent STATUS direct edits: engine reconciles the parent's status to the computed subtask rollup in both directions (silently, with Activity Log audit entry). Matches Meg's comment "1a + 1b".
- **R2** — Parent DATE direct edits on frozen parents: engine reverts the edit and posts the same Automation Reporting warning that non-frozen parents already get, regardless of Status=Done/N-A.
- **R3** — Cascade click feedback: PM sees immediate "Cascade queued" state on click, transitioning to "Cascade started" when debounce fires, then "Cascade complete."
- **R4** — Add Task Set buttons gracefully fall back to Blueprint-offset date computation when no previous corresponding task set exists in the study. When a previous task set exists, dates inherit from that previous task set (current `latestDates` behavior).
- **R5** — Behavior documentation: update `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` to describe the new parent-direct status handling, the frozen-parent date revert path, the cascade-queued state, and the add-task-set fallback rules.

## Scope Boundaries

- **Not in scope**: repairing Meg Test April 21's existing broken D#2/#3/#4 dates (pre-production test data; Tem deferred).
- **Not in scope**: adding Notion @-mentions or page comments for status snap-back (Meg explicitly chose silent correction + Activity Log audit).
- **Not in scope**: changing Repeat Delivery's inherit-from-previous behavior (Meg confirmed current design is correct).
- **Not in scope**: middle-parent date edit handling (Sites Planning is top-level; case-a middle-parent path remains unchanged). Middle-parent edits already fire case-a subtask shift when non-frozen.
- **Not in scope**: undo-cascade, inception, or status-rollup parent-direct middle-parent cascading to grandparents.

## Context & Research

### Relevant Code and Patterns

- `engine/src/routes/status-rollup.js` — current route short-circuits on `!changedTask.parentId || hasSubtasks` (lines 31-33). Route needs a new branch for parent-direct edits.
- `engine/src/engine/status-rollup.js` — pure `computeStatusRollup(siblings)` already computes Done/In Progress/Not Started correctly. Reusable for parent-direct snap-back.
- `engine/src/routes/date-cascade.js` — `isFrozen` check at lines 202-211 fires before classify. `applyError1SideEffects` at lines 133-164 is the revert-and-warn flow that needs to run for frozen parents.
- `engine/src/engine/classify.js` lines 65-83 — Error 1 guard fires on `hasSubtasksFromGraph && !hasParent && (startDelta !== 0 || endDelta !== 0)`.
- `engine/src/routes/add-task-set.js` — `latestDates` override (lines 390-457) for repeat-delivery; `resolveTaskSetNumbers` (lines 62-82) for TLF numbering. Falls back to Blueprint offsets via `buildTaskBody` in `create-tasks.js` when no override present.
- `engine/src/services/cascade-queue.js` — debounce + per-study FIFO queue. Webhook handler calls `cascadeQueue.enqueue(req.body, parseWebhookPayload, processDateCascade)` in `handleDateCascade` (date-cascade.js:478-481).
- `engine/src/services/activity-log.js` — `ActivityLogService.logTerminalEvent` is the existing audit entry point used by status-rollup and date-cascade.
- `engine/src/notion/clients.js` — `commentClient` vs `cascadeClient` token pools; status-rollup uses `commentClient`.

### Existing Test Patterns

- `engine/test/routes/status-rollup-route.test.js` — already has vitest + mocked NotionClient pattern; mocks `parseWebhookPayload`, `computeStatusRollup`, `normalizeTask`. New tests follow the same pattern.
- `engine/test/routes/date-cascade.test.js` — frozen-status and Error 1 revert scenarios exist; new tests extend those.
- `engine/test/routes/add-task-set.test.js` — add-task-set scenarios with blueprint fixture + study fixture.
- `engine/test/engine/status-rollup.test.js` — pure-function tests for `computeStatusRollup`; extend if the logic signature changes.

### Institutional Learnings

- `engine/src/routes/date-cascade.js` `applyError1SideEffects` already does the revert + Automation Reporting warning + study Import Mode reset. Reuse it for the frozen-parent case instead of duplicating.
- The Automation Reporting field is an inline rich_text property on the task — distinct from Notion page comments. Silent snap-back means skipping both.
- `ActivityLogService.logTerminalEvent` supports `cascadeMode: 'status-rollup'` already; new parent-direct events can reuse the same workflow tag with a `triggerType: 'Parent-direct edit'` or similar distinction in details.

### External References

- None needed. This is a maintenance batch on existing code.

## Key Technical Decisions

- **Decision**: Both-direction status reconciliation in status-rollup, with `editedByBot` skip at the top of the new branch.
  - **Rationale**: Meg's comment: "if some subtasks are not started or in progress, it should reset... the status of the parent should become done when all subtasks are done. otherwise it should revert." She wants the parent to always mirror the computed rollup. The `editedByBot` skip (matching cascade-queue.js:45 pattern) prevents the new branch from re-entering on every engine-patched parent's echo webhook — without it, each parent-direct edit produces at least 2 webhooks × 4 Notion reads each.
  - **Implementation**: In status-rollup route, when `parsed.editedByBot === true`, return early in the parent-direct branch. Otherwise when `hasSubtasks` is true, compute rollup from the edited task's own children (not siblings) and patch if mismatched. Existing subtask → parent rollup path (for leaves) stays intact. If children query returns empty (`length === 0`) despite `hasSubtasks === true` (stale Notion relation), return early without patching — avoids silently resetting a Done parent to Not Started based on stale data.
- **Decision**: Silent correction with Activity Log audit entry. Summary string pre-committed (not deferred to implementer).
  - **Rationale**: Meg's comment "just change without notification/comment (or have it show up in the notification log). We will note in the directions that parent task should never be updated." Pre-committing the Activity Log summary string ensures parent-direct snap-back vs subtask-triggered rollup are distinguishable at a glance — both currently write `workflow: 'Status Roll-Up'` so the summary is the only discriminator.
  - **Implementation**: Use `ActivityLogService.logTerminalEvent` with `workflow: 'Status Roll-Up'`. For parent-direct: `summary: "Parent <Name> status corrected: <old> → <computed> (direct edit blocked)"`. For subtask-triggered (existing): `summary: "Parent <Name> status → <desired> (triggered by <child name>)"`. The "corrected" vs "→" phrasing and the parenthetical distinguisher let a scanner tell them apart instantly.
- **Decision**: Reorder date-cascade guards so `parseWebhookPayload` → `reportStatus("Cascade queued/started")` → `queryStudyTasks` → `classify` ALL run before `isFrozen`.
  - **Rationale**: classify requires `allTasks` (via queryStudyTasks) to determine `hasSubtasksFromGraph` and trigger Error 1. Running classify with empty allTasks breaks the unit's whole goal. So the full preamble must move.
  - **Consequence (accepted trade-off)**: Every frozen-leaf edit (previously a zero-I/O no-op log) now triggers a full study-tasks Notion query. Acceptable because frozen-leaf edits are rare, the per-study FIFO queue already bounds concurrency, and the alternative is a broken Error 1 path.
  - **Consequence (UX)**: For a frozen top-level parent date edit, the sequence will be: "Cascade queued" → (5s debounce) → "Cascade started" → revert-and-warn (red). Unit 3 must suppress the "Cascade started" reportStatus for the Error 1 classified.skip path so the user sees queued → revert-warn directly without the misleading "started" state.
  - **Implementation**: New order — `parsed.skip` → zero-delta → Import Mode → hasDates/studyId → parse + post "Cascade queued" (Unit 3) → queryStudyTasks → classify → if `classified.skip === true` (Error 1 is the only skip path today; verify by reading classify.js return shape) → `applyError1SideEffects` and return → else → `isFrozen(parsed)` check → log no_action and return → else → proceed to cascade.
- **Decision**: "Cascade queued" + all cascade lifecycle states write to the TASK's `Automation Reporting` field, not the study's.
  - **Rationale**: The study-level `Automation Reporting` field is shared across ALL cascades in a study. Multi-task cascades would overwrite each other's queued/started/complete states. Task-scoped reporting avoids the field collision and gives PMs per-task status visibility. PMs look at the task page when they edit dates; that's the natural place for the feedback.
  - **Implementation**: In both the new `handleDateCascade` queued write (Unit 3) and existing `processDateCascade` started/complete writes, switch `reportStatus` target from `studyId` to `taskId`. Error 1 warning (applyError1SideEffects) already writes to the task's Automation Reporting — unchanged. Study-level Automation Reporting reserved for add-task-set, inception, and Error 1's study-level `DIRECT_PARENT_WARNING` (the study-level red banner for the whole operation).
  - **Cascade failure state**: for cascades that fail after "Cascade started" was posted, the error path already calls `reportStatus` with 'error' level and the failure message — unchanged, but now on the task's field, persistent until the next cascade overwrites.
- **Decision**: Bug 3 requires no engine code change. Current behavior already matches Meg's design.
  - **Design (confirmed 2026-04-22)**: For additional task sets (repeat-delivery and TLF variants), dates are copied from the previous corresponding task set in the study. If no previous task set exists (deleted or never existed), dates are computed from Blueprint offsets relative to Contract Sign Date. Blueprint is fetched fresh every button press and supplies task structure (names, dependencies, relationships, properties).
  - **Rationale**: Verified in code — add-task-set.js:390-457 (`latestDates` override) + create-tasks.js:37-53 (Blueprint fallback) implement this exactly. Railway logs confirm fresh `fetchBlueprint` on every invocation (no caching).
  - **Consequence to document clearly**: Blueprint STRUCTURAL edits (new tasks, renamed tasks, changed dependencies) propagate to every button press. Blueprint OFFSET edits only propagate when no previous task set exists. PMs who want their Blueprint offset fix to apply to an existing study's next delivery must manually correct the most-recent existing delivery first, since that's what the next press inherits from.
- **Decision**: Unit 4 scope split — pristine empty-seed fallback verification is in scope; delete-mid-cascade hardening deferred.
  - **Rationale**: "Verify Blueprint-offset fallback for all button types when seed is empty" is bounded and testable. "Harden against PMs deleting seed groups while a cascade is mid-flight" is unbounded scope (race conditions, copy-blocks state, idMapping validity) and doesn't come from Meg's reported bugs.
  - **Implementation**: Pre-verify the Blueprint template's numbering convention BEFORE implementation — specifically: when `resolveNextDeliveryNumber` returns 1 (no deliveries found) and `applyDeliveryNumbering` names new tasks `Data Delivery #1`, is there a collision risk with inception's "Initial Data Delivery"? Read the Blueprint via MCP and confirm before writing the test scenarios.
  - **Deferred**: delete-mid-cascade race, copy-blocks integrity, partial-delete numbering reuse — new backlog entry to be created post-merge.
- **Decision**: Docs updates live in `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` only.
  - **Rationale**: Existing doc covers the relevant sections; CASCADE-RULEBOOK.md doesn't reference status-rollup or Error 1 behavior per grep check, so excluded from Unit 5.

## Open Questions

### Resolved During Planning

- **Should status snap-back fire both directions or only "more done"?** — Resolved: both directions. Meg's comment confirmed "1a and 1b."
- **Silent or Notion comment for snap-back?** — Resolved: silent + Activity Log. Meg's comment: "just change without notification/comment (or have it show up in the notification log)."
- **Does Bug 3 need a code change?** — Resolved: No. Current behavior matches Meg's hybrid design intent.
- **Is the isFrozen check safe to move after classify?** — Resolved (revised from earlier): classify is pure, BUT the full preamble (reportStatus + queryStudyTasks + preSnapshot) must move ahead of isFrozen because classify requires `allTasks`. Accepted consequence: frozen-leaf edits now trigger a queryStudyTasks fetch. Documented in Unit 2 approach + Key Technical Decisions.
- **Does Unit 1 need a bot-echo guard?** — Resolved: yes, `editedByBot` skip at the top of the new branch. Prevents engine-echo read amplification (without it, each parent-direct edit produces 2+ webhooks × 4 Notion reads).
- **Does Unit 1 need a stale-relation guard?** — Resolved: yes. If `hasSubtasks === true` but children query returns empty, return early without patching. Prevents silently snapping a Done parent to Not Started based on stale Notion relations.
- **What target (task vs study) for Cascade lifecycle reportStatus?** — Resolved: task. Study's Automation Reporting is shared across all cascades in a study and collides on multi-task workflows. Switch queued/started/complete/failed to task-scoped.
- **Activity Log summary string for parent-direct STATUS snap-back** — Resolved (pre-committed): `Parent <Name> status corrected: <old> → <computed> (direct edit blocked)` for parent-direct; existing subtask-triggered rollup stays as `Parent <Name> status → <desired> (triggered by <child name>)`. The "corrected" vs "→" phrasing + parenthetical distinguisher lets a scanner tell them apart in Activity Log.
- **Unit 4 scope**: resolved to pristine empty-seed verification only. Delete-mid-cascade hardening split out as a follow-up backlog entry.

### Deferred to Implementation

- **Blueprint template repeat-delivery naming convention** — Unit 4 pre-implementation verification (BLOCKING): read the Blueprint's "Data Delivery #2 Activities" parent structure and confirm whether `resolveNextDeliveryNumber === 1` produces a valid fallback name (no collision with Initial Data Delivery). Record in the plan before tests are written.
- **classify's skip trigger shape** — Unit 2 verification before coding: confirm `classified.skip === true` is uniquely the Error 1 path (classify.js:67-83). If another skip reason exists or is added later, the Error 1 branch needs a more specific discriminator (e.g., checking `classified.parentMode === null` alongside `skip === true`).
- **Exact text copy for Unit 2 revert warning on frozen vs non-frozen parents** — `applyError1SideEffects` uses the same warning string today. Implementer should confirm whether the existing "edit a subtask directly" wording reads correctly for a Done parent (a Done parent's subtasks should also be Done, so "edit a subtask" may be odd). If the wording doesn't fit, add a frozen-specific variant.

## Implementation Units

- [ ] **Unit 1: Parent STATUS snap-back in status-rollup route**

**Goal:** When a PM directly edits a parent task's Status, the engine reconciles the parent against its subtasks' computed rollup and patches silently if mismatched.

**Requirements:** R1, R5

**Dependencies:** None.

**Files:**
- Modify: `engine/src/routes/status-rollup.js`
- Test: `engine/test/routes/status-rollup-route.test.js`

**Approach:**
- Keep the existing leaf-subtask → parent rollup path intact.
- Add a new parent-direct branch that runs when `hasSubtasks === true`:
  - **First guard**: if `parsed.editedByBot === true`, return early (matches cascade-queue.js:45 pattern). Prevents read-amplification from engine-echo webhooks when the parent-direct patch itself fires a new webhook.
  - Fetch the edited task's children (filter by `Parent Task relation contains changedTask.id`) using the existing `queryDatabase` pattern from the subtask branch.
  - **Stale-relation guard**: if the children query returns an empty array despite `hasSubtasks === true` (stale Notion relation to deleted pages), return early without patching. Prevents silently snapping a Done parent to Not Started based on stale data.
  - Call `computeStatusRollup(children)` to get the desired status; normalize via `mapRollupStatusToNotion`.
  - Read the current status from `changedTaskPage.properties.Status.status.name`.
  - If `desiredStatus === currentStatus`, return early (no patch, no log).
  - Otherwise, PATCH the edited task's own status back to the computed value.
  - Log to Activity Log with `workflow: 'Status Roll-Up'` and pre-committed summary: `Parent <Name> status corrected: <old> → <computed> (direct edit blocked)`. Note the "corrected" wording + parenthetical distinguisher — the existing subtask-triggered rollup uses `Parent <Name> status → <desired> (triggered by <child name>)` so the two paths are visually distinct in Activity Log.
- Preserve Import Mode skip for both branches.
- Preserve the existing `!parentId || !studyId` guard so free-floating tasks still return early. Note: top-level parents (no parentId of their own) still need to enter the parent-direct branch — the `hasSubtasks` check comes AFTER the parent-exists check today, so reorder: check `hasSubtasks` first, then if hasSubtasks run the new branch regardless of parentId; if not hasSubtasks fall through to the existing subtask-rollup path which requires parentId.

**Patterns to follow:**
- Existing `processStatusRollup` structure: parallel fetches, computeStatusRollup, patchPage, activityLogService.logTerminalEvent.
- `mapRollupStatusToNotion` helper for 'Not Started' vs 'Not started' string normalization.
- `editedByBot` skip pattern from `engine/src/services/cascade-queue.js:45`.

**Test scenarios:**
- Happy path: Parent set to Done while some subtasks are Not Started or In Progress → engine patches parent back to computed (In Progress or Not Started); Activity Log summary uses "corrected" wording.
- Happy path: Parent set to Not Started while all subtasks are Done → engine patches parent back to Done.
- Happy path: Leaf subtask Status changes (`hasSubtasks === false`, has parentId) → existing roll-up to parent path runs unchanged; Activity Log uses "triggered by" wording.
- Edge case: Parent set to match computed rollup exactly → no patch, no log entry (early return on equality check).
- Edge case: Bot-echo webhook (`parsed.editedByBot === true`) on a parent-direct patch → early return, no re-fetch, no patch, no log. Critical: prevents the engine's own parent-status PATCH from echoing back and re-running the whole compute-and-patch flow.
- Edge case: Stale-relation — `hasSubtasks === true` but children query returns empty array → early return, no patch, no log. Prevents accidental snap to Not Started.
- Edge case: Middle parent (has both parentId AND subtasks) → parent-direct snap-back path runs on the middle parent; grandparent rollup NOT triggered (out of scope — documented limitation).
- Edge case: Import Mode enabled on study → early return, no patch, no log.
- Error path: Notion query for children fails → propagated to existing route-level catch in handleStatusRollup.

**Verification:**
- New vitest cases pass (including bot-echo skip + stale-relation guard).
- Manual smoke test on a fresh study: set parent to Done while subtasks are In Progress → status flips back within ~1-2s; Activity Log shows "corrected" entry. Follow-up: check that the engine's PATCH did NOT produce a second parent-direct entry (bot-echo skip working).

- [ ] **Unit 2: Parent DATE revert path for frozen parents**

**Goal:** Parent date edits hit the existing Error 1 revert-and-warn flow regardless of whether the parent's Status is Done/N-A.

**Requirements:** R2, R5

**Dependencies:** None.

**Files:**
- Modify: `engine/src/routes/date-cascade.js`
- Test: `engine/test/routes/date-cascade.test.js`

**Approach:**
- **Full preamble move** (not just `isFrozen`): move `parseWebhookPayload` + `reportStatus("Cascade started...")` + `queryStudyTasks` + `preSnapshot` construction + `classify()` ALL to run BEFORE the `isFrozen` check. classify requires `allTasks` from `queryStudyTasks` to compute `hasSubtasksFromGraph`; running it with empty allTasks breaks Error 1 detection entirely.
- **New guard order**: `parsed.skip` → zero-delta skip → Import Mode skip → hasDates/studyId check → post "Cascade queued" (Unit 3) → reportStatus("Cascade started") → queryStudyTasks → preSnapshot → classify → if `classified.skip === true` (Error 1 is the only skip path; classify.js:67 returns `skip: true` only when `hasSubtasksFromGraph && !hasParent && (startDelta !== 0 || endDelta !== 0)`) → `applyError1SideEffects` + log no_action with reason 'Direct parent edit blocked' + return → else if `isFrozen(parsed)` → log no_action with reason 'frozen_status' + return → else → proceed to cascade.
- **Verify classify's skip trigger** before implementation: confirm the only classify path that returns `skip: true` is the Error 1 guard. If a future condition adds another skip reason, the Error 1 branch will need a more specific discriminator (check `classified.reason` string or `parentMode === null` together with `skip === true`).
- **`applyError1SideEffects` unchanged**: already patches `Dates`, `Reference Start/End Date`, and the task's `Automation Reporting` (red warning) + study's `Automation Reporting` (study-level red banner). No modification to the helper itself.
- **Accepted trade-off (documented)**: every frozen-leaf edit now triggers a full `queryStudyTasks` Notion fetch (previously a zero-I/O no-op log). Acceptable because frozen-leaf edits are rare and per-study FIFO queue bounds concurrency; the alternative breaks the unit's goal.
- **UX interaction with Unit 3**: for Error 1 classified-skip path, SUPPRESS the intermediate "Cascade started" reportStatus (it's misleading — no cascade is running, we're reverting). Sequence becomes: "Cascade queued" (set by handler) → `applyError1SideEffects` writes revert-warn red → no "started" or "complete" in between. Implementer: move the "Cascade started" reportStatus to after the classified.skip branch so Error 1 paths skip it.

**Patterns to follow:**
- Existing Error 1 branch at date-cascade.js:266-288.
- Existing `logTerminalEvent` invocations with `status: 'no_action'` and `noActionReason`.
- `applyError1SideEffects` helper at date-cascade.js:133-164.

**Test scenarios:**
- Happy path: Frozen top-level parent dates edited → classify runs (queryStudyTasks happens), classified.skip===true, `applyError1SideEffects` fires, dates reset to refStart/refEnd, task's Automation Reporting shows red revert warning, study's Automation Reporting shows red banner, Activity Log no_action entry with reason 'Direct parent edit blocked'.
- Happy path: Non-frozen top-level parent dates edited → same path as frozen (Error 1 fires unchanged from existing behavior).
- Happy path: Frozen leaf subtask dates edited → classify runs (cost: queryStudyTasks), classified.skip===false, cascadeMode set, then isFrozen fires, logs no_action with 'frozen_status' and returns. Net behavior same as today but with one added Notion fetch.
- Edge case: Middle parent (has parentId AND subtasks) edits dates while frozen → classify sets `parentMode: 'case-a'` and `skip: false`; isFrozen then fires, logs no_action. Subtask shifts don't run on frozen middle parents (intentional narrow scope).
- Edge case: Frozen parent edited to SAME dates (zero delta) → zero-delta skip fires before classify (earliest guard); no revert, no log. Unchanged existing behavior.
- Edge case: Error 1 path must NOT post a "Cascade started" intermediate status — verify via mock assertion that the frozen-parent test case sees "Cascade queued" (from Unit 3) then the revert-warn, with no "Cascade started" between them.
- Error path: Notion patch during applyError1SideEffects fails → route-level catch logs failure (existing behavior).
- Load path: Frozen-leaf edit now triggers a queryStudyTasks call (new cost). Verify via test that the mock is called even for the frozen-leaf skip path.

**Verification:**
- New vitest cases pass.
- Manual smoke test: unfreeze a parent first (set all subtasks non-Done) → set parent Status=Done via Unit 1 path (will immediately snap back; that's fine for setup) → manually re-set Done by marking all subtasks Done → then edit parent's dates → dates visibly revert; task's Automation Reporting shows red revert warning; study's Automation Reporting shows banner; Activity Log entry with 'Direct parent edit blocked' reason. Confirm no "Cascade started" message between queued and reverted.

- [ ] **Unit 3: "Cascade queued" pre-state**

**Goal:** PM clicking a date change sees immediate "Cascade queued" feedback in the Automation Reporting field, transitioning to "Cascade started" when the 5s debounce fires and then "Cascade complete."

**Requirements:** R3, R5

**Dependencies:** None.

**Files:**
- Modify: `engine/src/routes/date-cascade.js` (`handleDateCascade` function at lines 478-481)
- Test: `engine/test/routes/date-cascade.test.js`
- Possibly modify: `engine/src/services/cascade-queue.js` (only if the simplest path requires a hook)

**Approach:**
- **Order within handler**: `res.status(200).json({ok: true})` FIRST (preserve webhook fast-return pattern) → then `try { parseWebhookPayload(req.body) }` → if parseable + not-skip, fire-and-forget `notionClient.reportStatus(TASK_ID, 'info', 'Cascade queued — starting in ~5s...')` → then `cascadeQueue.enqueue(...)`. Wrap the parse+reportStatus block in try/catch so handler never 500s.
- **Task-scoped reporting (CRITICAL)**: switch all cascade-lifecycle `reportStatus` calls from `studyId` target to `taskId` target. The study's `Automation Reporting` field is shared across all cascades in a study; multi-task cascades overwrite each other's states. Task-scoped writes give per-task visibility and eliminate field collision.
  - New Unit 3 "Cascade queued" → task field.
  - Existing "Cascade started for..." (processDateCascade line ~234) → task field.
  - Existing "Cascade complete for..." (~line 395) → task field.
  - Existing "No updates needed for..." (~line 354) → task field.
  - Error-path "Cascade failed for..." (~line 452) → task field.
  - Study-level `reportStatus` reserved for: Error 1 revert banner (DIRECT_PARENT_WARNING via `applyError1SideEffects`), Import Mode operations, add-task-set errors. Unchanged.
- **Error 1 interaction (Unit 2)**: when classify returns skip (Error 1), do NOT post "Cascade started" — skip directly to applyError1SideEffects. The sequence PMs see for a frozen parent edit: "Cascade queued" → red revert-warn. No misleading "started" in between.
- **Rapid clicks**: debounce keys by taskId (cascade-queue.js:43); each click within the 5s window reposts "Cascade queued" (acceptable UX — the task's field refreshes). Same-study cross-task clicks no longer collide because each task writes to its own field.
- **Cascade-failed state**: if a cascade errors after "started" was posted, existing error path posts "Cascade failed for..." to the task's Automation Reporting (now also task-scoped). Persistent until the next cascade overwrites.
- **Process-crash state** (acknowledged, not fixed): if the process crashes between the queued post and debounce firing, the task's field shows "Cascade queued" indefinitely until the next cascade. Acceptable for pre-production; Railway auto-restart plus normal user testing behavior will overwrite naturally.

**Patterns to follow:**
- Existing `reportStatus` invocations in `processDateCascade` — need the target to switch from `parsed.studyId` to `parsed.taskId`.
- Fire-and-forget pattern: `.catch(() => {})` on the reportStatus promise.
- `cascadeQueue.enqueue` fall-through for skip payloads (cascade-queue.js:36) — Unit 3's skip-the-queued-status-and-enqueue should NOT double-log or bypass the existing fall-through.

**Test scenarios:**
- Happy path: Webhook with valid body → "Cascade queued" posts to the TASK's Automation Reporting (mock target = taskId), handler returns 200, cascade enqueued.
- Happy path: Debounce fires 5s later → processDateCascade posts "Cascade started" then "Cascade complete" to the task's field (not study's) — verify mock target is taskId not studyId.
- Happy path: Rapid consecutive clicks on SAME task within 5s → each click reposts "Cascade queued" to that task's field; one cascade eventually runs.
- Happy path: Clicks on DIFFERENT tasks in the same study within 5s → each task's field receives its own queued → started → complete cycle; no cross-task overwrite.
- Edge case: Error 1 path (frozen parent date edit) → "Cascade queued" appears, then revert-warn red; verify no intermediate "Cascade started" was posted.
- Edge case: Webhook with missing studyId or taskId → skip the queued status; still enqueue.
- Edge case: parsed.skip === true → skip the queued status; preserve existing cascade-queue.js:36 fall-through behavior (calls processFn directly). Unit 3 must not break that.
- Edge case: reportStatus fails synchronously during parse (malformed body) → caught by try/catch; handler still returns 200.
- Error path: reportStatus fails (Notion 5xx) on queued post → `.catch()` swallows; handler still returns 200 and enqueues.
- Regression: study-level reportStatus for Error 1 banner + add-task-set messages still targets studyId (not taskId) — verify nothing accidentally switched.

**Verification:**
- New vitest cases pass.
- Manual smoke test 1 (single-task): edit a non-parent task's date. Within ~1s, "Cascade queued" appears on that TASK's Automation Reporting. At ~5s, transitions to "Cascade started." At completion, "Cascade complete."
- Manual smoke test 2 (multi-task): rapidly edit dates on two different tasks in the same study. Verify each task's field independently shows its own queued → started → complete. The study page's Automation Reporting field should stay untouched by lifecycle states.
- Manual smoke test 3 (Error 1): edit a frozen parent's date (set up via all-Done subtasks). Task field shows "Cascade queued" then revert-warn red — no "Cascade started" flash between them.

- [ ] **Unit 4: Verify Add Task Set fallback to Blueprint when seed group missing**

**Goal:** Add Task Set buttons (TLF-only, TLF+CSR, TLF+Insights, TLF+Insights+CSR, additional-site, repeat-delivery) produce correctly-dated tasks when no previous corresponding task set exists in the study. Confirms the existing fallback path works for all button types.

**Requirements:** R4, R5

**Dependencies:** None.

**Files:**
- Review (possibly modify): `engine/src/routes/add-task-set.js`
- Test: `engine/test/routes/add-task-set.test.js`

**Scope note**: Unit 4 covers pristine empty-seed verification only. Harden-against-delete-mid-cascade (races, copy-blocks integrity with stale idMapping, partial-delete numbering reuse) is OUT OF SCOPE and tracked as a follow-up backlog entry post-merge.

**Approach:**
- Confirm existing fallback behavior via code inspection + tests:
  - For repeat-delivery with no previous delivery: `latestDeliveryParentId` stays null (add-task-set.js:404), `latestDates` empty, `_overrideStartDate` never set, create-tasks.js:37-53 falls through to Blueprint SDate/EDate offsets.
  - For TLF buttons with no existing TLF group: TLF buttons never hit the `latestDates` override (it's scoped to `isRepeatDelivery`). `resolveTaskSetNumbers` returns `{templateId: 1}`, tasks numbered `#1`, create-tasks.js uses Blueprint offsets.
- If verification reveals a gap: patch narrowly. Candidates pre-identified:
  - (a) draft-TLF unblocking logic at add-task-set.js:302-308 — assumes existence of a seed; verify it safely no-ops on empty seed.
  - (b) copy-blocks webhook fires against `newIdMapping` — with all tasks fresh, newIdMapping contains all production IDs, should work.
  - (c) single-leaf duplicate guard at add-task-set.js:332-368 — `existingIdMapping[templateId]` is undefined on empty seed, guard passes, one task creates.

**Patterns to follow:**
- Existing fallback: `if (task._overrideStartDate) { ... } else { Blueprint offsets }` in create-tasks.js:37-53.
- Existing draft-TLF blocker clear: add-task-set.js:302-308.

**Test scenarios:**
- Happy path: Repeat Delivery on a study with existing D#2 → creates D#3 inheriting D#2's dates (existing override behavior; regression check).
- Happy path: Repeat Delivery on a study with zero existing deliveries → creates first delivery with Blueprint-offset dates relative to Contract Sign Date.
- Happy path: TLF-only button on a study with zero existing TLF tasks → creates TLF #1 with Blueprint-offset dates, copy-blocks fires against fresh newIdMapping.
- Happy path: TLF-only button on a study with one existing TLF group → creates TLF #2 with Blueprint-offset dates (existing behavior; regression check).
- Edge case: Additional-site button on a study with zero existing sites → creates first site with Blueprint offsets.
- Edge case: Blueprint template empty → existing error path fires ("No blueprint tasks found"). Unchanged.
- Integration: Copy-blocks webhook for newly-created tasks still fires correctly; idMapping complete.

**Verification:**
- New vitest cases pass for each button type's empty-seed happy path.
- Manual smoke test: in a fresh study, delete the first TLF group; press Add TLF; confirm new TLF #1 created with Blueprint-offset dates, no errors.
- Manual smoke test: in a fresh study with zero Data Deliveries, press Add Repeat Delivery; confirm delivery is named per current convention (pre-verified via Blueprint inspection) with Blueprint-offset dates.

- [ ] **Unit 5: Documentation updates**

**Goal:** `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` reflects the new status-rollup parent-direct behavior, the frozen-parent date revert path, the cascade-queued pre-state, and the add-task-set fallback rules.

**Requirements:** R5

**Dependencies:** Units 1-4 (must be implemented before documentation is accurate).

**Files:**
- Modify: `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md`

**Approach:**
- Update the Status Roll-Up section: describe both the leaf → parent flow (existing) and the parent-direct reconciliation flow (new). Note the silent correction + Activity Log audit + the `editedByBot` skip + the stale-relation guard + the "corrected" vs "triggered by" summary string distinction.
- Update the Date Cascade section: document the new guard order (parseWebhookPayload → zero-delta → Import Mode → hasDates/studyId → reportStatus queued → queryStudyTasks → classify → Error 1 branch OR isFrozen branch → cascade). Note the accepted trade-off: frozen-leaf edits now trigger a queryStudyTasks call (previously zero-I/O).
- Document the Error 1 revert flow runs regardless of parent's frozen status, and that the "Cascade started" intermediate status is SUPPRESSED for the Error 1 path (sequence: queued → revert-warn).
- Add a new subsection "Cascade lifecycle states (task-scoped reporting)": queued → started → complete OR queued → revert-warn (Error 1) OR queued → failed. Explicitly note: cascade lifecycle writes to the TASK's Automation Reporting field, NOT the study's. Study-level writes reserved for Error 1 banner, Import Mode operations, add-task-set errors.
- Add a known limitation note: middle-parent direct edits snap back the middle parent but do NOT propagate a rollup to the grandparent (Unit 1 scope boundary). Tracked for potential future work.
- Update the Add Task Set section: document the empty-seed fallback to Blueprint for all button types, with a table of button-type × seed-present matrix showing expected behavior.
- Record the Repeat Delivery design decision explicitly: "inherit dates from previous in-study delivery; fall back to Blueprint offsets when no previous exists." Note that this is the intentional design (Meg-confirmed 2026-04-22) and that Blueprint fixes propagate to future studies but NOT existing studies with an already-created delivery.

**Patterns to follow:**
- Existing section structure in ENGINE-BEHAVIOR-REFERENCE.md (headers 1-9, numbered behavior definitions, file:line references).

**Test scenarios:**
- Test expectation: none — documentation-only unit.

**Verification:**
- Reviewer confirms the new sections accurately describe Units 1-4's behavior.
- File:line references in the doc point to the current post-implementation code.

## System-Wide Impact

- **Interaction graph:**
  - Unit 1 adds a new parent-direct branch in status-rollup. Subtask → parent roll-up path (critical path) unchanged. Every engine-initiated parent PATCH produces a bot-echo webhook; the `editedByBot` guard prevents re-entry.
  - Unit 2 reorders date-cascade guards. Critical consequence: `queryStudyTasks` moves ahead of `isFrozen`, so every frozen-leaf edit now triggers a study-tasks fetch. Per-study FIFO queue already bounds concurrency.
  - Unit 3 adds fire-and-forget `reportStatus` on webhook hot path + switches all cascade lifecycle writes from study-scoped to task-scoped Automation Reporting. Eliminates field collision across multi-task cascades in the same study.
  - Unit 4 is verification + tests; no code change expected. Pre-implementation Blueprint verification required before tests are written.
  - Unit 5 (docs) lands after 1-4.
- **Error propagation:**
  - Unit 3's fire-and-forget reportStatus errors are swallowed with `.catch(() => {})` so they never block the enqueue.
  - Unit 1's new branch propagates Notion API errors through the existing `handleStatusRollup` outer try/catch + study-level reportStatus error banner.
  - Unit 2's Error 1 revert path propagates errors through the existing route-level catch (unchanged).
- **State lifecycle risks:**
  - Unit 1: concurrent rollup webhooks for the same parent can race. `status-rollup.js` uses `flightTracker.track(...)` for shutdown drain, NOT for serialization. Two concurrent webhooks for the same parent both run `processStatusRollup` in parallel. Mitigation: `editedByBot` skip prevents echo loops. Residual risk: rapid PM toggling during eventual-consistency window can produce stale-read-then-overwrite. Accepted for pre-production; revisit if Meg encounters it.
  - Unit 2: `queryStudyTasks` now runs for frozen leaves. Load is bounded by per-study FIFO queue; negligible Notion API impact at current study sizes (~250 tasks max).
  - Unit 3: `parseWebhookPayload` now runs twice per webhook (handler + processDateCascade). Minor CPU cost. reportStatus errors race with terminating cascades on the same task — acceptable trade-off (last-write-wins per task).
- **API surface parity:**
  - No public API changes. All modifications internal to webhook routes.
- **Integration coverage:**
  - Task-scoped Automation Reporting depends on existing `reportStatus(taskId, ...)` flow — verify via integration test that taskId targets accept the same writes studyId targets do.
  - Cascade queued → started → complete sequence depends on debounce + Notion UI refresh timing; covered by manual smoke test (automated Notion round-trip testing impractical).
- **Unchanged invariants:**
  - n8n workflows (all deactivated) untouched.
  - Webhook auth middleware (WEBHOOK_SECRET) unchanged.
  - Cascade-queue debounce window (5s) unchanged; undo semantics unchanged.
  - Inception behavior unchanged (plan only touches add-task-set via Unit 4 verification).
  - Status-rollup's Import Mode skip unchanged — applies to both subtask → parent and parent-direct branches.
  - Study-level reportStatus paths for Error 1 banner + add-task-set errors + Import Mode ops untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Unit 1 bot-echo re-entry amplifies Notion reads | `editedByBot` skip at the top of the new branch (cascade-queue.js:45 pattern). Verified in dedicated test scenario. |
| Unit 1 race: concurrent webhooks for same parent produce stale-read overwrite | `status-rollup.js` has no per-key serialization (flightTracker tracks for shutdown only). Residual risk accepted for pre-production. If Meg hits it in testing, add an in-memory per-parent lock similar to `study-lock.js`. |
| Unit 1 stale-relation: `hasSubtasks=true` but children query returns empty → silently resets parent to Not Started | Explicit empty-children guard in the new branch: `if (children.length === 0) return;`. Test scenario covers this. |
| Unit 2 guard reorder: frozen leaf edits now trigger queryStudyTasks | Accepted trade-off — bounded by per-study FIFO queue; documented in Key Technical Decisions + ENGINE-BEHAVIOR-REFERENCE docs. |
| Unit 2 guard reorder: Error 1 detection relies on classify returning `skip: true` uniquely for that case | Pre-implementation verification: confirm classify.js:67-83 is the only skip path today. If another skip reason is added later, discriminator needs tightening. |
| Unit 2+3 interaction: "queued → started → revert-warn" flicker on frozen parent edits | Suppress "Cascade started" reportStatus for the Error 1 classified-skip path. Sequence becomes queued → revert-warn. Test scenario asserts no "started" message in between. |
| Unit 3 study-scoped → task-scoped reporting change affects PMs' visibility mental model | Unit 5 docs explicitly call out the change. Manual smoke test 2 covers the multi-task scenario. Meg reviews on next call. |
| Unit 3 handler parse failure on malformed payload | try/catch around parse + reportStatus; handler always returns 200; parse errors never prevent enqueue. |
| Unit 4 naming-convention collision (D#1 from repeat-delivery template vs inception's "Initial Data Delivery") | Pre-implementation Blueprint verification is BLOCKING. Resolve the expected task name before writing tests. Documented as deferred question. |
| Meg's "both directions" interpretation may not match her actual intent in edge cases (e.g., parent set to Not Started while some subtasks In Progress) | Residual product risk. Silent correction + Activity Log is the worst combo if wrong. Pre-production, so revertable. Tem to share deployed behavior with Meg on next call + add a concrete-scenario confirmation question. |
| Test coverage on vitest mocks diverges from production Notion behavior | Manual smoke test after each unit deploys to Railway. Tem owns verification. Test scenarios include mock target assertions (taskId vs studyId) to catch switch regressions. |

## Documentation / Operational Notes

- **Deployment**: Railway auto-deploys on merge to main. No manual steps.
- **Rollback**: all five units are single-PR-sized; rollback = revert PR. Note: code reverts do NOT undo persisted state — Activity Log entries accumulate, Automation Reporting fields may be left mid-transition ("Cascade queued" stuck), and Unit 2's reverted dates stay reverted. Pre-production risk is low but acknowledge revert is not a full reset.
- **Activity Log volume**: Unit 1 adds a new event type (parent-direct snap-back). Expected volume: ~1 per parent edit attempt. Very low.
- **PM directions update**: Meg owns adding "parent task should never be updated" note to PM directions (mentioned in her 2026-04-22 comment). Not an engineering deliverable.
- **Follow-up backlog** (create post-merge):
  - BL-apr22-followup-1: harden add-task-set against delete-mid-cascade (seed deleted while button is mid-flight, copy-blocks fires against stale idMapping, partial-delete numbering reuse). Unbounded scope; not in this plan.
  - BL-apr22-followup-2: consider per-parent locking in status-rollup to eliminate concurrent-webhook stale-read race. Only prioritize if Meg encounters it in testing.
  - BL-apr22-followup-3: middle-parent status snap-back should optionally propagate rollup to grandparent. Out of scope this plan; document the limitation.

## Deferred P2 Review Items (Product-Lens)

The document-review surfaced several strategic questions that weren't resolved here. They don't block implementation but deserve separate decisions:

- **Engine-as-policer vs UI-as-gatekeeper (Finding F9 product)** — Units 1 and 2 entrench engine logic that overrides PM edits. An alternative is to lock parent Status/Dates in the Notion UI (formula/rollup property) so they can't be edited. Collapses Unit 1+2, shrinks engine surface, makes the PM contract teachable in one sentence. Tem to decide: have 10-minute conversation with Meg before shipping Units 1+2 OR commit to engine-as-policer trajectory.
- **"Both directions" semantics ambiguity (Finding F10)** — Meg's comment covered the "some subtasks in progress" case explicitly. The symmetric case ("parent set to Not Started while some subtasks In Progress") is inferred, not confirmed. Worth a concrete-scenario Slack question before Unit 1 lands.
- **Bug 3 discoverability gap (Finding F11)** — Plan resolves to "no code change + docs." Meg will hit the same surprise again in months. Consider surfacing an Automation Reporting hint on Add Repeat Delivery: "Created D#N with dates inherited from D#(N-1). Blueprint changes do not propagate to existing deliveries." Tem decides whether worth the complexity.
- **Meg Test April 21 test data repair (Finding F12)** — Plan defers. Meg's next session will re-encounter broken D#2/#3/#4 dates. Cost: her clean-slate test time. Consider scripting a one-time repair before deploy (overwrite D#2's children dates with Blueprint offsets).
- **Engine-as-policer trajectory (Finding F7 product)** — Every PM feedback item so far has added more policing logic. Worth stepping back to evaluate whether future items should default to UI constraints instead of engine rules.
- **PM-facing docs ownership (Finding F8+F13)** — Unit 5 docs serve engineers (ENGINE-BEHAVIOR-REFERENCE.md). Meg "owns" the PM-facing docs update informally. Worth making explicit — either Tem writes the PM-facing behavior note and sends to Meg, or Meg writes it and Tem reviews.

## Sources & References

- **Origin document**: Notion page "Response to Meg's Report 4/21" — `3492386760c280b59159e785ee80cc0f` (workspace: picnichealth)
- **Meg's inline comment** (parent STATUS decisions): block `34923867-60c2-8087-814c-ebcf6888d10c`, discussion `34a23867-60c2-8004-a58d-001c2faa3ab8`, posted 2026-04-22T19:19 UTC by Meg Sanders
- **Slack thread**: [optemization.slack.com archive](https://optemization.slack.com/archives/C0AFWTRSD8U/p1776800969319279)
- **Prior pulse logs**: `pulse-log/04.21/001-pr-66-cascade-simplification-review-merge.md`, `pulse-log/04.20/001-pr-e-narrow-retry-and-sweep.md`
- **Related code**:
  - `engine/src/routes/status-rollup.js`
  - `engine/src/routes/date-cascade.js`
  - `engine/src/routes/add-task-set.js`
  - `engine/src/engine/status-rollup.js`
  - `engine/src/engine/classify.js`
  - `engine/src/provisioning/create-tasks.js`
  - `engine/src/services/cascade-queue.js`
  - `engine/src/services/activity-log.js`
- **Backlog entries**: `foundational/BACKLOG.md` → BL-apr21-item-1 through BL-apr21-item-5
