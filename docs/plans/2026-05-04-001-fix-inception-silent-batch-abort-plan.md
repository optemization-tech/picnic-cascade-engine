---
title: "fix: Inception silent batch-abort partial-failure"
type: fix
status: completed
date: 2026-05-04
---

# fix: Inception silent batch-abort partial-failure

## Overview

When `createStudyTasks` issues a parallel `createPages` batch and one POST hits a non-idempotent unsafe error (5xx or post-send timeout on `POST /pages`), `runParallel` marks the failing slot as `Error`, sets `aborted = true`, and signals other workers to stop pulling new items. Items not yet picked up remain `undefined`. The current caller filters `undefined` and `Error` together when computing `successes`, so partial-failure is invisible: the route reports `Inception complete: N tasks created` with status `success`. The Activity Log's only signal is `narrowRetrySuppressed: N` — which counts trigger errors, not the abandoned slots.

This plan adds detection, escalation, and observability at the caller layer. It deliberately does **not** change `runParallel` semantics, add an automatic retry pass, or ship the post-flight duplicate sweep originally planned in PR E2.

---

## Problem Frame

**May 1 incident (Ionis HAE 001 study `35323867-60c2-81d0-bb16-fb6e33ee64c9`).** Inception ran at 02:17 UTC. Blueprint had 202 tasks, all valid (no orphans, no null offsets — verified by re-querying current state and confirming all 202 pages predate the run). Diagnostics:
- `totalCreated: 131`, `narrowRetrySuppressed: 1`, `pagesProcessed: 128, pagesSkipped: 3`
- Activity Log status: `success`
- 70 blueprint task IDs missing from the study's Study Tasks (verified by Template Source ID diff)
- Reconciliation: `131 created + 1 narrow-retry-suppressed + 70 not attempted = 202` (entries that reached `createBatch`); `pagesProcessed: 128 + pagesSkipped: 3 = 131` (downstream `copyBlocks` ran on the 131 created pages and either copied or skipped per template).

Mechanism (already documented and tested at `test/notion/client.test.js:690-741`): one `unsafe_retry`+`nonIdempotent` error → worker stores `Error` in slot, sets `aborted = true` → other workers return on next loop iteration → un-pulled slots stay `undefined` (`src/notion/client.js:153-201`). `createStudyTasks` filters `successes = createdPages.filter((p) => p && !(p instanceof Error))` (`src/provisioning/create-tasks.js:287`) — both `undefined` and `Error` are dropped equivalently, with no count of how many were never attempted.

The narrow-retry refactor plan (`docs/plans/2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md`, R1-7) accepted "batch abort surprises callers" as a documented risk on the basis that "inception/add-task-set provisioning paths already handle partial failure via error comment + Automation Reporting." That mitigation never landed for inception/add-task-set — those routes still report success on partial-failure. The companion PR E2 post-flight duplicate sweep also never shipped (no `sweep` service in `src/services/`).

**The user impact:** Operators (Tem and the team running the engine, plus PMs reading the study state) see a "successful" study with broken hierarchies — child tasks missing under created parents — and have no signal that anything went wrong. Re-running inception is blocked by the double-inception guard, so recovery requires manual cleanup. PMs lack the engine context to recognize the partial state; Tem (or a developer) is the actual recovery actor. The operator-facing message budget below targets that recovery actor.

---

## Requirements Trace

- **R1.** `createStudyTasks` MUST detect when the underlying `createPages` batch did not attempt every entry it received — i.e., `successes.length + errors.length < entries.length`, or equivalently `undefinedCount > 0`.
- **R2.** `createStudyTasks` MUST escalate any incomplete batch (any `Error` or any `undefined` slot) to a thrown error, so the caller's existing failure-path handling runs. The error's message MUST include the breakdown: created, failed-unsafe, not-attempted.
- **R3.** The thrown error's user-facing summary (≤180 chars to fit `inception.js:291` slicing) MUST tell the operator (a) what state the study is in, and (b) the next action — archive partial tasks and re-run.
- **R4.** The cascade tracer MUST surface attempted/created/failed/aborted counts in `toActivityLogDetails()` so future incidents are diagnosable from the Activity Log body alone, not Railway logs.
- **R5.** Inception's existing failure path (Activity Log `failed`, study comment, `reportStatus error`, Import Mode disabled in `finally`) MUST run unmodified for the new throw path. Add-task-set's equivalent path likewise.
- **R6.** Verification: re-running today's incident scenario (1 unsafe error mid-batch) MUST result in Activity Log entry with `status: failed`, study comment posted, and details body containing the abandonment count.

