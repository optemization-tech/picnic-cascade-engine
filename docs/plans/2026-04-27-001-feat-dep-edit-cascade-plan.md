---
title: "feat: Dependency-edit cascade — fix start-after-predecessor on Blocked by edits, chain-wide"
type: feat
status: active
date: 2026-04-27
origin: "clients/picnic-health/pulse-log/04.24/001-meg-apr24-dep-edit-cascade-brainstorm.md + Notion page Response to Meg's Report 4/22 (34c2386760c2803ab064fc33540510f5)"
---

# feat: Dependency-edit cascade — chain-wide tightening on Blocked by edits

## Overview

Add a new automation in the cascade engine that fires when a Study Task's `Blocked by` (native Notion relation) is edited by a non-bot user. The handler enforces the rule **"every task starts after its latest predecessor's end"** at dep-wire time: tighten the just-edited task against its non-frozen blockers, then propagate that tightening through the full downstream chain via the existing `tightenDownstreamFromSeed` helper.

This is the engineering implementation of the proposal Meg confirmed on the 2026-04-27 New Features Review call. It closes the structural gap in cascade behavior surfaced by Meg's 2026-04-24 manual-subtask tests: today, the rule is enforced only at date-edit time and only on a few modes; nothing fires when a user wires (or rewires) dependencies with already-bad dates. Without this handler, violations introduced at dep-wire time persist until someone touches dates again — and date-edits don't tighten the chain either, only `start-left` does.

The work is small in surface area (one new route, one new pure helper, one new Notion automation) but high in semantic value: it closes the last open behavior question for PMs adding tasks mid-flight, and it unblocks first-PM rollout of the migrated studies (Meg targets this week).

## Problem Frame

The cascade engine currently has 6 modes, all dispatched from `runCascade` based on `(startDelta, endDelta)` in `engine/src/engine/classify.js`. None of them fire on `Blocked by` edits — only on `Dates` edits. As a result:

