---
title: "feat: Status roll-up — partial-done -> In Progress"
type: feat
status: active
date: 2026-05-01
---

# feat: Status roll-up — partial-done -> In Progress

## Overview

Extend `computeStatusRollup` so a parent task whose children are `[Done, Not Started, ...]` (any one child `Done` or `N/A`, but not all complete, and none `In Progress`) rolls up to `In Progress` instead of `Not Started`. Helper-level change cascades automatically to both route branches (parent-direct snap-back and subtask-triggered roll-up) without route edits. Test additions and a behavior tag complete the change.

---

## Problem Frame

PicnicHealth project managers expect a parent task to reflect *partial* progress when at least one subtask is `Done` and the rest are `Not Started`. Today the engine treats that case as fully-not-started, so the parent stays `Not Started` even after one or more children complete. Meg confirmed this gap on the 2026-05-01 PM check-in: "if one subtest is done, and others are not yet done, it should be marked as in progress."

The two cases Meg already validated as working in production are unchanged:
- All subtasks `Done` → parent `Done`
- Any subtask `In Progress` → parent `In Progress`

This plan adds the missing third case.

---

## Requirements Trace

- R1. When `computeStatusRollup` receives a list where at least one child status is `Done` (or `N/A`, since `normalizeStatus` collapses `N/A` to `Done`), at least one child is not `Done`, and no child is `In Progress`, the helper returns `In Progress`.
- R2. Existing roll-up cases continue to behave as today: all-done → `Done`; any-in-progress → `In Progress`; all-not-started (or empty) → `Not Started`.
- R3. Both route branches in `src/routes/status-rollup.js` (parent-direct snap-back at line ~52 and subtask-triggered roll-up at line ~115) inherit the new behavior automatically through `computeStatusRollup`. No route changes.
- R4. The new partial-done case is covered by a tagged unit test that the traceability check (`scripts/check-behavior-traceability.js`) recognizes.
- R5. Documentation reflects the new rule: ENGINE-BEHAVIOR-REFERENCE.md (rule prose + 2026-05-01 changelog entry), BEHAVIOR-TAGS.md (new tag).

---

## Scope Boundaries

- Not changing route handlers, webhook payload parsing, Activity Log shape, or guard logic.
- Not introducing any new status precedence (e.g., `Blocked` propagation) — Meg has not asked for it and PicnicHealth's status set in this engine is currently `Not Started | In Progress | Done | N/A`.
- Not changing how `N/A` is normalized — it continues to count as `Done` for roll-up purposes (existing `normalizeStatus` behavior).
- Not altering the two existing roll-up cases (all-done, any-in-progress); the new branch is strictly additive after both.
- Not addressing multi-level (grandparent) roll-up. This is a **pre-existing limitation** that is unchanged by this plan, **not** something `editedByBot` re-entry handles. When the engine patches a middle parent (a task that has both a parent and its own subtasks), the resulting Notion webhook arrives with `editedByBot=true` AND `hasSubtasks=true`. The parent-direct branch in `src/routes/status-rollup.js:52-56` enters on `hasSubtasks`, then immediately returns on the bot-echo guard (line 56) to prevent patch storms — so the subtask-triggered branch never runs against the middle parent's parent (the grandparent). The existing route test at `test/routes/status-rollup-route.test.js:310-371` ("snap-back runs on middle parent…; grandparent rollup is not triggered") documents this as a known scope boundary. After this plan ships, more middle parents will flip from `Not Started` to `In Progress` under the new partial-done rule, which may make the grandparent gap more visible to PMs. Surface as a separate follow-up plan if PM testing reveals the grandparent gap is blocking.

---

## Context & Research

### Relevant Code and Patterns

