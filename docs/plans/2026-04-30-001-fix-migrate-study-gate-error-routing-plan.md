---
title: "fix: Migrate Study gate-error reporting routes to wrong target"
type: fix
status: active
date: 2026-04-30
---

# fix: Migrate Study gate-error reporting routes to wrong target

## Overview

The `POST /webhook/migrate-study` route reports gate failures and unexpected errors to the wrong Notion page in almost every failure mode, causing the user-facing report PATCH to 400 silently and leaving PMs with **no visible signal** in Notion when the migration aborts. The fix carries the resolved Production Study page id on `MigrateStudyGateError` so the catch can route reports correctly, plus tightens swallowed-error visibility and tracer logging on the failure path.

This is also the first opportunity to close a real test-coverage gap: the existing tests cover only the two extremes (success path → Production Study; pre-resolution gate → Exported Studies) and miss the entire middle band of post-resolution gate failures, which is where the production bug lives.

---

## Problem Frame

**Observed (2026-04-30T14:58:24Z, Railway logs after a button click on the Exported Studies DB):**

```
POST /webhook/migrate-study 200 1ms
[migrate-study] unhandled: MigrateStudyGateError:
  Study Tasks count 0 < minimum 100 (inception prerequisite).
  at buildMigrationPlan (src/migration/migrate-study-service.js:193)
  at runMigrateStudyPipeline (src/migration/migrate-study-service.js:443)
```

PM clicked the button, the gate fired correctly (Production Study had 0 Study Tasks — inception not run), but **nothing showed up in Notion**: no red banner in Automation Reporting, no Study comment, no observable change anywhere. The PR #79 contract claims "Red banner in Automation Reporting + a comment on the Study page → gate failed". That contract is broken for 12 of the 13 gate codes.

**Why it fails:**

1. `runMigrateStudyPipeline` declares `let studyPageId = null;` at line 426, then assigns it at line 432 — **after** `buildMigrationPlan` returns successfully.
2. Every gate failure throws inside `buildMigrationPlan`, so the outer `studyPageId` stays `null`.
3. The catch block at line 459 falls back to `reportTarget = studyPageId || exportedStudyPageId`, which evaluates to `exportedStudyPageId`.
4. The Exported Studies DB schema does **not** have an Automation Reporting property — `reportStatus` 400s.
5. The 400 is wrapped in `.catch(() => {})` (lines 473, 482), so it's swallowed without a log line.
6. PM sees nothing, clicks again, hits the same wall.

The only gate that's reported correctly today is `production_study_relation`, because that one fires *before* Production Study is resolvable, and the Exported-Studies fallback is genuinely the right target there.

**Twelve gates currently silent:** `import_mode_on`, `contract_sign_empty`, `exported_study_relation_mismatch`, `exported_study_relation_count`, `schema_migrated_tasks`, `migrated_tasks_empty`, `migrated_count_low`, `migrated_count_high`, `migrated_count_mismatch`, `study_tasks_low`, `carryover_study_missing`, `unmatched_completed_ratio`, `low_tier_cap`.

---

## Requirements Trace

- R1. After this change, every `MigrateStudyGateError` thrown from `buildMigrationPlan` after the Production Study page is resolved must report on the **Production Study** page, not the Exported Studies row.
- R2. Pre-resolution gate failures (`production_study_relation` only, today) must continue to report on the **Exported Studies** row, since the Production Study target is unknown.
- R3. When a `reportStatus` or `postComment` call fails inside the catch path, the failure must leave at least a `console.warn` log line — never an empty swallow.
- R4. The `CascadeTracer` log must be emitted on **both** success and failure paths so post-mortem debugging has the same instrumentation either way.
- R5. Test coverage must include at least one post-resolution gate scenario that asserts reports route to the Production Study page id.
- R6. The webhook contract documented in `docs/MIGRATE-STUDY-WEBHOOK.md` ("red banner in Automation Reporting + Study comment on every gate failure") must hold for all 13 gate codes after the fix.

