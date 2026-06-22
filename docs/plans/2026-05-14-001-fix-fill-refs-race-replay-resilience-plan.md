---
title: "fix: Fill Refs automation race makes replay-dropped-cascades ineffective"
type: fix
status: completed
date: 2026-05-14
---

# fix: Fill Refs automation race makes replay-dropped-cascades ineffective

## Overview

The Notion "Fill Refs" database automation overwrites already-populated `[Do Not Edit] Reference Start/End Date` values, causing a race condition that silently zeroes the delta the cascade engine computes from `classify()`. This makes the `replay-dropped-cascades` script ineffective — three consecutive replay attempts on the Sanofi Pre-T1D study (2026-05-14) all produced `mode=null`, `updateCount=0`.

Two fixes are needed: (1) correct the Notion-side automation filter to stop the overwrite, and (2) add a `_replayTrustRef` flag so the replay script can bypass the stale-reference correction in `classify()` when Notion-side races make DB Reference unreliable.

---

## Problem Frame

The cascade engine classifies every edit via `signedBDDelta(Reference, Dates)`. The stale-reference correction in `classify()` (lines 85-138 of `src/engine/classify.js`) compares webhook Reference against DB Reference and adopts the DB value when they differ. This correction is correct under normal operation — it handles the case where the webhook payload was generated before a concurrent engine write updated Reference.

However, the "Fill Refs" Notion automation is misconfigured: its view filter does not restrict to tasks where Reference is empty, so it fires on ALL `Dates is edited` events. When the replay script synthesizes a webhook with the divergent task's properties (Reference = old, Dates = new), Fill Refs simultaneously writes Reference = Dates on the same task. By the time `classify()` queries the DB (after 5s debounce), DB Reference = Dates, and the stale-ref correction recomputes delta = 0.

Evidence: Notion API query of all leaf tasks in Sanofi Pre-T1D study shows Reference = Dates on every task — Fill Refs has already clobbered all divergence.

The race sequence:
1. Replay script reads task: Reference = A, Dates = B (divergent)
2. Replay script synthesizes webhook with Reference = A, Dates = B
3. Fill Refs fires (on some edit) and writes Reference = B
4. Engine debounces 5s, queries DB: Reference = B, Dates = B
5. `classify()` stale-ref correction: DB ref (B) ≠ webhook ref (A) → adopts DB ref
6. Recomputed delta = B - B = 0 → `cascadeMode = null`
7. No cascade runs, no Activity Log entry created

This is documented as a known failure mode in `docs/ENGINE-BEHAVIOR-REFERENCE.md` Section 11 ("Critical invariant — do NOT overwrite already-populated Reference"), but the Notion-side filter was never verified to enforce it.

---

## Requirements Trace

- R1. The Fill Refs automation filter must only fire on tasks where Reference is empty (bootstrap-not-overwrite invariant from ENGINE-BEHAVIOR-REFERENCE.md Section 11)
- R2. The replay script must be resilient to Fill Refs races by instructing the engine to trust the webhook's Reference values
- R3. The stale-reference correction in `classify()` must be bypassable via an explicit flag without affecting normal cascade behavior
- R4. ENGINE-BEHAVIOR-REFERENCE.md must document the fix and update the known failure modes table
- R5. Existing tests must not regress; new tests must cover the flag path

---

## Scope Boundaries

- NOT changing `classify()`'s default behavior — stale-ref correction remains the default for all normal cascades
- NOT adding a new webhook endpoint — the flag rides on the existing payload shape
- NOT fixing the two known replay script bugs on branch `tem/fix-replay-script-poll-and-formatter` (Source Task ID property mismatch and seed Reference writeback gap) — those are separate follow-ups
- NOT implementing automatic detection of Fill Refs misconfiguration — the Notion API does not expose automation configs

### Deferred to Follow-Up Work

- Merge `tem/fix-replay-script-poll-and-formatter` (commit `c9d4801`) for the Activity Log poll fix: separate PR
- Seed Reference writeback on `no_shifts` terminal: filed follow-up, not yet addressed
- Automated Notion automation health check: blocked by Notion API not exposing automation configs

---

## Context & Research

### Relevant Code and Patterns

