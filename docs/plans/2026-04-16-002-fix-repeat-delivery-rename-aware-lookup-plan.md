---
title: "fix: Rename-aware name match for repeat-delivery date copy"
type: fix
status: active
date: 2026-04-16
origin: engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md
---

# PR C — Rename-Aware Name Match for Repeat-Delivery

## Overview

Fix the repeat-delivery date-copy bug where `Data Delivery #N` tasks get blueprint-offset formula dates instead of inheriting the previous delivery's (possibly drag-left-shifted) dates. Root cause: `applyDeliveryNumbering` renames `"Data Delivery #2"` → `"Data Delivery #(nextNum)"` *before* the override lookup, and `latestDates` is keyed by the **original** production names. The renamed key misses. ~10-line fix: normalize the map keys so the renamed task still finds its source. Also correct the L2 behavior-ref doc which erroneously claims matching is TSID-based.

## Problem Frame

Meg's 2026-04-16 repeat-delivery click created `Data Delivery #3` on her test study with the Delivery task dated `2027-12-07` and `Repeat QC` dated `2027-12-08 → 2028-01-03` — Delivery starts *before* QC ends. Screenshot confirmation. Activity Log `3442386760c28113bdb4d7c9f9050794`.

Investigation mapped the exact failure at `engine/src/routes/add-task-set.js`:
- **Line 245** `applyDeliveryNumbering(filteredLevels, nextNum)` renames every blueprint task name containing `#\d+` to `#nextNum`.
- **Line 333** `latestDates` is built by iterating existing production tasks and keying by `name.trim()` → keys like `"Data Delivery #2"`, `"Repeat QC"`, `"Repeat Abstraction"`.
- **Line 360** the override lookup uses `latestDates[task._taskName.trim()]` — but `task._taskName` is the already-renamed `"Data Delivery #3"`. Miss → no override → `create-tasks.js:37-53` falls back to blueprint-offset formula → Delivery anchored to `contractSignDate + offset 428 = 2027-12-07`.
- Meanwhile QC and Abstraction names lack `#N`, so their lookups hit and they correctly inherit DD#2's shifted dates (`2027-12-08` and adjacent). Result: QC dates shift, Delivery falls back to formula, ordering inverts.

**Why the 2026-04-15 audit missed this:** The Apr 14 test study had no manually shifted DD#2 dates. Blueprint-offset dates == copy-source dates by coincidence. Meg's Apr 16 drag-left on DD#2 exposed the bug.

