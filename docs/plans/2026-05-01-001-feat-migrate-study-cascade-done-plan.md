---
title: "feat: Migrate Study cascade-Done by end-date threshold"
type: feat
status: bookmarked
date: 2026-05-01
bookmarked: 2026-05-01
origin: "Slack DM 2026-04-30 21:47 ET — Meg Sanders (Optemization workspace T0122RG9934, channel D0AKBGZ0EAK, ts 1777650453.921429)"
---

# feat: Migrate Study cascade-Done by end-date threshold

> **BOOKMARKED 2026-05-01.** Meg decided to keep current Migrator behavior as-is; the cascade-Done change is no longer wanted. Plan preserved in case the question reopens (this is now the third pivot on bracket-style inference: D26c killed it 04-27, 04-30 ask wanted it back, 05-01 cancelled). If revived, the Pre-Ship Verification questions (PSV1: scope; PSV2: D26c failure-mode) should be the first conversation with Meg.

## Overview

Extend the Migrate Study webhook's matched-Done overlay to also cascade `Status: Done` to every cascade Study Task whose end date falls strictly before the latest matched-Done task's end date. Adds a new Migration Status option `Asana-matched-cascaded` to preserve provenance.

Triggered by Meg's 2026-04-30 21:47 Slack DM after she observed Group A/C match rates of 18-40% on the studies that shipped tonight (PR #96 — 6 studies via batch-migrate orchestrator). PMs were having to manually mark "obviously done" rows whose end dates fall before clearly-done milestones; this puts that inference in the engine.

---

## Problem Frame

The Migrate Study webhook currently marks a cascade Study Task as Done only when an Asana Exported Task row matches it AND that row's `Completed` checkbox is true. After tonight's batch run shipped 6 studies, Meg observed:

- Group A (Moderna, argenx, Amgen): ~35-40% of cascade Study Tasks matched
- Group C (Ipsen, Pfizer Heme 002, Ionis HAE 001): ~18-29% post-fix

PMs are doing significant manual cleanup. Meg's exact framing (2026-04-30 21:47 ET, Slack DM ts 1777650453.921429):

> "the prompt is matching items as done, but it should also ensure everything with an end date that ends prior to the latest done task is also marked as done. Right now it's not doing that. It's only marking the ones it is matching as done."

The semantic intent: if work is clearly done up through end date X, anything ending before X should also be considered done. PM mental model is timeline-based — completed work cascades backward to anything earlier.

**This pattern was previously killed in D26c (2026-04-27).** Meg's call simplification on 04-27 retired bracket-by-cutoff and sequential closure ("AI was editing dates incorrectly, creating gaps... PMs handle inference manually via the Migration Support callout"). Her 04-30 ask reverses that decision in light of the post-Alexion match-rate reality. **This plan documents the supersession as D27** — bracket logic returns, but in a different shape (end-date ordering on cascade Study Tasks, not SDate-offset cutoff on Blueprint).

---

## Requirements Trace

- R1. After matching marks cascade Study Tasks Done by direct Asana match, ALSO mark Done every cascade Study Task — matched or unmatched — whose end date is strictly before the latest matched-Done end date ("high-water mark").
- R2. Cascade-implied Done rows write `Migration Status = Asana-matched-cascaded` (new option) to preserve provenance.
- R3. Cascade-implied Done rows write `Date Completed = null` to override Notion's Status=Done auto-fill (matches Sanofi D8b precedent).
- R4. The existing matched-Done overlay path is unchanged. Manual Workstream / Item exclusion is mirrored. Tasks already in `cascadeCompletionTargets`, tasks with current Status `N/A`, tasks already `Done`, and tasks without end dates are skipped.
- R5. Success summary (Automation Reporting) reports a new count: `cascade-implied done: N`. Tracer field `cascade_implied_done_count` is set.
- R6. The future-due-date guard Meg mentioned ("completed at date should not be completed nor status marked done if the due date of matching asana task is in the future") was walked back in her 04-30 21:47 message ("this one actually should be fine looking at it again") — no change required here.
- R7. Cascade-Done ids are added to `cascadeIdsMatched` to suppress the existing Blueprint-default sweep, which would otherwise overwrite Migration Status to `Blueprint-default` on the same row.

---

## Scope Boundaries

- Migrator behavior change is the only engine-code scope. No other webhook (`inception`, `add-task-set`, `date-cascade`, `dep-edit`, `status-rollup`) is modified.
- The matched-Done overlay logic itself is unchanged. Only adding a parallel cascade pass.
- No backfill of existing studies. Meg explicitly asked Tem not to re-fire Migrator on existing studies — she will re-run "initiate migration" herself after the fix deploys, on top of in-flight manual edits.
- No auto-creation tooling for the `Asana-matched-cascaded` Notion select option. Notion auto-creates options on first PATCH; if Meg wants a specific color, she configures it in Notion afterward.

