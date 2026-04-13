# TESTING-REFERENCE

## Role of This Document
This is the authoritative testing reference for the PicnicHealth cascade engine. It defines how to manually test each cascade behavior against live Notion tasks, what to verify, and how to avoid common pitfalls.

- Source of truth for behavior: `ENGINE-BEHAVIOR-REFERENCE.md` (L2) and the code (L3)
- Source of truth for testing: this file
- Source of truth for requirements: Workflow Requirements Doc in Notion (L1)
- Machine-readable `BEH-*` tag registry: `BEHAVIOR-TAGS.md` (enforced by `scripts/check-behavior-traceability.js`)
- Implementation-detailed rulebook: `CASCADE-RULEBOOK.md`

If this file disagrees with `ENGINE-BEHAVIOR-REFERENCE.md` or the code, update this file.

## 1) Test Infrastructure

### Local Testing Stack
```
Notion automation → Cloudflare tunnel → Local Express server (port 3000) → Notion API
```

### Setup Commands
```bash
# Terminal 1: engine server
cd ~/Documents/Claude/clients/picnic-health/engine && npm run dev

# Terminal 2: tunnel (generates new URL each restart)
cloudflared tunnel --url http://localhost:3000 --no-autoupdate
```

### Required .env Variables
```
NOTION_TOKEN_1=<integration token>
STUDY_TASKS_DB_ID=<study tasks database ID>
STUDIES_DB_ID=<studies database ID>
ACTIVITY_LOG_DB_ID=<activity log database ID>
PORT=3000
NODE_ENV=development
```

### Notion Automation Webhook URLs
After starting the tunnel, update BOTH automation webhooks to the new tunnel URL:
- Date cascade: `https://<tunnel-domain>.trycloudflare.com/webhook/date-cascade`
- Status rollup: `https://<tunnel-domain>.trycloudflare.com/webhook/status-rollup`

### Critical Infrastructure Rules
- **Tunnel URLs are ephemeral.** Every restart of `cloudflared` generates a new URL. Update Notion automation webhooks each time.
- **Database restores revert automations.** If you restore from page history, the automation webhook URLs revert. Re-update them.
- **Keep both terminals open.** If either the server or tunnel dies, webhooks fail silently (Notion gets no error feedback).
- **Verify connectivity before testing:** `curl -s https://<tunnel-url>/health` must return `{"status":"ok"}`.

## 2) How to Make Each Edit Type in Notion

The cascade mode is determined by which dates change. How you edit in Notion matters:

| Edit Type | How to Edit in Notion | startDelta | endDelta | Cascade Mode |
|---|---|---|---|---|
| Start-only right | Timeline: drag **left edge** right | > 0 | 0 | `pull-right` |
| Start-only left | Timeline: drag **left edge** left | < 0 | 0 | `start-left` |
| End-only right | Timeline: drag **right edge** right | 0 | > 0 | `push-right` |
| End-only left | Timeline: drag **right edge** left | 0 | < 0 | `pull-left` |
| Drag right | Timeline: drag **whole bar** right | > 0 | > 0 | `drag-right` |
| Drag left | Timeline: drag **whole bar** left | < 0 | < 0 | `drag-left` |

### Pitfalls
- **Date picker edits are unreliable for testing.** Changing the start in the date picker may cause Notion to reinterpret the range (e.g., shortening the end instead of moving the start). Always use the **timeline view** for test edits.
- **Drag normalization.** When both start and end move in the same direction, the engine normalizes to preserve the original BD duration. This means `endDelta` gets recalculated. The reported cascade mode may differ from naive delta reading.
- **Stale reference correction.** If the task's DB reference dates differ from the webhook payload's reference dates, the engine recomputes deltas against DB refs. This can change the cascade mode.

## 3) Baseline Capture Protocol

**Before every test action, the Notion AI operator (or human tester) MUST:**

1. **Record the source task's current dates** (start, end) and reference dates (Reference Start, Reference End).
2. **Record current dates of all expected affected tasks:**
   - For `start-left` and `pull-right`: all upstream blockers (follow "Blocked by" chain)
   - For `pull-left`: all downstream dependents on the edited chain (follow "Blocking" chain)
   - For `drag-left` and `drag-right`: the full dependency-connected component (both "Blocked by" and "Blocking")
   - For push-right: all downstream dependents
3. **Record the parent task's dates** if the source is a subtask (Case B) or has subtasks (Case A).
4. **Note any cross-chain blockers** on downstream tasks (tasks with 2+ entries in "Blocked by" from different chains).

After the cascade completes, compare against these snapshots — not against inception dates. Prior cascades may have shifted tasks from their inception positions.

