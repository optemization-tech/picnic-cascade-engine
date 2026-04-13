# PicnicHealth Cascade Engine — Codebase Review Refresh

**Date**: 2026-04-13
**Scope**: Diff from [CODEBASE-REVIEW-2026-04-07.md](./CODEBASE-REVIEW-2026-04-07.md)
**Method**: Spot-check each 04-07 finding against current `main` + supplement with the live undo bug surfaced on 2026-04-13
**Branch / HEAD**: `main` @ `5c13263` — "chore: consolidate engine docs in repo as single source of truth (#45)"
**Landed since 04-07**: PR #43 (codebase audit P0+P1+P3 + V2 archive), PR #44 (drag-mode split), PR #45 (doc consolidation), shutdown reliability plan
**Open as of today**: Undo cascade crashed in production at `src/routes/undo-cascade.js:58` — manifestation of P2 #11

Read the 04-07 review for full context on any finding below; this doc is strictly a diff.

---

## §1 — Fixed since 2026-04-07

| # | Finding (short) | Where it landed | Verifying file:line |
|---|---|---|---|
| 1 | Webhook auth | PR #43 | `src/middleware/webhook-auth.js`, `src/server.js:28` |
| 2 | SIGTERM handler | PR #43 + shutdown-reliability plan | `src/index.js:37-52` (also handles SIGINT) |
| 3 | `queryDatabase` undefined return | PR #43 | `src/notion/client.js:214` — now throws explicitly after retry exhaustion |
| 5 | No fetch timeout | PR #43 | `src/notion/client.js:83` — `AbortSignal.timeout(30_000)` |
| 6 | `_throttleSlot` unbounded loop | PR #43 | `src/notion/client.js:42-62` — `MAX_ITERATIONS=100` + safety-valve log |
| 7 | V1/V2 duplication (~1,400 lines) | PR #43 (V2 archived) | `src/v2/` directory no longer exists |
| 8 | 10 independent NotionClient instances | PR #43 | `src/notion/clients.js:4-16` — 3 singletons (`cascadeClient`, `provisionClient`, `deletionClient`) |
| 10 | Status rollup sequential fetches | PR #43 | `src/routes/status-rollup.js:23-26, 37-44` — task+study parallelized, parent+siblings parallelized |
| 14 | `_drainStudy` deadlock risk | PR #43 | `src/services/cascade-queue.js:83-91` outer catch clears `lock.running`; `:128-132` inner `finally` releases lock and deletes entry |
| 22 | Self-HTTP copy-blocks | Shutdown-reliability plan, Unit 3 | `src/routes/add-task-set.js` no longer self-HTTPs; direct function call |

**10 findings closed by evidence.** All claims independently verified by file:line inspection.

---

## §2 — Reclassifications

| # | Original classification | New classification | Rationale |
|---|---|---|---|
| 4 | P1 correctness bug (frozen blocker ends ignored) | **Intentional — product contract** | `docs/BEHAVIOR-TAGS.md:30` defines `BEH-COMPLETE-FREEZE`: *"Tasks with status `Done` or `N/A` never move during cascades and are ignored as blocking constraints."* The 04-07 finding misread contract as bug. Close. |
| 9 | P1 V2 `createBatch` rate-limit bypass | **N/A** | V2 archived in PR #43. |
| 25 | P2 undo-vs-cascade race | **Mitigated** | `src/routes/undo-cascade.js:114` now enqueues via `cascadeQueue.enqueue`, serializing undo with in-flight cascades per-study. Original race path is closed. |
| 29 | P2 V2 sequential `reportComplete + logTerminal` | **N/A** | V2 archived. |

**4 findings closed by reclassification.**

---

## §3 — Still outstanding

Grouped by theme, not P-level. File:line anchors are on `main` @ HEAD.

### Correctness
- **#11 Undo snapshot Date-vs-string mismatch** — `src/routes/date-cascade.js:214-222`. Non-source snapshot stores `Date` objects (`t.start`/`t.end` from `normalizeTask`); source task stores `YYYY-MM-DD` strings (`parsed.refStart`/`refEnd`). The manifest propagates the mix to `undoStore`. **Manifested in production on 2026-04-13** — `undo-cascade.js:58` sort called `.localeCompare` on a `Date`, throwing `TypeError`. Log: `TypeError: (a.properties.Dates.date.start || "").localeCompare is not a function`. Promote to **P0** — data-loss risk (user hits Undo, nothing restored) and now reproduced.
- **#12 `computeCascadeMode` returns null on opposing-sign deltas** — `src/engine/classify.js:9-17`. Valid user edits (e.g., startDelta > 0 + endDelta < 0) silently no-op with no warning or activity log. Design decision needed.
- **#23 Source task unconditionally added to patch set** — `src/routes/date-cascade.js:307-316`. Always emits an echo patch even when constrained dates equal original. Wastes an API call per edit and amplifies debounce churn.