---

## Scope Boundaries

- **Out of scope:** automatic retry of un-attempted slots. Selected against in scoping; transient errors recover on user re-run after cleanup.
- **Out of scope:** PR E2 post-flight duplicate sweep (originally planned at `docs/plans/2026-04-20-003-feat-post-flight-duplicate-sweep-plan.md`). Larger architectural change; unblocked by this plan but not executed by it.
- **Out of scope:** modifying `runParallel` abort-on-first-unsafe semantics. Documented and tested intentional behavior (R1-7); changing it would require revisiting the duplicate-prevention guarantees.
- **Out of scope:** automatic cleanup of partial-state Study Tasks after a failed batch. Operator-driven for now.
- **Out of scope:** "force-resume" inception mode that bypasses the double-inception guard.

### Deferred to Follow-Up Work

- **Ionis HAE 001 partial-task cleanup (owner: Tem, before this fix deploys).** Archive the 131 partial Study Tasks linked to study `35323867-60c2-81d0-bb16-fb6e33ee64c9` so the study returns to a state where the double-inception guard sees no existing tasks, and a re-run can succeed cleanly. Use the U4 runbook procedure as the dogfood test — if it works for this incident, the runbook is validated for future operators. Tracked separately from the engine fix; should complete before deploy so the deploy-day signal is "no regressions" rather than "Ionis still broken."
- **PR E2 post-flight duplicate sweep:** unblocks an automatic-retry follow-up plan if narrow-retry suppression remains a recurring source of partial failures after this fix lands. See `Deferred to Future Work` in Open Questions for the architectural insight that `undefined`-only auto-retry is duplicate-safe and may not require the full sweep.

---

## Context & Research

### Relevant Code and Patterns

- **`src/notion/client.js:153-201`** — `runParallel` abort-on-first-unsafe semantics. The fixed point of this plan; not modified.
- **`src/notion/client.js:115-127`** — narrow-retry suppression for non-idempotent paths. Calls `tracer.recordNarrowRetrySuppressed()`, throws → bubbles up to `runParallel` worker as the abort trigger.
- **`src/notion/client.js:240-262`** — `requestBatch` returns the mixed array (successes / Error / undefined). The full-batch-failure throw at line 254 only fires when `successes.length === 0`, which is correct as-is.
- **`src/provisioning/create-tasks.js:280-290`** — site of the fix. Currently filters `undefined` + `Error` equivalently; needs to differentiate.
- **`src/services/cascade-tracer.js`** — small, focused tracer. `recordNarrowRetrySuppressed()` is the established pattern for surfacing batch-level signals to Activity Log details.
- **`src/services/activity-log.js:69-70`** — surfaces `narrowRetrySuppressed` to Activity Log entry body when present. Pattern to copy for new counters.
- **`src/routes/inception.js:270-306`** — existing catch block. Reports status `error`, logs terminal `failed` event, posts study comment with `String(error.message || error).slice(0, 180)`. Already correct; relies on createStudyTasks throwing.
- **`src/routes/add-task-set.js:497-504`** — calls `createStudyTasks` identically; same try/catch shape (verified earlier in this engagement); inherits the fix automatically when create-tasks throws.
- **`test/notion/client.test.js:629-741`** — "batch abort semantics (Unit 4)" suite. Already locks in `result[2]` is `undefined` after worker abort. The lib-layer contract is fixed; the fix sits in callers.

### Institutional Learnings

- **PR E1 / PR E2 shorthand used throughout this plan:**
  - **PR E1** = the narrow-retry refactor for non-idempotent writes (`docs/plans/2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md`). Shipped. Established `runParallel` abort-on-first-unsafe semantics.
  - **PR E2** = the post-flight duplicate sweep (`docs/plans/2026-04-20-003-feat-post-flight-duplicate-sweep-plan.md`). Planned as the safety net for E1; never shipped (no `sweep` service in `src/services/`).