- `src/engine/classify.js:85-138` — stale-reference correction reads `dbRefStart`/`dbRefEnd` from `allTasks`, adopts DB values when they differ from webhook
- `src/gates/guards.js:20-110` — `parseWebhookPayload` extracts Reference and Dates from webhook payload properties; returns `_replayTrustRef` would follow the same pass-through pattern as `editedByBot`, `mentionable`, `executionId`
- `scripts/replay-dropped-cascades.js:217-230` — `synthesizeWebhookPayload` builds webhook body from seed task's properties
- `src/routes/date-cascade.js:188-263` — `processDateCascade` orchestration; the zero-delta gate at line 217 runs before `classify()`
- `test/engine/classify.test.js:212-300` — three stale-ref correction tests with consistent mock pattern: `{taskId, taskName, newStart, newEnd, refStart, refEnd}` task + `[{id, refStart, refEnd}]` DB snapshot array
- `test/scripts/replay-dropped-cascades.test.js:195-214` — minimal `synthesizeWebhookPayload` tests using `makeTask()` helper

### Institutional Learnings

- **Three-layer gate posture** (`docs/solutions/cascade-queue-gate-position.md`): Notion-side filter → cascade-queue front-door → per-handler defense-in-depth. The `_replayTrustRef` flag is a per-handler defense-in-depth mechanism that compensates for Notion-side filter misconfiguration.
- **Reference vs Dates divergence is the canonical dropped-cascade signal** (plan `2026-05-12-001`): `REF_START/REF_END != Dates` means the cascade never ran. Fill Refs clobbering this signal eliminates the replay script's ability to detect dropped cascades.
- **Seed Reference writeback gap**: `date-cascade.js` writes `Reference = Dates` on shifted tasks but not on the seed for `no_shifts` terminals. This leaves cosmetic residue that the replay script's diagnose phase keeps flagging. Related but separate fix.

---

## Key Technical Decisions

- **Flag name `_replayTrustRef`**: Underscore prefix signals internal/non-Notion-originated field, matching the `_reportingMsg` and `_isRollUp` patterns in the codebase. "TrustRef" is specific about what it does (trust webhook Reference, skip DB correction). The webhook-body field is `_replayTrustRef` (underscore prefix for non-Notion-originated data); the `classify()` function parameter is `trustWebhookRef` (camelCase matching JS conventions). The names differ intentionally — one is a wire format field, the other is a function parameter.
- **Flag is payload-level, not query-param or header**: Keeps the entire replay intent self-contained in the webhook body. The cascade-queue debounce stores the raw payload; a query param would be lost after enqueue. The flag lives at `body._replayTrustRef` only (not `body.data._replayTrustRef`) since the replay script controls the payload shape and there is no Notion-originated equivalent to fall back from.
- **`classify()` receives the flag via a new options parameter**: Rather than adding it to the `allTasks` array or the parsed object, pass it as a 5th parameter `{ trustWebhookRef }` to keep the function signature clean. The flag defaults to `false`.
- **No additional auth gating on the flag**: The webhook endpoint already requires `x-webhook-secret` header auth (Section 7 of ENGINE-BEHAVIOR-REFERENCE.md). Any caller who can POST to the endpoint is already authenticated.
- **Notion filter fix is documented as a manual step**: The Notion API does not expose automation configurations. The plan documents exact filter conditions for Tem/Meg to apply in the Notion UI.

---

## Open Questions

### Resolved During Planning

- **Q: Does the flag need to flow through `cascadeQueue`?** Yes — the queue stores the raw payload body and passes it to `processDateCascade`. `parseWebhookPayload` must extract the flag from the body so it survives the enqueue/dequeue cycle.
- **Q: Should `classify()` log when `trustWebhookRef` bypasses stale-ref correction?** Yes — a telemetry event `stale_ref_bypass_replay` should be emitted so operators can correlate replay runs with engine behavior.
- **Q: Does Fill Refs trigger on Reference property edits or only Dates edits?** Per ENGINE-BEHAVIOR-REFERENCE.md Section 11, the primary trigger is `Dates is edited`. But the view filter scope determines which tasks the automation acts on. If the view doesn't exclude tasks with populated Reference, all tasks with date edits get Reference overwritten.

### Deferred to Implementation

- **Whether `_replayTrustRef` should also bypass the zero-delta gate**: No — the zero-delta gate at `date-cascade.js:217` runs on the webhook's own Reference vs Dates delta, which is computed before any DB read. If the webhook payload itself has zero delta, the replay script picked a non-divergent task as seed, which is a script bug, not a race.