**Task selection rules:**
- **Use a DIFFERENT task for each test within a session.** After each test, the source task's dates and its dependency chain are shifted — reusing it compounds state changes and may create invalid configurations (e.g., start past end).
- **Stay within the test study.** All tests in a round should use tasks from the same study (e.g., Round 15). Do not pick tasks from other studies.
- **Prefer small blast-radius tasks early.** For initial tests, pick tasks with short upstream/downstream chains (2-4 tasks affected, not 100+). Leaf tasks near the end of a workstream or tasks in smaller parallel branches are ideal. Save large-chain tasks for later tests when confidence is higher.

Pick a fresh task matching the required chain topology:

| Test Need | Selection Criteria |
|---|---|
| Tight chain (no gaps) | Leaf task where blocker.end = next BD before task.start |
| Gapped chain | Leaf task where blocker.end is 2+ BD before task.start |
| Top-level parent | Task with subtasks and no parent of its own |
| Fan-in node | Task with 2+ entries in "Blocked by" from different chains |
| Frozen blocker | First set a task to Done, then use a task in its chain |

With 254 tasks in a standard study, there is no reason to reuse tasks within a session.

## 4) Verification Rules by Cascade Mode

### 4.1 push-right (`startDelta == 0, endDelta > 0`)
**Trigger:** End date moves later (right edge drag right).

| Direction | Rule | Verification |
|---|---|---|
| Upstream | No movement | All upstream blockers unchanged |
| Downstream | Conflict-only | Only tasks where `task.start < nextBD(source.newEnd)` shift right. Tasks with gaps stay put. |

**Activity Log check:** Cascade Mode = `push-right`, Status = Success.

### 4.2 start-left (`startDelta < 0, endDelta == 0`)
**Trigger:** Start date moves earlier (left edge drag left).

| Direction | Rule | Verification |
|---|---|---|
| Upstream | Conflict-only | Blockers move earlier only if `nextBD(blocker.end) > source.newStart`. Gaps collapse to 0. |
| Downstream | No movement | End didn't change, so no downstream pull runs. |

### 4.3 pull-left — end-only (`startDelta == 0, endDelta < 0`)
**Trigger:** End date moves earlier (right edge drag left).

| Direction | Rule | Verification |
|---|---|---|
| Upstream | No movement | Start didn't change, so `pullLeftUpstream` finds no conflicts. |
| Downstream | Local pull-left | Reachable downstream tasks shift left by the same BD delta, clamped to blocker constraints. |
| Cross-chain | Clamp only | Stationary cross-chain blockers do not move in end-only-left; they clamp how far the edited chain can move. |

**Key check:** Compare each moved task against its latest blocker after the edit. The task should move left when it can, but it should stop at the latest non-frozen blocker instead of moving that blocker chain.

### 4.4 drag-left (`startDelta < 0, endDelta < 0`)
**Trigger:** Drag whole bar left.

This is a true whole-graph translation:

| Direction | Rule |
|---|---|
| Connected graph | Every non-frozen task in the dependency-connected graph shifts left by the same BD delta. |
| Cross-chain blockers | If they are in the connected graph and not frozen, they move too. |

### 4.5 pull-right (`startDelta > 0, endDelta == 0`)
**Trigger:** Start date moves later (left edge drag right).

| Direction | Rule | Verification |
|---|---|---|
| Upstream | ALL shift unconditionally | Every upstream blocker shifts right by the same BD delta. No adjacency check, no gap absorption. Gaps preserved exactly. |
| Downstream | Conflict-only (expanded seeds) | `conflictOnlyDownstream` runs with seeds = ALL shifted upstream tasks (not just source). Any shifted task whose new end conflicts with a downstream task's start triggers a push. |
| Parent | Case B roll-up | If source is a subtask, parent envelope expands/contracts to cover all subtask dates. |

**Critical nuance:** Downstream tasks may move even though the source's end didn't change, because a DIFFERENT shifted upstream task's new end creates a conflict. This is correct behavior — `conflictOnlyDownstream` uses expanded seeds.

### 4.6 drag-right (`startDelta > 0, endDelta > 0`)
**Trigger:** Drag whole bar right.

This is the rightward mirror of drag-left:

| Direction | Rule |
|---|---|
| Connected graph | Every non-frozen task in the dependency-connected graph shifts right by the same BD delta. |

### 4.7 Complete Freeze
**Rule:** Tasks with Status = "Done" or "N/A" never move during cascades and are excluded from blocker constraints.

**Verification:**
- Frozen tasks remain at original dates after any cascade.
- Non-frozen tasks downstream of a frozen task can still be shifted.
- Frozen tasks are skipped even during whole-graph drags.

## 5) Parent-Subtask Verification