### Deferred to Follow-Up Work

- **D27 supersession entry in `engagements/picnic-health/projects/migration/prompts/migrate-study.md`** — capture the D26c → D27 reversal in the institutional spec doc so future readers can trace the bracket-removed-then-rethought arc. Cross-repo (engagement folder, not engine repo). Non-blocking; can land after the engine PR ships. Includes: (1) D27 entry referencing D26c with the post-batch match-rate trigger context; (2) qualified standing rule about manual PM inference (engine now does high-water cascade up to latest matched-Done end date, exclusive); (3) mention of the new `Asana-matched-cascaded` option for filtering cascaded vs directly-matched; (4) Slack DM ts `1777650453.921429` cited as trigger.
- **Sanofi Pre-T1D Tepli-QUEST template update** (Meg's 9:13 ET message, same thread): "It looks like the Sanofi Template is still the old one." Notion data fix, not engine code. Tem handles separately as a Notion ops task — out of this plan.
- **`docs/solutions/` capture** of bracket-removed-then-rethought arc (D26c → D27) plus the Notion-Status-auto-fill-override pattern. The engine repo has no `docs/solutions/` folder yet (gap noted in `pulse-log/04.30/007-migrate-study-end-to-end-shipped-jot.md`). Worth seeding with this case once the change ships.
- **Backfill match-rate lift (the durable fix)** — per-study transformers backfilling `Task Type Tags`, `Milestone`, `Workstream` from source columns before Migrator runs. Raises direct-match rate so the high-water cascade becomes an additive lift rather than primary inference. **Strategic note:** this plan is a bridge, not the destination. The cascade-Done logic compensates for low Group A/C match rates; the durable fix is data quality at the source-row stage. If/when match rates climb above ~70%, the cascade-Done logic becomes a small refinement; until then it's load-bearing.
- **Higher-level decision log entry** — if there's a Meg-or-team-maintained decision log beyond the migration prompt doc, the D27 supersession should land there too. Out of this plan unless Tem identifies a specific file.

---

## Context & Research

### Relevant Code and Patterns

- `src/migration/migrate-study-service.js:280-293` — `cascadeCompletionTargets` build (per-twin max date). The new pass reads from this Map's keys to determine the high-water threshold (cascade-side end dates, not Asana-side).
- `src/migration/migrate-study-service.js:341-350` — existing matched-Done loop. The new cascade-Done loop slots immediately after (between line 350 and the per-migrated-row loop at line 352).
- `src/migration/migrate-study-service.js:193-201` — `studyTaskPages` query already returns full property bodies for every Study Task in the study. The new pass iterates this list — no new I/O.
- `src/migration/migrate-study-service.js:41-45` — `mergeCascadePatch(cascadePatches, cascadeId, {...})` for additive merging (Object.assign-style; later writes overwrite earlier writes on the same property key).
- `src/migration/migrate-study-service.js:297` — `cascadeIdsMatched: Set<cascadeId>` declaration. **U1 must add to this set** so the Blueprint-default sweep skips cascade-Done rows.
- `src/migration/migrate-study-service.js:392-399` — Blueprint-default sweep. Short-circuits on `(ms !== undefined) || cascadeIdsMatched.has(taskPage.id)`. On a first run, cascade-Done rows have no prior `ms`, so `cascadeIdsMatched` membership is the only thing preventing overwrite.
- `src/migration/migrate-study-service.js:401-417, 510-512` — `summary` build + `reportStatus` success message construction. Extend.
- `src/migration/matcher.js:237` — `hasManualWorkstreamTag(properties)` exclusion. Mirror in the new pass (matches `migrate-study-service.js:282-285, 343`).
- `src/notion/property-names.js:58-85` — `STUDY_TASKS_PROPS.STATUS` (status type — write `'Done'`), `STUDY_TASKS_PROPS.DATES` (date-range type — read `.date.end || .date.start`), `STUDY_TASKS_PROPS.MIGRATION_STATUS` (select — write `'Asana-matched-cascaded'`), `STUDY_TASKS_PROPS.DATE_COMPLETED` (date — write `null`).
- `src/notion/properties.js:21-25` — established `endStr = end || start` fallback pattern. Mirror.
- `src/notion/property-names.js:245-248` — `findById(page, propDef)` rename-immune property reader. Use this rather than name-keyed reads.
- `test/migration/migrate-study-service.test.js:270-323` — pattern for asserting on `plan.cascadePatches` after `buildMigrationPlan`. Mirror for new tests.

### Institutional Learnings

- **D26c (2026-04-27, `pulse-log/04.27/001-meg-call-scope-simplification.md` lines 12-25)** — bracket-by-cutoff and sequential closure removed. Standing direction at that time: "Only Asana-explicit `Completed = true` rows are marked Done. PMs handle inference manually via the Migration Support callout." This plan supersedes that as **D27** based on Meg's 2026-04-30 21:47 message and the post-batch match-rate reality.
- **D8b-revised (`pulse-log/04.17/001-sanofi-migration.md` lines 84-90, 142)** — Notion Status `Done` auto-fills `Date Completed = today` unless an explicit value is sent in the same PATCH. Always pair Status writes with Date Completed (real date or `null`). The current matched-Done loop already does this; the new cascade-Done pass must follow the same pattern.
- **D26d (`pulse-log/04.27`)** — the team explicitly removed `Asana-matched-inferred` from the active Migration Status write set. This plan adds back a similar option (`Asana-matched-cascaded`) as a deliberate reversal tied to D27.
- **D15 (`pulse-log/04.17`)** — Manual Workstream / Item rows are PM-managed and excluded from completion overlay. Mirror.
- **PR #88 reporting convention** — quality counters (e.g., `unmatchedRatio`, `lowTierCount`) surface in `Automation Reporting` but never gate the run. Match this for the new `cascadeImpliedDoneCount` counter.
- `~/Documents/Claude/memory/notion-api-guide.md` — Status auto-fill override pattern; select-option auto-create on first PATCH.

### External References

None. Codebase has strong patterns; Notion semantics are covered by `~/memory/notion-api-guide.md`.

---

## Key Technical Decisions

- **Supersede D26c as D27.** Re-introduce bracket-style cascade Done logic, with end-date ordering on cascade Study Tasks (not SDate-offset cutoff on Blueprint). Document in Migration prompt doc + reference back to D26c so the history is traceable.
- **Boundary semantics: strict `<`.** A cascade Study Task ending exactly on the high-water mark is NOT cascaded Done. Matches Meg's "ends prior to" wording.
- **High-water source: cascade Study Task end dates.** Compute `highWaterEnd = max(studyTaskPages[id].Dates.end || .Dates.start for id in cascadeCompletionTargets.keys())`. NOT the Asana-side completed date (which is what the matched-Done loop uses for `Date Completed`).
- **Migration Status: new option `Asana-matched-cascaded`.** Preserves provenance. Notion auto-creates the option on first PATCH (no manual setup required, but Meg can re-color afterward).
- **Date Completed: `null`** for cascade-implied rows. Matches Sanofi D8b precedent. Avoids inventing a date the team didn't record.
- **Skip rules for the new pass:** Manual Workstream / Item; already in `cascadeCompletionTargets`; current Status = `N/A`; current Status = `Done` (defensive, saves PATCH); no end date at all.
- **Add cascade-Done ids to `cascadeIdsMatched`** to suppress the Blueprint-default sweep that would otherwise overwrite `Migration Status` on the same row.
- **Idempotency:** PATCH semantics are no-op when values match. Re-runs are safe. Manual edits stick — once cascade-Done is applied, removing the trigger doesn't undo it.

---

## Open Questions

### Pre-Ship Verification (recommended DM to Meg before merge)

Two ambiguities the adversarial review surfaced that warrant a one-line DM to Meg before the PR merges. Both are cheap to resolve and both materially affect the design:

- **PSV1. Scope: study-wide vs per-Workstream/Milestone vs per-dependency-chain?** Meg's "everything with an end date that ends prior to the latest done task" is ambiguous on scope. The plan picks study-wide (broadest interpretation). If Meg actually meant per-Workstream / per-Milestone / per-chain, the design changes (the high-water mark becomes per-track, not global). Cross-track contamination is a real risk: a study with one milestone completed long ago and another in-flight track active today would mark the in-flight track's earlier tasks Done under study-wide semantics. **Verify before merge.**
- **PSV2. D26c root cause considered addressed?** D26c (2026-04-27) killed bracket logic because (a) AI was editing dates incorrectly, creating gaps; (b) Asana exports lack repeat-delivery rows, mismatching Blueprint cadence. The new logic does NOT edit dates (a) doesn't apply — but it still infers Done from partial Asana data (b) is the same brittleness. **Worth naming D26c's specific failure mode in the heads-up DM and confirming Meg considers it acceptable here.** If she pushes back, the plan needs a stronger guard (e.g., per-Workstream scope from PSV1, or skipping rows in active dependency chains).

If Meg confirms both, the plan ships as-is. If she clarifies narrower scope, U1's high-water computation becomes per-track and additional skip rules apply.

### Resolved During Planning

- **Boundary `<` vs `<=`?** Strict `<` per Meg's "ends prior to" wording. Tasks ending exactly on the high-water mark are NOT cascaded.
- **Migration Status assignment for cascade-implied Done?** New option `Asana-matched-cascaded` (Tem confirmed 2026-05-01).
- **Date Completed value for cascade-implied Done?** `null` (Tem confirmed 2026-05-01; matches D8b).
- **D26c conflict?** Plan as a deliberate D26c → D27 supersession given post-batch match-rate data (Tem confirmed 2026-05-01).
- **High-water source: cascade end date or Asana date?** Cascade end date — that's what Meg's wording specifies ("end date that ends prior to the latest done task").
- **Skip rows currently `N/A`?** Yes. PMs use N/A to explicitly exclude tasks; we should not second-guess.
- **Skip rows currently `Done`?** Yes, defensively. No-op PATCH but avoids unnecessary writes and keeps the patch map smaller.
- **Whether to add cascade-Done ids to `cascadeIdsMatched`?** Yes — confirmed by reading the Blueprint-default sweep at lines 392-399.

### Deferred to Implementation

- **Notion auto-creates the new select option on first write?** `~/memory/notion-api-guide.md` confirms select options auto-create with random color. Verify with first live run; if Meg wants a specific color, she configures in Notion.
- **Tracer field naming.** Suggest `cascade_implied_done_count` and `high_water_end`. Confirm consistent with existing tracer field naming during implementation.
- **Whether to also surface `highWaterEndDate` in Automation Reporting summary or only in tracer.** Recommend tracer-only (debug breadcrumb); revisit if Meg wants it visible in Automation Reporting.
- **Where exactly to put the `'Asana-matched-cascaded'` constant.** Likely `src/migration/constants.js` alongside other Migration Status string constants if such a place exists, otherwise inline in the patch body. Implementer chooses based on existing convention.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
// Slot in src/migration/migrate-study-service.js, AFTER the existing
// matched-Done loop (line 350), BEFORE the per-migrated-row loop (line 352).

// 1) Compute high-water mark from CASCADE-side end dates of matched-Done targets.
let highWaterEnd = null;
for (const cascadeId of cascadeCompletionTargets.keys()) {
  const page = studyTaskPages.find(p => p.id === cascadeId);
  if (!page) continue;
  const dates = findById(page, STUDY_TASKS_PROPS.DATES)?.date;
  const end = dates?.end || dates?.start || null;
  if (end && (!highWaterEnd || end > highWaterEnd)) highWaterEnd = end;
}

// 2) Cascade Done to rows strictly before the high-water mark.
let cascadeImpliedDoneCount = 0;
if (highWaterEnd) {
  for (const page of studyTaskPages) {
    if (cascadeCompletionTargets.has(page.id)) continue;          // already matched-Done
    if (hasManualWorkstreamTag(page.properties)) continue;        // PM-owned
    const currentStatus = readStatus(page);
    if (currentStatus === 'N/A' || currentStatus === 'Done') continue;
    const dates = findById(page, STUDY_TASKS_PROPS.DATES)?.date;
    const end = dates?.end || dates?.start || null;
    if (!end || end >= highWaterEnd) continue;                    // strict < (Meg's "prior to")

    mergeCascadePatch(cascadePatches, page.id, {
      [STUDY_TASKS_PROPS.STATUS.id]: { status: { name: 'Done' } },
      [STUDY_TASKS_PROPS.MIGRATION_STATUS.id]: { select: { name: 'Asana-matched-cascaded' } },
      [STUDY_TASKS_PROPS.DATE_COMPLETED.id]: { date: null },
    });
    cascadeIdsMatched.add(page.id);   // CRITICAL — suppresses Blueprint-default sweep at L392-399
    cascadeImpliedDoneCount++;
  }
}

// 3) Surface in summary + tracer (same U1):
//    plan.summary.cascadeImpliedDoneCount = cascadeImpliedDoneCount;
//    plan.summary.highWaterEndDate = highWaterEnd;
//    tracer.set('cascade_implied_done_count', cascadeImpliedDoneCount);
//    tracer.set('high_water_end', highWaterEnd);
//    success message append: `cascade-implied done: N` (when N > 0)
```

The pass adds zero read-side I/O (`studyTaskPages` is already in scope from line 193). Adds at most one PATCH per qualifying cascade row — merged into `cascadePatches` via `mergeCascadePatch`. Throughput impact: linear in `studyTaskPages.length`, executed once. No new lock surface.

---

## Implementation Units

- U1. **Cascade-Done by end-date threshold + reporting**

**Goal:** Add the high-water-mark cascade-Done pass between the existing matched-Done loop and the per-migrated-row loop, add cascade-Done ids to `cascadeIdsMatched` to suppress the downstream Blueprint-default sweep, and surface the count in the success summary + tracer.

**Requirements:** R1, R2, R3, R4, R5, R7

**Dependencies:** None (engine code only; uses already-loaded `studyTaskPages`).

**Files:**
- Modify: `src/migration/migrate-study-service.js` (insert pass between line 350 and 352; extend `summary` build at lines 401-417; append to success message at line 511; add tracer fields near line 489)
- Modify: `src/migration/constants.js` (add `'Asana-matched-cascaded'` constant if a constants module exists for Migration Status strings; otherwise inline)
- Test: `test/migration/migrate-study-service.test.js`

**Approach:**
- **High-water computation:** `highWaterEnd = max(studyTaskPages[id].Dates.end || .Dates.start for id in cascadeCompletionTargets.keys())`. Skip cascade ids whose page has no `Dates` property at all (defensive). Skip cascade ids whose end date is in the future relative to `today` (defensive — guards against stale cascade dates inflating the high-water; log dropped ids in the tracer).
- **Iteration:** for each `page` in `studyTaskPages`, apply skip rules: already in `cascadeCompletionTargets`, Manual Workstream / Item tag, current Status `N/A` or `Done`, no end date, end date `>=` high-water.
- **Patch:** Use `mergeCascadePatch` so the patch coexists with any other writes on the same cascade id. Write `STATUS = Done`, `MIGRATION_STATUS = 'Asana-matched-cascaded'`, `DATE_COMPLETED = null`.
- **Sweep suppression:** Add cascade-Done page ids to `cascadeIdsMatched` (same Set used by the Blueprint-default sweep at lines 392-399) to suppress its overwrite.
- **Read patterns:** End dates via `findById(page, STUDY_TASKS_PROPS.DATES)?.date?.end || .date?.start` (rename-immune; mirrors `src/notion/properties.js:21-25`). Current Status via `findById(page, STUDY_TASKS_PROPS.STATUS)?.status?.name` (status type, not select).
- **Reporting:** track `cascadeImpliedDoneCount`. Add `summary.cascadeImpliedDoneCount` (number, always present, default 0) and `summary.highWaterEndDate` (ISO date string or null). Append to success message after `low-confidence matches: ${plan.summary.lowTierCount}`: when count > 0, `; cascade-implied done: ${plan.summary.cascadeImpliedDoneCount}` (omit segment when 0). Tracer: `tracer.set('cascade_implied_done_count', N)` and `tracer.set('high_water_end', highWaterEnd)` on every run.

**Patterns to follow:**
- Existing matched-Done loop (`migrate-study-service.js:341-350`) for the patch-merge shape.
- Manual Workstream exclusion (`matcher.js:237` + service lines 282-285).
- Status type write: `{ status: { name: 'Done' } }` (NOT `select` — `Status` is a `status` property type).
- Date Completed null write: `{ date: null }` (matches Sanofi D8b auto-fill override).
- Existing summary message construction at line 511 and tracer.set calls (e.g., `tracer.set('study_id', ...)` at line 489).

**Test scenarios:**
- Happy path: Two cascade tasks matched-Done with end dates 2026-01-15 and 2026-02-10 (high water = 2026-02-10). One unmatched task with end date 2026-01-20. After `buildMigrationPlan`, `plan.cascadePatches` contains a Done patch for the 2026-01-20 task with Migration Status `Asana-matched-cascaded` and Date Completed `null`. `plan.summary.cascadeImpliedDoneCount === 1`. Success message includes `cascade-implied done: 1`. Tracer fields are set.
- Boundary (strict `<`): Cascade task with end date EXACTLY equal to the high-water mark is NOT in the cascade-Done patch set. Verify the patch Map does not include that id with Migration Status `Asana-matched-cascaded`.
- Edge (single matched): Only one matched-Done task → high water = its end date → no tasks before it → `cascadeImpliedDoneCount === 0`.
- Edge (no matches): Zero matched-Done tasks → `highWaterEnd === null` → no cascade-implied Dones. Pass exits early without iterating studyTaskPages. `plan.summary.cascadeImpliedDoneCount === 0`. Success message omits the cascade-implied segment. Tracer field is still set to 0.
- Edge (matched-Done end date in the future relative to `today`): Defensive guard drops it from high-water computation. Tracer logs the dropped id. Other matched-Done tasks still contribute.
- Edge (mixed date shapes): One matched-Done task with date-only end (`'2026-01-15'`), another with datetime end (`'2026-01-15T10:00:00.000-05:00'`). Verify ISO-string lex comparison produces deterministic high-water (the datetime sorts after the date-only on string compare, which is consistent with `<` semantics).
- Edge (matched task without end date): Matched-Done cascade task whose page has no `Dates` property → excluded from high-water computation. Other matched-Done tasks still contribute. Pass continues.
- Edge (single-day task): Cascade task with `Dates.start` only (no `Dates.end`) → uses `start` as effective end date. Participates if `start < highWater`.
- Edge (no Dates property on candidate): Cascade task has no `Dates` property at all → excluded from cascade-Done check (never patched).
- Exclusion (Manual Workstream): Task tagged `Manual Workstream / Item` with end date before high water → NOT cascaded Done. Patch Map does not include it.
- Exclusion (already matched-Done): Task already in `cascadeCompletionTargets` is NOT double-patched. The matched-Done patch's `Date Completed` (real date) and Migration Status `Asana-matched` win; cascade-Done loop does not overwrite.
- Exclusion (current Status `N/A`): Task with Status `N/A` → NOT cascaded Done even if end date is before high water.
- Exclusion (current Status `Done`): Task with Status `Done` already → NOT re-patched (defensive; saves a no-op PATCH).
- Integration with Blueprint-default sweep: Cascade-Done id is added to `cascadeIdsMatched`. Verify the Blueprint-default sweep does NOT overwrite Migration Status to `Blueprint-default` on cascade-Done rows. (Read the final state of `cascadePatches` after `buildMigrationPlan` returns.)
- Integration with per-migrated-row loop (NEW — feasibility-review surfaced): A cascade Study Task qualifies as cascade-Done (its end date < high-water; no matched-Done contributor). A separate Asana migrated row points to it via Production Task relation but is NOT in `cascadeCompletionTargets` (e.g., the migrated row has `Completed = false` or is a repeat-delivery row). The per-migrated-row loop at lines 352-388 may write `Migration Status: 'Asana-matched'` for that twin (line 387 fires conditionally). Verify which write wins and whether the cascade-Done's `Asana-matched-cascaded` is preserved. If the per-migrated-row write clobbers, add a guard so the per-migrated-row write skips when the twin is in `cascadeIdsMatched` from the cascade-Done pass, OR reorder the passes so the per-migrated-row loop runs first.
- Re-run idempotency: Running `buildMigrationPlan` twice on the same fixture data produces identical `cascadePatches` content for the cascade-Done set (no flakiness from object iteration order or string comparison locale).
- PATCH body shape: Assert against documented Notion shapes — `STATUS` uses `{ status: { name: 'Done' } }` (status type), `MIGRATION_STATUS` uses `{ select: { name: 'Asana-matched-cascaded' } }` (select type), `DATE_COMPLETED` uses `{ date: null }`. Per `~/memory/notion-api-guide.md` cautionary tale (PR #91 → #95), assert against documented shape, not against constructed shape.

**Verification:**
- Cascade-implied Done count is exposed via `plan.summary.cascadeImpliedDoneCount`.
- Automation Reporting comment includes `cascade-implied done: N` when count > 0.
- Tracer logs include `cascade_implied_done_count` and `high_water_end` on every run.
- All existing tests pass unchanged (matched-Done logic, Manual Workstream exclusion, Blueprint-default sweep on rows that should still get it).
- New tests for the scenarios above pass.

---

- U3. **Update `docs/MIGRATE-STUDY-WEBHOOK.md`**

**Goal:** Document the new cascade pass + new Migration Status option in the engine repo's PM-facing reference.

**Requirements:** R5 (so PMs reading the doc understand `cascade-implied done` in the success message)

**Dependencies:** U1 (so doc reflects shipped behavior).

**Files:**
- Modify: `docs/MIGRATE-STUDY-WEBHOOK.md`

**Approach:**
- Find the Pipeline shape section (lines 53-60). Add a step describing the cascade-Done pass: "after the matched-Done overlay, mark Done every Study Task whose end date falls strictly before the latest matched-Done end date. Skip Manual Workstream / Item, current Status N/A, and current Status Done."
- Find the completion overlay description (line 109 area). Extend with the high-water-mark behavior and the new Migration Status option.
- Add the new Migration Status option to any property reference: `Asana-matched`, `Blueprint-default`, **`Asana-matched-cascaded` (new)**.
- Document the success message segment: `cascade-implied done: N` — explain what it means in PM terms.
- Note that the D27 supersession is captured in the migration prompt doc (engagement folder; see Deferred to Follow-Up Work for the cross-repo entry).

**Test expectation:** none — doc-only change. Verification via review.

**Verification:**
- New behavior is described in the Pipeline shape.
- New Migration Status option is listed alongside the existing two.
- A PM reading the doc cold could understand what `cascade-implied done: 5` means in Automation Reporting.

---

## System-Wide Impact

- **Interaction graph:** New cascade-Done pass shares the `cascadePatches` Map with matched-Done overlay (lines 341-350), per-migrated-row owner + Migration Status writes (lines 352-388), and Blueprint-default sweep (lines 392-399). `mergeCascadePatch` ensures additive merging within a single property key — but later writes on the SAME property key overwrite earlier ones. This is why U1 must add cascade-Done ids to `cascadeIdsMatched`: otherwise the Blueprint-default sweep would later overwrite Migration Status from `Asana-matched-cascaded` to `Blueprint-default`.
- **Error propagation:** A failure during the new pass would surface as a thrown error in `buildMigrationPlan` and propagate up through the route handler's standard error path. No new error handling required. The pass is pure (in-memory transforms over data already loaded), so the most likely failure mode is a property-shape mismatch in test fixtures, not a production runtime error.
- **State lifecycle risks:**
  - Manual edits to cascade Study Task `Status` STICK across Migrator re-runs because the Migrator only writes Done forward (never reverts). A PM who manually sets a cascade-Done row back to `Not Started` will keep that state until a new Migrator run flips it (only if it's still before the new high-water mark).
  - High-water mark can shift between runs as matched-Done membership changes. A row that was cascade-Done in run 1 might no longer be eligible in run 2 (high water shifted earlier), but it stays Done because the engine doesn't unwind. This is acceptable behavior — manual PM authority over reversal stands.
  - Re-firing Migrator on a study mid-PM-edit could overwrite `Date Completed` from the matched-Done loop if a PM has manually set a date that differs from the Asana contributor's. This is existing behavior, not new — flag in the PR description for Meg's awareness during her re-run.
- **API surface parity:** Only `/webhook/migrate-study` is touched. `inception`, `add-task-set`, `date-cascade`, `dep-edit`, `status-rollup` are unaffected.
- **Integration coverage:** The buildMigrationPlan tests at `test/migration/migrate-study-service.test.js` are already integration-shaped (use a fake notionClient, exercise the full pipeline). Add new tests in this file rather than a separate unit-test file. The "integration with Blueprint-default sweep" scenario in U1 is the critical cross-pass test.
- **Unchanged invariants:**
  - Matched-Done overlay semantics (lines 280-293, 341-350) — only Asana `Completed = true` rows continue to drive direct matched-Done.
  - `Date Completed` source for matched-Done rows continues to be `max(contributor Date Completed → Due Date fallback)` per `matcher.js:241-245`.
  - Manual Workstream / Item exclusion (`matcher.js:237`).
  - Repeat-row exclusion (existing matcher logic).
  - Locking (`withStudyLock` on Production Study page id).
  - Tracer field structure — only adding new fields; never modifying existing fields' semantics.
  - Notion-Version policy — no API version bump required.
  - The Blueprint-default sweep's Migration Status write target (`Blueprint-default`) — unchanged for rows that are NOT in `cascadeIdsMatched`.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Re-introducing inference Meg killed via D26c three days ago | Document supersession explicitly as D27 in migration prompt doc. New Migration Status `Asana-matched-cascaded` makes provenance auditable — PMs can filter "is this row Done because Asana said so, or because the engine inferred?" Pre-merge DM to Meg (PSV1 + PSV2 above) gates the design's premise. |
| **Cross-track contamination from study-wide high-water** (multiple disjoint completed milestones at different points in time) | If PSV1 resolves to "per-Workstream/Milestone," the high-water becomes per-track and contamination is impossible by construction. If study-wide is confirmed, document the trade-off in the engine doc and recommend PMs review Migration Support callout carefully on multi-track studies. |
| **Cascade end-date data quality** — stale/wrong end dates inflate the high-water mark | U1's defensive guard skips matched-Done tasks with end dates in the future relative to `today` (logged in tracer). For past-dated stale data, no automatic guard — PMs review via Migration Support callout. Documented in System-Wide Impact. |
| **Notion select-option auto-create may race or fail** on first PATCH (locked schema, race across parallel runs, etc.) | Pre-create the `Asana-matched-cascaded` option manually in Notion's Migration Status property before deploy. One-minute task that eliminates the race entirely. Recommend matching the color of `Asana-matched` for visual coherence. |
| **Stale cascade-Done from prior runs** stays wrong forever (engine writes Done forward, never reconciles) | Accepted and documented in System-Wide Impact. PMs reconcile manually if a row was cascade-Done in run 1 under a stale high-water and is no longer eligible in run 2. The cost of automatic reconciliation (re-validating every cascade-Done row each run) outweighs the rare-staleness benefit. |
| Notion auto-fills `Date Completed = today` on Status=Done if explicit value not sent | Always send explicit `{ date: null }` in the same PATCH (matches D8b). U1 test scenario asserts the PATCH body contains the explicit null. |
| Cascading Done over PM-set N/A | Skip rule: `currentStatus === 'N/A'` exits before patching. Tested in U1. |
| Cascading Done over Manual Workstream rows | Skip rule: `hasManualWorkstreamTag` exits before patching. Tested in U1. |
| Blueprint-default sweep overwrites cascade-Done's Migration Status | U1 adds cascade-Done ids to `cascadeIdsMatched` so the sweep skips them. Tested in the "integration with Blueprint-default sweep" scenario. |
| New Notion select option doesn't exist on first write | Notion auto-creates select options on PATCH (`~/memory/notion-api-guide.md` confirms). First live run validates. |
| High-water mark unstable across runs | Once cascade-Done is applied, removing the trigger doesn't undo it (Migrator only writes Done forward). Documented in System-Wide Impact. |
| Re-firing Migrator on existing studies overwrites Meg's in-flight manual edits | Operational note: Meg explicitly asked Tem not to re-trigger Migrator on existing studies after deploy. Flag in PR description. |
| Migration Status option color is auto-assigned | Cosmetic only. Meg can re-color in Notion after first live run if desired. Recommend matching `Asana-matched`'s color for visual coherence in board views. |
| Test fixtures drift from production data shape | The test pattern at `test/migration/migrate-study-service.test.js:270-323` uses fakes that mirror real Notion property shapes. Add new fixtures by extending those existing ones rather than building from scratch. |

---

## Documentation / Operational Notes

- **Pre-merge DM to Meg (recommended).** Two questions, one message: PSV1 (scope: study-wide vs per-track) and PSV2 (D26c failure-mode addressed?). Cheap; gates the design's premise. Override only if Tem judges shipping urgency outweighs the scope-confirmation risk.
- **Pre-deploy Notion setup.** Manually pre-create the `Asana-matched-cascaded` option in the Migration Status property in cascade Studies' Study Tasks DB before merging. Match the color of `Asana-matched` for visual coherence. Eliminates the option auto-create race on first run.
- **PR description must call out:** "Do not re-fire Migrator on already-migrated studies after deploy. Per Meg's 2026-04-30 21:47 message, she will re-run `initiate migration` herself once she's done with in-flight SPM edits. The fix becomes available on next Migrator run she initiates."
- **Sanofi template update** is a separate Notion ops task (Meg's 9:13 ET message in the same thread). Tem handles outside this plan.
- **`docs/solutions/`** in the engine repo: this work is a worthwhile seed entry once shipped — the bracket-removed-then-rethought arc plus the Notion-Status-auto-fill-override pattern. The 2026-04-30 jot at `pulse-log/04.30/007` already noted the missing folder as a gap.
- **Post-deploy success criterion.** After Meg's first re-run on a cascade-Done-eligible study: (1) tracer logs show `cascade_implied_done_count > 0` if any matched-Done tasks exist; (2) `Asana-matched-cascaded` option exists in Notion with at least one row tagged; (3) Meg eyeballs the cascaded rows on one study — if more than ~10% look wrong (Done on tasks that shouldn't be), revert and re-scope. PR description names this threshold so Tem and Meg align on revert criteria pre-deploy.
- **Bridge, not destination.** This plan compensates for the 18-40% match rates seen on Group A/C studies. The durable fix is per-study transformers backfilling `Task Type Tags`, `Milestone`, `Workstream` from source columns to raise direct-match rates above ~70%, after which cascade-Done becomes a small refinement rather than primary inference. Captured in Deferred to Follow-Up Work.

---

## Sources & References

- **Origin Slack message:** Optemization workspace (T0122RG9934), DM channel D0AKBGZ0EAK, ts `1777650453.921429`, Meg Sanders 2026-04-30 21:47 ET.
- **Tem confirmations on planning decisions** (2026-05-01): D26c → D27 supersession; new Migration Status option `Asana-matched-cascaded`; `Date Completed = null` for cascade-implied rows.
- Related code: `src/migration/migrate-study-service.js`, `src/migration/matcher.js`, `src/notion/property-names.js`, `src/migration/constants.js`, `src/notion/properties.js`
- Related plans: `docs/plans/2026-04-22-001-fix-meg-apr21-feedback-plan.md` (Meg-feedback-batch pattern reference), `docs/plans/2026-04-30-001-fix-migrate-study-gate-error-routing-plan.md` (recent Migrator change pattern)
- Related pulse logs: `pulse-log/04.27/001-meg-call-scope-simplification.md` (D26c origin), `pulse-log/04.17/001-sanofi-migration.md` (D8b auto-fill rule), `pulse-log/04.30/008-moderna-batch-migrate-shipped-jot.md` (post-batch match-rate context)
- Related PRs: #88 (quality-counter reporting convention), #96 (2026-04-30 batch-migrate orchestrator)
- Memory: `~/Documents/Claude/memory/notion-api-guide.md` — Status auto-fill pattern, select-option auto-create on first PATCH