- **Adding a task with a blocker that starts before its blocker ends** (Meg's archetypal case): a violation sits silently. PM sees a Gantt chart with overlapping dependent tasks and has to manually drag.
- **Rewiring an existing task's blocker to one that ends after the task already started**: same silent violation.
- **Removing/replacing a blocker so the task could start earlier (gap)**: chain stays stretched against an obsolete predecessor.

Meg's 2026-04-24 testing report (Notion page `34c2386760c2803382ccdd9497460150`, "Meg Test: Apr 24, New Subtasks") surfaced the violation case directly via Test 1 (manual task `Reiterate Draft` wired as blocker for `Initial Internal Review & Revisions of Draft Patient Materials`, dates pre-existing as overlapping). The 2026-04-24 brainstorm (`clients/picnic-health/pulse-log/04.24/001-meg-apr24-dep-edit-cascade-brainstorm.md`) audited the existing 6 modes and confirmed: only `start-left` calls `tightenDownstreamFromSeed`, every other mode either preserves gaps by design or leaves the chain alone. The fix is a new trigger, not a behavior change to any existing mode.

The Notion response doc to Meg (`34c2386760c2803ab064fc33540510f5`) proposed the new automation and posed two scoping questions; the 2026-04-27 New Features Review with Meg + Sebastien resolved both:

- **Q1 → dep-wire only.** Don't add date-drag-time enforcement of the rule. Sebastien: *"I'd rather keep the code simpler. Not try to fix errors, and just make sure we don't have any errors happen in the first place."* The dep-edit trigger fixes violations upfront; date-drag behavior stays gap-preserving.
- **Q2 → chain-wide.** When the dep-edit fires, tighten the full downstream chain via `tightenDownstreamFromSeed`, not just the seed→blocker pair. Sebastien's example: *"you have two tasks right next to each other, and then you add a new one that you want to put in between. Like, you want to make sure that it doesn't change just those two tasks, it just changes the entire chain and pushes everything outside."* Meg confirmed she's removed all non-weekend gaps from the blueprint, so chain-wide tightening is structurally safe (no surprise compressions).

Meg added one nuance during the call: **"if it just adds a task and doesn't add a dependency, then we don't have to do anything."** The trigger fires on `Blocked by` edits, NOT on raw task creation/deletion. A task created without dependencies has no chain to integrate into; it's a free-floating PM-tracked item until the PM wires it.

## Requirements Trace

- **R1** — When a non-bot user edits `Blocked by` on a Study Task whose new latest blocker ends after the task starts (violation), the task pushes to `nextBusinessDay(latest_blocker_end)` and end shifts by the same delta (origin: Notion doc Plan & Scope worked example; meeting Q1 resolution).
- **R2** — When the new latest blocker ends well before the task starts (gap case), the task pulls left to `nextBusinessDay(latest_blocker_end)` so the chain becomes butt-to-butt (origin: brainstorm sub-case 2; meeting Q1).
- **R3** — In both R1 and R2, the full downstream chain re-validates against the new positions and tightens where needed via `tightenDownstreamFromSeed` (origin: meeting Q2 resolution; brainstorm chain-wide preference).
- **R4** — The handler does not fire on raw task add/delete with no `Blocked by` change, and does not fire when bot writes change `Blocked by` (origin: Meg meeting nuance; brainstorm bot-echo guard).
- **R5** — Existing date-edit cascade behavior (gap-preserving for `pull-left`/`push-right`/`drag-*`, chain-tightening for `start-left`) is unchanged (origin: meeting Q1 — *"don't change existing pull-left/push-right date-edit behavior"*).
- **R6** — The new trigger uses the same authentication, debounce (5s), bot-echo guard, and per-study FIFO serialization as existing cascade routes (origin: brainstorm "reuses existing 5s debounce + bot-echo guards"; institutional learning §5).
- **R7** — The behavior is documented in `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` §1 (Behavior Matrix L2 row) and `engine/docs/CASCADE-RULEBOOK.md` so future contributors and Meg can reason about it (origin: institutional learning §"Update L2 row").
- **R8** — Parent tasks (`Subtask(s)` non-empty) are excluded from the cascade via Notion filter + route guard + helper early-return, preserving the BL-H5g parent-edge invariant that `runCascade`'s parent-edge stripping enforces for every other mode (origin: feasibility review P1-1; engine code at `cascade.js:520-540`).

## Scope Boundaries

**In scope**
- New webhook route at `POST /webhook/dep-edit` with auth + debounce + per-study FIFO via existing middleware/services.
- New pure helper in `engine/src/engine/cascade.js` (or co-located file) that tightens the seed against its non-frozen blockers and calls `tightenDownstreamFromSeed` for the downstream chain.
- New Notion automation on Study Tasks DB triggered by `Blocked by` property edit, filtered to non-bot edits and non-empty `Reference Start Date`, posting to the new webhook.
- Updates to `ENGINE-BEHAVIOR-REFERENCE.md` and `CASCADE-RULEBOOK.md` capturing the new trigger.
- Vitest coverage at engine, route, and full-chain layers.

**Out of scope**
- **Date-edit-time enforcement of "start after predecessor end"** — explicitly rejected at the 2026-04-27 meeting (Q1). `gapPreservingDownstream` and `pullLeftUpstream` keep their gap-preserving philosophy. Reopen only if a future Meg/Seb decision reverses Q1.
- **Changes to `tightenDownstreamFromSeed` itself** — its signature and invariants were designed for a second caller; this PR is that caller, not a refactor.
- **Add-task-set / deletion / inception cascades** — those routes already do their own provisioning + relation wiring inside Import Mode and don't need this handler.
- **Replay / heal-pre-existing-violations passes** — the engine since PR #66 (2026-04-21) only fixes the touched subgraph. Pre-existing violations elsewhere in a study are surfaced via `scripts/check-study-blocker-starts.js`, not auto-healed by this handler. Documented as a known limitation.
- **`Blocking` (reverse) edits** — Notion dual-syncs `Blocked by` ↔ `Blocking`. To avoid double-fire, the new automation watches `Blocked by` only. Editing from the `Blocking` side still triggers correctly because Notion writes to the `Blocked by` partner.
- **Raw task creation/deletion without dep change** — does not fire the new handler (Meg's nuance). Existing inception / add-task-set / deletion routes are unchanged.
- **The "new task automation filter" change** Tem and Sebastien also discussed (replacing `created_by ≠ tokens` with `Reference Start Date is empty` on the bootstrap automation). Useful, but a separate concern — tracked in backlog, not this plan.

## Context & Research

### Relevant Code and Patterns

- **`tightenDownstreamFromSeed`** at `engine/src/engine/cascade.js` (~376–442). Pure: mutates `updatesMap` only, never `taskById`, never calls Notion. BFS reachable downstream via `blockingIds` → Kahn topo sort → for each non-seed, non-frozen task: `newStart = nextBusinessDay(max(non-frozen blocker.effectiveEnd))`, `duration = countBDInclusive(task.start, task.end)` from pre-cascade snapshot (Bug 2A.2 pattern: read blocker ends from `updatesMap[bid]?.newEnd ?? taskById[bid].end`). **Note: the function skips seeds in its topo loop** (line 401), so the new handler must compute and write the seed's own update before calling it.
- **`runCascade` switch** at `engine/src/engine/cascade.js` — currently dispatches the 6 modes via `cascadeMode` string. Per repo-research recommendation, the new dep-edit logic does NOT slot in here; it's a fresh route that calls `tightenDownstreamFromSeed` directly. `classify.js` is delta-driven and has no concept of "blocker changed."
- **Webhook route pattern** at `engine/src/routes/date-cascade.js`. Reads payload via `parseWebhookPayload` from `engine/src/gates/guards.js`, replies `200 {ok: true}` immediately, then does async work via `cascadeQueue`. Auth comes from `engine/src/middleware/webhook-auth.js` mounted at `app.use('/webhook', webhookAuth)` in `engine/src/server.js`.
- **`CascadeQueue` debounce** at `engine/src/services/cascade-queue.js`. 5s per-task debounce + per-study FIFO. Drops `editedByBot === true` events at the gate (logs `debounce_echo_ignored`). The new route `enqueue`s into the same singleton — same debounce/echo guard inheritance the date-cascade route gets.
- **`editedByBot` short-circuit** at `engine/src/routes/status-rollup.js` line 49 (`if (parsed.editedByBot) return;`). Defense-in-depth idiom: even when the queue drops echoes, route-level guard returns early. New route mirrors this.
- **Activity Log** at `engine/src/services/activity-log.js` via `logTerminalEvent({ workflow, status, triggerType, cascadeMode, sourceTaskId, ... })`. The `Cascade Mode` Notion select already accepts non-motion strings — `status-rollup` route uses `cascadeMode: 'status-rollup'` — so `'dep-edit'` (or split into `'dep-edit-violation'` / `'dep-edit-gap'`) is precedented.
- **Notion property reads** in `engine/src/notion/properties.js` `normalizeTask`: reads `p['Blocked by'].relation` → `blockedByIds[]` and `p['Blocking'].relation` → `blockingIds[]`. The route will need to read the seed task's full state (not just the webhook payload, which doesn't currently include the relations) to know its current blockers.
- **Test fixtures** at `engine/test/fixtures/cascade-tasks.js` (`linearTightChain`, `linearGappedChain`, `fanIn`, `chainWithFrozen`, `gappedUpstreamChain`, etc.) and `engine/test/fixtures/full-study-task-graph.js` (200-task study with helpers `makeCascadeParams`, `runFixtureScenario`, `findFixtureGapViolations`, `getTaskByName`).
- **`@behavior BEH-*` test tags** — every cascade test prefixes its `it()` with a behavior tag tied to `engine/docs/BEHAVIOR-TAGS.md`. New tests will need new tags (e.g., `BEH-DEP-EDIT-001`).

### Existing Test Patterns

- `engine/test/engine/cascade.test.js` — per-mode unit tests against fixture chains. New helper tests slot in here (or a sibling `dep-edit.test.js` engine-level file if cleaner).
- `engine/test/engine/cascade-full-chain.test.js` — chain-wide invariant suite ("after edit, no gap violations remain"). Already covers `start-left`, `pull-left`, `push-right`. New scenarios for dep-edit slot in here using `findFixtureGapViolations`.
- `engine/test/routes/date-cascade.test.js` — route-level test pattern: `vi.hoisted` mocks on `notion/clients.js`, `services/activity-log.js`, `services/study-comment.js`. New route test `engine/test/routes/dep-edit.test.js` follows the same structure.

### Institutional Learnings

- **`tightenDownstreamFromSeed` was designed for reuse** (`engine/docs/plans/2026-04-16-001-fix-start-left-downstream-pass-plan.md`). Hard-won invariants the new caller must honor: do not mutate `taskById`; seed set = `{source} ∪ Object.keys(updatesMap)` to support fan-in; effective-end lookup is `updatesMap[bid]?.newEnd ?? taskById[bid].end`; duration via `countBDInclusive` from `taskById`, never `updatesMap`; frozen blockers excluded from max, frozen downstream tasks skipped entirely.
- **PR #66 (2026-04-21) deleted `validateConstraints` + `engine/src/engine/constraints.js`** (`pulse-log/04.21/001-pr-66-cascade-simplification-review-merge.md`). The engine fixes only the touched subgraph — there is no post-pass cleanup. The new dep-edit handler must produce a tight schedule on its own. Monitoring: `scripts/check-study-blocker-starts.js` is the standalone CLI for spotting residual violations.
- **`Reference Start Date is empty` filter precedent** (`engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` §11; `CASCADE-RULEBOOK.md` line 47). The `Fill Refs` automation uses this filter as its bootstrap-not-overwrite mechanism. **Critical invariant:** if a `Blocked by` edit fires the new cascade BEFORE Reference is bootstrapped on a manual task, `classify()`'s stale-ref correction would compute `delta = 0` and silently no-op. The new automation gates on `Reference Start Date is not empty` to avoid this. Manual tasks created without dates won't cascade until their Reference is populated — acceptable one-edit lag.
- **Notion `Blocked by` ↔ `Blocking` dual-sync** (`memory/tools-and-integrations.md`; engine convention: write the primary side only). Editing one side triggers a write to both. Filter the new automation on `Blocked by` only to avoid double-fire on a single user action.
- **The 2026-04-15 cascade-gap-tightening plan** (`engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md`) is **superseded** by PR #66's simplification (its rewrite-the-passes approach is no longer current). Don't pattern off it. The 2026-04-16 start-left plan is the canonical reference for this style of work.
- **Verify-before-speculate** (brainstorm Decisions §3): cascade symptoms can be misread from Notion UI snapshots. Activity Log + classify mode trace is source of truth. Live-verify on Meg's Apr 24 study (`34c2386760c2803382ccdd9497460150`) during ce:work, not on Notion UI alone.

### External References

None — pure internal engine work against our own Notion workspace and behavior contract.

## Key Technical Decisions

### D1 — New fresh route, not a new mode in `runCascade`

**Decision:** Add `engine/src/routes/dep-edit.js` and register at `/webhook/dep-edit` in `engine/src/server.js`. Do NOT extend `runCascade`'s `switch (cascadeMode)` with a new case. Do NOT add a new branch to `classify.js`.

**Rationale:** `classify.js` is delta-driven (`computeCascadeMode(startDelta, endDelta)`); the dep-edit trigger has no delta input — it has a seed task whose blockers list changed. Forcing it through `classify.js` would require synthesizing fake deltas. A fresh route keeps the engine's two trigger paradigms (date-driven via `classify.js`, blocker-driven via the new route) cleanly separated. Status Roll-Up is the existing precedent for a non-classify cascade route.

### D2 — Reuse `tightenDownstreamFromSeed` as-is; add a thin orchestrator helper

**Decision:** Keep `tightenDownstreamFromSeed` unchanged. Add a new pure helper in `engine/src/engine/cascade.js` (working name: `tightenSeedAndDownstream`, exact name deferred to implementation) that:
1. Computes the seed's own update against its non-frozen blockers (mirroring the per-task tightening logic inside `tightenDownstreamFromSeed`'s topo loop).
2. Writes `updatesMap[seedId]` with the new start/end (or returns early if seed is already tight, frozen, or has no non-frozen blockers).
3. Calls `tightenDownstreamFromSeed([seedId], updatesMap, taskById)` to propagate.

