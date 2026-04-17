---
date: 2026-04-16
topic: meg-apr-16-feedback-batch
status: requirements-locked (post document-review)
ships_as: 3 PRs (B, C, D) + 3 non-PR items
---

# Meg Apr 16 Feedback — Batch Requirements

Scopes and locks requirements for five items surfaced in Meg's 2026-04-16 live-test feedback on study "Meg Test Apr 16" ([Notion page](https://www.notion.so/picnichealth/Meg-Test-Apr-16-3442386760c28008ba9edc8ebba67f87)). Post document-review, Item 3's direction was reversed (minimal patch over TSID refactor) and Item 2's Bug α was returned to bookmarked status pending Seb's independent investigation.

## Summary Table

| # | Topic | Root cause | PR |
|---|---|---|---|
| 1 | Orphaned duplicate task after Add Task Set click | add-task-set.js strips existing template IDs before create → silent duplicate on single-leaf templates | PR D (guard) + Notion archive |
| 2α | `pull-left` downstream preserves gaps (Apr 14 repro) | `gapPreservingDownstream` shifts uniformly by delta | **Bookmarked** — Seb independent investigation (not in this batch) |
| 2β | `start-left` never tightens downstream siblings (Apr 16 repro) | `start-left` dispatches `pullLeftUpstream` only — no downstream pass | PR B |
| 3 | Repeat Delivery Delivery task starts before QC ends | `applyDeliveryNumbering` renames "#N" → "#(N+1)" *before* `latestDates` lookup; lookup misses on the renamed key and falls through to blueprint-offset formula | PR C (rename-aware name match, ~10 lines) |
| 4 | Default Contract Sign Date silently anchors to today when empty | Silent "today" fallbacks in 3 routes; Notion property has stale default | PR D + Notion tweak |
| 5 | Additional TLF buttons don't tag new tasks "Manual Workstream / Item" | Engine doesn't add the tag; blueprint templates don't carry it (intentional for original TLF) | PR D |

## PR Map

- **PR B — `start-left` downstream pass.** New plan. Surgical dispatch change in `cascade.js` + seeded downstream tightening logic introduced locally (no dependency on PR A since α is deferred).
- **PR C — Rename-aware name match in `add-task-set.js`.** ~10-line fix: normalize `latestDates` keys so the renamed new task (e.g., "Data Delivery #3") correctly matches the most recent production task (e.g., "Data Delivery #2"). Update [ENGINE-BEHAVIOR-REFERENCE.md:59](engine/docs/ENGINE-BEHAVIOR-REFERENCE.md:59) to remove the inaccurate claim that matching is TSID-based — it is name-based by design per PR #18's rationale (blueprint has 9 separate DD subtrees with unique TSIDs; TSID matching would be degenerate).
- **PR D — Provisioning safety batch.** Five tightly-related changes in add-task-set / inception / create-tasks / study-comment:
  1. Single-leaf duplicate guard (Item 1).
  2. Fail-loud on empty Contract Sign Date, all three call sites (Item 4).
  3. Manual Workstream / Item tag on 4 Additional TLF buttons via `extraTags` param to `createStudyTasks` (Item 5).
  4. Generalized error-comment mention-prepend on button-triggered routes, with dedup + bot-carve-out (Item 4 R4e).
  5. Required rewrite of the existing "falls back to today" test in `inception.test.js:588-619` to assert the abort path instead.

PR B is standalone. PR C and PR D both touch `src/routes/add-task-set.js`; sequence by merge order — recommended PR C first, then PR D (PR D's add-task-set changes are in different regions of the file from PR C's lookup-key fix).

### Non-PR items

