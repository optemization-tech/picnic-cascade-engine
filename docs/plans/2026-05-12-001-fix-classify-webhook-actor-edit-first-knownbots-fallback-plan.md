---
title: "fix: classifyWebhookActor edit-first mode consults KNOWN_BOT_IDS + replay dropped cascades"
type: fix
status: active
date: 2026-05-12
deepened: 2026-05-12
---

# fix: classifyWebhookActor edit-first mode consults KNOWN_BOT_IDS + replay dropped cascades

## Overview

Restore property-change cascades (date-cascade, dep-edit, status-rollup) that have been silently dropping in production since PR #104 deployed (~2026-05-08). Root cause: Notion's automation builder does not expose `last_edited_by.type` as a field that can be added to the HTTP body — operators can only include the user object. Post-PR #104, `classifyWebhookActor` in `edit-first` mode treats missing `type` as conservatively `'unknown'` → `editedByBot=true` → the cascade-queue front-door gate (PR #101) drops the webhook silently.

The fix: in `edit-first` mode, mirror `button-first`'s fallback chain — when `type` is missing, consult `KNOWN_BOT_IDS` (populated at boot by PR #108 `registerBotIds`); default to `'person'` when the userId isn't in the allowlist. This restores legitimate user cascades while preserving the bot-echo gate via positive identification rather than negative inference.

After the fix lands, run a one-off backfill that identifies study tasks whose `Reference` dates no longer match `Dates` (a signature of a dropped cascade) and re-fires the cascade once per affected study so downstream tasks finally propagate.

---

## Problem Frame

Tem ran inception on the "Testing Edits Post Inception" study at 18:00 UTC 2026-05-12. Inception completed cleanly (53s, 202 tasks created). Tem then moved `Draft v1 SAP`'s end date and waited — nothing propagated. Railway logs showed:

- 18:03:10 and 18:04:52 — Two `POST /webhook/date-cascade` arrived for the moved task. **Both dropped** with `event="cascade_bot_echo_dropped"`.
- 19:09 — Tem's next move on the same task: **no webhook fired** at the engine (Notion may have auto-disabled the automation after seeing a flood of no-effect webhooks during inception).
- 19:36–20:05 — After Tem added "Last edited by" to the automation body, 13+ webhooks fired across multiple studies. **Every single one dropped** as `cascade_bot_echo_dropped`.

Diagnosis path: `cascade_bot_echo_dropped` fires at [`src/services/cascade-queue.js:70`](../../src/services/cascade-queue.js) when `parsed.editedByBot === true`. `parseWebhookPayload` calls `classifyWebhookActor(payload, { sourcePriority: 'edit-first' })`. In `edit-first` mode, the classifier reads `lastEditedBy.type`; if absent, `rawType = null` → `userType = 'unknown'` → `editedByBot = true`. The conservative-unknown stance was introduced by PR #104 ([test `guards.test.js:115` codifies it](../../test/gates/guards.test.js)).

Notion's automation builder doesn't expose `last_edited_by.type` as a body field — only the user reference itself. So even when operators add `last_edited_by` to the body, `type` doesn't ride along. Production-wide consequence: every property-change cascade has been silently dropping since PR #104 deployed on 2026-05-08.

---

## Requirements Trace

- **R1.** Property-change webhooks (date-cascade, dep-edit, status-rollup) classify legitimate user edits as `editedByBot=false` so the cascade-queue front-door gate doesn't drop them.
- **R2.** Engine echoes (inception, cascade patches, add-task-set writes, deletion bot writes) still classify as `editedByBot=true` so the gate continues to drop them — loop prevention preserved.
- **R3.** When `last_edited_by` is structurally present but `type` is absent, the classifier falls back to `KNOWN_BOT_IDS` lookup (mirroring button-first); defaults to `'person'` when the userId isn't in the allowlist.
- **R4.** When `last_edited_by` is entirely absent (rare — legacy callers or grossly misconfigured automations), the classifier produces a usable classification rather than dropping silently, and emits a telemetry event so misconfiguration surfaces loudly.
- **R5.** Classifier path resolution matches `parseWebhookPayload`'s fallback chain (`body.data.X` OR `body.X`) so misconfigured automation bodies don't bypass classification by accident.
- **R6.** Production tasks whose cascades were dropped during the 2026-05-08 → 2026-05-12 window have their cascades replayed once after the fix lands, so downstream date propagation catches up.
- **R7.** Cold-boot window safety: while `KNOWN_BOT_IDS` is empty (between `app.listen` resolving and `registerBotIds` completing — typically 1-10s after each Railway redeploy), the classifier must fall back to the pre-PR-#104 conservative behavior (`editedByBot = true` on missing type) so engine echoes are still dropped during the registration race. Once `KNOWN_BOT_IDS.size > 0`, default to `'person'` per R3.
- **R8.** Third-party bot writers (Notion AI, Zapier, future workspace integrations not in `KNOWN_BOT_IDS`) will now be classified as `'person'` and trigger cascades. The plan must explicitly acknowledge this posture shift and provide ops-visible telemetry that logs every non-engine-bot `user_id` seen on a webhook so unexpected actors surface in monitoring.

---

## Scope Boundaries

