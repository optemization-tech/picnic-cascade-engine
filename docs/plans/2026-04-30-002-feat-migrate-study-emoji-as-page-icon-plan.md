---
title: "feat(migrate-study): move leading emoji marker from source title to page icon"
type: feat
status: active
date: 2026-04-30
---

# feat(migrate-study): move leading emoji marker from source title to page icon

## Overview

PR #91 cleaned matched Migrated Task titles by stripping the study-name prefix, but kept the leading emoji marker (`🔶`) in the title — `🔶  Alexion PNH PLEDGE Final SAP Delivery` became `🔶 Final SAP Delivery`. The user's intent is fully clean titles with the emoji **moved to the Notion page icon** instead.

This plan changes that behavior: when a matched Migrated Task's title has a leading recognized emoji marker (`🔶 ✅ 🔷 ⚠️ 🚨`), the emoji is detached from the title and written as the page icon in the same Notion PATCH that already lands `Notion Task` + `Match Confidence`.

---

## Problem Frame

Matched Migrated Task titles still show as `🔶 Final SAP Delivery` after PR #91. PMs scrolling the Migration Support callout get a wall of orange-rectangle-prefixed strings instead of clean task names. The emoji is meaningful (it marks "this row was a milestone in Asana") but as a *prefix character* it's competing with the task name for attention. As a *page icon* it shows up in the page header, the database row's row icon, and the URL slug doesn't carry it — exactly where status markers belong.