### From 2026-05-14 review

- **[P1] Fill Refs race breaks all manual-task cascades, not just replays** *(adversarial reviewer)*: The plan frames the misconfigured Fill Refs automation as a replay-script problem, but the same clobber happens on every normal PM date-edit cascade — Reference is overwritten before the engine reads it, producing stale refs and potentially wrong deltas for live cascades too. Fix ordering may need inversion: the Notion filter fix (U5) may need to be applied before the code fix matters, or the plan needs to address what happens to live cascades while the filter is still misconfigured.
- **[P1] Zero-delta gate blocks `_replayTrustRef` from being reached when seed is clobbered** *(adversarial reviewer)*: When Fill Refs has already synced Reference = Dates for all tasks, `datesDiverge()` in the replay script returns false for every task (no divergent seeds found). Even if a seed is force-selected, re-fetching it at line 535 retrieves the clobbered data, producing a zero-delta payload that the `date-cascade.js:217` gate rejects before `classify()` (and thus `_replayTrustRef`) is ever reached. The plan needs a recovery mechanism for the destroyed divergence signal — either the replay script synthesizes known-good Reference values from an external source, or it bypasses `datesDiverge()` and the zero-delta gate when `_replayTrustRef` is set.
- **[P1] Shared webhook secret scoping** *(security-lens reviewer)*: The plan notes that no additional auth gating is needed because the webhook endpoint already requires `x-webhook-secret`. However, this means any caller with the shared secret (Notion automations, n8n legacy, the replay script) can set `_replayTrustRef: true` on any payload. Consider whether to add a call-site distinction (e.g., a separate replay-specific secret or an additional header) so that only the replay script can assert trust, or document why the shared-secret model is acceptable given the threat profile.
- **[P2] Telemetry event delivery** *(security-lens reviewer)*: U2 adds a `stale_ref_bypass_replay` telemetry event, but the plan doesn't specify where it surfaces beyond Railway logs. Consider whether the event should write to Notion Activity Log fields, trigger an alert, or integrate with existing monitoring — especially since silent stale-ref bypasses could mask data integrity issues if the flag is set erroneously.
- **[P2] Queue coalescing behavior when replay and Notion payloads collide** *(security-lens reviewer)*: The cascade queue uses debounce/coalescing to merge rapid-fire webhook payloads for the same task. If a replay payload (with `_replayTrustRef: true`) and a real Notion payload arrive within the debounce window, the coalesced payload may either gain or lose the flag depending on which payload wins. Document expected behavior or add a merge rule that preserves `_replayTrustRef` if present in any coalesced payload.

---

## Implementation Units

- U1. **Pass `_replayTrustRef` through parseWebhookPayload**

