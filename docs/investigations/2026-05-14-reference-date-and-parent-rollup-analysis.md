# Analysis: Reference Date Handling and Parent Rollup Gaps

**Date:** 2026-05-14
**Scope:** Issues 4 and 5 from Meg's Major Engine Issues report
**Plan:** `docs/plans/2026-05-14-002-fix-meg-major-engine-issues-triage-plan.md` (U6)

---

## How Reference Dates Work in the Engine

Reference dates (`[Do Not Edit] Reference Start Date` and `[Do Not Edit] Reference End Date`) serve as the "before" snapshot for cascade delta computation. The cascade flow is:

1. PM edits a task's Dates in Notion
2. Notion fires a webhook with `newStart`, `newEnd`, `refStart` (old Reference Start), `refEnd` (old Reference End)
3. Engine computes `startDelta = signedBDDelta(refStart, newStart)` and `endDelta = signedBDDelta(refEnd, newEnd)`
4. Engine runs the cascade algorithm using the deltas
5. Post-cascade, `buildUpdateProperties()` at `date-cascade.js:173-175` writes BOTH new Dates AND new Reference dates for every moved task:
   ```javascript
   [STUDY_TASKS_PROPS.DATES.id]: { date: { start: update.newStart, end: update.newEnd } },
   [STUDY_TASKS_PROPS.REF_START.id]: { date: { start: update.newReferenceStartDate || update.newStart } },
   [STUDY_TASKS_PROPS.REF_END.id]: { date: { start: update.newReferenceEndDate || update.newEnd } },
   ```

Reference dates are updated **only** when a cascade fires and moves a task. They are NOT updated when:
- The frozen-status gate skips the cascade (task is Done/N/A)
- The zero-delta gate skips the cascade (startDelta=0 AND endDelta=0)
- The bot-author gate skips the cascade (edit was made by a bot, not a human)
- The import-mode gate skips the cascade (study is in import mode)

---

## Issue-by-Issue Classification

### Issue 4a: Parent Task Anchoring Children

**Classification: Not an engine bug (design is correct)**

Parent tasks are explicitly excluded from cascade dependency graphs by the BL-H5g rule at `cascade.js:648-668`. When parent edges are stripped:
- Parent tasks have their `blockedByIds` and `blockingIds` cleared to empty arrays
- Child tasks filter out parent IDs from their `blockedByIds` and `blockingIds` arrays

