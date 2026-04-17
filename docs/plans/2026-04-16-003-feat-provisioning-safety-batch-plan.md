---
title: "feat: Provisioning safety batch — empty-date guard, single-leaf duplicate guard, Manual Workstream tag, generalized error mentions"
type: feat
status: active
date: 2026-04-16
origin: engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md
---

# PR D — Provisioning Safety Batch

## Overview

Four related safety improvements on the button-triggered provisioning routes, plus generalized error-comment mentions. All touch `engine/src/routes/{inception,add-task-set}.js`, `engine/src/provisioning/create-tasks.js`, and `engine/src/services/study-comment.js`:

1. **Fail-loud on empty Contract Sign Date** at every creation entry point (removes 3 silent-today fallbacks).
2. **Single-leaf duplicate guard** on `add-task-set.js` so a second click on a single-leaf non-repeat template doesn't silently create a duplicate.
3. **"Manual Workstream / Item" tag** added to every task created by the 4 Additional TLF buttons, via an `extraTags` param plumbed through `createStudyTasks` into `buildTaskBody` (no post-create PATCH loop).
4. **Generalized error-comment mentions** on button-triggered routes: auto-prepend the button presser's `triggeredByUserId` to the configured `COMMENT_ERROR_MENTION_IDS`, with dedup, bot carve-out, and null-safe behavior.

## Problem Frame

Addresses four of the five items in Meg's 2026-04-16 live-test batch:

