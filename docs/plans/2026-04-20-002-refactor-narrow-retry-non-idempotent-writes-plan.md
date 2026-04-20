---
title: "refactor: Path-based narrow retry for non-idempotent Notion writes"
type: refactor
status: active
date: 2026-04-20
revised: 2026-04-20 (post document-review — flipped from opt-in to opt-out architecture)
origin: engine/docs/plans/2026-04-16-004-refactor-notion-client-idempotency-plan.md (superseded probe-based plan)
---

# PR E1 — Path-Based Narrow Retry for Non-Idempotent Writes

## Overview

`_requestWithSlot`'s retry loop classifies Notion errors by `method + path`. For non-idempotent write endpoints (POST `/pages`, PATCH `/blocks/:id/children`), errors that may have caused a server-side commit (5xx responses, post-send timeouts) are **surfaced** immediately instead of retried — eliminating the dominant source of silent duplicates at the source. For all other methods/paths (PATCH existing pages, DELETE, GET queries, etc.), retry behavior is unchanged — existing wide retry preserved.

This is **path-based opt-out**, not flag-based opt-in — classification happens automatically in the client. A future developer adding a new POST `/pages` call site cannot forget to opt in; the client's classifier recognizes the path and applies the correct policy. No caller-side flag required for the common case.

Ships second in the PR E0/E1/E2 sequence. Depends on PR E0 (shared `withStudyLock`) for race-safety of surfaced errors against in-flight concurrent operations.

## Problem Frame

`engine/src/notion/client.js:65-117` `_requestWithSlot` retries up to 5× on any 429, any 5xx, and a broad class of network errors — regardless of which endpoint it's calling. For endpoints where Notion commits writes before acknowledging (POST `/pages`, PATCH `/blocks/:id/children` appends), a 5xx response after successful commit causes the retry to create a duplicate. The client counts only the retry's response, so the engine doesn't know a duplicate exists.

Measured behavior (2026-04-20 Activity Log investigation, n=37 measurable success runs):
- Overall retry rate: 5.4%
- Inception (200-task runs): 22.2% (2 of 9)
- Add-task-set: 0% (0 of 27)
- Deletion: 0% (1 of 1)

Both retry-firing inceptions succeeded → both are silent-duplicate candidates. Estimated 5–20 existing duplicates across active studies.

**Architecture decision (revised 2026-04-20):** the original plan proposed a flag-based opt-in (`nonIdempotent: true` passed by callers). Document-review argued this fails silent — a new POST `/pages` call site that forgets the flag produces silent duplicates. Path-based classification at the client layer is the safer default: fails loud (surfaces errors) for any unflagged new caller that happens to touch an unsafe path.

The empirical consistency experiment (2026-04-16) ruled out probe-on-retry (Notion filtered queries lag POST commits by p95 6–11s, max 15.4s). The fix has to be *preventive* at the retry layer, not *reactive* via queries. Path-based narrow retry is the preventive piece; PR E2's sweep is the reactive safety net.

## Requirements Trace

- **R1-1.** Classify errors into three buckets: `safe_retry` (429, pre-send network errors — Notion never saw the request), `unsafe_retry` (5xx after request sent, post-send timeouts — Notion may have committed), `non_retryable` (4xx, malformed request — no point retrying).
- **R1-2.** Classify operations by `method + path` into `nonIdempotent` vs `idempotent`. Path-based, automatic, no caller flag required in the common case.
  - `nonIdempotent`: POST `/pages`, PATCH `/blocks/:id/children`.
  - `idempotent`: PATCH `/pages/:id`, PATCH `/data_sources/:id/query` results, GET `/*`, DELETE/archive semantics (`PATCH /pages/:id` with `{archived: true}`), everything else not in the non-idempotent list.