### Reliability
- **#13 Inception Import Mode race** — `src/routes/inception.js:151-162`. `disableImportMode` runs inside `Promise.all` with `copyBlocks`. If copy-blocks triggers Notion automations, cascades fire while blocks are still being written.
- **#15 Unbounded in-memory queue (DoS)** — `src/services/cascade-queue.js`. No caps on `_debounce` size, `_studyLocks` count, or per-study queue depth. Attacker POSTing unique payloads to `/webhook/date-cascade` exhausts memory. Webhook auth from #1 narrows the attack surface but doesn't bound legitimate runaway.
- **#16 `runParallel` partial-failure semantics** — `src/notion/client.js:149`. `Promise.all(workers)` short-circuits on first error; batch `patchPages` during a cascade can leave the dependency graph in an inconsistent state.
- **#26 UndoStore lost on restart** — `src/services/undo-store.js`. Still in-memory only. Every Railway deploy silently clears every user's undo. The current user-facing message — "No recent cascade to undo (expired or already undone)" — does not distinguish TTL expiry from process restart.
- **#27 Status rollup not serialized via `cascadeQueue`** — `src/routes/status-rollup.js:80`. Uses `flightTracker.track` (fire-and-forget tracking for shutdown drain) instead of `cascadeQueue.enqueue`. Concurrent rollups for the same parent can race and write conflicting status values.

### Maintainability
- **#19 Notion property-name string literals scattered** — ~70 occurrences across 12 files (down from 80+/15+). Single `PROPERTY_NAMES` map in `notion/schema.js` still the right fix; a silent rename would still fail on unknown properties.
- **#20 `isFrozen` duplicated 3× (plus inline `['Done', 'N/A']` in guards)** — `isFrozen` function at `src/engine/cascade.js:18-22` and `src/engine/parent-subtask.js:9-13` (both backed by a `FROZEN_STATUSES` constant), and at `src/gates/guards.js:98-100` which inlines `['Done', 'N/A']` directly. Consolidation to a single `utils/status.js` (exporting `isFrozen` + `FROZEN_STATUSES`) normalizes all 3 sites. Adding a status like `Cancelled` still requires editing 3 files.
- **#21 Kahn's topo sort duplicated — now 4 sites** (was 5) — `src/engine/cascade.js:96-119, 289-316, 418-441` + `src/provisioning/blueprint.js:114-146`. `parent-subtask.js` no longer hosts one. `topoSort(nodeIds, getSuccessors)` utility still warranted.

### Design-decision flags (may be intentional, like #4)
- **#24 Case-A dep resolution only pushes right** — `src/engine/parent-subtask.js`. Asymmetric gap behavior for negative parent deltas. Needs Meg confirmation before it's treated as a bug.

### P3 carried forward (not re-verified)
- **#30–42** — P3 items from the 04-07 review. No re-verification performed today. Next reviewer: sample 3–5 randomly before assuming they're still live. Explicit callouts worth re-checking first: **#34** (error-reporting retry storms when Notion is the cause), **#35** (`parseDate('garbage')` returns Invalid Date), **#38** (internal structure leaked in Activity Log).

---

## §4 — Recommended next 3–5 items

Ordered by value-per-surface-area, *not* by original P-level. The 04-07 doc's Top 5 are all landed; this is a fresh pick from the live outstanding set.

### 1. #11 Undo snapshot normalization (P0 — promote)
Now a reproduced production crash, not a theoretical type concern. Fix at `src/routes/date-cascade.js:214-222`: format both `start` and `end` to `YYYY-MM-DD` via `formatDate()` from `src/utils/business-days.js:20-22` at snapshot time. Add a narrow unit test that drives a `Date`-typed `allTasks` input and asserts the `undoStore.save` argument has string-typed `oldStart` / `oldEnd`. Harden `undo-cascade.js:57-59` sort comparator with `String(...)` coercion as defense-in-depth. Small diff, unblocks Meg's undo button today.

### 2. #15 Bound the cascade queue
Cap `_debounce` at ~1000 entries and each per-study queue at ~50. Return `429 Too Many Requests` when exceeded. Small, removes the last memory-exhaustion vector now that auth from #1 is in place.

### 3. #27 Status rollup serialization
Move `handleStatusRollup` onto `cascadeQueue.enqueue` (key by `parentId`, not `studyId`, since status rollup is parent-scoped). Same-parent races disappear; per-study cascades stay isolated. Medium diff — needs a parent-aware queue key or a second queue instance.

### 4. #20 + #21 consolidation
Single `utils/status.js` (export `isFrozen`, `FROZEN_STATUSES`) and single `utils/topo-sort.js` (export `topoSort(ids, getSuccessors)`). Mechanical refactor, ~120 line reduction across 4 files. Lowest risk of the five. Good warm-up for a new contributor.

### 5. #13 Inception Import Mode ordering
Move `disableImportMode` to run *after* `copyBlocks` resolves (or pattern-match `add-task-set`'s fire-and-forget). Small, closes a subtle race nobody has hit yet but will as copy-blocks volume grows.

Deferred from the top 5 but worth queueing: **#26 UndoStore persistence** — longer surface area (Notion property or external KV), worth waiting until the user-feedback pattern is clearer.

---

## §5 — Delta summary

```
Starting count (04-07):    42 findings
  Fixed:                   10  (§1)
  Reclassified:             4  (§2 — 1 intentional, 1 mitigated, 2 N/A via V2 removal)
  Outstanding, verified:   15  (§3 non-P3)
  Outstanding P3, unverified: 13 (§3 P3 carry-forward)
                          ---
Accounted for:             42 ✓
```

Testing gaps from the 04-07 review not re-audited today. The undo cascade gap (no production-realistic round-trip test) is the only one demonstrably biting — covered in §4 item 1.

---

## How to use this doc

- **Next fix-planning session**: start from §4. Item 1 is blocking a live user (Meg's undo button).
- **Handoff / onboarding**: read §1 to understand what PR #43 + shutdown reliability already took off the plate.
- **Next review (suggested ~2 weeks)**: re-verify §3 — especially the P3 carry-forward — and update §5 counts. Keep the historical snapshots; don't rewrite this doc, write a new dated one.
