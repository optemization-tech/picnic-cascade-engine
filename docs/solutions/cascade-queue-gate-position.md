---
title: Suppression gates belong at the resource boundary, not inside the eventual compute
date: 2026-05-06
tags: [reliability, observability, queueing, anti-pattern]
related:
  - PR for cascade-queue bot-authored gate at webhook entry
  - docs/plans/2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md
  - docs/solutions/silent-partial-failure-in-async-batches.md
---

# Suppression gates belong at the resource boundary, not inside the eventual compute

## Problem

The cascade webhook queue had three layers of "drop work that won't do anything" gates:

1. **Notion-side automation filter** — would prevent the webhook from firing at all (deferred operator-side change, not yet deployed at the time of the incident).
2. **Per-handler `editedByBot` short-circuits** — `processDepEdit:129` returns immediately when the parsed payload is bot-authored. `processDateCascade` did *not* have a symmetric gate.
3. **Defense-in-depth gates** inside `processDateCascade` (`zero_delta_skip` line 199, `import_mode_skip` line 204) — return early once the cascade has already dequeued and started running.

All three correctly identified bot-authored echoes as no-ops. None ran *before* the cascade-queue's debounce timer was set or its per-study FIFO slot was reserved. So during inception (which PATCHes 200+ tasks while wiring parents/dependencies), Notion fired ~200 "When Dates changes" automations, the engine accepted every one, debounced each for 5 seconds, queued them per-study, and only *then* identified each as a no-op. Per-study queue depth on a single Test study peaked at 187. Real user task moves stacked behind 180+ doomed-to-skip cascades. Wall-clock cascade activity for one study: 12 minutes.

## Why it matters

- **The downstream gate works correctly but at the wrong layer.** "Drop the work" beats "fail to do the work" only when the dropping happens before resource reservation. After debounce + enqueue, the gate has already cost a 5s timer, a queue slot, and serialization behind whatever's already running.
- **Compound resource reservation.** A single study's per-task debounce is independent (good), but the per-study queue is FIFO (necessary, by design). Suppression gates *after* enqueue mean every queued no-op pays sequential time behind real work.
- **Defense-in-depth is necessary but not sufficient.** Multiple layers protect against bugs in upstream layers — but if the layers run in the wrong order (cheap check inside the expensive resource), they don't reduce the resource cost.

## The anti-pattern

```
async function enqueue(payload, parseFn, processFn) {
  const parsed = parseFn(payload)           // cheap
  setTimeout(() => {                         // RESERVES A 5s TIMER ←
    studyQueue.push(payload)                 // RESERVES A FIFO SLOT ←
    processFn(payload)                       // ← gate runs here
  }, debounceMs)
}

async function processFn(payload) {
  if (parsed.editedByBot) return             // ← gate fires after debounce + dequeue
  // ... real work
}
```

Variant: the existing inner-branch check inside `enqueue` (lines 45-49 pre-fix) only fired when a prior debounce timer existed for the same task. For tasks the user hadn't recently edited (e.g., the 200+ tasks being PATCHed during inception), there *was* no prior debounce, so the bot-author check never ran and the bot echo proceeded to `setTimeout`.

## The pattern (load-bearing rule)

> **Cheap suppression gates run at the resource boundary, before resource reservation. Defense-in-depth gates run inside the compute as a backstop, not as the primary signal.**

For an async webhook handler with debounce + queue + downstream compute, the order is:

1. **At enqueue, after parsing**: drop on cheap signals derivable from the payload alone (bot author, missing required fields, explicit skip flags). Returns without setting a timer or reserving a queue slot.
2. **Inside the eventual compute**: re-validate as defense-in-depth — payload may have changed shape between enqueue and dequeue, the upstream filter may have a bug, or a future code path may bypass the queue entirely.

The two layers are not redundant when they cover different failure modes:
- Layer 1 protects the queue's resource budget.
- Layer 2 protects correctness if Layer 1 is missing or buggy or bypassed.