The helper is exported and called directly from the new route — no `runCascade` indirection.

**Rationale:** `tightenDownstreamFromSeed` deliberately skips seeds in its topo loop because in `start-left` the seed's update was authored by the upstream pass (`pullLeftUpstream`). For dep-edit, no upstream pass runs — the seed is the user's edit target and must be tightened directly. A thin orchestrator makes that responsibility explicit at one site instead of duplicating across the route.

**Alternative considered (rejected):** Modifying `tightenDownstreamFromSeed` to optionally tighten seeds. Rejected because it changes a hard-won invariant used by `start-left` for a different reason (seeds-already-authored-upstream), and the existing function is documented as not mutating seeds — changing that contract would surprise readers of `cascade.js`.

### D3 — Seed set for downstream propagation = `new Set([seedId])` (single-task seed)

**Decision:** When the new route calls `tightenDownstreamFromSeed`, the seed set is `new Set([seedId])` (the user-edited task, just-tightened in updatesMap). Not `new Set([seedId, ...Object.keys(updatesMap)])`.

**Rationale:** In `start-left`, the seed set includes `Object.keys(updatesMap)` because `pullLeftUpstream` may have moved upstream tasks too — those need to be excluded from re-tightening. In dep-edit, only the seed itself is in `updatesMap` before the downstream pass; there's no upstream walk. A single-task `Set` is correct and avoids an off-by-one re-walk of the same task.

**Implementation note:** `tightenDownstreamFromSeed`'s first parameter is a `Set` (uses `seedTaskIds.has(taskId)` at `engine/src/engine/cascade.js:401`). The orchestrator must construct a `Set` literal, not pass an array — calling `.has()` on an array throws at runtime.

### D4 — Cascade Mode label: single string `'dep-edit'`, sub-case in details payload

**Decision:** Activity Log writes use `cascadeMode: 'dep-edit'` (one new mode string), with `details.subcase: 'violation' | 'gap' | 'no-op'` carrying the discriminator.

**Rationale:** The two sub-cases share 100% of the engine logic — only the framing of "why we tightened" differs. Splitting into two cascade-mode strings (`'dep-edit-violation'`, `'dep-edit-gap'`) would imply different mechanisms in the Activity Log column. Status Roll-Up's precedent (one `'status-rollup'` string with sub-detail in the payload) is the right shape. PMs filtering Activity Log by Cascade Mode see one `'dep-edit'` row; Tem debugging a specific case reads `details.subcase`.

### D5 — Notion automation gates: bot exclusion + non-empty Reference + parent exclusion, watching `Blocked by` only

**Decision:** The new Notion automation in Study Tasks DB triggers when `Blocked by` is edited, with three filters:
1. `Last edited by` is not any of the engine's bot integration users (defense-in-depth alongside the engine's `editedByBot` short-circuit).
2. `Reference Start Date` is not empty (avoids the `delta = 0` silent no-op on un-bootstrapped manual tasks; matches `Fill Refs` precedent).
3. `Subtask(s)` is empty (parent tasks excluded from this cascade per D6).

It does NOT also watch `Blocking` (avoids dual-sync double-fire). It does NOT filter on `Created by` (the dep-edit case applies to existing tasks too, not just newly-created ones).

**Rationale:** The three filters cover the failure modes cleanly: bot echo storm (filter 1), un-bootstrapped Reference (filter 2), parent-task invariant violation (filter 3 + D6). Single-side watch (Blocked by) avoids two webhook fires per user action. Engine-side guards (cascadeQueue debounce, route `editedByBot` short-circuit, route parent-task short-circuit) provide defense in depth in case any Notion filter misfires.

**Feasibility note:** Confirm via the Notion automation UI before Unit 3.1 that `Last edited by ≠ <bot integration users>` is settable as an inline trigger condition on a Study Tasks DB property-edit automation. The existing `Fill Refs` precedent (`engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` §11) uses a view-scoped filter, not an inline trigger condition. If Notion's automation UI does not support `Last edited by` inline, fall back to scoping the new automation to a Study Tasks view filtered by `Last edited by ≠ <bot users>` AND `Subtask(s) is empty` AND `Reference Start Date is not empty` (the `Fill Refs` pattern). Engine-side guards still hold either way.

### D6 — Parent tasks are excluded from the dep-edit cascade

