---
title: "refactor: Unify webhook actor classification (person vs bot) across routes and services"
type: refactor
status: draft
date: 2026-04-29
origin: "Meg Apr 29 002 test surfaced `[activity-log] Cannot mention bots: 33723867-…` 400; defensive retry shipped as activity-log bridge fix (this plan = Option B follow-up)"
---

# refactor: Unify webhook actor classification

## Overview

Every route handler today computes `triggeredByUserId` and `editedByBot` flags from incoming Notion webhook payloads, but they do it inconsistently — and two of the three patterns are subtly wrong. When the wrong flag combination escapes upstream, downstream consumers (activity log, study comments) write a bot id into a Notion `people` or `mention.user` field, and Notion 400s with `Cannot mention bots`. The current activity-log defensive retry (PR shipped 2026-04-29) catches this for `TESTED_BY` writes only and at the cost of an entry without sender attribution. Study comment is structurally exposed to the same failure mode and has no defensive retry.

This plan unifies actor classification behind a single helper, audits every callsite, and migrates them. Net result: one definition of "is the actor a real person we can mention?", one source of truth for `triggeredByUserId`/`editedByBot`, and zero bot ids reaching `people` / `mention.user` fields.

The activity-log defensive retry stays in place as a belt-and-suspenders backstop — it costs nothing to keep, and protects against any future webhook shape we haven't seen yet.

---

## Problem Frame

Notion sends button-trigger webhooks (with a `source.user_id` indicating who pressed the button) and property-change webhooks (with `data.last_edited_by` indicating who made the edit). The engine extracts an `actor` from these payloads in three different places, with three different rules:

**Pattern A — Button-trigger routes** (`inception.js:27-28`, `add-task-set.js:113-114`, `migrate-study.js:16-17`, `undo-cascade.js:24-25`, `deletion.js:22-23`):
```js
const triggeredByUserId = body?.source?.user_id || body?.data?.last_edited_by?.id || null;
const editedByBot       = !body?.source?.user_id && body?.data?.last_edited_by?.type === 'bot';
```
Failure mode: when `source.user_id` is itself a bot id (a Notion automation presses the button on a user's behalf, or another integration fires the webhook), `triggeredByUserId` becomes the bot id but `editedByBot` is `false` because the `&&` short-circuits on `!body.source.user_id`. The bot id flows through every downstream guard untouched.

**Pattern B — Property-change routes** (`gates/guards.js:96-97`, consumed by `dep-edit.js`, `date-cascade.js`, `status-rollup.js`, `cascade-queue.js`):
```js
triggeredByUserId: data?.last_edited_by?.id || null,
editedByBot:       data?.last_edited_by?.type === 'bot',
```
Failure mode: if Notion's payload omits or mistypes `last_edited_by.type` (we've seen `type: 'integration'` and missing `type` in production samples for older bot integrations), `editedByBot` is `false` for an actual bot edit. Less common than Pattern A, but the same downstream effect.

**Pattern C — Activity-log defensive retry** (`activity-log.js:178-201`, shipped 2026-04-29):
Catches the symptom (Notion 400 on `people: [{ id: <bot> }]`), strips `TESTED_BY`, retries once. Bridge fix only — does not fix study-comment, does not fix cascade-queue's `editedByBot` guard, does not fix any of the other ~30 callsites that branch on these flags.

### Where this hurts today

1. **Activity log**: Pattern A or B → `properties[TESTED_BY] = { people: [{ id: <bot> }] }` → 400 → defensive retry → entry written without sender, observable via `strippedTestedBy: true`. **Symptom: missing sender attribution on activity log entries.** Cost: one extra round-trip to Notion (~300ms) per cascade fired by an automation.

2. **Study comment** (`study-comment.js:18-19`): Pattern A or B → `mention.user = { id: <bot> }` → 400 → entire study-comment write fails. **No defensive retry exists. The whole comment fails to land.** This is silent today because study-comment failures degrade gracefully on the calling route, but it's a real data-loss path Meg hasn't reported yet because it requires the bot-pressed-button shape.

