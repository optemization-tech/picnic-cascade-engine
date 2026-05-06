---
title: 'fix: cascade-queue bot-authored gate at webhook entry'
type: fix
status: active
date: 2026-05-06
deepened: 2026-05-06
---

# fix: cascade-queue bot-authored gate at webhook entry

## Overview

The cascade webhook queue suppresses bot-authored echoes only conditionally — when a prior debounce timer already exists for the same task. For tasks the user hasn't recently touched (e.g., the 200+ tasks PATCHed during inception, or downstream tasks moved by a real cascade), the gate doesn't fire and the bot-authored webhook proceeds to debounce + enqueue. Defense-in-depth gates inside `processDateCascade` (zero-delta and import-mode) catch the no-op later, but only after the work has already consumed a 5s debounce window and a per-study queue slot. Result: a single inception or large cascade can pile 100–200 doomed-to-skip cascades into the per-study FIFO, behind which the user's real edits stall.

This plan moves the bot-authored gate to the front door — `cascadeQueue.enqueue()` itself — so all three async routes (`date-cascade`, `dep-edit`, `undo-cascade`) reject bot-authored webhooks before they reserve any resources. It also closes two adjacent gaps: `processDateCascade` lacks the symmetric in-handler gate that `processDepEdit` has, and `parseUndoPayload` does not currently surface `editedByBot` to the queue.

### Terminology

- **Bot-authored webhook** — the webhook payload's `data.last_edited_by.type === 'bot'`. The plan uses "bot-authored" consistently to mean "Notion received the edit from a bot user (any integration)", which is broader than "engine echo" (the engine's own writes echoing back). The fix gate is broad: it suppresses *all* bot-authored cascade webhooks regardless of which integration made the edit, because the engine has no live use case for a bot-authored cascade trigger today. See "External bot integration" risk row for the carve-out reasoning.
- **Engine echo** — a subset of bot-authored webhooks where the bot user is the engine itself. The original line 45-49 inner-branch check was framed around engine echoes (debounce-replacement defense); this plan generalizes to all bot-authored payloads.

### Sequencing relative to the Notion-side filter

A complementary operator-side change exists: editing the "When Dates changes", "When Blocked by changes", and "When Subtask(s) changes" automations on the Study Tasks DB to add a `LMBS != Optemization Bot` filter eliminates the webhook fire entirely (saves the ~180ms HTTP roundtrip per echo). That change is cheaper and has smaller blast radius. **It should ship in parallel or first.** This engine PR remains worthwhile because it is defense-in-depth against (a) future Notion automation drift or misconfiguration, (b) operator turnover where the filter setting is forgotten, and (c) other bot integrations that bypass the filtered automations. Concretely: the Notion change addresses ~95% of the volume in normal operation; the engine change keeps queue depth bounded even if the Notion filter regresses.

---

## Problem Frame

Observed today (2026-05-06) on a test study (`3582386760c2806c8376fce014d280f8`) immediately after inception:

| Metric | Value |
|---|---|
| HTTP webhook hits in the affected window | 325 (311 date-cascade + 14 dep-edit) |
| Cascades that ran | 455 |
| `zero_delta_skip` events | 293 (94% of cascades) |
| `dep_edit_noop` events | 155 |
| `import_mode_skip` events | 0 |
| Peak per-study queue depth | 187 |
| Wall-clock cascade activity | ~12 minutes |

Two real user task moves were stuck behind ~180 self-triggered no-op cascades. Per-cascade engine compute was within target (≤19s for the largest 160-update cascade), so the felt slowness was queue accumulation, not engine slowness.

Root cause is in `src/services/cascade-queue.js`. The bot-echo skip at lines 45–49 lives **inside** the `if (existing)` branch:

```javascript
const existing = this._debounce.get(taskId);
if (existing) {
  if (parsed.editedByBot) {
    // Bot-edited webhook = cascade echo. Don't replace the user's original edit.
    console.log(JSON.stringify({ event: 'debounce_echo_ignored', taskId, taskName, studyId }));
    return;
  }
  clearTimeout(existing.timer);
  ...
}
```

The original design assumption — bot echoes always arrive after a corresponding user edit on the same task — does not hold for inception's mass writes (every task PATCHed by the engine, no preceding user edit on those task IDs). The check is reached but only when a user already debounced the same task; for fresh task IDs, the bot echo bypasses it and reaches `setTimeout(... , debounceMs)` at line 57.

The downstream gates in `src/routes/date-cascade.js` (`zero_delta_skip` line 199, `import_mode_skip` line 204) and `src/routes/dep-edit.js` (`dep_edit_bot_skip` line 129) work correctly — but they fire *after* debounce + dequeue, so they don't prevent the queue from growing.

---

## Requirements Trace

