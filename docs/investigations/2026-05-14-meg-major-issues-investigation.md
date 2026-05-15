# Investigation: Meg's Major Engine Issues — Root Cause Validation

**Date:** 2026-05-14
**Origin:** [Major Engine Issues report](https://www.notion.so/picnichealth/Major-Engine-Issues-3602386760c2800dacbaf6fda98a6009)
**Plan:** `docs/plans/2026-05-14-002-fix-meg-major-engine-issues-triage-plan.md`
**Studies analyzed:**
- Jalisa's Playground (`ae7f88d7`) — 202 tasks, freshly provisioned
- argenx CIDP 001 (`35323867`) — 182 tasks, production with 41 Done tasks
- Sanofi Pre-T1D Tepli-QUEST (`34423867`) — 196 tasks, production with 38 Done tasks

---

## Issue 1: Tasks NOT Moving When They Should (Gap Preservation)

### Root cause confirmed

`gapPreservingDownstream()` at `src/engine/cascade.js:276-361` computes a uniform negative BD delta from the source task's end-date change and applies it to all downstream tasks. It clamps to blocker constraints but never collapses pre-existing gaps to zero. This is the function dispatched for `pull-left` mode (line 723-724).

The correct algorithm already exists: `tightenDownstreamFromSeed()` at `cascade.js:376-442` computes `newStart = nextBD(max(non-frozen blocker.effectiveEnd))` for each downstream task in topological order — true zero-gap tightening. It's used by `start-left` (line 718-719) and `dep-edit` (line 583), but NOT by `pull-left`, `pull-right`, `drag-left`, or `drag-right`.

### Evidence from live studies

**argenx CIDP 001 (100 tasks sampled, 95 with blockers):**
- 11 tasks with blocker-start gaps, up to 152 business days
- Examples:
  - "Data Management Plan" — Start: 2026-04-22, blocker ends: 2025-11-20, expected start: 2025-11-21. **Gap: 152 days.**
  - "Data Dictionary" — Start: 2026-04-22, blocker ends: 2025-11-20. **Gap: 152 days.**
  - "Create Retrieval Guide" — Start: 2025-12-11, blocker ends: 2025-11-25. **Gap: 15 days.** Status: Done.
  - "Internal Testing" — Start: 2026-06-05, blocker ends: 2026-05-06. **Gap: 29 days.**

**Sanofi Tepli-QUEST (100 tasks sampled):**
- 2 tasks with gaps:
  - "First Site(s) IRB Submission" — Start: 2027-07-08, blocker ends: 2025-12-30. **Gap: 554 days.**
  - "Initial Delivery Recruitment Period" — Start: 2026-10-19, blocker ends: 2026-01-27. **Gap: 264 days.**

**Jalisa's Playground (100 tasks sampled, freshly provisioned):**
- 89/99 tasks with blockers are tight (0 gap) — confirms inception produces correct zero-gap state
- Only 2 tasks with minor gaps — likely from cross-page blocker references

### Conclusion

Gaps accumulate over time as `pull-left` cascades run `gapPreservingDownstream` instead of `tightenDownstreamFromSeed`. Freshly provisioned studies start tight; production studies drift. The fix is to replace `gapPreservingDownstream` with `tightenDownstreamFromSeed` in the `pull-left` dispatch (and similarly for `pull-right` and drag modes).

---

## Issue 2: Tasks ARE Moving When They Shouldn't (Scope Too Broad)

### Root cause confirmed

`collectConnectedTaskIds()` at `cascade.js:68-89` performs a bidirectional BFS, walking both `blockedByIds` (upstream) AND `blockingIds` (downstream). This forms the full connected component of the dependency graph — not just the forward chain from the edited task.

`shiftConnectedComponent()` at `cascade.js:91-117` calls `collectConnectedTaskIds` and shifts every task in the connected component by the same delta. It's used by `drag-left` and `drag-right` (line 736-739).

In the `runCascade` dispatch:
```
case 'drag-left':
case 'drag-right': {
  shiftConnectedComponent(sourceTaskId, startDelta, updatesMap, taskById, [sourceTaskId]);
  break;
}
```

This means: drag task A → find all tasks reachable via ANY edge direction → shift ALL of them. If task A blocks B, and B is also blocked by C (unrelated), C gets shifted too. This is the mechanism behind Meg's 138-task cascade.

### Evidence from code

The bidirectional walk at line 80-85:
```javascript
for (const blockerId of (task.blockedByIds || [])) {      // walks upstream
  if (!connected.has(blockerId) && taskById[blockerId]) queue.push(blockerId);
}
for (const dependentId of (task.blockingIds || [])) {      // walks downstream
  if (!connected.has(dependentId) && taskById[dependentId]) queue.push(dependentId);
}
```

Compare with `tightenDownstreamFromSeed` (line 387-390) which only walks `blockingIds` (forward):
```javascript
for (const bid of (taskById[cur]?.blockingIds || [])) {    // forward only
  if (!reachable.has(bid) && taskById[bid]) dfsStack.push(bid);
}
```

### Conclusion

Replacing drag mode dispatch with `tightenDownstreamFromSeed` (forward-only) would limit scope to the downstream chain from the edited task. This is a behavioral change from the current "connected component translation" design — requires Meg confirmation before shipping.

---

## Issue 3: Silent Success on Broken Cascades

### Root cause confirmed

No post-cascade invariant verification exists in the codebase. The cascade writes dates to Notion and logs "success" to the Activity Log without checking whether the resulting state satisfies the zero-gap invariant.

In `src/routes/date-cascade.js`, the Activity Log entry is written with status "success" or "failed" based solely on whether the cascade algorithm completed without errors — not whether the output is correct. A cascade that preserves gaps (Issue 1) still logs "success."

### Evidence

The `buildUpdateProperties()` function at `date-cascade.js:171-186` writes Automation Reporting with a green checkmark (`❇️ cascade: dates shifted`) regardless of output quality. Examples from live studies:
- argenx CIDP 001 tasks show `❇️ drag-right: dates shifted` in Automation Reporting even for tasks with 150+ day gaps
- No Activity Log entries contain violation counts or diagnostic information about gap adherence

### Conclusion

A post-cascade verification pass (proposed in U5) would check `task.start === nextBD(max(non-frozen blocker.effectiveEnd))` for every moved task and log violations to the Activity Log. This is additive — it doesn't change cascade behavior, only adds observability.

---

## Issue 4: Parent/Child Date Logic Broken

### Root cause analysis — multiple sub-issues

**Issue 4a: "Parent task anchoring children"**

NOT an engine bug. Parent edges are stripped at `cascade.js:648-668` (BL-H5g). Parent tasks have their `blockedByIds` and `blockingIds` cleared, and child tasks filter out parent IDs from their dependency arrays. Parents do not constrain children in cascades.

What Meg likely sees is stale parent dates — the rollup that computes `min(child starts) / max(child ends)` only runs after a cascade touches children. If no cascade fires (e.g., Fill Refs race → delta=0), parent dates stay stale.

**Issue 4b: "Disconnected parent/child dates after data changes"**

From the live data, parent tasks in both argenx and Sanofi studies currently MATCH their children's date ranges:
- argenx: 2 parent tasks, both MATCH
- Sanofi: 5 parent tasks (4 in this page), all MATCH

This suggests the rollup is working when cascades fire. The gap Meg reported likely occurs when a cascade is silently skipped (delta=0 from Fill Refs race, or actor classifier bug), leaving parent dates stale. Both underlying causes have been partially fixed (Fill Refs: PR #114, actor classifier: PR #108).

**Issue 4c: "Reference dates don't match Dates when end date is empty"**

Found in argenx CIDP 001: 2 tasks with null `Dates.end` but non-null `Reference End Date`:
- "SAP Delivery" — Dates: 2026-01-11→null, Reference: 2026-01-11→2026-01-11
- "Document IRB Approval" — Dates: 2026-03-03→null, Reference: 2026-03-03→2026-03-03

These are milestones (single-date tasks where Notion stores only the start). The Reference dates were set during inception with both start and end populated. When a PM clears the end date manually, Reference End stays stale. This is a Notion data shape issue — milestones store `{start, end: null}` while Reference dates store `{start}` separately for start and end.

**Issue 4d: "Reference dates stuck on manually-moved Done tasks"**

Confirmed in argenx CIDP 001:
- "Configure & Implement Retrieval Guide" — Status: Done. Dates: 2026-01-02→2026-01-10, Reference: 2026-01-21→2026-01-29. **19-day mismatch.**
- "Create Retrieval Guide" — Status: Done. Dates: 2025-12-11→2025-12-19, Reference: 2025-11-26→2025-12-04. **15-day mismatch.**

Root cause: the frozen-status gate in `date-cascade.js` skips cascade processing for Done tasks. Since Reference date sync happens inside the cascade write path (`buildUpdateProperties` at line 173-175), no cascade → no Reference sync.

This is by-design behavior — the engine deliberately skips frozen tasks. See U6 analysis for classification.

---

## Issue 5: Dependencies Intermittently Failing to Fire

### Root cause — composite symptom

Three independent causes produce this symptom:

**5a: Fill Refs race condition (delta=0 → silent skip)**

When the "Fill Refs" Notion automation writes Reference dates to match current Dates, it triggers a webhook. The webhook arrives with `refStart = newStart` (because Fill Refs just set Reference to match Dates), producing `startDelta = 0, endDelta = 0`. The zero-delta gate at `date-cascade.js:217-218` skips the cascade:

```javascript
if (parsed.startDelta === 0 && parsed.endDelta === 0) {
  console.log(JSON.stringify({ event: 'zero_delta_skip', ... }));
```

This was identified in the May 14 Fill Refs race plan. The `_replayTrustRef` bypass was added for replay scripts, and a Notion-side filter fix was documented for the automation itself.

**5b: Actor classifier bug (all cascades silently dropping)**

The actor classifier at `classify.js:87-147` corrects stale references. Before the May 12 fix (PR #108), a bug in the classifier was causing ALL cascades to be silently dropped for a 4-day window. This is now fixed.

**5c: Cold-boot guard during Railway redeploys**

Railway's zero-downtime deploy can have a brief window where the old instance is shutting down and the new instance hasn't fully started. Webhooks during this window may be dropped. This is an infrastructure issue, not an engine bug.

### Evidence

The stale-reference correction at `classify.js:98` adopts DB Reference over webhook Reference:
```javascript
if (!trustWebhookRef && dbRefStart && dbRefEnd && (dbRefStart !== refStart || dbRefEnd !== refEnd)) {
```

When Fill Refs sets DB Reference to match Dates (which is exactly what the webhook carries as `newStart/newEnd`), the correction path finds `dbRefStart === newStart` → recalculates `startDelta = signedBDDelta(newStart, newStart) = 0` → cascade is skipped.

### Conclusion

After the Notion-side Fill Refs filter fix is verified (preventing the automation from writing Reference dates that match existing Dates), most Issue 5 instances should resolve. The actor classifier bug is already fixed.

---

## Summary of Root Causes

| Issue | Root Cause | Type | Fix Status |
|-------|-----------|------|------------|
| 1: Gaps not closing | `gapPreservingDownstream` preserves gaps instead of tightening | Engine bug | U2 (planned) |
| 2: Scope too broad | `collectConnectedTaskIds` walks bidirectionally | Engine bug | U3 (planned, needs Meg confirmation) |
| 3: Silent success | No post-cascade invariant check | Engine gap | U5 (planned) |
| 4a: Parent anchoring | Not a bug — parent edges stripped (BL-H5g) | Design (correct) | N/A |
| 4b: Parent date staleness | Rollup only runs after cascade touches children | Downstream of 5a/5b | Resolves with 5a/5b fixes |
| 4c: Reference mismatch (null end) | Milestone data shape difference | Notion config | Document for Meg |
| 4d: Reference stuck on Done | Frozen gate skips cascade + Reference sync | Design decision | U6 analysis |
| 5a: Fill Refs race | Automation writes Reference = Dates → delta=0 → skip | Notion config + engine | PR #114 + Notion filter fix |
| 5b: Actor classifier | Classification bug caused silent drops | Engine bug | Fixed (PR #108) |
| 5c: Cold-boot drops | Railway deploy gap | Infrastructure | Not engine scope |

---

## Specific Task IDs for Test Fixtures

### Issue 1 (gap preservation)
- argenx: `35323867-60c2-81d1-a9d8-dddc9a2447e5` ("Data Management Plan", 152-day gap)
- argenx: `35323867-60c2-8116-bf5f-cb219d86440c` ("Data Dictionary", 152-day gap)
- Sanofi: IRB Submission task (554-day gap from cross-page blocker)

### Issue 4d (Done task Reference mismatch)
- argenx: "Configure & Implement Retrieval Guide" (Dates: Jan 2-10, Reference: Jan 21-29)
- argenx: "Create Retrieval Guide" (Dates: Dec 11-19, Reference: Nov 26-Dec 4)

### Issue 4c (milestone Reference mismatch)
- argenx: "SAP Delivery" (Dates: 2026-01-11→null, Reference End: 2026-01-11)
- argenx: "Document IRB Approval" (Dates: 2026-03-03→null, Reference End: 2026-03-03)