- Not changing the cascade-queue front-door gate logic itself ([`cascade-queue.js:70`](../../src/services/cascade-queue.js) still drops on `editedByBot === true`). The classifier's output is the change surface.
- Not adding new actor sources. Still uses `source.user_id` + `last_edited_by`.
- Not modifying `registerBotIds` boot wiring (PR #108). U5 only verifies it's healthy in production.
- Not changing any Notion-side automations or their HTTP body shapes.
- Not changing the security boundary established by PR #101 — the gate still rejects bot-authored payloads, just via positive ID match instead of negative type inference.

### Deferred to Follow-Up Work

- Documentation runbook: "Notion automation HTTP body requirements" (which fields must be included, where in the body). Separate doc PR.
- Engine-side admin endpoint `/admin/replay-cascade` for ad-hoc cascade replay. U6 uses a one-off script instead.
- Adding a structured `bot_ids_registered` health check endpoint or alert. Out of scope.

---

## Context & Research

### Relevant Code and Patterns

- [`src/notion/actor-classifier.js`](../../src/notion/actor-classifier.js) — primary file to modify. The `button-first` branch (lines 51-59) already implements the fallback pattern we need to mirror in `edit-first`.
- [`src/services/cascade-queue.js:70`](../../src/services/cascade-queue.js) — consumer of `parsed.editedByBot`. The front-door gate.
- [`src/gates/guards.js:97`](../../src/gates/guards.js) — `parseWebhookPayload` calls the classifier with `sourcePriority: 'edit-first'`. Lines 21-22 do path-tolerant unwrapping (`body = payload?.body || payload; data = body?.data || body`) — the classifier should match this.
- [`src/startup/register-bot-ids.js`](../../src/startup/register-bot-ids.js) — populates `KNOWN_BOT_IDS` at boot via `GET /v1/users/me` for each integration token. Wired in `src/index.js:30-35`.
- [`test/notion/actor-classifier.test.js`](../../test/notion/actor-classifier.test.js), [`test/gates/guards.test.js`](../../test/gates/guards.test.js) — test files that encode current classifier behavior. Lines 106 and 115 of guards.test.js encode the conservative-unknown stance that this plan changes.

### Institutional Learnings

- [`docs/solutions/cascade-queue-gate-position.md`](../solutions/cascade-queue-gate-position.md) (2026-05-06) — the principle behind PR #101: suppression gates belong at the resource boundary (cheap, before debounce/queue), not inside the eventual compute. **This plan preserves that principle** — the gate stays at the front door, only its classification input changes.
- [`docs/solutions/silent-partial-failure-in-async-batches.md`](../solutions/silent-partial-failure-in-async-batches.md) — adjacent pattern: silent drops kill cascades the same way silent partial failures kill batches. U4 (telemetry) borrows the "emit on signal" pattern from this learning.
- Pulse log [`pulse-log/05.07/002-actor-classifier-refactor-shipped.md`](../../../picnic-health/pulse-log/05.07/002-actor-classifier-refactor-shipped.md) (in the picnic-health repo) — PR #104's residual work item R1 (`KNOWN_BOT_IDS` boot wiring) was filed as issue #105 and shipped in PR #108 (`029a6ec`). **The allowlist exists but is only consulted in button-first mode.** This plan closes that gap.

### External References

- Notion automation builder UX — does not expose `last_edited_by.type` as a selectable body field; only the user reference. Verified by Tem in this debugging session (2026-05-12).
- 2026-05-12 Railway logs showing 13+ `cascade_bot_echo_dropped` events across multiple studies post-Tem's automation update, confirming Notion sends `last_edited_by` without a `type` field even when operators include the property.

---

## Key Technical Decisions

- **Edit-first mode consults `KNOWN_BOT_IDS` on missing type, with cold-boot guard.** Mirrors button-first's fallback chain. When `KNOWN_BOT_IDS.size > 0`, defaults to `'person'` when the userId isn't in the allowlist. **When `KNOWN_BOT_IDS.size === 0` (cold-boot window between `app.listen` and `registerBotIds` completing), defaults to `'unknown'` (drops the webhook) so the pre-fix safe behavior is preserved during the registration race.** Self-healing: once registration completes, default flips to `'person'` for the rest of the process lifetime. Rationale: closes the cold-boot window 4/6 reviewers flagged, without adding deploy latency or new failure surfaces.
- **Path-tolerant `last_edited_by` lookup only.** Replace `body?.data?.last_edited_by` with `(body?.data ?? body)?.last_edited_by` so misconfigured automation bodies (no `data` wrapper) still extract the actor. **Do NOT change the `source` lookup** — real Notion button payloads put `source` at body level by design (sibling to `data`, not nested inside it), verified in `test/notion/actor-classifier.test.js:9-14` and `test/routes/add-task-set.test.js:832-839`. Touching `source` would silently break every button automation.
- **Telemetry on missing last_edited_by.** Add a `webhook_actor_missing_last_edited_by` event when both `source.user_id` and `last_edited_by` are absent. Misconfiguration surfaces loudly instead of silently dropping. Rationale: silent drops were the root cause of this incident — observability prevents recurrence.
- **Backfill as a one-off script, not a permanent endpoint.** Avoid net-new admin surface area. Script queries Notion for tasks where `Reference Start/End != Dates Start/End` on Migration Playground / recently-touched studies, dedupes per-study (only one cascade per study needed since cascade walks the graph), and POSTs synthesized webhooks to `/webhook/date-cascade`. Rationale: the affected window is bounded (2026-05-08 → 2026-05-12), the operation is one-off, and a permanent endpoint would itself need an auth/gate review.
- **Preserve security stance from PR #101 with explicit third-party trade-off.** The gate still rejects engine-known bot writes via positive ID match — strictly safer because `KNOWN_BOT_IDS` is a closed allowlist. **However, third-party bot writers not in `KNOWN_BOT_IDS` (Notion AI editing dates, Zapier zaps, future workspace integrations) will now be classified as `'person'` and trigger cascades.** This is a deliberate posture shift from PR #101's "drop ALL bot writes" stance, accepted because (a) Meg's Notion AI date-edit workflow needs cascades to fire, and (b) the alternative — a curated config allowlist — defers the decision without resolving it. U4 telemetry logs every non-engine-bot user_id seen on a webhook so unexpected actors surface in monitoring (`event: webhook_actor_unrecognized` with truncated id + route).

---

## Open Questions

### Resolved During Planning

- **Should the cascade-queue gate change?** No. The gate's logic and position are correct (per `docs/solutions/cascade-queue-gate-position.md`). Only the classifier's output changes.
- **Should we revert to PR #103's `editedByBot === 'bot'` semantic?** No. That would re-introduce the 2026-05-07 integration-type vulnerability (provisioning pool bot writes were `type='integration'`, which `=== 'bot'` missed). The `KNOWN_BOT_IDS` allowlist catches both.
- **What if `KNOWN_BOT_IDS` is empty at runtime?** Cold-boot guard (R7, built into U1) handles this structurally: edit-first returns `'unknown'` while the allowlist is empty, drops the webhook (pre-fix safe behavior), and self-heals once registration completes. U5 still verifies the steady state, but the engine is no longer dependent on registration succeeding before any webhook arrives.
- **How do we know which cascades to replay?** Reference vs Dates divergence is the signal. Engine writes `Reference = Dates` after every successful cascade ([`src/routes/date-cascade.js:174-175`](../../src/routes/date-cascade.js)). If they differ, the cascade either never ran or got dropped.
- **(Round 1 doc review) Should U2 also reshape `source` lookup?** No. Real Notion button payloads put `source` at body level (sibling to `data`), not inside `data`. U2 is scoped to `last_edited_by` only; touching `source` would silently break every button automation.
- **(Round 1 doc review) How should the cold-boot race be mitigated?** Cold-boot guard built into U1's classifier (option A from the walk-through). Self-healing, no deploy delay, no spurious 5xx alerts.
- **(Round 1 doc review) How explicit should the third-party bot posture shift be?** Plan acknowledges it explicitly (R8 + Key Technical Decisions + Risk row); U4 telemetry logs every non-engine actor for monitoring. No config allowlist for now — defer until we have evidence a specific bot needs gating.
- **(Round 1 doc review) U6 seed selection — per study or per chain?** Per connected component (chain). Most recently edited divergent task wins; tie-break on largest delta, then alphabetical task UUID for full determinism. Frozen tasks skip with explicit reporting.
- **(Round 2 doc review) Cold-boot guard implementation — module-level Set or injected option?** Use the resolved `knownBotIds` option, NOT the module-level `KNOWN_BOT_IDS` constant. Tests inject local Sets via the option; reading module-level state would make every "allowlist populated" test fail and the guard untestable via the public API.
- **(Round 2 doc review) `webhook_actor_unrecognized` event noise problem?** Switch to first-seen-only: maintain an in-memory Set of observed userIds, emit only on first occurrence per process boot. Reduces the event from ~hundreds/day to ~one per unique actor per restart.
- **(Round 2 doc review) Cold-boot drop visibility?** Add `webhook_dropped_cold_boot` structured log event for every drop during the registration-race window. Bounded by the window (seconds per deploy), so log volume is small. Lets ops correlate post-deploy "edit didn't propagate" complaints to the actual window.

### Deferred to Implementation

- ~~Exact rate-limiting policy for the `webhook_actor_missing_last_edited_by` telemetry event~~ — RESOLVED: no rate-limiting for `missing_last_edited_by` (rare misconfiguration); `webhook_actor_unrecognized` uses first-seen-only suppression instead.
- Whether the backfill script should be `node scripts/...` or `npm run backfill:cascades`. Resolve in U6.
- Whether to scope the backfill to specific studies (Migration Playground) or all studies with Reference/Dates divergence in the affected window. Resolve in U6 based on what the diagnostic query surfaces.
- **U2 source-asymmetry future risk:** the path-tolerant unwrap applies to `last_edited_by` only. If Notion changes its webhook payload shape to nest `source` under `data` (a future product change we can't predict), every button automation silently breaks. The plan's verification ("verified 2026-05-12 by Tem") is moment-in-time. Mitigation if it ever bites: add path-tolerance to `source` AND update test fixtures in lockstep. Optional preventive measure deferred: emit a `webhook_source_unexpected_location` event if `body.data.source` is ever observed (it shouldn't be today), so future shape changes surface in telemetry before causing breakage.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

The current `classifyWebhookActor` has asymmetric fallback behavior between button-first and edit-first paths:

```
button-first path (today, works):
  source.user_id exists →
    rawType = source.type
          ?? (KNOWN_BOT_IDS.has(source.user_id) ? 'bot' : 'person')

edit-first path (today, broken):
  last_edited_by →
    rawType = last_edited_by.type
          ?? null   ← drops to 'unknown' → editedByBot=true
```

The fix makes them symmetric:

```
edit-first path (after fix):
  last_edited_by →
    rawType = last_edited_by.type
          ?? (KNOWN_BOT_IDS.has(last_edited_by.id) ? 'bot' : 'person')
```

Resulting classification matrix:

| `last_edited_by` shape from Notion | Today | After fix (allowlist populated) | After fix (cold-boot, allowlist empty) |
|---|---|---|---|
| `{id, type: 'person'}` | person ✓ | person ✓ | person ✓ (explicit type bypasses cold-boot guard) |
| `{id, type: 'bot'}` | bot ✓ | bot ✓ | bot ✓ |
| `{id, type: 'integration'}` | bot ✓ (PR #104) | bot ✓ (PR #104) | bot ✓ |
| `{id}` — user, id NOT in KNOWN_BOT_IDS | **bot ✗ (drops legit edits)** | person ✓ | bot (cold-boot guard — safely dropped during boot window) |
| `{id}` — bot, id IN KNOWN_BOT_IDS | bot ✓ (accidentally right) | bot ✓ (positively identified) | bot (cold-boot guard) |
| `{id}` — third-party bot, id NOT in KNOWN_BOT_IDS | bot ✗ | **person + `webhook_actor_unrecognized` telemetry** | bot (cold-boot guard) |
| missing entirely | bot ✗ | person + `webhook_actor_missing_last_edited_by` telemetry | bot (cold-boot guard) |

The "after fix (allowlist populated)" column is the steady-state behavior — matches actual Notion webhook payload behavior without weakening security. The "cold-boot" column shows the safe-fallback during the 1-10s registration race: behaves like today's conservative classifier until `KNOWN_BOT_IDS` is populated, then transitions to the new permissive behavior for the rest of the process lifetime.

Backfill flow:

```
1. Query Notion: SELECT tasks WHERE Reference Start != Dates.start OR Reference End != Dates.end
2. Group by studyId, deduplicate to one task per study (cascade walks downstream from one seed)
3. For each (studyId, seedTaskId):
   - Synthesize webhook payload mimicking Notion's "When Dates changes" shape
   - Include last_edited_by: {id: 'replay-script-actor', type: 'person'} so the post-fix classifier sees a clean person actor
   - POST to /webhook/date-cascade with WEBHOOK_SECRET
   - Wait for terminal Activity Log entry (or 60s timeout) before next study
4. Report: studies replayed, tasks affected, any failures
```

---

## Implementation Units

### U1. classifyWebhookActor edit-first mode: KNOWN_BOT_IDS fallback + cold-boot guard + empty-id truthiness

**Goal:** When `last_edited_by.type` is missing, fall back to `KNOWN_BOT_IDS` lookup, with a cold-boot guard that preserves pre-fix safe behavior while the allowlist is still being populated at startup.

**Requirements:** R1, R2, R3, R7

**Dependencies:** None

**Files:**
- Modify: `src/notion/actor-classifier.js`
- Test: `test/notion/actor-classifier.test.js`

**Approach:**
- In the `else` branch of `classifyWebhookActor` (the edit-first path, currently lines 60-66), replace `rawType = candidate?.type ?? null` with a fallback chain that:
  - Uses `candidate.type` when present (preserves PR #104's integration-type protection)
  - When type is missing: if `knownBotIds.size > 0` (steady state), looks up the userId in the resolved `knownBotIds` option — returns `'bot'` if in allowlist, `'person'` otherwise
  - **Cold-boot guard:** when `knownBotIds.size === 0` (between `app.listen` resolving and `registerBotIds` completing), returns `'unknown'` so the front-door gate drops the webhook (preserves pre-fix safe behavior during the registration race). The size>0 transition is monotonic in production — once populated, the allowlist never empties for the process lifetime.
- **Critical: use `knownBotIds.size`, NOT `KNOWN_BOT_IDS.size`.** The classifier accepts `knownBotIds` as an injected option (line 41) defaulting to the module-level `KNOWN_BOT_IDS` Set. Every existing test passes its own local Set via this option — the module-level Set stays empty across the entire test suite. If the cold-boot guard reads the module-level Set directly, every "allowlist populated" test breaks because the module-level Set is empty even when the test's injected Set isn't. Read the resolved option throughout. (Caught in Round 2 doc review — original spec said the opposite.)
- **Empty-string id guard:** wrap the userId derivation so empty-string id values are normalized to `null` before the `mentionable` computation. Mirrors the existing button-first empty-string guard at line 51. Localized to the else branch — does not change the universal `userId` derivation that other paths depend on.
- **Cold-boot drop telemetry:** when the cold-boot guard returns `'unknown'`, emit a structured event `webhook_dropped_cold_boot` (payload: `{event, route, taskIdPrefix, userIdPrefix}`) so ops can correlate post-deploy "my edit didn't propagate" reports with the actual registration-race window. The event is bounded by the registration window (seconds per deploy) so log volume is small.
- Preserve existing security comment but update it to describe positive bot identification via allowlist plus cold-boot guard, not conservative unknown-bias.
- Behavior when `lastEditedBy` is completely missing AND allowlist populated: `candidate` is undefined → `userId = null` → defaults to `'person'` but `mentionable = false`. U4 adds telemetry for this case so misconfigurations surface.
- Behavior when `lastEditedBy` is completely missing AND cold-boot window: cold-boot guard returns `'unknown'` → `editedByBot=true` → drop + `webhook_dropped_cold_boot` event.

**Execution note:** Test-first. The behavior is security-relevant — write the new test assertions before changing the classifier so we don't accidentally weaken the bot-detection path while fixing the unknown-classification path.

**Patterns to follow:**
- Existing button-first logic at `src/notion/actor-classifier.js:51-59` (KNOWN_BOT_IDS fallback + empty-string guard)
- `registerBotId(id)` export at line 27 — the cold-boot guard reads `KNOWN_BOT_IDS.size` directly; do not re-export internals

**Test scenarios:**
- Happy path: `last_edited_by = {id: 'user-1', type: 'person'}` → `editedByBot=false`, `mentionable=true`. (Preserves existing behavior.)
- Happy path: `last_edited_by = {id: 'bot-1', type: 'bot'}` → `editedByBot=true`. (Preserves existing behavior.)
- Happy path NEW: `last_edited_by = {id: 'user-1'}` + userId NOT in KNOWN_BOT_IDS (allowlist populated) → `editedByBot=false`, `mentionable=true`. (Regression fix for Tem's 2026-05-12 edits.)
- Happy path NEW: `last_edited_by = {id: 'bot-1'}` + userId IN KNOWN_BOT_IDS → `editedByBot=true`, `mentionable=false`. (Engine echoes drop via positive ID match.)
- Cold-boot NEW: `last_edited_by = {id: 'bot-1'}` + KNOWN_BOT_IDS is empty (cold-boot window) → `editedByBot=true` (cold-boot guard treats unknown as bot; webhook drops). Engine echoes still safely suppressed during the registration race.
- Cold-boot NEW: `last_edited_by = {id: 'user-1', type: 'person'}` + KNOWN_BOT_IDS is empty → `editedByBot=false`. (Explicit type bypasses the guard; legitimate person edits still work even during cold-boot.)
- Edge case: `last_edited_by` missing entirely (no field) + allowlist populated → `editedByBot=false`, `userId=null`, `mentionable=false`. U4 telemetry emits.
- Edge case: `last_edited_by` missing entirely + cold-boot window → `editedByBot=true` (cold-boot guard).
- Edge case: `last_edited_by = {id: 'integration-1', type: 'integration'}` → `editedByBot=true`. (Preserves PR #104's integration-type fix unchanged.)
- Edge case: `last_edited_by = {id: ''}` (empty string id) → empty-string guard normalizes to `null`, classifier returns `'person'` (assuming populated allowlist), `mentionable=false`.

**Verification:**
- All existing `test/notion/actor-classifier.test.js` tests pass.
- All new test cases above pass.
- `npm test` exits 0 across the full suite (no regression in adjacent guards).

---

### U2. Make `last_edited_by` lookup path-tolerant (do NOT touch source)

**Goal:** Match `parseWebhookPayload`'s fallback chain for `last_edited_by` only, so misconfigured automation bodies without a `data` wrapper still extract the actor. **`source` must not be moved** — it lives at body level by design and the current `body?.source` access is correct.

**Requirements:** R5

**Dependencies:** None (independent of U1; can land in same PR for surgical scope)

**Files:**
- Modify: `src/notion/actor-classifier.js`
- Test: `test/notion/actor-classifier.test.js`

**Approach:**
- In `classifyWebhookActor`, after the existing `const body = …` line, derive a `data` reference for the property-change path only: `const data = body?.data ?? body;`.
- Replace `body?.data?.last_edited_by` with `data?.last_edited_by`. This is the ONLY structural change.
- **Leave `body?.source` exactly as-is.** Real Notion button payloads have `source` as a top-level sibling of `data`. Verified in `test/notion/actor-classifier.test.js:9-14` (`buttonPayload` returns `{source: ..., data: ...}`) and `test/routes/add-task-set.test.js:832-839`. Moving the source access to `data?.source` would silently break every button automation (add-task-set, inception, deletion, undo-cascade) by losing the source.user_id security binding that `test/notion/actor-classifier.test.js:201-235` locks down.
- Patterns to follow: `parseWebhookPayload`'s body/data unwrap at `src/gates/guards.js:21-22` — but apply the same shape only to the property-change branch, not universally.

**Test scenarios:**
- Happy path: `payload.body.data.last_edited_by` exists → reads correctly. (Existing fixtures.)
- Happy path NEW: `payload.body.last_edited_by` exists (no data wrapper) → reads correctly.
- Regression guard NEW: button payload with `source` at body level + `last_edited_by` inside data → button-first path still reads source.user_id correctly. (Locks in that U2 did not break button-first.)
- Edge case: all paths empty → returns same shape as today (defaults handled by U1).

**Verification:**
- All existing tests pass (especially `test/notion/actor-classifier.test.js:201-235` cross-field invariant tests).
- New `last_edited_by` unwrap tests pass.
- New button-first regression test passes (proves source still resolves at body level).

---

### U3. Update test/gates/guards.test.js AND test/notion/actor-classifier.test.js to reflect new permissive behavior

**Goal:** Multiple test files encode the old conservative-unknown behavior. U3 updates both `test/gates/guards.test.js` (the parseWebhookPayload-level tests) and `test/notion/actor-classifier.test.js` (the classifier-level tests) to match U1's new semantics. Adds tests for the KNOWN_BOT_IDS hit path and the cold-boot guard path.

**Requirements:** R3, R4, R7

**Dependencies:** U1

**Files:**
- Modify: `test/gates/guards.test.js`
- Modify: `test/notion/actor-classifier.test.js`

**Approach (`test/gates/guards.test.js`):**
- Line 106 test: rename from "sets editedByBot true when last_edited_by is missing" → "sets editedByBot FALSE when last_edited_by is missing AND allowlist populated (defaults to person, mentionable=false)". Update assertion.
- Line 115 test: rename from "sets editedByBot true when last_edited_by.id present but type missing" → "sets editedByBot FALSE when last_edited_by.id present but type missing AND id not in KNOWN_BOT_IDS". Update assertion.
- Add: "sets editedByBot TRUE when last_edited_by.id is in KNOWN_BOT_IDS even without type". Register a bot id via `registerBotId()` in the test setup, then assert.
- Add: "cold-boot guard: sets editedByBot TRUE when KNOWN_BOT_IDS is empty and type is missing". Verify the registration-race safe-fallback locks in.
- Keep line 92 (`type is bot`), 99 (`type is person`), 123 (`integration type`) unchanged — explicit-type paths are preserved.

**Approach (`test/notion/actor-classifier.test.js`):**
- Update existing edit-first tests at lines 136-160 (`id present but no type → editedByBot=true (conservative)` and `no last_edited_by field at all → editedByBot=true`) — both now expect `editedByBot=false` when allowlist is populated.
- Update telemetry test at lines 264-275 (`webhook_actor_misclassified does NOT emit for edit-first integration type`): this assertion remains TRUE under the new U4 semantics — `webhook_actor_misclassified` only fires on `button-first` path mismatches. Add a new test alongside it asserting `webhook_actor_unrecognized` is NOT emitted for explicit `type: 'integration'` (caught by the explicit-type branch, no fallback to allowlist lookup). The legacy `webhook_actor_misclassified` event is kept; the new tests cover U4's two new events without removing the existing test.
- Add corresponding cold-boot guard tests at the classifier level: register zero bot ids in the test's local Set, assert classifier returns `userType: 'unknown'` for missing-type edit-first webhooks; assert `webhook_dropped_cold_boot` event emits with the expected payload shape.
- Add `_resetUnrecognizedActorSeen()` test helper invocation in `beforeEach` so the first-seen-only telemetry seen-set doesn't bleed across tests.
- Add new test: button payload with `source` at body level + `last_edited_by` inside `data` → button-first path still resolves source.user_id correctly. (Regression guard for U2's deliberate asymmetry.)

**Test scenarios:**
- All updated tests pass under the new behavior.
- New KNOWN_BOT_IDS-hit tests pass.
- New cold-boot guard tests pass.
- New U2-regression test passes (source still at body level).

**Verification:**
- `npm test test/gates/guards.test.js test/notion/actor-classifier.test.js` exits 0.
- Full suite (`npm test`) exits 0.

---

### U4. Two telemetry events: missing-actor + unrecognized-actor (no rate-limiting)

**Goal:** Two new structured log events surface (a) misconfigurations where the actor is entirely absent, and (b) third-party bot actors that aren't in the engine's allowlist — so ops can spot unexpected automation behavior in Railway logs.

**Requirements:** R4, R8

**Dependencies:** U1

**Files:**
- Modify: `src/notion/actor-classifier.js`
- Test: `test/notion/actor-classifier.test.js`

**Approach:**
- In the `else` branch of `classifyWebhookActor`:
  - **Event 1 — `webhook_actor_missing_last_edited_by`**: emit when `candidate` is undefined/null AND `source?.user_id` is absent (true structural misconfiguration). Payload: `{event, sourcePriority, route}`. No user id present to include.
  - **Event 2 — `webhook_actor_unrecognized`** (first-seen-only): emit ONLY on the FIRST observation of each unique `candidate.id` per engine process boot. Maintain a module-level `Set<string>` of already-seen userIds; emit + add-to-set on first occurrence, no-op afterward. Conditions: `candidate?.id` is present AND `knownBotIds.size > 0` (not cold-boot) AND the id is NOT in `knownBotIds` AND the id is NOT already in the seen-set. Payload: `{event, sourcePriority, route, userIdPrefix: id.slice(0, 8)}`. Truncated id for privacy; full id stays out of logs.
- **Rationale for first-seen-only:** the original "fires on every unrecognized webhook" design would emit on every real user edit (Notion omits `type` for all actors in webhook bodies, not just bots), drowning the signal in noise. First-seen-only emits ~once per unique user per engine boot — a clean signal where a new actor genuinely is surfaced and the engine restart resets the cache. Seen-set is in-memory; lost on restart by design (re-emission per actor per restart is the desired cadence).
- **Legacy event preserved:** the existing `webhook_actor_misclassified` event (`actor-classifier.js:79-92`) is kept as-is. It fires only on the `button-first` path when legacy Pattern A disagrees with the new classification — a distinct purpose from U4's two new events. Consolidating the three is out of scope for this plan; treat `webhook_actor_misclassified` as legacy diagnostic alongside the new events.
- Do NOT change the return value — classification still proceeds per U1; these are observability-only.

**Test scenarios:**
- Edge case: `last_edited_by` and `source.user_id` both missing → `webhook_actor_missing_last_edited_by` emitted exactly once per webhook.
- Edge case (first-seen): `last_edited_by = {id: 'unrecognized-id-1'}` + allowlist populated + id NOT in allowlist + seen-set empty → `webhook_actor_unrecognized` emitted with `userIdPrefix: 'unrecogn'`.
- Edge case (repeat): same payload fired a second time within the same process boot → NO telemetry (id is now in seen-set).
- Edge case (multiple distinct ids): two different unrecognized ids in the same boot → telemetry emitted twice (one per unique id).
- Edge case: `last_edited_by = {id: bot-id-in-allowlist}` → NO telemetry (recognized engine bot).
- Edge case: `last_edited_by = {id: 'x'}` + cold-boot window (allowlist empty) → NO unrecognized-actor telemetry (cold-boot guard already drops via webhook_dropped_cold_boot from U1).
- Happy path: `last_edited_by = {id: 'x', type: 'person'}` → NO telemetry (explicit type satisfied the gate).
- Test isolation: the seen-set is a module-level Set; tests must reset it between cases via `vi.beforeEach` to avoid cross-test bleed. Export a `_resetUnrecognizedActorSeen()` symbol prefixed with underscore (test-only convention).

**Verification:**
- Tests pass.
- Manual production check after deploy: `webhook_actor_unrecognized` events should be visible if Notion AI or any third-party automation writes to a study task during normal use. Absence over multiple days means the posture shift had no observable third-party impact.

---

### U5. Pre-Deploy Verification: KNOWN_BOT_IDS boot wiring health (not a code unit)

**Goal:** Operational verification step, not implementation work. With the cold-boot guard (R7) now built into U1, the engine is structurally safe even if registration fails — webhooks drop with `editedByBot=true` until the allowlist populates. U5 still verifies that registration is HEALTHY before deploy so the system reaches its steady-state happy path quickly rather than living in cold-boot-guard mode indefinitely.

**Requirements:** R2

**Dependencies:** None — gates deploy of U1, but is not a code unit.

**Files:** None — this is an operator checklist item.

**Approach:**
- Pull Railway logs from the latest deployment startup window: `railway logs --since "<deploy-time>" --until "<deploy-time + 5m>"`.
- Confirm a structured event line like `{event: 'bot_ids_registered', registered: N, failed: M}` appears with `N > 0` and `M = 0`.
- If absent or `N = 0`: investigate `src/startup/register-bot-ids.js` and `src/index.js:30-35` — likely culprits include env var misconfiguration (no integration tokens loaded), `/v1/users/me` returning unexpected shape, or `AbortSignal.timeout(10_000)` firing because Notion is slow.
- If `failed > 0`: partial registration is acceptable for tokens whose corresponding integrations don't write to studies, BUT see the new "registerBotIds partial-failure" risk row — engine echoes from un-registered tokens would be misclassified as `'person'` after the cold-boot window. Pair this check with an alerting recommendation (Railway notification on `failed > 0`).

**Verification (operator checklist):**
- `bot_ids_registered` event visible in Railway logs from the latest boot with `registered > 0 AND failed: 0`. The exact registered count varies based on how many distinct integration accounts back the pooled tokens (token-to-bot mapping is deduped via Set on each `/users/me` call) and whether `commentTokens` is configured separately. Treat the structural guarantee (`registered > 0 AND failed: 0`) as the pass/fail; the specific count is informational.

**Note:** With R7's cold-boot guard, a broken registration no longer blocks deploy safety — it just keeps the engine in the safe-but-degraded mode forever (drops all property-change cascades). This is recoverable by restarting after the fix.

---

### U6. Backfill — replay dropped cascades for affected studies

**Goal:** Identify study tasks whose `Reference != Dates` (signature of a dropped cascade between 2026-05-08 and the U1-U4 deploy) and re-fire the cascade once per affected study so downstream tasks finally propagate.

**Requirements:** R6

**Dependencies:** U1, U2, U3, U4, U5 — fix must be deployed before backfill fires, otherwise the replay webhooks will be dropped the same way.

**Files:**
- Create: `scripts/replay-dropped-cascades.js`
- Create: `docs/runbooks/replay-dropped-cascades.md`
- Test: `test/scripts/replay-dropped-cascades.test.js`

**Approach:**

Two-phase script with explicit operator gates:

**Phase 1 — Diagnose (dry-run, read-only):**
- Query Notion's Study Tasks DB filtered by `[Do Not Edit] Reference Start Date is not empty` AND status is not Done/N/A.
- For each study with at least one task where `dates.start != reference_start.start` or `dates.end != reference_end.start` (using ID-keyed property reads via `STUDY_TASKS_PROPS` / `findById`), record `(studyId, studyName, divergent_task_count, oldest_divergent_task_last_edited)`.
- Output a JSON envelope listing affected studies. No writes.
- Operator reviews the list and confirms which studies to replay (or `--all`).

**Phase 2 — Apply (with --apply flag and per-study confirmation):**
- For each confirmed study:
  - **Group divergent tasks by connected component** (chain). Two tasks are in the same component if they're transitively connected via `Blocked by` / `Blocking` edges. Frozen tasks (Status = Done/N/A) break the chain.
  - For each connected component containing at least one divergent task, **pick the most recently edited divergent task as the seed** (use Notion's `last_edited_time`). Tie-break on largest Reference→Dates delta if `last_edited_time` is equal. **Tertiary tie-break: alphabetical task UUID** if both timestamp and delta tie — gives a stable, reproducible seed pick so Phase 1 and Phase 2 always agree on the same task. Rationale: most recently edited best approximates the user's actual intent; per-component seed selection guarantees every affected chain in a multi-chain study gets re-cascaded; stable tie-break makes the operation deterministic across runs.
  - If a component has divergent tasks but the most recently edited one is now frozen, fall back to the next most recently edited non-frozen task. If all divergent tasks in the component are frozen, skip the component and report it (`skipped: all_frozen_component`).
  - Synthesize a webhook payload mimicking Notion's "When Dates changes" shape: include `data.id` (seed task), `data.properties` (current property snapshot via Notion fetch), and `data.last_edited_by: {id: <BACKFILL_ACTOR_USER_ID>, type: 'person'}`. The user ID is loaded from the `BACKFILL_ACTOR_USER_ID` env var (a real Notion person user — typically the operator running the script) so any downstream Notion mention writes don't 400 on a fake UUID. **Treat `BACKFILL_ACTOR_USER_ID` as a sensitive env var** — it's a deanonymizing identifier in the Notion workspace. Same hygiene as `WEBHOOK_SECRET`: don't commit, don't log unredacted, rotate if leaked. The script aborts with usage error if the env var is missing.
  - POST to `https://picnic-cascade-engine-production.up.railway.app/webhook/date-cascade` with the `X-Webhook-Secret` header (loaded from `WEBHOOK_SECRET` env var).
  - Poll Notion for terminal Activity Log entry on the study (Workflow: "Date Cascade", Source Task ID: seed task) with a 60s timeout.
  - If timeout or non-success terminal status, log and continue (don't abort the batch).
  - Throttle: 5s between components (not just between studies — multi-chain studies will fire multiple webhooks). The engine's per-study FIFO queue handles in-study serialization.
  - **Run during off-hours.** "Off-hours" = outside US/Pacific business hours (PicnicHealth team timezone). Notify the PicnicHealth eng Slack channel (placeholder: `#picnic-eng-cascade-ops` — confirm in runbook) before starting. Notification template: `Starting cascade replay backfill — N studies, ~M components, ETA <X> minutes. Operator: <name>. Abort: ping me here. Engine commit: <SHA>.` The script requires a `--confirm-notified` flag for Phase 2; running without it prints the template and exits 3.
- Output a final report: `{studies_replayed: N, components_replayed: M, tasks_affected_total: K, successes: …, failures: […]}`.

**Idempotency:**

The script is idempotent via filter-driven exclusion: a successful cascade writes `Reference = Dates` ([`src/routes/date-cascade.js:174-175`](../../src/routes/date-cascade.js)), so Phase 1's divergence query (`Reference != Dates`) excludes already-replayed studies on subsequent runs. Failed cascades leave divergence unchanged, so retry safely re-attempts those components. Edge case: if the divergence filter has a bug (e.g., misses an edge case where only one of Start/End differs), a retry could double-cascade an already-replayed study. Mitigation: each Phase 2 batch tags its `executionId` with a `backfill_replay_id` prefix so duplicate runs are detectable in post-hoc Activity Log analysis.

**Handoff / Sequencing:**

This unit is intentionally bundled with U1-U5 in the same plan, but the runtime sequencing is decoupled:
1. **Phase 1 (diagnose, read-only) can run pre-merge** to size the backfill — operator runs it against production to estimate scope and identify affected studies. No production writes.
2. **The engineering PR (U1-U4) merges and deploys** independent of U6 Phase 2.
3. **U5 (operator checklist) gates the deploy** — `bot_ids_registered > 0 AND failed: 0` verified in Railway logs from the post-merge boot.
4. **Live verification**: Tem moves a task date on a sacrificial study, confirms cascade lifecycle (queued → started → complete) in Railway logs.
5. **U6 Phase 2 (apply) runs as a scheduled operator task**, target window: within 48h of deploy. Runs against production with `--apply` and `--confirm-notified` flags. Slack notification fires before, pulse-log entry after.

The script lives in `scripts/` permanently as a forensic tool — it's gated behind `--apply` so accidental runs are impossible, and the same shape may be useful for future cascade-replay needs.

**Execution note:** Test-first for the synthesizer (the most error-prone piece). Use the existing test fixtures in `test/gates/guards.test.js` as the contract — whatever shape the parser accepts, the script must produce.

**Patterns to follow:**
- [`scripts/batch-migrate/`](../../scripts/batch-migrate/) — agent-readiness patterns: `run()` / `runMain` extraction, `--json` flag, structured envelope with `ok` discriminator + `state` + `outcome`, exit code conventions (per the 2026-05-07 polish that landed as `851a593`).
- [`scripts/repair-task-blocks.js`](../../scripts/repair-task-blocks.js) — recent example of the diagnose-then-apply, gated-with-confirmation script pattern.
- [`src/notion/property-names.js`](../../src/notion/property-names.js) — ID-keyed property reads (the script must be rename-immune; do not key by property name).

**Test scenarios:**
- Diagnose-only run on a study with no divergence → reports zero affected, exits 0.
- Diagnose-only run on a study with 3 divergent tasks across 2 chains → reports the study with `divergent_task_count: 3`.
- Apply run on one study → synthesizes one webhook, posts it, sees terminal Activity Log, reports success.
- Apply run with a missing WEBHOOK_SECRET → exits 3 (usage error) BEFORE any Notion read.
- Apply run where the cascade returns failed → logs the failure, continues to next study, final report includes it.
- Apply run where the engine returns 401 (wrong/missing secret) → fails fast with a clear error; does not silently skip.
- Apply run on a study whose seed task is now frozen (Status = Done) → script picks a different seed; if no non-frozen divergent task exists, reports the study as `skipped: all_frozen`.
- Apply run synthesizing the payload → assert that `data.id`, `data.properties[STUDY_TASKS_PROPS.DATES.id]`, and `data.last_edited_by` are present with correct shapes (use the existing `parseWebhookPayload` to validate the synthesized payload — meta-test).

**Verification:**
- Diagnose run produces a usable affected-studies list.
- Apply run on a single test study moves at least one downstream task (verify by Notion query before/after).
- Railway logs show `debounce_new` → `debounce_fired` → cascade Activity Log success for each replayed study (NOT `cascade_bot_echo_dropped`).
- After the full backfill, a re-run of Phase 1 (diagnose) reports zero or near-zero affected studies (residue acceptable for tasks that were intentionally moved without cascading, e.g., manual sync writes).

---

## System-Wide Impact

- **Interaction graph:** `classifyWebhookActor` is called by `parseWebhookPayload` (every property-change route), `parseUndoPayload` (undo-cascade), and the cascade-queue's parse-error bypass. All consumers get the same `editedByBot` value with the new semantics. The cascade-queue front-door gate at `cascade-queue.js:70` is the most impactful consumer — its drop rate should go from ~100% (today) to near-zero (after fix) for legitimate user edits, while staying high for engine echoes.
- **Error propagation:** Defense-in-depth gates remain in place inside `processDateCascade` and `processDepEdit` (`zero_delta_skip`, `import_mode_skip`, `frozen_skip`). If U1 incorrectly classifies a bot edit as 'person' (e.g., because `KNOWN_BOT_IDS` lookup fails for some reason), the cascade still runs but downstream gates catch loops. Worst-case regression: a spurious cascade fires once per bot edit; Import Mode guards still prevent the inception-fan-out flood pattern.
- **State lifecycle risks:** None for U1-U4. U6 modifies production data (re-fires cascades on real studies) — gated by `--apply` flag + per-study confirmation + the cascade engine's own Import Mode / frozen / per-study FIFO protections.
- **API surface parity:** All routes using `classifyWebhookActor({sourcePriority:'edit-first'})` benefit equally (date-cascade, dep-edit, status-rollup, undo-cascade parse-error bypass). No partial fix — one classifier change unblocks all property-change routes.
- **Integration coverage:** Required production verification post-deploy: Tem moves a task date on the Test Edits study, watches Railway for `debounce_new` (not `cascade_bot_echo_dropped`), watches the downstream tasks for actual date propagation. U6's diagnostic run is itself an integration test for the fix.
- **Unchanged invariants:** PR #101's cascade-queue front-door gate stays. PR #43's `WEBHOOK_SECRET` auth stays. PR #108's `registerBotIds` boot wiring stays. PR #104's integration-type protection stays (now via positive `KNOWN_BOT_IDS` ID match instead of negative type inference). The security posture is at least as strong as today.

---

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cold-boot window: `KNOWN_BOT_IDS` is empty between `app.listen` and `registerBotIds` completion (1-10s per Railway redeploy) | Deterministic per redeploy | High without mitigation | **Cold-boot guard built into U1**: when `KNOWN_BOT_IDS.size === 0`, edit-first classifier returns `'unknown'` → webhook drops (pre-fix safe behavior). Once `size > 0`, defaults flip to `'person'`. Self-healing, no deploy delay. U5 verifies the steady state reaches `size > 0` quickly. |
| `registerBotIds` partial failure: some tokens succeed, others fail (`Promise.allSettled`); engine echoes from un-registered token bots misclassify as `'person'` once cold-boot window closes | Medium | Medium | U5 alerts on `failed > 0`. Recommend follow-up: extend `register-bot-ids.js` with retry+exponential-backoff on failed tokens, and a periodic re-attempt loop that converges over time. Out of scope for THIS plan but tracked as immediate follow-up. |
| Third-party bots (Notion AI, Zapier, future workspace integrations) now cascade because they're not in `KNOWN_BOT_IDS` | Confirmed posture change | Low-Medium | Deliberate. Acknowledged in Key Technical Decisions and R8. U4's `webhook_actor_unrecognized` telemetry logs every non-engine-bot user_id seen on a webhook. Ops watches Railway for surprise actors; if an unwanted bot starts cascading, add a config allowlist as a follow-up. |
| New default-to-person re-introduces a spoofing vector | Very Low | Medium | `WEBHOOK_SECRET` (PR #43) already gates webhook access. An attacker would need both the secret AND a valid Notion user ID. The positive ID allowlist closes the integration-type loophole that PR #104 was protecting against. |
| Tests in `guards.test.js` (lines 106, 115) AND `actor-classifier.test.js` (lines 136-160, 264-275) fail on first run (expected) | High | Low | U3 updates BOTH files as a deliberate part of the fix. CI failure here is the expected signal that the change took effect. |
| U2 accidentally moves `source` lookup and breaks every button automation | Mitigated | Critical | U2's Approach is explicit: leave `body?.source` as-is. U3 adds a regression test that locks in body-level source resolution. |
| Backfill synthesized payload doesn't match real Notion shape → engine processes incorrectly | Medium | Medium | U6 includes a meta-test using the real `parseWebhookPayload` to validate the synthesized shape. Run U6 against a single sacrificial test study first; only `--all` after confirming end-to-end success. |
| Backfill seed selection misses a multi-chain study | Mitigated | Medium | U6 picks seeds per connected component (not per study). A study with N independent chains gets N webhooks. |
| Backfill `BACKFILL_ACTOR_USER_ID` env var missing → script fails, or set to a fake id → Notion mention writes 400 | Low | Low | Script aborts with usage error if env var missing. Runbook specifies "use a real Notion person user — typically the operator running the script." Meta-test asserts the synthesized payload's `last_edited_by.id` is a valid UUID shape. |
| Backfill triggers a cascade flood that overloads Notion (rate limit) | Low | Medium | 5s inter-component throttle. Engine's per-study queue serializes within a study. Notion's 3 req/s shared budget enforced by the existing token pool. Backfill runs off-hours with Slack notification. |
| Concurrent PM edits during backfill produce surprising outcomes | Low (off-hours run) | Low | Slack notification before script starts. PMs notified to avoid edits during the window. Engine per-study FIFO queue handles in-study serialization safely. |
| Tem's 19:09 edit DIDN'T fire a webhook at all (suggests Notion auto-disabled the automation) | Confirmed | Medium | Out of scope for this plan — operator-side check. Tem confirms each affected study's automations are active before the backfill runs. |

---

## Documentation / Operational Notes

- Update [`docs/ENGINE-BEHAVIOR-REFERENCE.md`](../ENGINE-BEHAVIOR-REFERENCE.md) Section 7 (or the changelog) with a 2026-05-12 entry noting: (a) the edit-first KNOWN_BOT_IDS fallback with cold-boot guard, (b) the `last_edited_by`-only path-tolerant unwrap, (c) the third-party bot posture shift, and (d) the two new telemetry events.
- **Notion automation body shape note (inline reminder for future operators).** Every property-change automation that POSTs to a `/webhook/*` engine endpoint MUST include `last_edited_by` in the JSON body (the user reference picked from Notion's automation builder property dropdown). The engine reads the user id from this field; missing `last_edited_by` causes the webhook to drop via the cold-boot guard or `webhook_actor_missing_last_edited_by` telemetry path. The runbook (deferred to follow-up doc PR) will expand on this.
- The `webhook_actor_missing_last_edited_by` and `webhook_actor_unrecognized` telemetry events from U4 should be added to the standard ops dashboard or alerting rules — sustained emission indicates a misconfigured automation or an unexpected third-party actor writing to study tasks.
- The `bot_ids_registered` event with `failed > 0` should also trigger an alert (per U5's checklist) — partial registration leaves engine echoes from un-registered tokens vulnerable to misclassification once the cold-boot window closes.
- After U6 completes, write a short pulse-log entry in the picnic-health repo capturing: studies replayed, components per study, tasks affected, any residue requiring manual follow-up.

---

## Sources & References

- **Origin:** 2026-05-12 production debugging session — Railway logs showed all property-change cascades dropping since ~2026-05-08.
- **Related solutions:**
  - [`docs/solutions/cascade-queue-gate-position.md`](../solutions/cascade-queue-gate-position.md) — PR #101 design rationale (gate at resource boundary).
  - [`docs/solutions/silent-partial-failure-in-async-batches.md`](../solutions/silent-partial-failure-in-async-batches.md) — adjacent pattern (silent drops in async pipelines).
- **Related PRs:**
  - PR #101 `87b20fb` — cascade-queue front-door bot-author gate (2026-05-06)
  - PR #104 `58c16e6` — actor-classifier unify + `editedByBot = !== 'person'` (2026-05-07)
  - PR #107 `f0ba598` — human-noop cascade feedback (2026-05-07)
  - PR #108 `029a6ec` — registerBotIds at boot (2026-05-07)
- **Related plans:**
  - [`docs/plans/2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md`](2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md) — original PR #101 plan; this fix tunes the classifier input that gate consumes.
  - [`docs/plans/2026-04-29-002-refactor-webhook-actor-classification-plan.md`](2026-04-29-002-refactor-webhook-actor-classification-plan.md) — PR #104 plan; this fix closes the residual R1 boot-wiring follow-up in the property-change path.
- **External:** Notion automation builder does not expose `last_edited_by.type` as a body field — verified 2026-05-12 by Tem.