- **Item 1 (duplicate task)** — investigation showed the orphaned `Delivery Retrieval Wrap-Up Window 10` duplicate was created by a second click on the Final Delivery Retrieval Wrap-Up Window add-task-set button. `add-task-set.js:280-300` strips existing template IDs before creation, which is correct for numbered sets (TLF #2/#3) but silently duplicates single-leaf non-repeat templates.
- **Item 4 (empty Contract Sign Date)** — three code paths fall back silently to today when Contract Sign Date is empty: [inception.js:74-75](engine/src/routes/inception.js:74), [add-task-set.js:172-173](engine/src/routes/add-task-set.js:172), [create-tasks.js:215](engine/src/provisioning/create-tasks.js:215). Silent anchoring to today produces wrong dates across the whole study. Tem's decision: empty + fail-loud.
- **Item 5 (Manual Workstream / Item tag)** — the 4 Additional TLF buttons should tag every task they create with the "Manual Workstream / Item" multi-select tag (id `79520630-ac48-45c6-913d-2c29d28eb6fa`). Today no engine code references this tag; tags flow only via blueprint-copying.
- **Item 4 R4e (generalized error mentions)** — [study-comment.js](engine/src/services/study-comment.js) posts error comments mentioning `COMMENT_ERROR_MENTION_IDS` (Tem + Meg + Seb). The PR generalizes this to also mention the button presser. With three sub-requirements from document-review: dedup against the configured list, skip when `editedByBot`, null-safe when `triggeredByUserId` is absent.

## Requirements Trace

| Requirement (see origin) | Unit |
|---|---|
| R1b — single-leaf duplicate guard | Unit 3 |
| R4b — remove silent "today" fallback in 3 routes | Unit 2 |
| R4c — abort with Automation Reporting write + study-page comment | Unit 2 |
| R4d — specific error-comment body | Unit 2 |
| R4e — generalized error-comment mention-prepend | Unit 1 |
| R4e-dedup — dedup presser against configured mentions | Unit 1 |
| R4e-bot-carveout — skip prepend when `editedByBot` | Unit 1 |
| R4e-null-safe — skip prepend when `triggeredByUserId` absent | Unit 1 |
| R5-1 — Manual Workstream / Item tag applied by 4 TLF buttons | Unit 4 |
| R5-2 — `extraTags` param injection point (no post-create PATCH loop) | Unit 4 |
| R5-3 — tag NOT applied to repeat-delivery, additional-site, inception | Unit 4 |
| Test rewrite — `inception.test.js:588-619` rewritten to assert abort | Unit 2 |

Satisfies origin success criteria **SC-1** (empty date → error), **SC-2** (TLF tag on all tasks), **SC-4** (single-leaf duplicate blocked), **SC-6** (existing tests + rewritten fallback test pass).

## Scope Boundaries

- **No change** to date-cascade, status-rollup, deletion, undo-cascade routes beyond the R4e study-comment generalization (which they inherit naturally since they already call `postComment`).
- **No change** to existing `COMMENT_ERROR_MENTION_IDS` env var contents.
- **No change** to success-path comment behavior — still suppressed per PR #58.
- **No change** to the `Automation Reporting` field semantics.
- **No change** to the `applyDeliveryNumbering` rename logic, `latestDates` lookup, or repeat-delivery behavior — that's PR C.
- **No change** to cascade engine functions, `runCascade`, or any date-shift semantics — that's PR B.
- **No change** to blueprint data or Notion workspace structure.
- **No backfill or audit** of existing studies' Contract Sign Date values — per Tem, all studies in pre-production testing mode.
- **No new feature flags.** Behavior ships immediately per Railway auto-deploy. Acceptable because pre-production.
- **No additional Notion API round-trips** for tag injection. `extraTags` merges at body-build time, not post-create PATCH.

## Context & Research

### Relevant Code and Patterns

- `engine/src/services/study-comment.js:7-27` — `buildRichText(event)` reads `config.comment.errorMentionIds`, prepends each as `{type: 'mention', mention: {type: 'user', user: {id}}}`, appends `❌ ${summary}`. Tests at `engine/test/services/study-comment.test.js` use `vi.hoisted` + `vi.mock('../../src/config.js', ...)` pattern.
- `engine/src/services/study-comment.js` — the `event` object already carries `triggeredByUserId` and `editedByBot` from callers. No new plumbing needed for Unit 1.
- `engine/src/config.js:33-38` — current `config.comment.errorMentionIds` shape: comma-split, trimmed, empty-filtered. Same pattern for any new env var.
- `engine/src/routes/inception.js:39` (sets Import Mode), `:74-75` (Contract Sign Date fallback), `:144` (calls `createStudyTasks`), `:269-272` (finally block, resets Import Mode) — the end-to-end provisioning flow in inception.
- `engine/src/routes/add-task-set.js:127` (sets Import Mode), `:168` (reads `existingTasks` pre-creation), `:172-173` (Contract Sign Date fallback), `:245` (applyDeliveryNumbering), `:280-300` (`internalTemplateIds` strip from `existingIdMapping`), `:375` (calls `createStudyTasks`), `:540-547` (finally block, resets Import Mode), `:556` (`withStudyLock` per-study serialization).
- `engine/src/provisioning/create-tasks.js:82-108` — `buildTaskBody`. Line 82 reads `const tags = props['Tags']?.multi_select || [];` from blueprint; line 108 writes merged tags into page body. Unit 4 adds `extraTags` merging here.
- `engine/src/provisioning/create-tasks.js:212-215` — `createStudyTasks(client, levels, { studyPageId, contractSignDate, ... })` signature. Unit 2 removes the `|| new Date()` fallback; Unit 4 adds `extraTags` param.
- `engine/src/notion/clients.js` — `commentClient` (post comments via provisioning tokens) vs `cascadeClient`, `provisionClient`, `deletionClient`. Confirmed: study-comment posts via `commentClient`.
- `engine/test/routes/inception.test.js:588-619` — the existing "falls back to today" test that Unit 2 rewrites.

### Institutional Learnings

- **PR #57 (`clients/picnic-health/pulse-log/04.14/005-button-user-attribution-fix.md`)** — `source.user_id` is the correct field for button-presser attribution, NOT `data.last_edited_by.id`. `triggeredByUserId` is already plumbed correctly.
- **PR #58 (`pulse-log/04.15/002-post-call-batch-session.md`)** — errors-only comment flow with env-configurable mentions. Unit 1 extends this with dedup/bot/null-safety.
- **PR #48 (`pulse-log/04.14/001-import-mode-and-activity-log-fixes.md`)** — three-path Import Mode cleanup discipline. Unit 2's empty-date abort MUST route through the existing `finally` blocks so Import Mode gets reset. Do not add a duplicate cleanup site — use the existing one.
- **PR #52 (`pulse-log/04.14/002-task-set-numbering-fix.md`)** — pre-creation data is the correct source for counts/guards. Unit 3's duplicate guard uses `existingTasks` already fetched at `add-task-set.js:168`, not a fresh query (eventual consistency ate results last time).
- **PR #56 (`pulse-log/04.14/004-add-task-set-serialization.md`)** — `withStudyLock` serializes same-study add-task-set operations. Unit 3's guard runs inside the lock, so no double-abort races.
- **Rate-limit constraint** — engine NotionClient runs at 9 req/s per token × multiple tokens (not the legacy 3 req/s). Post-create PATCH loops for tag injection would fan out Notion retries on 14+ tasks under concurrency. Unit 4 avoids this by merging `extraTags` into the create body.

### External References

None. Local patterns are strong.

## Key Technical Decisions

- **`extraTags` as array of strings (names only), not ids.** Notion multi_select accepts `{ name }` references; tags are auto-created if missing (though "Manual Workstream / Item" already exists). Simpler call-site: `extraTags: ['Manual Workstream / Item']`.
- **Merge by name uniqueness in `buildTaskBody`.** Combine blueprint `tags.map(t => ({ name: t.name }))` + `extraTags.map(name => ({ name }))`, dedup by name. Notion ignores duplicates server-side but client-side dedup keeps the payload clean.
- **Dedup mention list in `buildRichText`.** Build a `Set<string>` of user IDs from `{triggeredByUserId}` prepended to `errorMentionIds`, filter out falsy/null, emit mentions in set order. Guarantees each user mentioned exactly once.
- **Bot carve-out via `event.editedByBot`.** The event shape already carries this flag (populated by callers). In `buildRichText`, if `editedByBot === true`, skip the `triggeredByUserId` prepend. Configured IDs still fire.
- **Null-safe via falsy filter.** `if (!event.triggeredByUserId) skip prepend`. Same gate as bot carve-out path. Plain `if` check, not truthiness gymnastics.
- **Fail-loud abort routes through existing study-comment.** Build the event (status=`failed`, summary=`"Cannot activate / add task set — Contract Sign Date is empty. Please set it on the study page and try again."`, workflow, triggeredByUserId, editedByBot) and call `studyCommentService.postComment(event)`. The comment flow already posts to the study page and writes Automation Reporting via the existing pattern (actually — only Activity Log writes to AR; comment goes through `commentClient`. Verify `reportStatus` also called on abort path per three-path cleanup discipline).
- **Abort runs through existing `finally` blocks.** Do not add a separate cleanup site. At the empty-date check point, throw or early-return into the existing catch/finally so Import Mode resets as it does on any other error.
- **Guard ordering in add-task-set.js.** Check empty Contract Sign Date (Unit 2) *first*, before the single-leaf duplicate guard (Unit 3), because the duplicate check requires a valid contractSignDate to compute future dates (even if it's just for error-message context).
- **Duplicate guard uses pre-creation `existingTasks`.** No fresh Notion query. PR #52 established this pattern.
- **Single-leaf non-repeat detection:** the filtered subtree contains a single template AND `buttonType` is not in the set `{repeat-delivery}`. Any of the 4 Additional TLF buttons, `additional-site`, or any new single-leaf button type that may exist would be subject to the guard. The guard key is "single-leaf + not-repeat," not hardcoded to specific button types.
- **Test rewrite (not augment) of `inception.test.js:588-619`.** The existing test asserts behavior PR D removes. Rewrite the same `it()` to assert the abort path: `createStudyTasks` NOT called, `studyCommentService.postComment` called with the empty-date summary, `reportStatus` called with failure, Import Mode reset.

## Open Questions

### Resolved During Planning

- **Whether empty-date check lives in `inception.js` / `add-task-set.js` only, or also in `create-tasks.js`:** Both. Remove the `|| new Date()` fallback at `create-tasks.js:215` (defense in depth — if any future caller forgets the route-level guard, the provisioning layer refuses). But the user-facing abort happens at the route level (which can post the comment); `create-tasks.js` just throws if called with undefined `contractSignDate`. Route catches and routes through normal error flow.
- **Whether `extraTags` flows from `inception.js` too:** No. Inception always passes empty array (or omits the param — default `[]`). The "original TLF subtree from inception should not be tagged" rule (origin R5-3) is enforced at the inception call-site: `createStudyTasks(client, levels, { ...options, extraTags: [] })`.
- **Whether dedup in `buildRichText` should also remove duplicate mentions in the configured list itself:** Yes. The `Set`-based dedup naturally handles this — if `COMMENT_ERROR_MENTION_IDS` accidentally has a duplicate (e.g., Tem's ID listed twice by env config error), it emits once.
- **Whether abort should write Automation Reporting:** Yes, via `reportStatus(... 'failed', ...)` on the existing path (same as any other error). The comment is the added channel; AR remains the machine-readable log.
- **Whether the single-leaf guard short-circuits numbered task sets (TLF #2/#3, etc.):** No. Numbered sets have multiple templates in the filtered subtree, so the "single-leaf" detection fails → guard skipped → existing strip behavior runs. Only pure single-leaf non-repeat cases trigger the guard.

### Deferred to Implementation

- **Exact wording of error-comment body** — origin R4d specifies "Cannot activate / add task set — Contract Sign Date is empty. Please set it on the study page and try again." Keep exact; adjust at implementation if Meg/Tem want a tweak.
- **Whether to add a config env var for dedup behavior** — defer. Dedup is a pure-logic fix; no need for a toggle.
- **Whether to emit a new Activity Log event distinguishing "aborted due to empty date" from generic failure** — defer. `reportStatus` with the failure summary is enough for pre-production.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

**Unit 1 — `buildRichText` with dedup + bot + null-safe:**

```
buildRichText(event):
  if event.status !== 'failed':
    return null   (existing behavior)

  mentionIds = []
  if event.triggeredByUserId and not event.editedByBot:
    mentionIds.push(event.triggeredByUserId)
  mentionIds.push(...config.comment.errorMentionIds)

  uniqueIds = new Set(mentionIds).filter(id => id)

  richText = []
  for each id in uniqueIds:
    push { type: 'mention', mention: { type: 'user', user: { id } } }
    push { type: 'text', text: { content: ' ' } }
  push { type: 'text', text: { content: `❌ ${summary}` } }

  return richText
```

**Unit 2 — fail-loud abort path (inception / add-task-set):**

```
processInception(body):
  try:
    setImportMode(true)
    contractSignDate = studyPage.properties['Contract Sign Date'].date?.start
    if !contractSignDate:
      event = { status:'failed', workflow:'inception', summary:'Cannot activate — Contract Sign Date is empty. ...', studyId, triggeredByUserId, editedByBot }
      await Promise.all([
        reportStatus(event),                            [existing]
        activityLogService.logTerminal(event),          [existing]
        studyCommentService.postComment(event),         [existing, picks up Unit 1 improvements]
      ]).catch(...)
      return
    ... rest of flow ...
  finally:
    setImportMode(false)                                [existing]
```

Same shape in `processAddTaskSet`. `create-tasks.js:215` simply throws when `contractSignDate` is falsy (defense in depth).

**Unit 3 — single-leaf duplicate guard:**

```
processAddTaskSet(body):
  ... existing checks ...
  existingTasks = ...                                    [existing, line 168]
  filteredLevels = filterBySubtree(...)                  [existing]

  if isSingleLeafNonRepeat(filteredLevels, buttonType):
    templateId = filteredLevels[0].tasks[0].templateId
    if existingTasks.some(t => t.templateId === templateId):
      event = { status:'failed', workflow:'add-task-set', summary:`Cannot add this task — '${existingName}' already exists in this study.`, ... }
      await Promise.all([reportStatus, activityLog, studyComment]).catch(...)
      return

  ... rest of flow (existingIdMapping strip, createStudyTasks, etc.) ...
```

**Unit 4 — extraTags flow:**

```
processAddTaskSet → createStudyTasks(... , extraTags: isAdditionalTlfButton(buttonType) ? ['Manual Workstream / Item'] : [])
createStudyTasks → for each task, buildTaskBody(task, { ..., extraTags })
buildTaskBody:
  tags = blueprint['Tags']?.multi_select || []
  merged = dedup by name: [...tags.map(t=>({name:t.name})), ...extraTags.map(n=>({name:n}))]
  if merged.length > 0: pageBody.properties['Tags'] = { multi_select: merged }
```

## Implementation Units

- [ ] **Unit 1: Dedup + bot carve-out + null-safe in `study-comment.js`**

**Goal:** Generalize the error-comment mention-prepend pattern safely for all button-triggered routes.

**Requirements:** R4e, R4e-dedup, R4e-bot-carveout, R4e-null-safe.

**Dependencies:** None. Standalone.

**Files:**
- Modify: `engine/src/services/study-comment.js`
- Modify: `engine/test/services/study-comment.test.js`

**Approach:**
- In `buildRichText`, before the existing `errorMentionIds` loop, branch on `event.triggeredByUserId` + `event.editedByBot`:
  - If `triggeredByUserId` is present AND `editedByBot` is not true: prepend `triggeredByUserId` to the mention list source.
  - Otherwise: skip prepend; use configured list only.
- Dedup the combined list via `new Set()` before emitting mentions.
- Emit each unique ID as a `{type: 'mention'}` followed by a `{type: 'text', text: {content: ' '}}` spacer (same pattern as today).
- Append the existing `❌ ${summary}` text at the end (unchanged).
- Keep the `status !== 'failed'` early return (post-PR #58 behavior).

**Patterns to follow:**
- `engine/src/services/study-comment.js:7-27` existing `buildRichText` structure.
- `engine/test/services/study-comment.test.js` — `vi.hoisted` + `vi.mock` config mocking pattern.

**Test scenarios:**
- **Happy — triggered by non-configured user:** `triggeredByUserId = 'user-X'`, `errorMentionIds = ['A','B','C']`. Mentions emitted in order: `X, A, B, C`. All four distinct.
- **Happy — triggered by configured user (dedup):** `triggeredByUserId = 'A'`, `errorMentionIds = ['A','B','C']`. Mentions emitted: `A, B, C`. No double-mention.
- **Edge — bot-triggered:** `triggeredByUserId = 'bot-id'`, `editedByBot = true`, `errorMentionIds = ['A','B']`. Mentions emitted: `A, B`. Bot ID skipped. Summary still posts.
- **Edge — null/undefined triggeredByUserId:** `triggeredByUserId = null` or `undefined`, `errorMentionIds = ['A','B']`. Mentions emitted: `A, B`. No crash. Single test covers both via a parameterized check.
- **Edge — empty `errorMentionIds`:** `triggeredByUserId = 'X'`, `errorMentionIds = []`. Mentions emitted: `X`. Summary still posts.
- **Edge — both empty:** `triggeredByUserId = null`, `errorMentionIds = []`. No mentions emitted. Summary text still posts alone.
- **Edge — status is `'no_action'`:** returns null (existing early-return). No regression.
- **Edge — duplicate entries in `errorMentionIds`:** `errorMentionIds = ['A','A','B']`, `triggeredByUserId = null`. Mentions emitted: `A, B`. Dedup handles malformed env vars.

**Verification:**
- `npm run test:ci` passes; all 9 new scenarios green.
- Code review confirms no breaking changes to `postComment` signature.
- Manual test: post a comment from an inception abort path (via Unit 2 once it lands) with Tem as presser — confirm Tem not double-mentioned.

- [ ] **Unit 2: Fail-loud on empty Contract Sign Date**

**Goal:** Remove silent "today" fallbacks at all 3 code sites; route abort through the existing error pattern.

**Requirements:** R4b, R4c, R4d.

**Dependencies:** Unit 1 (so the comment routes through improved mention list).

**Files:**
- Modify: `engine/src/routes/inception.js` (lines ~74-75, ~130-150 for abort routing)
- Modify: `engine/src/routes/add-task-set.js` (lines ~172-173, abort routing around the Promise.all error pattern)
- Modify: `engine/src/provisioning/create-tasks.js` (line ~215)
- Modify: `engine/test/routes/inception.test.js` (rewrite the existing test at lines 588-619)
- Modify: `engine/test/routes/add-task-set.test.js` (new test for add-task-set abort path)
- Test: `engine/test/provisioning/create-tasks.test.js` (if exists; otherwise add basic throws-on-empty-contractSignDate check)

**Approach:**
- **`inception.js:74-75`** — replace `const contractSignDate = studyPage.properties?.['Contract Sign Date']?.date?.start || new Date().toISOString().split('T')[0];` with just the nullable read. Immediately after, check `if (!contractSignDate) { ... abort ... return; }`.
- Abort pattern mirrors the existing early-failure paths in the same route:
  - Build event with `status:'failed'`, `workflow:'inception'`, summary `"Cannot activate — Contract Sign Date is empty. Please set it on the study page and try again."`, `studyId`, `sourceTaskName` (study name), `triggeredByUserId`, `editedByBot`.
  - `await Promise.all([reportStatus(...), activityLogService.logTerminal(...), studyCommentService.postComment(event)]).catch(...)`.
  - `return` (fall through to `finally` block for Import Mode reset).
- **`add-task-set.js:172-173`** — same pattern. Replace `|| new Date()...` with the nullable read + empty check. Summary: `"Cannot add task set — Contract Sign Date is empty. Please set it on the study page and try again."` Workflow: `'add-task-set'`.
- **`create-tasks.js:215`** — guard first, parse second: `if (!contractSignDate) throw new Error('createStudyTasks: contractSignDate is required'); const anchorDate = parseDate(contractSignDate);`. Order matters — `parseDate(null)` returns `null` without throwing, so an inverted order would silently proceed with `anchorDate = null` and produce NaN dates downstream. (Defense in depth — callers should have checked, but provisioning layer refuses to anchor against `undefined`.)
- Verify abort path exits via the existing `finally` block so Import Mode resets. Route-level `try { ... abort ...; return; } finally { importMode=false }`.
- **Rewrite `inception.test.js:588-619`**: the existing `it('falls back to today when study has no Contract Sign Date', ...)` should become `it('aborts when study has no Contract Sign Date and posts a study-page comment', ...)`. Assert: `createStudyTasks` NOT called; `studyCommentService.postComment` called with `status:'failed'` + the empty-date summary; `reportStatus` called with `'failed'`; `setImportMode` called with `false` after the abort (finally ran).
- Add similar test in `add-task-set.test.js`.

**Patterns to follow:**
- Existing early-failure `Promise.all([reportStatus, activityLog, studyComment])` pattern at `inception.js:90-98`, `add-task-set.js:189-197`.
- Three-path Import Mode cleanup discipline from PR #48 (`pulse-log/04.14/001-import-mode-and-activity-log-fixes.md`).

**Test scenarios:**
- **Happy — Contract Sign Date present:** inception/add-task-set run normally. No regression on existing success-path tests.
- **Edge — empty Contract Sign Date on inception:** `createStudyTasks` NOT called; study-page comment posted mentioning Tem+Meg+Seb+presser (deduped); Import Mode reset; Activity Log entry with `status:'failed'`.
- **Edge — empty Contract Sign Date on add-task-set:** same shape, workflow = `'add-task-set'`.
- **Edge — `create-tasks.js` called directly with `contractSignDate = undefined`** (e.g., a future misbehaving caller): throws. Defense-in-depth.
- **Edge — Import Mode reset on abort:** mock the `finally` flow; assert Import Mode PATCHed to false even when abort fires.
- **Edge — abort when `triggeredByUserId` is null:** comment still posts, configured mentions still fire.
- **Edge — abort when `editedByBot` is true:** comment posts, bot not mentioned.
- **Regression — rewritten `inception.test.js:588-619`:** asserts abort behavior. Does NOT assert old "falls back to today" behavior.

**Verification:**
- `npm run test:ci` passes.
- `grep -rn "new Date().toISOString" engine/src/routes/inception.js engine/src/routes/add-task-set.js engine/src/provisioning/create-tasks.js` returns no matches (all fallbacks gone).
- Manual test in a scratch study: create a Studies DB record with empty Contract Sign Date, click Activate → expect error comment tagging self+Tem+Meg+Seb, no tasks created, Import Mode reset.

- [ ] **Unit 3: Single-leaf duplicate guard in `add-task-set.js`**

**Goal:** Abort add-task-set when the filtered subtree is a single non-repeat template that already exists in the study.

**Requirements:** R1b.

**Dependencies:** Unit 1 (so the comment routes through improved mention list); Unit 2 (so the abort pattern is established and both units can use it identically).

**Files:**
- Modify: `engine/src/routes/add-task-set.js` (insert guard after the Contract Sign Date check from Unit 2, before the `internalTemplateIds` strip at line 280–300)
- Modify: `engine/test/routes/add-task-set.test.js`

**Approach:**
- **Place the guard AFTER the `existingIdMapping` construction (currently around line 288) and BEFORE the `internalTemplateIds` strip (currently around line 298).** This lets the guard reuse the already-built map instead of scanning raw Notion pages.
- After `filteredLevels` is computed and `existingIdMapping` is built, detect single-leaf non-repeat:
  - `isSingleLeaf = filteredLevels.length === 1 && filteredLevels[0].tasks.length === 1`
  - `isRepeat = buttonType === 'repeat-delivery'`
  - `guardActive = isSingleLeaf && !isRepeat`
- If `guardActive`:
  - `const templateId = filteredLevels[0].tasks[0]._templateId;` — note the leading underscore, matches `blueprint.js:41` where `parseTask` assigns `_templateId: page.id`.
  - `const existingProductionPageId = existingIdMapping[templateId];` — O(1) lookup.
  - If `existingProductionPageId` is truthy:
    - To build a useful error message, look up the existing task's name by scanning `existingTasks` for the matching `page.id`: `const existingPage = existingTasks.find(p => p.id === existingProductionPageId); const existingName = existingPage?.properties?.['Task Name']?.title?.[0]?.plain_text ?? 'this task';`.
    - Build an event with `status:'failed'`, `workflow:'add-task-set'`, summary `"Cannot add '${existingName}' — it already exists in this study."`, `studyId`, `triggeredByUserId`, `editedByBot`.
    - Abort via the same `Promise.all([reportStatus, activityLog, studyComment]).catch(...)` + `return` pattern as Unit 2.
- Runs inside `withStudyLock` (already wrapping the whole route handler at `add-task-set.js:570-577`) — no extra serialization.
- Uses pre-creation `existingTasks` + `existingIdMapping` — no re-query (per PR #52).

**Patterns to follow:**
- Unit 2's abort pattern (identical shape).
- PR #52 pre-creation data pattern.

**Test scenarios:**
- **Happy — single-leaf non-repeat, template not in study:** guard doesn't fire; normal add-task-set flow runs; task is created.
- **Happy — numbered task set (TLF #2):** `filteredLevels` has multiple tasks; `isSingleLeaf = false`; guard doesn't fire; existing strip-before-create logic runs; duplicate creation works as today.
- **Happy — repeat-delivery:** `buttonType === 'repeat-delivery'`; `isRepeat = true`; guard doesn't fire; existing logic runs.
- **Edge — single-leaf non-repeat, template already exists:** guard fires. No tasks created. Comment posted. Import Mode reset. Activity Log `status:'failed'` with descriptive summary mentioning the existing task's name.
- **Edge — single-leaf non-repeat, templateId of the blueprint row differs from the existing task's templateId** (unusual case — could happen if blueprint was remapped): guard doesn't fire (no matching templateId). Normal flow creates the new task. Consistent with PR #18's emphasis on template-ID identity.
- **Edge — multiple existing tasks with same templateId in study** (hypothetical malformed state): guard still fires on the first match; summary names the first found existing task.
- **Regression — all existing add-task-set tests pass unchanged.**

**Verification:**
- `npm run test:ci` passes.
- Manual test in a scratch study: inception creates a study with the single-leaf template already in it. Click the corresponding Add Task Set button on the study page a second time → expect error comment, no duplicate task.
- Confirm the orphaned page `34423867-60c2-815b-afa6-e9890a23c405` from Meg's Apr 16 test can be recreated by the same action (as a verification of the guard's trigger path), then archive again.

- [ ] **Unit 4: `extraTags` plumb + Manual Workstream / Item tag injection**

**Goal:** Add the "Manual Workstream / Item" tag to every task created by the 4 Additional TLF buttons, without post-create PATCH loops.

**Requirements:** R5-1, R5-2, R5-3.

**Dependencies:** None. Standalone.

**Files:**
- Modify: `engine/src/provisioning/create-tasks.js` (signature of `createStudyTasks` + `buildTaskBody`)
- Modify: `engine/src/routes/add-task-set.js` (call site — compute `extraTags` from `buttonType`)
- Modify: `engine/src/routes/inception.js` (call site — pass `extraTags: []` explicitly for clarity)
- Modify: `engine/test/provisioning/create-tasks.test.js`
- Modify: `engine/test/routes/add-task-set.test.js`
- Modify: `engine/test/routes/inception.test.js`

**Approach:**
- Extend `createStudyTasks(client, levels, options)` options to accept `extraTags: string[]` (default `[]`).
- Thread `extraTags` through to every `buildTaskBody(task, { ..., extraTags })` call inside the iteration loop.
- In `buildTaskBody` (around line 82-108):
  - After reading `const tags = props['Tags']?.multi_select || [];`, build the merged list:
    - `const blueprintNames = tags.map(t => t.name);`
    - `const merged = [...new Set([...blueprintNames, ...extraTags])].map(name => ({ name }));`
  - Replace the existing `pageBody.properties['Tags'] = ...` block to use `merged`:
    - `if (merged.length > 0) { pageBody.properties['Tags'] = { multi_select: merged }; }`
- In `add-task-set.js` at the `createStudyTasks` call:
  - `const isAdditionalTlfButton = ['tlf-only','tlf-csr','tlf-insights','tlf-insights-csr'].includes(buttonType);`
  - `const extraTags = isAdditionalTlfButton ? ['Manual Workstream / Item'] : [];`
  - Pass `extraTags` in the options bag to `createStudyTasks`.
- In `inception.js`, pass `extraTags: []` explicitly at the call site for clarity (not strictly required — the default is `[]` — but it documents intent at the call-site that inception doesn't tag).

**Patterns to follow:**
- Existing `options` bag threading in `createStudyTasks` (studyPageId, contractSignDate, etc.).
- `buildTaskBody`'s existing tag merging via `{ name }` reference form (no tag IDs needed).

**Test scenarios:**
- **Happy — TLF-only button:** `buttonType='tlf-only'`. Every created task's `Tags` property includes `{ name: 'Manual Workstream / Item' }` PLUS whatever blueprint tags were there.
- **Happy — TLF+CSR, TLF+Insights, TLF+Insights+CSR:** same behavior. Every task tagged.
- **Happy — repeat-delivery:** no tag added. Tasks have only blueprint-derived tags.
- **Happy — additional-site:** no tag added. Same.
- **Happy — inception:** no tag added. Original TLF subtree from inception has no Manual Workstream tag (confirming R5-3).
- **Edge — blueprint tag coincides with `extraTags`:** if blueprint already had "Manual Workstream / Item" on some task (unlikely but possible), the merged tag list still has it exactly once (Set dedup).
- **Edge — empty blueprint tags + non-empty `extraTags`:** merged list is just `[{ name: 'Manual Workstream / Item' }]`. Tags property set.
- **Edge — empty blueprint tags + empty `extraTags`:** no Tags property emitted (existing guard `if (merged.length > 0)`).
- **Integration — full TLF+Insights+CSR subtree of ~14 tasks:** every task in the subtree has the tag. No extra Notion PATCH calls beyond the create.

**Verification:**
- `npm run test:ci` passes.
- Manual test: click each of the 4 Additional TLF buttons on a scratch study. Verify every created task shows the "Manual Workstream / Item" tag in Notion.
- Manual test: click repeat-delivery and additional-site. Verify no Manual Workstream / Item tag on created tasks.
- Manual test: fresh inception on a test study. Verify no Manual Workstream / Item tag on any inception-created task.

## System-Wide Impact

- **Interaction graph:**
  - Unit 1 touches `study-comment.js`, called by date-cascade, status-rollup, inception, add-task-set, deletion, undo-cascade. All benefit from dedup + bot + null-safe automatically.
  - Unit 2 touches inception / add-task-set / create-tasks — creation entry points only. Cascade routes don't use Contract Sign Date at runtime (dates are read from tasks).
  - Unit 3 touches add-task-set only. Inception's double-inception guard is different and already exists.
  - Unit 4 touches add-task-set + inception call sites and create-tasks' buildTaskBody.
- **Error propagation:** all abort paths route through the existing `Promise.all([reportStatus, activityLog, studyComment])` pattern with `.catch(...)` wrapper. No new failure modes. Import Mode always resets via existing `finally` blocks.
- **State lifecycle risks:** Unit 3's guard must run inside `withStudyLock` (it does, by virtue of sitting in `processAddTaskSet`). Abort-before-lock-release is safe because the lock is released by the same mechanism that acquires it.
- **API surface parity:** no changes to webhook payload shapes, route signatures, or response bodies. Only internal helper signatures (`buildTaskBody`, `createStudyTasks`) change, and those are internal.
- **Integration coverage:** all abort paths exercised by tests that mock the full `{ reportStatus, activityLog, studyComment }` trio. Unit 4 exercised by full TLF+Insights+CSR subtree fixture.
- **Unchanged invariants:**
  - PR #18 name-based matching (PR C's concern; not touched here).
  - PR #56 per-study serialization (outer wrapper still intact).
  - PR #52 pre-creation data pattern (Unit 3 honors).
  - PR #48 three-path Import Mode cleanup (Unit 2 honors).
  - PR #57 `source.user_id` button attribution (Unit 1 consumes).
  - PR #58 errors-only comments (Unit 1 extends, doesn't break).
  - Cascade engine (not touched).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Test rewrite of `inception.test.js:588-619` loses coverage if someone re-introduces a "today" fallback | New test explicitly asserts `createStudyTasks` NOT called + comment posted. Any future fallback would fail the new assertion. Also, SC-6 in origin names this rewrite explicitly. |
| Unit 3's single-leaf detection is over-eager and blocks a legitimate case | Guard is `isSingleLeaf && !isRepeat` — both conditions must hold. Numbered sets (TLF #2/#3) have multiple tasks in the subtree and pass through. Repeat-delivery is gated explicitly. Tests cover both positive-skip cases. |
| Unit 4's `extraTags` is missed by future callers of `createStudyTasks` | Default is `[]` (safe). Inception passes `[]` explicitly at call site for documentation. Add-task-set passes based on `buttonType`. Future callers will see the param in the signature. |
| Dedup in Unit 1 changes the order of mentions visibly in Notion comments | Order in the output is `[triggered, ...configured]` then unique via `Set`. Consistent across calls. Visible change: if Tem is both presser and configured, previously comment would show him twice (would it? not sure — current code doesn't dedup). Post-Unit-1, always once. Acceptable visible change per origin R4e-dedup. |
| Abort path on Contract Sign Date empty fires during withStudyLock-held inception, leaving Import Mode stuck | Abort is inside the `try` that `finally` resets Import Mode. Verified pattern from PR #48. Unit 2's test explicitly asserts Import Mode reset. |
| Notion comment posting fails (rate limit, network) during abort → user sees no error | Existing `studyCommentService.postComment(...).catch(...)` wrapper silences failures. `reportStatus` (Automation Reporting field) is the backup visibility channel — already written. Activity Log also written. Worst case, user sees the red AR message but no comment. Acceptable. |

## Documentation / Operational Notes

- Post-merge: update `clients/picnic-health/foundational/BACKLOG.md` — mark Items 1 (code hardening), 4, and 5 from Meg Apr 16 batch as resolved. Item 1 data cleanup (archiving `34423867-60c2-815b-afa6-e9890a23c405`) is a separate manual task already noted.
- Pulse log entry `clients/picnic-health/pulse-log/04.16/NNN-pr-d-provisioning-safety-batch.md`.
- Railway auto-deploys on merge. No feature flag — pre-production testing mode makes immediate deploy acceptable.
- Notion-side action (Item 4a): Tem manually clears the Contract Sign Date default value on the Studies DB property. Non-PR. Ordering: Notion change can happen any time relative to PR D merge — existing studies have date values so R4b breaking them is already ruled out per origin.
- Post-merge monitoring: watch first 3-5 button clicks in Activity Log to confirm no unexpected abort paths fire. Watch first error comment to confirm dedup + bot-handling work as specified.

## Sources & References

- **Origin document:** [engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md](engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md) — Items 1, 4, 5
- **Related code:**
  - `engine/src/services/study-comment.js` (Unit 1)
  - `engine/src/routes/inception.js` (Unit 2)
  - `engine/src/routes/add-task-set.js` (Units 2, 3, 4)
  - `engine/src/provisioning/create-tasks.js` (Units 2, 4)
  - `engine/src/config.js` (referenced by Unit 1)
- **Related tests:**
  - `engine/test/services/study-comment.test.js` (Unit 1)
  - `engine/test/routes/inception.test.js` (Unit 2 — test rewrite)
  - `engine/test/routes/add-task-set.test.js` (Units 2, 3, 4)
  - `engine/test/provisioning/create-tasks.test.js` (Unit 4)
- **Prior shipped work referenced:**
  - PR #57 — `source.user_id` button attribution (`pulse-log/04.14/005-button-user-attribution-fix.md`)
  - PR #58 — errors-only comments with env-configurable mentions (`pulse-log/04.15/002-post-call-batch-session.md`)
  - PR #48 — three-path Import Mode cleanup discipline (`pulse-log/04.14/001-import-mode-and-activity-log-fixes.md`)
  - PR #52 — pre-creation data patterns (`pulse-log/04.14/002-task-set-numbering-fix.md`)
  - PR #56 — per-study serialization via `withStudyLock` (`pulse-log/04.14/004-add-task-set-serialization.md`)
- **Cross-PR coordination:**
  - PR C also touches `add-task-set.js` in a disjoint region. Recommended merge order: PR C first (surgical), PR D second (touches more surface). Second merger handles trivial rebase.