- R1. Bot-authored cascade webhooks must be dropped at the entry to `cascadeQueue.enqueue()`, before any debounce timer is set or queue slot reserved.
- R2. User-authored webhooks must continue to flow through debounce + per-study FIFO unchanged. Existing test scenarios in `test/services/cascade-queue.test.js` must remain green **except for the two tests explicitly rewritten by this plan** (`drops consecutive bot echoes — only first enters buffer` becomes "all consecutive bot echoes dropped at door"; `user webhook replaces a bot webhook in the debounce buffer` becomes "user webhook proceeds normally after a bot is dropped at the door"). U1 specifies the rewrites.
- R3. Each dropped bot-authored payload must emit a structured log event (`cascade_bot_echo_dropped` proposed) carrying `taskId`, `taskName`, `studyId`, `route` so volume can be observed per route and false positives surfaced.
- R4. The fix must benefit all three callers of `cascadeQueue.enqueue()` (date-cascade, dep-edit, undo-cascade) at the queue level. **Undo-cascade requires a small per-route change** (extend `parseUndoPayload` to surface `editedByBot` using the route's stricter `!source.user_id && last_edited_by.type === 'bot'` definition); date-cascade and dep-edit benefit at the queue level alone. U1 specifies the parser change.
- R5. Existing in-handler defense-in-depth gates that **currently exist** inside `processDepEdit` (line 129) remain in place as a second-line guard. **`processDateCascade` lacks a symmetric `editedByBot` gate today** — this plan adds one (mirroring `processDepEdit`) so that `zero_delta_skip` + `import_mode_skip` are no longer the only backstops for bot leakage on the date-cascade path. `processUndoCascade` retains its existing inline `editedByBot` check at line 25 as the second-line guard for that route.
- R6. The new gate is load-bearing only when the webhook authentication boundary holds. Production deployment must enforce `WEBHOOK_SECRET` (the middleware at `src/middleware/webhook-auth.js:16` skips auth if the env var is unset). U1 includes a startup assertion to fail-fast if the secret is missing in production environments.

---

## Scope Boundaries

- **Not** changing the Notion-side "When Dates changes" automation filter. A `LMBS != Optemization Bot` filter on the Notion automation is a separate, complementary improvement that should ship in parallel or first (see Documentation/Operational Notes for owner + sequencing).
- **Not** changing the synchronous `status-rollup` route (`src/routes/status-rollup.js`). It does not use `cascadeQueue`, already has its own bot-echo skip at line 56, and its echo-loop pathology is structurally different (no per-study FIFO).
- **Not** removing the existing per-route `editedByBot` checks (`src/routes/dep-edit.js:129`, `src/routes/date-cascade.js`'s preflight `shouldPostQueued` predicate at line 576, the inline check inside `src/routes/undo-cascade.js:25`). They remain as defense-in-depth.
- **Not** changing `processDateCascade`'s `zero_delta_skip` or `import_mode_skip`. Those remain; this plan **adds** a sibling `editedByBot` gate next to them (see U1).
- **Not** removing the existing `try/catch` parse-error path in `cascadeQueue.enqueue()` that calls `processFn(payload)` directly on parse failure — only extending it to suppress bot-authored payloads via an inline payload check before the direct call.
- **Not** redesigning the three-layer defense-in-depth posture. After this plan: layer 1 = Notion-side filter (deferred), layer 2 = queue-front-door gate (this plan, U1), layer 3 = in-handler `editedByBot` gates. The plan's position is that all three layers are **permanent**, not transitional; the cost of carrying them is small (one branch each), and they protect against independent failure modes (Notion drift, queue-gate bug, novel bot integration). Future async webhook handlers should mirror this posture.

### Deferred to Follow-Up Work

- **Notion-side automation filter** on "When Dates changes" / "When Blocked by changes" / "When Subtask(s) changes" to add `LMBS != Optemization Bot` predicate. Eliminates the webhook fire entirely, removing even the ~180ms HTTP roundtrip the engine pays per echo. Operator change in Notion UI; no engine PR. **Owner:** Tem (Notion admin). **Sequencing:** can ship before, in parallel with, or after this engine PR — independent. **Tracking:** captured in this plan's Documentation/Operational Notes; if this stretches beyond the next inception, file as a follow-up backlog entry in the engagement repo.
- **Per-bot-user-id allowlist refinement.** If `cascade_bot_echo_dropped` log events later surface a legitimate non-engine bot integration whose cascades are being silenced, refine the gate to filter on specific bot user IDs (the engine's own provision-pool tokens) instead of `editedByBot`. Trigger: any `cascade_bot_echo_dropped` event for a `bot_user_id` not in the engine's known integration set, observed for >1 day.

---

## Context & Research

### Relevant Code and Patterns

- `src/services/cascade-queue.js:18-64` — `enqueue()` method, where the front-door check belongs.
- `src/services/cascade-queue.js:45-49` — existing conditional bot-echo skip (becomes unreachable after the fix).
- `src/gates/guards.js:97` — `editedByBot` extraction from webhook payload (`data?.last_edited_by?.type === 'bot'`).
- `src/routes/date-cascade.js:540-595` — `handleDateCascade` route handler. Returns 200 immediately, runs preflight parse, calls `cascadeQueue.enqueue`. The preflight already has `!parsed.editedByBot` in `shouldPostQueued` (line 576) so suppressing bot-edits at the queue front door does not cause stuck "Cascade queued" banners.
- `src/routes/dep-edit.js:129` and `src/routes/dep-edit.js:284` — same shape: `processDepEdit` has its own bot-echo skip but it fires after `cascadeQueue.enqueue` has already debounced + serialized.
- `src/routes/status-rollup.js:56` — example of the gate at the right level (synchronous, route-level, before any work). Pattern to mirror conceptually.
- `src/routes/undo-cascade.js:25, 164-167, 171` — uses a stricter `editedByBot` definition (`!payload?.source?.user_id && data.last_edited_by.type === 'bot'`) inline at line 25. **`parseUndoPayload` at lines 164-167 does not currently surface `editedByBot`** — U1 extends it so the queue gate sees undo-cascade's bot status. Without this parser change, R4 would not hold for undo.
- `test/services/cascade-queue.test.js` — existing fake-timer harness with `makeParseFn` factory; `editedByBot` already wired into the mock at line 18.

### Institutional Learnings

- `docs/solutions/silent-partial-failure-in-async-batches.md` — adjacent learning on copy-blocks. Same shape of issue: gates running after expensive work has already been queued. The fix shape (gate at front door, defense-in-depth at back) generalizes.
- `engagement/workflow-manifest.json` (in the picnic-health engagement repo) cycle_guard documentation: "LMBS (Last Modified By System) anti-loop gate + Import Mode rollup check". The original n8n design intent is preserved by this fix — currently the implementation only realizes half of it.

### External References

None needed — well-patterned change, clear local conventions to mirror.

---

## Key Technical Decisions

- **Connect Problem Frame → fix shape.** The Problem Frame's root cause is "the original gate only fires when a prior debounce timer exists for the task". The fix shape ("gate on `parsed.editedByBot` at queue entry") solves it because the bot-author signal is intrinsic to *the bot write itself* and does not depend on prior user activity on the same task ID. This is why `editedByBot` is the correct signal and why `Import Mode` (which depends on Notion rollup propagation) is not the primary gate.
- **Gate on `parsed.editedByBot`, not `parsed.importMode`.** `editedByBot` is a direct property of the webhook payload and is already extracted in `parseWebhookPayload`. Import Mode is a rollup that may not always be present in time on the source task (eventual consistency in Notion). The bot-author signal is sufficient for the dominant case (engine-driven echoes) and simpler.
- **Place the gate after parse, before the existing `parsed.skip` check.** Order: parse → drop-if-bot → existing skip handling → debounce timer logic. This means a bot-authored webhook with `parsed.skip=true` is dropped by the bot-skip rather than `debounce_bypass`. **Decision (was previously deferred):** bot-skip takes precedence over parse-skip because (a) it's strictly cheaper — bot drops never call `processFn`, while `debounce_bypass` does call `processFn(payload)` directly — and (b) it produces more informative logs (`cascade_bot_echo_dropped` is a stronger signal than a generic `debounce_bypass`).
- **Extend the `try/catch` parse-error path with an inline payload check.** Currently `cascade-queue.js:22-28` catches parse errors and calls `processFn(payload)` directly. To prevent a malformed bot-authored payload from reaching `processFn`, add an inline check on `payload?.data?.last_edited_by?.type === 'bot'` inside the catch block before the `processFn` call. Cheap; closes the bypass.
- **Add an `editedByBot` short-circuit at the top of `processDateCascade`** (mirroring `processDepEdit:129`). This is the in-handler defense-in-depth gate that the existing plan claimed but the code did not have. Without it, a bot-authored payload with non-zero delta and Import Mode=false (very plausible — Import Mode is OFF by the time backlogged Notion webhooks flush) currently bypasses both `zero_delta_skip` and `import_mode_skip` and runs a real cascade. Adding this closes the back-door.
- **Extend `parseUndoPayload` to surface `editedByBot`.** The current parser at `src/routes/undo-cascade.js:164-167` returns only `{ skip, taskId, studyId }`, so the queue-front-door gate cannot see undo's bot status. Use the route's existing stricter definition (`!source.user_id && data.last_edited_by.type === 'bot'`) so legitimate button-driven undos (which carry `source.user_id`) still flow through.
- **Remove the now-dead `if (parsed.editedByBot)` inside `if (existing)`.** Once the front-door gate runs, the inner branch is unreachable. Leaving dead code there invites a future maintainer to mistakenly think the inner branch is the real gate.
- **Emit a new `cascade_bot_echo_dropped` log event** with `taskId`, `taskName`, `studyId`, `route` (so volume can be tracked per route). Distinct from the existing `debounce_echo_ignored` event (which counted only the inner-branch case). The existing `debounce_echo_ignored` event is removed alongside the dead inner branch.
- **Add a startup assertion that `WEBHOOK_SECRET` is set in production.** The new gate becomes load-bearing for cascade integrity: an unauthenticated attacker who reaches `/webhook/date-cascade` could craft `last_edited_by.type='bot'` to suppress real cascades. Today's deployment leaves `WEBHOOK_SECRET` optional ([src/middleware/webhook-auth.js:16](src/middleware/webhook-auth.js); [.env.example:25-26](.env.example)). Production environments (`NODE_ENV=production` or Railway-detected) must fail-fast at boot if the secret is missing. Non-production environments retain today's permissive behavior so tests and local dev are not broken.

---

## Open Questions

### Resolved During Planning

- *Should the gate also drop `Import Mode = true` payloads at the queue door?* No — `editedByBot` is the simpler, sufficient signal for the dominant case (cascade self-storm during inception or large cascades). Import Mode handling stays in `processDateCascade` where the rollup is reliably read.
- *Does removing the inner `if (existing) if (parsed.editedByBot)` branch regress the "user edits, then bot echoes the same task" case?* No — that case is now handled at the front door (bot echo dropped before reaching the inner branch). The user's debounce timer is preserved because the bot path returns before any timer manipulation.
- *Order of parse-skip vs bot-skip when both fire on the same payload?* Bot-skip first. Cheaper (no `processFn` invocation) and emits more informative logs.
- *Why not refactor undo-cascade entirely to use `parseWebhookPayload` (the standard parser) so it gets `editedByBot` for free?* Out of scope — `parseUndoPayload` carries different defaults (e.g., `taskId: '__undo__'`) and a stricter `editedByBot` definition that matters for undo button semantics. Surgically adding `editedByBot` is safer than reshaping the parser.
- *Operator pain frequency: is the 12-min wall-clock observed on the Test study representative of real workflows?* Single-incident sample. The fix is justified primarily as defense against future inceptions and large cascades on real client studies — the same code path runs there. Real-client telemetry was not available at planning time; if post-deploy `cascade_bot_echo_dropped` volume on real studies is <10/day, U2 and U3 are arguably over-investment and can be revisited in a future trim pass.

### Deferred to Implementation

- Final log event name (`cascade_bot_echo_dropped` proposed; if conflict with existing convention surfaces during code review, choose the closest analog).
- Whether to log the bot user's `id` in addition to `taskId/taskName/studyId`. Useful for the per-bot-user-id allowlist refinement (deferred follow-up); cheap to add. Recommend yes, but not load-bearing for U1.

---

## Implementation Units

- U1. **Bot-authored gate at queue entry + symmetric in-handler gate + parser fix + production secret assertion**

**Goal:** Drop bot-authored webhooks at the queue front door, before any debounce timer or queue slot is allocated. Add the symmetric in-handler gate to `processDateCascade` so defense-in-depth is real (not just claimed). Extend `parseUndoPayload` so the queue gate sees undo-cascade's bot status. Close the parse-error bypass. Fail-fast at boot if `WEBHOOK_SECRET` is missing in production.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** None.

**Files:**
- Modify: `src/services/cascade-queue.js` (front-door gate + parse-error inline check + remove dead inner branch)
- Modify: `src/routes/date-cascade.js` (add in-handler `editedByBot` gate at top of `processDateCascade`)
- Modify: `src/routes/undo-cascade.js` (extend `parseUndoPayload` to compute and surface `editedByBot`)
- Modify: `src/server.js` or `src/startup/*.js` (production startup assertion for `WEBHOOK_SECRET` — exact path determined during implementation by reading existing startup wiring)
- Modify: `test/services/cascade-queue.test.js` (rewrite two existing tests; add new bot-drop coverage)
- Modify: `test/routes/date-cascade.test.js` (add in-handler gate test)
- Create or modify: `test/routes/undo-cascade.test.js` (parser-shape tests; create if file does not exist)

**Approach:**

1. **`cascade-queue.js` — front-door gate (the load-bearing change):** At the top of `enqueue()`, after the `try { parsed = parseFn(payload) }` block succeeds, before the `parsed.skip || !taskId || !studyId` short-circuit: if `parsed.editedByBot === true`, log `{ event: 'cascade_bot_echo_dropped', taskId, taskName, studyId }` and return.
2. **`cascade-queue.js` — close parse-error bypass:** Inside the existing `try { ... } catch { ... }` block at lines 19-28, before the `void processFn(payload).catch(...)` call in the catch, add an inline check: if `payload?.data?.last_edited_by?.type === 'bot'`, log `{ event: 'cascade_bot_echo_dropped', reason: 'parse_error_bot_payload' }` and return without calling `processFn`. This closes the back-door surfaced by adversarial review.
3. **`cascade-queue.js` — remove dead code:** Remove the inner `if (parsed.editedByBot) { ... debounce_echo_ignored ... return; }` block at lines 45-49 (now unreachable). Remove the corresponding `debounce_echo_ignored` log emission entirely (no callers will produce it post-fix).
4. **`date-cascade.js` — symmetric in-handler gate:** At the top of `processDateCascade()` (after `if (parsed.skip) return;` at line 191, before the `tracer = new CascadeTracer(...)` line and the `if (parsed.startDelta === 0 && parsed.endDelta === 0)` check at line 198), add `if (parsed.editedByBot) { console.log(JSON.stringify({ event: 'date_cascade_bot_skip', taskId: parsed.taskId, taskName: parsed.taskName, studyId: parsed.studyId })); return; }`. Mirrors `processDepEdit:129-137`.
5. **`undo-cascade.js` — parser fix:** Extend `parseUndoPayload` (currently at lines 164-167) to compute `editedByBot` using the route's existing stricter definition: `editedByBot: !payload?.source?.user_id && payload?.data?.last_edited_by?.type === 'bot'`. Return it on the parsed object. The existing inline calculation at line 25 (inside `processUndoCascade`) becomes redundant for queue-fed paths but is kept as defense-in-depth (consistent with the three-layer posture).
6. **Startup assertion for `WEBHOOK_SECRET`:** In the engine's startup path, if `process.env.NODE_ENV === 'production'` and `process.env.WEBHOOK_SECRET` is unset, throw at boot with a clear message ("WEBHOOK_SECRET must be set in production — bot-author gate is load-bearing for cascade integrity"). Local dev / test environments retain today's permissive behavior. Verify the existing middleware skip-if-unset behavior at `src/middleware/webhook-auth.js:16` is preserved for those environments so test suites are unaffected.

**Patterns to follow:**
- `src/services/cascade-queue.js:33-40` (existing `debounce_bypass` pattern — same log-and-return shape).
- `src/routes/dep-edit.js:129-137` (existing `dep_edit_bot_skip` log shape; mirror the `taskId`/`taskName`/`studyId` field set for the new `date_cascade_bot_skip`).
- `src/middleware/webhook-auth.js` (where the optional-secret behavior currently lives — startup assertion belongs at boot, not in the middleware).

**Test scenarios:**

*Queue-level (`test/services/cascade-queue.test.js`):*
- Happy path: bot-authored webhook (`parseFn` returns `editedByBot: true`) → `processFn` is never called even after `vi.advanceTimersByTimeAsync(5000)`; queue stats show `debounceSize: 0, studyLockCount: 0`; `cascade_bot_echo_dropped` log emitted.
- Happy path: user-authored webhook (`editedByBot: false`) reaches `processFn` after debounce — existing test at lines 36-48 unchanged.
- Edge case: bot-authored webhook with `parsed.skip=true` → bot-skip fires first (`cascade_bot_echo_dropped`), `processFn` never called. Verifies the resolved precedence decision.
- Edge case: bot-authored payload that causes `parseFn` to throw → catch block's inline payload check fires, `processFn` never called, `cascade_bot_echo_dropped` logged with `reason: 'parse_error_bot_payload'`.
- Edge case: non-bot payload that causes `parseFn` to throw → catch block falls through to existing `debounce_bypass` path, `processFn` invoked (regression guard for the existing parse-error semantics).
- Edge case: user enqueues `task-1` (timer set), bot arrives for same `task-1` → bot dropped at door, user's existing timer is **not** cleared, user's `processFn` fires after the original debounce window.
- Edge case: 100 bot-authored webhooks for 100 distinct task IDs → 0 enqueues, 0 timers set, queue stats remain zero.
- **Test rewrite (R2 carve-out):** `drops consecutive bot echoes — only first enters buffer` at lines 309-323 must be rewritten to `drops consecutive bot echoes — none enter buffer`; assertion changes from "processFn called once with v: 'echo-1'" to "processFn never called; 3 cascade_bot_echo_dropped events logged".
- **Test rewrite (R2 carve-out):** `user webhook replaces a bot webhook in the debounce buffer` at lines 325-339 must be renamed to `user webhook proceeds normally after a bot is dropped at the door`; assertion structure preserved (user fires, bot doesn't), comments updated to reflect that no replacement occurs.

*Route-level (`test/routes/date-cascade.test.js`):*
- Happy path: `processDateCascade` called directly with a parsed payload where `editedByBot=true` → returns immediately, `date_cascade_bot_skip` logged, no Notion API calls. Verifies the in-handler gate even if the queue gate is bypassed (defense-in-depth proof).

*Route-level (`test/routes/undo-cascade.test.js`):*
- Happy path: `parseUndoPayload({ data: { last_edited_by: { type: 'bot' } } })` returns `editedByBot: true`. Verifies the parser change.
- Edge case: button-driven undo (`source.user_id` set) with `data.last_edited_by.type === 'bot'` returns `editedByBot: false`. Preserves the route's stricter button semantics so legitimate undos are not silenced.
- Edge case: user-driven undo (no bot in `last_edited_by`) returns `editedByBot: false`.

*Startup (covered by existing or new boot test if available, otherwise manual):*
- `NODE_ENV=production` + `WEBHOOK_SECRET` unset → process exits at boot with clear error message.
- `NODE_ENV=production` + `WEBHOOK_SECRET` set → boot succeeds.
- `NODE_ENV=development` (or unset) + `WEBHOOK_SECRET` unset → boot succeeds (preserves dev/test ergonomics).

**Verification:**
- `npm test` passes including all rewritten and new tests.
- `npm test test/services/cascade-queue.test.js`, `npm test test/routes/date-cascade.test.js`, `npm test test/routes/undo-cascade.test.js` each pass in isolation.
- Manual: deploy to non-prod Railway environment without `WEBHOOK_SECRET` (`NODE_ENV=development`) → boot succeeds. Set `NODE_ENV=production` without secret → boot fails fast with clear message. Set both → boot succeeds.
- Manual: trigger inception on a fresh study; observe `cascade_bot_echo_dropped` events at the rate of bot writes (~200/inception); `study_queue_enqueued queueDepth=N` log values stay bounded by the count of distinct *user* actions, not bot echoes. Expected reduction: ~60-95% of pre-fix queue volume (60% if Notion-side filter is not also deployed; up to 95% if it is).

---

- U2. **Verify async-route handlers benefit and add a route-level integration test**

**Goal:** Confirm `date-cascade`, `dep-edit`, and `undo-cascade` all benefit from the queue-level gate without per-route code changes; add at least one route-level test exercising the full HTTP → queue → no-call path.

**Requirements:** R4, R5

**Dependencies:** U1.

**Files:**
- Modify: `test/routes/date-cascade.test.js` (add HTTP-level integration test)
- Verify only (read, no edits): `src/routes/date-cascade.js`, `src/routes/dep-edit.js`, `src/routes/undo-cascade.js`

**Approach:**
- Add an HTTP-level integration test in `test/routes/date-cascade.test.js`: POST `/webhook/date-cascade` with a payload whose `data.last_edited_by.type === 'bot'`. Assert: response is 200; `processDateCascade` is never invoked (use a spy or counter); `cascade_bot_echo_dropped` log event observed.
- Read `src/routes/date-cascade.js:567-588` (the `shouldPostQueued` preflight predicate and its `if`-block) and confirm: it already excludes bot-edits via `!parsed.editedByBot` at line 576, so suppressing bot-edits at the queue does not leave a stuck "Cascade queued" banner on the task. No code change needed.
- Read `src/routes/dep-edit.js:282-285` (the route handler) and confirm: `handleDepEdit` does not post any pre-queue status banner; banner-stranding does not apply. The existing `dep_edit_bot_skip` at line 129 becomes redundant for queue-fed bot-edits (they no longer reach `processDepEdit`) but remains valid as defense-in-depth for direct-call paths. Keep it; add a one-line comment noting its now-secondary role per the three-layer posture.
- Read `src/routes/undo-cascade.js:169-172` (the route handler) and confirm: `handleUndoCascade` does not post any pre-queue status banner; banner-stranding does not apply.

**Patterns to follow:**
- Existing route tests in `test/routes/date-cascade.test.js`.

**Test scenarios:**
- Integration: POST `/webhook/date-cascade` with bot-typed `last_edited_by` → 200 OK in <50ms; no `study_cascade_started` event; `cascade_bot_echo_dropped` log emitted.
- Integration: POST `/webhook/date-cascade` with user-typed `last_edited_by` and a non-zero date delta → 200 OK; cascade runs as before (regression guard).

**Verification:**
- `npm test test/routes/date-cascade.test.js` passes.
- Manual webhook test in dev (curl with crafted bot payload) returns 200 and produces `cascade_bot_echo_dropped` in logs without invoking the cascade pipeline.

---

- U3. **Document the gate-position pattern in `docs/solutions/`**

**Goal:** Capture the lesson — defense-in-depth gates that suppress no-op work must run before the resource (debounce timer, queue slot), not inside the eventual compute — so the next async webhook handler doesn't repeat the gap.

**Requirements:** R3 (indirectly — observability via documented pattern), maintainability for future async handlers.

**Dependencies:** U1.

**Files:**
- Create: `docs/solutions/cascade-queue-gate-position.md`

**Approach:**
- Short doc (~80–150 lines) framed as a learning, not a runbook. Sections: Problem, Symptom, Root Cause, Fix Shape, Generalization. Reference the 2026-05-06 Test study incident as the motivating case (Activity Log + Railway log evidence).
- Mirror the format of `docs/solutions/silent-partial-failure-in-async-batches.md`.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Reviewer reads the doc and confirms the lesson is generalizable (not just a recap of this specific bug).

---

## System-Wide Impact

- **Interaction graph:** `cascadeQueue.enqueue()` is called from `src/routes/date-cascade.js:594`, `src/routes/dep-edit.js:284`, and `src/routes/undo-cascade.js:171`. The first two benefit at the queue level alone; undo-cascade requires the small `parseUndoPayload` change in U1 to surface `editedByBot` to the queue.
- **Error propagation:** No change. Webhook handlers continue to return 200 immediately. Bot-author drops are silent to Notion (no error response) and observable only via engine logs (`cascade_bot_echo_dropped`, `date_cascade_bot_skip`).
- **State lifecycle risks:** Dropped bot-authored webhooks correspond either to engine echoes (no-ops by design) or to external bot integrations (which the plan accepts will be silenced — see Risks). No legitimate state changes are dropped.
- **API surface parity:** No public API change. Webhook contracts unchanged. Notion automation configs unchanged. The startup assertion is a deployment precondition, not an API change.
- **Integration coverage:** U2's HTTP-level integration test covers the full HTTP → queue → no-call path for date-cascade. The new in-handler `editedByBot` gate test (U1) covers the back-door defense-in-depth path. Existing `processDateCascade` and `processDepEdit` tests remain green.
- **Unchanged invariants:**
  - User-authored webhooks continue to flow through debounce + per-study FIFO with identical semantics.
  - `processDateCascade`'s `zero_delta_skip` and `import_mode_skip` remain unchanged; the new `date_cascade_bot_skip` runs *before* them.
  - `processDepEdit`'s `dep_edit_bot_skip` at line 129 remains in place (defense-in-depth).
  - `processUndoCascade`'s inline `editedByBot` calculation at line 25 remains in place (defense-in-depth).
  - Synchronous `status-rollup` is untouched (different code path; already gates correctly).
  - The 5s debounce window for user edits is unchanged.
  - Local dev / test environments without `WEBHOOK_SECRET` continue to boot and run as today.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| **Webhook spoofing suppresses real cascades.** The `editedByBot` field is attacker-controlled payload data. Today, `WEBHOOK_SECRET` is optional ([src/middleware/webhook-auth.js:16](src/middleware/webhook-auth.js); [.env.example:25-26](.env.example) leaves it commented out). If the secret is unset in production, an unauthenticated attacker who reaches `/webhook/date-cascade` could craft `last_edited_by.type='bot'` to silence real user cascades. After this fix, the silencing is immediate (no downstream gates run). | U1 adds a startup assertion: production environments must have `WEBHOOK_SECRET` set, or boot fails. Operator deploys must update Notion automation `X-Webhook-Secret` header to match. Risk reduces to "compromised Notion → spoofed echoes" which is outside the engine's threat model. |
| **External (non-engine) bot integration legitimately needs to trigger a cascade.** This is a pre-existing gap on `dep-edit` and `status-rollup` (which already gate on `editedByBot`); this fix extends the same policy to date-cascade and to all routes via the queue gate. A future Zapier or n8n workflow that PATCHes dates as a bot would be silenced. | New `cascade_bot_echo_dropped` log event surfaces the volume per `route` and `taskId`. If a real bot-driven use case emerges (e.g., from `cascade_bot_echo_dropped` log entries with bot user IDs not in the engine's known integration set, observed for >1 day), refine the gate to filter on specific bot user IDs (deferred follow-up in Scope Boundaries). |
| **Removing the inner `if (existing) if (parsed.editedByBot)` branch creates a regression in the "user edits, then bot echoes for same task" path.** | Test scenario in U1 explicitly covers this: user enqueues, then bot arrives for same task → bot dropped at door, user's timer preserved, user's cascade fires. |
| **Notion mislabels `last_edited_by.type`** (rare, but documented in their changelog history). | If a real user edit was misclassified as bot, it would be dropped silently — but the user's UI would show no change, which they would report. The new in-handler `date_cascade_bot_skip` (U1) does not catch this case (it's the same field), but the `cascade_bot_echo_dropped` log volume becomes the early warning: a sudden spike on a study where no engine activity is running indicates Notion mislabeling. Acceptable given the rarity. |
| **`taskName` in logs at ~200x volume during inception** — `taskName` may include study task names that carry health-context information in PicnicHealth's domain. | Existing log events (`debounce_new`, `study_cascade_started`) already log the same fields, so this is not a net new exposure. Railway log retention and access policy is acceptable for engine operational data. If `taskName` is later judged sensitive, drop it from the log shape (consistent with existing `dep_edit_bot_skip` would also need to drop it). |
| **Three-layer maintenance cost.** After this fix: Notion-side filter (deferred, optional), queue-front-door gate (this PR, mandatory), per-route in-handler gate (existing + new for date-cascade). Each layer carries its own log event and test surface. | Decision in Scope Boundaries: this is the **permanent** posture, not transitional. The cost is small (one branch per layer); the protection covers independent failure modes. Future async webhook handlers should mirror this. |
| **The new log event volume is high during inception (200+ events per inception).** | Railway log rate limit is 500/sec; current peak during cascades is ~50/sec. The new event replaces existing `debounce_new` events in roughly equal volume, so net log rate is unchanged. |

---

## Documentation / Operational Notes

### Sequencing relative to the Notion-side filter

The Notion-side automation filter is independent of this engine PR and can ship before, in parallel, or after. Either ordering is safe:
- **Notion first:** Eliminates ~95% of bot-echo webhook volume immediately. Engine PR then becomes pure defense-in-depth.
- **Engine first (this PR):** Bot-author drops happen at the engine's queue door. ~60% volume reduction (the inner-branch already caught some; this catches the rest). Notion change adds the remaining benefit (eliminating HTTP roundtrip).
- **Parallel:** Both deploys land independently; combined effect is roughly multiplicative.

**Owner of the Notion change:** Tem (Notion admin for the PicnicHealth workspace). **Tracking:** captured in this plan's Scope Boundaries → "Deferred to Follow-Up Work"; if the Notion change has not landed within ~2 weeks of this PR merging, file a follow-up entry in `engagement/BACKLOG.md` (in the picnic-health engagement repo).

### Deployment preconditions (R6)

Before merging this PR to production:
1. Confirm `WEBHOOK_SECRET` is set in the production Railway environment.
2. Confirm all Notion automations targeting the engine endpoints carry the matching `X-Webhook-Secret` header. (Per `engagement/STATUS.md` 2026-04-12, this was verified end-to-end at the time of `WEBHOOK_SECRET` rollout; re-verify before deploy.)
3. The startup assertion in U1 will fail-fast if (1) is missing — preventing a silent unauthenticated deploy.

### Post-deploy verification

Observe a fresh inception run on a Migration Playground or Test study. Confirm:
- `study_queue_enqueued queueDepth=N` log values stay bounded by the count of distinct *user* actions (not by inception's bot writes). Pre-fix peak was 187; post-fix expected ≤ 5–10 for typical user testing during inception.
- `cascade_bot_echo_dropped` events appear at the rate of bot writes (~200/inception during inception's task-wiring phase).
- `date_cascade_bot_skip` events appear in dev/test if any payload bypasses the queue gate (should be 0 in normal operation; non-zero indicates a code path we missed).
- Activity Log entries for the study show only the user's real cascade events; no `zero_delta` `Date Cascade` rows at minute boundaries.

### Operator pain framing

This plan was triggered by a single-incident observation on a Test study (2026-05-06). Real-client telemetry was not available at planning time. The fix is justified as defense for future inceptions and large cascades on real client studies (same code path); if post-deploy `cascade_bot_echo_dropped` volume on real (non-Test) studies is consistently <10/day, U2 and U3 may be revisited as over-investment in a future trim pass.

---

## Sources & References

- Engine code:
  - `src/services/cascade-queue.js:18-64` (where the front-door gate is added; lines 22-28 parse-error catch block extended; lines 45-49 inner-branch removed)
  - `src/routes/date-cascade.js:188-206` (where the new in-handler `editedByBot` gate is added — top of `processDateCascade`)
  - `src/routes/date-cascade.js:540-595` (route handler; preflight `shouldPostQueued` at line 576 already excludes bot-edits)
  - `src/routes/dep-edit.js:112-137, 282-285` (route handler + existing `dep_edit_bot_skip` defense-in-depth, kept)
  - `src/routes/status-rollup.js:56` (synchronous route; correct gate-position pattern, untouched)
  - `src/routes/undo-cascade.js:25, 164-167, 169-172` (inline `editedByBot` calculation kept; `parseUndoPayload` extended; route handler unchanged)
  - `src/gates/guards.js:97` (`editedByBot` extraction from `data.last_edited_by.type`)
  - `src/middleware/webhook-auth.js:16` (skip-if-unset behavior; preserved for non-prod)
  - `src/server.js` or `src/startup/*.js` (location of new production startup assertion — TBD during implementation)
  - `.env.example:25-26` (current `WEBHOOK_SECRET` documentation; consider updating to indicate it is now required in production)
- Tests:
  - `test/services/cascade-queue.test.js` (extend; rewrite tests at lines 309-323 and 325-339)
  - `test/routes/date-cascade.test.js` (extend; new HTTP integration test + new in-handler gate test)
  - `test/routes/undo-cascade.test.js` (create or extend; parser-shape tests)
- Observability evidence (Test study, 2026-05-06):
  - 311 date-cascade webhooks + 14 dep-edit webhooks in 1 hour
  - 293 `zero_delta_skip` events (94% of cascades)
  - 0 `import_mode_skip` events (the gate that should have fired was never reached because Import Mode flipped off before queue dequeue)
  - Peak queue depth 187 on a single study
  - Wall-clock cascade activity: ~12 minutes
  - Activity Log: 7 entries on study `35823867-60c2-806c-8376-fce014d280f8`; longest engine compute 18.7s for a 160-update drag-right cascade
- Adjacent learning: `docs/solutions/silent-partial-failure-in-async-batches.md` (same shape: gates running after expensive work has already been queued).
