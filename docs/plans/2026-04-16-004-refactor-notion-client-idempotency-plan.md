---
title: "refactor: Client-layer idempotency for Notion writes (SUPERSEDED — probe approach ruled out)"
type: refactor
status: superseded
date: 2026-04-16
superseded_on: 2026-04-20
superseded_by:
  - engine/docs/plans/2026-04-20-001-fix-inception-with-study-lock-plan.md
  - engine/docs/plans/2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md
  - engine/docs/plans/2026-04-20-003-feat-post-flight-duplicate-sweep-plan.md
origin: clients/picnic-health/pulse-log/04.16/001-meg-apr-16-feedback-batch.md (re-investigation section)
---

> **SUPERSEDED 2026-04-20.** This plan proposed probe-on-retry idempotency. Empirical measurement showed Notion's filtered-query index lags POST `/pages` commits by up to 15.4s (p95 6–11s, worse under concurrency). Probes would routinely return false negatives → retry → duplicate created → same bug the plan was trying to fix.
>
> Activity Log retry frequency was then measured: **5.4% overall, ~22% on 200-task inceptions**. Both retry-firing runs succeeded, each a candidate for a silent duplicate. Estimated 5–20 existing duplicates across active studies.
>
> Replaced by three sequenced PRs targeting a **narrow retry + post-flight sweep** architecture. See `superseded_by` frontmatter above.
>
> Original plan content preserved below for reference.

---


# PR E — Client-Layer Idempotency for Notion Writes

## Overview

Add a generalized idempotency primitive at the `NotionClient` layer so retries of non-idempotent Notion writes (POST `/pages`, POST `/blocks/:id/children`) do not create server-side duplicates when Notion returns a transient error *after* it has already committed the write. Also includes a one-time historical dedup sweep on existing studies to clean up any latent duplicates that shipped before this fix.

## Problem Frame

**The bug Meg caught.** During her 2026-04-16 live test, inception reported 200 tasks created but the Study Tasks DB showed 201 — a silent duplicate of "Delivery Retrieval Wrap-Up Window 10". Both duplicates were created at 17:29 by tokens in the shared `provision` pool.

**Why the first investigation's conclusion was wrong.** Investigation #1 (2026-04-16 afternoon) concluded the duplicate was from an Add Task Set button click because the `created_by.id` mapped to "Additional Task Set Creation 4" — a bot name that suggested the Add Task Set workflow. That conclusion was incorrect: the `provision` token pool contains all 10 bots ("Study Activation Token 1–5" + "Additional Task Set Creation 1–5"), and inception round-robins across all 10. Bot name does not identify workflow origin.

**The actual root cause** (re-investigation, 2026-04-16 evening): `NotionClient._requestWithSlot` retries POST `/pages` on 429/5xx and network timeouts. Notion's POST `/pages` is not idempotent — when Notion returns a transient 5xx after the backend has already committed the write, the retry creates a second identical page. The client only counts the second (successful) response as the created page. Evidence from the inception Activity Log: `retryStats: { count: 1, totalBackoffMs: 551 }` during the 31-second create phase.

**Why this matters beyond Meg's case.** This "at-least-once write with no idempotency key" pattern can produce silent duplicates in *any* call that hits a 5xx/timeout mid-retry. Inception, add-task-set, and copy-blocks are all exposed. Studies that already ran any provisioning with `retryStats.count > 0` may have latent duplicates nobody has noticed. PR #62's single-leaf duplicate guard defensively catches single-leaf shapes but doesn't address the root cause.

## Requirements Trace

- **R1.** POST `/pages` retries cannot create server-side duplicates when Notion returns a 5xx/timeout after a successful write.
- **R2.** POST `/blocks/:id/children` retries (used by copy-blocks) cannot append the same blocks twice on transient failure.
- **R3.** The idempotency mechanism is a generalized primitive at the `NotionClient` layer — callers opt in by supplying a probe function, not by scattering retry-specific logic through route handlers.
- **R4.** Retries that hit a 429/5xx *before* the write committed still succeed on the next attempt (current behavior preserved — we're not disabling retry, we're making it idempotent).
- **R5.** If the probe itself fails (e.g., DB unreachable), the client surfaces the error rather than silently dropping the write. Better to fail loudly than to skip a legitimate create.
- **R6.** All existing studies are swept once for latent duplicates (Template Source ID appearing twice in the same study). Any found are archived with a trace. Before this PR ships, document the current duplicate count per study so the sweep's impact can be audited.
- **R7.** `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` documents the new idempotency guarantee so future maintainers understand the contract.
- **R8.** Tem's Apr 16 pulse log is updated with the re-investigation narrative correcting Investigation #1's conclusion.