- **R1-3.** For `nonIdempotent` operations: `unsafe_retry` errors surface immediately (no retry). `safe_retry` errors retry normally. `non_retryable` errors surface immediately (as today).
- **R1-4.** For `idempotent` operations: all retry behavior preserved exactly as today (wide retry on 429/5xx/timeouts, 2-attempt timeout cap from PR #43).
- **R1-5.** All existing callers continue to work unchanged. No caller needs to pass a flag for the common case. The classifier is authoritative.
- **R1-6.** Observable telemetry: when the classifier would have retried today but chose not to under narrow retry, emit a counter (`narrowRetrySuppressed: N`) on the `CascadeTracer`. Surfaces in the Activity Log body alongside existing `retryStats`.
- **R1-7.** Batch semantics for `createPages` / `requestBatch`: if any per-operation request surfaces an `unsafe_retry` error, the batch aborts. Remaining in-flight operations are allowed to complete (don't abort Promise.all mid-flight; let each worker finish or fail on its own) but no new operations start. The returned batch reports the per-operation outcomes (success/error). Partial-success state is then owned by PR E2's sweep (archives duplicates of succeeded ones) or by callers (inception route reports failure via existing error path).

## Scope Boundaries

- **No change** to idempotent retry behavior. PATCH existing-page, DELETE/archive, GET — all keep today's 5-attempt retry.
- **No change** to the rate-limit throttle (9 req/s/token), token pool composition, or backoff strategy.
- **No change** to Activity Log, study-comment, Import Mode, withStudyLock, cascade engine, or any route's business logic. This PR is purely a retry-classification change in the client layer.
- **No change** to the request path constants or method strings — we classify off what callers already pass.
- **Not in scope:** post-flight dedup sweep (PR E2), historical cleanup (PR E2), schema changes, new Notion API versions.
- **Not in scope:** structural block-append dedup. Narrow retry surfaces errors; copy-blocks' existing skip-on-error semantics handle the user-visible surface. Structural block dedup is a future concern.
- **Not in scope:** tuning the classifier for any new Notion endpoints added in future. Each new endpoint gets a classification decision in its PR.

## Context & Research

### Relevant Code and Patterns

- `engine/src/notion/client.js:65-117` — `_requestWithSlot`. The retry loop lives here. Classifier insertion happens inside the catch block.
- `engine/src/notion/client.js` — `createPages`, `requestBatch`, `request`, `patchPage`, `queryDatabase`, other methods that route through `_requestWithSlot`. None need caller-side changes — the classifier operates on the `method + path` arguments they already pass.
- `engine/src/provisioning/create-tasks.js` — calls `createPages` with POST `/pages`. Classified as non-idempotent automatically. No caller change.
- `engine/src/provisioning/copy-blocks.js:248,298` — calls `client.request('PATCH', '/blocks/{id}/children', ...)`. Classified as non-idempotent automatically. No caller change.
- `engine/src/provisioning/deletion.js:29-32` — calls PATCH for archive. Classified as idempotent (path = `/pages/:id`, not `/blocks/:id/children`). Existing wide retry preserved.
- `engine/src/services/cascade-tracer.js:47` — `recordRetry` pattern. Sibling method for `recordNarrowRetrySuppressed` follows the same shape.
- `engine/test/notion/client.test.js` — existing retry-loop tests. New classifier + narrow-retry tests land here.

### Institutional Learnings

- **PR #43 reliability fixes (`pulse-log/04.11/003-pr43-reliability-fixes-and-ideation.md`)** — 30s fetch timeout + 2-attempt cap on timeouts. Narrow retry composes cleanly: for non-idempotent paths, post-send timeouts surface on attempt 1 (cap is moot); for idempotent paths, cap continues to apply as today.
- **PR #56 withStudyLock (`pulse-log/04.14/004-add-task-set-serialization.md`)** — per-study serialization. PR E0 extends coverage to inception. Narrow retry's surface-the-error behavior is race-safe under study-lock coverage because only one flow touches a given study at a time.
- **Consistency experiment (2026-04-16)** — killed probe-on-retry. The reason narrow retry is the preventive architecture rather than probe-then-retry.
- **Activity Log retry-rate measurement (2026-04-20)** — sized the problem: 5.4% overall, ~22% on big inceptions.
- **Document-review findings (2026-04-20)** — flipped the architecture from opt-in (caller flag) to opt-out (path-based) to eliminate the silent-failure mode of a forgotten flag.

### External References

- [Notion API — POST `/pages`](https://developers.notion.com/reference/post-page) — documented as non-idempotent (no idempotency-key header support).
- [Notion API — PATCH `/blocks/:id/children`](https://developers.notion.com/reference/patch-block-children) — appends are non-idempotent at the positional level.

## Key Technical Decisions

- **Path-based classification at the client layer.** `_requestWithSlot` knows the `method + path` of every call. A helper `classifyIdempotency(method, path)` returns `'idempotent' | 'nonIdempotent'` by matching against a small table:
  ```
  POST /pages                         → nonIdempotent
  PATCH /blocks/{id}/children         → nonIdempotent
  * /* (everything else)              → idempotent
  ```
  Adding a new non-idempotent endpoint is a single-line edit to the table, not a per-caller change. The table is the source of truth, not 12 scattered call sites.
- **Default behavior for unrecognized paths: idempotent.** Preserves current behavior for every existing caller that isn't on the non-idempotent list. Any future endpoint that genuinely is non-idempotent gets added to the table in its own PR.
- **Error classification is a separate helper.** `classifyNotionError(err)` returns `'safe_retry' | 'unsafe_retry' | 'non_retryable'` by inspecting `err.status`, `err.name`, `err.code`. Conservative default for unknown error shapes: `unsafe_retry` (safer — surfaces for non-idempotent paths; still retries the 2-attempt cap for idempotent paths since all unknowns could be pre-send).
  - Wait — that default creates a small asymmetry: for idempotent paths, unknowns are retried because they're idempotent anyway. For non-idempotent paths, unknowns surface. That's correct: for idempotent, retry is always safe regardless of unknown; for non-idempotent, conservatism requires surface.
- **Pre-send vs post-send timeout distinction is unreliable in Node fetch.** Drop the pre-send-timeout classifier branch. All `TimeoutError` and `AbortError` classify as `unsafe_retry`. For idempotent paths this is no worse than today (they retry regardless). For non-idempotent paths this means timeouts surface — which matches the conservative principle.
- **Connect-level errors (ECONNREFUSED, ENOTFOUND) remain safe.** These fire before the request body is sent. Reliably detectable via `err.code`. Classify as `safe_retry` → retry under both policies.
- **429 classifies as `safe_retry`.** Notion's documented semantic: rate-limit means not-yet-committed. Adversarial review raised a theoretical "429-after-commit" edge case; accept as unverified-rare and document in risks. If production telemetry shows 429 correlates with duplicates, revisit — but that would require a post-deploy signal we don't have today.
- **Batch-level abort for `createPages`.** Per R1-7: one unsafe-error surfaces, remaining in-flight complete, no new starts. Caller receives a partial-result object with per-operation outcomes. Inception + add-task-set routes already have error-path handling that treats partial-failure as failure overall (existing behavior). PR E2's sweep handles the partial-success cleanup.
- **Telemetry on suppression, not classification.** Only emit `narrowRetrySuppressed` when a retry is actively suppressed. Zero emission = zero narrow-retry activity (common case), keeps the log clean and the signal interpretable.
- **No caller API surface change.** `createPages`, `requestBatch`, `request`, `patchPage`, `queryDatabase` — all keep their current signatures. Classifier is purely internal.

## Open Questions

### Resolved During Planning

- **Opt-in vs. opt-out?** Opt-out (path-based). Adversarial review: opt-in fails silent; opt-out fails loud. For the "silent duplicates" problem class, failing loud is the right bias.
- **Safe-to-retry for 429?** Yes. Notion's documented semantic. Theoretical edge case acknowledged in risks.
- **Pre-send vs post-send timeout detection?** Give up on it. Node fetch doesn't expose this reliably. All timeouts are `unsafe_retry`; connect errors (distinguishable via `err.code`) are `safe_retry`.
- **Default for unknown error shapes?** `unsafe_retry`. For idempotent paths this is equivalent to today; for non-idempotent paths it surfaces — which is the safer side of the tradeoff.
- **Batch semantics?** Abort-on-first-unsafe. Remaining in-flight allowed to complete. Caller sees per-operation outcomes. PR E2 handles partial cleanup.
- **Ensure we don't break anything?** Path table explicitly lists only POST `/pages` and PATCH `/blocks/:id/children` as non-idempotent. Every other path is classified as idempotent → current wide retry preserved exactly. No existing caller changes behavior unless they hit one of the two listed paths. Grep verification in Unit 5.

### Deferred to Implementation

- **Exact regex/matcher for PATCH `/blocks/{id}/children`.** `{id}` is a UUID — implementer decides between a regex, a `startsWith('/blocks/') && endsWith('/children')` check, or a dedicated parse. All equivalent; pick the one that reads cleanest.
- **Precise name for the telemetry counter.** Suggest `narrowRetrySuppressed: N` as a sibling field under the Activity Log body's existing stats block. Final shape decided at implementation.
- **Where the path-table lives.** Likely inside `engine/src/notion/client.js` as a module-level constant. Could also live in a small sibling file if it grows. Decide at implementation.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
_requestWithSlot(slot, method, path, body, { tracer } = {}):
  idempotency = classifyIdempotency(method, path)
  for attempt in 1..maxAttempts:
    try:
      response = await fetch(...)
      if response.ok: return response
      throw response.toError()
    catch (err):
      errClass = classifyNotionError(err)
      if errClass === 'safe_retry':
        await backoff(attempt); continue
      if errClass === 'non_retryable':
        throw err
      // errClass === 'unsafe_retry'
      if idempotency === 'nonIdempotent':
        tracer?.recordNarrowRetrySuppressed()
        throw err
      else:
        // idempotent path — retry, but respect existing 2-attempt timeout cap
        if (err.name === 'TimeoutError' || err.name === 'AbortError') && attempt >= 2: throw err
        if attempt < maxAttempts: await backoff(attempt); continue
        throw err

classifyIdempotency(method, path):
  if method === 'POST' && path === '/pages': return 'nonIdempotent'
  if method === 'PATCH' && /^\/blocks\/[^/]+\/children$/.test(path): return 'nonIdempotent'
  return 'idempotent'

classifyNotionError(err):
  if err.status === 429: return 'safe_retry'
  if err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT':
    return 'safe_retry'  // connect-level, pre-send
  if err.status >= 500 && err.status <= 599: return 'unsafe_retry'
  if err.name === 'TimeoutError' || err.name === 'AbortError': return 'unsafe_retry'
  if err.status === 400 || err.status === 401 || err.status === 403 || err.status === 404:
    return 'non_retryable'
  return 'unsafe_retry'  // conservative default for unknown
```

## Implementation Units

- [ ] **Unit 1: Add `classifyIdempotency(method, path)` helper**

**Goal:** Introduce the path-based classifier as a pure function.

**Requirements:** R1-2.

**Dependencies:** None.

**Files:**
- Modify: `engine/src/notion/client.js` (add helper inline) OR Create: `engine/src/notion/idempotency-classifier.js` if factorable cleanly.
- Test: `engine/test/notion/client.test.js` or sibling

**Approach:**
- Module-level constant table mapping (method, path-pattern) → idempotency class.
- Function dispatches on method + path, returns `'idempotent' | 'nonIdempotent'`.
- Default for unrecognized paths: `idempotent` (preserves current behavior).
- Path-patterns use a small regex for the `/blocks/{id}/children` case; exact match for `POST /pages`.

**Patterns to follow:**
- Sibling pure-function helpers in `engine/src/notion/`.

**Test scenarios:**
- **Happy — POST /pages:** returns `nonIdempotent`.
- **Happy — PATCH /blocks/abc-123/children:** returns `nonIdempotent` (valid UUID pattern).
- **Happy — PATCH /pages/:id:** returns `idempotent`.
- **Happy — GET /databases/:id:** returns `idempotent`.
- **Happy — DELETE /pages/:id** (hypothetical; engine uses archive-PATCH): returns `idempotent`.
- **Edge — PATCH /blocks/abc-123:** returns `idempotent` (the path doesn't end with `/children` — it's a block update, not an append).
- **Edge — POST /pages/something-weird:** returns `idempotent` (path isn't exactly `/pages`).
- **Edge — case sensitivity:** `post /pages` (lowercase method) — behavior depends on how fetch capitalizes; specify. Recommended: match `method.toUpperCase() === 'POST'` to be defensive.
- **Edge — empty path or null method:** returns `idempotent` (safe default).

**Verification:**
- `npm run test:ci` passes. Classifier has branch coverage.

- [ ] **Unit 2: Add `classifyNotionError(err)` helper**

**Goal:** Introduce the error classifier as a pure function.

**Requirements:** R1-1.

**Dependencies:** None.

**Files:**
- Modify: `engine/src/notion/client.js` OR Create: `engine/src/notion/error-classifier.js`
- Test: sibling test file

**Approach:**
- Pure function taking an error object, returning `'safe_retry' | 'unsafe_retry' | 'non_retryable'`.
- Handles: HTTP status-code errors from Notion (`err.status`), Node fetch timeout/abort errors (`err.name`), connect-level errors (`err.code`), and conservative default (`unsafe_retry`) for unknowns.
- One-line comment per mapping documenting the rationale.

**Patterns to follow:**
- Existing error shape usage in `_requestWithSlot`'s current catch block.

**Test scenarios:**
- **Happy — 429:** `safe_retry`.
- **Happy — 502, 503, 504:** `unsafe_retry`.
- **Happy — 400 bad request:** `non_retryable`.
- **Happy — 401 unauthorized:** `non_retryable`.
- **Happy — 403 forbidden:** `non_retryable`.
- **Happy — 404:** `non_retryable`.
- **Edge — ECONNREFUSED:** `safe_retry`.
- **Edge — ENOTFOUND:** `safe_retry`.
- **Edge — ETIMEDOUT (connect-level):** `safe_retry`.
- **Edge — TimeoutError (post-send):** `unsafe_retry`.
- **Edge — AbortError:** `unsafe_retry`.
- **Edge — unknown error shape (plain `Error`):** `unsafe_retry` (conservative default).
- **Edge — 5xx with body indicating rate limit** (hypothetical): still `unsafe_retry` (status dominates).

**Verification:**
- `npm run test:ci` passes. Classifier has 100% branch coverage.

- [ ] **Unit 3: Integrate classifiers into `_requestWithSlot` retry loop**

**Goal:** The retry loop uses both classifiers to decide retry-vs-surface per attempt.

**Requirements:** R1-3, R1-4, R1-5, R1-6.

**Dependencies:** Units 1, 2.

**Files:**
- Modify: `engine/src/notion/client.js` (`_requestWithSlot`)
- Test: `engine/test/notion/client.test.js`

**Approach:**
- At loop entry: compute `idempotency = classifyIdempotency(method, path)` once.
- In catch block: compute `errClass = classifyNotionError(err)`.
- Branch per the High-Level Technical Design pseudocode.
- For `nonIdempotent` + `unsafe_retry`: increment tracer counter (Unit 5), throw.
- For `idempotent` + `unsafe_retry`: preserve current behavior (retry, honor 2-attempt timeout cap).
- For `safe_retry`: retry (both policies).
- For `non_retryable`: throw (both policies).

**Patterns to follow:**
- Existing retry-loop structure at `client.js:65-117`.

**Test scenarios:**
- **Happy — idempotent PATCH /pages/:id, 502 on attempt 1:** retries. Succeeds on attempt 2. No tracer increment.
- **Happy — idempotent GET /databases/:id, 429 on attempt 1:** retries. No tracer increment.
- **Happy — nonIdempotent POST /pages, 429 on attempt 1:** retries (safe_retry applies to both policies). No tracer increment.
- **Happy — nonIdempotent POST /pages, 502 on attempt 1:** throws immediately. Tracer counter = 1.
- **Happy — nonIdempotent POST /pages, post-send timeout on attempt 1:** throws immediately. Tracer counter = 1.
- **Happy — nonIdempotent POST /pages, ECONNREFUSED on attempt 1:** retries (safe_retry, pre-send). No tracer.
- **Edge — idempotent, post-send timeout on attempt 1, 2:** retries once (attempt 1 → 2), then throws at attempt 2 (PR #43 cap). Unchanged behavior.
- **Edge — nonIdempotent PATCH /blocks/X/children, 502:** throws immediately. Tracer counter = 1.
- **Edge — idempotent PATCH /blocks/X (no /children suffix), 502:** retries. Current behavior preserved (it's classified idempotent).
- **Edge — 400 on either path:** throws (`non_retryable`).
- **Edge — unknown error shape on idempotent path:** retries (conservative default `unsafe_retry` but idempotent retries anyway).
- **Edge — unknown error shape on nonIdempotent path:** throws, counter = 1.

**Verification:**
- `npm run test:ci` passes. Existing retry tests preserved unchanged (idempotent paths). New non-idempotent tests green.

- [ ] **Unit 4: Batch abort semantics for `createPages` / `requestBatch`**

**Goal:** Define what batch operations return when per-operation narrow-retry suppression fires.

**Requirements:** R1-7.

**Dependencies:** Unit 3.

**Files:**
- Modify: `engine/src/notion/client.js` (`createPages`, `requestBatch`)
- Test: `engine/test/notion/client.test.js`

**Approach:**
- Current `createPages`: fans out to parallel workers via `requestBatch` / `runParallel`. Each worker calls `_requestWithSlot` independently.
- Post-narrow-retry: a worker that hits `unsafe_retry` on a non-idempotent op throws. The surrounding Promise.all / runParallel must:
  - Allow already-in-flight workers to complete (don't abort mid-flight — they have their own fate).
  - Not start new workers after one has thrown (stop the queue).
  - Return a per-operation result array: `[{success, result}, {success, error}, ...]` — each operation reports its own outcome.
- `createPages` callers (`create-tasks.js`) receive this result array. `create-tasks.js` already iterates the returned list and populates `idMapping` from successful responses; failed operations simply don't have an idMapping entry. Inception's error path handles the overall failure signal.
- Full batch failure (all failed) → throw for the caller. Partial (some succeed, some fail) → return the array; caller decides.

**Patterns to follow:**
- Existing `requestBatch` / `runParallel` shapes at `client.js`.

**Test scenarios:**
- **Happy — all 50 ops succeed:** returns 50 success results. No tracer increments.
- **Happy — 48 ops succeed, 2 throw unsafe_retry:** returns 50 results (48 success, 2 error). Tracer counter = 2. No new workers start after the first throw; already-in-flight workers complete.
- **Happy — all 50 ops throw unsafe_retry:** `createPages` itself throws (full-batch failure).
- **Edge — 1 op throws non_retryable (4xx):** returns 50 results (1 error, 49 success/pending). Tracer unchanged (non_retryable doesn't count as suppression).
- **Edge — exact race: two workers throw simultaneously:** no double-counting; tracer counter = 2, both surfaced.

**Verification:**
- `npm run test:ci` passes. New integration tests cover partial-failure semantics.

- [ ] **Unit 5: Telemetry — `narrowRetrySuppressed` counter on CascadeTracer**

**Goal:** Observable signal in Activity Log when narrow retry fires.

**Requirements:** R1-6.

**Dependencies:** Unit 3.

**Files:**
- Modify: `engine/src/services/cascade-tracer.js`
- Modify: `engine/src/services/activity-log.js` (if body-rendering needs extension)
- Test: `engine/test/services/cascade-tracer.test.js` or equivalent

**Approach:**
- Add `recordNarrowRetrySuppressed()` method on `CascadeTracer`. Increments an internal counter.
- Emit in `toActivityLogDetails()` as `narrowRetrySuppressed: N` alongside `retryStats`. Emit only when N > 0 (matches the principle of quiet common-case).
- Increment from `_requestWithSlot`'s catch block in the `nonIdempotent` + `unsafe_retry` branch.
- If the tracer isn't available (`tracer` option not passed), no-op safely. Don't throw.

**Patterns to follow:**
- Existing `retryStats` accumulation and emission in `cascade-tracer.js`.

**Test scenarios:**
- **Happy — no suppression:** tracer output doesn't include the field.
- **Happy — one suppression:** `narrowRetrySuppressed: 1`.
- **Happy — multiple suppressions in a batch:** `narrowRetrySuppressed: N`.
- **Edge — no tracer passed:** no-op; `_requestWithSlot` doesn't throw.

**Verification:**
- `npm run test:ci` passes.
- Manual check post-deploy: first few provisioning runs' Activity Log bodies show the counter when retries fire.

- [ ] **Unit 6: Verify the path-table is exhaustive for existing callers**

**Goal:** Ensure the path-based classification doesn't accidentally misclassify any existing call site.

**Requirements:** R1-5.

**Dependencies:** Units 1-3 merged.

**Files:**
- Test: `engine/test/notion/client.test.js` (integration-ish test) OR a standalone verification

**Approach:**
- Grep all `client.request(`, `client.createPages(`, `client.patchPage(`, `client.queryDatabase(`, etc. call sites in `engine/src/`.
- For each unique (method, path) pair, confirm the classifier returns the expected value.
- Explicit test: enumerate every call site's method+path and assert classification matches intent.
- Catch any misclassification before ship.

**Patterns to follow:**
- Grep-driven coverage. Engine is small enough that enumeration is tractable (<30 call sites).

**Test scenarios:**
- **Verification test:** list every (method, path) pair in use. Classifier returns the expected class for each.

**Verification:**
- All existing call sites match intent. If any existing caller hits the `nonIdempotent` branch unexpectedly (e.g., we missed a path), the test fails and we update either the table or the caller.

## System-Wide Impact

- **Interaction graph:** `_requestWithSlot` is the client-layer choke point for every write and query. After this PR, the classifier decides per-call whether retries apply. All callers of `createPages`, `request`, `patchPage`, `queryDatabase` pass through the new logic. Only calls to POST `/pages` or PATCH `/blocks/{id}/children` see behavior change (surface on unsafe).
- **Error propagation:** non-idempotent errors surface sooner. Route handlers' existing try/catch absorb them via the existing `Promise.all([reportStatus, activityLog, studyComment]).catch()` pattern. No new error channels.
- **State lifecycle risks:** narrow-retry-surfaced errors during inception cause the run to abort. `finally` blocks reset Import Mode. PR E0's `withStudyLock` ensures no concurrent run is mid-flight. PR E2's sweep cleans up any partial-success residue.
- **API surface parity:** no external API changes. Classification is purely internal.
- **Integration coverage:** existing retry tests (idempotent paths) continue unchanged. New tests cover non-idempotent path behavior.
- **Unchanged invariants:** idempotent retry behavior, rate-limit throttle, token pool composition, timeout envelope (PR #43's 2-attempt cap for idempotent paths), Activity Log shape (minor additive field), study-comment flow, Import Mode lifecycle, withStudyLock semantics (PR E0), classifier-default-idempotent-for-unknown-paths preserving current behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Narrow retry surfaces too many "transient" failures that would have succeeded on retry | Telemetry counter quantifies how often this fires in production. PR E2's sweep catches residual duplicates if any slip through. If frequency is user-hostile post-Seb-handoff, revisit classifier. |
| 429 theoretically fires after a commit (undocumented Notion edge case) | Accept as unverified-rare. Monitor post-deploy: if `narrowRetrySuppressed` stays near 0 but PR E2's sweep keeps finding duplicates, the classifier for 429 is wrong and should be revisited. |
| Pre-send-vs-post-send timeout distinction is unreliable | Solved by treating all timeouts as `unsafe_retry`. For idempotent paths this matches today's retry-with-cap. For non-idempotent paths this surfaces — conservative side of the tradeoff. |
| Path-table misclassifies an existing caller | Unit 6 enumerates every call site's (method, path) pair and asserts classification matches intent. Grep verification is exhaustive because the engine is small. |
| Future developer adds a new non-idempotent endpoint and forgets to update the path-table | The default is `idempotent` — so the new endpoint initially retries as today. If it's actually non-idempotent, that manifests as silent duplicates and gets caught by PR E2's sweep. Not zero-cost, but the sweep is the fail-safe. Documentation in ENGINE-BEHAVIOR-REFERENCE.md (PR E2's docs unit) explicitly reminds future authors to update the table. |
| Batch abort semantics surprise callers that expect all-or-nothing | Only `createPages` and `requestBatch` are affected. Both are only called by inception/add-task-set provisioning paths, which already handle partial failure via error comment + Automation Reporting. No new surprise. |
| Rollback entangles with E2 | Path-based classification is self-contained; if reverted, retry behavior returns to today's wide retry everywhere. E2's sweep logic doesn't depend on E1's narrow retry being in place — it handles residual duplicates regardless of source. Rollback is safe. |

## Documentation / Operational Notes

- Post-merge: observe the first ~20 provisioning runs for `narrowRetrySuppressed` signal. If it fires too often (say >5% of inceptions), consider whether 429-retry behavior needs tuning.
- Pulse log entry: `clients/picnic-health/pulse-log/04.20/NNN-pr-e1-path-based-narrow-retry.md` post-merge.
- No feature flag. Pre-prod state makes immediate deploy acceptable.
- Railway auto-deploys on merge. No env var changes.
- Future authors: when adding a new non-idempotent endpoint, update the path-table in `engine/src/notion/client.js` (or the sibling classifier file). PR E2's documentation unit adds this to `ENGINE-BEHAVIOR-REFERENCE.md`.

## Sources & References

- **Superseded plan:** `engine/docs/plans/2026-04-16-004-refactor-notion-client-idempotency-plan.md` (probe-based approach ruled out).
- **Document-review findings (2026-04-20):** flipped architecture from opt-in to opt-out. Also identified:
  - Pre-send timeout detection unreliable — dropped.
  - 429 theoretical edge case — accepted with monitoring.
  - Batch semantics gap — specified (Unit 4).
- **Consistency experiment (2026-04-16):** Notion filtered-query lag p95 6–11s, max 15.4s. Killed probe approach.
- **Retry-rate measurement (2026-04-20):** 5.4% overall, ~22% on 200-task inceptions.
- **Prior related PRs:** PR #43 (30s timeout + 2-attempt cap — preserved for idempotent), PR #56 (withStudyLock — E0 extends), PR #62 (single-leaf duplicate guard — stays as belt-and-suspenders).
- **Sequenced plans:** PR E0 (`2026-04-20-001-fix-inception-with-study-lock-plan.md` — prerequisite), PR E2 (`2026-04-20-003-feat-post-flight-duplicate-sweep-plan.md` — safety net).
- **Related code:**
  - `engine/src/notion/client.js` — primary target.
  - `engine/src/provisioning/create-tasks.js`, `engine/src/provisioning/copy-blocks.js`, `engine/src/provisioning/deletion.js` — call sites (no changes required).
  - `engine/src/services/cascade-tracer.js` — telemetry.
