---
title: "fix: Add downstream tightening pass to start-left cascade dispatch"
type: fix
status: active
date: 2026-04-16
origin: engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md
---

# PR B — `start-left` Downstream Pass

## Overview

Add a downstream tightening pass to the cascade engine's `start-left` dispatch so that downstream siblings of the source task are reached and tightened against their blockers' new positions. Today `start-left` runs `pullLeftUpstream` only — downstream siblings that share a blocker with the source task are never touched, producing a "massive gap" like the one Meg observed on 2026-04-16 when Draft ICF's start was moved far left.

## Problem Frame

Meg's 2026-04-16 live test dragged Draft ICF's start ~45 BD left (`start-left` mode). Internal Revisions Round 1: Protocol — a downstream sibling of Draft ICF (both blocked by Client Review R1) — ended up with a massive gap to Client Review R1 because no cascade function was ever called against it.

Investigation confirmed:
- Activity Log event `3442386760c281799d85fea88ef5abf7` ran mode `start-left`, `pullLeftUpstream` only, `updatedCount=9`.
- Current dispatch in `engine/src/engine/cascade.js` (switch case `'start-left'`, around line 579) calls `pullLeftUpstream` and returns. No downstream function.
- The L2 behavior ref at `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md:29` already specifies *"Upstream then downstream — downstream re-evaluated against blockers"* for `start-left`. **Spec-vs-code drift.**
- Meg's frozen-task hypothesis is ruled out: Client Review R1 is `Not started`, not Done. The bug is a missing pass, not frozen-blocker semantics (see origin).

This is **Bug β** in the requirements doc (origin). **Bug α** (Apr 14 `pull-left` gap-preservation) is a different code path and is bookmarked separately — not in scope here.

## Requirements Trace

- **R2β-1** — `start-left` dispatch runs a downstream tightening pass after `pullLeftUpstream` (see origin).
- **R2β-2** — Seed set = `{sourceTaskId} ∪ tasks whose start OR end changed during the upstream pass` (broadened from end-only per document-review feedback).
- **R2β-3** — Implements tight-schedule semantics locally in a new function `tightenDownstreamFromSeed`: each reachable task's new start = `nextBusinessDay(max(non-frozen blocker end))`, duration preserved.
- **R2β-4** — Frozen-task semantics unchanged. Done/N/A blockers excluded from constraint calculation; frozen downstream tasks don't move.
- **R2β-5** — Post-cascade safety net (`validateConstraints`) continues to run after the downstream pass as it does for every other mode; no changes to that sweep.

Satisfies origin success criterion **SC-5** (Apr 16 gap closes) and **SC-7** (regression test for frozen blocker in fan-in).

## Scope Boundaries

- **No change** to `push-right`, `pullLeftUpstream`, `gapPreservingDownstream`, `conflictOnlyDownstream`, or `pullRightUpstream` function bodies.
- **No change** to Complete Freeze semantics (frozen blockers stay invisible to constraints; frozen tasks stay put).
- **No change** to parent-subtask roll-up or `validateConstraints` (the post-cascade safety-net sweep that runs after every mode).
- **No change** to `classify.js`, route handlers, Activity Log, study-comment service, or status-rollup.
- **Not included:** Bug α rewrite of `gapPreservingDownstream`. The new helper here is intentionally named `tightenDownstreamFromSeed` so a future Bug α PR can refactor the existing function to share it; that refactor is out of scope for this PR.

## Context & Research

### Relevant Code and Patterns