### Case A: Parent Edited (source has subtasks)
- **Guard:** If a top-level parent (no parent of its own) is edited directly, the cascade is **rejected** with Error 1 and the source task is reverted to its reference dates. No tasks move.
- **V1 current behavior:** All non-frozen subtasks shift by the inferred parent delta. Dependency-connected tasks reachable from those shifted subtasks move by the same delta too. Parent dates then recompute to cover the subtasks.
- **Current limitation:** V1 still infers one delta from the parent envelope; it does not yet distinguish parent start-left, end-left, and drag edits as separate modes.
- **V2 difference:** V2 has no `case-a`. It recomputes direct subtask offsets from the moved parent start date and does not currently drag dependency-connected tasks beyond those subtasks.

### Case B: Subtask Edited (source has a parent)
- After cascade completes, parent dates expand or contract to cover the natural span of all its subtasks.

### Cascade Roll-up
- When cascade moves tasks that have parents, those parents' date envelopes auto-adjust.
- This is expected and not a bug — parent expansion after a cascade is normal Case B/roll-up behavior.

## 6) Cross-Chain / Connected Graph Verification

### End-only-left (`pull-left`)
- Check if any downstream task has 2+ entries in "Blocked by" from different chains.
- After cascade: stationary cross-chain blockers should stay put.
- The edited chain may move left until it reaches the latest non-frozen blocker, then stop.

### Drag-left / drag-right
- Trace the full dependency-connected graph from the edited task.
- Every non-frozen task in that connected graph should shift by the same business-day delta.
- If a cross-chain blocker is part of that connected graph, it should move with the drag.

## 7) Webhook Echo Pattern

### Expected Behavior
When a cascade fires, the engine patches multiple tasks via the Notion API. Each patch triggers the Notion automation again (because dates changed). This creates a flood of webhook calls:

```
POST /webhook/date-cascade 200 485ms   ← actual cascade (one)
POST /webhook/date-cascade 200 0ms     ← zero-delta no-op (many)
POST /webhook/date-cascade 200 0ms
POST /webhook/date-cascade 200 1ms
...
```

- **One request takes >100ms** — the real cascade processing.
- **Many requests take 0-1ms** — reference dates already match dates, so zero-delta guard exits immediately.

This is normal. Wait for the flood to settle (~30s after last line) before checking results.

## 8) Activity Log Verification

Every cascade produces an Activity Log entry in Notion with:

| Field | What to Check |
|---|---|
| Cascade Mode | Must match expected mode from Section 4 |
| Status | `Success` (normal), `No Action` (gated), `Failed` (cap hit) |
| Summary | Shows mode, source task name, update count |
| Original Dates | Source task's reference dates before cascade |
| Modified Dates | Source task's new dates after cascade |
| Study Tasks | Linked to source task |
| Tested by | The user who triggered the edit |

**In the page body:**
- `Updated tasks: N` — total tasks patched
- `Unresolved residue count: 0` — should be 0 for success
- `Original source dates: YYYY-MM-DD -> YYYY-MM-DD` — refStart → refEnd
- `Modified source dates: YYYY-MM-DD -> YYYY-MM-DD` — newStart → newEnd
- JSON diagnostics with `movedTaskIds[]`, `parentMode`, and safety details

## 9) Test Matrix

Each test maps to a behavior row from `ENGINE-BEHAVIOR-REFERENCE.md` Section 1.

| Test ID | Behavior Row | Edit Type | Cascade Mode | What It Validates |
|---|---|---|---|---|
| 1.1 | — | — | — | Fresh inception baseline (265 tasks, deps wired) |
| H.1 | — | — | — | Import Mode off and reference dates aligned |
| H.2 | — | — | — | Reference dates aligned with current dates |
| 2A.1 | Start-only right | Left edge drag right +5 BD | `pull-right` | ALL upstream shift unconditionally, gap-preserving |
| 2A.2 | Start-only right | Left edge drag right on gapped chain | `pull-right` | No gap absorption — gaps preserved exactly |
| 2A.3 | — | Any date edit on top-level parent | Rejected | Error 1 guard blocks and reverts direct parent edit |
| 2B.1 | Start-only left | Left edge drag left | `start-left` | Upstream conflict-only, no downstream change |
| 2B.2 | End-only left | Right edge drag left | `pull-left` | Downstream tasks pull left until they hit their latest blocker |
| 2B.3 | Drag left | Whole bar drag left | `drag-left` | Full dependency-connected graph shifts uniformly |
| 2D.1 | — | Drag parent +5 BD | Case A | Subtasks and connected dependencies shift uniformly |
| 2D.2 | — | Subtask end past parent | Case B | Parent envelope expands |
| 2D.3 | — | Drag parent with frozen subtask | Case A + Freeze | Frozen subtask stays, others shift |
| 2D.4 | — | Subtask start before parent | Case B | Parent expands, no secondary case-a loop |
| 2F.1 | Complete Freeze | Push-right past frozen task | `push-right` | Frozen task stays put |
| 2F.2 | Complete Freeze | Pull-left past frozen task | `pull-left` | Frozen task stays put |
| 2G.1 | Drag right (x2) | Consecutive +3 BD drags | `drag-right` | Second cascade uses fresh refs, cumulative +6 BD |
| 3.1 | — | Add Task Set button | No cascade | Import Mode prevents spurious cascades |
| 3.2 | — | Double-click button | No cascade | Concurrent guard rejects second click |
| C1.1 | — | Two edits within 5s | Queue | Task B queued, auto-processed after A |
| C1.2 | — | Same task edited twice during cascade | Queue + dedup | Latest kept, queue auto-fires |
| 2H.1 | Cross-chain clamp | End-only-left on fan-in chain | `pull-left` | Stationary cross-chain blocker stays put and clamps movement |
| 2H.2 | Cross-chain drag | Drag-left on fan-in chain | `drag-left` | Connected cross-chain blocker shifts with the dragged graph |