## Detection recipe

When reviewing a new async webhook handler that uses a debounce queue, ask:

- **Q1: Where does the cheapest suppression check run?** If the answer is "inside `processFn`, after debounce and dequeue," the queue is paying for work it will throw away. Move the check up.
- **Q2: What signals are payload-derivable?** Anything the parser already extracts (bot author, missing IDs, malformed shapes) belongs at the queue front door. Anything that requires a Notion fetch, a state lookup, or business-logic computation belongs inside `processFn`.
- **Q3: Does the queue have a "throw away" event?** A no-op that runs through debounce + dequeue pays the same wall-clock cost as a real cascade until it returns. The log event for the dropped work should be distinguishable from the log event for completed work, and the volume of drops should be observable separately from the volume of work.
- **Q4: What's the resource budget under burst?** If 200 echoes can land in 30s during inception, the queue better be able to drop them in O(1) each, not O(debounce + dequeue).
- **Q5: Does defense-in-depth still exist after the front-door gate is added?** The front-door check should be defense-in-depth's *primary* layer, not its replacement. Keep the per-handler gate so direct-call paths and future bypasses are still protected.

## Fix recipe

1. **Identify the resource boundaries** in the async pipeline: webhook receipt, parse, debounce, queue enqueue, dequeue, process. Each boundary is a candidate for a suppression gate.
2. **Move payload-derivable suppression to the earliest boundary.** For this engine's cascade-queue, that's right after `parseFn(payload)` succeeds, before the `parsed.skip || !taskId || !studyId` short-circuit and before any timer is set.
3. **Cover the catch-block.** Parse-error paths often call `processFn` directly to let the route's own guard chain handle malformed payloads. Bot-authored payloads that throw on parse should be dropped via an inline raw-payload check inside the catch block, not allowed to reach `processFn`.
4. **Keep the in-handler gate as defense-in-depth.** When the front-door gate moves up, the in-handler check becomes redundant on the queue-fed path but still protects direct-call paths and future bypasses. Tag it with a comment explaining the layered posture.
5. **Symmetric gates across siblings.** When `processDepEdit` has an `editedByBot` short-circuit and `processDateCascade` does not, the asymmetry is a bug. Add the missing gate.
6. **Distinct log events per layer.** Front-door drops emit `cascade_bot_echo_dropped`; in-handler drops emit `date_cascade_bot_skip`. Volume per event tells you which layer is doing the work, which surfaces both pre-fix regressions and post-fix anomalies.
7. **Auth boundary becomes load-bearing.** When suppression gates key on payload-derived signals (`last_edited_by.type`), the authentication boundary protecting that payload becomes load-bearing for cascade integrity. Production deployments must enforce the auth secret; the boot path should fail-fast if the secret is missing.

## Case study — cascade-queue bot-authored gate at webhook entry

**Symptom.** 2026-05-06: Test study (`3582386760c2806c8376fce014d280f8`) — created at 18:18 UTC, inception completed at 18:20. User moved 2 tasks at ~18:21 expecting ≤30s cascade response. Cascade activity stretched to 18:31:46. Per the operator: "really slow."