- `engine/src/engine/cascade.js:81-168` — `conflictOnlyDownstream(seedTaskIds, updatesMap, taskById)`. Template to mirror: BFS reachable set → Kahn's topo sort → per-task blocker scan. Difference: conflictOnlyDownstream early-outs when `task.start >= constraint`; the new function never early-outs — always tightens.
- `engine/src/engine/cascade.js:177-243` — `pullLeftUpstream`. Uses Bellman-Ford and produces the `updatesMap` that PR B's new pass will read as seed input. Already collapses upstream gaps to 0.
- `engine/src/engine/cascade.js:252-361` — `gapPreservingDownstream`. Not modified by PR B. Future Bug α PR will refactor this to share logic with the new function.
- `engine/src/engine/cascade.js` switch dispatch (around line 579) — the `'start-left'` case currently calls `pullLeftUpstream` only. PR B inserts the second call.
- `engine/test/engine/cascade.test.js` — `describe('start-left')` block at line 92 covers existing upstream-only behavior. No current test covers start-left downstream siblings — that gap is what Meg hit. The new tests live in a new nested describe block inside the `'start-left'` group.
- `engine/test/fixtures/cascade-tasks.js` — reusable fixtures. `fanIn`, `chainWithFrozen`, `diamondUpstream`, `linearTightChain`, `multiBlockerStationary` all relevant for the new test cases.

### Institutional Learnings

- **PR #41 (BL-H4g, gap-aware stationary blocker guard)** — `clients/picnic-health/pulse-log/04.07/02-bl-h4g-h5g-h6g-cascade-fixes.md`. Note: BL-H4g's guard lives in `gapPreservingDownstream` (cascade.js:328-344, the `earliestAllowed` clamp with pull-left skip). The new `tightenDownstreamFromSeed` does NOT inherit BL-H4g semantics — it always tightens to `nextBD(max(non-frozen blocker end))`, no gap-based skip. Only frozen-blocker exclusion is shared. This is deliberate; tight-schedule is the point of the new pass.
- **PR #41 (BL-H5g, parent edge stripping)** — `runCascade` scrubs parent-level `blockedByIds`/`blockingIds` before dispatch, so the new helper receives a clean graph.
- **Bug 2A.2 fix (`pulse-log/04.01/07-bugfix-pullright-double-shift.md`)** — in diamond/fan-in graphs, read blocker dates from the **original** `taskById` snapshot, NOT the running `updatesMap`. Otherwise fan-in tasks double-shift. Applies here when a seeded upstream blocker's dates are in `updatesMap` AND original `taskById` still holds pre-cascade dates — the new helper must consult `effectiveEnd(t) = updatesMap[t.id]?.newEnd ?? taskById[t.id].end` (same pattern as `gapPreservingDownstream:282-289`).
- **Bookmarked plan `engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md`** — contains the reference design for the tight-schedule topo-sort. PR B's helper is shaped to be extracted later when Bug α ships.

### External References

None. Local patterns are strong.

## Key Technical Decisions

- **Add a new function `tightenDownstreamFromSeed` rather than modifying `gapPreservingDownstream`.** Keeps Bug β surgical; Bug α remains bookmarked. Future Bug α PR refactors `gapPreservingDownstream` to share the helper.
- **Seed from `updatesMap` keys + source.** Broader than "end-changed only" (per doc-review R2β-2). Uses `Object.keys(updatesMap)` + `sourceTaskId` as the reachability seed set. Any upstream task that moved (start, end, or both) anchors the downstream pass.
- **Signature mirrors `conflictOnlyDownstream`**: `tightenDownstreamFromSeed(seedTaskIds, updatesMap, taskById)`. Returns void; mutates `updatesMap` in place; reads from `taskById` with `updatesMap` overlay for effective positions. Same pattern the rest of cascade.js already uses.
- **No early-out.** Unlike `conflictOnlyDownstream` (which skips `task.start >= constraint`), this helper always assigns `newStart = nextBD(max(non-frozen blocker end))`. That's what makes it "tighten."
- **Duration preserved** via `addBusinessDays(newStart, duration - 1)`. Use `countBDInclusive(taskById[task.id].start, taskById[task.id].end)` (same pattern as `gapPreservingDownstream:346`) for each downstream task's duration. **Do not** read `duration` from `updatesMap` — seeded upstream tasks had their own dates changed, but downstream siblings' durations should come from their own pre-cascade state in `taskById`.
- **Frozen handling inherited.** Use `isFrozen(taskById[id])` predicate that the rest of cascade.js already uses. Frozen blockers skipped in max. Frozen downstream tasks skipped entirely.
- **L2 doc note.** The L2 behavior matrix at `ENGINE-BEHAVIOR-REFERENCE.md:29` already says "Upstream then downstream." Code was the one that drifted. This PR brings code into conformance; no L2 change needed beyond a Section 8 changelog entry noting the drift was closed.