## Scope Boundaries

- **No change** to PATCH semantics — PATCH is naturally idempotent for same-body retries; not touching that path.
- **No change** to DELETE/archive semantics — already idempotent at Notion.
- **No change** to queries (GET) — read operations have no duplication risk.
- **No change** to route handlers' error-handling, comment flow, or Activity Log.
- **No change** to the provision token pool composition or bot-name labeling. (The shared pool is a legitimate architectural choice; the fix is in client logic, not pool segmentation.)
- **No change** to the existing `withStudyLock` per-study serialization (PR #56 territory).
- **No change** to blueprint data or Notion workspace properties beyond the dedup sweep's archive actions.
- **Not in scope:** adding idempotency keys as a Notion API header (Notion doesn't support `Idempotency-Key` on POST `/pages` — our strategy is probe-based, not API-header-based).
- **Not in scope:** backpressure or rate-limit refactoring. The existing 9 req/s/token throttle + 5-attempt retry envelope stays.
- **Not in scope:** PR #62's single-leaf duplicate guard. It stays as defensive belt-and-suspenders; this PR addresses the upstream root cause.

## Context & Research

### Relevant Code and Patterns

- `engine/src/notion/client.js` — the `NotionClient` class. `_requestWithSlot` (around lines 65–117) is the retry loop that currently creates the duplicate. `createPages` calls through to `_requestWithSlot` with POST `/pages`. `appendBlockChildren` (if the method exists — verify at implementation time) uses the same retry path for blocks. `patchPages` uses the same retry, but PATCH is safe.
- `engine/src/notion/clients.js` — instantiates `cascadeClient`, `provisionClient`, `deletionClient`, `commentClient`. Pool composition is unchanged by this PR.
- `engine/src/provisioning/create-tasks.js` — `createStudyTasks` calls `client.createPages` in the per-level loop (around line 249). The caller already has `Template Source ID` (`_templateId`) and `Study Page ID` available at the call site — this is the correlation key we need.
- `engine/src/routes/inception.js:144` — calls `createStudyTasks`. Passes `studyPageId`, `contractSignDate`, etc. Need to thread the probe or idempotency option through.
- `engine/src/routes/add-task-set.js:375` — same call pattern.
- `engine/src/provisioning/copy-blocks.js` or `engine/src/routes/copy-blocks.js` (verify actual path) — the async block-copy handler. POST `/blocks/:id/children` is called per page. Probe strategy differs from page creation because blocks are ordered and positional.
- `engine/test/notion/client.test.js` (if exists, else create) — the right home for idempotency primitive tests. Mock a 5xx-after-write pattern by controlling the mocked `fetch` (or whatever HTTP layer `_requestWithSlot` uses).
- `engine/test/provisioning/create-tasks.test.js` — integration tests for the create flow with idempotency plumbed through.
- `engine/src/services/activity-log.js` — emits `retryStats` into the Activity Log event details. Today it counts retries; after this PR, it should additionally emit any "probe prevented duplicate create" events so we can see the fix working in production.

### Institutional Learnings

- **Re-investigation report (2026-04-16 evening)** — establishes the root cause and rules out alternative hypotheses (blueprint dedup, bot-identity correlation, post-inception button clicks). Included in detail in the Apr 16 pulse log (section TBD after this plan ships).
- **Investigation #1 report (2026-04-16 afternoon)** — the wrong conclusion. Preserved in the pulse log with an explicit correction marker so future readers understand why the initial fix (PR #62 single-leaf guard) was necessary-but-insufficient.
- **PR #62 (single-leaf duplicate guard)** — already merged. Provides a belt-and-suspenders guard against any single-leaf duplicate shape regardless of root cause. Does not address the retry-without-idempotency bug. Stays in place.
- **PR #43 (2026-04-11 reliability fixes)** — `pulse-log/04.11/003-pr43-reliability-fixes-and-ideation.md` documents the 30s fetch timeout + 2-attempt cap on timeout. Idempotency work here intersects because retry-on-timeout is one of the specific paths that can double-write.
- **Notion API idempotency limitations** — Notion does not support `Idempotency-Key` headers on POST endpoints. The only correct strategy is client-side probe-then-create.

### External References

- Notion API reference for [creating pages](https://developers.notion.com/reference/post-page) and [appending block children](https://developers.notion.com/reference/patch-block-children) — both documented as non-idempotent.
- General HTTP idempotency patterns: Stripe's Idempotency-Key approach is the industry reference. Since Notion doesn't accept that header, we emulate the semantic at the client layer via probe.

## Key Technical Decisions

- **Probe-based idempotency over header-based.** Notion doesn't support idempotency headers. The client's retry loop accepts an optional `probe` callback from the caller. On retryable failure, before retrying, the client calls `probe()` which returns either `{ alreadyCreated: true, result: <existing> }` (skip retry, return that result) or `{ alreadyCreated: false }` (proceed with retry). Keeps the semantic general.
- **Callers own probe definition.** `create-tasks.js` knows that `Template Source ID + Study` uniquely identifies a task within a study — it supplies the probe. The client doesn't know business semantics. This keeps the client layer generic and avoids special-casing Notion DBs inside the client.
- **Probe only runs after a retryable failure.** On first attempt, no probe overhead. On first retry, probe checks if the write already landed. If yes, short-circuit. If no, retry normally. Subsequent retries (up to the existing 5-attempt cap) use the probe before each retry.
- **Probe failure is loud.** If the probe itself throws (e.g., Notion unreachable when we need to check), the client surfaces the error instead of retrying the original write blindly. Better to fail a single study's provisioning than to risk silent duplicates OR silent drops. Callers can treat probe failure the same as any other provisioning failure.
- **Separate primitive for block append.** POST `/blocks/:id/children` has different idempotency semantics — order matters, existing blocks on the page form the probe's state. The probe strategy: on retry, query the page's existing block children, check whether the tail matches what we intended to append. If yes, treat as already done. If no, retry. This is more complex than task probe, so block-append gets its own helper.
- **Historical dedup sweep runs once, produces a report.** Script-style, not a recurring cron. Scans Study Tasks DB per active study, groups by Template Source ID, reports + archives duplicates. Run manually (Tem or Seb) post-merge. Output saved to `clients/picnic-health/pulse-log/04.16/NNN-idempotency-historical-sweep.md`.
- **No new schema additions.** We reuse existing Template Source ID + Study relation as the correlation key for task probes. No new property to add on DBs, no migration.
- **Retry attempt cap unchanged** — still 5 attempts (or 2 for timeouts per PR #43). The probe short-circuits retries; it doesn't extend the envelope.
- **Tests use a controlled mock.** We introduce a fixture that simulates "Notion 5xx after write committed" by mocking the fetch layer: first call returns 502, but a follow-up read shows the page exists. This locks the regression semantic.

## Open Questions

### Resolved During Planning

- **Scope of endpoints to cover:** POST `/pages` and POST `/blocks/:id/children`. PATCH and DELETE excluded.
- **Correlation key for tasks:** Template Source ID + Study Page ID. Already available at the caller.
- **Where probe lives:** supplied by caller, invoked by client. Keeps client layer generic.
- **Historical dedup scope:** all active (non-archived) studies via Studies DB query, limited to Study Tasks DB. Other DBs (e.g., Activity Log) not swept — low duplicate risk, tolerate if any.
- **Rollback strategy:** if idempotency breaks legitimate writes, revert this PR and rely on PR #62's guard + the dedup sweep findings. Probe logic is isolated enough that a targeted revert is safe.

### Deferred to Implementation

- **Exact signature of `probe`.** Likely `async (): Promise<{ alreadyCreated: boolean, result?: any }>`. Final shape resolves when wiring the caller.
- **How to detect "retryable" vs "non-retryable" failure.** Current client treats 429, 5xx, and some network errors as retryable. No change intended, but implementer should verify the exact classification is unchanged.
- **Where to emit the "probe short-circuited retry" telemetry.** Likely alongside `retryStats` in the Activity Log event details. Exact field name decided at implementation time.
- **Block-append probe details.** Appending N blocks to a page — how do we check "did the first N of the tail match what we tried to append?" Implementer may need to stash the intended block payload alongside the request and compare after retry. If this turns out to be too complex, consider falling back to "disable retry for block-append, surface the error" as an interim.
- **Historical sweep — should it run automatically once on next deploy, or only on manual trigger?** Lean manual for safety. Implementer confirms with Tem before shipping the sweep script.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Caller (createStudyTasks) calls:
  client.createPages(body, {
    probe: async () => {
      existing = await queryDB(studyTasksDbId, {
        filter: { and: [
          { property: 'Template Source ID', rich_text: { equals: tsid } },
          { property: 'Study', relation: { contains: studyPageId } }
        ]}
      })
      if (existing.length > 0) return { alreadyCreated: true, result: existing[0] }
      return { alreadyCreated: false }
    }
  })

Inside _requestWithSlot:
  attempt 1: POST /pages
    success → return result
    retryable error → hold for retry
    non-retryable error → throw
  
  before attempt 2:
    if (probe supplied):
      probeResult = await probe()
      if (probeResult.alreadyCreated):
        emit telemetry: 'probe_short_circuited_retry'
        return probeResult.result  ← idempotency semantic achieved
    attempt 2: POST /pages
    ...same pattern up to retry cap
```

**Key invariants:**
- Probe runs at most once per retry interval, not on first attempt.
- Probe failure → surfaces as client error (no silent retry-without-probe).
- No probe supplied → existing retry behavior preserved exactly (backward compatible for callers that don't opt in).
- Successful probe short-circuit → telemetry emitted so we can see the fix working in production logs.

**Historical dedup flow (Unit 5):**

```
for each active Study in Studies DB:
  tasks = queryDB(studyTasksDbId, filter: { Study contains studyId })
  groups = group tasks by Template Source ID
  for each group with len > 1:
    keep = group with the earliest created_time and wired relations
    duplicates = group - {keep}
    report duplicate IDs + study info
    if --archive flag: archive each duplicate
    else: dry-run output only
```

Run dry-run first. Tem reviews the report. Then run with `--archive` if safe.

## Implementation Units

- [ ] **Unit 1: Extend `NotionClient._requestWithSlot` with probe primitive**

**Goal:** Add the generic `probe` option to the client's retry loop. No caller changes yet — this is the primitive.

**Requirements:** R1 (foundation), R5, R3.

**Dependencies:** None.

**Files:**
- Modify: `engine/src/notion/client.js`
- Test: `engine/test/notion/client.test.js`

**Approach:**
- Extend the options bag accepted by `_requestWithSlot` (and `createPages`, which wraps it) to accept an optional `probe: () => Promise<{alreadyCreated: boolean, result?: any}>`.
- Inside the retry loop, before invoking `fetch` on any attempt after the first, check if `probe` is supplied. If yes, await it. If `alreadyCreated` is true, return `probeResult.result` immediately without retrying. If the probe itself throws, let the throw propagate (don't swallow).
- Emit a telemetry event (or console log, or via the existing `retryStats` mechanism) whenever a probe short-circuits a retry. Exact emission channel decided at implementation time — must be observable in Railway logs and/or Activity Log.
- Preserve existing behavior exactly when `probe` is not supplied. This is additive — no existing caller breaks.

**Patterns to follow:**
- Existing `_requestWithSlot` shape at `engine/src/notion/client.js:65-117`.
- Existing `retryStats` emission pattern (wherever it's tracked — implementer verifies).

**Test scenarios:**
- **Happy path — first attempt succeeds:** `_requestWithSlot` called with a probe. First fetch succeeds. Probe never invoked. Returns result.
- **Happy path — retryable failure then success, no probe:** First fetch returns 502. No probe supplied. Second fetch succeeds. Existing behavior preserved. Returns second-attempt result.
- **Probe short-circuits retry after 5xx:** First fetch returns 502 (retryable). Probe supplied, returns `{alreadyCreated: true, result: X}`. Client returns `X` without attempting a second fetch.
- **Probe short-circuits retry after timeout:** First fetch times out. Probe returns `{alreadyCreated: true, ...}`. Retry suppressed.
- **Probe returns not-already-created, retry proceeds:** First fetch 502. Probe returns `{alreadyCreated: false}`. Second fetch succeeds. Return second-attempt result.
- **Edge — probe itself throws:** First fetch 502. Probe throws "DB unreachable". Client surfaces the probe error (does not retry blindly).
- **Edge — retry cap reached:** First + second + third fetch all 502. Probe returns `{alreadyCreated: false}` each time. Client hits retry cap, throws final error.
- **Edge — non-retryable error:** First fetch returns 400 (bad request). Probe not invoked (retry path not entered). Error propagates immediately.
- **Telemetry:** any probe short-circuit emits an observable event (log line or stat) so production can verify the fix is firing.

**Verification:**
- `npm run test:ci` passes, including all new `_requestWithSlot` scenarios.
- Code review confirms the `probe` option is purely additive — callers without it see no behavior change.

- [ ] **Unit 2: Thread probe through `createStudyTasks` for task creation**

**Goal:** Make `createStudyTasks` supply a probe per-page-create so inception and add-task-set retries become idempotent.

**Requirements:** R1, R3.

**Dependencies:** Unit 1.

**Files:**
- Modify: `engine/src/provisioning/create-tasks.js`
- Test: `engine/test/provisioning/create-tasks.test.js`

**Approach:**
- For each page about to be created, construct a probe closure that queries Study Tasks DB by `Template Source ID = task._templateId` AND `Study relation contains studyPageId`. If a row exists, return `{alreadyCreated: true, result: <existing page>}`. Otherwise `{alreadyCreated: false}`.
- Pass this probe into `client.createPages` alongside the page body.
- Existing error paths (e.g., missing Contract Sign Date guard added in PR D) remain unchanged.
- Preserve the existing per-level sequencing and `accumulateIdMappings` pattern.

**Patterns to follow:**
- `existingIdMapping` pattern at `engine/src/routes/add-task-set.js:283-287` — shows the query shape for TSID lookup.
- `create-tasks.js:249-253` — current `createPages` call site.

**Test scenarios:**
- **Happy path — no prior page, first attempt succeeds:** probe returns `{alreadyCreated: false}` (would-be invoked only on retry). Create succeeds. Task created once.
- **Simulated 502-after-write:** fetch mock returns 502 on first attempt but the DB query shows the page exists. Probe returns `{alreadyCreated: true, result: <page>}`. Create returns that existing page. DB ends up with exactly one page.
- **Simulated 502-before-write:** fetch mock returns 502, but the DB query shows no page exists. Probe returns `{alreadyCreated: false}`. Retry proceeds. Create succeeds on second attempt. DB has one page.
- **Edge — probe fails:** DB query throws. `createStudyTasks` surfaces the error upward; `inception.js` / `add-task-set.js` catch it and route through the existing failure path (Automation Reporting + study comment).
- **Edge — multiple concurrent creates for different tasks:** two tasks with different TSIDs created in parallel. Each has its own probe. Both probes correctly isolate.
- **Regression — existing tests pass:** all current `create-tasks.test.js` scenarios still green.

**Verification:**
- `npm run test:ci` passes.
- A new integration test that simulates the 502-after-write scenario passes.

- [ ] **Unit 3: Historical dedup sweep (one-time script)**

**Goal:** Find and optionally archive any duplicate tasks already sitting in production studies due to pre-PR-E retry bugs.

**Requirements:** R6.

**Dependencies:** None (independent of Units 1–2; can run before or after).

**Files:**
- Create: `engine/scripts/dedup-study-tasks.js` (new script directory if needed)
- Create: `engine/docs/plans/2026-04-16-004-dedup-sweep-findings.md` (or a pulse log entry; decide at implementation time)

**Approach:**
- Script accepts `--dry-run` (default) and `--archive` flags.
- Queries Studies DB for all active (non-archived) studies.
- For each study, queries Study Tasks DB filtered to that study.
- Groups tasks by `Template Source ID`. Any group with >1 entries is reported.
- Keep-rule: keep the task with the earliest `created_time` AND with `Parent Task` / `Blocked by` / `Blocking` relations wired. Archive the others.
- Produces a report listing each study, each duplicate group, and which tasks would be/were archived.
- Under `--archive`, uses the `NotionClient.archivePage` call per duplicate.

**Patterns to follow:**
- Existing query shape in `add-task-set.js:146-156`.
- Archive pattern from `routes/deletion.js` (reuse the archive helper).

**Test scenarios:**
- **Happy path — no duplicates in the target study:** report empty for that study.
- **Happy path — one duplicate found:** report shows TSID, both page IDs, `created_time`s, and which would be kept vs archived.
- **Edge — all duplicates have identical `created_time` and both wired:** keep-rule falls back to lower `page.id` lexicographically (or earliest unique id). Documented deterministically.
- **Edge — duplicate TSID where one has empty relations and one is wired:** wired one kept; orphan archived.
- **Dry-run vs archive:** dry-run reports without mutating; archive mutates.
- **Edge — archive fails mid-sweep:** script reports partial progress; doesn't crash the rest of the sweep.

**Verification:**
- Dry-run on a test study produces expected report.
- Under `--archive`, target study has exactly the expected set of tasks post-run.
- Tem reviews the dry-run output before running `--archive`.

**Execution note:** Run dry-run first across all studies. Hand Tem the report. Only run `--archive` after Tem confirms.

- [ ] **Unit 4: Copy-blocks idempotency (POST `/blocks/:id/children`)**

**Goal:** Apply the idempotency primitive to the block-append flow used by copy-blocks. Prevents duplicate blocks on pages when Notion returns a transient error after appending.

**Requirements:** R2.

**Dependencies:** Unit 1 (primitive).

**Files:**
- Modify: `engine/src/routes/copy-blocks.js` (or wherever block-append is called — verify path)
- Modify: `engine/src/notion/client.js` if block-append needs a specialized probe helper
- Test: `engine/test/routes/copy-blocks.test.js`

**Approach:**
- Probe strategy for block append: before retrying, query the target page's existing block children. Check if the tail of the existing blocks matches what we intended to append (by position and by block content signature). If yes, `{alreadyCreated: true, result: <existing tail>}`. If no, retry.
- Content signature: hash the intended append payload (block type + text content). Compare against the last N blocks of the target page.
- **If block-append idempotency proves too complex in practice, fall back to** "disable retry for block-append, surface the error to route handler, let it decide." Route handler can report the partial failure via Automation Reporting and a study-page comment. Document the decision in the code and in the L2 doc.

**Patterns to follow:**
- Unit 1's probe pattern.
- Existing `appendBlockChildren` invocation (verify name and location at implementation time).

**Test scenarios:**
- **Happy path — no retry needed:** first append succeeds. Probe not invoked.
- **Retry after 502-before-write:** probe shows append didn't land. Retry proceeds. Correct final state.
- **Retry after 502-after-write:** probe shows the tail of the page matches the intended append. Probe short-circuits. Blocks not duplicated.
- **Edge — partial write (some blocks appended, some not):** probe detects partial match. Falls back to either completing the remaining blocks or surfacing an error. Document which behavior is chosen.
- **Edge — page has non-appended blocks at the tail that happen to look similar:** probe's content hash must be specific enough to avoid false positives. Include a unique sentinel in the append payload if needed.

**Execution note:** This unit is the most complex of the plan. If the probe strategy doesn't converge within reasonable time, ship the fallback (disable retry, surface error) and file a follow-up issue.

**Verification:**
- `npm run test:ci` passes.
- Copy-blocks flow tested end-to-end with a simulated 502-after-write — no duplicate blocks appear on target pages.

- [ ] **Unit 5: Documentation — L2 behavior ref + pulse log correction**

**Goal:** Document the new idempotency guarantee in `ENGINE-BEHAVIOR-REFERENCE.md` and correct the Investigation #1 conclusion in the Apr 16 pulse log.

**Requirements:** R7, R8.

**Dependencies:** Units 1–2 (the primary behavior change).

**Files:**
- Modify: `engine/docs/ENGINE-BEHAVIOR-REFERENCE.md` (add a new section or sub-section under existing reliability content)
- Modify: `clients/picnic-health/pulse-log/04.16/001-meg-apr-16-feedback-batch.md` (add a "Re-investigation correction" section)

**Approach:**
- In the behavior ref, add a section (probably under the existing Section 7–9 reliability cluster) titled "Client-Layer Idempotency". Document:
  - Which endpoints are covered (POST `/pages`, POST `/blocks/:id/children`).
  - The probe contract callers use.
  - That PATCH/DELETE are naturally idempotent.
  - The observable signal when a probe short-circuits (for ops).
- In the pulse log, add a "Correction — Investigation #1 was wrong about Item 1 root cause" subsection. Explain:
  - The original bot-identity argument fell apart because `provision` pool shares bots between inception and add-task-set.
  - The real root cause is retry-without-idempotency.
  - PR E ships the proper fix.
  - PR #62's single-leaf guard stays as belt-and-suspenders.

**Patterns to follow:**
- Existing behavior ref sections on webhook auth (Section 7), graceful shutdown (Section 8), Import Mode sweep (Section 9).
- Existing pulse log format.

**Test scenarios:** Test expectation: none — docs-only change.

**Verification:**
- Grep the docs for consistent terminology.
- Tem reads and confirms the correction is honest and clear.

- [ ] **Unit 6: Activity Log observability for probe events**

**Goal:** When a probe short-circuits a retry, emit an observable event so we can see the fix working in production.

**Requirements:** R1 (verification), observability follow-through.

**Dependencies:** Unit 1.

**Files:**
- Modify: `engine/src/services/activity-log.js` (or wherever `retryStats` lives)
- Test: `engine/test/services/activity-log.test.js` (if idempotency telemetry is emitted through this service)

**Approach:**
- Extend the existing `retryStats` emission or add a sibling `idempotencyStats` field on the Activity Log event details. Fields: `{probeInvocations, probeShortCircuits, probeErrors}`. Counter-style integers.
- Only emit when non-zero (avoid noise on successful first-attempt flows).
- Increment from inside `_requestWithSlot` whenever a probe fires. Expose a way for the client to pass accumulated stats to the caller (e.g., via the returned result object or an out-parameter the caller reads after the call).

**Patterns to follow:**
- Existing `retryStats` emission (implementer verifies location).

**Test scenarios:**
- **Happy path — no probe fired:** `idempotencyStats: { probeInvocations: 0, probeShortCircuits: 0, probeErrors: 0 }` (or omitted entirely).
- **Probe short-circuits once:** stats show `{probeInvocations: 1, probeShortCircuits: 1}`.
- **Probe runs and retry proceeds:** `{probeInvocations: 1, probeShortCircuits: 0}`.
- **Probe throws:** `{probeErrors: 1}`.

**Verification:**
- Activity Log entries in a post-deploy test visibly carry the new field when a retry occurs.

## System-Wide Impact

- **Interaction graph:** `NotionClient._requestWithSlot` is called by every write path — this PR touches the shared choke point. Affected: inception, add-task-set, copy-blocks, cascade (patch-only so unaffected), deletion (archive-only so unaffected), status-rollup, undo-cascade, study-comment. Only inception / add-task-set / copy-blocks actively create new pages or blocks, so they're the only ones gaining new probe behavior. Others pass through the unchanged `patchPages` / archive paths.
- **Error propagation:** probe failure throws into the calling route's existing try/catch. Route handlers already route provisioning errors to Automation Reporting + study comment. No new error channel needed.
- **State lifecycle risks:** the probe itself is a read — no state mutation. The risk is if probe returns a false positive (`alreadyCreated: true` when the page was actually NOT created), a legitimate write gets dropped. This is the reason for extensive Unit 1 tests covering the edge cases and for the telemetry in Unit 6 so we can audit production behavior.
- **API surface parity:** no external API changes. Webhook contracts unchanged. Notion API usage unchanged except for the new read-before-retry pattern.
- **Integration coverage:** requires end-to-end test of a simulated 502-after-write scenario on both `/pages` and `/blocks/:id/children`. Unit-level mocks cover the logic; integration-level covers the real flow through route handlers.
- **Unchanged invariants:** existing retry cap, 9 req/s throttle, token pools, LMBS, Import Mode, withStudyLock, cascadeQueue, FlightTracker, graceful shutdown, startup Import Mode sweep — all preserved exactly. Complete Freeze, cascade semantics, parent-subtask roll-up — untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Probe returns false positive (says "alreadyCreated" for a task that wasn't created) — drops a legitimate write | Extensive Unit 1 tests + Unit 6 telemetry + dry-run mode for the sweep. Probe's query uses exact-match filters (TSID + Study) which are hard to spoof. |
| Probe itself is slow or times out, adding latency to every retry | Probe is only invoked on retry, not first attempt. At steady state (no retries), probe overhead is zero. Probe call inherits the same 30s fetch timeout envelope from PR #43. |
| Block-append probe logic (Unit 4) turns out to be too complex or too fragile | Explicit fallback in Unit 4: disable retry on block-append and surface the error. Ship interim, follow up with better probe later. |
| Historical dedup sweep archives a legitimate non-duplicate due to unexpected data shape | Dry-run mandatory first, Tem reviews the report, `--archive` only runs after confirmation. Keep-rule is explicit and documented. |
| PR E breaks an existing caller that implicitly relied on retry-creates-duplicates (unlikely but theoretically possible) | Grep all callers of `createPages` / `appendBlockChildren`. None should rely on retry duplication — that would be the bug, not a feature. Verify at implementation time. |
| Telemetry emission adds noise to Activity Log | Only emit when non-zero. Stats are small counter integers, negligible payload size. |

## Documentation / Operational Notes

- **Pulse log.** Post-merge, update `clients/picnic-health/pulse-log/04.16/001-meg-apr-16-feedback-batch.md` (or append a new pulse log entry `04.17/NNN-pr-e-client-idempotency.md`) with:
  - The re-investigation correction.
  - The PR E fix summary.
  - Results from the dry-run sweep.
- **Production rollout.** Railway auto-deploys on merge. No feature flag. Post-deploy, monitor the first 5–10 provisioning Activity Log entries for `idempotencyStats` fields — confirm the probe is wired correctly (zero short-circuits on healthy runs; non-zero stats correlate with concurrent `retryStats`).
- **Historical sweep.** Manual execution post-merge. Dry-run first, Tem reviews, then `--archive`. Document results in the pulse log.
- **Seb handoff context.** Seb is investigating Bug α (Issue #61) independently. This PR E is orthogonal to Bug α but touches the same client layer — worth mentioning in a comment on Issue #61 so Seb knows the client's retry semantics are changing.

## Sources & References

- **Re-investigation report (2026-04-16 evening):** embedded in Apr 16 pulse log; also in the Claude conversation log that produced this plan.
- **Investigation #1 report (2026-04-16 afternoon, since corrected):** same pulse log location; preserved with a correction marker.
- **Related shipped work:**
  - PR #62 (provisioning safety batch, `34bea9f`) — single-leaf duplicate guard stays as defensive complement.
  - PR #43 (reliability fixes, 2026-04-11) — 30s fetch timeout + 2-attempt timeout cap.
  - PR #56 (withStudyLock serialization) — per-study FIFO still protects against parallel writes within a study.
- **Related code:**
  - `engine/src/notion/client.js` — the retry loop that creates duplicates today.
  - `engine/src/notion/clients.js` — pool composition, unchanged.
  - `engine/src/provisioning/create-tasks.js` — the primary caller.
  - `engine/src/routes/inception.js` + `engine/src/routes/add-task-set.js` — higher-level callers.
  - `engine/src/routes/copy-blocks.js` — block-append caller (Unit 4 target).
- **External:**
  - [Notion API `POST /pages`](https://developers.notion.com/reference/post-page) — no idempotency header support, documented.
  - [Notion API `PATCH /blocks/:id/children`](https://developers.notion.com/reference/patch-block-children) — same.
- **Issue #61 (Bug α to Seb):** orthogonal but touches the same client layer; add a courtesy comment when this PR lands.