**Diagnosis.** Railway logs showed 311 date-cascade webhooks + 14 dep-edit webhooks in the affected hour. 94% of the 455 cascades that ran hit `zero_delta_skip` after dequeue. 0 `import_mode_skip` events fired (Import Mode flipped off as soon as inception's `finally` block ran, *before* the queue had drained the backlogged echoes). Peak per-study queue depth: 187. Two real user task moves were stuck behind ~180 self-triggered no-ops.

**Root cause.** The pre-fix bot-author check at `cascade-queue.js:45-49` lived *inside* the `if (existing)` branch — it only fired when a prior debounce timer covered the same task. For inception's mass writes (every task PATCHed by the engine, no preceding user edit on those task IDs), the check never ran and the bot echo bypassed it to `setTimeout(..., 5000)`. Defense-in-depth `zero_delta_skip` correctly identified each as a no-op, but only after the queue had already grown to depth 187.

A second gap: `processDateCascade` lacked the symmetric in-handler `editedByBot` gate that `processDepEdit:129` already had — so a bot-authored payload with non-zero delta and Import Mode=false (routine right after inception) would have bypassed both `zero_delta_skip` and `import_mode_skip` and run a real cascade.

A third gap: `parseUndoPayload` didn't surface `editedByBot` to the queue, so undo-cascade got no benefit from a queue-level gate keyed on the parsed result.

A fourth gap: the `try/catch` parse-error path in `cascadeQueue.enqueue` called `processFn(payload)` directly, sidestepping any front-door gate added later.

**Fix.**
- Move the bot-author gate to the top of `cascadeQueue.enqueue()`, before debounce timer creation and queue slot reservation. Drop on `parsed.editedByBot === true`.
- Extend the parse-error catch block with an inline `payload.data.last_edited_by.type === 'bot'` check so a malformed bot-authored payload is dropped rather than passed through to `processFn`.
- Remove the now-dead inner `if (existing) if (parsed.editedByBot)` branch and its `debounce_echo_ignored` log event.
- Add the symmetric `if (parsed.editedByBot) return` to the top of `processDateCascade`, mirroring `processDepEdit:129`.
- Extend `parseUndoPayload` to compute and return `editedByBot` using the route's stricter button-click-aware definition.
- Add a production startup assertion: `NODE_ENV=production` must have `WEBHOOK_SECRET` set. The middleware's existing skip-if-unset behavior is preserved for local dev / tests but becomes a fatal error at boot in production.

**Detection signal post-fix.** Volume of `cascade_bot_echo_dropped` log events per route. Expected ~200/inception during the task-wiring phase. Sudden drop or spike outside inception windows indicates upstream Notion automation behavior changed.

**What stayed in place.** All three layers of defense-in-depth gating remain (Notion-side filter deferred, queue front-door gate this PR, per-handler `editedByBot` checks). The position is permanent, not transitional — each layer protects an independent failure mode (Notion drift, queue gate bug, novel bot integration). Future async webhook handlers should mirror this three-layer posture.

## What this learning closes

- Engineers writing new async webhook handlers have a checklist for layering suppression gates correctly.
- Reviewers know what to demand: front-door gate for payload-derivable signals, in-handler gate as defense-in-depth, distinct log events per layer.
- Operators know that "queue depth peaked at N" is a real signal, not a counter that can be dismissed as "expected during inception." Post-fix queue depth should track distinct user actions, not bot writes.

## What it doesn't close

- The Notion-side automation filter (`LMBS != Optemization Bot` predicate on "When Dates changes" / "When Blocked by changes" / "When Subtask(s) changes"). This is a complementary operator-side improvement that eliminates the webhook fire entirely. Engine fix remains as defense-in-depth even when the Notion filter is deployed.
- Per-bot-user-id allowlist refinement. If `cascade_bot_echo_dropped` later surfaces a legitimate non-engine bot integration whose cascades are being silenced, refine the gate to filter on specific bot user IDs (the engine's own provision-pool tokens) instead of all `editedByBot`. Trigger: any drop event for a `bot_user_id` not in the engine's known integration set, observed for >1 day.

## References

- `docs/plans/2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md` (the implementation plan)
- `src/services/cascade-queue.js` (front-door gate + parse-error catch + dead-code removal)
- `src/routes/date-cascade.js` (symmetric in-handler gate)
- `src/routes/undo-cascade.js` (`parseUndoPayload` extension)
- `src/config.js` (production `WEBHOOK_SECRET` assertion)
- `docs/solutions/silent-partial-failure-in-async-batches.md` (adjacent learning: also about gates running at the wrong layer)