- **2026-04-20 narrow-retry plan (PR E1), R1-7 risk register** (`docs/plans/2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md:388-389`): documented the risk of caller surprise; mitigation specified but not delivered for inception/add-task-set. This plan is the deferred R1-7 mitigation half.
- **2026-05-01 silent-skip pulse log** (`engagements/picnic-health/pulse-log/05.01/001-meg-moderna-cascade-notion-filter-jot.md`): same diagnostic pattern flagged a separate observability gap (`zero_delta_skip` / `import_mode_skip` silent paths). The class — engine produces correct internal state but Activity Log doesn't reflect it — is recurring; this plan applies the same "fail loud" remedy.

### External References

None. Fix is local; Notion API behavior is not in scope.

---

## Key Technical Decisions

- **Throw from `createStudyTasks` rather than return a `partial: true` flag.** Both inception and add-task-set already have correct error-path handling via try/catch; throwing reuses that infrastructure with no new branches. A flag would require new conditional logic in two routes and risks divergence over time. Rationale aligns with R5.
- **Differentiate "not attempted" (`undefined`) from "attempted and failed" (`Error`)** in the thrown error's message. Both are partial-failure but they imply different operator response: not-attempted likely recovers on re-run; attempted-and-failed-unsafe is a duplicate-suspect that may need manual reconciliation. Counts in the message let the operator make that call.
- **Escalate even on `errorCount > 0` with `undefinedCount === 0`** (the "trigger error was the last slot" edge case). A single unsafe failure during inception still leaves a study with one missing task and broken wiring — semantically identical to the broader partial-failure case. Treat all incomplete batches uniformly.
- **Plain `Error` with attached own properties, not a typed `BatchAbortedError` class.** One throw site, two catch sites, neither does `instanceof` discrimination today. `Object.assign(new Error(msg), { attempted, created, failedUnsafe, notAttempted, kind: 'batch-aborted' })` carries the structured data with zero new files. Add a string `kind` discriminator so future code can branch on shape via property check. If a future caller genuinely needs `instanceof` (e.g., to differentiate this from network errors), refactor to a class then — adding a class later is cheap; living with a speculative one indefinitely is not.
- **Extend `CascadeTracer` with a `recordBatchOutcome({ attempted, created, failedUnsafe, notAttempted })` method** and surface in `toActivityLogDetails()` only when `failedUnsafe > 0 || notAttempted > 0`. Mirrors the `narrowRetrySuppressed` "emit only on signal" pattern (`cascade-tracer.js:100`) so the common case stays clean.

---

## Open Questions

### Resolved During Planning

- **Should the fix touch `runParallel` itself?** Resolved: no. The abort-on-first-unsafe semantic is documented (R1-7), tested (client.test.js:629-741), and load-bearing for duplicate prevention. The bug is invisibility at the caller layer, not the abort itself.
- **Should we auto-retry undefined slots once?** Resolved: no, per scoping. Defer until incident frequency justifies it; the post-flight sweep needs to ship first to make retries safe.
- **Should we add a force-resume mode for inception (bypass double-inception guard)?** Resolved: no. Manual cleanup is acceptable; force-resume is a foot-gun without sweep-class duplicate detection.
- **Should `errorCount > 0 && undefinedCount === 0` (last-slot-failed) also escalate?** Resolved: yes (Key Technical Decisions). Any incomplete batch is a failure for inception's purposes.

### Deferred to Implementation

- **Exact wording of the operator-facing summary** within the 180-char budget. Sketched below; final wording during implementation.

### Deferred to Future Work (captured for future planners)

- **Auto-retry of the `undefined` bucket may be duplicate-safe and was rejected on overly-conservative grounds.** The duplicate-prevention rationale that justifies `runParallel`'s abort-on-first-unsafe applies to slots that *may have succeeded server-side* despite a client-side error — those are the `Error` bucket. The `undefined` bucket consists of slots a worker never picked up — they were never sent to Notion at all, so retrying them carries zero duplicate risk by definition. A single sequential pass over only the `undefined` bucket after the parallel batch finishes would convert most transient single-error incidents from "partial-failure requires cleanup" to "fully recovered" without depending on the deferred PR E2 sweep. Out of scope for this minimal-fix plan (per the scoping decision), but the architectural reasoning is preserved here so the next planner doesn't have to re-derive it. Triggers for revisiting: incident frequency post-deploy, or a follow-up plan that wants to ship recovery automation.

