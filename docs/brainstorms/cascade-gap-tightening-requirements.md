---
date: 2026-04-15
topic: cascade-gap-tightening
status: bookmarked
---

# Cascade Gap Tightening (Meg's BIGGEST ISSUE from 2026-04-14 live testing)

> **BOOKMARKED 2026-04-15 after Meg + Seb call.** Gap did not reproduce live. Possible concurrency issue rather than algorithm bug. Document-review surfaced additional concerns (drag modes, cross-chain blockers, product premise). Paused pending reproduction. See plan file for details.

## Problem Frame

When a PM edits a task's date, the cascade engine currently preserves pre-existing gaps between dependent tasks by shifting them all by the same delta. Meg's feedback from live testing on 2026-04-14 (her study "Meg Test Apr 14"): this creates gaps between tasks every time a date changes, which doesn't match the PM mental model.

Her exact words: *"I'd rather have no gaps preserved between tasks than creating gaps every time a date is changed."*

This reverses the Mar 31 Meg-confirmed spec decision that pull-left (downstream) and pull-right (upstream) should be uniform gap-preserving shifts.

## Concrete Example (from Meg's testing)

Meg shortened **Round 3 Committee Review**'s end date (end moved earlier → `pull-left`). The downstream task **Prepare for IRB Review** shifted left by the same delta, but the original gap between the two was preserved — so a new gap appeared between Round 3's new (earlier) end and Prepare for IRB Review's new (earlier) start. Meg expected the downstream task to close up tight against Round 3's new end.

Railway Activity Log confirms: `pull-left: Finalize SoA and Journey Map (3 updates)` at 20:41 UTC on 2026-04-14 — a small cascade that exposed the gap-preserving behavior.

## Decision (L1 spec change)

Switch from **gap-preserving** to **conflict-only tightening** for all cascade modes that shift dependent tasks. Every task the engine moves closes up to `max(latestBlockerEnd) + 1 BD`. Pre-existing gaps in the cascade path collapse.

## Requirements

**Behavior Change**

- R1. `pull-left` (end moved earlier) — downstream tasks close up tight to their blocker's end + 1 BD, instead of uniformly shifting by the source delta. Pre-existing gaps downstream of the edited task collapse.
- R2. `pull-right` (start moved later) — upstream tasks close up tight to their successor's start - 1 BD, instead of uniformly shifting by the source delta. Pre-existing gaps upstream of the edited task collapse.
- R3. `drag-left` — downstream pass inherits R1 automatically (drag-left = start-left upstream + end-left downstream; the downstream half uses the pull-left function).
- R4. `drag-right` — upstream pass inherits R2 automatically (drag-right = start-right upstream + end-right downstream; the upstream half uses the pull-right function).
- R5. Fan-in tasks (multiple blockers): tighten to `max(blocker.end) + 1 BD` across all non-frozen blockers.

**Unchanged Behaviors**

- R6. `push-right` (end moved later) — already conflict-only per [ENGINE-BEHAVIOR-REFERENCE.md:32](engine/docs/ENGINE-BEHAVIOR-REFERENCE.md:32). No change.
- R7. `start-left` (start moved earlier) — already uses `pullLeftUpstream` with documented "gaps collapse to 0" behavior. No change. This is the pattern the other modes are being extended to match.
- R8. **Source task dates are preserved.** The user's edit stands. Tightening applies only to tasks the engine moves in response.
- R9. **Frozen tasks (Done / N/A) still skipped** by all cascade modes. Complete Freeze semantics unchanged.
- R10. **Parent direct edits still rejected** via the `classify.js` guard with snap-back via `applyError1SideEffects`. Unchanged.
- R11. **Cross-chain propagation continues graph-wide** until stable or the safety cap fires. The tightening rule applies per-task within each pass; the cascade loop structure is unchanged.
- R12. **Parent-subtask roll-up** (case-a / case-b) is unchanged. This PR is scoped to the direct cascade passes, not the roll-up logic.

## Success Criteria

- **SC1.** Meg's Round 3 / Prepare for IRB Review scenario: after shortening Round 3's end by N BD, Prepare for IRB Review's new start is exactly 1 BD after Round 3's new end — no gap.
- **SC2.** After any `pull-left`, `pull-right`, `drag-left`, or `drag-right` cascade completes, no pair of dependent tasks in the affected subgraph has a gap between them (every dependent's start = its latest blocker's end + 1 BD, except where a task was frozen or not in the cascade path).
- **SC3.** `push-right` and `start-left` behavior is byte-identical to before the change (no regressions on modes that already worked correctly).
- **SC4.** Cross-chain propagation still fires when tightening in one chain creates conflicts in another — graph-wide cascade stability preserved.
- **SC5.** All 368 existing tests pass, with modifications to gap-preserving test fixtures to assert tight schedules instead.
- **SC6.** New test coverage: pull-left with pre-existing downstream gaps (gap collapses), pull-right with pre-existing upstream gaps (gap collapses), fan-in tightening to max-blocker, cross-chain tightening propagation, parent rejection still fires on direct parent edits.

## Non-Goals

- No change to the parent-subtask roll-up logic (case-a / case-b).
- No change to Complete Freeze (frozen task semantics).
- No change to the cross-chain propagation algorithm itself — only the per-task movement rule within each pass.
- No change to `push-right` or `start-left` behavior.
- This PR does not address the other three Meg items (parent end-shorten snap-back, repeat delivery ordering, comment noise) — those are separate PRs.

## Documentation Updates Required

Per SOURCE-OF-TRUTH.md change control, L1 / L2 / L3 all move together:

- **L1 — Workflow Requirements Doc (Notion):** Update Sections 4.3 (End-only Left), 4.5 (Start-only Right / Pull Right) to reflect conflict-only tightening. Record the 2026-04-15 reversal of the 2026-03-31 decision.
- **L2 — `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md`:** Update Section 2 "Gap Policy" column for `pull-left`, `pull-right`, `drag-left`, `drag-right` rows. Update Section 8 change log with the reversal note.
- **L2 — `engine/docs/CASCADE-RULEBOOK.md`:** Update Sections 3.2 (Pull-Left), 3.3 (Pull-Right), 3.4 (Drag-Right) with the tight-schedule behavior. Update the function docstrings.

## Code Scope (informational — planning will detail)

Two functions in [engine/src/engine/cascade.js](engine/src/engine/cascade.js) change their internal behavior:

- `gapPreservingDownstream` (line 252) → reshape to conflict-only tightening. Name should change (e.g., `tightenDownstream`).
- `pullRightUpstream` (line 370) → reshape to conflict-only tightening. Name should change (e.g., `tightenUpstream`) or unify with `pullLeftUpstream`.

Existing pattern to follow: `pullLeftUpstream` (line 177), which already implements conflict-only tightening with Bellman-Ford relaxation. Comment: *"Gaps collapse to 0."*

## Open Questions

None. Meg confirmed on 2026-04-14 Slack thread. Scope locked.

## Related Backlog Items

- Replaces/supersedes BL-H1b resolution note (downstream gap behavior).
- Related to BL-H1 (proportional subtask expansion) — orthogonal; this PR does not address parent-subtask case-a propagation.
- The other three items from Meg's 2026-04-14 feedback remain separate PRs:
  - Parent end-shorten snap-back bug
  - Repeat delivery task ordering
  - Comment notification noise (68 notifications)