- **Data cleanup.** Archive orphaned page `34423867-60c2-815b-afa6-e9890a23c405` (Item 1 residue).
- **Notion tweak.** Clear the default value on the Contract Sign Date property in the Studies DB (Item 4a).
- **Comms to Seb.** Brief Seb on Bug α (Apr 14 `pull-left` gap-preservation) findings from 2026-04-15 investigation for independent verification. Bug α stays bookmarked until Seb independently validates or Meg reproduces live. [bookmarked plan](engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md) + [brainstorm](engine/docs/brainstorms/cascade-gap-tightening-requirements.md) remain on disk as reference.

---

## Item 1 — Orphaned duplicate task after Add Task Set click

### What Meg saw

> "I am showing 201 tasks, but the Activity Log shows it only created 200 tasks. It looks like the 'extra' task is a duplicate: Delivery Retrieval Wrap-Up Window 10 appears twice."

### Root cause

Not an inception bug. Inception correctly created 200 tasks. The 201st was created by the "Additional Task Set Creation 4" bot — someone clicked the Final Delivery Retrieval Wrap-Up Window add-task-set button after inception. At [add-task-set.js:280-300](engine/src/routes/add-task-set.js:280), the engine strips existing template IDs from `existingIdMapping` before creation so numbered task sets (TLF #2, #3, …) can co-exist. For a single-leaf non-repeat template that already exists in the study, this strip produces a silent duplicate with no parent, no `Blocked by`, no `Blocking`.

### Requirements

- **R1a. Archive the orphaned page.** Manual archive of `34423867-60c2-815b-afa6-e9890a23c405` in Meg's Apr 16 test study. No code; no PR.
- **R1b. Add single-leaf duplicate guard** (PR D). Before creation in `add-task-set.js`, if the filtered subtree contains a single non-repeat template and that template ID already exists in the study's task set, abort. The abort routes through the error-comment flow defined in Item 4 (R4e) — button presser + configured mentions get an @-mentioned comment on the study page. No tasks are created.

### Non-goals

- No change to numbered task-set logic (TLF #2/#3 behavior). Numbering is working correctly.
- No change to repeat-delivery or additional-site buttons.

---

## Item 2 — Pull-left gap (two separate bugs)

### What Meg saw

- **Apr 14:** shortened Round 3 Committee Review end → Prepare for IRB Review shifted but a new gap opened between them.
- **Apr 16:** dragged Draft ICF start ~45 BD left → "massive gap" between Client Review Round 1: Protocol and Internal Revisions Round 1: Protocol. Internal Revisions's only blocker is Client Review Round 1; she expected it to tighten.

### Root causes (investigation 2026-04-16)

Two distinct bugs under the "gap" umbrella.

**Bug α (Apr 14 scenario) — BOOKMARKED.** `gapPreservingDownstream` in [cascade.js](engine/src/engine/cascade.js) shifts all downstream tasks uniformly by the source delta, preserving pre-existing gaps. This is the bug covered by the existing bookmarked plan ([2026-04-15-001](engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md)). **Not in this batch.** Not reproduced since 2026-04-14. Handed to Seb for independent investigation — if Seb confirms the bug is real (vs. concurrency artifact), we'll ship the existing bookmarked plan in a separate batch. If Seb's investigation finds a different root cause (e.g., multi-replica race), we'll reshape.

**Bug β (Apr 16 scenario) — PR B.** `start-left` mode dispatches `pullLeftUpstream` only. No downstream pass runs at all. Internal Revisions R1: Protocol is a downstream sibling of Draft ICF (both share Client Review R1 as blocker) — unreachable via upstream-only traversal. The task is never touched by the cascade. The Complete Freeze / frozen-task hypothesis Meg raised is ruled out: Client Review R1 is `Not started`, not Done.

The L2 behavior ref [ENGINE-BEHAVIOR-REFERENCE.md:29](engine/docs/ENGINE-BEHAVIOR-REFERENCE.md:29) already specifies *"Upstream then downstream — downstream re-evaluated against blockers"* for `start-left`. Code and contract diverged.

### Requirements (PR B)

- **R2β-1.** `start-left` dispatch in `runCascade` runs a downstream tightening pass AFTER the existing `pullLeftUpstream` pass.
- **R2β-2.** The downstream pass's seed set is `{sourceTaskId} ∪ tasks whose start OR end changed during the upstream pass` — broadened from end-only to cover any upstream task movement. Typically tasks present in `updatesMap` after `pullLeftUpstream` returns.
- **R2β-3.** The new pass implements tight-schedule semantics locally inside PR B: each reachable task's new start = `nextBusinessDay(max(non-frozen blocker end))`, duration preserved. Uses a new function `tightenDownstreamFromSeed(seedIds, updatesMap, taskById)` in `cascade.js`. When Bug α's plan ships later (separately), it refactors `gapPreservingDownstream` to share logic with this new function — not a dependency this batch.
- **R2β-4.** Frozen-task semantics unchanged. Done/N/A blockers are excluded from constraint calculation (current behavior); frozen downstream tasks don't move.
- **R2β-5.** Cross-chain propagation loop structure unchanged. The new pass participates in existing graph-wide stability cap.

**Regression test required (from review):** start-left scenario where downstream sibling has fan-in blockers = `{upstream-pulled-blocker, frozen-blocker}`. Verify frozen blocker is still excluded from constraint calculation (pre-existing invariant inherited from `pullLeftUpstream`).

### Non-goals

- No change to Complete Freeze semantics.
- No change to `push-right`, `pullLeftUpstream`, or `gapPreservingDownstream` behavior.
- No change to parent-subtask roll-up.
- Bug α is **not** addressed in this batch. See Seb comm item above.

---

## Item 3 — Repeat Delivery Delivery task starts before QC ends

### What Meg saw

Activity Log event `3442386760c28113bdb4d7c9f9050794` — repeat-delivery on the Apr 16 study, creating Data Delivery #3 subtree. `Repeat QC` dates `2027-12-08 → 2028-01-03`. `Data Delivery #3` starts `2027-12-07` — one day BEFORE QC ends. Screenshot confirmation from Tem 2026-04-16.

### Root cause (investigation 2026-04-16)

At [add-task-set.js:245](engine/src/routes/add-task-set.js:245), `applyDeliveryNumbering` renames "Data Delivery #2" → "Data Delivery #3" **before** the date-override lookup runs. The `latestDates` map is built at [line 333](engine/src/routes/add-task-set.js:333) using the **original** production names (still "#2"). At [line 360](engine/src/routes/add-task-set.js:360), the override lookup reads using the **renamed** key ("#3") → miss → falls through to blueprint-offset formula at [create-tasks.js:37](engine/src/provisioning/create-tasks.js:37) → Delivery anchors to `contractSignDate + offset 428 = 2027-12-07`. QC/Abstraction names don't contain `#N`, so their lookups succeed and they inherit DD#2's shifted dates (`2027-12-08`). Result: QC shifted, Delivery formula-default, ordering inverts.

Why the Apr 15 audit missed it: that study had no manual date shifts on DD#2, so formula-offset == copy-source by coincidence.

### Requirements (PR C)

- **R3-1. Minimal rename-aware patch.** Normalize `latestDates` keys so the renamed new task matches the most recent production task. Options the implementer can pick:
  - (a) Build `latestDates` using names with `#N` stripped (`/#\d+/g` → `""`), look up with the same normalization.
  - (b) Pre-rewrite existing names from "#N" to "#(nextNum)" when building `latestDates`, so the renamed new task's key matches directly.
  - (c) Do the override lookup *before* `applyDeliveryNumbering` runs, using the original names.
  - All three produce equivalent behavior. Implementer picks the one with the smallest diff.
- **R3-2. Scope confined to** `src/routes/add-task-set.js` (the lookup and keying logic around lines 245–360). No changes to `create-tasks.js`, no changes to how `_overrideStartDate` / `_overrideEndDate` flow downstream.
- **R3-3. Correct the L2 doc.** Update [ENGINE-BEHAVIOR-REFERENCE.md:59](engine/docs/ENGINE-BEHAVIOR-REFERENCE.md:59) to say matching is by **task name**, not by Template Source ID. Add a one-line rationale: "Blueprint has 9 separate delivery subtrees with unique TSIDs; TSID matching would be degenerate for the repeat-delivery copy-from-latest use case. See PR #18." This aligns L2 with the code's actual (and correct) contract.

### Why not TSID refactor (surfaced by document-review)

I initially proposed refactoring to TSID matching as the "principled" fix. Document-review surfaced that this is exactly the bug [PR #18](clients/picnic-health/pulse-log/04.05/01-live-button-testing.md) fixed: the blueprint has 9 separate DD# subtrees with unique TSIDs, and the repeat-delivery button always clones from the same blueprint subtree, so TSID-based matching would silently match the blueprint source rather than the latest production delivery. Reverting to TSID would reintroduce the bug. Name-matching disambiguates via the `#N` suffix, which is why PR #18 moved away from TSID in the first place.

### Non-goals

- No change to the "copy from latest delivery" semantic.
- No change to the numbering logic.
- No blueprint changes (blueprint wiring is correct per investigation).
- No changes to `create-tasks.js` or `_override*` fields.

---

## Item 4 — Default Contract Sign Date + fail-loud validation

### What Meg saw

> "Can we make the default contract sign date either empty or the date of New Page creation?"

### Root cause

Two interacting defaults:

1. **Notion:** the Contract Sign Date property on the Studies DB carries a baked-in default value.
2. **Engine:** [inception.js:74-75](engine/src/routes/inception.js:74), [add-task-set.js:172-173](engine/src/routes/add-task-set.js:172), and [create-tasks.js:215](engine/src/provisioning/create-tasks.js:215) all fall back to `new Date().toISOString().split('T')[0]` (today) when the property is empty. Silently anchors the study to today's date.

Decision (Tem): empty default + fail-loud. All studies are in pre-production testing state; no backfill/audit needed.

### Requirements

- **R4a.** *Notion tweak, non-PR.* Clear the default value on the Contract Sign Date property in the Studies DB.
- **R4b.** *PR D.* Remove the silent "today" fallback in all three locations: `inception.js`, `add-task-set.js`, and `create-tasks.js`. Require Contract Sign Date to be present at every entry point.
- **R4c.** *PR D.* When Contract Sign Date is empty on inception or add-task-set, abort creation before any tasks are made. Exit via the existing `finally` block so Import Mode gets reset. Write the error to Automation Reporting AND post a study-page comment via the existing `study-comment.js` error flow.
- **R4d.** *PR D.* Error comment body: "Cannot activate / add task set — Contract Sign Date is empty. Please set it on the study page and try again."
- **R4e.** *PR D. Generalized pattern for all button-triggered errors.* The error-comment path in `study-comment.js` auto-prepends the button presser's user ID (`triggeredByUserId`, sourced from `source.user_id` per PR #57) to the mention list. Applies to all button-triggered routes: inception, add-task-set, deletion, undo-cascade. Property-change-triggered routes (date-cascade, status-rollup) unchanged.
- **R4e-dedup.** Mentions are deduplicated across `{triggeredByUserId} ∪ COMMENT_ERROR_MENTION_IDS`. If the button presser is already in `COMMENT_ERROR_MENTION_IDS` (e.g., Tem clicking during testing), they are mentioned exactly once, not twice.
- **R4e-bot-carveout.** If the webhook is bot-triggered (`editedByBot === true` or `triggeredByUserId` is a bot user ID), skip the button-presser prepend. The configured `COMMENT_ERROR_MENTION_IDS` still fires as the backstop.
- **R4e-null-safe.** If `triggeredByUserId` is null/undefined (manual API call, webhook without source), skip the prepend. Configured IDs still fire.

### Test rewrite required

`engine/test/routes/inception.test.js:588-619` currently asserts the "falls back to today" behavior. PR D rewrites this test to assert the abort path — `createStudyTasks` NOT called, error comment posted, error written to Automation Reporting, Import Mode reset.

### Non-goals

- No change to the `COMMENT_ERROR_MENTION_IDS` env var or its current contents (Tem, Meg, Seb).
- No change to success-path comment behavior (still suppressed per PR #58).
- No change to the Automation Reporting field semantics — still written as-is; the comment is the added channel.
- No backfill or audit of active studies — all pre-production, in testing mode.

---

## Item 5 — "Manual Workstream / Item" tag on Additional TLF buttons

### What Meg asked

> "For any of the Additional TLF buttons (ie. TLF + Insights + CSR, TLF, TLF + Insights, TLF + CSR), can we make sure when those are added all tasks part of that automation get the 'Manual Tasks' tag added to them? … for repeats it should be added to any tasks being created as part of that automation."

### Clarification from schema

The actual tag in the Study Tasks DB is **"Manual Workstream / Item"** (id `79520630-ac48-45c6-913d-2c29d28eb6fa`, brown). "Manual Tasks" was Meg's shorthand.

### Requirements (PR D)

- **R5-1.** For the four Additional TLF button types — `tlf-only`, `tlf-csr`, `tlf-insights`, `tlf-insights-csr` — every task the button creates has the "Manual Workstream / Item" tag added.
- **R5-2. Injection point: `createStudyTasks` accepts an optional `extraTags: string[]` parameter.** `add-task-set.js` passes `['Manual Workstream / Item']` for the 4 TLF button types, empty array otherwise. Inside `buildTaskBody` in `create-tasks.js`, `extraTags` merge into the task's final `properties.Tags` by name (Notion multi_select accepts `{ name }` — no id needed). This keeps `createStudyTasks` caller-agnostic and avoids a second round-trip Notion PATCH per task.
- **R5-3.** Not applied to: `repeat-delivery`, `additional-site`, or any inception-time task creation.

### Non-goals

- No change to other tags or to blueprint structure.
- No changes to `repeat-delivery` or `additional-site` routes.

---

## Cross-item considerations

### Shared files

- `src/routes/add-task-set.js` — touched by PR C (lookup-key region, lines 245–360) and PR D (guard at ~280–300, Contract Sign Date check at 172–173, `extraTags` pass-through at ~375).
- `src/routes/inception.js` — touched by PR D (Contract Sign Date check at 74–75).
- `src/provisioning/create-tasks.js` — touched by PR D (Contract Sign Date guard at 215, `extraTags` parameter + merge in `buildTaskBody`).
- `src/services/study-comment.js` — touched by PR D (mention-prepend + dedup + bot carve-out).
- `src/engine/cascade.js` — touched by PR B only.

### Ordering

- PR B is fully independent — can ship any time.
- PR C and PR D both touch `add-task-set.js` but in different regions of the file. Recommended merge order: PR C first (tiny, surgical), then PR D (larger, touches more surface). Second merger handles a trivial rebase if any.

### Error-comment flow (from PR D)

PR D generalizes the error-comment mention list to include the button presser on all button-triggered error paths (with dedup + bot carve-out). This becomes shared infrastructure for Item 1's R1b guard and Item 4's R4c abort. The other PRs (B, C) don't post error comments and don't need this.

---

## Success Criteria

- **SC-1.** Study has empty Contract Sign Date → user clicks Activate or any Add Task Set button → receives a clear error comment mentioning themselves + Tem + Meg + Seb (deduplicated; no double-mention if the clicker is in the configured list). No tasks created. Import Mode reset. (PR D)
- **SC-2.** User clicks any TLF/TLF+CSR/TLF+Insights/TLF+Insights+CSR button → all new tasks carry the "Manual Workstream / Item" tag. (PR D)
- **SC-3.** User drag-lefts DD#N's Delivery task start date by some offset, then clicks Repeat Delivery → DD#(N+1)'s Delivery task inherits the shifted start date and still starts AFTER DD#(N+1)'s Repeat QC ends. (PR C)
- **SC-4.** User clicks an Add Task Set button for a single-leaf non-repeat template that already exists in the study → receives an error comment, no duplicate created. (PR D)
- **SC-5.** User drags a mid-chain task's start left with end unchanged (`start-left`) → downstream siblings that share a blocker with the source tighten to the blocker's new end + 1 BD. The gap Meg reported on Apr 16 closes. (PR B)
- **SC-6.** Existing cascade tests pass unchanged. The `inception.test.js:588-619` "falls back to today" test is rewritten to assert abort path and passes.
- **SC-7.** Regression test added for start-left with frozen blocker in downstream sibling's fan-in (PR B).

## Non-Goals (Batch-Wide)

- No change to Complete Freeze semantics (Done / N/A remain invisible to blocker constraints).
- No change to parent-subtask roll-up logic.
- No change to `push-right`, `pullLeftUpstream`, or status-rollup behavior.
- No change to cascadeQueue, FlightTracker, LMBS, Import Mode, or withStudyLock mechanisms.
- No new dependencies.
- No feature flags; behavior changes deploy immediately per current Railway auto-deploy flow. Pre-production / testing-mode environment makes this acceptable.
- No migration of existing studies' data (except the manual archive in R1a).
- **Bug α** (Apr 14 `pull-left` gap-preservation) is bookmarked, handed to Seb for independent investigation. Not shipped in this batch.

## Open Questions

None at scoping time. Implementation-time questions (exact function signature for `tightenDownstreamFromSeed`, specific normalization scheme for R3-1, helper sharing between PR B and the future Bug α work) resolve during planning.

## References

- **Feedback source:** [Meg Test Apr 16 Notion page](https://www.notion.so/picnichealth/Meg-Test-Apr-16-3442386760c28008ba9edc8ebba67f87)
- **Investigation findings (2026-04-16):**
  - Item 1: `Additional Task Set Creation 4` bot created the duplicate, not inception.
  - Item 3: name-based lookup misses after rename; TSID matching would be degenerate (PR #18 rationale).
  - Item 2: Apr 16 is `start-left` mode with no downstream pass — different bug from Apr 14's `pull-left` gap-preservation.
- **Document-review (2026-04-16):** surfaced the TSID-refactor reversal (Item 3), PR A bookmark decision (Item 2α), R4e dedup + bot carve-out, and `inception.test.js` rewrite requirement.
- **Bookmarked (Bug α handoff to Seb):**
  - [engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md](engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md)
  - [engine/docs/brainstorms/cascade-gap-tightening-requirements.md](engine/docs/brainstorms/cascade-gap-tightening-requirements.md)
- **L2 contract:** [engine/docs/ENGINE-BEHAVIOR-REFERENCE.md](engine/docs/ENGINE-BEHAVIOR-REFERENCE.md) §1 behavior matrix (§29 start-left row is the spec PR B implements), §2b provisioning guards, §10 concurrency.
- **Pulse log (PR #18 rationale for name-matching over TSID):** [pulse-log/04.05/01-live-button-testing.md](clients/picnic-health/pulse-log/04.05/01-live-button-testing.md)
- **Prior shipped work referenced:**
  - PR #57 — button user attribution (source.user_id fix)
  - PR #58 — errors-only comments with env-configurable mention IDs
  - PR #18 — reverted from TSID matching to name matching for repeat-delivery date copy
- **Activity Log events referenced:**
  - `3442386760c281799d85fea88ef5abf7` — Apr 16 Draft ICF start-left cascade (Bug β)
  - `3442386760c28113bdb4d7c9f9050794` — Apr 16 repeat-delivery add-task-set (Item 3)
