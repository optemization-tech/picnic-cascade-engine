---
title: "fix: Surface positive feedback for user-initiated no-op cascades"
type: fix
status: active
date: 2026-05-07
origin: "Surfaced 2026-05-07 in a Tem testing session as the user-visible 'engine looks broken' symptom of the post-inception incident. Companion to docs/plans/2026-04-29-002-refactor-webhook-actor-classification-plan.md (which fixes the bot-echo subset of the same incident). Tracked in that plan's Scope Boundaries → Deferred to Follow-Up Work. Status stays draft until the actor-classification plan ships U1+U3+U4 to production — implementation here depends on the `mentionable` flag flowing through the queue."
---

# fix: Surface positive feedback for user-initiated no-op cascades

## Overview

When a user drags a date on a study task and the cascade engine determines no downstream shifts are needed (every dependent task was already past the new date, or every upstream blocker was already loose), the engine silently returns without writing to the Activity Log or setting the source task's Automation Reporting banner. From the user's perspective, this is indistinguishable from "the engine didn't process my edit." The companion actor-classification plan ships the `mentionable` flag through the queue. This plan consumes that flag at the existing silent-noop suppression sites to fork a positive-feedback path for human seeds while preserving the existing silence for engine-bot self-echoes (which is load-bearing for loop prevention — see Risks).

---

## Validation: 2026-05-07 Production Incident

This plan addresses the human-edit subset of the 2026-05-07 production incident (see [`docs/plans/2026-04-29-002-refactor-webhook-actor-classification-plan.md`](2026-04-29-002-refactor-webhook-actor-classification-plan.md) Validation section for the full incident). That incident had two distinct symptom classes:

