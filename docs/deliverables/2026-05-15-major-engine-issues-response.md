# Response: Major Engine Issues Report

Hey Meg! Went through your full bug report and investigated each issue class against live study data (argenx CIDP 001, Sanofi Tepli-QUEST, and Jalisa's Playground). Here's what we found, what's been fixed, and what still needs your input.

---

## Issue 1: Tasks NOT Moving When They Should

**What you reported:** After pulling a task left, downstream tasks don't fully close the gap. Dates shift but leave gaps between tasks that should be tight.

**Root cause:** The cascade algorithm for "pull-left" was using a gap-preserving shift instead of a zero-gap tightening. It would slide downstream tasks by the same number of business days as the source moved, but if there was already a gap between tasks, that gap was preserved. Over time, these gaps compound across cascades.

We confirmed this against live data:
- **argenx CIDP 001:** 11 tasks with blocker-start gaps, some up to 152 business days (e.g., "Data Management Plan" starts April 22 but its blocker finished Nov 20 -- that's a 152-day gap that should have been zero)
- **Sanofi Tepli-QUEST:** 2 tasks with gaps, one at 554 business days
- **Jalisa's Playground:** 89/99 tasks with blockers are perfectly tight -- confirms that freshly provisioned studies start correct, and gaps accumulate from cascades over time

**Fix:** Replaced the gap-preserving algorithm with the zero-gap tightening algorithm (which already existed in the engine and was working correctly for other cascade modes). Now when you pull a task left, every downstream task snaps tight to its latest blocker's end date -- no gaps preserved.

**Status:** Fixed (PR #117). Ready for review.

---

## Issue 2: Tasks ARE Moving When They Shouldn't

**What you reported:** Dragging a single task's dates caused 138 tasks to move, including tasks that have no downstream relationship to the one you edited.

**Root cause:** The drag cascade was walking the dependency graph in both directions -- upstream AND downstream. So if you drag task A, it finds A's blockers, then the blockers' blockers, then anything those blockers are blocking... eventually it reaches the entire connected component of the dependency graph. Every task in that component gets shifted.

For example: you drag task A, which blocks B. B is also blocked by C (unrelated to your edit). C gets shifted too, along with everything C blocks, and so on. That's how you get 138 tasks moving from a single edit.

**Fix:** Drag modes now use forward-only tightening -- only tasks downstream of the one you edited are affected. Upstream blockers and unrelated branches are untouched.

**Behavioral change to confirm:** This means drag is no longer a "rigid translation" of the whole chain. Dragging a task right will tighten its downstream tasks (collapsing gaps), and dragging it back left won't perfectly undo the rightward drag if there were pre-existing gaps. The tradeoff is that you never accidentally move 138 tasks again. Let us know if this behavior change works for your team or if you'd prefer a different scope.

**Status:** Fixed (PR #117). Ready for review.

---

## Issue 3: Silent Success on Broken Cascades

**What you reported:** The Activity Log shows a green checkmark and "cascade: dates shifted" even when the resulting dates are wrong.

**Root cause:** The engine was logging success based on whether the cascade algorithm completed without errors -- not whether the output was actually correct. A cascade that preserves 150-day gaps still logged "success" because it ran without crashing.

**Fix:** Added a post-cascade verification step. After every cascade, the engine now checks that each moved task satisfies the zero-gap invariant (start date = next business day after latest blocker's end date). Any violations are counted and logged in the Activity Log details. So instead of just "dates shifted," you'll see something like "dates shifted (0 violations)" or "dates shifted (3 violations: ...)" if something went wrong.

**Status:** Fixed (PR #117). Ready for review.

---

## Issue 4: Parent/Child Date Logic

This one turned out to be several distinct sub-issues:

### 4a: "Parent tasks anchoring children"

**Not a bug.** The engine explicitly strips parent-child edges from the dependency graph before running cascades (this is by design -- parent tasks are containers, not blockers). Parent dates come from a Notion rollup formula that computes min(child starts) and max(child ends). Parents can't constrain or move children.

What you're likely seeing is stale parent dates -- the rollup only refreshes when children actually move. If a cascade gets silently skipped (see Issue 5 below), children don't move and parent dates stay stale. Once the Issue 5 fixes land and cascades fire reliably, parent dates should stay current.

### 4b: "Disconnected parent/child dates after data changes"

**Downstream effect of Issue 5.** Same mechanism as 4a -- when cascades are silently skipped (Fill Refs race or actor classifier bug), children don't move, and parent rollup dates go stale. We confirmed that when cascades DO fire, parent dates match perfectly: 2/2 in argenx, 4/4 in Sanofi.

**Fix:** Resolves automatically once Issue 5a (Fill Refs filter) is verified. Affected studies may need a cascade replay to clean up historical staleness.

### 4c: "Reference dates don't match Dates when end date is empty"

**Cosmetic Notion data shape mismatch.** Found 2 tasks in argenx where the end date is null (milestones) but Reference End still has a value from inception. This is because milestones store dates as `{start: Jan 11, end: null}`, but Reference End was set to Jan 11 during provisioning and never cleared.

This doesn't affect cascade logic -- the engine handles it correctly. It just looks confusing in the Notion UI.

**Recommendation:** If it's causing PM confusion, we can run a cleanup script to null out Reference End on milestone tasks. Otherwise, safe to leave as-is.

### 4d: "Reference dates stuck on manually-moved Done tasks"

**By-design behavior, but worth discussing.** Found in argenx: "Configure & Implement Retrieval Guide" has Status: Done, Dates moved to Jan 2-10, but Reference still shows Jan 21-29 (19-day mismatch).

This happens because the engine treats Done tasks as frozen -- it won't cascade from them to protect completed work. When a PM manually moves a Done task's dates, the Reference dates don't sync because no cascade runs.

The risk: if someone un-Dones that task and edits it again, the cascade would compute deltas against the stale Reference, potentially producing wrong shifts.

**Options:**
1. **Leave as-is (recommended for now)** -- Reference on Done tasks is cosmetically stale but functionally irrelevant unless someone un-Dones the task
2. **Lightweight fix** -- sync Reference dates (without cascading) when a Done task is manually moved
3. **Notion-side fix** -- extend the Fill Refs automation to handle Done tasks

Let us know if this matters for your workflow and we'll implement Option 2 or 3.

---

## Issue 5: Dependencies Intermittently Failing to Fire

This was the trickiest one -- three independent root causes producing the same symptom:

### 5a: Fill Refs Race Condition

**Root cause:** Notion's "Fill Refs" automation (which copies current Dates into Reference date fields) sometimes runs BEFORE the cascade webhook arrives. When that happens, the webhook sees Reference dates that already match the new Dates, computes a delta of zero, and skips the cascade entirely. No cascade, no movement, no error -- just silence.

**Fix:** Two parts:
1. **Engine-side** (PR #114): Added a bypass for replay scripts so we can re-run skipped cascades
2. **Notion-side** (needs verification): The Fill Refs automation needs a filter update so it doesn't write Reference dates that match existing Dates. This is a configuration change in your Notion workspace.

**Action needed from you/Seb:** Verify the Fill Refs automation filter is set correctly. This is the single highest-impact fix -- it unblocks Issues 1, 4b, and the rest of Issue 5.

### 5b: Actor Classifier Bug

**Root cause:** A bug in how the engine classifies who made an edit (human vs. bot) was causing ALL cascades to be silently dropped for a 4-day window.

**Status:** Fixed (PR #108, May 12). Fully resolved.

### 5c: Cold-Boot Drops During Railway Redeploys

**Root cause:** Railway's deploy process has a brief window where webhooks can be dropped. This is rare and infrastructure-level.

**Status:** Not an engine fix -- this is a Railway ops issue. If it becomes frequent, we can add webhook replay on startup.

---

## What's Been Fixed vs. What Needs Your Input

| Issue | Type | Status | Your action needed? |
|-------|------|--------|---------------------|
| 1: Gaps not closing | Engine bug | Fixed (PR #117) | Review PR |
| 2: 138 tasks moving | Engine bug | Fixed (PR #117) | Confirm the behavioral change (forward-only drag) works for your team |
| 3: Silent success | Engine gap | Fixed (PR #117) | Review PR |
| 4a: Parent anchoring | Not a bug (design correct) | N/A | None |
| 4b: Parent date staleness | Downstream of Issue 5 | Auto-resolves with 5a fix | None |
| 4c: Reference mismatch (milestones) | Cosmetic | Optional cleanup | Let us know if it's confusing PMs |
| 4d: Reference on Done tasks | Design decision | Documented | Let us know if it matters for your workflow |
| 5a: Fill Refs race | Notion config | Partially fixed (PR #114) | Verify Fill Refs automation filter |
| 5b: Actor classifier | Engine bug | Fixed (PR #108) | None |
| 5c: Cold-boot drops | Infrastructure | Not engine scope | None |

## Recommended Priority

1. **Verify the Fill Refs Notion-side filter** (5a) -- this is the single biggest unblock. Most of the "dependencies not firing" and "parent dates stale" symptoms trace back to this race condition.
2. **Review and merge PR #117** (cascade fixes) -- ships the gap tightening (Issue 1), forward-only drag (Issue 2), pull-right fix, and post-cascade verification (Issue 3).
3. **Confirm the drag behavior change** (Issue 2) -- forward-only tightening is a change from the current "translate whole chain" behavior. We think it's the right call, but want your sign-off.
4. **Replay cascades on affected studies** -- after PRs land and the Fill Refs filter is verified, we should replay cascades on argenx CIDP 001 and Sanofi Tepli-QUEST to clean up accumulated gaps.
5. **Decide on Issue 4d** (Reference sync for Done tasks) -- cosmetic for now, but let us know if it matters.

---

*Investigation: PR #116 (root cause analysis) | Fixes: PR #117 (cascade algorithm changes), PR #114 (Fill Refs race bypass), PR #108 (actor classifier fix)*