---

## Implementation Units

- U1. **Detect partial-failure in `createStudyTasks` and throw a structured Error**

**Goal:** Make `createStudyTasks` fail loud whenever the underlying batch did not run to completion, preserving the operator-facing breakdown.

**Requirements:** R1, R2, R3.

**Dependencies:** None.

**Files:**
- Modify: `src/provisioning/create-tasks.js` (count `undefined` and `Error` slots separately after `createBatch`; throw a plain `Error` with `kind: 'batch-aborted'` and structured count fields when either is non-zero)
- Test: `test/provisioning/create-tasks.test.js` (extend — partial-failure paths)

**Approach:**
- After the existing `createBatch` call, partition `createdPages` into three buckets in one pass: real page objects (current `successes` filter), `Error` instances, and `undefined`/missing slots.
- **Bucket invariant:** `successes.length + errorCount + notAttemptedCount === entries.length`. If this invariant fails, runParallel's return shape has drifted and the partition logic is undercounting. Surface as a different error (e.g., message prefix `runParallel contract drift:`) so the failure mode is distinguishable from the partial-batch case in test output and Activity Log.
- When both bucket counts are zero, current behavior is unchanged — populate `idMapping`, return result, no throw.
- When either bucket is non-zero, populate `idMapping` from successes (so the catch block has visibility into what survived for any future cleanup tooling), call `tracer.recordBatchOutcome(...)`, then throw a plain `Error` with `kind: 'batch-aborted'` and own properties `attempted`, `created`, `failedUnsafe`, `notAttempted`. Message shape: `"Inception batch incomplete: created ${created}/${attempted}, ${failedUnsafe} failed (transient Notion error), ${notAttempted} not attempted. Archive partial tasks and re-run."`. Implementer adjusts to fit the 180-char budget per `inception.js:291`.
- Construct via `Object.assign(new Error(msg), { kind: 'batch-aborted', attempted, created, failedUnsafe, notAttempted })` — no class hierarchy, fields are still queryable from the route-level catch and from tests via `error.kind`, `error.notAttempted`, etc.
- **Phase timing on the throw path:** wrap the `createBatch` call + bucket counting + throw inside a `try/finally` so `tracer.endPhase('createStudyTasks')` always fires, even when the function throws. Without this, `_activePhases` retains the start mark and `toActivityLogDetails().timing.phases.createStudyTasks` silently drops out of the failure-path Activity Log entry — exactly where post-mortem diagnosis needs it.

**Execution note:** Test-first. The new test scenarios are the contract; the production change is small enough that implementing-then-testing risks under-specifying the error shape.

**Patterns to follow:**
- `Error` subclass shape: keep small, no class-level magic, just `super(message)` + property assignment.
- `successes` filter pattern at `src/provisioning/create-tasks.js:287` — keep the filter; just add the partition and the throw.

**Test scenarios:**
- **Happy path:** all entries return real page objects → `idMapping` populated, no throw, return shape unchanged from today (pin via existing test if covered, otherwise add).
- **Edge case:** zero entries (empty levels) → no throw (we never attempted a batch, no abandonment to escalate).
- **Error path:** 1 `Error` slot, 0 `undefined` slots → throws Error with `error.kind === 'batch-aborted'`, `error.failedUnsafe === 1`, `error.notAttempted === 0`, `error.created === N-1`.
- **Error path:** 0 `Error` slots, K `undefined` slots → throws with `failedUnsafe=0, notAttempted=K, created=N-K`. (Hard to construct from a unit test without the full client; mock `createPages` to return a mixed array directly.)
- **Error path:** mixed — 1 `Error` slot, K `undefined` slots → throws with all counts populated.
- **Error path:** error message length ≤180 chars for any combination of counts up to 1000 entries (regression-proof against `inception.js:291` slicing).
- **Edge case (invariant guard):** if `createPages` returns an array containing a value that is neither a page object, `Error`, nor `undefined`, throw a `runParallel contract drift:`-prefixed Error rather than silently undercounting. Pin this so future runParallel evolution that adds a new slot shape fails loud rather than recreating the invisibility this plan fixes.
- **Integration:** `idMapping` is populated for the survivor slots before throw, so a future cleanup tool can reach them.