This means parent tasks:
- Cannot constrain child dates (they don't appear as blockers)
- Cannot be moved by cascades (they have no dependency edges)
- Cannot trigger cascades (they don't participate in the graph)

**What Meg sees** is stale parent dates: the rollup formula that computes `min(child starts) / max(child ends)` is a Notion-side formula/rollup, not engine-driven. If no cascade runs (because of the Fill Refs race or other skip gate), the formula may show cached values.

**Evidence:** Both argenx CIDP 001 and Sanofi Tepli-QUEST parent tasks currently match their children's date ranges (2/2 and 4/4 respectively). The rollup formula is working correctly when cascades actually fire and touch children.

**Recommendation:** Document for Meg that parent dates are rollup-driven and refresh when children are touched. If parent dates appear stale, it means children weren't cascaded (likely due to Issue 5a/5b). After those fixes, parent dates should stay current.

---

### Issue 4b: Disconnected Parent/Child Dates After Data Changes

**Classification: Downstream effect of Issues 5a and 5b**

When a cascade is silently skipped (delta=0 from Fill Refs race, or actor classifier bug dropping all cascades), children don't move, and therefore parent rollup dates don't refresh. The parent appears "disconnected" from its children's correct positions.

**Root cause chain:**
1. PM edits a task's dates
2. Fill Refs automation fires, setting Reference = Dates (before the webhook arrives)
3. Webhook arrives with Reference already matching new Dates
4. Engine computes delta=0 → skips cascade
5. Children that should have moved don't move
6. Parent rollup shows the old child dates

**Fix:** Resolving Issues 5a (Fill Refs Notion-side filter) and 5b (actor classifier, already fixed) eliminates the skip. Once cascades fire reliably, children move, and parent rollups refresh.

**Recommendation:** After the Notion-side Fill Refs filter fix is verified, replay cascades on affected studies to bring stale parent dates up to date.

---

### Issue 4c: Reference Dates Don't Match Dates When End Date Is Empty

**Classification: Notion data shape issue (config)**

Found in argenx CIDP 001:
- "SAP Delivery" — Dates: `{start: "2026-01-11", end: null}`, Reference End: `{start: "2026-01-11"}`
- "Document IRB Approval" — Dates: `{start: "2026-03-03", end: null}`, Reference End: `{start: "2026-03-03"}`

These are milestone tasks (single-date tasks). In Notion's data model:
- A milestone's Dates property stores `{start: "YYYY-MM-DD", end: null}`
- Reference Start/End are separate date properties, each storing `{start: "YYYY-MM-DD"}`
- At inception, Reference dates are set to match Dates. For milestones, `refEnd = datesStart` (since `datesEnd` is null, the engine falls back to start: `endStr = datesProp?.date?.end || startStr` at `properties.js:25`)

When a PM later clears the end date (or the task was always a milestone), the Reference End remains populated with the inception value. This is not a functional issue — the cascade correctly uses `refEnd` for delta computation regardless of whether Dates.end is null.

**Recommendation:** Document as a known cosmetic mismatch for milestone tasks. No engine change needed. If it causes PM confusion, a cleanup script could null out Reference End for tasks where Dates.end is null.

---

### Issue 4d: Reference Dates Stuck on Manually-Moved Done Tasks

**Classification: Design decision (by-design behavior)**

Found in argenx CIDP 001:
- "Configure & Implement Retrieval Guide" — Status: Done. Dates: Jan 2→Jan 10. Reference: Jan 21→Jan 29. **19-day gap.**
- "Create Retrieval Guide" — Status: Done. Dates: Dec 11→Dec 19. Reference: Nov 26→Dec 4. **15-day gap.**

**Mechanism:**
1. Task was completed (Status = Done) with Dates matching Reference
2. PM manually moved the Done task's dates (e.g., to record actual completion dates)
3. Notion webhook fires with the new dates
4. Engine's frozen-status gate sees `isFrozen(task) === true` → skips cascade
5. No cascade runs → no Reference sync → Reference stays at the old values

**Why this is by-design:** The engine deliberately treats Done/N/A tasks as frozen to prevent cascades from disrupting completed work. A PM moving a Done task's dates is an infrequent manual action, and the engine is correct not to cascade from it.

**However,** the Reference dates becoming stale means that if the PM later un-Dones the task and moves it again, the cascade will compute deltas against the stale Reference — potentially producing incorrect shifts.

**Options:**
1. **Status quo (recommended):** Leave as-is. Reference dates on Done tasks are cosmetically stale but functionally irrelevant unless the task is un-Doned. Document for Meg.
2. **Lightweight fix:** Add a Reference-sync-only path in `date-cascade.js` that updates Reference dates without running a cascade when a Done task is manually moved. Low risk, narrow scope.
3. **Extend Fill Refs automation:** Modify the Notion-side Fill Refs automation to handle Done tasks. This moves the fix entirely to Notion configuration.

**Recommendation:** Option 1 for now (document as design decision). If Meg considers it a problem, Option 2 is the cleanest engine-side fix.

---

### Issue 5: Dependencies Intermittently Failing to Fire

**Classification: Composite — Notion config + engine bug (both partially fixed)**

Three independent causes:

**5a: Fill Refs race condition → delta=0 → cascade skipped**
- **Type:** Notion config issue + engine design interaction
- **Status:** Partially fixed. `_replayTrustRef` bypass added for replay scripts (PR #114). Notion-side filter fix documented but requires manual verification by Meg/Seb.
- **Remaining work:** Verify the Notion-side filter is applied correctly. After verification, this cause is eliminated for future edits. Historical damage requires replay.

**5b: Actor classifier bug → all cascades silently dropped**
- **Type:** Engine bug
- **Status:** Fixed (PR #108, 2026-05-12). The classifier was incorrectly dropping all cascades for a 4-day window. This is fully resolved.

**5c: Cold-boot guard during Railway redeploys**
- **Type:** Infrastructure
- **Status:** Not engine scope. Railway's deploy model has a brief window where webhooks may be dropped. This is a rare occurrence and not actionable from the engine side.

---

## Summary Table

| Sub-Issue | Classification | Fix Needed? | Owner |
|-----------|---------------|-------------|-------|
| 4a: Parent anchoring | Design (correct) | No — document for Meg | N/A |
| 4b: Parent date staleness | Downstream of 5a/5b | Resolves with 5a/5b fixes | Engine + Notion |
| 4c: Reference mismatch (null end) | Notion config (cosmetic) | Optional cleanup script | Meg/Seb |
| 4d: Reference stuck on Done | Design decision | Document; optional lightweight fix | Engine (if desired) |
| 5a: Fill Refs race | Notion config + engine | Notion filter fix (manual) | Meg/Seb |
| 5b: Actor classifier | Engine bug | Fixed (PR #108) | Done |
| 5c: Cold-boot drops | Infrastructure | Not engine scope | Railway ops |

---

## Impact on Other Issues

The Fill Refs race (5a) and actor classifier bug (5b) have downstream effects on Issues 1-3:

- **Issue 1 (gaps):** Even if we fix `gapPreservingDownstream`, cascades that are silently skipped (5a) won't tighten anything. The Notion-side filter fix is a prerequisite for Issue 1 fixes to have full effect.
- **Issue 3 (silent success):** Post-cascade verification (U5) would log violations but can't detect cascades that never ran. The Activity Log already shows `zero_delta_skip` events — these should be monitored.
- **Issue 4b (parent staleness):** Parent rollups only refresh when children move. Children only move when cascades fire. Fixing 5a/5b is the prerequisite.

**Recommended fix priority:**
1. Verify Notion-side Fill Refs filter (unblocks everything)
2. Gap tightening conversion (U2) — resolves Issue 1
3. Drag mode scope fix (U3) — resolves Issue 2 (needs Meg confirmation)
4. Pull-right tightening (U4) — resolves Issue 1 for pull-right
5. Post-cascade verification (U5) — adds observability for Issue 3
6. Replay cascades on affected studies — repairs historical damage