- **(a) ~155 spurious self-echo cascades** caused by misclassified bot writes — fixed by the actor-classification plan. Once that ships, the queue stays empty after inception and user edits process immediately.
- **(b) Underlying no-op-silent-suppression rule** in [`src/routes/dep-edit.js:179-191`](src/routes/dep-edit.js#L179-L191) and three sibling sites — runs regardless of who initiated the cascade, so even after (a) is fixed, a user dragging a date and finding no downstream shifts STILL sees nothing. This plan addresses that subset.

The dep-edit comment captures the original rationale honestly:

> Silent no-op (matches status-rollup's silent-when-idempotent pattern). Avoids Activity Log noise for: already-tight chains, frozen seeds, seeds with no effective blockers, parent-task seeds that bypassed the Notion filter, etc.

That rationale is correct *for engine-seed cascades*. It is wrong *for human-seed cascades* — a user who just performed an action expects feedback. The fix is to fork the suppression based on the seed source.

---

## Problem Frame

The current silent-noop rule was written when the dominant no-op source was the engine itself. After inception, the engine writes ~150+ task dates in a burst; each write fires a Notion automation webhook back to the engine; the engine processes each as a cascade, finds nothing further to shift (inception placed the dates correctly), and silently returns. Without the silent-noop rule, every one of those 150+ self-echoes would emit an Activity Log entry — pure log spam carrying no information.

The same code path runs for human-initiated edits. Common cases:

- User extends a leaf task's end date by 1 day. Downstream tasks have no dependency on this one. No shifts needed → silent.
- User drags a parent's date earlier within the existing slack. Downstream is already loose enough. No shifts needed → silent.
- User restores a date to its previous value (within tolerance). `zero_delta_skip` short-circuits at [`src/routes/date-cascade.js:218`](src/routes/date-cascade.js#L218) → silent.
- User edits a task whose `Blocked by` chain resolves to all-frozen leaves. `cascade.js:564` returns `depEditNoopResult('already-tight')` → silent.

In every one of these cases the user expects a confirmation that their edit was processed and (informatively) that there was nothing more to propagate. Today they get nothing.

The fix has to preserve silence for engine-seed cascades — both because that is what the original rule was protecting, and because writing an Automation Reporting banner from the engine bot triggers another Notion webhook (see Risk-A below). The `mentionable` flag from the actor-classification plan is the correct discriminator: human seeds get feedback, engine seeds stay silent.

---

## Requirements Trace

- **R1 — Distinguish human-seed no-ops from engine-seed no-ops at every existing silent-noop suppression site.** Use `parsed.mentionable === true` as the human-seed signal (or, during the migration window before the actor-classification plan finishes, fall back to `parsed.editedByBot === false && parsed.triggeredByUserId != null` to derive the same signal from legacy flags).
- **R2 — Human-seed no-ops emit an Activity Log entry.** Status: a new value `no_shifts`, distinct from `success` (which implies property updates landed) and `no_action` (which implies the engine couldn't try). Summary copy: a clear one-liner including source task name and reason (e.g., `No shifts: "Remote visits" — downstream tasks already in range`).
- **R3 — Human-seed no-ops set the source task's `Automation Reporting` property, with copy that matches the engine's actual verdict.** Use the same green ❇️ banner property as shift-success (`STUDY_TASKS_PROPS.AUTOMATION_REPORTING`, id `%3Fj%60i`). Emit as raw `rich_text` with `annotations: { color: 'green_background' }` — matching existing convention at [`src/routes/dep-edit.js:96-110`](src/routes/dep-edit.js#L96-L110) and [`src/routes/date-cascade.js:171-186`](src/routes/date-cascade.js#L171-L186). Do NOT use `buildReportingText` (it prepends its own `❇️` prefix and would double up). Per-reason banner treatment (since `cascade.js` `depEditNoopResult` is called with 6 distinct reasons and they don't all warrant identical UX): `already-tight` + `no-effective-blockers` → `❇️ dep-edit cascade: no shifts needed — downstream already in range` (green, success-style); `seed-frozen` (user edited a Done/N/A task) → `⚠️ frozen task — edit not propagated; downstream cascades only fire on active leaves` (yellow, warning-style — preserves the "don't edit Done tasks" UX intent rather than implying success); `seed-not-found` → log a structured `cascade_seed_not_found` error event AND emit a red error-style banner (this indicates corrupted study state, not a clean no-op); `parent-task` and `seed-no-dates` → unreachable through dep-edit (upstream guards at lines 138, 147 short-circuit before line 179), no banner needed. The `cascadeMode` placeholder in copy is the literal string `'dep-edit'` for U2's fork point and `'cascade'` (or omitted) for U3's `zero_delta_skip` fork. Banner is content-only; do NOT introduce a new property.
- **R4 — The fork emits positive feedback for human seeds; the engine-seed branch is a defensive `else`, not a behavioral gate.** Note: by the time control reaches `dep-edit.js:179` or `date-cascade.js:218`, upstream gates ([`src/services/cascade-queue.js:70`](src/services/cascade-queue.js#L70), [`src/routes/dep-edit.js:129`](src/routes/dep-edit.js#L129), [`src/routes/date-cascade.js:202`](src/routes/date-cascade.js#L202)) have already dropped `parsed.editedByBot === true` payloads — so under correct upstream behavior, `parsed.mentionable === false` cannot reach the no-op fork. The defensive `else` exists for two reasons: (a) future-proofing against a classifier gap that lets a non-person payload through; (b) test surface that exercises the fork's structure. R6's regression-lock test pins the defensive branch, but the framing should not imply that "preserving silence for engine seeds" is the active behavioral concern at the fork — the active concern is delivering positive feedback for human seeds. Loop prevention is owned by the upstream classifier (companion plan), not by this fork.
- **R5 — Consciously decide per silent-noop site whether the human-seed feedback fork applies; document the choice.** The known sites are [`src/routes/dep-edit.js:179-191`](src/routes/dep-edit.js#L179-L191) (`subcase === 'no-op'` branch — primary user-facing site, fork applies), [`src/routes/date-cascade.js:218`](src/routes/date-cascade.js#L218) (`zero_delta_skip` — user-facing, fork applies), [`src/routes/status-rollup.js:82`](src/routes/status-rollup.js#L82) and [`:140`](src/routes/status-rollup.js#L140) (bare `return;` after `desiredStatus === currentStatus` / `desiredStatus === parentStatus` — typically engine-driven, default to "leave silent + add a code comment explaining why"). The engine-side suppression at [`src/engine/cascade.js:564`](src/engine/cascade.js#L564) and [`src/engine/cascade.js:609`](src/engine/cascade.js#L609) (`depEditNoopResult` and the `subcase: 'no-op'` returned from `tightenSeedAndDownstream`) is pure logic with no I/O — it is consumed by the route-level callsites above and is not itself a fork point. R5 does NOT mandate adding feedback to engine-driven paths; positive evidence of a human-driven invocation is required before extending the fork. This is a decision per site, not uniform application.
- **R6 — Implementer must verify the loop-prevention regression-lock.** A test that pins: engine writes the green banner; Notion fires the webhook back; engine receives; classifier returns `mentionable=false`; silent return; **no further writes**. Without this test, shipping risks an infinite loop on every human edit.

---

## Scope Boundaries

- **In scope:** [`src/routes/dep-edit.js`](src/routes/dep-edit.js), [`src/routes/date-cascade.js`](src/routes/date-cascade.js), [`src/routes/status-rollup.js`](src/routes/status-rollup.js) (the silent-noop callsites). [`src/services/activity-log.js`](src/services/activity-log.js) (new `no_shifts` status). [`src/utils/reporting.js`](src/utils/reporting.js) (banner-text builder for the no-shifts case). Tests for both human-seed and engine-seed branches at each callsite, including the loop-prevention regression-lock from R6.
- **Not in scope:**
  - The actor-classification refactor itself ([`docs/plans/2026-04-29-002-refactor-webhook-actor-classification-plan.md`](2026-04-29-002-refactor-webhook-actor-classification-plan.md)) — separate plan, must land first.
  - Re-architecting the per-study queue or the cascade engine's tightness logic — the queue is correct; the consumer-side suppression rule is what needs forking.
  - The Notion-side automation filter audit — tracked in the actor-classification plan's deferred section.
  - Adding a user-facing in-Notion changelog or activity feed — out of scope; this plan only writes to the existing Activity Log DB and Automation Reporting property.
  - Changing the engine-side silent-noop in `cascade.js` itself — that path has no I/O surface, only returns a result object. The fork happens at the route-level consumers that interpret that result.

### Deferred to Follow-Up Work

- A user-facing, in-Notion changelog or feed of cascade activity (long-running ask — separate feature).
- Refactoring the four silent-noop callsites to share a single `emitNoOpFeedback(parsed, reason)` helper — natural after U1-U4 land and the duplication is visible. Not blocking the bug fix.

---

## Context & Research

### Relevant Code

**Silent-noop suppression sites (the fork points this plan touches):**

- [`src/routes/dep-edit.js:179-191`](src/routes/dep-edit.js#L179-L191) — `subcase === 'no-op'` short-circuit; primary user-facing site.
- [`src/routes/date-cascade.js:218`](src/routes/date-cascade.js#L218) — `zero_delta_skip` for webhook-level zero-delta payloads.
- [`src/routes/status-rollup.js`](src/routes/status-rollup.js) — "silent-when-idempotent" pattern (line varies; implementer to locate via `reportStatus`-vs-skip branching).

**Engine-side returns these consume (NOT fork points themselves):**

- [`src/engine/cascade.js:564`](src/engine/cascade.js#L564) — `depEditNoopResult('already-tight')` factory.
- [`src/engine/cascade.js:609`](src/engine/cascade.js#L609) — `subcase: 'no-op'` returned from `tightenSeedAndDownstream`.

**Consumers and helpers:**

- [`src/services/activity-log.js`](src/services/activity-log.js) — `logTerminalEvent` accepts a `status` field; the Notion select option list is implicit (Notion accepts any string into a select property and creates the option lazily). The status string flows through `toStatusName` at line 151.
- [`src/utils/reporting.js`](src/utils/reporting.js) — `buildReportingText(level, content)` returns a level-prefixed rich-text block (with annotation color matching the level). Used by warning/error paths in `date-cascade.js` (e.g., `DIRECT_PARENT_REVERT_WARNING` at line 162). NOT used by the green-success banner path — `dep-edit.js:96-110` and `date-cascade.js:171-186` emit raw `rich_text` directly with `annotations: { color: 'green_background' }`. This plan follows the raw-rich_text convention; do not use `buildReportingText` for the no-shifts banner (it would prepend a duplicate `❇️`).
- [`src/notion/property-names.js`](src/notion/property-names.js) — `STUDY_TASKS_PROPS.AUTOMATION_REPORTING` (id `%3Fj%60i`) is the green banner property on study tasks. Note: `STUDIES_PROPS.AUTOMATION_REPORTING` (id `%5BJmF`) is a separate property on the parent Study page used in different cross-DB workflows ([`src/notion/client.js:341-359`](src/notion/client.js#L341-L359)) — this plan touches the Study Tasks property only.
- [`src/gates/guards.js:78-100`](src/gates/guards.js#L78-L100) — `parseWebhookPayload` returns `parsed.mentionable` post-actor-classification, `parsed.editedByBot` and `parsed.triggeredByUserId` pre-classification.

**Tests that lock in current behavior (must continue to pass — current silent-noop semantic is correct for engine seeds):**

- [`test/routes/dep-edit.test.js`](test/routes/dep-edit.test.js) — at least one test asserts the `dep_edit_noop` log line fires and no Activity Log write happens. This test stays correct for the engine-seed branch and gets a paired human-seed test.
- [`test/routes/date-cascade.test.js`](test/routes/date-cascade.test.js) — `zero_delta_skip` test, same shape.
- [`test/services/activity-log.test.js`](test/services/activity-log.test.js) — status enum tests.

### Institutional Learnings

- **Silent-noop is load-bearing for loop prevention.** When the engine writes shift updates today, each write triggers a Notion webhook back to the engine. The cascade re-runs, finds nothing further to shift (already done), and silently returns. If the silent-noop suppression were removed entirely, every shift would re-trigger a "no further shifts" cascade that wrote an Activity Log entry, which doesn't itself loop — but if the no-op path also wrote the source task's `Automation Reporting` banner, that property write would re-trigger the cascade. Per the existing shift-success path, the Notion `Date Cascade` automation only watches the `Dates` property, not `Automation Reporting` — so the property write is safe IF that automation configuration holds. Implementer must verify this assumption at U2 (see Risk-A).
- **Activity Log status property is a Notion `select`.** Adding a new option (`no_shifts`) is non-destructive — Notion creates the option lazily on first write. But downstream consumers (n8n workflows, dashboards) may have hardcoded filters on the existing values. See Risk-B.
- **The dep-edit comment cites status-rollup's "silent-when-idempotent" pattern as the precedent.** That pattern was introduced for a different reason (a status rollup that hasn't actually changed anything shouldn't write an Activity Log row), but it shares the same code shape. Both should fork on `mentionable` for symmetry — a user who manually changed a child status that didn't roll up to the parent should still get acknowledgment that the engine ran.

### External References

- None applicable — this is internal UX work on the existing Activity Log + Automation Reporting surfaces.

---

## Key Technical Decisions

- **Use `mentionable` (or legacy `editedByBot && triggeredByUserId`) as the discriminator, not a separate `is_user_seed` flag.** The actor-classification plan already encodes this. Adding a parallel flag risks drift between the two definitions.
- **New Activity Log status: `no_shifts`.** Distinct from `success` (engine shifted N tasks; property updates landed) and `no_action` (engine couldn't try; missing Study relation, missing Dates, etc.). Lets analytics differentiate "engine ran, nothing to shift" from "engine ran, shifted N tasks" from "engine couldn't run." Worth a fresh value rather than overloading `success` because downstream consumers querying for "what shifted recently?" should still get a clean answer.
- **Reuse `STUDY_TASKS_PROPS.AUTOMATION_REPORTING` with adapted copy.** Existing pattern; users already recognize the green ❇️ banner. Don't introduce a new property — that would force every consumer (Notion views, dashboards) to learn a new column.
- **Keep the `dep_edit_noop` / `zero_delta_skip` console event regardless.** Diagnostic-only, already grep-friendly, not part of the user-facing surface. Adding the new feedback path is purely additive.
- **Implementer responsibility — verify the Notion `Date Cascade` automation does NOT watch the `Automation Reporting` property** before shipping U2. If it does, the human-seed banner write would re-trigger the cascade, which would correctly classify as bot-seed and silently return — but only if the actor-classification plan is fully deployed first. The combined assumption (`Automation Reporting` not watched, OR classifier reliable) is the loop-prevention contract.

---

## Open Questions

### Resolved during planning

- **Should `zero_delta_skip` ([`src/routes/date-cascade.js:218`](src/routes/date-cascade.js#L218)) get the same feedback?** Yes. Same UX problem (user dragged a date and got nothing), same fix shape. The "delta is zero" might be normalization noise, but from the user's perspective they made an edit and want acknowledgment.
- **Should the engine-side `cascade.js` be the fork point instead of route-level?** No. `cascade.js` is pure logic with no I/O — it returns a result object. The fork belongs at the route-level consumers that interpret the result. Forking inside `cascade.js` would require passing `parsed` deep into pure logic, which complicates testing.
- **Should the new `no_shifts` status reuse `success` to minimize downstream churn?** No. Analytics consumers will want to distinguish them eventually; introducing a new status now is cheaper than splitting `success` later.

### Deferred to implementation

- **Final banner copy review.** R3 specifies per-reason verdicts (`already-tight` / `no-effective-blockers` → green ❇️ "no shifts needed — downstream already in range"; `seed-frozen` → yellow ⚠️ "frozen task — edit not propagated"; `seed-not-found` → red ❌ error-style). Final wording at implementation, after Tem reviews a few real Activity Log entries; the per-reason verdict shapes are settled, only the exact wording is open.
- **Whether to populate `MODIFIED_DATES` on the Activity Log entry in the no-shifts case.** Could be useful for filtering ("show me edits that didn't propagate") but adds complexity. Decide at implementation; default to NOT populating to keep schema simple.
- **Whether `status-rollup.js`'s silent-when-idempotent path needs the same fork or a different one.** Status rollups are typically engine-driven (a child's status change triggers the rollup), not user-driven directly. May not need user-facing feedback at all. Implementer to evaluate per-callsite at U4.

---

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```
// Current shape at dep-edit.js:179 (and analogous at date-cascade.js:218,
// status-rollup.js's idempotent path, etc.):
if (result.subcase === 'no-op') {
  console.log({ event: 'dep_edit_noop', taskId, taskName, studyId, reason })
  return  // silent
}

// Proposed shape — fork on mentionable:
// At dep-edit.js:179 — the U2 fork point. cascadeMode at this site is the literal 'dep-edit'.
const cascadeMode = 'dep-edit'

if (result.subcase === 'no-op') {
  console.log({ event: 'dep_edit_noop', taskId, taskName, studyId, reason: result.reason })

  if (parsed.mentionable === true) {  // human seed (positive feedback)
    // Pick banner shape and Activity Log status by reason. Per R3:
    //   already-tight, no-effective-blockers → green ❇️ success-style
    //   seed-frozen                          → yellow ⚠️ warning-style
    //   seed-not-found                       → red ❌ error-style + structured error log
    //   parent-task, seed-no-dates           → unreachable through dep-edit
    const verdict = noShiftsVerdict(result.reason, cascadeMode)
    // verdict = { bgColor, prefix, copy, status, workflow, triggerType }

    await Promise.all([
      activityLogService.logTerminalEvent({
        workflow: verdict.workflow,             // e.g. 'Dep Edit Cascade'
        status: verdict.status,                 // 'no_shifts' | 'no_action' | 'failed'
        triggerType: verdict.triggerType,       // 'Manual' for human seeds
        sourceTaskId: parsed.taskId,
        sourceTaskName: parsed.taskName,
        studyId: parsed.studyId,
        triggeredByUserId: parsed.triggeredByUserId,
        editedByBot: parsed.editedByBot,
        summary: `${verdict.prefix} "${parsed.taskName}" — ${verdict.copy}`,
        // ... details, executionId, etc., per existing logTerminalEvent shape
      }),
      notionClient.patchPage(parsed.taskId, {
        // STUDY_TASKS_PROPS.AUTOMATION_REPORTING.id === '%3Fj%60i' (verified)
        // Raw rich_text matches existing shift-success convention at dep-edit.js:96-110.
        // Do NOT use buildReportingText — it would double the prefix emoji.
        // Pre-ship verification: confirm the Notion Date Cascade automation watches
        //   the Dates property only, not Automation Reporting (see Risk-A — this is
        //   a NEW assumption, not inherited from the shift-success path which always
        //   wrote both atomically).
        [STUDY_TASKS_PROPS.AUTOMATION_REPORTING.id]: {
          rich_text: [{
            type: 'text',
            text: { content: `${verdict.prefix} ${cascadeMode} cascade: ${verdict.copy}` },
            annotations: { color: verdict.bgColor },  // green_background | yellow_background | red_background
          }],
        }
      }, { tracer }),
    ])
  }
  // else: engine seed. Defensive fall-through — under correct upstream classification
  //   (cascade-queue.js:70, dep-edit.js:129, date-cascade.js:202 already drop bots)
  //   this branch is unreachable. Kept as test surface and future-proofing.
  return
}
```

The same shape applies at `date-cascade.js:218` (zero_delta_skip) and `status-rollup.js`'s idempotent path. U4 either factors out a shared helper (`emitNoShiftsFeedback(parsed, reason, cascadeMode)`) or duplicates the pattern at each callsite — implementer's call based on whether the duplication is annoying enough at the third site.

**No legacy fallback for `mentionable`.** An earlier draft proposed a fallback derivation `editedByBot === false && triggeredByUserId != null` to handle pre-classifier callers. After review: that formula is NOT equivalent to the new `mentionable === true` (today's `editedByBot === false` allows `'integration'`/`'unknown'`/missing-type cases that the new strict-person classifier rejects), so the fallback would re-introduce the exact Pattern B loop hazard the companion plan exists to prevent. Conservative default instead — when `parsed.mentionable === undefined`, treat as engine-seed (silent), AND emit a structured `webhook_actor_legacy_fallback` telemetry event so observability flags any callsite that hasn't been migrated:

```
if (parsed.mentionable === undefined) {
  console.log(JSON.stringify({
    event: 'webhook_actor_legacy_fallback',
    route: 'dep-edit',
    reason: 'mentionable_undefined',
    triggeredByUserId: parsed.triggeredByUserId,
    editedByBot: parsed.editedByBot,
  }))
  return  // silent default — do NOT emit positive feedback when classification is unverified
}
```

This is a hard pre-condition: the actor-classification plan must ship `parseWebhookPayload` migration (its U4) to all callsites before this plan's U2/U3 deploy. The telemetry event is the canary — if it ever fires post-deploy, a callsite was missed and the fix is to migrate that callsite, not to widen the fallback.

---

## Implementation Units

- U1. **Add `no_shifts` status to ActivityLogService**

**Goal:** Extend the Activity Log status to accept `'no_shifts'` as a new value. Verify Notion's lazy-creation of the select option works as expected.

**Requirements:** R2.

**Dependencies:** None.

**Files:**
- Modify: [`src/services/activity-log.js`](src/services/activity-log.js) (extend `toStatusName` if it has an explicit allowlist; otherwise this is a no-op since the function already passes the string through to Notion).
- Modify: [`test/services/activity-log.test.js`](test/services/activity-log.test.js) — add a test that calls `logTerminalEvent` with `status: 'no_shifts'` and asserts the Notion `pages.create` payload carries `[STATUS.id]: { select: { name: 'no_shifts' } }`.
- Optional: a small ops script to pre-create the select option in Notion before U2 deploys, so the first real-world write doesn't race the option creation. Decide at implementation.

**Approach:** `toStatusName` is an explicit allowlist ([`src/services/activity-log.js:18-22`](src/services/activity-log.js#L18-L22)) that today maps `'failed'` → `'Failed'`, `'no_action'` → `'No Action'`, and **everything else** → `'Success'`. Without modification, `status: 'no_shifts'` lands in Notion as `'Success'` — silently indistinguishable from real shift-success entries, defeating the entire purpose of the new status. The required modification: add `if (status === 'no_shifts') return 'No Shifts';` before the catchall return. The Notion select option name on the wire is the title-case `'No Shifts'`, matching the existing convention (`'No Action'`, `'Failed'`); the engine-side string is the snake_case `'no_shifts'`.

**Test scenarios:**
- Happy path: `logTerminalEvent({ status: 'no_shifts', ... })` writes the entry; the Notion `pages.create` payload's STATUS property carries `{ select: { name: 'No Shifts' } }` (title case, NOT the snake-case engine code — `toStatusName` does the casing). Mirrors existing `test/services/activity-log.test.js:62-82` which pins `'no_action'` → `'No Action'` and `'failed'` → `'Failed'`.
- Schema validation: existing tests for `success` / `error` / `no_action` still pass unchanged.
- Defensive: if Notion responds with an option-not-found error (rare but possible), the existing failure-path is preserved (graceful warn, no crash).

**Verification:** `npm run test:ci` passes. Manual smoke: dispatch one real `no_shifts` write to staging Activity Log DB and verify the option appears in Notion's select column UI.

---

- U2. **Add positive-feedback emission to `dep-edit.js` no-op branch**

**Goal:** The no-op return at [`src/routes/dep-edit.js:179-191`](src/routes/dep-edit.js#L179-L191) forks based on `parsed.mentionable` (with the legacy fallback). Human seed → Activity Log entry + Automation Reporting banner. Engine seed → silent (current behavior).

**Requirements:** R1, R2, R3, R4, R6.

**Dependencies:** U1.

**Files:**
- Modify: [`src/routes/dep-edit.js`](src/routes/dep-edit.js) — add the fork at line 179.
- Modify: [`src/utils/reporting.js`](src/utils/reporting.js) — only if a shared helper for the no-shifts banner content emerges as useful across U2 and U3. The default convention (matches existing shift-success paths at [`src/routes/dep-edit.js:96-110`](src/routes/dep-edit.js#L96-L110) and [`src/routes/date-cascade.js:171-186`](src/routes/date-cascade.js#L171-L186)) is to emit the green banner as a raw `rich_text` with `annotations: { color: 'green_background' }` — NOT to use `buildReportingText`, which prepends its own `❇️` prefix and would double up. Reuse the raw convention.
- Modify: [`test/routes/dep-edit.test.js`](test/routes/dep-edit.test.js) — see Test scenarios below.

**Approach:** Reuse the existing shift-success path's Activity Log call shape; the new `status: 'no_shifts'` and `summary: 'No shifts: ...'` are the only deltas. The banner write reuses `notionClient.patchPage` and `STUDY_TASKS_PROPS.AUTOMATION_REPORTING` exactly as the shift-success path does. Both writes happen in parallel via `Promise.all` to keep latency low.

**Patterns to follow:**
- The shift-success path in `date-cascade.js` writes both the Activity Log entry and the Automation Reporting banner; mirror that structure.
- The legacy-fallback branch in [`src/services/activity-log.js:175`](src/services/activity-log.js#L175) (`event.triggeredByUserId && !event.editedByBot`) is the same legacy-flag derivation we need; if the actor-classification plan's U2 lands first, `parsed.mentionable` is canonical and the fallback is dead code.

**Test scenarios:**

Human-seed positive feedback (per-reason verdicts from R3):
- **`already-tight` reason** (downstream already in range) → `dep_edit_noop` console event AND Activity Log entry with `status: 'no_shifts'` (Notion select: `'No Shifts'`) AND source task's `Automation Reporting` updated to green ❇️ "no shifts needed — downstream already in range".
- **`no-effective-blockers` reason** → same shape as `already-tight`: green ❇️ success-style.
- **`seed-frozen` reason** (user edited a Done/N/A task) → Activity Log entry with `status: 'no_action'` (NOT `'no_shifts'` — the engine couldn't propagate, didn't decide nothing was needed) AND source task banner is YELLOW ⚠️ "frozen task — edit not propagated". Preserves the "don't edit Done tasks" UX intent.
- **`seed-not-found` reason** (corrupted study state) → Activity Log entry with `status: 'failed'` AND structured `cascade_seed_not_found` error log AND source task banner is RED ❌ error-style.
- **`parent-task` and `seed-no-dates` reasons** → these are unreachable through dep-edit (upstream guards at lines 138, 147 short-circuit). Test asserts they DO short-circuit and never reach the no-op branch — protects against a future regression that removes the upstream guards.

Engine-seed defensive branch (unreachable under correct upstream behavior):
- **`parsed.mentionable === false` reaches the fork** (e.g., simulated by mocking the upstream gates) → `dep_edit_noop` console event AND no Activity Log entry AND no banner update. Defensive `else` works as designed; this scenario should not occur in production.
- **`parsed.mentionable === undefined`** (legacy caller, classifier not yet migrated) → `webhook_actor_legacy_fallback` telemetry event AND silent return AND no Activity Log entry AND no banner. Conservative default.

`@behavior` tag preservation:
- **`BEH-DEP-EDIT-ROUTE-NOOP-SILENT` (existing test at `test/routes/dep-edit.test.js:172-192`)** must be modified, not preserved as-is. The existing test's `happyParsed()` likely represents a human-seed case (the common shape), so the assertion `logTerminalEvent.not.toHaveBeenCalled()` will INVERT under this plan's behavior. Two paths: (a) modify `happyParsed()` to add `mentionable: false` so the existing test now means "engine-seed happy path no-op (defensive branch)" with the silent assertion intact; (b) add a new test with `@behavior BEH-DEP-EDIT-ROUTE-NOOP-HUMAN-FEEDBACK` that asserts the human-seed positive emission. Both are required — the `@behavior` tag becomes ambiguous about what `BEH-DEP-EDIT-ROUTE-NOOP-SILENT` pins otherwise.

Loop-prevention regression-lock (R6):
- **Simulated banner-write echo:** mock the engine writing the green banner; next webhook arrives with `last_edited_by` matching a known bot id; classifier returns `mentionable: false`; dep-edit runs to no-op; **no further writes**. Pin this with a unit test (assert no `notionClient.patchPage` call on the engine-seed branch) AND an integration-shape test (the cascade-queue front-door gate at `cascade-queue.js:70` drops the echo before dep-edit even runs).

Failure-path resilience:
- Activity Log write 5xxs but banner write succeeds → cascade still considered successful, error logged, no crash. **User-visible outcome:** banner appears on task; row missing in Activity Log DB. Acceptable but observability-degraded — log a structured `noop_feedback_partial_success` event so dashboards can flag the rate.
- Banner write 5xxs but Activity Log succeeds → cascade considered successful, error logged, no crash. **User-visible outcome:** Activity Log row exists; user dragging the task sees no banner (partial regression of the symptom this plan fixes). Log structured `noop_banner_failed` event; consider falling back to a `notionClient.reportStatus` call as backup signal. Symmetric framing of the two failures is misleading — the banner is the user-visible signal; its failure is a UX regression while Activity Log failure is only an audit-trail regression.

**Verification:** `npm run test:ci` passes. Staging smoke test: manually drag a date on a study task that has no downstream dependents; observe Activity Log entry appears and green banner shows on the task within ~3 seconds.

---

- U3. **Add positive-feedback emission to `date-cascade.js` zero_delta_skip**

**Goal:** Same fork as U2, applied to [`src/routes/date-cascade.js:218`](src/routes/date-cascade.js#L218) (`zero_delta_skip`). Banner copy is slightly different (`❇️ no change to propagate — dates within tolerance`) because the user's edit didn't actually create a new date in the engine's view.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U1. Independent of U2 — can parallelize.

**Files:**
- Modify: [`src/routes/date-cascade.js`](src/routes/date-cascade.js) — fork at line 218.
- Modify: [`test/routes/date-cascade.test.js`](test/routes/date-cascade.test.js).

**Test scenarios:** Mirror U2: human / engine seed × zero_delta path. Same loop-prevention regression-lock.

**Verification:** Per U2.

---

- U4. **Sweep `status-rollup.js` and `cascade.js` consumers for analogous suppression sites**

**Goal:** Find any other "no-op silently" branches outside dep-edit and date-cascade and apply the same fork. The `status-rollup.js` "silent-when-idempotent" pattern referenced in dep-edit's comment is the obvious candidate; verify whether it's user-driven enough to warrant the fork, or whether it's purely engine-internal (in which case leave it silent).

**Requirements:** R5.

**Dependencies:** U2 (to learn the pattern).

**Files:**
- Modify: [`src/routes/status-rollup.js`](src/routes/status-rollup.js) and its tests, IF the analysis says the fork applies there.
- Modify: any other route-level consumer of `cascade.js`'s no-op result that this audit surfaces.

**Approach:** Start from the explicit known list, NOT a grep. The grep tokens originally proposed (`silent`, `idempotent`, `no-op`, `noop`, `subcase === 'no-op'`) miss the actual silent-when-idempotent returns at [`src/routes/status-rollup.js:82`](src/routes/status-rollup.js#L82) and [`:140`](src/routes/status-rollup.js#L140), which are bare `return;` statements after `if (desiredStatus === currentStatus)` / `if (desiredStatus === parentStatus)` with no matching keywords in their immediate context. Known sites for U4 to evaluate:

1. `status-rollup.js:82` — `if (desiredStatus === currentStatus) return;` — typically engine-driven (a child status change triggers the rollup); default outcome **leave silent**, add a code comment explaining why ("engine-driven path; user-seed reaches here only via the parent-direct branch which already emits to Activity Log").
2. `status-rollup.js:140` — `if (desiredStatus === parentStatus) return;` — same shape, same default.
3. Any additional silent-return sites surfaced by a structural sweep: locate every bare `return;` inside `src/routes/` that follows a comparison guard AND is NOT preceded by an Activity Log write or `reportStatus` call. For each candidate, ask: "does this site ever fire for a human seed?" If no positive evidence, leave silent + comment. If yes, apply the U2/U3-style fork. Default conservative.

R5 explicitly does NOT mandate "apply uniformly" — the rule is "consciously decide per site, document the choice." A site left silent in U4 is a documented decision, not a missed sweep.

**Test scenarios:** For each suppression site that gets the fork, paired human / engine tests as in U2. For sites left silent, a one-line code comment explaining why (the path is engine-only) so future reviewers don't re-open the question.

**Verification:** Sweep grep produces zero unexamined silent-noop sites. Each documented site is either forked or has a "engine-only, intentional silence" comment.

---

- U5. **Documentation and operational notes**

**Goal:** Update [`docs/ENGINE-BEHAVIOR-REFERENCE.md`](docs/ENGINE-BEHAVIOR-REFERENCE.md) to document the new positive-feedback semantic at the cascade-engine behavior contract level. Note the new `no_shifts` status value for downstream Activity Log analytics consumers.

**Requirements:** R5 (operational completeness).

**Dependencies:** U2, U3, U4.

**Files:**
- Modify: [`docs/ENGINE-BEHAVIOR-REFERENCE.md`](docs/ENGINE-BEHAVIOR-REFERENCE.md) — add a section on no-op feedback, distinguishing engine-seed (silent) and human-seed (Activity Log + banner).
- Optional: notify n8n workflow owners (via Slack or pulse log) that a new Activity Log status value is now possible, so downstream filters can opt in if useful.

**Test scenarios:** None — documentation only.

**Verification:** Documentation references match the implemented behavior. A future reader can find the engine vs human distinction without reading code.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **Risk-A: Banner write on no-op re-triggers the cascade webhook from Notion; if the cascade isn't classified as bot-seed on echo, an infinite loop forms.** Compounded by a NEW assumption this plan tests for the first time: existing shift-success paths always write `Dates` AND `AUTOMATION_REPORTING` atomically (`buildUpdateProperties` at `dep-edit.js:99-108` and `date-cascade.js:171-186`), so the absence of looping today is consistent with the Notion automation watching either (a) `Dates` only or (b) both — only (a) is safe for this plan, which writes `AUTOMATION_REPORTING` ALONE. Production has never observed an `AUTOMATION_REPORTING`-only write. | Three-layer mitigation: (1) Hard pre-condition — actor-classification plan U1+U3+U4 deployed to production with telemetry confirming `mentionable` is reliable, plan stays at `status: draft` until satisfied. (2) Pre-ship inspection — directly verify the Notion `Date Cascade` automation's trigger-property filter (admin export or screenshot, NOT inferred from production behavior); confirm it watches the `Dates` property only, not `Automation Reporting`. (3) Staging dry-run — before shipping U2 to production, run a single `AUTOMATION_REPORTING`-only write to a test task in staging and observe whether the cascade webhook fires; only ship if it does not. (4) U2's loop-prevention regression-lock test (R6) pins the post-classifier behavior in unit-test space. If layers (2) and (3) reveal that the automation also watches `AUTOMATION_REPORTING`, this plan halts and a different feedback channel must be selected (e.g., a separate "Cascade Result" property the automation does not watch). |
| **Risk-B: New Activity Log status (`no_shifts`) breaks downstream consumers.** n8n workflows or dashboards may filter on the existing enum. Adding a new value is non-destructive at the Notion layer, but consumers with hardcoded `status === 'success'` filters will silently miss the new entries. | Audit downstream consumers (n8n workflows, any dashboards) before merging U2. Identify any that filter on `status` and notify owners. The new value is additive — existing filters keep working — but consumers wanting both shift-success and no-shifts visibility need to update. |
| **Risk-C: Pre-classifier legacy callers won't have `mentionable` set; a permissive fallback would re-introduce the Pattern B loop.** No fallback is provided — when `parsed.mentionable === undefined`, the kill-switch fires (silent default + `webhook_actor_legacy_fallback` telemetry event). | Ship this plan AFTER the actor-classification plan U1+U3+U4 is fully deployed AND `webhook_actor_legacy_fallback` telemetry shows zero firings for at least 48 hours of normal traffic. If the kill-switch fires post-deploy, a callsite of `parseWebhookPayload` was missed during the actor-classification migration; the fix is to migrate that callsite, not to widen this plan's logic. The kill-switch is the canary for incomplete classifier deployment. |
| **Risk-D: Re-introduces some Activity Log volume that the original silent-noop rule was avoiding.** | Volume is bounded by human edits, not engine self-echoes (which stay silent). Empirically this should be a small fraction of total Activity Log writes. Monitor volume after the first deploy; if surprisingly high, sample entries to confirm they're real human edits, not a regression in the bot-skip filter (which would indicate the actor-classification plan has a gap). |
| **Risk-E: User confusion if the banner copy doesn't make clear that "no shifts" is success, not failure.** | Final copy review at implementation. The leading green ❇️ emoji and explicit "no shifts needed — downstream already in range" wording carry the success framing; avoid neutral or ambiguous phrasing like "cascade complete" that a user might read as "did nothing." |

---

## Sequencing & Estimate

**Pre-condition:** Actor-classification plan ([`docs/plans/2026-04-29-002-refactor-webhook-actor-classification-plan.md`](2026-04-29-002-refactor-webhook-actor-classification-plan.md)) U1+U3+U4 deployed to production. `parsed.mentionable` flowing reliably through every callsite this plan touches.

1. **U1** (Activity Log status): quarter-day. Standalone, mergeable on its own with zero behavioral impact.
2. **U2** (dep-edit no-op fork): half-day. Depends on U1.
3. **U3** (date-cascade `zero_delta_skip` fork): half-day. Can parallelize with U2 across two PRs.
4. **U4** (sweep `status-rollup.js` and friends): quarter-day. After U2 and U3 to learn the pattern.
5. **U5** (docs): quarter-day. Last.

Total: ~1.5 dev-days. Spread across one focused day if shipping rapidly, or alongside other work over a week.

---

## Sources & References

- **Origin discussion:** Tem testing session, 2026-05-07 (this conversation)
- **Companion plan:** [`docs/plans/2026-04-29-002-refactor-webhook-actor-classification-plan.md`](2026-04-29-002-refactor-webhook-actor-classification-plan.md) — must land first
- **Production logs reference:** Railway logs 2026-05-07 21:54 UTC – 22:06 UTC (study `35923867-60c2-804f-b3a6-e738810d4439`); 130-task drain showed every cascade resolving to `dep_edit_noop reason="already-tight"` with zero user-visible feedback
- **Related code:** [`src/routes/dep-edit.js:179-191`](src/routes/dep-edit.js#L179-L191), [`src/routes/date-cascade.js:218`](src/routes/date-cascade.js#L218), [`src/engine/cascade.js:564`](src/engine/cascade.js#L564), [`src/services/activity-log.js`](src/services/activity-log.js), [`src/utils/reporting.js`](src/utils/reporting.js)
- **Behavior contract:** [`docs/ENGINE-BEHAVIOR-REFERENCE.md`](docs/ENGINE-BEHAVIOR-REFERENCE.md) — needs U5 update to document the human-vs-engine seed distinction at the cascade-engine contract level

---

## Deferred / Open Questions

### From 2026-05-07 review

These are premise-level questions surfaced by document review. They block confident shipping until resolved with a real PicnicHealth PM / Meg, not just by the developer-author of this plan. Implementation can proceed in parallel as long as ship/no-ship is gated on these.

- **Has Meg or any active PM reported the silence on no-shift edits as a workflow problem?** The plan's motivating evidence is a Tem testing session — a developer self-experiencing silence during incident reproduction. PicnicHealth PMs already get a synchronous "Cascade queued for `<task>`..." info comment per `ENGINE-BEHAVIOR-REFERENCE.md` that IS the click-acknowledgment they may have learned to rely on. If no PM has reported the silence as a bug, this plan is solving a hypothetical user model, and a 1-line `ENGINE-BEHAVIOR-REFERENCE.md` note ("when nothing happens, downstream was already tight") may deliver the same value at 0% of the cost. Resolution path: ask Meg directly OR sample 1-2 production PMs on a study tracker. Capture the answer in the Validation section; if "no, hadn't noticed," downgrade this entire plan to a doc-only fix and close U1-U5.
- **Should R2 (Activity Log entry) and R3 (banner) be sequenced rather than parallel?** Today the Activity Log is a "what cascaded?" feed — every entry is a real change. After this plan, it becomes a "what got processed?" feed — entries include "engine ran, nothing happened." For PMs reviewing what cascaded across a study, this dilutes the signal: filtering by `status === 'success'` to find real shifts now requires also excluding `'no_shifts'`. Risk-D treats this as monitoring volume; the underlying concern is workflow degradation for the very surface the engine's audit trail is supposed to support. Resolution path: ship R3 (banner) first as a Phase A — that's the editor-moment fix and doesn't touch Activity Log. Observe whether confusion persists; only ship R2 (Activity Log entry + new `no_shifts` enum) as a Phase B if Phase A alone doesn't close the gap. Side benefit: avoids the `no_shifts` schema commitment until it's earned its place.
