---
title: "fix: Extract withStudyLock to shared service + add to inception"
type: fix
status: active
date: 2026-04-20
revised: 2026-04-20 (post document-review)
origin: engine/docs/plans/2026-04-16-004-refactor-notion-client-idempotency-plan.md (adversarial review finding F-A3)
---

# PR E0 — Shared `withStudyLock` + inception coverage

## Overview

`withStudyLock` today is a private module-level helper inside `engine/src/routes/add-task-set.js` (lines 648-672) — its `_studyLocks` Map is route-scoped. Inception can't just "import" it. This PR:

1. **Extracts** `withStudyLock` + `_studyLocks` into a new shared service `engine/src/services/study-lock.js`.
2. **Migrates** `add-task-set.js` to import from the shared service (no behavior change for add-task-set).
3. **Adds** `withStudyLock` coverage to `inception.js` handler.

Two commits in one PR: (a) extract-only refactor (no behavior change), (b) add inception coverage (new behavior). Makes the diff reviewable in pieces and keeps the extraction reversible independently.

Prerequisite for PR E1 (narrow retry) and PR E2 (post-flight sweep) — both depend on cross-route lock coordination for their correctness claims.

## Problem Frame

Current state:
- `add-task-set.js:650` declares `const _studyLocks = new Map();` at module scope.
- `withStudyLock(studyId, fn)` at `add-task-set.js:652` is not exported.
- Inception has no lock coverage. Two concurrent inception webhooks for the same study can each run `processInception` in parallel — both create 200 tasks, both hit the existing-tasks guard too late (it's at line 107, after Import Mode is set and Contract Sign Date is read), both produce silent damage.

The double-inception guard at `inception.js:107` catches back-to-back clicks (first completes, second sees existing tasks) but not true concurrency (both see `existingTasks.length === 0` before either creates anything).

Document-review flagged three problems with the original "just wrap inception" plan:
1. The target file `engine/src/services/study-lock.js` doesn't exist — extraction is required.
2. Simply duplicating the `_studyLocks` Map in inception would give the two routes separate lock maps — no cross-route serialization. An inception and an add-task-set on the same study could still overlap.
3. The correct cross-route semantic requires a SHARED map, which requires extracting to a shared service.

The extraction is the real work here; the inception wrap is the trivial follow-up.

## Requirements Trace

- **R0-1.** `withStudyLock` lives in `engine/src/services/study-lock.js` as an exported function backed by a module-level `_studyLocks` Map.
- **R0-2.** `add-task-set.js` imports from the shared service; `_studyLocks` is no longer declared in the route. Same test helper `_resetStudyLocks` remains available (re-exported if needed for existing tests).
- **R0-3.** `inception.js` handler acquires the lock around `processInception` — mirrors add-task-set's handler pattern at `add-task-set.js:662-672`.
- **R0-4.** When an inception webhook fires without a `studyPageId` (unlikely but possible), it runs without the lock (same fallback as add-task-set). Logs a warning.
- **R0-5.** All existing add-task-set tests continue to pass unchanged. Inception gets new tests for same-study-concurrent and different-study-concurrent.
- **R0-6.** The lock's queue has no explicit timeout today. Accepted as-is for this PR — unbounded accumulation is a theoretical concern only reachable by a flood of webhook redeliveries; not in scope here.

Satisfies the concurrency prerequisite for PR E1 and PR E2.

## Scope Boundaries

- **No change** to `withStudyLock`'s behavior — pure extraction + re-import.
- **No change** to inception's business logic beyond the handler wrap — task creation, wiring, copy-blocks, Activity Log, comments, existing guards all untouched.
- **No change** to add-task-set's business logic — only its import changes.
- **No change** to any other route.
- **No new lock-timeout logic.** R0-6 accepts the unbounded-queue risk; mitigation is a separate PR if it becomes real.
- **Not in scope:** idempotency, retry behavior, duplicate cleanup. Those are PR E1 and PR E2.

## Context & Research

### Relevant Code and Patterns

- `engine/src/routes/add-task-set.js:648-660` — current `withStudyLock` + `_studyLocks` declaration (module-local).
- `engine/src/routes/add-task-set.js:662-672` — the `handleAddTaskSet` reference pattern. Key features: acknowledges the webhook with `res.status(200).json({ok: true})`, extracts `studyPageId` from the request body, conditionally wraps `processAddTaskSet(req)` in `withStudyLock`, wraps the result in `flightTracker.track(...)` so graceful shutdown awaits it.
- `engine/src/routes/inception.js` — current handler at `handleInception` (verify exact function name and line at implementation time; prior reference to "lines 310-313" was inaccurate).
- `engine/src/routes/inception.js:107` — the existing double-inception guard (`if (existingTasks.length > 0)`). Stays as belt-and-suspenders after this PR.
- `engine/src/services/` — the target directory. Houses `cascade-queue.js`, `cascade-tracer.js`, `flight-tracker.js`, `activity-log.js`, `undo-store.js`, `study-comment.js`. `study-lock.js` fits cleanly alongside these.
- `engine/test/routes/add-task-set.test.js` — existing tests using `_resetStudyLocks` in setup hooks. Need to continue working post-extraction (via re-export or test-env helper).
- `engine/test/routes/inception.test.js` — mocks `notionClient`, `activityLogService`, `studyCommentService`, blueprint/create/wire/copy. Reusable for new concurrent-case tests.

### Institutional Learnings

- **PR #56** (`pulse-log/04.14/004-add-task-set-serialization.md`) — introduced `withStudyLock` after the two-"TLF #2" concurrent-numbering bug. Same shape of fix (serialize per-study), applied here to a new route.
- **Activity Log retry-rate measurement (2026-04-20)** — sized the inception retry problem; concurrent inception would compound it. Lock is the prereq for E1/E2 to be correct.

### External References

None. Pure local refactor.

## Key Technical Decisions

- **Extract-then-add, in two commits.** Commit 1: pure extraction (no behavior change for add-task-set, no inception change). Commit 2: add inception handler wrap (new behavior for inception). Reviewers can verify commit 1 in isolation — if it doesn't break add-task-set tests, the risk of the PR is isolated to commit 2.
- **Shared `_studyLocks` Map at module scope.** Both routes read/write the same Map → cross-route serialization. No cross-import awkwardness.
- **Keep `_resetStudyLocks` helper for tests.** Re-export from the new service so existing test cleanup in `add-task-set.test.js` continues to work. Inception tests also use it.
- **Handler wraps, processor body doesn't.** Mirrors add-task-set: `handleInception` extracts `studyPageId` and conditionally wraps `processInception(req)` in `withStudyLock`. If `studyPageId` is missing, run unlocked (same fallback as add-task-set).
- **Keep the double-inception guard.** Line 107's check stays — defense in depth. Handles back-to-back (post-lock-release) double-clicks cleanly; lock handles true concurrency.
- **No timeout on lock acquisition.** R0-6 accepts unbounded queue as a theoretical concern. A runaway queue is only reachable by pathological webhook flooding, not normal operation.

## Open Questions

### Resolved During Planning

- **Lock key naming** — use the study page ID (not the whole body, not some nested field). Mirrors add-task-set.
- **Missing `studyPageId` behavior** — run without the lock, log a warning. Mirrors add-task-set.
- **Deadlock risk with add-task-set** — none. Both routes lock the same study-scoped key on the shared map; serialize cleanly.
- **Test helper export** — `_resetStudyLocks` re-exported from the new service so existing `add-task-set.test.js` hooks continue to work without import-path churn.
- **Extraction location** — `engine/src/services/study-lock.js` (confirmed consistent with sibling services).

### Deferred to Implementation

- Exact line placement inside `handleInception` for the wrap — mirror add-task-set's handler.
- Whether to add a `getActiveLockCount()` debug accessor to the service for future observability. Nice-to-have, not required by this PR.

## Implementation Units

- [ ] **Unit 1: Extract `withStudyLock` + `_studyLocks` into `engine/src/services/study-lock.js`**

**Goal:** Move the private helper to a shared service. No behavior change.

**Requirements:** R0-1, R0-2, R0-5.

**Dependencies:** None.

**Files:**
- Create: `engine/src/services/study-lock.js`
- Modify: `engine/src/routes/add-task-set.js` (remove local declaration, import from the new service)
- Modify: `engine/test/routes/add-task-set.test.js` (update import path for `_resetStudyLocks` if needed)

**Approach:**
- Create `engine/src/services/study-lock.js` exporting `withStudyLock(studyId, fn)` and `_resetStudyLocks()`. Internal `_studyLocks` Map is module-scoped (not exported directly, but `_resetStudyLocks` clears it for tests).
- Copy the function body verbatim from `add-task-set.js:650-660`. Same FIFO chain-of-promises semantics.
- In `add-task-set.js`: remove the local `_studyLocks` declaration + `withStudyLock` + `_resetStudyLocks` function body. Replace with a single `import` from the new service. Do NOT re-export `_resetStudyLocks` from `add-task-set.js` — tests import directly from the service.
- Update any test file that imports `_resetStudyLocks` to pull from the new path.

**Execution note:** Land as a standalone commit before Unit 2. The commit should pass all existing tests unchanged — no new behavior.

**Patterns to follow:**
- Sibling services in `engine/src/services/` for export style.
- Existing `_resetStudyLocks` usage pattern in `add-task-set.test.js`.

**Test scenarios:**
- **Happy path — module-level import works:** `import { withStudyLock, _resetStudyLocks } from '../../services/study-lock.js';` in both `add-task-set.js` and test files resolves correctly.
- **Regression — all existing add-task-set tests pass.** No assertion changes; only import-path changes.
- **Cross-route map sharing (verified via unit test):** instantiate two call sites from two different source files, both calling `withStudyLock('study-X', fn)`. Second call waits until first completes. Proves shared Map semantics.

**Verification:**
- `npm run test:ci` passes with zero test-body changes (only import-path updates).
- Grep: `grep -r "_studyLocks" engine/src/` returns only one match — in `engine/src/services/study-lock.js`.

- [ ] **Unit 2: Wrap `processInception` in `withStudyLock`**

**Goal:** Add per-study serialization to the inception handler.

**Requirements:** R0-3, R0-4.

**Dependencies:** Unit 1 merged.

**Files:**
- Modify: `engine/src/routes/inception.js`
- Test: `engine/test/routes/inception.test.js`

**Approach:**
- Import `withStudyLock` from `engine/src/services/study-lock.js`.
- In `handleInception`: after the webhook acknowledgement (`res.status(200).json({ok: true})`), extract `studyPageId` from the request body (same field path as add-task-set: `req.body?.data?.id || req.body?.studyPageId`).
- Conditionally wrap `processInception(req)` in `withStudyLock`:
  - If `studyPageId` truthy: `withStudyLock(studyPageId, () => processInception(req))`.
  - Else: `processInception(req)` directly, plus a warning log.
- Keep the existing `flightTracker.track(...)` wrapper around whichever Promise results.

**Patterns to follow:**
- `engine/src/routes/add-task-set.js:662-672` — direct mirror.

**Test scenarios:**
- **Happy path — single webhook:** one inception fires, lock acquired, runs, releases. Identical observable behavior to today.
- **Concurrent — same study:** two inception webhooks fire within 50ms for the same study page ID. First acquires, runs to success (200 tasks created, Activity Log success row). Second waits, then acquires, enters `processInception`, the double-inception guard at line 107 fires (existing tasks found), aborts cleanly (comment posted, Import Mode reset). DB has 200 tasks, not 400.
- **Concurrent — different studies:** two inception webhooks for different study IDs. Both acquire their respective locks in parallel. Both succeed independently. No cross-study interference.
- **Concurrent — inception + add-task-set on same study:** inception first, add-task-set fires 500ms later for same study. Add-task-set waits (same Map → same lock). Inception completes, add-task-set proceeds. Proves cross-route serialization.
- **Error path — first inception throws mid-flight:** lock released via FIFO promise settlement (settled = rejected). Second queued inception proceeds normally.
- **Missing `studyPageId`:** handler runs `processInception` unlocked, logs a warning. Processor's own missing-ID handling takes over (current behavior).

**Verification:**
- `npm run test:ci` passes. The concurrent-same-study test is the key new case.
- Manual optional: fire two inception webhooks ~500ms apart via `scripts/fire-inception-webhook.js` (if it exists) and confirm DB task count is 200, not 400.

## System-Wide Impact

- **Interaction graph:** `withStudyLock` is now a shared utility. Two callers today (inception, add-task-set). Both lock the same study — serializes cross-route work for the same study.
- **Error propagation:** unchanged. Lock settles regardless of inner promise outcome; outer `flightTracker.track` wrapper absorbs errors per existing `.catch` pattern.
- **State lifecycle risks:** none net-new. Lock releases on settled promise; Import Mode still reset via existing `finally` inside `processInception`.
- **API surface parity:** no webhook or response contract changes.
- **Integration coverage:** existing add-task-set tests validate the extraction (Unit 1). New inception tests validate the coverage (Unit 2) and the cross-route serialization.
- **Unchanged invariants:** double-inception guard at line 107, Import Mode lifecycle, Activity Log emission, Study Comment flow, Contract Sign Date fail-loud (PR #62), single-leaf duplicate guard (PR #62), add-task-set's existing lock behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Extraction accidentally changes add-task-set's lock semantics | Unit 1 is a pure code-move commit; Unit 1's verification requires all add-task-set tests pass unchanged. If they don't, something was subtly different in the extracted version. |
| Test helper `_resetStudyLocks` import path change breaks existing tests | Unit 1 updates the import in `add-task-set.test.js` same commit as the extraction. Also a CI check. |
| Missing studyPageId path for inception differs from processor's own handling | Explicit warning log + fall-through to `processInception` unlocked. Processor's own no-ID handling takes over (current behavior). Preserves backward compatibility. |
| Unbounded lock queue under webhook flooding | R0-6 explicitly accepts this. Real-world trigger requires sustained webhook storm on a single study; unlikely in pre-production. If it becomes real, add a bounded queue in a follow-up. |
| Downstream plans (E1, E2) depend on this lock semantics | PR E0 ships first. PR E1 and PR E2 can safely reference shared lock coverage. |

## Documentation / Operational Notes

- Post-merge: short pulse log entry `clients/picnic-health/pulse-log/04.20/NNN-pr-e0-shared-study-lock.md` — one paragraph.
- No Railway env var changes. No rollout concerns.
- Closes the concurrency gap the 2026-04-16 re-investigation surfaced as a prerequisite for the wider duplicate-prevention work.

## Sources & References

- **Prior shipped:** PR #56 (`pulse-log/04.14/004-add-task-set-serialization.md`).
- **Document-review findings:** 2026-04-20 feasibility review of this plan's first draft — identified the `study-lock.js`-doesn't-exist problem, the line-107-not-77 error, and the add-task-set.js:648-672 reference pattern (not :570-577). This revised plan addresses all three.
- **Upstream plan (superseded):** `engine/docs/plans/2026-04-16-004-refactor-notion-client-idempotency-plan.md` — the probe-based approach that first identified the inception-concurrency gap (F-A3).
- **Related code:**
  - `engine/src/routes/inception.js`
  - `engine/src/routes/add-task-set.js` (lines 648-672 for current `withStudyLock`, lines 662-672 for handler reference)
  - `engine/src/services/` (target directory for the new shared service)
- **Downstream plans:** PR E1 (`2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md`), PR E2 (`2026-04-20-003-feat-post-flight-duplicate-sweep-plan.md`) — both depend on shared lock coverage.