## Open Questions

### Resolved During Planning

- **Seed set breadth** (doc-review surfaced): end-only vs start-or-end changed. **Resolved:** broaden to start-or-end via `Object.keys(updatesMap)` — costs nothing, closes a latent edge case where a future upstream function might move start without end.
- **Helper location vs. separate file:** **Resolved:** keep in `engine/src/engine/cascade.js` alongside the other pass functions. Adding a second file fragments the cascade mental model.
- **Should tightening be optional / guarded?** **Resolved:** no. The L2 contract already says start-left is upstream+downstream; the code was just incomplete. Adding the pass unconditionally matches the contract.

### Deferred to Implementation

- **Exact parameter name for seed set:** `seedTaskIds` (a `Set<string>`) vs `seedIds` (a plain array) — match whichever pattern is already in `cascade.js` helpers at implementation time.
- **Whether `tightenDownstreamFromSeed` also seeds the parent relation graph** — `runCascade` already strips parent edges before dispatch (BL-H5g), so unlikely to matter. Verify during implementation.
- **Test fixture authoring detail:** Meg's exact `Draft ICF / Internal Revisions / Client Review R1` shape can be encoded as either a new fixture (`startLeftDownstreamSibling`) or by composing existing fixtures. Decide at test-writing time.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
runCascade dispatch (mode = 'start-left')
│
├── pullLeftUpstream(sourceId, newStart, updatesMap, taskById)      [existing]
│     └── produces updatesMap entries for upstream blockers that moved
│
└── tightenDownstreamFromSeed(seedIds, updatesMap, taskById)         [NEW]
      │   seedIds = { sourceId } ∪ Object.keys(updatesMap)
      │
      ├── BFS downstream from seedIds via taskById[id].blockingIds
      ├── Kahn's topological sort of the reachable non-frozen set
      ├── for each task in topo order:
      │     effectiveBlockerEnd = max over non-frozen blockers of
      │         (updatesMap[bid]?.newEnd ?? taskById[bid].end)
      │     if task is frozen: skip (don't move)
      │     else:
      │         duration = countBDInclusive(taskById[task.id].start, taskById[task.id].end)
      │         newStart = nextBusinessDay(effectiveBlockerEnd)
      │         newEnd   = addBusinessDays(newStart, duration - 1)
      │         updatesMap[task.id] = { taskId, taskName, newStart, newEnd, duration }
      └── returns void
```

Behavioral equivalence: `pullLeftUpstream` already collapses upstream gaps. The new downstream pass does the same for downstream tasks reachable from any upstream-moved blocker. Cross-chain stability-cap logic in `runCascade` is unaffected — it treats the downstream pass as another mode-specific step.

## Implementation Units

- [ ] **Unit 1: Add `tightenDownstreamFromSeed` to `engine/src/engine/cascade.js`**

**Goal:** Introduce the new downstream-tightening helper.

**Requirements:** R2β-1, R2β-3, R2β-4, R2β-5.

**Dependencies:** None.

**Files:**
- Modify: `engine/src/engine/cascade.js`
- Test: `engine/test/engine/cascade.test.js`

**Approach:**
- Add new exported function `tightenDownstreamFromSeed(seedTaskIds, updatesMap, taskById)` modeled on `conflictOnlyDownstream` (see cascade.js:81-168).
- BFS reachable set downstream from each seed via `taskById[id].blockingIds`, skipping seeds not in `taskById`.
- Kahn's topological sort on the reachable set (reuse the pattern already present in `conflictOnlyDownstream`).
- For each task in topo order:
  - If `isFrozen(task)`, continue (frozen downstream tasks don't move).
  - Compute `effectiveBlockerEnd = max over non-frozen blockers of (updatesMap[bid]?.newEnd ?? taskById[bid].end)`. Skip frozen blockers entirely per existing `isFrozen` check.
  - `newStart = nextBusinessDay(effectiveBlockerEnd)`.
  - `duration = countBDInclusive(taskById[task.id].start, taskById[task.id].end)` — same pattern `gapPreservingDownstream:346` uses. Do not read duration from `updatesMap`.
  - `newEnd = addBusinessDays(newStart, duration - 1)`.
  - Write `updatesMap[task.id] = { taskId, taskName, newStart: formatDate(newStart), newEnd: formatDate(newEnd), duration }`.
- Docstring: "Tightens downstream reachable tasks against their effective blocker ends. Seeds from any source+upstream-moved tasks. Frozen tasks skipped; frozen blockers excluded from constraint calculation. Mutates updatesMap in place. Return void."
- **Do NOT** mutate `taskById`. Only `updatesMap`. (Contrast with `gapPreservingDownstream` which does mutate `taskById.start/end` — that's an inconsistency we don't want to propagate here.)

**Patterns to follow:**
- `engine/src/engine/cascade.js:81-168` — `conflictOnlyDownstream` (BFS + topo + per-task loop shape, frozen-skip pattern).
- `engine/src/engine/cascade.js:282-289` — `gapPreservingDownstream`'s "effective end" lookup pattern (`updatesMap[bid]?.newEnd ?? taskById[bid].end`).
- `engine/src/engine/cascade.js:204` — `pullLeftUpstream` frozen-blocker exclusion pattern.

**Test scenarios:** (covered in Unit 3)

**Verification:**
- Function exported and visible from `cascade.js`.
- Code review confirms no `taskById` mutation, only `updatesMap`.
- Lint/typecheck pass (`npm run lint`, `npm run typecheck` if present).

- [ ] **Unit 2: Wire `tightenDownstreamFromSeed` into `start-left` dispatch**

**Goal:** Invoke the new helper from `runCascade`'s `start-left` case after `pullLeftUpstream` completes.

**Requirements:** R2β-1, R2β-2.

**Dependencies:** Unit 1.

**Files:**
- Modify: `engine/src/engine/cascade.js` (the `runCascade` switch statement — `'start-left'` case around line 579)
- Test: `engine/test/engine/cascade.test.js`

**Approach:**
- In the `'start-left'` branch of `runCascade`, after the existing `pullLeftUpstream(sourceId, newStart, updatesMap, taskById)` call, add a second call: `tightenDownstreamFromSeed(seedIds, updatesMap, taskById)`.
- Build `seedIds` as `new Set([sourceTaskId, ...Object.keys(updatesMap)])`. This covers R2β-2 broadened semantics.
- No changes to other mode branches (`push-right`, `end-only-right`, `pull-left`, `drag-left`, `drag-right`, `pull-right`).
- No changes to cross-chain propagation loop — the downstream pass participates the same way `gapPreservingDownstream` does for `pull-left`.

**Patterns to follow:**
- `engine/src/engine/cascade.js` switch dispatch for other modes — observe how they compose multiple pass calls.

**Test scenarios:** (covered in Unit 3)

**Verification:**
- Manual trace: run the dispatch mentally against Meg's Apr 16 scenario (Draft ICF start-left, Internal Revisions downstream sibling of Client Review R1) and confirm Internal Revisions ends up in `updatesMap` with `newStart = nextBD(Client Review R1.newEnd)`.

- [ ] **Unit 3: Test coverage for `start-left` downstream behavior**

**Goal:** Lock the new behavior via unit tests; add the frozen-blocker regression test requested by document-review (SC-7).

**Requirements:** R2β-2, R2β-3, R2β-4, R2β-5 (verification), SC-5, SC-7.

**Dependencies:** Units 1 and 2.

**Files:**
- Modify: `engine/test/engine/cascade.test.js`
- Reuse fixtures: `engine/test/fixtures/cascade-tasks.js` (`fanIn`, `chainWithFrozen`, `multiBlockerStationary`, `linearTightChain`).
- Optionally add new fixture: `startLeftDownstreamSibling` (Draft-ICF / Internal-Revisions / Client-Review-R1 shape).

**Approach:**
- New `describe('start-left downstream pass')` block in `cascade.test.js`.
- Use Vitest patterns (`describe`/`it`/`expect`) consistent with existing tests.
- Each test builds a small `taskById` + `updatesMap` via fixture factories, calls `runCascade` with `mode='start-left'`, asserts the expected `updatesMap` entries.

**Test scenarios:**
- **Happy — sibling tightens:** source task with a downstream sibling sharing a single blocker. After start-left cascade, sibling's `newStart = nextBD(blocker.newEnd)`. No gap.
- **Happy — no downstream siblings:** source task with no downstream reach. `tightenDownstreamFromSeed` runs but produces no additional updates. `pullLeftUpstream`'s output is the entire `updatesMap`.
- **Happy — multi-level downstream chain:** chain where upstream shift propagates through three downstream levels. All three tighten to their effective blocker ends.
- **Edge — frozen blocker in fan-in** (SC-7): downstream sibling has two blockers: one non-frozen (moved by upstream pass) and one frozen. After cascade, sibling tightens against only the non-frozen blocker. Frozen blocker is excluded from max.
- **Edge — frozen downstream task:** a downstream task in the reachable set is frozen. It does not move. Its children (if any, and non-frozen) still tighten against the frozen task's current end.
- **Edge — pre-existing violation:** downstream sibling currently starts before blocker's current end (pre-cascade violation). After start-left cascade, sibling tightens to `nextBD(blocker.newEnd)` regardless of prior state.
- **Edge — stationary blocker guard:** downstream task has a non-frozen blocker that is NOT in the seed set (stationary) AND has a pre-existing gap. Expected behavior: still tighten against `max(all non-frozen blocker ends)` — stationary blocker's current end is the effective constraint. Document this explicitly since BL-H4g semantics differ between "skip on gap" (for push-right) and "always tighten" (here). If uncertain, reference the BL-H4g pulse log and confirm in PR review.
- **Integration — cross-chain propagation still fires:** source and downstream sibling are in different chains connected by a task that lives in both. After downstream tightens, a task in the second chain has a new conflict. Cross-chain loop continues to resolve.
- **Regression — Meg's Apr 16 shape:** reproduce the exact Draft ICF / Internal Revisions / Client Review R1 topology. Assert Internal Revisions's new start = Client Review R1's new end + 1 BD after cascade. Comments cite the origin doc.

**Patterns to follow:**
- Existing `describe` blocks in `cascade.test.js` for fixture setup and `runCascade` call convention.
- `engine/test/fixtures/cascade-tasks.js` factory usage.

**Verification:**
- `npm run test:ci` passes, including all new cases.
- No existing test regresses.
- Regression-test for Meg's exact shape passes.

- [ ] **Unit 4: L2 behavior-ref changelog note**

**Goal:** Record the 2026-04-16 code-contract alignment in the L2 doc's Section 8 changelog. The Section 1 row for `start-left` already correctly specifies upstream+downstream — no table edit needed.

**Requirements:** Source-of-truth compliance (origin doc § "Requirements doc locked + document-reviewed").

**Dependencies:** Units 1–3 merged.

**Files:**
- Modify: `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` (Section 8, append dated entry)

**Approach:**
- Add a 2026-04-16 changelog entry under Section 8:
  > *2026-04-16 — PR B: code aligned with `start-left` behavior-matrix row.* Previously the dispatch ran `pullLeftUpstream` only, producing downstream gaps when a source task's upstream blockers moved. Added `tightenDownstreamFromSeed` downstream pass seeded from `{source} ∪ {upstream-moved tasks}`. No behavior change to the other modes.

**Patterns to follow:**
- Existing Section 8 entries (2026-03-31, 2026-04-12 format).

**Test scenarios:** Test expectation: none — docs-only change.

**Verification:** Manual review of the changelog entry.

## System-Wide Impact

- **Interaction graph:** only `runCascade`'s `start-left` dispatch changes. All other modes untouched. Parent-subtask roll-up untouched. Status-rollup untouched.
- **Error propagation:** the new helper throws only on programmer error (missing `taskById[seedId]`). Any such throw propagates out of `runCascade` and is caught by the existing route-handler try/catch.
- **State lifecycle risks:** the new helper does not mutate `taskById`. Safe across multiple calls within the same `runCascade` invocation.
- **API surface parity:** no changes to route handlers, webhook contracts, or ActivityLog / StudyComment payloads.
- **Integration coverage:** `validateConstraints` post-sweep continues to fix any residual violations; existing cross-chain fixtures stay green.
- **Unchanged invariants:** `conflictOnlyDownstream`, `pullLeftUpstream`, `gapPreservingDownstream`, `pullRightUpstream`, Complete Freeze semantics, parent edge stripping, `validateConstraints`, cross-chain stability cap — none touched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| New pass creates constraint violations for downstream tasks with frozen blockers that tighten past them | Same behavior pattern as existing `pullLeftUpstream` + `validateConstraints`. Already-known inherited behavior — documented as a non-change. SC-7 test locks the semantic. |
| Cross-chain cascade loop hits safety cap more often because more tasks move | Low risk — broadening seeds adds at most `len(updatesMap)` extra reachability roots, not a fundamental algorithm change. Existing cap logic unchanged. |
| `gapPreservingDownstream` mutates `taskById`; new helper doesn't. Parallel calls in future refactors could diverge | Future Bug α refactor unifies both helpers; this PR documents the deliberate non-mutation. Until then, no code calls both in the same phase. |
| "Either ship order with future Bug α PR" claim from requirements doc is ambiguous about shared helper | PR B's helper signature `(seedTaskIds, updatesMap, taskById)` is compatible with Bug α's refactor intent. If Bug α ships after, it extracts `tightenDownstreamFromSeed` as-is. If Bug α never ships, the new helper is self-contained. |

## Documentation / Operational Notes

- No rollout / operational changes. Railway auto-deploys on merge.
- Post-merge: update `clients/picnic-health/foundational/BACKLOG.md` to record Bug β as resolved (origin-level), Bug α as bookmarked handed to Seb.
- Pulse log entry `clients/picnic-health/pulse-log/04.16/NNN-start-left-downstream-pass.md` summarizing the change.

## Sources & References

- **Origin document:** [engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md](engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md) — Item 2 Bug β
- **Related bookmarked plan (Bug α, not in scope):** [engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md](engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md)
- **L2 contract:** [engine/docs/ENGINE-BEHAVIOR-REFERENCE.md](engine/docs/ENGINE-BEHAVIOR-REFERENCE.md) §1 Behavior Matrix (row for `start-left`), §8 Changelog
- **Related code:** `engine/src/engine/cascade.js`, `engine/test/engine/cascade.test.js`, `engine/test/fixtures/cascade-tasks.js`
- **Activity Log event (original repro):** `3442386760c281799d85fea88ef5abf7`
- **Prior related PRs:** #41 (BL-H4g gap-aware stationary guard, BL-H5g parent edge stripping), Bug 2A.2 fix (original blocker dates in fan-in)