**Verification:**
- Existing happy-path inception tests still pass without modification.
- New partial-failure tests fail before the change and pass after.
- The thrown error carries `kind: 'batch-aborted'` plus machine-readable count fields, not just a string.

---

- U2. **Surface batch outcome counts via `CascadeTracer` → Activity Log details**

**Goal:** When a batch is incomplete, the Activity Log entry's body diagnostics block reports counts inline, so future incidents are debuggable without Railway log archaeology.

**Requirements:** R4.

**Dependencies:** U1 (the throw populates the tracer just before throwing).

**Files:**
- Modify: `src/services/cascade-tracer.js` (add `recordBatchOutcome` + serialize in `toActivityLogDetails`)
- Modify: `src/services/activity-log.js` (extend the body-builder around line 69 to surface new counts when present)
- Test: `test/services/cascade-tracer.test.js` (extend — new method + serialization)
- Test: `test/services/activity-log.test.js` (extend — body lines for new counts)

**Approach:**
- Add `recordBatchOutcome({ attempted, created, failedUnsafe, notAttempted })` storing the latest values (overwrite on repeat call — for inception there's only one batch; for add-task-set possibly two but the latter is the operator-facing one).
- In `toActivityLogDetails()`, emit `batchOutcome: {...}` only when `failedUnsafe > 0 || notAttempted > 0` — same conditional pattern as `narrowRetrySuppressed` at `cascade-tracer.js:100`.
- In `activity-log.js` body-builder, after the existing `narrowRetrySuppressed` line, add: when `details.batchOutcome` is present, emit a bullet line `Batch incomplete: created X of Y (Z failed unsafe, W not attempted — runParallel abort).` Wording final during implementation.

**Patterns to follow:**
- Tracer "emit only on signal" pattern at `cascade-tracer.js:100`.
- Activity-log body-builder at `services/activity-log.js:69-70`.

**Test scenarios:**
- **Happy path (no signal):** `recordBatchOutcome({ attempted: 5, created: 5, failedUnsafe: 0, notAttempted: 0 })` → `toActivityLogDetails()` does NOT include `batchOutcome` key.
- **Edge case (only failedUnsafe):** counts include `failedUnsafe=1, notAttempted=0` → details includes `batchOutcome` with all four fields.
- **Edge case (only notAttempted):** counts include `failedUnsafe=0, notAttempted=70` → details includes `batchOutcome`.
- **Activity-log body line:** when `details.batchOutcome` is present, the body builder emits exactly one bullet line containing all four counts.
- **Activity-log body line absent:** when `details.batchOutcome` is absent, the body builder does not emit the line (no `undefined` numbers leaking into output).

**Verification:**
- Re-running U1's mixed-failure test scenario through a route-level integration test (U3) shows the new line in the Activity Log body.

---

- U3. **Verify route-level failure-path coverage for the new throw**

**Goal:** Inception and add-task-set routes correctly surface the batch-aborted Error (kind: 'batch-aborted') through their existing failure paths (Activity Log `failed`, study comment posted, `reportStatus error`, Import Mode disabled), AND those paths are resilient to the same Notion brownout that triggered the abort. Expected to require at most a `Promise.all` → `Promise.allSettled` swap.

**Requirements:** R5, R6.

**Dependencies:** U1, U2.

**Files:**
- Modify: `test/routes/inception.test.js` (extend — batch-aborted Error from `createStudyTasks` exercises the existing catch block end-to-end, including resilience-to-Notion-down failure modes)
- Modify: `test/routes/add-task-set.test.js` (extend — same scenarios for the second caller)
- Modify: `src/routes/inception.js` (only if test reveals a real gap — expected: zero or minimal changes; see Notion-down resilience scenarios below)
- Modify: `src/routes/add-task-set.js` (only if test reveals a real gap — expected: zero or minimal changes)

**Approach:**
- Mock `createStudyTasks` to throw a representative batch-aborted Error after the existing setup phases.
- Assert the existing failure path runs: `reportStatus(error, ...)`, `activityLogService.logTerminalEvent({ status: 'failed', ... })`, `studyCommentService.postComment(...)`, `finally` block disables Import Mode, `tracer.toActivityLogDetails()` is called and its return value is included in the terminal event details.
- Assert the failure summary in both Activity Log and study comment contains the operator-actionable text (created/attempted/failedUnsafe/notAttempted breakdown).
- **Notion-down resilience (new emphasis from doc-review).** The catch block currently uses `Promise.all` over three Notion-bound calls. When the underlying batch failure is itself caused by Notion degradation (the dominant trigger condition), the catch block's three calls are likely to hit the same brownout. `Promise.all` rejects on first failure, so a single inner rejection can drop the Activity Log write — silently recreating the invisibility this plan is trying to remove. Test scenarios below pin the desired behavior; if the existing source uses `Promise.all` and those scenarios fail, the minimum patch is to switch to `Promise.allSettled` (or wrap each call in `.catch`) so all three sites attempt independently. This is a localized, low-risk change to the existing catch block.
- If anything else is missing in the existing route code, add the minimum patch to surface counts; expectation is at most the `Promise.all` → `Promise.allSettled` swap.

**Execution note:** Characterization-first. Run the new tests against current source to confirm the existing catch block behaves as expected, before deciding whether any source change is needed. Expect the resilience scenarios to fail under current `Promise.all` — that's the signal to apply the swap.

**Patterns to follow:**
- Existing test pattern at `test/routes/inception.test.js:496-512` (`mocks.createStudyTasks.mockRejectedValue(new Error('Rate limited'))` → assert `status: 'failed'` flows). Replace the rejection value with a batch-aborted Error and assert the count fields propagate to the terminal event details.

**Test scenarios:**
- **Inception route — happy failure path:** `createStudyTasks` throws batch-aborted Error → Activity Log terminal event has `status: 'failed'`, summary contains breakdown, details contain `batchOutcome` and `timing.phases.createStudyTasks`.
- **Inception route — comment shape:** study comment posted with the same operator-actionable summary; `String(error.message || error).slice(0, 180)` does not truncate the breakdown awkwardly.
- **Inception route — status report:** `reportStatus` called once with `error` severity and the failure message.
- **Inception route — finally invariant:** `finally` block fires — Import Mode patched to `false` even on the throw path. (Likely already covered; confirm.)
- **Inception route — Notion-down resilience (Activity Log):** when `activityLogService.logTerminalEvent` rejects, `reportStatus` and `studyCommentService.postComment` still attempt and complete. Original error is rethrown unmodified. If this fails under current source (`Promise.all`), apply the `Promise.allSettled` patch.
- **Inception route — Notion-down resilience (status report):** when `reportStatus` rejects, the other two calls still attempt.
- **Inception route — Notion-down resilience (worst case):** when all three calls reject, the original batch-aborted error still surfaces upstream (the existing inner `try { } catch { /* don't mask original error */ }` at `inception.js:304` covers this; pin it).
- **Add-task-set route:** mirror of all the above for the second call site.

**Verification:**
- Both routes' failure paths exercise the new throw end-to-end with at most a `Promise.all` → `Promise.allSettled` swap. Any larger source change is documented and re-reviewed.

---

- U4. **Document behavior + ship operator runbook for partial-failure recovery**

**Goal:** Codify the fix in `ENGINE-BEHAVIOR-REFERENCE.md` so future contributors know the contract, AND ship a runbook so an operator hitting a batch-incomplete failure can recover without dev intervention. Recovery is a load-bearing part of this fix — without it, the plan trades silent-broken for loud-broken-and-stuck.

**Requirements:** R3, R4 (operator legibility), and an implicit recovery requirement that doc-review surfaced: visibility without recovery is a regression in some failure modes.

**Dependencies:** U1, U2, U3.

**Files:**
- Modify: `docs/ENGINE-BEHAVIOR-REFERENCE.md` (add a new H3 entry under the dated changelog with the date `2026-05-04` covering: `createStudyTasks` now throws on partial-failure; tracer surfaces counts; recovery procedure lives in the runbook)
- Modify: `docs/BEHAVIOR-TAGS.md` (add `BEH-INCEPTION-BATCH-INCOMPLETE` tag; mirror the §6 Status Roll-Up addition shape from PR #95)
- **Create (required):** `docs/runbooks/inception-batch-incomplete.md` (operator-facing recovery procedure)

**Runbook contents (required):**
- What the `Inception batch incomplete` Activity Log entry means in plain English.
- How to identify the partial Study Tasks for a given study: paginated query of Study Tasks DB with `Study.relation contains <studyPageId>`, collect `[Do Not Edit] Template Source ID` values, diff against the Blueprint DB to confirm the count matches the failure entry's `created` field.
- Archive procedure: bulk-archive the partial tasks via Notion (UI multi-select + archive, or a small ad-hoc script using the engine's `NOTION_TOKEN_1`). Include a copy-paste curl/Node snippet that paginates archive calls.
- Re-run preconditions: confirm `existingTasks.length === 0` before re-triggering the inception webhook (the double-inception guard reads this).
- Safety note: the runbook procedure does not bypass the double-inception guard at the source-code level. It restores preconditions via DB cleanup so the existing guard sees the study as fresh.

**Approach:**
- Follow the dated H3 changelog pattern Tem already uses (see `ENGINE-BEHAVIOR-REFERENCE.md:429` for the 2026-05-01 status-rollup partial-done entry — same shape).
- Runbook is a single markdown file, ~150-300 words plus one or two code blocks. Tight and operator-actionable, not theoretical.
- The error message thrown by U1 should reference the runbook path so operators reading the Activity Log have a discoverable next step.

**Test scenarios:**
- Test expectation: none — documentation-only changes.

**Verification:**
- Link from the new behavior-reference entry to this plan file AND to the new runbook.
- The runbook's Notion query shape works against a real study (manual verification using Ionis HAE 001 as the test case before this fix deploys).
- The U1 error message text references the runbook path (e.g., `docs/runbooks/inception-batch-incomplete.md`) within the 180-char budget — possibly via a short token like `(see runbook)` if the path itself doesn't fit.

---

## System-Wide Impact

- **Interaction graph:** Affects two routes (inception, add-task-set) via one shared service (createStudyTasks). Both routes already have correct catch blocks; no new pathways introduced. The fix's reliability depends on the catch blocks themselves running to completion under Notion-degraded conditions — see U3 Notion-down resilience scenarios.
- **Error propagation:** New batch-aborted Error propagates from `createStudyTasks` → caller's `catch` → existing terminal-event/comment paths. Same shape as today's `Rate limited` test scenario at `test/routes/inception.test.js:496`.
- **State lifecycle risks:** Partial Study Tasks remain in production after a failed batch (today's behavior, unchanged). The fix makes that visible AND ships an operator runbook (U4) so recovery doesn't require dev intervention. The double-inception guard prevents accidental re-run on partial state; the runbook documents how to restore the precondition (archive partial tasks) so the guard sees the study as fresh on re-run. `finally` block in inception still disables Import Mode — confirmed by U3 tests.
- **API surface parity:** No external API changes. Webhook contract unchanged. Activity Log entry shape gains an optional `batchOutcome` field in `details` when present — backward-compatible (existing consumers ignore unknown keys).
- **Integration coverage:** U3 covers the cross-layer scenario (route → createStudyTasks throw → terminal event + comment + tracer), AND the catch path's resilience to Notion brownouts. Unit tests alone would not prove this end-to-end.
- **Unchanged invariants:**
  - `runParallel` abort-on-first-unsafe semantics (`src/notion/client.js:153-201`) — explicitly preserved.
  - Narrow-retry suppression behavior (`src/notion/client.js:115-127`) — explicitly preserved.
  - Double-inception guard (`src/routes/inception.js:54-67`) — explicitly preserved; partial state still blocks re-run by design. Recovery happens via runbook DB cleanup, not source-level bypass.
  - `idMapping` population semantics — survivor slots still populate `idMapping` even on throw (so any future cleanup tool can find them).
  - Webhook 200-OK fast-ack at `src/routes/inception.js:319-332` — unchanged; the throw fires inside the post-ack async work.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **Loud-broken-without-recovery worse than silent-broken in some failure modes.** Post-fix, an operator hitting partial-failure on a study they're not actively watching may sit in a "failed" state for hours/days, with re-run blocked by the double-inception guard. | U4 ships the recovery runbook (now required, not optional). The runbook gives any operator a complete path from "saw failed Activity Log entry" to "re-ran inception cleanly" without dev intervention. Acceptance criteria: Tem walks through the runbook against Ionis HAE 001 before deploy; if any step requires engine knowledge a non-dev operator wouldn't have, tighten the runbook. |
| **Inception "success" rate appears to drop after fix lands.** Previously-silent partial failures now surface as `failed`. | Expected and desired — this is the user-facing improvement. Communicate to Tem before deploy so the dashboard change isn't surprising. |
| **Catch block uses `Promise.all`; same Notion brownout that caused the abort can drop the failure-logging itself.** | U3 adds explicit Notion-down resilience scenarios. Likely outcome: a `Promise.all` → `Promise.allSettled` swap in the existing catch block, so all three sites attempt independently. Localized, low-risk change pinned by tests. |
| **Operator confusion: "what does 'archive partial tasks' mean?"** | U4 runbook (now required) addresses this end-to-end. The U1 error message references the runbook path so operators have a discoverable next step. |
| **Error shape changes break a future caller of `createStudyTasks`.** | Only two callers exist today, both updated. Plain Error with own properties is additive; the `kind` discriminator lets a future caller branch on shape via property check without `instanceof`. |
| **Tracer `batchOutcome` field collides with downstream Activity Log consumers.** | Field is gated behind `failedUnsafe > 0 \|\| notAttempted > 0` — only present when something is wrong. Existing Activity Log readers (operators, PMs reading the body) read the body bullet list, not the JSON details — no breakage. |
| **Test assertion couples to error message wording.** | Tests should assert on error own properties (`error.notAttempted === 70`, `error.kind === 'batch-aborted'`), not message string contents, except for one explicit message-length-budget regression test. |
| **runParallel return-shape contract drift in a future change recreates invisibility.** | U1 adds an explicit bucket invariant assertion (`successes + errorCount + notAttemptedCount === entries.length`); violation throws a distinct `runParallel contract drift:` error. Forces future contributors to acknowledge the dependency rather than silently undercounting. |
| **PR E1 narrow-retry refactor introduced this gap; PR E2 was supposed to backstop it.** | This plan delivers half of E2's intent (visibility + recovery procedure); the automated duplicate-sweep half remains deferred. If post-deploy data shows narrow-retry suppression is recurring, revisit E2 priority. The `Deferred to Future Work` section preserves the architectural insight that the `undefined` bucket can be safely auto-retried even without E2 — useful when prioritizing the follow-up. |

---

## Documentation / Operational Notes

- **Pre-deploy:** Confirm with Tem that the Ionis HAE 001 partial cleanup will be handled out-of-band (or as a separate operational task — see Scope Boundaries / Deferred to Follow-Up Work) before this fix ships.
- **Deploy signal:** Once deployed, the next inception that hits a transient `unsafe_retry` will produce a `failed` Activity Log entry with the new bullet line. That's the live confirmation.
- **Monitoring:** Watch for Activity Log entries with `status=failed` AND `details.batchOutcome` present in the first week post-deploy. Frequency informs whether to prioritize the deferred E2 sweep + auto-retry follow-up.

---

## Sources & References

- **Diagnostic chat (this session):** Activity Log entry [Inception — Ionis HAE 001](https://www.notion.so/picnichealth/Inception-Ionis-HAE-001-3532386760c281a38713c6774647fa76); Blueprint diff via `Template Source ID` (70 missing IDs identified, all valid in the blueprint, all under 14 created parents — confirms the abandonment is mid-batch, not upstream).
- Related code:
  - `src/notion/client.js:153-201` (runParallel)
  - `src/notion/client.js:115-127` (narrow-retry suppression)
  - `src/provisioning/create-tasks.js:280-290` (the fix site)
  - `src/services/cascade-tracer.js` (whole file)
  - `src/services/activity-log.js:69-70`
  - `src/routes/inception.js:183-209, 270-306, 319-332`
  - `src/routes/add-task-set.js:497-504`
- Related plans:
  - `docs/plans/2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md` (R1-7 batch abort semantics — the deferred mitigation half)
  - `docs/plans/2026-04-20-003-feat-post-flight-duplicate-sweep-plan.md` (PR E2, never shipped — unblocked by this plan but not executed)
- Related tests:
  - `test/notion/client.test.js:629-741` ("batch abort semantics (Unit 4)" — already locks in the lib-layer contract)
  - `test/routes/inception.test.js:496-512` (existing rejected-promise pattern to extend)
- Related pulse logs:
  - `engagements/picnic-health/pulse-log/05.01/001-meg-moderna-cascade-notion-filter-jot.md` (sibling silent-skip observability gap; same "fail loud" remedy)