---

## Scope Boundaries

- Not changing the **gate logic itself** — every threshold, gate code, and order-of-checks stays as-is.
- Not redesigning the report fallback to also write a Study comment when Automation Reporting is missing on the target — orthogonal UX improvement, can be a follow-up if PMs still hit the gap.
- Not touching `withStudyLock` / lock-key resolution (PR #79 follow-up `e8c2451` already serializes against Inception correctly).
- Not adding Activity Log integration to migrate-study — explicitly out per PR #79 ("one-time per-study operations").
- Not changing the `body.source.user_id` extraction in the route — separate concern (Notion automation payload shape).
- Not threshold tuning (`MIGRATE_*` env vars stay at defaults).

### Deferred to Follow-Up Work

- Investigate whether `studyCommentService.postComment` succeeds on the Exported Studies row even when `reportStatus` 400s, and use it as a secondary surface so the user always sees something. Defer until we observe whether R3's `console.warn` logs actually surface a separate class of failures we don't already understand.
- Capture `studyName` on the gate error too so failure comments can name the study even when `buildMigrationPlan` throws before returning. Low value; the comment is posted on the right page already.

---

## Context & Research

### Relevant Code and Patterns

- `projects/engine/src/migration/migrate-study-service.js`
  - `MigrateStudyGateError` class at lines 22-28 — the error carries a `details` object today (with `code` and a few gate-specific fields), but no `studyPageId`.
  - `buildMigrationPlan` lines 76-376 — Production Study is resolved at line 87 (`const studyPageId = prodStudyIds[0];`) before any of the 12 post-resolution gates throw.
  - `runMigrateStudyPipeline` catch at lines 459-485 — `reportTarget = studyPageId || exportedStudyPageId` is the routing decision; both async reports use `.catch(() => {})`.
- `projects/engine/src/routes/migrate-study.js`
  - `processMigrateStudy` lines 28-50 — `tracer.toConsoleLog()` only runs on success (line 49 sits after the awaited pipeline call, so a thrown error skips it).
  - `handleMigrateStudy` lines 52-67 — final unhandled catch logs `[migrate-study] unhandled:` (the line we observed in production).
- `projects/engine/test/migration/migrate-study-service.test.js`
  - Lines 179-209 — success-path test asserts reports target `'study-1'`, never `'exported-1'`.
  - Lines 211-241 — pre-resolution gate test (`production_study_relation`) asserts reports target `'exported-1'`.
  - **Gap:** zero coverage for the post-resolution gate band (`import_mode_on`, `contract_sign_empty`, `study_tasks_low`, etc.) — the bug shipped because the contract those tests exist to enforce isn't asserted for these codes.

### Comparable Engine Patterns

- `projects/engine/src/routes/inception.js` and the inception service follow the same shape (200 → flightTracker → withStudyLock → pipeline). Inception's webhook trigger is the Production Study itself, so it doesn't have the dual-target problem migrate-study has. Useful as the structural reference but not a 1:1 fix template.
- Defensive retry pattern in `projects/engine/src/services/activity-log.js` (PR #80) — when a Notion 400 has a known recoverable cause, log + retry once. Same instinct applies here: don't silently swallow.

### Institutional Learnings

- `engagements/picnic-health/pulse-log/04.30/004-carryover-agent-dispatch-jot.md` — confirms migrate-study webhook is treated as a fully-merged surface; carryover is a separate prerequisite. The fix preserves that contract.
- Pre-PR #79 `migrate-study.md` v2.4 prompt (line 414): the manual prompt halts with "one-liner + relevant context + next action for operator." Engine fix should preserve the "next action" affordance — `study_tasks_low` should clearly tell PM "run Inception first."

### External References

- None needed — this is a localized correctness fix in an internal webhook with full source access.

---

## Key Technical Decisions

- **Carry `studyPageId` on the error, not in a thread-local.** `MigrateStudyGateError` already has a `details` bag; promoting `studyPageId` to a top-level property keeps the catch reading clean (`err.studyPageId`) and avoids reaching into `err.details`. The `details.code` field stays the gate-code source of truth.
- **Three-tier fallback in the catch.** Read `err.studyPageId` first (gate that knew Production Study), then outer `studyPageId` (success-path got partway, then a non-gate error threw), then `exportedStudyPageId` (pre-resolution failure). Preserves the legitimate Exported-Studies fallback for `production_study_relation` while routing every other gate correctly.
- **`console.warn` on swallow, don't promote to throw.** The outer await is wrapped in `Promise.all`; promoting one report failure to a throw would skip the second report and the `finally`. A warn line gives us logs without changing control flow.
- **Tracer log moves into a `finally`-equivalent shape in the route.** Emit the tracer log regardless of pipeline outcome so failed runs have the same diagnostic surface as successful ones.
- **Test the gate that actually shipped broken.** Add explicit coverage for `study_tasks_low` (the exact gate the user hit) and one or two other post-resolution gates to lock the contract in.

---

## Open Questions

### Resolved During Planning

- *Should we add a Study comment fallback when `reportStatus` 400s?* — Deferred. First land the routing fix and the swallow-logging, observe whether `console.warn` lights up any other unhandled failure modes, then decide.
- *Should `MigrateStudyGateError` carry `studyName` as well?* — No. `postComment` is keyed by study id, and the message body already includes the gate text. Adding `studyName` is cosmetic and noisy.
- *Is the Exported Studies fallback ever right after this fix?* — Yes, exactly when `err.studyPageId` is unset, which today means `production_study_relation`. Preserve it.

### Deferred to Implementation

- The exact phrasing of `study_tasks_low` user-facing copy may want a "run Inception first" hint. Implementer can adjust the message string while keeping the gate code stable.

---

## High-Level Technical Design

> *Directional sketch. The implementing agent should treat it as context, not code to reproduce.*

```
buildMigrationPlan(notionClient, exportedStudyPageId):
    page = getPage(exportedStudyPageId)
    studyPageId = single Production Study relation
        or throw GateError(code='production_study_relation')   # studyPageId not yet known

    # FROM HERE ON, every GateError carries studyPageId:
    studyPage = getPage(studyPageId)
    if importMode on:    throw GateError('import_mode_on', studyPageId)
    if contract empty:   throw GateError('contract_sign_empty', studyPageId)
    ... 10 more gates, each carrying studyPageId ...

runMigrateStudyPipeline(...):
    try:
        plan = buildMigrationPlan(...)
        outerStudyPageId = plan.studyPageId
        ... apply ...
    catch err:
        target = err.studyPageId         # ← new: set by post-resolution gates
              || outerStudyPageId        # success-path partial failure
              || exportedStudyPageId     # pre-resolution gate (production_study_relation only)
        await Promise.all([
            reportStatus(target, ...).catch(e => console.warn(...)),  # ← was () => {}
            postComment({studyId: target, ...}).catch(e => console.warn(...)),
        ])
        throw err
    finally:
        if armed: clear Import Mode

route handler:
    try {
        await runMigrateStudyPipeline(...)
    } finally {
        console.log(tracer.toConsoleLog())   # ← new: emit on success AND failure
    }
```

The change set is intentionally additive: no gate code names change, no return shapes change, no public API moves. The only behavior change observable from outside the service is "errors land on the right page now" and "report-swallow failures appear in engine logs."

---

## Implementation Units

- U1. **Carry `studyPageId` on `MigrateStudyGateError` for post-resolution gates**

**Goal:** Make every gate error thrown after Production Study is known carry the resolved page id, so downstream code can route reports correctly without needing the outer scope to have committed `studyPageId`.

**Requirements:** R1, R2

**Dependencies:** None.

**Files:**
- Modify: `src/migration/migrate-study-service.js`
- Test: `test/migration/migrate-study-service.test.js`

**Approach:**
- Extend `MigrateStudyGateError` constructor to accept and expose `studyPageId` as a top-level property (beside `name`, `message`, `details`).
- In `buildMigrationPlan`, after `const studyPageId = prodStudyIds[0]` (line 87), pass `studyPageId` to every subsequent gate throw — `import_mode_on`, `contract_sign_empty`, `exported_study_relation_mismatch`, `exported_study_relation_count`, `schema_migrated_tasks`, `migrated_tasks_empty`, `migrated_count_low`, `migrated_count_high`, `migrated_count_mismatch`, `study_tasks_low`, `carryover_study_missing`, `unmatched_completed_ratio`, `low_tier_cap`.
- Leave the pre-resolution `production_study_relation` throw at line 82 unchanged (it has nothing to attach).
- Keep `details.code` as the gate-code field of record. Do not move `code` onto the top level.

**Execution note:** Test-first. Write a failing test that asserts `study_tasks_low` thrown from `buildMigrationPlan` carries `err.studyPageId === 'study-1'` before changing the constructor.

**Patterns to follow:**
- Existing `MigrateStudyGateError` shape in `src/migration/migrate-study-service.js:22-28`. Stay minimal — one new property, no helper class.

**Test scenarios:**
- Happy path: `MigrateStudyGateError` constructed with `studyPageId` exposes it as `err.studyPageId` and preserves `err.details.code`.
- Edge case: constructed without `studyPageId` (legacy two-arg signature) leaves `err.studyPageId` undefined and does not throw.
- Post-resolution gates: for each of `import_mode_on`, `contract_sign_empty`, `exported_study_relation_mismatch`, `study_tasks_low`, `carryover_study_missing`, `unmatched_completed_ratio` — drive `buildMigrationPlan` into the failure mode with mocks, assert `err.studyPageId` is the resolved Production Study id.
- Pre-resolution gate: `production_study_relation` continues to throw with `err.studyPageId === undefined`.

**Verification:**
- All existing tests still pass.
- New per-gate tests assert `err.studyPageId` is populated for every gate that fires after Production Study resolution.

---

- U2. **Route catch reports to `err.studyPageId` first; warn on swallowed report failures**

**Goal:** Plumb the new error property through `runMigrateStudyPipeline`'s catch so reports land on the correct Notion page. Replace silent `.catch(() => {})` with `console.warn` so we have engine logs when reporting itself fails.

**Requirements:** R1, R2, R3, R6

**Dependencies:** U1.

**Files:**
- Modify: `src/migration/migrate-study-service.js`
- Test: `test/migration/migrate-study-service.test.js`

**Approach:**
- In the catch at line 459, replace `const reportTarget = studyPageId || exportedStudyPageId` with the three-tier fallback: `err?.studyPageId || studyPageId || exportedStudyPageId`.
- Replace `.catch(() => {})` on both `reportStatus` and `postComment` with a logger that includes the target id, gate code (when present), and the error message:
  `.catch((reportErr) => console.warn('[migrate-study] failed to <reportStatus|postComment> on', target, gateCode, reportErr.message))`.
- Keep the rethrow (`throw err`) — the route handler already catches and logs `[migrate-study] unhandled:`, and the `finally` Import Mode cleanup depends on this control flow.
- Update the inline comment at lines 464-467 to reflect the new routing reality (Exported Studies is now only the third-tier fallback for true pre-resolution gates).

**Patterns to follow:**
- `console.warn` on cleanup error in the existing `finally` block (line 498) — same shape and verbosity.

**Test scenarios:**
- Covers R1: `study_tasks_low` failure routes `reportStatus` and `postComment` calls to the Production Study page id, not the Exported Studies row id.
- Covers R2: `production_study_relation` failure still routes to the Exported Studies row id.
- Covers R3: when the `reportStatus` mock rejects, the catch emits a `console.warn` with the target id and the gate code; the rejection does not propagate, the second report (`postComment`) still runs, and the gate error still rethrows.
- Edge case: when `postComment` mock rejects, same warn behavior; doesn't mask the gate error.
- Integration: when `buildMigrationPlan` succeeds and `applyMigrationPlan` throws (non-gate error mid-write), `err.studyPageId` is undefined but outer `studyPageId` is set — fallback chain still routes to Production Study, Import Mode `finally` still clears.

**Verification:**
- Failing run-through of `study_tasks_low` end-to-end (mocked) writes to Production Study, not Exported Studies; engine logs show no swallowed `.catch(() => {})`.
- Existing success-path test continues to assert reports target Production Study only.
- Existing pre-resolution gate test continues to assert reports target Exported Studies.

---

- U3. **Emit `tracer.toConsoleLog()` on both success and failure paths**

**Goal:** Ensure the structured trace is logged regardless of whether the pipeline succeeded or threw, so post-mortem debugging has consistent instrumentation.

**Requirements:** R4

**Dependencies:** None (independent of U1/U2).

**Files:**
- Modify: `src/routes/migrate-study.js`
- Test: `test/routes/migrate-study.test.js`

**Approach:**
- Wrap the `await runMigrateStudyPipeline(...)` call in `processMigrateStudy` with `try { ... } finally { console.log(tracer.toConsoleLog()); }`.
- Do not swallow the throw — let it propagate to `handleMigrateStudy`'s `flightTracker.track(... .catch(...))`. The `finally` only adds the trace emission.
- `tracer.toConsoleLog()` should never throw (it's a serializer), but if it does, log a single `console.warn` and continue — never let trace emission corrupt the failure signal.

**Patterns to follow:**
- The existing `console.log(tracer.toConsoleLog())` at line 49 — same call, just relocated into a `finally`.

**Test scenarios:**
- Happy path: pipeline resolves; tracer log is emitted exactly once.
- Error path: pipeline rejects with `MigrateStudyGateError`; tracer log is still emitted exactly once before the error reaches `flightTracker`.
- Edge case: tracer's `toConsoleLog` throws synchronously; emission failure logs a warn but does not mask the original error.

**Verification:**
- Spy on `console.log` calls; assert `toConsoleLog` output appears in both passing and failing test runs.

---

- U4. **Update `MIGRATE-STUDY-WEBHOOK.md` to reflect corrected reporting routing**

**Goal:** Bring the published webhook contract in line with the fixed behavior so PMs and the next implementer reading docs trust what they see.

**Requirements:** R6

**Dependencies:** U1, U2 landed.

**Files:**
- Modify: `docs/MIGRATE-STUDY-WEBHOOK.md`

**Approach:**
- In "Dry-run gates (abort before any write)", add a one-line clarification that **all** gate failures except `production_study_relation` now report on the Production Study page; `production_study_relation` reports on the Exported Studies row because the Production Study target is not yet resolvable.
- In "What errors mean" (PM one-pager), reaffirm "Red banner in Automation Reporting on the Production Study + a comment on the Study page" without the implicit caveat that broke before.
- No new sections; this is a tightening pass.

**Patterns to follow:**
- Existing tone and structure of `docs/MIGRATE-STUDY-WEBHOOK.md` — concise, table-heavy, PM-readable.

**Test scenarios:**
- Test expectation: none — documentation-only change.

**Verification:**
- Doc reads coherently against the merged code; no stale claims about "may not show in Automation Reporting."

---

## System-Wide Impact

- **Interaction graph:** No new entry points or webhooks. The change is internal to the migrate-study service, route, and its tests. Inception, dep-edit, copy-blocks, add-task-set, status-rollup, undo-cascade, deletion routes are all unaffected.
- **Error propagation:** Gate errors continue to rethrow from the catch so `handleMigrateStudy`'s flight-tracker logger and the `finally` Import Mode cleanup behave identically. Only the *target* of in-catch reporting changes.
- **State lifecycle risks:** None new. Import Mode arm/clear sequencing in the `finally` block is untouched. The fix never arms Import Mode on a different page than before.
- **API surface parity:** `MigrateStudyGateError` gains an optional `studyPageId` property. No external consumer uses this class directly. Downstream PM ops still match on `err.details.code` exactly as today.
- **Integration coverage:** The new test scenarios for U2 cross the service ↔ Notion-client boundary by mocking `reportStatus` failures. This proves the swallow-warn behavior in a way unit-level Promise mocks alone wouldn't.
- **Unchanged invariants:** Gate-code values (`production_study_relation`, `import_mode_on`, etc.), gate ordering, threshold defaults, payload shapes (`body.data.id` and back-compat keys), and the 200-first response pattern are all explicitly preserved.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A consumer somewhere relies on `MigrateStudyGateError` being a two-arg constructor (only `message`, `details`) | The change is additive — adding an optional third parameter (or accepting `studyPageId` in `details` and re-exposing it) does not break existing callers. Verified in U1 edge-case test. |
| `console.warn` adds log noise that masks legitimate failures | The warn only fires when reporting itself fails — a path that previously dropped silently. Net signal goes up, not down. |
| `tracer.toConsoleLog()` running in `finally` doubles output if a future caller also logs it | Today only `processMigrateStudy` logs the tracer. Move it to `finally` and remove the line-49 invocation in the same change. |
| The "next action" hint in `study_tasks_low` (e.g., "run Inception first") is added inconsistently across other gates | U1 test scenarios cover gate-code stability but leave message phrasing flexible — implementer chooses one phrasing for `study_tasks_low` only and leaves siblings as-is. |

---

## Documentation / Operational Notes

- After merge, post a short summary to the migrate-study Slack thread (or pulse-log jot in `engagements/picnic-health/pulse-log/{MM.DD}/`) confirming the routing fix and pointing at the next pilot study to retest. The very test that triggered this plan (Production Study with 0 Study Tasks) is the natural verification: run Inception on that study, then re-click Migrate Study, and confirm the success-path banner appears in Automation Reporting.
- No migration, rollout flag, or env-var change required. Re-deploy is the only operational step.

---

## Sources & References

- **Primary failure evidence:** Railway logs `2026-04-30T14:58:24.586Z`, `[migrate-study] unhandled: MigrateStudyGateError: Study Tasks count 0 < minimum 100 (inception prerequisite)`.
- **Original feature PR:** [picnic-cascade-engine PR #79](https://github.com/optemization-tech/picnic-cascade-engine/pull/79) — `feat(engine): one-button Asana → Notion migrate-study webhook` (merged 2026-04-30T06:03Z).
- **Related morning fixes (already merged, not in scope here):** [PR #83](https://github.com/optemization-tech/picnic-cascade-engine/pull/83), [PR #84](https://github.com/optemization-tech/picnic-cascade-engine/pull/84), [PR #85](https://github.com/optemization-tech/picnic-cascade-engine/pull/85).
- **Source files:**
  - `src/migration/migrate-study-service.js` (especially lines 22-28, 76-376, 459-485)
  - `src/routes/migrate-study.js` (especially lines 28-50)
  - `test/migration/migrate-study-service.test.js` (especially lines 175-241)
  - `test/routes/migrate-study.test.js`
  - `docs/MIGRATE-STUDY-WEBHOOK.md`
- **Companion prompt for context:** `engagements/picnic-health/projects/migration/prompts/migrate-study.md` v2.4.
- **Pulse-log context:** `engagements/picnic-health/pulse-log/04.30/004-carryover-agent-dispatch-jot.md`.