- `src/engine/status-rollup.js` — `computeStatusRollup(siblings)` is the single rollup decision point. Both route branches call it.
- `src/routes/status-rollup.js:52-112` — parent-direct snap-back branch (Meg-confirmed 2026-04-22). When a PM directly edits a parent's `Status`, the route recomputes from the parent's own subtasks and patches back if the manual value disagrees.
- `src/routes/status-rollup.js:115-168` — subtask-triggered branch. When a leaf child's status changes, the route fetches siblings, recomputes the parent's roll-up, and patches the parent if the value changed.
- `test/engine/status-rollup.test.js` — 3 existing helper tests; missing the partial-done case.
- `test/routes/status-rollup-route.test.js` — 496 lines of route-level coverage. **Important:** this file mocks `computeStatusRollup` per scenario via `vi.mock('../../src/engine/status-rollup.js', ...)` and `mocks.computeStatusRollup.mockReturnValue(...)` (e.g., lines 11, 41-43, 123, 186, 350, 437). Route tests therefore do **not** exercise the real helper — they prove the route patches whatever the helper returns. Existing tests will pass unchanged after the helper change. R3 ("both route branches inherit") is verified by code inspection (the route uses the helper's return value directly with no intervening logic) — optional new route scenarios are listed under U1 test scenarios for explicit test coverage.

### Institutional Learnings

- The 2026-04-22 plan added the parent-direct snap-back branch in response to Meg's earlier feedback about parent/child desync. The same Meg-driven refinement loop continues here — each iteration tightens the roll-up rule against real PM workflows.
- The `editedByBot` echo-loop skip (`src/routes/status-rollup.js:56`) and stale-relation guard (`status-rollup.js:68-76`) protect against patch storms; both remain unaffected by this change.

### External References

- None — this is an internal rule extension confirmed verbally by the PM stakeholder. Notion's native subtask roll-up display does the right thing visually, but the engine writes the status property explicitly so dependent automations (Notion automations keyed on `Status`) fire correctly.

---

## Key Technical Decisions

- **Single-helper change, not a route change.** `computeStatusRollup` is the only decision point for both branches. Adding the partial-done branch in the helper is the smallest correct fix and inherits coverage by both route paths automatically. Rationale: minimal blast radius, no risk of branch drift between parent-direct and subtask-triggered semantics.
- **Place the new branch after `anyInProgress`, before the final `Not Started` fallthrough.** When children are `[Done, In Progress, Not Started]`, both the existing `anyInProgress` branch and the new partial-done branch would return `In Progress` — the outcome is identical, but the precedence (`anyInProgress` fires first) makes the source-of-truth explicit. This documents the intended precedence ladder: explicit in-progress beats implicit partial-done. Rationale: the existing rule reads top-to-bottom; the new branch slots cleanly into that ladder without changing the outcome of any pre-existing case.
- **`N/A` continues to count as `Done`.** `normalizeStatus` already collapses `N/A` to `Done`, so `[N/A, Not Started, Not Started]` will roll up to `In Progress` under the new rule. Rationale: consistent with the existing all-done case, where `[N/A, Done]` already returns `Done`. PMs treat N/A as "this work is done because it doesn't apply" — the same intuition extends to partial completion.
- **Status type: `feat`, not `fix`.** The current helper matches its current spec ("returns Not Started otherwise"). The change extends the spec rather than fixing a defect against it. Filename and frontmatter use `feat` accordingly.

---

## Open Questions

### Resolved During Planning

- **Where does the rule live?** `src/engine/status-rollup.js`, single helper. Confirmed by direct read.
- **Are both route branches affected?** Yes, both. Both call `computeStatusRollup` and patch based on the result. Confirmed by reading `src/routes/status-rollup.js`.
- **Does this need a brand-new behavior tag or can we extend an existing one?** New tag — there are no existing `BEH-STATUS-ROLLUP-*` tags in BEHAVIOR-TAGS.md (Status Roll-Up is documented in ENGINE-BEHAVIOR-REFERENCE.md but does not yet have a tag section).

### Deferred to Implementation

- **Should U1 add an optional route-level test scenario for explicit R3 coverage?** Recommended but not strictly required — the route uses the helper's return value directly with no intervening logic. If added, the scenario mocks `computeStatusRollup` to return `'In Progress'` for a `[Done, Not Started]`-shaped child fixture and asserts the parent gets patched + Activity Log fires correctly. Tag: `BEH-STATUS-ROLLUP-ROUTE-PARTIAL-DONE`.
- **Does BEHAVIOR-TAGS.md need a new top-level section ("Status Roll-Up") or does the new tag fit under §4 Route And Automation Rules?** U2 will decide based on whether more status-rollup tags are likely to land soon. Default: add a new §6 "Status Roll-Up" between §5 "Dep-Edit Cascade" and the renumbered §7 "Current Known Gaps", to mirror how Dep-Edit got its own section once it had multiple tags. Optional follow-up (deferred): the existing `BEH-PARENT-DIRECT-SNAPBACK`, `BEH-PARENT-DIRECT-BOT-ECHO-SKIP`, `BEH-PARENT-DIRECT-STALE-RELATION` tags appear in `test/routes/status-rollup-route.test.js` but are not yet registered in BEHAVIOR-TAGS.md — they could be back-filled in the new §6 to round out the section, but that is out of scope for this plan.

---

## Implementation Units

- U1. **Extend `computeStatusRollup` to treat any-Done-but-not-all as `In Progress`**

**Goal:** Add a single branch to `computeStatusRollup` so that when at least one child status normalizes to `Done` (and the all-done and any-in-progress branches did not match), the helper returns `In Progress` instead of falling through to `Not Started`. Land the matching unit test for the new case and any regression tests that protect the precedence ladder.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** None.

**Files:**
- Modify: `src/engine/status-rollup.js`
- Modify: `test/engine/status-rollup.test.js`
- Optionally modify: `test/routes/status-rollup-route.test.js` — only if adding the recommended route-level scenario for explicit R3 coverage. Existing fixtures will not break (they mock `computeStatusRollup` directly, so the helper change is invisible to them).

**Approach:**
- In `computeStatusRollup`, after the `anyInProgress` check and before the final `return 'Not Started'`, add `const anyDone = statuses.some((s) => s === 'Done'); if (anyDone) return 'In Progress';`. Note: `statuses` inside the helper is already the post-normalization list (`siblings.map((s) => normalizeStatus(...))`), so no additional normalization is needed — `N/A` will already be collapsed to `'Done'` before this check.
- Update the existing "returns Not Started otherwise" test to keep its all-not-started fixture (since that case is unchanged) and add new tests for the partial-done cases.
- Tag the new partial-done test with `BEH-STATUS-ROLLUP-PARTIAL-DONE` so traceability picks it up.
- Optional: add a route-level scenario tagged `BEH-STATUS-ROLLUP-ROUTE-PARTIAL-DONE` that mocks `computeStatusRollup` to return `'In Progress'` and asserts the parent gets patched + Activity Log fires.

**Execution note:** Test-first. Write the partial-done unit test first, watch it fail, then add the helper branch.

**Patterns to follow:**
- The existing precedence-ladder structure of `computeStatusRollup` (early-return per branch, with `normalizeStatus` already collapsing variants).
- Test tagging convention examples: `test/gates/guards.test.js` (e.g., `// @behavior BEH-GUARD-FREEZE` style) and `test/routes/status-rollup-route.test.js` (existing `BEH-PARENT-DIRECT-*` tags at lines 72, 113, 190, 272, 291). The traceability script `scripts/check-behavior-traceability.js` regex-matches `\bBEH-[A-Z0-9-]+\b` across the entire test file content, so any occurrence (description, `it(...)`, comment) is picked up — the `// @behavior BEH-…` comment style is a convention but not enforced.

**Test scenarios:**
- Happy path: `[Done, Not Started]` → `In Progress`. Tagged `BEH-STATUS-ROLLUP-PARTIAL-DONE`.
- Happy path: `[Done, Not Started, Not Started]` → `In Progress` (matches Meg's exact repro from the transcript).
- Edge case: `[N/A, Not Started]` → `In Progress` (N/A normalizes to Done).
- Edge case: `[Done, Done, Not Started]` (all but one done) → `In Progress`.
- Regression — all-done branch unchanged: `[Done, Done]` → `Done`.
- Regression — all-done branch unchanged: `[Done, N/A]` → `Done`.
- Regression — any-in-progress beats partial-done: `[Done, In Progress, Not Started]` → `In Progress` (precedence: in-progress branch fires before partial-done branch; outcome is the same string but the source branch differs).
- Regression — all-not-started case unchanged: `[Not Started, Not Started]` → `Not Started`.
- Regression — empty array: `[]` → `Not Started`.

**Verification:**
- `npm test -- test/engine/status-rollup.test.js` passes with the new tests included.
- `npm test -- test/routes/status-rollup-route.test.js` passes unchanged (route tests mock the helper, so the helper-level change is invisible at this layer).
- If the optional route-level scenario was added: `BEH-STATUS-ROLLUP-ROUTE-PARTIAL-DONE` is registered in the new route test.
- `npm run test:traceability` reports `BEH-STATUS-ROLLUP-PARTIAL-DONE` (and `BEH-STATUS-ROLLUP-ROUTE-PARTIAL-DONE` if added) covered.
- Reading the helper's branching reads as a clear precedence ladder: all-done → done; any-in-progress → in-progress; any-done (partial) → in-progress; else → not-started.

---

- U2. **Document the new rule in ENGINE-BEHAVIOR-REFERENCE.md, CASCADE-RULEBOOK.md (if applicable), and BEHAVIOR-TAGS.md**

**Goal:** Bring the engine's behavior documentation in line with the new rule so future contributors and ops/triage readers see the partial-done case as part of the documented spec.

**Requirements:** R5.

**Dependencies:** U1 (so the rule is real before docs claim it).

**Files:**
- Modify: `docs/ENGINE-BEHAVIOR-REFERENCE.md` — section heading "Status Roll-Up (parent-direct snap-back):" exists at line 51. Insert a new lead bullet at the top of that section documenting the helper's full precedence ladder (so the section accurately covers both branches, not just parent-direct). Then insert a new `### 2026-05-01 — …` H3 changelog section above the existing `### 2026-04-22 — Meg Apr 21 feedback batch` H3 (currently around line 454 — verify before editing).
- Modify: `docs/BEHAVIOR-TAGS.md` — add new section "## 6) Status Roll-Up" between §5 "Dep-Edit Cascade" and current §6 "Current Known Gaps" (renumber Current Known Gaps to §7); register `BEH-STATUS-ROLLUP-PARTIAL-DONE` (plus `BEH-STATUS-ROLLUP-ROUTE-PARTIAL-DONE` if U1 added the route scenario) with a one-line description.
- Modify (only if it documents the rule): `docs/CASCADE-RULEBOOK.md` — grep shows it does not call out the rollup precedence ladder explicitly, but if U2 finds an inline reference, update it to match.

**Approach:**
- In ENGINE-BEHAVIOR-REFERENCE.md, insert a new lead bullet at the top of the "Status Roll-Up (parent-direct snap-back):" section (line 51): something like "**Roll-up algorithm (shared by both branches):** all children `Done`/`N/A` → `Done`; any child `In Progress` → `In Progress`; any child `Done` (partial completion, no `In Progress`) → `In Progress`; otherwise → `Not Started`. Both the parent-direct snap-back and the subtask-triggered roll-up use this precedence ladder via `computeStatusRollup`." Keep the existing parent-direct-specific bullet below it unchanged.
- Insert a new H3 changelog section above the existing `### 2026-04-22 — Meg Apr 21 feedback batch` (line 454): `### 2026-05-01 — Status Roll-Up partial-done` with body "Status Roll-Up rule extended to surface partial completion. Previously a parent with `[Done, Not Started, ...]` children stayed `Not Started`; now it rolls up to `In Progress` whenever at least one subtask is `Done`/`N/A`. Both branches (parent-direct snap-back and subtask-triggered) inherit the change. Tag: `BEH-STATUS-ROLLUP-PARTIAL-DONE`."
- Add a new §6 to BEHAVIOR-TAGS.md modeled on the structure of §5 "Dep-Edit Cascade":
  - Subheading: `Engine helper (\`computeStatusRollup\`):`
  - Tag: `BEH-STATUS-ROLLUP-PARTIAL-DONE: When at least one child status is Done (or N/A) but not all children are complete and none are In Progress, the helper returns In Progress.`
  - If U1 added the route scenario, also add a `Route (\`processStatusRollup\` in \`src/routes/status-rollup.js\`):` subheading with `BEH-STATUS-ROLLUP-ROUTE-PARTIAL-DONE`.
  - Renumber current "Current Known Gaps" from §6 to §7.

**Patterns to follow:**
- The §5 "Dep-Edit Cascade" section structure in BEHAVIOR-TAGS.md (Engine helper subheading, Route subheading; section may grow over time).
- The 2026-04-30 changelog entry style in ENGINE-BEHAVIOR-REFERENCE.md from PR #92.

**Test scenarios:** Test expectation: none — pure documentation update. Verification is reading the diffs against the changed code from U1.

**Verification:**
- `git diff --stat docs/` shows the three doc files modified.
- `npm run test:traceability` continues to pass with the new tag covered (was covered by U1's test).
- ENGINE-BEHAVIOR-REFERENCE.md §51 prose accurately describes the post-U1 behavior.
- BEHAVIOR-TAGS.md numbering is contiguous: §1 through §7 with §7 being "Current Known Gaps".

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A PM or downstream Notion automation depends on a parent staying `Not Started` until all children move to `In Progress` or `Done`. | Low risk — Meg explicitly requested the new behavior on 2026-05-01 and has tested the existing two cases that work. Roll-out via merge + post-deploy validation on a sandbox study (same playbook as PR #92). If a downstream automation breaks, the rollback is a one-line revert in the helper. |
| R3 ("both route branches inherit") is verified by code inspection only, since `test/routes/status-rollup-route.test.js` mocks `computeStatusRollup` per scenario and never exercises the real helper. | Add the optional route-level scenario in U1 (`BEH-STATUS-ROLLUP-ROUTE-PARTIAL-DONE`) for explicit test coverage. If skipped, accept code-inspection verification — the route uses the helper's return value directly with no intervening logic. |
| Grandparent gaps become more visible after this change. Once middle parents start flipping from `Not Started` to `In Progress` under the new partial-done rule, PMs may notice that grandparents do not also roll up — exposing the pre-existing bot-echo guard limitation in the parent-direct branch. | Pre-existing limitation, not introduced by this plan. The grandparent gap is documented behavior (`test/routes/status-rollup-route.test.js:310-371`). If PM testing surfaces it as blocking, scope a separate follow-up plan that addresses re-entry semantics carefully (the bot-echo guard exists for a reason — patch storms). Not blocking for this PR. |

---

## Documentation / Operational Notes

- Post-deploy: run a quick sandbox check on a study with any parent task that has 2-3 leaf subtasks. Mark one leaf `Done`, observe the parent flips to `In Progress` (Activity Log entry should show `cascadeMode: 'status-rollup'`, `direction: 'subtask-triggered'`, `oldStatus: 'Not started'`, `newStatus: 'In Progress'`).
- No data backfill needed. The rule applies on the next status-change webhook per task; existing parents will naturally converge as PMs move children.
- No feature flag — single-helper change, fully covered by tests, low blast radius.

---

## Sources & References

- Slack / Zoom call: 2026-05-01 PM check-in with Meg Sanders (PicnicHealth PM). Transcript captured in conversation context (key quotes: 02:35-02:45 and 02:48 confirmation).
- Related code: `src/engine/status-rollup.js`, `src/routes/status-rollup.js`, `test/engine/status-rollup.test.js`, `test/routes/status-rollup-route.test.js`.
- Related docs: `docs/ENGINE-BEHAVIOR-REFERENCE.md` §51 (parent-direct snap-back), §173 (event shape), §459 (2026-04-22 changelog).
- Related plan: `docs/plans/2026-04-30-002-fix-dep-edit-parent-rollup-plan.md` (parent date roll-up, shipped via PR #92 on 2026-04-30 — analogous structure for the date dimension).
- Pulse log: `engagements/picnic-health/pulse-log/04.30/006-dep-edit-parent-rollup-v2-shipped.md`.
