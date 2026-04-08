# ENGINE-BEHAVIOR-REFERENCE

This document is the in-repo behavior reference for the cascade engine. It is the source used by the traceability check in `scripts/check-behavior-traceability.js`.

## 1) Core Cascade Modes

- `BEH-MODE-PUSH-RIGHT`: End-only-right (`startDelta == 0`, `endDelta > 0`) pushes downstream dependents right only when their current start violates `nextBusinessDay(latest blocker end)`. Upstream tasks do not move.
- `BEH-MODE-START-LEFT`: Start-only-left (`startDelta < 0`, `endDelta == 0`) pulls upstream blockers left only on conflict. Downstream tasks do not move.
- `BEH-MODE-PULL-LEFT`: End-only-left (`startDelta == 0`, `endDelta < 0`) pulls downstream dependents left by the source's negative business-day delta, clamped against the latest non-frozen blocker. It does not move unrelated blocker chains.
- `BEH-MODE-PULL-RIGHT`: Start-only-right (`startDelta > 0`, `endDelta == 0`) pulls upstream blockers right by the same business-day delta, preserving upstream slack.
- `BEH-MODE-DRAG-LEFT`: Drag-left (`startDelta < 0`, `endDelta < 0`) shifts the whole dependency-connected graph left by the same business-day delta, excluding frozen tasks and stripped parent-level dependency edges.
- `BEH-MODE-DRAG-RIGHT`: Drag-right (`startDelta > 0`, `endDelta > 0`) shifts the whole dependency-connected graph right by the same business-day delta, with the same exclusions.

## 2) Cascade Graph Rules

- `BEH-ENDLEFT-ALL-DOWNSTREAM`: End-only-left can move multiple downstream tasks in one pass; each reachable downstream task moves left by up to the source delta and is clamped by its latest blocker.
- `BEH-PULLRIGHT-ALL-UPSTREAM`: Start-only-right shifts all reachable upstream blockers by the same business-day delta, even when there were gaps.
- `BEH-DRAG-LEFT-FANOUT`: Drag-left translates every reachable branch in a dependency fan-out by the same delta.
- `BEH-CROSSCHAIN-PROPAGATION`: Stationary cross-chain blockers clamp end-only-left movement; drag modes move the connected cross-chain graph instead of using a separate blocker-moving heuristic.
- `BEH-CONSTRAINT-VALIDATION`: After the mode-specific pass, the engine validates dependency constraints topologically and only snaps tasks forward when a violation remains.
- `BEH-CROSSCHAIN-FIXEDPOINT`: A single cascade execution plus constraint validation should converge to a dependency-consistent fixed point for the edited graph.
- `BEH-SAFETY-CAP`: The iterative upstream pull for `start-left` has a hard safety cap.
- `BEH-RESIDUE-REPORTING`: If the safety cap is hit, unresolved residue is surfaced in diagnostics.
- `BEH-MONOTONIC-SAFETY`: Directional passes must move tasks monotonically in the intended direction within one execution.

## 3) Task And Parent Rules

- `BEH-COMPLETE-FREEZE`: Tasks with status `Done` or `N/A` never move during cascades and are ignored as blocking constraints.
- `BEH-BL-H5G`: Parent tasks do not participate in dependency-driven cascading; parent-level dependency edges are stripped before the engine runs.
- `BEH-PARENT-DIRECT-EDIT-BLOCK`: A top-level parent task cannot be directly shifted right; the classifier rejects that edit.

## 4) Route And Automation Rules

- `BEH-GUARD-FREEZE`: Route guards skip cascades triggered from frozen tasks.
- `BEH-GUARD-IMPORT-MODE`: Route guards skip cascades while Import Mode is active.
- `BEH-DEBOUNCE-ECHO`: The cascade queue treats bot echo webhooks as debounced noise instead of user edits.
- `BEH-AUTOMATION-REPORTING`: Success, failure, and no-action outcomes are surfaced consistently in automation reporting and activity logs.

## 5) Current Known Gaps

- V1 parent `case-a` now drags connected dependencies with shifted subtasks, but it still infers a single delta from the parent envelope. It does not yet classify parent edits into distinct start-left, end-left, and drag modes.
- V2 still has no `parentMode`. Its parent fan-out recomputes direct subtask offsets from the moved parent's start date and does not drag dependency-connected tasks beyond those subtasks.