## 10) Notion AI Session Prompt Template

Each session prompt should follow this structure:

```
1. Role statement: "You are helping me execute Round N tests..."
2. Database references: Round N Tracker (recipe cards) + Activity Log
3. Per-test flow:
   a. Tell me the Action / Delta and link to the task
   b. BEFORE I edit: record current dates of source + all affected tasks (baseline capture)
   c. I make the change
   d. Poll Activity Log for new entry (10-15s intervals)
   e. Note Cascade Mode, Status, Duration, Execution ID
   f. Check affected tasks for correct dates (compare against baseline)
   g. Update test card: Status, Actual/Notes, Exec ID(s)
4. Rules:
   - One test at a time
   - Use relative deltas (± BD), not absolute dates
   - Cross-reference Activity Log as source of truth
   - Mark BUG if wrong, capture details, move on
5. Session-specific test descriptions with v7 behavior rules
```

### Required Additions to All Session Prompts
The following rules must be present in every session prompt:

**Baseline capture rule:**
> BEFORE telling me to make any edit, look up the source task AND all expected affected tasks. Record their current Dates (start → end). After the cascade, compare against these snapshots — not against inception dates.

**Edit method rule:**
> When telling me to edit a date, specify HOW to edit in the timeline view:
> - "drag the LEFT EDGE right" for start-only-right (pull-right)
> - "drag the RIGHT EDGE left" for end-only-left (pull-left)
> - "drag the WHOLE BAR" for drag-right or drag-left
> Do NOT use the date picker for cascade tests.

**Expanded seeds rule (for pull-right tests):**
> In pull-right mode, downstream tasks may shift even if the source's end didn't change. This is because ALL shifted upstream tasks are used as seeds for downstream conflict detection. If a shifted upstream task's new end conflicts with a downstream task's start, the downstream shifts. This is correct behavior.

**Parent roll-up rule:**
> After any cascade, parent task dates may expand or contract. This is Case B roll-up (parent envelope adjusts to cover all subtask dates). It is not a bug.

## 11) Gotchas & Lessons Learned

| Gotcha | Impact | Prevention |
|---|---|---|
| Date picker vs timeline drag | Wrong cascade mode (e.g., pull-left instead of pull-right) | Always use timeline view for test edits |
| Tunnel URL changes on restart | Webhooks fail silently | Re-update Notion automation URLs after every tunnel restart |
| Database restore reverts automations | Webhooks point to old/production URLs | Re-update automation URLs after every restore |
| Webhook echo flood in server terminal | Looks like something is wrong | Normal — one real hit (>100ms), rest are 0ms zero-delta exits |
| Expanded seeds in downstream pass | Unexpected downstream movement in pull-right | Trace ALL blockers of the moved downstream task, not just the source |
| Parent expansion after cascade | Parent dates change unexpectedly | Normal Case B roll-up — parent envelope covers all subtask dates |
| Cross-chain clamping in pull-left | Downstream task doesn't reach full delta | Check the latest non-frozen blocker on the affected task |

## Change Log

### 2026-04-01 — Initial version
Created from the v7 engine implementation and original testing workflows. Derived from `ENGINE-BEHAVIOR-REFERENCE.md`, `cascade.js`, `classify.js`, `date-cascade.js`, `guards.js`, and Round 15 testing experience.

### 2026-04-08 — Mode split refresh
Updated for explicit `start-left`, `drag-left`, and whole-graph drag semantics. Also notes the current V1/V2 parent behavior split.