**Why NOT TSID refactor (resolved by document-review):** I initially proposed replacing name-matching with TSID matching. [PR #18 pulse log](clients/picnic-health/pulse-log/04.05/01-live-button-testing.md) shows the engine deliberately moved *from* TSID *to* name-matching because the blueprint has 9 separate DD subtrees, all with unique TSIDs, but the repeat-delivery button always clones from one source subtree. TSID matching would be degenerate (always hits the blueprint source, never a production copy). Reverting would reintroduce the exact bug PR #18 fixed. Name matching disambiguates through the `#N` suffix. **This PR keeps name matching — fixes only the rename-timing bug — and corrects the L2 doc that incorrectly claims TSID matching.**

## Requirements Trace

- **R3-1** — Normalize `latestDates` keys so the renamed target task matches existing production tasks (see origin).
- **R3-2** — Scope confined to `engine/src/routes/add-task-set.js`. No changes to `create-tasks.js`, `_override*` flow, or blueprint wiring.
- **R3-3** — Update `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md:59` to correct the TSID-matching claim and cite PR #18 rationale.

Satisfies origin success criterion **SC-3** (drag-lefted DD#N → DD#(N+1) inherits shifted dates, stays after QC).

## Scope Boundaries

- **No change** to `create-tasks.js` or `buildTaskBody`. Override fields `_overrideStartDate` / `_overrideEndDate` consume the same shape as today.
- **No change** to `applyDeliveryNumbering` logic — renaming still happens in place.
- **No change** to the blueprint, dependency wiring, or copy-from-latest semantic.
- **No change** to non-delivery add-task-set buttons (TLF variants, additional-site). This bug is specific to repeat-delivery because only it runs `applyDeliveryNumbering` + relies on `latestDates`.
- **Not included:** the other four items in the Apr 16 batch. Separate PRs.

## Context & Research

### Relevant Code and Patterns

- `engine/src/routes/add-task-set.js:245` — `applyDeliveryNumbering(filteredLevels, nextNum)` rewrites `task._taskName` in place using `.replace(/#\d+/g, `#${nextNum}`)`. Shared across the entire subtree (including non-Delivery tasks that happen to have `#N` in their names, though for current repeat-delivery only the Delivery milestone does).
- `engine/src/routes/add-task-set.js:333` — the `for (const { name, dates } of existingDeliveryTasks)` loop that builds `latestDates[name.trim()]`.
- `engine/src/routes/add-task-set.js:360` — the override lookup `latestDates[task._taskName.trim()]`.
- `engine/src/routes/add-task-set.js:307-309` — the comment that spells out why TSID matching was rejected (from PR #18).
- `engine/src/provisioning/create-tasks.js:37-53` — the fall-through path that applies blueprint-offset formula when `_overrideStartDate` / `_overrideEndDate` are absent.
- `engine/test/routes/add-task-set.test.js` — existing repeat-delivery tests. Will add a regression test here.
- `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md:59` — current incorrect line: *"repeat-delivery copies dates from the latest existing delivery task-by-task, matched by Template Source ID"*.

### Institutional Learnings

- **PR #18 (`clients/picnic-health/pulse-log/04.05/01-live-button-testing.md`)** — established name-based matching over TSID because the blueprint has 9 unique DD subtrees with unique TSIDs. The current name-based lookup is load-bearing; the bug is timing, not strategy.
- **PR #52 (`pulse-log/04.14/002-task-set-numbering-fix.md`)** — pre-creation data is the correct source for numbering / counts. Do NOT do a post-creation re-query (Notion eventual-consistency ate results). The `latestDates` build here correctly uses pre-creation `existingTasks` — no change needed.
- **PR #56 (`pulse-log/04.14/004-add-task-set-serialization.md`)** — `withStudyLock` serializes same-study add-task-set operations. No concurrency concern for this PR.
- **PR #18 also introduced** the `nextNum` hoisting used by `applyDeliveryNumbering` — do not regress.

### External References

None. Local patterns are decisive.

## Key Technical Decisions

- **Pick normalization option (b) from origin: pre-rewrite existing names during `latestDates` build.** Smallest and clearest diff. At `add-task-set.js:333`, when building the map, rewrite each existing name from `#N` to `#nextNum` before keying. The later lookup with the already-renamed task name (also `#nextNum`) matches directly. No change to the lookup site. No change to how keys are later consumed.
  - Option (a) (strip `#N` from both sides) works but risks colliding unrelated tasks if blueprint ever uses bare `#` in other names.
  - Option (c) (do the lookup before `applyDeliveryNumbering`) works but reorders two operations and is the largest diff.
  - Option (b) is a single `.replace` on the key during map construction.
- **Correct L2 doc in the same PR, not a separate one.** The doc and code diverged; they should realign together. Adds a Section 8 changelog entry citing PR #18's reason.
- **Add a regression test where DD#N has manually shifted dates.** The Apr 15 audit missed this bug because test-fixture dates matched formula dates by coincidence. Explicitly construct a fixture where DD#2's Delivery task has a drag-left-shifted start that's different from the blueprint formula output.

## Open Questions

### Resolved During Planning

- **Normalization option (a / b / c):** picked (b). See decisions.
- **Should we also fix `create-tasks.js:215` Contract Sign Date fallback here?** No. That's PR D (Item 4). Separate concerns.
- **Does the renaming affect tasks other than Delivery?** The blueprint's repeat-delivery subtree only has `#N` in the Delivery task title (per investigation). Other subtree names (`Repeat QC`, `Repeat Abstraction`, etc.) don't contain `#N`, so they're unaffected by `applyDeliveryNumbering`. Their `latestDates` lookup already hits by exact name. Confirmed.

### Deferred to Implementation

- **Whether to share a tiny helper function or inline the regex.** Regex is pinned to `/#\d+/g` → `#${nextNum}` (exact mirror of `applyDeliveryNumbering`'s pattern). Decision deferred on whether to extract a two-line helper or inline.
- **Whether to keep a single-line code comment** citing PR #18 rationale at the lookup site. Recommended — protects against future "refactor to TSID" temptations.
- **Test fixture authoring effort.** The shifted-date regression test requires new fixture data — existing `add-task-set.test.js` mocks don't include a Data Delivery #2 parent with `Dates`/`Parent Task`/`id` shape. Estimate 40–60 LOC of new fixture + spy setup. This is additional work beyond the ~10-line production change but proportional to the Lightweight classification.

## Implementation Units

- [ ] **Unit 1: Normalize `latestDates` keys in `add-task-set.js`**

**Goal:** Fix the rename-timing bug by pre-rewriting `latestDates` keys so the renamed new task matches.

**Requirements:** R3-1, R3-2.

**Dependencies:** None.

**Files:**
- Modify: `engine/src/routes/add-task-set.js` (the `latestDates` build loop around line 333)
- Test: `engine/test/routes/add-task-set.test.js`

**Approach:**
- In the loop that builds `latestDates` (around line 333), replace `latestDates[name.trim()] = { start, end }` with:
  - `const normalizedKey = name.trim().replace(/#\d+/g, `#${nextNum}`);`
  - `latestDates[normalizedKey] = { start: dates.start, end: dates.end };`
- Confirm `nextNum` is in scope at that point (it's computed earlier in `applyDeliveryNumbering`'s setup — verify and pull into scope if needed).
- Leave the lookup site at line 360 unchanged — it already reads `latestDates[task._taskName.trim()]` which is the already-renamed target name.
- Add a 1-line code comment at the build site: `// Keyed by target delivery number (post-rename) to match renamed tasks in the override lookup. See PR #18 for why name-based (not TSID-based) matching.`
- **Do not** strip `#N` (option a) or reorder the lookup (option c). Option (b) only.
- **Do not** change anything in `create-tasks.js`.

**Execution note:** Smallest-diff principle. The change should be ≤10 net added lines.

**Patterns to follow:**
- `applyDeliveryNumbering` regex at `add-task-set.js:~245` — reuse same `.replace(/#\d+/g, `#${nextNum}`)` form for consistency.

**Test scenarios:**
- **Happy — no-shift baseline:** DD#2 has exactly blueprint-offset dates, repeat-delivery fires, DD#3 created with identical-to-formula dates. (Pre-existing behavior doesn't regress.)
- **Happy — drag-left shift propagates (SC-3):** test fixture where DD#2's Delivery task has a manually shifted start (e.g., 10 BD earlier than formula would produce). Click repeat-delivery. DD#3's Delivery task new start = DD#2's shifted start. Delivery still starts *after* QC ends in the resulting chain.
- **Happy — drag-right shift propagates:** same as above but DD#2 shifted later. DD#3 inherits shifted dates.
- **Edge — only DD#1 exists (first repeat call creating DD#2):** no prior delivery to copy from. Falls back to blueprint-offset formula. No regression from current behavior.
- **Edge — multiple deliveries (DD#2..DD#9 with varied shifts):** click repeat-delivery to create DD#10. DD#10 inherits DD#9's dates (latest, highest `#N`). Not DD#8 or DD#2.
- **Edge — DD#N with non-Delivery tasks named with `#N` (hypothetical):** if the blueprint ever introduces another `#N`-suffixed task name in the repeat-delivery subtree, normalization applies uniformly. Test with a fabricated fixture; confirm both tasks get their shifted dates.

**Verification:**
- `npm run test:ci` passes, including new regression scenarios.
- Code review confirms single-file change in `add-task-set.js`.
- Manual trace: walk through the exact Meg Apr 16 scenario (DD#2 shifted, click Repeat Delivery for DD#3) and verify via test fixture that Delivery's new start equals DD#2's shifted start, and QC starts *before* Delivery.

- [ ] **Unit 2: Correct `ENGINE-BEHAVIOR-REFERENCE.md` Section 2b + add changelog entry**

**Goal:** Align the L2 doc with the code's actual (and correct) matching strategy.

**Requirements:** R3-3.

**Dependencies:** Unit 1 merged (prefer doc + code in one PR).

**Files:**
- Modify: `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md`

**Approach:**
- **Section 2b "Provisioning Guards & Behavior" — Repeat-delivery date copying** (line 59): replace
  > *"repeat-delivery copies dates from the latest existing delivery task-by-task, matched by Template Source ID"*
  with
  > *"repeat-delivery copies dates from the latest existing delivery task-by-task, matched by task name (with delivery number normalized to the target `#N`). Name-matching is deliberate — the blueprint has multiple `Data Delivery #N` subtrees with unique Template Source IDs, so TSID matching would be degenerate. See PR #18 rationale."*
- **Section 8 Changelog** — append a dated entry:
  > *"2026-04-16 — PR C: corrected Section 2b repeat-delivery matcher description. Previously claimed TSID-based; code has been name-based since PR #18. Also fixed the timing bug where `applyDeliveryNumbering` renamed tasks before the `latestDates` lookup — `latestDates` keys now normalize to the target delivery number so the renamed task matches."*

**Patterns to follow:**
- Existing Section 8 entries format (2026-03-31, 2026-04-12 dated entries).

**Test scenarios:** Test expectation: none — docs-only change. Verification is a review of the updated file.

**Verification:**
- Grep `grep -n "Template Source ID" engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` returns only the corrected line (or corrected context), not the stale aspirational claim.
- Section 8 entry is present and dated 2026-04-16.

## System-Wide Impact

- **Interaction graph:** only `add-task-set.js`'s `latestDates` build site changes. No other route / module touched.
- **Error propagation:** unchanged. The normalization is a pure key-transformation; no new error modes.
- **State lifecycle risks:** none.
- **API surface parity:** no change to route payloads or contracts.
- **Integration coverage:** existing repeat-delivery test coverage stays green; new regression test added for shifted-date inheritance.
- **Unchanged invariants:** inception (doesn't use `latestDates`), other add-task-set buttons (TLF variants, additional-site — they don't run `applyDeliveryNumbering`), create-tasks.js consumers of `_override*`, blueprint wiring.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Normalization breaks future blueprint shape where `#N` appears in non-delivery task names with different semantics | Test scenario explicitly exercises a multi-`#N` fixture. If blueprint ever adds such names, the normalization still applies consistently; the map keys and lookup sites stay symmetric. |
| Someone reading the fix later proposes TSID refactor as "cleaner" | Inline code comment cites PR #18 rationale directly at the build site. L2 doc Section 2b also documents the reason. |
| Tests were written against coincidental-equal dates before (Apr 15 audit case) and could be repeated | New fixture explicitly uses manually-shifted DD#N dates that differ from blueprint-offset formula, making coincidence impossible. |

## Documentation / Operational Notes

- Post-merge: record in `clients/picnic-health/foundational/BACKLOG.md` that Item 3 from the Meg Apr 16 batch is resolved.
- Pulse log entry `clients/picnic-health/pulse-log/04.16/NNN-pr-c-repeat-delivery-rename-aware-match.md` summarizing the change.
- No operational / rollout changes. Railway auto-deploys on merge. No feature flag — behavior change is immediate and applies to all studies on next repeat-delivery click.

## Sources & References

- **Origin document:** [engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md](engine/docs/brainstorms/meg-apr-16-feedback-batch-requirements.md) — Item 3
- **L2 contract (to be updated):** [engine/docs/ENGINE-BEHAVIOR-REFERENCE.md](engine/docs/ENGINE-BEHAVIOR-REFERENCE.md) §2b (line 59), §8 Changelog
- **Related code:** `engine/src/routes/add-task-set.js` (lines 245, 307-309, 333, 360), `engine/src/provisioning/create-tasks.js` (lines 37-53 — consumer of `_override*`, unchanged)
- **Related tests:** `engine/test/routes/add-task-set.test.js`
- **Activity Log event (repro):** `3442386760c28113bdb4d7c9f9050794`
- **Prior shipped work referenced:**
  - PR #18 — established name-based matching over TSID for repeat-delivery (`clients/picnic-health/pulse-log/04.05/01-live-button-testing.md`)
  - PR #52 — pre-creation data patterns (`pulse-log/04.14/002-task-set-numbering-fix.md`)
  - PR #56 — per-study serialization (`pulse-log/04.14/004-add-task-set-serialization.md`)