**Goal:** Extract the `_replayTrustRef` flag from the webhook body and include it in the parsed output so downstream consumers can act on it.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/gates/guards.js`
- Test: `test/gates/guards.test.js`

**Approach:**
- In `parseWebhookPayload`, read `body._replayTrustRef` and pass it through as a boolean on the returned object, defaulting to `false`. No `body.data` fallback — the replay script controls the payload shape and places the flag at the body level only (see Key Technical Decisions).
- The flag must survive the cascade-queue enqueue/dequeue cycle — since the queue stores the raw payload body and re-parses via `parseWebhookPayload`, this is automatic.

**Patterns to follow:**
- `editedByBot` pass-through from `classifyWebhookActor` at `src/gates/guards.js:79-95`

**Test scenarios:**
- Happy path: payload with `body._replayTrustRef = true` → parsed output has `_replayTrustRef === true`
- Edge case: payload without `_replayTrustRef` field → parsed output has `_replayTrustRef === false`
- Edge case: payload with `_replayTrustRef = "yes"` (non-boolean truthy) → parsed output has `_replayTrustRef === true` (Boolean coercion)

**Verification:**
- `parseWebhookPayload` returns the flag on both normal and replay payloads
- Existing tests pass unchanged

---

- U2. **Skip stale-ref correction in classify when `trustWebhookRef` is set**

**Goal:** When the caller signals that the webhook's Reference values should be trusted over the DB, skip the stale-reference correction block in `classify()` so the original delta is preserved.

**Requirements:** R3, R5

**Dependencies:** U1

**Files:**
- Modify: `src/engine/classify.js`
- Test: `test/engine/classify.test.js`

**Approach:**
- Add a 5th parameter `options = {}` to `classify()`. Destructure `{ trustWebhookRef = false }` from it.
- Wrap the stale-ref correction block (lines 85-138) in `if (!trustWebhookRef) { ... }`.
- When `trustWebhookRef` is true **and** DB refs differ from webhook refs (i.e., the bypass actually skips a correction that would have fired), emit a structured telemetry log: `{ event: 'stale_ref_bypass_replay', taskId, webhookRefStart, webhookRefEnd, dbRefStart, dbRefEnd }`. When DB refs match webhook refs, no correction would have fired anyway, so no event is emitted.
- All existing callers pass no 5th argument, so `trustWebhookRef` defaults to `false` and behavior is unchanged.

**Patterns to follow:**
- Existing stale-ref correction tests at `test/engine/classify.test.js:212-300` for mock shapes
- Structured telemetry pattern: `console.log(JSON.stringify({ event, ...fields }))` used throughout the codebase

**Test scenarios:**
- Happy path: `trustWebhookRef=true`, DB refs differ from webhook refs → stale-ref correction is SKIPPED, original deltas preserved, `staleRefCorrected === false`
- Happy path: `trustWebhookRef=true`, DB refs match webhook refs → no correction needed anyway, deltas unchanged
- Happy path: `trustWebhookRef=false` (default), DB refs differ → stale-ref correction runs as before (existing tests cover this)
- Edge case: `trustWebhookRef=true`, DB refs differ, webhook delta would be zero after correction but non-zero without → verify non-zero delta preserved (this is the core race condition scenario)
- Integration: telemetry event `stale_ref_bypass_replay` is emitted when bypass activates and DB refs differ

**Verification:**
- All 3 existing stale-ref tests pass unchanged (they don't pass the options parameter)
- New tests prove the flag skips correction and preserves the webhook's delta

---

- U3. **Thread `_replayTrustRef` from route to classify**

**Goal:** Wire the `_replayTrustRef` flag from the parsed webhook payload through `processDateCascade` into the `classify()` call.

**Requirements:** R2, R3

**Dependencies:** U1, U2

**Files:**
- Modify: `src/routes/date-cascade.js`
- Test: `test/routes/date-cascade.test.js`

**Approach:**
- In `processDateCascade`, after `parsed = normalizeWeekendSourceDates(rawParsed)`, pass `{ trustWebhookRef: parsed._replayTrustRef }` as the 5th argument to `classify()` at line 363.
- No other route changes needed — the flag only affects `classify()`'s stale-ref correction.

**Patterns to follow:**
- The existing `classify()` call at `src/routes/date-cascade.js:363` — just add the options object

**Test scenarios:**
- Integration: synthesized replay payload with `_replayTrustRef=true` and DB refs that differ from webhook refs → `classify()` preserves webhook delta, cascade mode is non-null
- Integration: normal webhook payload (no `_replayTrustRef`) → `classify()` behavior unchanged

**Verification:**
- Existing date-cascade route tests pass unchanged
- A replay-shaped payload produces a non-null cascade mode when DB refs have been clobbered

---

- U4. **Set `_replayTrustRef` in replay script's synthesized payload**

**Goal:** The replay script's synthesized webhook payload must include the `_replayTrustRef` flag so the engine trusts its Reference values.

**Requirements:** R2

**Dependencies:** U1, U3 (flag must be wired through parseWebhookPayload and threaded to classify before the replay script's flag has any effect)

**Files:**
- Modify: `scripts/replay-dropped-cascades.js`
- Test: `test/scripts/replay-dropped-cascades.test.js`

**Approach:**
- In `synthesizeWebhookPayload` (line 217), add `_replayTrustRef: true` to the top level of the body object (alongside `data`).
- This is the simplest change — one line added to the return object.

**Patterns to follow:**
- Existing payload structure at `scripts/replay-dropped-cascades.js:217-230`
- Meta-test pattern at `test/scripts/replay-dropped-cascades.test.js:196-207` for round-trip validation

**Test scenarios:**
- Happy path: `synthesizeWebhookPayload` output includes `body._replayTrustRef === true`
- Integration (meta-test extension): round-trip through `parseWebhookPayload` → parsed output has `_replayTrustRef === true`

**Verification:**
- The replay script's synthesized payloads now carry the flag
- Existing replay tests pass unchanged

---

- U5. **Document Notion Fill Refs filter fix and update ENGINE-BEHAVIOR-REFERENCE.md**

**Goal:** Document the required Notion-side filter change and update the behavior reference with the fix details.

**Requirements:** R1, R4

**Dependencies:** U1-U4

**Files:**
- Modify: `docs/ENGINE-BEHAVIOR-REFERENCE.md`

**Approach:**
- Update Section 11 "Failure modes" table: add a row for the confirmed misconfiguration and its resolution
- Add a changelog entry for 2026-05-14 documenting both the Notion filter fix and the `_replayTrustRef` code change
- Add a subsection under Section 11 documenting the `_replayTrustRef` bypass mechanism as a defense-in-depth layer
- Include exact Notion UI instructions for verifying/fixing the Fill Refs view filter:
  1. Open Study Tasks database → Views → "Fill Refs"
  2. Verify filter includes: `[Do Not Edit] Reference Start Date is empty` AND `[Do Not Edit] Reference End Date is empty` (both must be empty — a task with one populated Reference date is partially bootstrapped and must not be overwritten)
  3. If missing, add the condition — automation should only bootstrap Reference on new tasks where neither Reference date has been set

**Test expectation:** none — documentation-only unit

**Verification:**
- Section 11 failure modes table includes the confirmed misconfiguration
- Changelog entry is present with the fix date and tags

---

## System-Wide Impact

- **Interaction graph:** The `_replayTrustRef` flag travels: replay script → HTTP POST → `handleDateCascade` → `cascadeQueue.enqueue` (raw payload stored) → `processDateCascade` → `parseWebhookPayload` → `classify()`. No other routes or handlers are affected.
- **Error propagation:** No new error paths — the flag is a boolean default-false. If missing or malformed, behavior is identical to today.
- **State lifecycle risks:** None — the flag is transient (lives only in the webhook payload and parsed object). It does not persist to Notion or any other store.
- **API surface parity:** The `processDepEdit` route at `src/routes/dep-edit.js` does not use `classify()` (dep-edit has its own seed-tightening logic), so no parity change needed.
- **Unchanged invariants:** The stale-reference correction remains the default behavior for all non-replay cascades. The three-layer gate posture (Notion filter → cascade-queue front-door → per-handler) is preserved; `_replayTrustRef` adds a gate mechanism within the existing per-handler layer (defense-in-depth bypass for authorized replays).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Notion Fill Refs filter fix requires manual Notion UI work by Tem or Meg | Exact instructions documented in U5; can be done independently of code changes |
| `_replayTrustRef` could be abused by a malicious caller to bypass stale-ref correction | Webhook endpoint requires `x-webhook-secret` auth; any caller with the secret is already trusted |
| Fill Refs fires on triggers other than "Dates is edited" (e.g., "Page added") | The "Page added" trigger is correct for bootstrapping Reference on new tasks; the filter fix only needs to constrain the "Dates is edited" trigger path |
| Replay script bugs on `tem/fix-replay-script-poll-and-formatter` not yet merged | This plan's changes are independent; merge the poll fix separately before running production replays |

---

## Documentation / Operational Notes

- After deploying U1-U4, the replay script will work even with the current (misconfigured) Fill Refs filter
- The Notion filter fix (U5) should still be applied to prevent the race from affecting normal PM cascades (not just replays)
- Operators should verify the Fill Refs filter in the Notion UI before the next replay run
- The `stale_ref_bypass_replay` telemetry event can be used to audit replay runs in Railway logs

---

## Sources & References

- Related code: `src/engine/classify.js:85-138` (stale-ref correction)
- Related code: `src/gates/guards.js:20-110` (parseWebhookPayload)
- Related code: `scripts/replay-dropped-cascades.js:217-230` (synthesizeWebhookPayload)
- Related doc: `docs/ENGINE-BEHAVIOR-REFERENCE.md` Section 11 (Manual Task Support & Reference Date Bootstrap)
- Related learning: `docs/solutions/cascade-queue-gate-position.md` (three-layer gate posture)
- Related plan: `docs/plans/2026-05-12-001-fix-classify-webhook-actor-edit-first-knownbots-fallback-plan.md` (U6 replay)
- Related branch: `tem/fix-replay-script-poll-and-formatter` (commit `c9d4801`, known replay bugs)