The user pointed at 11 specific [Alexion PNH PLEDGE Migrated Tasks](https://www.notion.so/picnichealth/Alexion-PNH-PLEDGE-Final-SAP-Delivery-34d2386760c2813a905fc46004dfd5ff) where they want this applied.

---

## Requirements Trace

- R1. When a matched Migrated Task title starts with a recognized emoji marker, the engine must remove it from the title.
- R2. The same emoji must be written as the page's icon (`{ type: 'emoji', emoji: '<marker>' }`).
- R3. The study-prefix-strip from PR #91 continues to apply: `Alexion PNH PLEDGE` tokens are peeled regardless of whether an emoji was present.
- R4. When the title has no leading emoji, the run must not change the page icon — pages with user-set icons or no icons stay as-is.
- R5. When the title has no study prefix and no emoji, no title PATCH and no icon PATCH fires (idempotent on already-clean rows).
- R6. The icon write piggybacks on the existing migrated-task PATCH (single Notion request per row), not a separate API call.
- R7. Behavior applies only to matched rows. Unmatched rows keep their original title + icon for PM context, same as PR #91.
- R8. Recognized emoji set is the existing `TITLE_EMOJI_PREFIXES` from `src/migration/normalize.js` (no new emojis introduced as part of this plan).

---

## Scope Boundaries

- **Not** moving non-recognized emojis (anything outside `🔶 ✅ 🔷 ⚠️ 🚨`).
- **Not** preserving an existing page icon when we would otherwise write one — the assumption is that Migrated Tasks are CSV-import-derived and don't have meaningful PM-set icons. If that turns out to be wrong, follow-up work can add an "only set if no current icon" guard.
- **Not** retroactively setting icons on already-cleaned rows from previous runs (where the title is now clean but the icon was never written). Re-cleaning happens only when the source title still carries the marker. PMs can fix one-off icons manually if needed.
- **Not** changing matcher logic, gate logic, threshold defaults, or any other surface from PRs #79–#93.
- **Not** clearing icons on unmatched rows or on rows whose title had no emoji — `icon: null` is never written.

---

## Context & Research

### Relevant Code and Patterns

- `src/migration/normalize.js`
  - `TITLE_EMOJI_PREFIXES` — already enumerates the 5 recognized markers.
  - `cleanTitleByStrippingStudyPrefix(name, studyName)` — current function that preserves the leading emoji while stripping study tokens. **This function's contract changes in this plan** (returns both cleaned title and detached emoji) or is replaced by a new function depending on U1's chosen shape.
  - `stripStudyPrefix(name, studyName)` — used by the matcher; unchanged.
  - `stripLeadingMarkers(s)` — internal helper that strips emoji markers; the new logic in U1 uses the same recognized set so behavior stays consistent across normalization and rename.
- `src/migration/migrate-study-service.js`
  - `queueProductionTask(migratedPageId, cascadeId, tier, originalName)` — the function PR #91 extended to write a `title` property when the cleaned name differs from the original. This is the call site that gains the icon write.
  - `migratedPatches.push({ taskId, properties })` — the patch shape consumed by `applyMigrationPlan`.
  - `applyMigrationPlan` — slices `migratedPatches` into chunks and calls `notionClient.patchPages(slice, { tracer })`.
- `src/notion/client.js` (and/or `src/notion/clients.js`)
  - `patchPages` — the wrapper that issues `PATCH /pages/{id}` per item. Implementation detail: confirm whether the wrapper currently passes through arbitrary top-level page fields (like `icon`) or only `properties`. If it doesn't, U2 extends it.
- Other engine routes (`src/routes/inception.js`, `src/routes/dep-edit.js`, etc.) do not currently set page icons — this is the first usage. No prior pattern in the repo for icon writes; the Notion API contract is the source of truth: top-level `icon` field on the page object, value shape `{ type: 'emoji', emoji: '🔶' }`.

### Institutional Learnings

- `docs/solutions/` does not exist in this engagement, so no prior compound learnings to fold in.
- PR #91's `cleanTitleByStrippingStudyPrefix` is fresh (this morning) — its tests in `test/migration/matcher.test.js` and `test/migration/migrate-study-service.test.js` are the primary reference for what the new helper's tests should look like.

### External References

- Notion API reference for `PATCH /pages/{id}` — accepts top-level `icon` field. Value shapes include `{ type: 'emoji', emoji: '🔶' }` for emoji icons. Single PATCH can update both `properties` and `icon`. Reference verified during plan writing.

---

## Key Technical Decisions

- **Detach emoji + study prefix in one helper.** Replace `cleanTitleByStrippingStudyPrefix(name, studyName) → string` with `splitStudyPrefixAndEmoji(name, studyName) → { title, emoji }`. Single function returning both pieces is more honest than two consecutive calls each doing partial work.
- **Single PATCH per row.** Extend the `migratedPatches` shape to optionally carry `icon`. Have `patchPages` pass the icon through to the page PATCH body. This keeps Notion API call count flat (still 1 call per matched row) — important for rate-limit hygiene and the existing chunked pacing.
- **Overwrite icon unconditionally when an emoji was detached.** Cleanest behavior. Migrated Tasks are CSV-import-derived; user-set icons on these rows are extremely unlikely. If a Migration Support callout user later says "I had a custom icon and migrate-study clobbered it," we add a guard then.
- **Don't touch icon when no emoji was detached.** Critical: this preserves user-set icons on rows where the source title had no marker, and avoids a needless `icon: null` write that could clobber UI state.
- **Recognized emoji set stays fixed at the existing 5.** No new markers introduced in this plan. If new ones surface, they're added to `TITLE_EMOJI_PREFIXES` in a separate change.
- **Behavior is matched-rows-only.** Same scope discipline as PR #91. Unmatched rows keep their original title + icon for PM triage context.

---

## Open Questions

### Resolved During Planning

- *Should we move all five recognized emojis or just `🔶`?* — All five. `TITLE_EMOJI_PREFIXES` already groups them as semantically equivalent (status/marker prefixes). Special-casing only `🔶` would create a maintenance pothole the next time anything changes.
- *Should re-runs retroactively set icons on already-cleaned rows?* — No. The trigger is "source title currently has a leading emoji"; if a previous run already cleaned it, this run sees a clean title and skips both the title and icon PATCH. PMs can manually fix outliers.
- *Should we preserve an existing page icon when a recognized emoji is detached from the title?* — No (default to overwrite). Migrated Tasks are CSV-import-derived. Trade-off accepted; revisitable.

### Deferred to Implementation

- *Whether `notionClient.patchPages` already forwards arbitrary top-level page fields or needs to be extended.* The implementer verifies during U2; if patchPages strips everything except `properties`, U2's scope expands to include the wrapper change. If it already forwards, U2 is a no-op for that wrapper and only the patch-shape contract docs change.

---

## Implementation Units

- U1. **Replace `cleanTitleByStrippingStudyPrefix` with `splitStudyPrefixAndEmoji`**

**Goal:** Helper returns both the cleaned title (no emoji, no study prefix) and the detected leading emoji (or null), so the call site can route them to the right Notion fields.

**Requirements:** R1, R3, R4, R5, R8

**Dependencies:** None.

**Files:**
- Modify: `src/migration/normalize.js`
- Test: `test/migration/matcher.test.js`

**Approach:**
- Replace `cleanTitleByStrippingStudyPrefix(name, studyName)` with `splitStudyPrefixAndEmoji(name, studyName) → { title: string, emoji: string|null }`.
- Detect the leading emoji using the existing `TITLE_EMOJI_PREFIXES` list. If found, set `emoji` to that marker and remove it (plus following whitespace) from the body before calling `stripStudyPrefix`.
- Run `stripStudyPrefix` on the post-emoji body. The combined operation drops both pieces.
- Preserve the existing "don't reduce to empty" guard: if the result is an empty string, return `{ title: <original>, emoji: null }` so the call site treats the row as already-clean and PATCHes neither field.
- The old function name `cleanTitleByStrippingStudyPrefix` is removed; its sole call site in `migrate-study-service.js` is updated in U3.

**Execution note:** Test-first. Locking in the exact contract — `{ title, emoji }` return shape, `null` emoji vs detected emoji, no-reduce-to-empty case — is cheap and prevents regression as the call site changes in U3.

**Patterns to follow:**
- `stripStudyPrefix` and `stripLeadingMarkers` in the same file. The new function reuses the recognized-emoji array via the same module-level constant.

**Test scenarios:**
- Happy path: `splitStudyPrefixAndEmoji('🔶  Alexion PNH PLEDGE Final SAP Delivery', 'Alexion PNH PLEDGE')` returns `{ title: 'Final SAP Delivery', emoji: '🔶' }`.
- Happy path: each of the 5 recognized markers detaches correctly when leading.
- Edge case: title with study prefix but no emoji — `splitStudyPrefixAndEmoji('Alexion PNH: Submit IRB', 'Alexion PNH PLEDGE')` returns `{ title: 'Submit IRB', emoji: null }`.
- Edge case: title with emoji but no study prefix — `splitStudyPrefixAndEmoji('🔶 Random Task', 'Alexion PNH PLEDGE')` returns `{ title: 'Random Task', emoji: '🔶' }`.
- Edge case: already-clean title — `splitStudyPrefixAndEmoji('Final SAP Delivery', 'Alexion PNH PLEDGE')` returns `{ title: 'Final SAP Delivery', emoji: null }`. (No PATCH should fire downstream.)
- Edge case: title is only the study name and emoji (would reduce to empty) — `splitStudyPrefixAndEmoji('🔶 Alexion PNH PLEDGE', 'Alexion PNH PLEDGE')` returns `{ title: '🔶 Alexion PNH PLEDGE', emoji: null }`. The original is returned wholesale; no PATCH should fire.
- Edge case: missing studyName — null/empty `studyName` returns `{ title: <original>, emoji: null }` (preserve existing behavior of `cleanTitleByStrippingStudyPrefix`).
- Edge case: non-recognized emoji at start (e.g., `📌`) — `emoji: null`, title strip-only (the unrecognized character stays in the title).

**Verification:**
- New test cases for `splitStudyPrefixAndEmoji` pass; the deleted `cleanTitleByStrippingStudyPrefix` test block is removed cleanly.
- No other call site references the old function name (grep confirms).

---

- U2. **Plumb `icon` through the migrated-task PATCH path**

**Goal:** Allow `migratedPatches` entries to carry an optional `icon` field, and have the patch wrapper forward it to Notion's `PATCH /pages/{id}` body alongside `properties`.

**Requirements:** R2, R6

**Dependencies:** None (independent of U1).

**Files:**
- Modify: `src/notion/client.js` (likely; see deferred question below for verification)
- Modify: `src/migration/migrate-study-service.js` (only if patch-shape is documented inline; otherwise touch in U3)
- Test: `test/notion/client.test.js` *(if a test file already exists for the Notion client)* OR add a focused test alongside the migrate-study integration test in U3 that asserts `icon` shows up in the PATCH request body.

**Approach:**
- Inspect `notionClient.patchPages` to see whether it currently spreads the patch entry into the request body, or strictly extracts `properties`. If the former, this unit is mostly a no-op (just confirms behavior + adds a test asserting `icon` flows through). If the latter, extend it to also forward `icon` (and only `icon` for now — don't open the floodgates to arbitrary top-level fields).
- The Notion API expects `icon: { type: 'emoji', emoji: '<char>' }` or `icon: null` to clear; this plan's call sites only ever produce the emoji shape.
- Patch shape contract becomes: `{ taskId: string, properties: object, icon?: { type: 'emoji', emoji: string } }`. Document this in a code comment at the top of the patch-related call site.

**Patterns to follow:**
- Existing single-page PATCH usage at `src/migration/migrate-study-service.js:443-450` (the Import Mode arm/disarm), which uses `notionClient.request('PATCH', '/pages/${id}', { properties: { ... } })`. The shape is well-known; just need the `icon` peer added to `patchPages`'s request body when present.

**Test scenarios:**
- Happy path: `patchPages([{ taskId: 'p1', properties: { foo: 'bar' }, icon: { type: 'emoji', emoji: '🔶' } }])` issues a PATCH whose body includes both `properties` and `icon`. (Mock the underlying `request` and assert call shape.)
- Edge case: `patchPages([{ taskId: 'p1', properties: { foo: 'bar' } }])` (no icon) issues a PATCH whose body has `properties` only — no `icon: null`, no `icon: undefined` polluting the body.
- Integration scenario: covered in U3's integration test (which exercises the full path from `buildMigrationPlan` through `applyMigrationPlan` and asserts the request body shape).

**Verification:**
- `patchPages` either already forwards `icon` (in which case the new test confirms it) or now does.
- Existing patch tests still pass; no behavior change for callers that don't pass `icon`.

---

- U3. **Wire emoji-to-icon writes into `queueProductionTask`**

**Goal:** When `splitStudyPrefixAndEmoji` returns a non-null emoji for a matched row, the migrated-task PATCH carries `icon: { type: 'emoji', emoji }` alongside the existing `properties` (`Notion Task`, `Match Confidence`, `title`).

**Requirements:** R1, R2, R3, R4, R5, R6, R7

**Dependencies:** U1, U2.

**Files:**
- Modify: `src/migration/migrate-study-service.js`
- Test: `test/migration/migrate-study-service.test.js`

**Approach:**
- Replace the `cleanTitleByStrippingStudyPrefix` call inside `queueProductionTask` with `splitStudyPrefixAndEmoji`.
- If `result.title !== originalName`, write `properties.title` (current PR #91 behavior — unchanged).
- If `result.emoji` is non-null, set the patch entry's `icon` field to `{ type: 'emoji', emoji: result.emoji }`.
- If neither title differs nor emoji is set, the patch carries only `Notion Task` + `Match Confidence` (no title, no icon — unchanged from before this plan).
- Idempotency: re-running on a row whose title has already been cleaned (no emoji prefix, no study tokens) yields `{ title: <unchanged>, emoji: null }`, so neither title nor icon PATCH fires. Re-running on a row whose title still has the marker yields the same emoji + cleaned title every time, which is a safe re-PATCH.

**Patterns to follow:**
- The current `queueProductionTask` body's pattern of conditionally adding properties (`Match Confidence` when `matchConfidencePropId && confidence`, `title` when `cleaned !== originalName`). The `icon` write follows the same conditional shape.

**Test scenarios:**
- Integration: build plan against a Migrated Task with title `🔶  Test Study Twin Task` and matched cascade twin. Assert `migratedPatches[0]`:
  - `properties.title` equals `[{ type: 'text', text: { content: 'Twin Task' } }]`
  - `icon` equals `{ type: 'emoji', emoji: '🔶' }`
  - `properties` still includes `Notion Task` relation and `Match Confidence` select.
- Integration: title has study prefix but no emoji (`Test Study Twin Task`). Patch entry has `properties.title` set but `icon` is undefined. (Negative assertion: `expect(plan.migratedPatches[0].icon).toBeUndefined()`.)
- Integration: already-clean title (no emoji, no study prefix; matches cascade by exact name). Patch entry has neither `properties.title` nor `icon`. The `Notion Task` and `Match Confidence` writes still land.
- Integration: each of the 5 recognized markers detaches and writes correctly via the integration path (parameterize or copy the simple case for one or two more markers).
- Edge case: `studyCommentService` and `tracer` mocks unchanged — this unit doesn't affect those paths but the integration test should pass without surprising the existing fixture.

**Verification:**
- The 11 example pages the user pointed at (all matched in the most recent Alexion re-run) would, on the next re-run, end up with clean titles and `🔶` icons. Verified at the patch level by the integration tests; verified end-to-end by the manual re-test step in the rollout notes.
- Existing `queueProductionTask` tests for `Match Confidence` and `Notion Task` still pass.

---

- U4. **Update `MIGRATE-STUDY-WEBHOOK.md` PM one-pager**

**Goal:** Bring the PM-facing contract description in line with the new behavior, so PMs reading the doc don't expect emoji-in-title.

**Requirements:** R1, R2, R7

**Dependencies:** U1, U2, U3.

**Files:**
- Modify: `docs/MIGRATE-STUDY-WEBHOOK.md`

**Approach:**
- Replace the "renames the source title" sentence (added in PR #91) with one that describes both the title strip and the emoji-to-icon move.
- Add a short example block: `🔶  Alexion PNH PLEDGE Final SAP Delivery` → title `Final SAP Delivery`, icon `🔶`.
- Note the matched-rows-only and idempotent guarantees that PR #91 already established remain in force.

**Test scenarios:**
- Test expectation: none — documentation-only change.

**Verification:**
- Reading the doc end-to-end gives a PM the right mental model of what the page looks like after a successful run.

---

## System-Wide Impact

- **Interaction graph:** Changes one helper (`splitStudyPrefixAndEmoji`) in `normalize.js` and one call site (`queueProductionTask`) in `migrate-study-service.js`. Optionally extends `patchPages` in `client.js`. No new entry points, no new webhooks. Inception, dep-edit, copy-blocks, add-task-set, status-rollup, undo-cascade, deletion routes are unaffected.
- **Error propagation:** Notion's `PATCH /pages/{id}` accepts `icon` as a valid top-level field; an invalid emoji shape would 400 the entire PATCH (including the `Notion Task` + `Match Confidence` writes). The existing chunked PATCH error handling already retries on 429s and surfaces other errors. The `TITLE_EMOJI_PREFIXES` set is hard-coded and validated, so we never construct an invalid shape from valid input.
- **State lifecycle risks:** None new. Idempotent on re-run (title already clean → no PATCH; title still dirty → same clean output every time). The `Import Mode` arm/clear sequencing in the success path is untouched.
- **API surface parity:** The `MigratedTaskPatch` shape gains an optional `icon` field. No external module consumes this shape directly today (it lives entirely inside the migration module and the Notion client wrapper), so the change is internal-only.
- **Integration coverage:** The U3 integration tests exercise the patch from `buildMigrationPlan` through the call site shape — covers the cross-layer that mocks alone wouldn't prove (i.e., the patch entry actually gets the right icon set, and the existing properties writes still land).
- **Unchanged invariants:** Match Confidence write, Notion Task relation, Migration Status, Status=Done overlay, Owner write, Manual Workstream skip, Import Mode arm/disarm, gate-error routing, study-prefix strip behavior — all explicitly preserved.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `patchPages` doesn't currently forward arbitrary top-level page fields, requiring a wrapper change. | U2 explicitly verifies and extends as needed. The fix is minimal — add `icon` as an opt-in pass-through alongside `properties`. Existing `request('PATCH', ...)` already proves the underlying API supports it. |
| User-set custom icons on Migrated Tasks get clobbered. | Accepted trade-off: Migrated Tasks are CSV-import-derived. If real-world feedback says PMs were customizing icons on these rows, follow-up adds an "only set if no current icon" guard in `queueProductionTask`. |
| Re-running on an already-cleaned row inadvertently re-PATCHes the title or icon. | Idempotency: `splitStudyPrefixAndEmoji` returns `{ title: <unchanged>, emoji: null }` on already-clean input. The conditional writes in `queueProductionTask` skip both PATCH fields. |
| Notion API rejects an emoji icon for some reason (font/encoding). | The 5 recognized markers are all standard Unicode emoji that Notion accepts as icons (verified empirically by manually setting them on Notion pages during planning). The hard-coded set means we never PATCH an unvalidated character. |
| Future markers added to `TITLE_EMOJI_PREFIXES` automatically start being moved to icons. | Acceptable — the markers in that list are semantically status/category indicators, all of which belong as icons rather than title prefixes. If a non-status emoji is ever added, the maintainer will see this contract and decide explicitly. |

---

## Documentation / Operational Notes

- Same Railway-deploy rollout pattern as PRs #79–#93. No env-var change required, no migration, no flag.
- After merge, PMs re-clicking **Migrator** on Alexion PNH PLEDGE will see all 25 previously matched Migrated Tasks land with cleaned titles and `🔶` page icons. The 11 example pages the user linked are part of that set.
- Pulse-log entry recommended in `engagements/picnic-health/pulse-log/{MM.DD}/` after the PR merges, summarizing the now-deployed end-to-end Migration Support callout view (clean titles, populated Match Confidence, page icons set).

---

## Sources & References

- Origin: user request in conversation, naming the 11 example Migrated Task URLs and the desired emoji-to-icon move.
- Related PRs:
  - [picnic-cascade-engine #91](https://github.com/optemization-tech/picnic-cascade-engine/pull/91) — title rename (emoji preserved); this plan supersedes that emoji-preservation behavior.
  - [picnic-cascade-engine #93](https://github.com/optemization-tech/picnic-cascade-engine/pull/93) — most recent matcher upgrade (aliases + threshold + disambiguation).
- Related code:
  - `src/migration/normalize.js` — `cleanTitleByStrippingStudyPrefix`, `TITLE_EMOJI_PREFIXES`, `stripStudyPrefix`.
  - `src/migration/migrate-study-service.js` — `queueProductionTask` and the migrated-patches loop.
  - `src/notion/client.js` — `patchPages` wrapper.
- Related docs: `docs/MIGRATE-STUDY-WEBHOOK.md`.
- Notion API: `PATCH /pages/{page_id}` accepts top-level `icon` field with shape `{ type: 'emoji', emoji: '<char>' }`.