**Decision:** The new automation does NOT fire on parent tasks (tasks where `Subtask(s)` is non-empty). Three layers of defense:
1. **Notion automation filter:** `Subtask(s) is empty` (per D5 filter #3).
2. **Route-level guard:** early-return in `engine/src/routes/dep-edit.js` if `parseWebhookPayload`'s `parsed.hasSubtasks === true`.
3. **Helper-level guard (belt and suspenders):** `tightenSeedAndDownstream` returns no-op if seed has `subtaskIds.length > 0`.

**Rationale:** `runCascade` strips parent-task dependency edges from `taskById` before any helper runs (`engine/src/engine/cascade.js:520-540`, BL-H5g invariant). This new handler bypasses `runCascade` (per D1), so without explicit handling it would see un-stripped parent edges and produce results that violate the parent-guard invariant Meg confirmed elsewhere. `classify.js:64-83` also rejects direct date edits on parent tasks via Error 1 — the dep-edit equivalent is "parent tasks should not be cascade triggers."

**Consequence:** A PM editing `Blocked by` on a parent task sees no automatic chain tightening. This is consistent with how the engine treats parent tasks elsewhere (parents derive their dates from their subtasks, not from their own blockers). If a PM needs the parent to relate to a blocker, they should wire the relation on the leaf subtasks instead. This will be documented in the behavior reference docs (Unit 3.2).

**Open question deferred to implementation:** Whether parent-blockers (i.e., the seed is a leaf, but one of its blockers is a parent task) should also be excluded from `max(blocker.end)`. The current `tightenDownstreamFromSeed` doesn't distinguish — it just reads `blocker.end` regardless of `subtaskIds.length`. Cross-reference how `runCascade`'s parent-edge stripping handles this and decide during ce:work; if stripping is the right behavior, add the same step to `tightenSeedAndDownstream`.

## Open Questions

### Resolved During Planning

- **Date-drag-time enforcement of the rule?** → No. Q1 of Notion doc, resolved at 2026-04-27 meeting (Sebastien + Tem).
- **Chain-wide vs seed-only tightening?** → Chain-wide. Q2 of Notion doc, resolved at 2026-04-27 meeting (Sebastien + Meg).
- **Trigger fires on raw task add/delete?** → No, only on `Blocked by` edits (Meg, 2026-04-27).
- **Where does the new route live?** → `engine/src/routes/dep-edit.js`, fresh route (D1).
- **Where does seed-tightening logic live?** → If implemented as a helper, in `engine/src/engine/cascade.js` next to `tightenDownstreamFromSeed`; if inlined, in the route worker (Unit 1.1 outcome-framed; final shape per implementer judgment).
- **One Cascade Mode string or two?** → One (`'dep-edit'` with subcase in details — D4).
- **Notion automation filter shape?** → `Blocked by` watch + `Last edited by ≠ bot integrations` + `Reference Start Date is not empty` + `Subtask(s) is empty` (D5, D6).
- **Parent task handling?** → Excluded via three-layer defense (D6).
- **Notion read pattern?** → Use `queryStudyTasks(studyId)` (single round-trip; matches `date-cascade.js` precedent). Resolved during planning per feasibility review P2-1.
- **Auth?** → Inherits `x-webhook-secret` from `app.use('/webhook', webhookAuth)`.
- **Debounce / serialization?** → Reuse `cascadeQueue` singleton.

### Deferred to Implementation

- **Exact helper function name** (`tightenSeedAndDownstream`, `cascadeFromBlockerEdit`, etc.) — pick during ce:work after seeing the existing naming conventions in `cascade.js` in context. Or skip naming entirely if Unit 1.1's logic ends up inlined into the route worker.
- **Helper vs inline:** whether the seed-tightening logic ends up as a named helper in `cascade.js` or inlined into the route worker. Both are correct; cleanest shape decided during ce:work.
- **Whether to extract the per-task tightening logic into a shared utility** to remove duplication between the new orchestrator and `tightenDownstreamFromSeed`'s topo loop, or leave it as small parallel computation. Decide during ce:work — refactor only if it reduces cognitive load.
- **Activity Log `details` payload exact shape** — match the existing date-cascade `buildActivityDetails` output structure when implementing. Include enough information to reconstruct the decision (seed task ID/name, blocker IDs/ends, computed new start/end, downstream count, subcase string).
- **Whether to also strip parent-blockers from `max(blocker.end)` if a leaf seed has a parent blocker** — D6 open sub-question. Mirrors `runCascade`'s parent-edge stripping at `cascade.js:520-540`. Implementer commits one way during ce:work and documents in the behavior reference.
- **Whether to add a feature flag** for safe rollout. Not strictly necessary given the additive nature (no existing behavior changes), but ce:work can decide if a flag adds value during the first week.
- **Empirical Notion automation UI feasibility** — verify `Last edited by` is settable as an inline filter on a property-edit trigger before Unit 3.1 (D5 feasibility note). Falls back to view-scoped automation if not.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Trigger flow

```
PM edits Blocked by on Study Task in Notion
            │
            ▼
Notion automation fires (filters: non-bot AND Ref Start ≠ empty AND Subtask(s) empty)
            │
            ▼  POST /webhook/dep-edit  (x-webhook-secret)
            │
            ▼
parseWebhookPayload
            │
            ▼  Early-return guards (route, no Activity Log noise):
            │     - parsed.editedByBot? → return 200, no work
            │     - !parsed.hasDates?   → return 200, no work
            │     - parsed.hasSubtasks? → return 200, no work (parent task)
            │
            ▼
res.status(200).json({ ok: true })   ← reply immediately
            │
            ▼
cascadeQueue.enqueue(studyId, taskId)  (5s debounce; per-study FIFO)
            │
            ▼  (after debounce, on dequeue)
            │
            ▼
queryStudyTasks(studyId)  ← single round-trip; returns blockedByIds/blockingIds
            │
            ▼
Build taskById; look up seed by taskId
            │
            ▼  Worker-level guards:
            │     - seed not found?              → log + return
            │     - seed.subtaskIds.length > 0?  → no-op (defense-in-depth, D6)
            │     - no non-frozen blockers?      → no-op
            │
            ▼
Compute seed.newStart = nextBD(max(non-frozen blocker.effectiveEnd))
            │     ├── if newStart === seed.start → subcase: 'no-op' (skip Activity Log)
            │     ├── if newStart > seed.start  → subcase: 'violation'
            │     └── if newStart < seed.start  → subcase: 'gap'
            │
            ▼
updatesMap[seedId] = { newStart, newEnd } (duration preserved from taskById)
            │
            ▼
tightenDownstreamFromSeed(new Set([seedId]), updatesMap, taskById)
            │     (BFS via blockingIds, Kahn topo, tighten each non-frozen, non-seed task)
            │
            ▼
Apply updatesMap via batched PATCH (engine/src/notion/client.js)
            │
            ▼
ActivityLogService.logTerminalEvent({
  workflow: 'Dep Edit Cascade',
  cascadeMode: 'dep-edit',
  sourceTaskId, sourceTaskName, studyId,
  details: { subcase, blockerIds, computedNewStart, downstreamCount, cycleNodes? }
})
```

### Sub-case decision matrix

| Seed state vs blockers | newStart computed | Subcase | Action |
|---|---|---|---|
| Seed is a parent task (`subtaskIds.length > 0`) | n/a | `no-op` (reason: `parent-task`) | Return early per D6. Notion filter should prevent this; route + helper guards are defense in depth. |
| Seed has no non-frozen blockers | n/a | `no-op` | Return early. PM may have removed the only blocker — no chain to integrate into. |
| Seed is frozen (Done) | n/a | `no-op` | Frozen tasks don't move. Skip. |
| `nextBD(max blocker.end) === seed.start` | tight already | `no-op` | Already correct. Don't write, don't log noise. |
| `nextBD(max blocker.end) > seed.start` | future | `violation` | Push seed right + tighten downstream. |
| `nextBD(max blocker.end) < seed.start` | past | `gap` | Pull seed left + tighten downstream. |
| Cycle detected during downstream BFS | n/a | `violation` or `gap` (whichever fired) | Tighten what we can; surface diagnostics from `tightenDownstreamFromSeed` to logs. |

## Implementation Units

### Phase 1 — Engine logic and tests

- [ ] **Unit 1.1 — Implement seed-tightening logic + tests**

**Goal:** Given a seed task whose `Blocked by` was just edited, compute its tight start against non-frozen blockers, propagate downstream via `tightenDownstreamFromSeed`, and return a result the route can log. Realize as a named helper in `engine/src/engine/cascade.js` (working name `tightenSeedAndDownstream`) OR inlined into the route worker — final shape decided during implementation. Outcome is the same; the abstraction question is deferred per Open Questions §"Deferred to Implementation."

**Requirements:** R1, R2, R3, R8 (parent-task gating per D6)

**Dependencies:** None (greenfield logic).

**Files:**
- Modify: `engine/src/engine/cascade.js` (if implementing as helper) OR `engine/src/routes/dep-edit.js` (if inlined; in that case Unit 1.1's logic merges into Unit 2.1 and only the test file is added here)
- Modify: `engine/docs/BEHAVIOR-TAGS.md` (register new `BEH-DEP-EDIT-*` tags introduced by the test scenarios below)
- Test: `engine/test/engine/cascade.test.js` (new `describe('dep-edit cascade', …)` block) OR a new `engine/test/engine/dep-edit-cascade.test.js` if the implementer prefers to keep `cascade.test.js` focused on the 6 motion modes.

**Approach:**
- If implementing as a helper, place it in `engine/src/engine/cascade.js` next to `tightenDownstreamFromSeed`. **Export the new helper at module top level.** The existing `tightenDownstreamFromSeed` stays module-private (the new helper calls it as a peer). Mirror its doc comment style and `Used by:` line.
- Read seed's non-frozen blocker ends; compute `nextBusinessDay(max(...))`. Use `effectiveEnd` lookup pattern (`updatesMap[bid]?.newEnd ?? taskById[bid].end`) for safety even though the route always passes `updatesMap = {}` initially.
- Preserve duration via `countBDInclusive(seed.start, seed.end)` from `taskById`, never `updatesMap` (Bug 2A.2 invariant).
- **Parent-task short-circuit (D6):** if `seed.subtaskIds?.length > 0`, return early with `subcase: 'no-op'` and reason `'parent-task'`. Belt-and-suspenders to the route guard and Notion filter.
- **Parent-blocker stripping (D6 open question):** decide during ce:work whether to also exclude blockers with non-empty `subtaskIds` from the `max(...)` computation, mirroring `runCascade`'s parent-edge stripping at `cascade.js:520-540`. Add a JSDoc note + assert if the decision is to strip; add a corresponding test scenario.
- Pass cycle diagnostics through from `tightenDownstreamFromSeed` (which returns `{topoOrder, cycleDetected, cycleTaskIds}` from `topologicalOrder` or `emptyCycleDiagnostics()` on empty reachable set — verify exact shape in `cascade.js`).
- Return a result object: `{ subcase: 'violation' | 'gap' | 'no-op', reason?: string, cycleDiagnostics, downstreamCount, updatesMap }`.
- Pass `new Set([seedId])` (NOT `[seedId]`) to `tightenDownstreamFromSeed` per D3.

**Execution note:** Implement test-first. The pure-function shape and the small input space (seed + blockers + chain) make TDD fast and the invariants concrete.

**Patterns to follow:**
- `tightenDownstreamFromSeed` at `engine/src/engine/cascade.js:376–442` — invariants and snapshot+overlay pattern.
- Per-task tightening loop body in the same function — reuse the same `effectiveBlockerEnd` computation shape.
- `runCascade` parent-edge stripping at `engine/src/engine/cascade.js:520-540` — pattern reference if helper-level stripping is decided in.
- `BEH-*` tag convention from `engine/docs/BEHAVIOR-TAGS.md`. Add new tags `BEH-DEP-EDIT-{NNN}` per scenario when the test is written.

**Test scenarios:**
- **Happy path — violation, single chain:** A→B with B.start = 7/14, A.end = 7/27 (overlap). Call with seed=B. Expect: `B.newStart = 7/28`, `B.newEnd = 7/28 + (originalDuration - 1)`, `subcase = 'violation'`, no downstream updates (B has no successors).
- **Happy path — gap, single chain:** A→B with B.start = 8/15, A.end = 7/27 (large gap). Seed=B. Expect: `B.newStart = 7/28`, end shifts by same delta, `subcase = 'gap'`.
- **Happy path — chain-wide propagation:** A→B→C, edit B's blocker so A.end moves forward. After tightening B, C must also tighten against B's new end. Expect: `updatesMap` contains both B and C entries; `findFixtureGapViolations` returns empty.
- **Happy path — fan-in:** B has two blockers A1 and A2 with different ends. Seed=B. Expect: `B.newStart = nextBD(max(A1.end, A2.end))`.
- **Edge case — already tight:** A.end + 1 BD === B.start. Seed=B. Expect: `subcase = 'no-op'`, `updatesMap` empty.
- **Edge case — no effective blockers:** seed has empty `blockedByIds` OR all blockers are frozen. Expect: `subcase = 'no-op'`, `updatesMap` empty. (One scenario covering both branches; assertion verifies via two parameterized cases.)
- **Edge case — seed frozen:** Seed has Status=Done. Expect: `subcase = 'no-op'`, frozen seeds don't move.
- **Edge case — frozen blocker excluded from max:** Seed has 2 blockers; one frozen with later end, one non-frozen with earlier end. Expect: `B.newStart = nextBD(non-frozen.end)`, frozen.end excluded.
- **Edge case — frozen downstream task skipped:** A→B→C with C frozen. Edit B's blocker (violation). Expect: B tightens, C is NOT in `updatesMap`.
- **Edge case — parent task as seed (D6):** seed has non-empty `subtaskIds`. Expect: `subcase = 'no-op'`, `reason = 'parent-task'`, `updatesMap` empty.
- **Edge case — parent task as blocker (D6 open question):** seed has a non-frozen blocker whose `subtaskIds` is non-empty. Expected behavior depends on the implementation's resolution of the parent-blocker stripping question — either (a) parent's `end` excluded from max (matches `runCascade` stripping), or (b) parent's `end` included. Implementer commits to one and tests it; documented choice carries to the behavior reference doc in Unit 3.2.
- **Edge case — cycle in graph:** A→B→C→A. **Note:** Notion's UI prevents cycles via `Blocked by` ↔ `Blocking` dual-sync; the fixture must be hand-constructed. Expect: `cycleDiagnostics.cycleDetected === true`; helper returns gracefully; tightening proceeds on the acyclic portion. (May skip this scenario if the fixture work isn't worth the coverage.)
- **Integration — Meg's Apr 24 Test 1 fixture:** Reproduce the meeting's worked example in a named fixture for traceability to the bug report: `Reiterate Draft` (7/14–7/27) wired as blocker for `Initial Internal Review & Revisions` (start 7/14). Seed = IIR. Expect: `IIR.newStart = 7/28`, `subcase = 'violation'`, downstream chain (if present in fixture) tightens. Anchors the test suite to the original report.

**Verification:**
- `npm test` passes including the new tests.
- `tightenDownstreamFromSeed` test suite still passes (no behavior change to existing helper).
- `cascade-full-chain.test.js` invariant suite still passes for `start-left`, `pull-left`, `push-right`.

---

- [ ] **Unit 1.2 — Full-chain integration scenarios in `cascade-full-chain.test.js`**

**Goal:** Confirm chain-wide tightening works correctly against the realistic 200-task study fixture, both for violation and gap sub-cases.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1.1.

**Files:**
- Modify: `engine/test/engine/cascade-full-chain.test.js`

**Approach:**
- Add a new `describe('dep-edit cascade — full chain', …)` block.
- Use `makeFullStudyTaskGraphFixture()` to build a 200-task realistic study.
- Pick a mid-chain task (e.g., `Initial Internal Review & Revisions`); pre-modify its blocker's end to create a violation. Call `tightenSeedAndDownstream`. Assert `findFixtureGapViolations` returns empty afterward.
- Repeat for a gap scenario: shorten a blocker's end so a downstream task has a large gap; call helper; assert chain is butt-to-butt afterward.

**Patterns to follow:**
- Existing `cascade-full-chain.test.js` scenarios for `start-left`, `pull-left`, `push-right` invariants.

**Test scenarios:**
- **Integration — violation propagates chain-wide:** 200-task fixture, edit blocker of mid-chain task to overlap. After helper: every downstream task (BFS reachable) starts strictly after its latest predecessor ends, modulo weekend `nextBusinessDay` semantics.
- **Integration — gap closes chain-wide:** 200-task fixture, shorten blocker of mid-chain task to create a gap. After helper: every downstream task's start equals `nextBusinessDay(latest predecessor end)`.
- **Integration — frozen tasks remain unchanged:** any task with Status=Done in the fixture has unchanged dates after the cascade (and is still frozen).
- **Integration — non-reachable subtree unchanged:** tasks not reachable from the seed via `blockingIds` have unchanged dates.

**Verification:**
- All new tests pass.
- `findFixtureGapViolations` returns empty in the success scenarios; non-empty initial state confirms the test setup actually creates the violation it claims to.

---

### Phase 2 — Webhook route

- [ ] **Unit 2.1 — Create `engine/src/routes/dep-edit.js`**

**Goal:** Webhook handler that receives the Notion automation POST, debounces via `cascadeQueue`, fetches study state, calls `tightenSeedAndDownstream`, applies updates, logs Activity Log.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** Unit 1.1.

**Files:**
- Create: `engine/src/routes/dep-edit.js`
- Test: `engine/test/routes/dep-edit.test.js`

**Approach:**
- Mirror `engine/src/routes/date-cascade.js` shape: `parseWebhookPayload` → early-return guards → `res.status(200).json({ ok: true })` immediately → `cascadeQueue.enqueue(studyId, taskId, async () => { ... })`.
- **Early-return guards (before enqueue), each logged but no Activity Log noise:**
  - `parsed.editedByBot === true` (defense in depth, mirrors `status-rollup.js:49`).
  - `parsed.hasDates === false` (seed has no Reference dates yet — should be filtered by Notion automation, but defense in depth).
  - `parsed.hasSubtasks === true` (parent task per D6 — Notion filter should catch this, but defense in depth).
- Inside the queued worker:
  1. Fetch the full study state via `queryStudyTasks(studyId)` from `engine/src/notion/queries.js` — returns normalized tasks with `blockedByIds`/`blockingIds`. Same pattern as `engine/src/routes/date-cascade.js` (which also uses `queryStudyTasks`). Single round-trip; no separate seed fetch needed.
  2. Build `taskById` from the queried result; look up the seed by `taskId`.
  3. If seed not found in study (rare race — task deleted between webhook and worker), log warning + return.
  4. Call `tightenSeedAndDownstream(seedId, {}, taskById)` (or inlined equivalent per Unit 1.1's chosen shape).
  5. If `subcase === 'no-op'`, **skip Activity Log entirely** (matches status-rollup's silent no-op pattern; PMs don't want noise in the log).
  6. Apply `updatesMap` via existing batched PATCH writer in `engine/src/notion/client.js`.
  7. Log Activity Log with `cascadeMode: 'dep-edit'`, `details.subcase`, `details.downstreamCount`, `details.cycleNodes` (if non-empty), `details.blockerIds`, `details.computedNewStart`.
- Error handling: on any thrown error, log to Activity Log with status=error and post a study comment via existing `studyComment` service (matches existing route error-comment posture from PR #58).

**Execution note:** Implement test-first. Mock `notion/clients.js`, `services/activity-log.js`, `services/study-comment.js` via `vi.hoisted` — match `date-cascade.test.js` mocking idiom.

**Patterns to follow:**
- `engine/src/routes/date-cascade.js` — full route shape.
- `engine/src/routes/status-rollup.js` line 49 — `editedByBot` short-circuit.
- `engine/test/routes/date-cascade.test.js` — mock setup + assertion idioms.

**Test scenarios:**
- **Happy path — violation:** Webhook arrives for a task with overlap; mocks return tasks. Expect: cascadeQueue enqueue called; helper called; PATCH writes for seed + downstream; Activity Log called with `cascadeMode: 'dep-edit'`, `details.subcase: 'violation'`.
- **Happy path — gap:** Same but gap-shaped seed. Expect: same flow, `details.subcase: 'gap'`.
- **Happy path — no-op (already tight):** Webhook arrives, seed already tight. Expect: helper returns no-op; **route skips Activity Log entirely**; no PATCH writes.
- **Edge case — `editedByBot === true`:** Webhook payload's `last_edited_by.type === 'bot'`. Expect: route returns 200 immediately, cascadeQueue NOT called, no Notion reads, no PATCH writes.
- **Edge case — `hasDates === false`:** Webhook arrives for a task without Reference dates. Expect: route returns 200, cascadeQueue NOT called.
- **Edge case — `hasSubtasks === true` (parent task):** Webhook arrives for a parent task. Expect: route returns 200, cascadeQueue NOT called (per D6).
- **Edge case — seed has no Blocked by:** Webhook arrives but seed's current Blocked by is empty (last blocker was just removed). Expect: helper returns no-op; route skips Activity Log; no writes.
- **Edge case — Notion read fails:** `notion/clients.js` mock throws on `queryStudyTasks`. Expect: error logged; study comment posted; no PATCH writes; no Activity Log success row.
- **Edge case — PATCH write partially fails:** Mock returns success on some IDs, error on others. Expect: graceful per-write error logging; Activity Log records final state; no engine crash.
- **Integration — debounce coalesces rapid edits:** Two webhooks for the same seed within the 5s window. Expect: `cascadeQueue.enqueue` called twice but the underlying worker runs once with the latest state.
- **Integration — auth required:** Request without `x-webhook-secret` header. Expect: 401/403 from `webhookAuth` middleware (covered by middleware test, not duplicated here, but route test should still pass with the secret applied).

**Verification:**
- All route tests pass.
- Manual smoke: send a curl to `localhost:3000/webhook/dep-edit` with a faked payload (Cloudflare tunnel pattern from `engine/docs/TESTING-REFERENCE.md`) and confirm Activity Log row appears in dev workspace.

---

- [ ] **Unit 2.2 — Wire route in `engine/src/server.js`**

**Goal:** Route registered under `/webhook/dep-edit` so requests reach the handler, inheriting `webhookAuth` middleware.

**Requirements:** R6

**Dependencies:** Unit 2.1.

**Files:**
- Modify: `engine/src/server.js`

**Approach:**
- Add `import { handleDepEdit } from './routes/dep-edit.js';` at the top.
- Register `app.post('/webhook/dep-edit', handleDepEdit);` next to the existing `date-cascade` and `status-rollup` registrations.
- Confirm `app.use('/webhook', webhookAuth);` is already in place above the route registrations (it is — predates this work).

**Test scenarios:**
- **Integration — server boot:** Server starts with the new route registered; `GET /health` (or equivalent) confirms listening; `POST /webhook/dep-edit` without auth returns 401/403; with auth returns 200 (covered transitively by Unit 2.1's tests).
- Test expectation: minimal server-level test if the existing pattern doesn't have one; otherwise lean on Unit 2.1's integration-level coverage.

**Verification:**
- `npm test` passes including the route test from Unit 2.1.
- Server starts cleanly; new route discoverable via the same surface as existing webhooks.

---

### Phase 3 — Notion automation + docs

- [ ] **Unit 3.1 — Create the Notion automation in Study Tasks DB**

**Goal:** New automation in PicnicHealth's Notion workspace that fires on `Blocked by` edits, filters out bot edits and un-bootstrapped tasks, and posts to the new webhook.

**Requirements:** R4, R5, R6

**Dependencies:** Unit 2.2 (route is live and discoverable).

**Files:**
- Workspace operation in PicnicHealth Notion (Study Tasks DB `40f23867-60c2-830e-aad6-8159ca69a8d6`). Not source-controlled as JSON; documented post-hoc.
- Create: `clients/picnic-health/pulse-log/04.27/NNN-dep-edit-cascade-engine-and-automation.md` (or whichever sequence number) documenting the exact filter spec, headers used, and screenshot of the configured automation.

**Approach:**
- **Pre-flight verification:** Before configuring the live automation, empirically verify in Notion's automation UI that `Last edited by ≠ <bot integration users>` is settable as an inline filter on a property-edit trigger. The `Fill Refs` precedent (`engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` §11) uses a view-scoped filter, not an inline trigger condition, so the inline path is unverified. Document the chosen path in the pulse log:
  - **If inline filter supported:** configure as below.
  - **If only view-scoped supported:** create a Study Tasks DB view filtered by `Last edited by ≠ <bot integration users>` AND `Subtask(s) is empty` AND `Reference Start Date is not empty`, and scope the automation to that view. Engine-side guards still hold; the only difference is where the filter is enforced.
- Trigger: **`Blocked by` property edited.** (Single trigger; not also `Blocking` — D5 dual-sync mitigation.)
- Filters (AND-combined; either inline or via view-scope per pre-flight result):
  - `Last edited by` is **not** any of the engine's bot integration users. List the exact user IDs in the pulse log.
  - `Reference Start Date` is **not empty.** (D5 #2; matches `Fill Refs` precedent.)
  - `Subtask(s)` is **empty.** (D5 #3 + D6: parent-task exclusion.)
- Action: send webhook to the engine's `/webhook/dep-edit` endpoint with `x-webhook-secret` header. Use the same secret value as existing cascade routes.
- Test in dev workspace first if a dev workspace mirror exists; otherwise live-verify on Meg's Apr 24 study (`34c2386760c2803382ccdd9497460150`) with controlled edits.

**Test scenarios:**
- Test expectation: workspace operation; verified by the post-deploy smoke test (see Operational Notes).

**Verification:**
- Pulse log captures the automation's exact filter config and the bot user IDs used.
- Spot edit of a Blocked by relation on a non-bot, non-empty-Reference task triggers a 200 response on the new endpoint (visible in Railway logs).

---

- [ ] **Unit 3.2 — Update `ENGINE-BEHAVIOR-REFERENCE.md` and `CASCADE-RULEBOOK.md`**

**Goal:** Behavior contract reflects the new trigger so future contributors and Meg can reason about it.

**Requirements:** R7

**Dependencies:** Unit 1.1, Unit 2.1 (final shape known).

**Files:**
- Modify: `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` (§1 Behavior Matrix — add a row for `Dep Edit Cascade`; §2 add a section describing the new trigger; §11 add note about the `Reference Start Date is not empty` filter precedent reuse).
- Modify: `engine/docs/CASCADE-RULEBOOK.md` (§1.1 add the new mode; §2.8 confirm 5s debounce inheritance applies; §3.3 document the seed-then-downstream invariant).

(BEHAVIOR-TAGS.md is updated in Unit 1.1 alongside the test creation — moved out of this unit.)

**Approach:**
- Mirror the row format used for existing modes in §1's table.
- Cross-reference D1–D5 from this plan as the rationale anchor for the new section.
- Add a short example walkthrough using Meg's Apr 24 Test 1 setup for clarity (matches the doc's existing "PM scenarios" style).

**Test scenarios:**
- Test expectation: none — documentation. Verified via the post-deploy smoke-test review pass (see Operational Notes).

**Verification:**
- New behavior matrix row reads correctly alongside existing rows.
- A new contributor reading §1 + §2 can answer: when does the new trigger fire, what does it do, what guards exist?

---

(Live smoke verification is captured under "Documentation / Operational Notes" → "Post-deploy smoke test" rather than as a formal implementation unit, since it has no automated assertions and runs after merge/deploy.)

## System-Wide Impact

- **Interaction graph:** New webhook source (Notion automation on Study Tasks DB `Blocked by` property). New route mounted at `/webhook/dep-edit` inheriting existing `webhookAuth`. Reuses `cascadeQueue` (debounce + per-study FIFO), `notion/client.js` (read + batched write), `services/activity-log.js`, `services/study-comment.js` (errors). No new external dependencies.
- **Error propagation:** Route catches errors at the worker boundary, logs to Activity Log with `status=error`, posts a study comment via `studyComment` (existing pattern). Mid-batch PATCH failures don't crash the engine; partially-applied updates are visible in Activity Log + Notion.
- **State lifecycle risks:** None new. Existing cascadeQueue handles concurrent edits via per-study FIFO. Bot-echo is filtered at three layers (Notion automation filter, route guard, queue gate) — defense in depth, no possibility of an infinite loop unless all three are misconfigured simultaneously.
- **API surface parity:** New POST endpoint `/webhook/dep-edit`. No changes to existing endpoints. `cascadeMode: 'dep-edit'` is a new value in the Activity Log `Cascade Mode` Notion select — that select must accept the new option. Either pre-add via Notion UI before deploy, or rely on Notion auto-creating the option on first write (verify with a test Activity Log row before the post-deploy smoke test).
- **Integration coverage:** Cross-layer scenarios beyond unit tests:
  - Notion automation filter + engine echo guard interaction (covered by the post-deploy smoke test).
  - Bot writes from this same engine triggering re-fire — must be silently dropped (covered by Unit 2.1 `editedByBot` test + queue debounce).
  - Concurrent edits on the same study via `cascadeQueue` per-study FIFO (existing invariant; smoke-tested post-deploy if practical).
- **Unchanged invariants:** `runCascade`'s 6-mode dispatch is unchanged. `tightenDownstreamFromSeed`'s signature, behavior, and seeds-skipped-in-topo invariant are unchanged. `gapPreservingDownstream` and `pullLeftUpstream` and `pullRightUpstream` are unchanged — explicitly preserved per Q1 meeting decision (R5). The BL-H5g parent-edge invariant `runCascade` enforces via stripping (`cascade.js:520-540`) is preserved by the new route via the parent-task exclusion (D6) — the new handler doesn't call `runCascade` but maintains the invariant by refusing to operate on parent tasks at all. All existing date-cascade, status-rollup, inception, add-task-set, copy-blocks, deletion, undo-cascade routes are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| **R-1: Dual-sync double-fire on `Blocked by` ↔ `Blocking`.** Notion writes both sides on a single user edit. If the new automation watched both, every edit would trigger twice. | D5: filter on `Blocked by` only. Cross-reference institutional learning §"Notion `Blocked by` ↔ `Blocking` dual-sync". |
| **R-2: Manual task with empty `Reference Start Date` triggers cascade with `delta = 0`, causing silent no-op or unexpected behavior.** | D5: Notion automation filter `Reference Start Date is not empty`. Manual tasks created without dates will not cascade until their Reference is populated. Documented as one-edit lag in the behavior reference. |
| **R-3: Bot-echo storm — engine's own writes re-trigger the new automation.** | Defense in depth: (a) Notion filter `Last edited by ≠ bot integrations`, (b) route-level `editedByBot` short-circuit (mirrors `status-rollup.js:49`), (c) `cascadeQueue` debounce drops bot-edited events at the queue gate (`debounce_echo_ignored`). At least two layers must fail simultaneously for an echo to escape. |
| **R-4: Pre-existing violations elsewhere in the chain don't get fixed by this handler.** Engine since PR #66 fixes only the touched subgraph. | Documented limitation. The new handler claims only "this seed and its downstream chain are tight after the cascade" — it does NOT claim the whole study is tight. Operator runs `scripts/check-study-blocker-starts.js` periodically (or on-demand) to spot residual violations. Out of scope to auto-heal here. |
| **R-5: Cycle in dependency graph.** `tightenDownstreamFromSeed` already returns cycle diagnostics. | Route logs cycle diagnostics to Activity Log `details.cycleNodes`; tightening proceeds on the acyclic portion. PM is responsible for resolving the cycle (Notion doesn't actually allow cycles via UI, but defensively handled in case of API-introduced cycles). |
| **R-6: Race between dep-edit cascade and concurrent date-edit cascade on the same study.** | `cascadeQueue` per-study FIFO already serializes all cascade work for a study. The first cascade runs to completion before the second starts. Activity Log shows them as two distinct rows. |
| **R-7: Adding a blocker that's a Done (frozen) task.** | `tightenDownstreamFromSeed` excludes frozen blockers from the constraint scan. The new orchestrator mirrors this — frozen blockers don't contribute to the seed's `max(blocker.end)`. If all blockers are frozen, seed doesn't move (subcase='no-op'). Tested in Unit 1.1. |
| **R-7b: Parent-task as seed or blocker bypasses BL-H5g invariant** that `runCascade` enforces via parent-edge stripping at `cascade.js:520-540`. | D6: three-layer defense (Notion filter `Subtask(s) is empty`; route guard `parsed.hasSubtasks === true`; helper-level early-return). Open question deferred to ce:work: whether to also strip parent-blockers from `max(blocker.end)` if a leaf seed has a parent blocker — decision documented in behavior reference (Unit 3.2). |
| **R-8: New blocker that creates a fan-in (seed already had blockers; now has more).** | `tightenSeedAndDownstream` and `tightenDownstreamFromSeed` both compute `max(...)` over blocker ends, so fan-in is naturally handled. Tested in Unit 1.1. |
| **R-9: PM rapidly toggles a blocker on/off, causing webhook spam.** | `cascadeQueue` 5s debounce coalesces rapid edits into a single cascade with the latest state. Worst case: one cascade per 5s window. Acceptable for human edit cadence. |
| **R-10: Notion automation runs but webhook delivery fails (network blip).** | Notion automations have their own retry behavior; the engine sees the next successful delivery. If Notion gives up, the violation persists until the next dep-edit on the same task or a manual re-trigger. Out of scope to add a periodic reconciliation pass; Meg can manually trigger by re-saving the relation. |
| **R-11: New `cascadeMode: 'dep-edit'` value not present in the Activity Log Notion select.** | Pre-add the option via Notion UI before deploy, OR confirm Notion auto-creates options on first write. Verify via test Activity Log row before the post-deploy smoke test (see Operational Notes). |
| **R-12: Notion eventual consistency — freshly-fetched seed has stale `Blocked by` (user's edit not yet propagated to read replicas).** | The 5s `cascadeQueue` debounce settles read-after-write timing in practice (Notion typically settles in <2s). If observed in the wild, add a single retry on stale-blocker detection in the worker. Not pre-emptively coded for. |

**External dependencies**
- Engine running on Railway (verified per `clients/picnic-health/foundational/STATUS.md`).
- Notion MCP / API access for the new automation setup (manual UI work).
- `cascadeQueue` and `webhookAuth` middleware unchanged in production (no concurrent refactor planned).

## Documentation / Operational Notes

- **Activity Log Cascade Mode select:** confirm `'dep-edit'` is added as an option before deploy (or accept first-write auto-creation if Notion supports it on this select). `memory/notion-api-guide.md` documents that Notion API typically auto-creates select options on first write, but verify with a test Activity Log row before the post-deploy smoke test.
- **PM-facing language:** when describing this in `ENGINE-BEHAVIOR-REFERENCE.md` §2 and to PMs, frame as: *"When you wire a Blocked by relation, the engine checks the rule 'every task starts after its predecessor ends.' If the chain is overlapping or has a too-large gap against the new blocker, the engine tightens the dependent task and its downstream chain."* Avoid jargon (cascade modes, BFS, etc.) in PM-facing sections.
- **Smoke test cadence:** after first deploy, watch the new endpoint in Railway logs for the first ~10 dep-edits across studies. Look for unexpected `'no-op'` rates (suggests filter is too tight), unexpected error rates, or echo loops.
- **Rollback path:** if the new automation misbehaves, disable the Notion automation (one click in Notion UI). The new route stays deployed but inert. Engine state is unaffected because no other code path uses the new helper.
- **Monitoring:** `scripts/check-study-blocker-starts.js` is the reconciliation tool for spotting residual violations across a study. Keep it as part of the post-deploy verification cadence for the first few studies that exercise the new automation.
- **PR description:** reference this plan, the Notion response doc (`34c2386760c2803ab064fc33540510f5`), Meg's Apr 24 test report (`34c2386760c2803382ccdd9497460150`), and the brainstorm pulse log. Note Q1/Q2 resolutions and D6 (parent-task gating) explicitly so reviewers don't re-litigate scope.

### Post-deploy smoke test

Once the route is deployed and the Notion automation is configured (Phase 3), run the following live-verification sequence on Meg's Apr 24 study (`34c2386760c2803382ccdd9497460150`) and capture observations in a pulse log:

1. **Reset Test 1 setup if needed:** `Reiterate Draft` (7/14–7/27), `Initial Internal Review & Revisions` (start 7/14, no Blocked by yet).
2. **Violation case:** as a non-bot user, wire `Reiterate Draft` as a blocker on `Initial Internal Review & Revisions`. Watch Railway logs for: webhook receipt, debounce window, helper run, PATCH writes. Confirm in Notion: IIR's start moves to 7/28, end shifts by the same delta, downstream chain re-validates. Confirm Activity Log: one new row with `Cascade Mode = dep-edit`, `details.subcase = 'violation'`.
3. **Gap case:** pick a downstream chain task, shorten its blocker's end well below its current start. Verify pull-left + chain tightening. Confirm Activity Log: `details.subcase = 'gap'`.
4. **No-op case:** wire a blocker that's already tight (no actual gap or overlap). Confirm: no Activity Log row written, no PATCH writes.
5. **Bot-echo case:** trigger a bot edit on Blocked by (e.g., via the engine's own write path). Confirm: no cascade fires, no echo loop.
6. **Parent-task case:** edit Blocked by on a parent task. Confirm: Notion automation does not fire (filtered by `Subtask(s) is empty`); even if it did, route returns early without reaching the helper.

**Pass criteria:**
- Activity Log entries match expectations for the violation, gap, and no-op cases.
- No surprise side effects: tasks outside the chain unchanged; frozen tasks unchanged; no echo storm.
- `scripts/check-study-blocker-starts.js` reports zero violations on the study post-cascade.

If any case fails, capture the symptom in a pulse log and decide whether it's a fix-forward or a Notion-automation-disable + revisit.

## Sources & References

- **Origin documents:**
  - [`clients/picnic-health/pulse-log/04.24/001-meg-apr24-dep-edit-cascade-brainstorm.md`](../../../pulse-log/04.24/001-meg-apr24-dep-edit-cascade-brainstorm.md) — brainstorm with mode audit and scope decision
  - Notion page: [Response to Meg's Report 4/22 (`34c2386760c2803ab064fc33540510f5`)](https://www.notion.so/picnichealth/Response-to-Meg-s-Report-4-22-34c2386760c2803ab064fc33540510f5) — scope spec with worked example
  - [`clients/picnic-health/pulse-log/04.24/002-meg-response-doc-rewrite.md`](../../../pulse-log/04.24/002-meg-response-doc-rewrite.md), [`003-meg-response-doc-add-examples.md`](../../../pulse-log/04.24/003-meg-response-doc-add-examples.md) — doc-side work that prepared the spec
  - 2026-04-27 New Features Review meeting transcript (Zoom) — Q1 + Q2 resolution
- **Related code:**
  - `engine/src/engine/cascade.js` — cascade primitives, `tightenDownstreamFromSeed`
  - `engine/src/engine/classify.js` — 6-mode dispatch
  - `engine/src/routes/date-cascade.js` — route pattern reference
  - `engine/src/routes/status-rollup.js` — `editedByBot` short-circuit precedent
  - `engine/src/services/cascade-queue.js` — debounce + per-study FIFO
  - `engine/src/services/activity-log.js` — `logTerminalEvent` API
  - `engine/src/middleware/webhook-auth.js` — `x-webhook-secret` check
  - `engine/src/notion/properties.js` — `normalizeTask` reading `Blocked by` / `Blocking`
- **Related plans / institutional learnings:**
  - `engine/docs/plans/2026-04-16-001-fix-start-left-downstream-pass-plan.md` — canonical reference for `tightenDownstreamFromSeed` design
  - `engine/docs/plans/2026-04-22-001-fix-meg-apr21-feedback-plan.md` — most recent format reference, similar Notion-driven feedback plan
  - `engine/docs/plans/2026-04-15-001-fix-cascade-gap-tightening-plan.md` — superseded by PR #66; do not pattern off
  - `clients/picnic-health/pulse-log/04.21/001-pr-66-cascade-simplification-review-merge.md` — `validateConstraints` removal context
- **Behavior contract:**
  - `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` (§1 Behavior Matrix L2 — add new row; §11 Fill Refs filter precedent)
  - `engine/docs/CASCADE-RULEBOOK.md` (§1.1 cascade modes; §2.8 debounce; §3.3 chain-tightening invariants)
  - `engine/docs/BEHAVIOR-TAGS.md` (add `BEH-DEP-EDIT-*` tags)
- **Test fixtures:**
  - `engine/test/fixtures/cascade-tasks.js` — small named fixtures
  - `engine/test/fixtures/full-study-task-graph.js` — 200-task realistic study
- **Operational:**
  - `engine/docs/TESTING-REFERENCE.md` — Cloudflare tunnel pattern for local automation testing
  - `engine/scripts/check-study-blocker-starts.js` — residual-violation reconciliation CLI