3. **Cascade queue / status-rollup guards** (`cascade-queue.js:45`, `status-rollup.js:56`, `dep-edit.js:115`, `date-cascade.js:576`): Pattern B can return `editedByBot: false` for an actual bot edit, causing the engine to *not* skip the bot-fired cascade. **Symptom: bot-on-bot loops.** We've seen one variant of this in the 04.11 retro — the existing skip-on-bot guard exists *because* this used to fire. Pattern B's strictness on `type === 'bot'` is the one thing standing between us and that loop.

The three patterns also imply two different mental models of "who triggered this":
- **Pattern A**: "Whoever Notion thinks pressed the button, with last_edited_by as a fallback."
- **Pattern B**: "Whoever Notion last credited as the editor."

Neither directly answers the question downstream consumers actually need: **"Can I write this id into a Notion people/mention field?"** That question has a single correct answer (yes if the user is a real person, no if it's a bot/integration), which is what this plan codifies.

---

## Requirements Trace

- **R1 — Single classifier.** A pure function `classifyWebhookActor(payload)` returns `{ userId, userType, mentionable }` where `userType` is one of `'person' | 'bot' | 'integration' | 'unknown'` and `mentionable` is `true` only when `userType === 'person'`. All callsites use this function. No raw `body?.source?.user_id` / `body?.data?.last_edited_by` parsing in route handlers.
- **R2 — Backward-compatible flag emission.** The classifier returns the existing `{ triggeredByUserId, editedByBot }` shape (alongside the richer `{ userId, userType, mentionable }`) so existing downstream guards continue to work unchanged. `editedByBot` becomes a derived value: `userType !== 'person'`. This is a stricter definition than today's Pattern B (which only flagged `type === 'bot'`); the strictness is the point.
- **R3 — Source priority is configurable per call.** Some routes care about the button-presser (`source.user_id`). Some care about the last editor (`last_edited_by`). The classifier accepts an optional `sourcePriority: 'button-first' | 'edit-first'` parameter, defaulting to `'button-first'` (matches Pattern A's intent). `gates/guards.js` calls with `'edit-first'` to preserve property-change semantics.
- **R4 — Consumers stop guarding `triggeredByUserId` against bots manually.** Activity-log's `if (event.triggeredByUserId && !event.editedByBot)` becomes `if (event.mentionable)`. Study-comment's equivalent guard at line 18-19 becomes the same. The defensive retry in activity-log stays as a backstop — it costs nothing.
- **R5 — Migration is callsite-by-callsite, not big-bang.** Each route's migration is its own commit and its own test pass so a regression is bisectable to a single route. Sequence: classifier helper → activity-log + study-comment (the user-facing 400 callers) → button-trigger routes → property-change routes (via guards.js) → remove the duplicated parsing.
- **R6 — Behavior parity for the common case.** A real person pressing a button must continue to produce `{ mentionable: true, userId: <person-id>, editedByBot: false }`. A property-change edit by a real person via the Notion UI must produce the same. Existing tests in `test/routes/*.test.js` and `test/services/*.test.js` continue to pass without rewriting their assertions on `triggeredByUserId`/`editedByBot`.
- **R7 — Telemetry on classification mismatches.** When the classifier sees a payload that today's Pattern A would have classified differently from the new helper (i.e. `source.user_id` is itself a bot), emit a structured log line `{ event: 'webhook_actor_misclassified', userId, userType, route }`. This gives us an observability signal for how often the bug fires in production once the fix lands. Drop after 30 days if rate is zero.

---

## Scope Boundaries

- **In scope**: ~7 route handlers, `gates/guards.js`, `activity-log.js`, `study-comment.js`, the new classifier helper, classifier tests, callsite tests where parser logic changed, the telemetry log line.
- **Not in scope**:
  - **Notion API version migration to `2025-09-03`**: separate brief. Touches different code (`notion/client.js` headers, query endpoints), different risk profile.
  - **The cascade-queue / status-rollup `editedByBot` guards' business logic**: we change *how* the flag is computed but not *which* routes branch on it. Audit confirms the existing branch points are still correct under the stricter classifier.
  - **`source.automation_id` handling**: Notion 2025 webhooks include an `automation_id` field that distinguishes "human pressed a button" from "automation pressed a button". We don't use it yet. Could supersede this whole helper. Out of scope; deferred until after the 2025 API migration above.
  - **Backfilling activity-log entries that lost their `TESTED_BY` to defensive retry.** Don't bother — they exist, they have `strippedTestedBy: true`, that's enough.
  - **Renaming the flags.** `triggeredByUserId` is a fine name. `editedByBot` is misleading (the new definition is "is non-person", not "was edited by a bot specifically"), but renaming it touches every callsite for cosmetic reasons. Defer to a separate cleanup pass if it ever becomes a real readability problem.

---

## Context & Research

### Relevant Code

**Classification sites (the duplicated logic this plan kills):**
- `engine/src/routes/inception.js:27-28` — Pattern A
- `engine/src/routes/add-task-set.js:113-114` — Pattern A
- `engine/src/routes/migrate-study.js:16-17` — Pattern A
- `engine/src/routes/undo-cascade.js:24-25` — Pattern A
- `engine/src/routes/deletion.js:22-23` — Pattern A
- `engine/src/gates/guards.js:96-97` (`parseWebhookPayload`) — Pattern B (consumed by dep-edit, date-cascade, status-rollup, cascade-queue)

**Consumer sites (the downstream guards):**
- `engine/src/services/activity-log.js:158-159` — `TESTED_BY` people write (defensive retry shipped 2026-04-29)
- `engine/src/services/study-comment.js:18-19` — `@mention` rich text in comment body (no defensive retry)
- `engine/src/services/cascade-queue.js:45` — early-return on bot edits to avoid bot-on-bot loops
- `engine/src/routes/status-rollup.js:54-56` — same skip-on-bot guard, with a longer comment explaining why
- `engine/src/routes/dep-edit.js:115` — same
- `engine/src/routes/date-cascade.js:576` — combined guard with other conditions

**Tests that lock in current behavior (must continue to pass):**
- `engine/test/services/activity-log.test.js` — TESTED_BY presence/absence per person/bot, defensive retry behavior, retry-on-other-400s regression lock
- `engine/test/services/study-comment.test.js` — mention building
- `engine/test/gates/guards.test.js` — parseWebhookPayload shape
- `engine/test/routes/*.test.js` — route-level fixture tests

### Institutional Learnings

- **Activity-log defensive retry (this conversation, 2026-04-29)**: caught the symptom but not the cause. Three new tests in `activity-log.test.js` lock in: retry on bot-mention 400, no retry on unrelated 400s, graceful failure on retry. These tests stay green through this refactor — the defensive retry is preserved.
- **Status-rollup bot-loop comment** (`status-rollup.js:54-56`): documents *why* `editedByBot` matters for cascade flow control. The comment is accurate; the underlying flag has been wrong in some payloads. Stricter classification fixes that without changing the guard's intent.
- **PR #56 withStudyLock + cascade-queue serialization** (`pulse-log/04.14/004`): per-study lock prevents bot-on-bot loops *if* the bot-edit detection works. Pattern B's `type === 'bot'` strictness has been the load-bearing piece preventing this from firing. Don't loosen it; if anything, broaden it (Pattern B's miss-cases get caught by the new helper).
- **Notion 2025 API migration discussion** (this conversation, 2026-04-29): `automation_id` field on webhooks would supersede this whole helper. Acknowledged, deferred — we're on `2022-06-28` for now and this fix has to work on that shape.

### External References

- [Notion API — User object](https://developers.notion.com/reference/user) — `type` field is enumerated: `person`, `bot`. Real-world payloads include cases where the field is missing or carries `integration` (legacy integration tokens). The classifier's `unknown` branch covers these.
- [Notion API — Mention rich text](https://developers.notion.com/reference/rich-text#mention) — explicitly forbids bot ids as mention targets. Same restriction applies to `people` property writes. This is the API-level reason `Cannot mention bots` 400s exist.
- [Notion webhook reference — `source` object](https://developers.notion.com/reference/webhook-events) — `source.user_id` documented as "the user who triggered the event". Not documented: this can be a bot integration's user id when a Notion automation fires a button. Empirical, surfaced via this 400.

---

## Key Technical Decisions

- **The classifier owns the question "can I @mention this id?", not "was the actor a bot?".** The latter is a side effect; the former is what every consumer actually needs. Naming the return field `mentionable` makes the intent of every guard self-documenting.
- **`userType: 'unknown'` is treated as not-mentionable.** Conservative default. If Notion sends a payload without `type`, we don't risk a 400. Worst case: we miss attributing a real person on a malformed payload, which is strictly better than the current behavior of writing a bot id and 400ing.
- **Default `sourcePriority: 'button-first'`.** Matches Pattern A's intent (the button presser is the actor when there is one). `gates/guards.js` opts into `'edit-first'` because for property-change webhooks the `source` block isn't present anyway — the priority parameter is mostly defensive against future webhook shapes that include both.
- **Keep the defensive retry in `activity-log.js`.** It's already shipped, has tests, and protects against any unknown future webhook shape we haven't classified yet. Removing it adds risk for zero gain.
- **Don't rename `editedByBot` in this PR.** Renaming touches every callsite for a cosmetic improvement. The semantic change (now means `userType !== 'person'`) is documented in a comment on the helper. Defer rename to a follow-up if confusion shows up in code review.
- **Telemetry log line, not metric counter.** We don't need long-term metrics for this — we need 30 days of "did the bug stop firing in production after the fix" evidence. A structured log line surfaces in Railway with grep-ability; promote to a metric only if the rate is non-zero after 30 days.

---

## Open Questions

### Resolved during planning

- **Should the classifier live in `gates/guards.js` or its own file?** Its own file (`engine/src/notion/actor-classifier.js`). `guards.js` is already doing too much (date-delta computation, import-mode resolution, payload normalization). New helper is small and pure; deserves its own home next to other notion-shape helpers.
- **Do we change the `editedByBot` definition (which becomes `userType !== 'person'`) or keep it identical to today's `type === 'bot'`?** We change it. The whole point is to catch the cases today's definition misses. The route guards that branch on `editedByBot` (status-rollup, cascade-queue) were already defensive about bot-on-bot loops; broader classification makes them more conservative, not less safe.
- **Defensive retry: keep or remove?** Keep. Already shipped. Costs nothing. Protects against future unknowns.

### Deferred to implementation

- **Where the `'integration'` userType comes from.** Need to grep production logs for actual `last_edited_by.type` values. If `'integration'` shows up, the helper handles it (lumps with bot, not mentionable). If only `'bot'` and `'person'` appear, the `'integration'` branch is dead-code-but-defensive.
- **Whether `parseWebhookPayload` returns the new fields (`userType`, `mentionable`) or just the legacy two (`triggeredByUserId`, `editedByBot`).** Lean toward returning all four — costs nothing, makes downstream guards cleaner. Final decision at implementation.
- **Whether to add a contract test that `if (mentionable === false) then triggeredByUserId is never written to a people/mention field` across the codebase.** Strong appeal — it's the invariant this whole plan exists to enforce. Implementation question is whether it's a static analysis pass (grep for `people: [{ id: ` near `triggeredByUserId`) or a runtime check (assert in tests). Decide at implementation.

---

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```
classifyWebhookActor(payload, { sourcePriority = 'button-first' } = {}):
  body = payload?.body || payload || {}
  source = body?.source
  lastEditedBy = body?.data?.last_edited_by

  // Pick which side of the payload is authoritative.
  primary = sourcePriority === 'button-first' ? source : lastEditedBy
  fallback = sourcePriority === 'button-first' ? lastEditedBy : source

  userId = primary?.user_id || primary?.id || fallback?.user_id || fallback?.id || null
  rawType = primary?.type || fallback?.type || null

  // Classify.
  userType = (
    rawType === 'person' ? 'person' :
    rawType === 'bot' ? 'bot' :
    rawType === 'integration' ? 'integration' :
    userId ? 'unknown' :  // we have an id but no type signal — treat as unknown, not mentionable
    'unknown'
  )

  return {
    userId,
    userType,
    mentionable: userType === 'person' && userId !== null,
    // Backward-compatible legacy fields:
    triggeredByUserId: userId,
    editedByBot: userType !== 'person',
  }

// Consumer pattern (replaces all 7 hand-rolled extractions):
const actor = classifyWebhookActor(body)
if (actor.mentionable) {
  properties[TESTED_BY.id] = { people: [{ id: actor.userId }] }
}
```

---

## Implementation Units

- [ ] **Unit 1: Add `classifyWebhookActor` helper + tests**

**Goal:** Pure function with full behavior coverage; no callsite changes yet.

**Requirements:** R1, R2, R3, R6.

**Dependencies:** None.

**Files:**
- Create: `engine/src/notion/actor-classifier.js`
- Create: `engine/test/notion/actor-classifier.test.js`

**Test scenarios:**
- Person presses button → `{ mentionable: true, userType: 'person', userId, editedByBot: false }`
- Bot integration presses button (`source.user_id` is bot id, `source.type === 'bot'`) → `{ mentionable: false, userType: 'bot', editedByBot: true }`
- Bot presses button but `source.type` missing → falls back to `last_edited_by.type === 'bot'` → still classified bot
- Property-change by person, `sourcePriority: 'edit-first'` → `mentionable: true`
- Property-change by bot, `last_edited_by.type === 'bot'` → `mentionable: false`
- Property-change by legacy integration, `last_edited_by.type === 'integration'` → `mentionable: false, userType: 'integration'`
- Payload with `userId` but no `type` → `userType: 'unknown', mentionable: false`
- Empty payload → `{ userId: null, userType: 'unknown', mentionable: false, triggeredByUserId: null, editedByBot: true }`
- `null`/`undefined` payload → same as empty

**Verification:** `npm run test:ci` passes. Helper has 100% branch coverage.

- [ ] **Unit 2: Migrate `activity-log.js` and `study-comment.js`**

**Goal:** The two services that write user ids into Notion mention/people fields use the new helper. Defensive retry stays.

**Requirements:** R4, R6.

**Dependencies:** Unit 1.

**Files:**
- Modify: `engine/src/services/activity-log.js` (replace `event.triggeredByUserId && !event.editedByBot` with `event.mentionable` once routes pass it; until then, derive from existing flags inline)
- Modify: `engine/src/services/study-comment.js` (same pattern at line 18-19)
- Modify: existing tests to assert `mentionable` flag flows through

**Approach:** Keep the existing `{ triggeredByUserId, editedByBot }` event shape as the parameter signature so caller routes don't need updating yet. Add `mentionable` as an optional event field. If present, prefer it; if not, derive from the legacy flags as today. This decouples Unit 2 from Units 3-4.

**Verification:** Existing activity-log + study-comment tests pass unchanged. New test: pass `mentionable: false` with `triggeredByUserId: <id>` → no people/mention write.

- [ ] **Unit 3: Migrate button-trigger routes**

**Goal:** Five button-trigger routes use `classifyWebhookActor` instead of inline parsing.

**Requirements:** R1, R5, R7.

**Dependencies:** Unit 1.

**Files:** `inception.js`, `add-task-set.js`, `migrate-study.js`, `undo-cascade.js`, `deletion.js` + their tests.

**Approach:** Each route gets its own commit. Replace the two-line extraction with `const actor = classifyWebhookActor(body)`. Pass `actor` (or `actor.mentionable`, depending on what downstream consumers expect post-Unit 2) into `logTerminalEvent` and study-comment calls. Existing tests assert on `triggeredByUserId` / `editedByBot` continue to pass because the legacy fields are still on `actor`.

Add the `webhook_actor_misclassified` log line (R7) when the classifier sees a `source.user_id` that is itself a bot — i.e. when today's Pattern A would have set `editedByBot: false` but the new helper sets `editedByBot: true`.

**Verification:** Each route's existing tests pass. Add one new test per route: "bot integration presses button → activity log entry has no TESTED_BY (or `mentionable: false`); study comment has no @mention; route still completes successfully".

- [ ] **Unit 4: Migrate `parseWebhookPayload` in `gates/guards.js`**

**Goal:** Property-change routes' actor classification flows through the same helper.

**Requirements:** R1, R5, R6.

**Dependencies:** Unit 1.

**Files:** `engine/src/gates/guards.js`, `engine/test/gates/guards.test.js`.

**Approach:** Replace lines 96-97 with `const actor = classifyWebhookActor(payload, { sourcePriority: 'edit-first' })` and spread `actor` into the return object. `dep-edit.js`, `date-cascade.js`, `status-rollup.js`, `cascade-queue.js` see a richer `parsed` object but their existing field reads (`parsed.triggeredByUserId`, `parsed.editedByBot`) are unchanged.

**Verification:** Existing `guards.test.js` passes. Add new test: payload with `last_edited_by.type` missing → `editedByBot: true` (stricter than today's behavior, which would have returned `false`). This is intentional — it's exactly the case that prevents a future bot-on-bot loop from slipping through.

- [ ] **Unit 5: Telemetry — `webhook_actor_misclassified` log line**

**Goal:** Production observability into how often the bug fired before the fix landed.

**Requirements:** R7.

**Dependencies:** Units 3, 4.

**Files:** `engine/src/notion/actor-classifier.js` (or a thin wrapper at each callsite — implementer decides).

**Approach:** When the classifier runs and detects that today's Pattern A or B would have produced a different `editedByBot`, emit one structured JSON log line with `{ event, userId, userType, route, sourcePriority, legacyEditedByBot, newEditedByBot }`. Implementer chooses whether the helper does this directly (cleaner but couples helper to logging) or each callsite passes a `route` label to a wrapper that compares old vs new (more boilerplate but separation of concerns). Lean wrapper.

**Verification:** Test asserts log line is emitted only when classifier disagrees with legacy logic. Fires zero times on person payloads.

- [ ] **Unit 6: Sweep verification + remove duplicated parsing**

**Goal:** Confirm no remaining inline `body.source.user_id || body.data.last_edited_by.id` extractions outside the helper.

**Requirements:** R5.

**Dependencies:** Units 3, 4.

**Files:** Repository-wide grep + delete.

**Approach:**
```bash
rg "source\?.user_id" src/  # should match only actor-classifier.js
rg "last_edited_by\?.type" src/  # same
```

Any remaining matches are either (a) the helper itself, (b) a missed callsite (fix), or (c) a legitimately different consumer of these fields (document why).

**Verification:** `npm run test:ci` passes. Grep returns only the classifier module.

---

## Risks

- **R1: New stricter `editedByBot` definition causes a previously-allowed cascade to skip.** Today's Pattern B only flags `type === 'bot'`. The new helper also flags `'integration'` and `'unknown'`. If a route was relying on `'integration'` payloads to *not* be classified as bot, the cascade for that route would now skip incorrectly. Mitigation: Unit 4's new test pins this behavior. Production dry-run: enable Unit 5's telemetry first, verify zero `'integration'` / `'unknown'` payloads in real traffic before shipping Units 3-4.
- **R2: `sourcePriority: 'edit-first'` for guards.js drops button-press attribution on a property-change webhook that happens to also have a `source` block.** Current Pattern B doesn't read `source` at all, so this is a strict superset of today's behavior. No regression risk; just confirming the parameter does what we want.
- **R3: Defensive retry stays, but its trigger condition (the bot-mention 400) should approach zero after this fix lands.** If we still see `strippedTestedBy: true` results in production after 30 days, the helper has a gap. Mitigation: Unit 5's telemetry tells us the rate ahead of time; we ship the fix only when we believe it's complete.
- **R4: study-comment is the higher-stakes write and has no existing defensive retry.** If a regression in Unit 2's migration breaks study-comment, the symptom is silent (graceful failure on the route). Mitigation: explicit test that asserts study-comment writes succeed for bot-pressed buttons (the comment lands without the bot @mention; still useful).

---

## Sequencing & estimate

Each unit is its own commit. Suggested order:

1. **Unit 1** (helper + tests) — half-day. Standalone, mergeable on its own with zero behavioral impact.
2. **Unit 5** (telemetry) — quarter-day. Ship with Unit 1 to start collecting baseline data.
3. **Wait 1-3 days** for telemetry to confirm the misclassification rate.
4. **Unit 2** (consumers) — half-day. Activity-log + study-comment migrate.
5. **Units 3, 4** (callsite migration) — half-day each, can parallelize across two PRs if we want.
6. **Unit 6** (sweep) — quarter-day.

Total: ~2.5 dev-days spread over ~1 week. The wait in step 3 is the value-multiplier — it prevents shipping a fix for a problem that only fires once a month and getting surprised in a different way.

---

## What this plan does NOT close out

- The Notion API version migration to `2025-09-03` (separate brief; required to take advantage of `automation_id` and to fully resolve the original `STUDY_TASKS_DB_ID` 404 surface area at the API layer rather than the permissions layer).
- The cosmetic rename of `editedByBot` → `actorIsBot` or similar. Defer.
- Any backfill of activity-log entries that lost their `TESTED_BY` to defensive retry between 2026-04-29 and the day this lands. Don't bother.
