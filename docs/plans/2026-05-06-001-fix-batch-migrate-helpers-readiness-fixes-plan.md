---
title: "fix(batch-migrate): agent-readiness polish — destructive-cascade safety + contract unification + cursor-retry parity"
type: fix
status: active
date: 2026-05-06
deepened: 2026-05-06
---

# fix(batch-migrate): agent-readiness polish — destructive-cascade safety + contract unification + cursor-retry parity

## Overview

PR [#100](https://github.com/optemization-tech/picnic-cascade-engine/pull/100) ported the PR #99 (repair-task-blocks) agent-readiness pattern onto the 3 batch-migrate recovery helpers. ce-code-review surfaced 12 P1 + 7 P2 findings; ce-doc-review on this plan then surfaced 6 anchor-100 + 13 anchor-75 decisions including a chain root. All 10 deferred decisions (Q1-Q10) have been resolved (see Open Questions → Resolved). This revision integrates those resolutions and restructures the work into **3 sequential PRs** (Q4): **Safety**, **Contract**, **Polish**.

The polish achieves what it set out to: state/outcome enums, schemaVersion, idempotency markers, clean stdout/stderr separation, dep-injectable run() + per-stage helpers. What it lacks is correct behavior when things go wrong — transient network errors trigger destructive recovery cascades; mid-stage throws silently exit 0; the deletion webhook archives PM-added manual tasks the runbook says to confirm first; the discriminator pattern across JSON outputs is inconsistent enough that downstream agents would need per-script parsers.

PR #100's base (`feat/batch-migrate-7-studies`, PR #96) was squash-merged to main as `0cde3e0`. Implementation begins by rebasing PR #100 onto main (Q2) and then splitting the polish commit + new fix commits into 3 stacked PRs (Q4).

---

## Problem Frame

The polish in PR [#100](https://github.com/optemization-tech/picnic-cascade-engine/pull/100) is structurally correct but unsafe under failure:

1. **Destructive cascade on transient errors.** A Notion network blip during `check-inception` exits Node with code 1, which the bash wrapper interprets as "Inception Failed" and triggers `/webhook/deletion` against a still-healthy cascade.
2. **Silent partial side effects.** A throw mid-stage in `recover-inception` (e.g., from `queryAll` cursor invalidation) leaves `RECOVERY_JSON=''` and the wrapper exits 0 — but `/webhook/deletion` already fired and started archiving.
3. **Runbook divergence.** The runbook's [Step 3 manual-task check](projects/engine/docs/runbooks/inception-batch-incomplete.md) is skipped; PM-added Study Tasks (without Template Source ID) get silently archived.
4. **Inconsistent JSON contract.** Three discrimination patterns (`ok`, `state`, `outcome`) coexist across the same composed envelope; same condition uses snake_case in `error.code` and kebab-case in `state`; `state: 'other'` masks Unknown / In-Progress / Cancelled behind one token; `schemaVersion: 1` ships with no bump policy.
5. **Coverage gaps.** Three branches that map directly to real production scenarios (transient AL latency, missing Production Study, Activity Log empty) are untested.
6. **`queryAll` lacks cursor-retry.** Same root cause as the [2026-05-05 GSK SLE BEACON 61-row loss](projects/engine/docs/solutions/silent-partial-failure-in-async-batches.md). `scripts/batch-migrate/notion.js` has the retry as of main; `recover-inception.js`'s local `queryAll` does not.

Origin: ce-code-review run `/tmp/compound-engineering/ce-code-review/20260506-121021-f8e639d0/`. ce-doc-review pass on this plan completed 2026-05-06 with all Q1-Q10 resolved interactively.

---

## Requirements Trace

- **R1.** `migrate-with-recovery.sh --json` exit code matches `envelope.outcome` (parity with default mode).
- **R2.** Transient Notion errors (5xx, network timeouts, ECONNRESET) MUST NOT cascade into destructive recovery. They surface as a distinct exit class and a JSON `error.code` that the wrapper recognizes as "do not auto-recover".
- **R3.** Uncaught throws inside `run()` are captured by `runMain()` into the standard error envelope. JSON mode ALWAYS emits a JSON object on stdout before exit.
- **R4.** `recover-inception` performs the runbook Step 3 manual-task check before firing `/webhook/deletion`. Refuse with `error.code: 'manual_tasks_present'` and the manual-task IDs in the envelope. **No override flag.**
- **R5.** `check-inception`'s `state` enum is exhaustive — `In Progress`, `Unknown`, `Cancelled` get distinct snake_case tokens. Compose-envelope outcome derivation honors the distinction.
- **R6.** `schemaVersion` carries a written bump policy at the top of `compose-envelope.js`. **Lands as a standalone commit** (Q8) before the larger U6 enum work in the Contract PR.
- **R7.** Single discrimination pattern: `ok: true | false` always present; `error: { code, message }` when `ok: false`. State and outcome enums layer on top.
- **R8.** Error code casing is uniform: snake_case in `error.code` and `state` token. Auth failures (401/403) get distinct `error.code: 'auth_error'`.
- **R9.** `clearAuditRows` returns `{ status: 'failed', error }` on PATCH errors. **Aborts on first error after fetch-layer retries are exhausted** (Q6) — recovery is all-or-nothing; partial cleanup misleads the next step.
- **R10.** Untested branches covered: `state: 'in_progress' / 'unknown' / 'cancelled'`, `no_production_study` recovery error, `reInceptionAndVerify` Activity Log empty.
- **R11.** `recover-inception`'s local `queryAll` gains cursor-retry parity. **Local port** (Q7-related) — different endpoints rule out direct import from `notion.js`.
- **R12.** `compose-envelope` outcome derivation handles `alreadySuccess` (REC_EXIT=2). When orchestrator clean → `outcome: 'already_success'`; **when orchestrator failed → `outcome: 'failed'`** (Q10) — orchestrator state dominates per Q5.
- **R13.** Brittle test reliability: `recover-inception.test.js`'s filter-shape dispatch replaced with stable discriminator (data-source ID).
- **R14.** Default-mode parity preserved: `'[null]'` regression fixed, missing `0/0` line restored, webhook banners print before await, `--format=status` docblock updated.
- **R15.** Bash wrapper's final exit code is read from `envelope.exitCode` (single source of truth in `compose-envelope.js`).
- **R16.** `AbortSignal.timeout(30000)` on `makeDefaultNotionFetch` — folded into U4 because retry-with-backoff cannot detect hung connections without a request-level timeout.
- **R17.** Retry-with-backoff lives **inside `makeDefaultNotionFetch`** (Q7), not at each call-site. Single source of truth; tests inject a non-retrying mock.
- **R18.** Outcome rule for in-flight states is **conditional on orchestrator exit** (Q5). When `orch_exit ≠ 0` AND check returns `state: in_progress | unknown | cancelled` → `outcome: 'failed'` (orch failure dominates). When `orch_exit == 0` AND check returns same → `outcome: 'inconclusive'`.

---

## Scope Boundaries

- **Not in scope:** Adding `--json` to `batch-migrate.js` (the orchestrator). It stays opaque; the wrapper continues to capture its tail as stdoutTail.
- **Not in scope:** Migrating `recover-inception` to `scripts/batch-migrate/notion.js`'s throttled client wholesale. R11 is cursor-retry parity only.
- **Not in scope:** Streaming JSON-line progress for long-running operations.
- **Not in scope:** Distributed locking against concurrent `migrate-with-recovery.sh` invocations on the same study.
- **Not in scope:** Closing the U5 TOCTOU race fully (Q9). Mitigated by README/runbook acknowledgement; engine-side fix (deletion webhook respects Template Source ID filter) is durable mitigation, separate scope.

### Deferred to Follow-Up Work

- **README "Agent usage" section in `scripts/batch-migrate/`**: Documenting `--json` surface, exit codes, outcome enum, and `batch-migrate.js` opacity caveat. Defer until contract stabilizes after the 3 PRs land.
- **JSON Schema / `.d.ts` for the envelope contract**: Once schemaVersion stabilizes post-merge, ship a machine-readable schema.
- **Throttle parity with `scripts/batch-migrate/notion.js`**: `clearAuditRows` hot-loops PATCHes with only a 1.1s sleep every 10 rows; full throttle migration is its own scope.
- **`AbortSignal.timeout` audit across all engine scripts**: U4 adds it to the two `makeDefaultNotionFetch` wrappers in this PR. Auditing the rest of `scripts/` is separate scope.
- **Engine-side `/webhook/deletion` filter narrowing for U5 TOCTOU race fix.**

---

## Context & Research

### Relevant Code and Patterns

- **Reference pattern**: [scripts/repair-task-blocks.js](projects/engine/scripts/repair-task-blocks.js) — `isMain` gate, `getArg`/`getFlag` helpers, `try/catch` around the apply phase that always writes Activity Log even on failure.
- **Cursor-retry source**: [src/notion/client.js:264-301](projects/engine/src/notion/client.js:264). Mirrored into `scripts/batch-migrate/notion.js` per main commit `0cde3e0` (different endpoint; pattern transferable, code not).
- **Runbook**: [docs/runbooks/inception-batch-incomplete.md](projects/engine/docs/runbooks/inception-batch-incomplete.md) — Step 3 manual-task check.
- **Notion property reference**: `[Do Not Edit] Template Source ID` is a `rich_text` property on Study Tasks; manual tasks have it empty. See [src/notion/property-names.js](projects/engine/src/notion/property-names.js).
- **Origin polish branch**: `chore/batch-migrate-helpers-agent-readiness` (commit `6455a78`).
- **Existing test conventions**: [test/scripts/repair-task-blocks.test.js](projects/engine/test/scripts/repair-task-blocks.test.js) — `mockClient` dep-injection. The new tests at `test/scripts/batch-migrate/*.test.js` follow this pattern with a `makeNotionFetch` adapter.

### Institutional Learnings

- **Silent partial-failure pattern** ([docs/solutions/silent-partial-failure-in-async-batches.md](projects/engine/docs/solutions/silent-partial-failure-in-async-batches.md)): "A batch caller reports `count_observed`, never `count_expected`." Directly relevant to U4 (transient retry classification) and U2 (stage failure status).
- **`Promise.allSettled` for cleanup-after-failure** ([docs/plans/2026-05-04-001-fix-inception-silent-batch-abort-plan.md](projects/engine/docs/plans/2026-05-04-001-fix-inception-silent-batch-abort-plan.md)): a single corrupt input must not torpedo the whole envelope. Already applied in compose-envelope's safeParse.
- **CodeBase review** ([docs/CODEBASE-REVIEW-2026-04-07.md](projects/engine/docs/CODEBASE-REVIEW-2026-04-07.md)): P1 #3 "queryDatabase returns undefined on cursor retry exhaustion" — always return a structured value at every loop exit point in U7. P1 #5 (no fetch timeout) folded into U4 via R16.

### External References

None new this round.

---

## Key Technical Decisions

- **Decision: Three sequential PRs (Q4).** Split into PR A (Safety), PR B (Contract), PR C (Polish). Each is independently mergeable, reviewable, and revertable. Stacked merge order; PR B depends on PR A's safety primitives, PR C depends on PR B's contract.
- **Decision: Rebase PR #100 onto main, repurpose as PR A (Safety) (Q2).** PR #100's polish commit `6455a78` gets reshaped to contain only Safety units (U2/U4/U5/U7). PR B and PR C are new branches stacked on PR A.
- **Decision: New exit code 4 for "transient/inconclusive" (R2).** Wrapper's case statement: 0=success, 1=recovery, 2=investigate, 4=transient (do NOT recover, retry the read).
- **Decision: All three layers (`ok` + `state` + `outcome`) preserved (Q3).** Each layer has a distinct job; collapsing would lose semantic refinement.
- **Decision: Single discriminator: `ok: true` always present.** Removes parser branching across success/failure shapes.
- **Decision: snake_case for both `error.code` and `state` tokens.** Auth failures (401/403) get distinct `error.code: 'auth_error'`.
- **Decision: Manual-task guard refuses without an override flag (Q1=A doesn't change this).** Per the runbook, manual tasks signal "coordinate with PM, then re-run cleanly." Script refuses with `error.code: 'manual_tasks_present'`; operator manually archives in Notion UI before re-running.
- **Decision: `state: 'other'` retired; replaced with `state: 'in_progress' | 'unknown' | 'cancelled'`.**
- **Decision: Outcome rule for in-flight states is conditional on orchestrator exit (Q5).** When `orch_exit ≠ 0` AND check returns in-flight → `outcome: 'failed'`. When `orch_exit == 0` AND check returns in-flight → `outcome: 'inconclusive'`. compose-envelope inspects orchestrator state.
- **Decision: alreadySuccess + orch_failed → outcome `failed` (Q10).** Consistent with Q5: orchestrator failure dominates regardless of recovery's view.
- **Decision: clearAuditRows aborts on first error after fetch-layer retries exhausted (Q6).** Recovery is all-or-nothing; partial cleanup misleads the next step. Operator fixes the failing row manually and re-runs.
- **Decision: Retry-with-backoff lives inside `makeDefaultNotionFetch` (Q7).** Single source; tests inject non-retrying mock.
- **Decision: schemaVersion docblock as standalone commit (Q8).** Lands first in PR B (Contract) before the larger U6 enum work for cleaner review.
- **Decision: U7 ports cursor-retry locally.** `notion.js`'s `queryDb` targets `/v1/databases/{id}/query` (Notion-Version 2022-06-28); `recover-inception`'s `queryAll` targets `/v1/data_sources/{id}/query` (2025-09-03). Direct import structurally broken.
- **Decision: Bash wrapper reads `envelope.exitCode`.** Single source of truth.
- **Decision: TOCTOU race in U5 acknowledged, not fixed in this PR (Q9).** README + runbook note; engine-side filter narrowing is the durable mitigation.

---

## Open Questions

### Resolved During Planning

- **Q: Rebase strategy?** A: Use `git rebase -i` and explicitly drop `ae1711c`, OR `git rebase --onto main feat/batch-migrate-7-studies --empty=drop`.
- **Q: Where does the manual-task guard live?** A: `recover-inception.js`'s `fireDeletionAndPoll` stage, before `await fireWebhook(...)`. Refuse-and-surface; no override flag.
- **Q: Should `--json-stream` ship in this PR?** A: No — out of scope.
- **Q: Import notion.js's queryDb or port locally?** A: Port locally — endpoints + API versions differ.
- **Q: state='other' rename — which canonical tokens?** A: `in_progress`, `unknown`, `cancelled` (snake_case).
- **Q: README in scripts/batch-migrate/?** A: Deferred to follow-up.

**Q1 [chain root]: Should destructive recovery be agent-callable at all? A: Yes — keep full agent-callable scope (option A).** All three helpers get full `--json` + agent-readiness treatment. The Q1 dependents (manual-task override, TOCTOU race, wrapper validation) remain real concerns within agent-callable scope and are addressed in U2/U5/U3.

**Q2: Rebase PR #100 onto main, or close + reopen? A: Rebase.** Force-push the polish commit + fixes onto rebased base. Preserves PR #100 number and review history.

**Q3: API surface — keep three layers or collapse outcome? A: Keep all three layers** (`ok` + `state` + `outcome`). Each has a distinct job.

**Q4: 1 PR or split into 3? A: 3 PRs — Safety / Contract / Polish.** PR A repurposes PR #100; PR B and PR C stack on top.

**Q5: in_progress outcome rule — conditional on orchestrator? A: Conditional.** When `orch_exit ≠ 0` AND check returns in-flight → `outcome: 'failed'`. When `orch_exit == 0` → `outcome: 'inconclusive'`. compose-envelope inspects orch_exit.

**Q6: clearAuditRows behavior on PATCH error after fetch-layer retries fail? A: Abort.** Recovery is all-or-nothing; partial cleanup misleads next step. Operator fixes failing row manually and re-runs.

**Q7: Retry layering — fetch wrapper or call-site? A: Inside `makeDefaultNotionFetch`** (single source of truth).

**Q8: schemaVersion docblock as standalone commit? A: Yes — standalone commit** in PR B before the U6 enum work.

**Q9: TOCTOU race in U5 — how to handle? A: Acknowledge, document, don't fix in this PR.** Engine-side filter narrowing is the durable mitigation, separate scope. README and runbook note the timing risk for operators.

**Q10: alreadySuccess + orch_failed combination — outcome? A: outcome `failed`** (orchestrator failure dominates, consistent with Q5).

### Deferred to Implementation

- **Exact transient-error retry budget for U4.** Start with 2 retries × 5s backoff; verify against real Notion 5xx behavior in dev. Tune if 10s leaves too many false negatives.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

**Decision matrix — `check-inception.js` exit codes after fix:**

| Activity Log state | Network | Exit | `state` | Outcome (compose-envelope) |
|---|---|---|---|---|
| `Success` | OK | 0 | `success` | `clean` |
| `Failed` (Batch incomplete) | OK | 1 | `failed` | (depends on recovery → `recovered` / `failed`) |
| (no entry) | OK | 2 | `no_entry` | `failed` |
| (no Production Study row) | OK | 2 | `no_production_study` | `failed` |
| `In Progress`/`Unknown`/`Cancelled` | OK | 2 | `in_progress` / `unknown` / `cancelled` | **`failed` if `orch_exit ≠ 0`, else `inconclusive`** (Q5 conditional rule) |
| (any) | network 5xx / timeout / ECONNRESET | 4 | `inconclusive` | `inconclusive` |
| (any) | 401/403 (auth) | 1 | (n/a — `ok: false`) | `failed` (with `error.code: 'auth_error'`) |
| (any) | usage / config error | 3 | (n/a — `ok: false`) | `failed` |

**alreadySuccess outcome derivation (Q10 conditional):**

- `alreadySuccess: true` AND `orch_exit == 0` → `outcome: 'already_success'` (exit 0)
- `alreadySuccess: true` AND `orch_exit ≠ 0` → `outcome: 'failed'` (exit 1) — orchestrator failure dominates

**Wrapper bash exit-code derivation (post-fix):**

```
# Read envelope.exitCode from compose-envelope output — single source of truth.
ENVELOPE_EXIT=$(printf '%s' "$ENVELOPE_JSON" | node -e "
  const env = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  process.stdout.write(String(env.exitCode));
")
exit "$ENVELOPE_EXIT"
```

**`run() / runMain()` error capture pattern:**

```
async function runMain() {
  try {
    const { exitCode, result } = await run({ studyKey, deps });
    if (jsonMode) process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(exitCode);
  } catch (err) {
    const envelope = {
      schemaVersion: 1,
      ok: false,
      study: studyKey,
      error: { code: classifyError(err), message: String(err.message || err).slice(0, 400) },
    };
    if (jsonMode) process.stdout.write(JSON.stringify(envelope) + '\n');
    else console.error(`[fatal] ${envelope.error.code}: ${envelope.error.message}`);
    process.exit(classifyExitCode(err));
  }
}

// classifyError: 401/403 → 'auth_error'; 4xx → 'notion_api'; 5xx/timeout/ECONNRESET → 'transient'; else → 'unknown'.
// classifyExitCode: 'transient' → 4; 'auth_error' / 'notion_api' / 'unknown' → 1.
```

---

## Phased Delivery (3 PRs)

### PR A — Safety (Repurposed PR #100)

Goal: eliminate destructive cascades on transient errors and silent partial side effects. Target audience: anyone running migrations against the engine.

Units: U1, U2, U4, U5, U7.

Dependencies: none (foundation for B and C).

Mergeability: independent. After merge, the engine is safer than today even if B/C never land.

### PR B — Contract (Stacked on A)

Goal: unified JSON contract across all three helpers. Target audience: agents that need to parse the output reliably.

Units: U6.0 (schemaVersion docblock standalone), U6, U3, U8.

Dependencies: PR A merged. Branches off A's tip.

Mergeability: requires A.

### PR C — Polish (Stacked on B)

Goal: close coverage gaps and default-mode parity drifts.

Units: U9, U10.

Dependencies: PR B merged.

Mergeability: requires B.

---

## Implementation Units

### PR A — Safety

- U1. **Repurpose PR #100 as PR A: rebase onto main, drop stowaway, narrow scope to Safety units**

**Goal:** PR #100's branch becomes the PR A (Safety) branch. Rebase onto main, drop `ae1711c`, narrow the polish commit `6455a78` to only contain Safety-related changes (U2/U4/U5/U7). Contract and Polish work moves to PRs B and C respectively.

**Requirements:** (foundational; not tied to a specific R)

**Dependencies:** None.

**Files:**
- (no file edits — git operations only)

**Approach:**
- `git checkout chore/batch-migrate-helpers-agent-readiness` in the engine repo.
- Use ONE of:
  - **Interactive (preferred):** `git rebase -i --onto main feat/batch-migrate-7-studies` and explicitly drop the line for `ae1711c`.
  - **Non-interactive:** `git rebase --onto main feat/batch-migrate-7-studies --empty=drop` (Git 2.26+).
- After rebase, the polish commit `6455a78` will be on top of main but contains all 10 units' worth of code. Reset and split:
  - Soft-reset to main: `git reset --soft main` (keeps all changes staged).
  - Re-stage and commit only Safety-relevant changes (U2/U4/U5/U7 hunks); push to PR #100.
  - The remaining changes (Contract: U3/U6/U8, Polish: U9/U10) get cherry-picked into new branches for PR B and PR C in U11 and U12.
- `git push --force-with-lease origin chore/batch-migrate-helpers-agent-readiness`.

**Test scenarios:**
- Test expectation: none — git operation, verified via `gh pr view 100 --json baseRefName,changedFiles`.

**Verification:**
- `git log polish ^main` shows the new Safety-only commit(s).
- `gh pr view 100 --json baseRefName` returns `main`.
- `gh pr diff 100 --name-only` lists ONLY: `recover-inception.js`, `check-inception.js`, `migrate-with-recovery.sh`, and the test file changes for Safety.
- Contract and Polish changes are NOT in PR #100's diff.

---

- U2. **Stage helpers return failure status; runMain captures uncaught throws into envelope (PR A)**

**Goal:** Eliminate silent exit 0 with partial side effects. Every code path through `run()` either returns a structured `{ exitCode, result }` or is caught by `runMain()` and converted to an error envelope before exit. `clearAuditRows` aborts on first error after fetch-layer retries are exhausted.

**Requirements:** R3, R8, R9.

**Dependencies:** U1.

**Files:**
- Modify: `scripts/batch-migrate/recover-inception.js` (`clearAuditRows` + `runMain`)
- Modify: `scripts/batch-migrate/check-inception.js` (`runMain`)
- Modify: `test/scripts/batch-migrate/recover-inception.test.js`
- Modify: `test/scripts/batch-migrate/check-inception.test.js`

**Approach:**
- `clearAuditRows`: wrap the PATCH loop body in `try/catch`. **On error, abort: return `{ name: 'clearAudit', status: 'failed', rowsScanned, rowsCleared, error: { code: 'patch_failed', rowId, message } }`** (Q6). Do NOT continue to subsequent rows after a failure. The fetch-layer retry (U4) handles transient errors before they reach this catch.
- `runMain` (both scripts): wrap `await run(...)` in `try/catch`. On uncaught throw, classify via `classifyError(err)`:
  - 401/403 from Notion → `auth_error` → exit 1 (R8)
  - 4xx with body (other) → `notion_api` → exit 1
  - Network 5xx, timeout, ECONNRESET → `transient` → exit 4 (R2)
  - Else → `unknown` → exit 1
- Emit envelope to stdout before `process.exit`, regardless of mode.
- Add `classifyError(err)` and `classifyExitCode(category)` helpers local to each script.

**Execution note:** Test-first. Add the failure-path test for `clearAuditRows` first; it should fail; then add the catch.

**Patterns to follow:**
- [scripts/repair-task-blocks.js](projects/engine/scripts/repair-task-blocks.js) `apply()` function — try/finally that always writes Activity Log on a non-clean outcome.

**Test scenarios:**
- Happy path: `clearAuditRows` with all PATCHes succeeding returns `{ status: 'ok', rowsScanned, rowsCleared }`.
- Error path (Q6 abort): `clearAuditRows` with a 5xx on the third PATCH returns `{ status: 'failed', rowsScanned: 62, rowsCleared: 2, error: { code: 'patch_failed', rowId: 'row-3', message } }`. Loop does NOT continue past row 3.
- Error path: `run()` with an unhandled throw inside `fireDeletionAndPoll` (queryAll throws) is caught by `runMain`, emits `{ ok: false, error: { code: 'transient' | 'unknown', message } }` to stdout in JSON mode, exits 4 if transient else 1.
- Error path: `notionFetch` throws 401 → `error.code: 'auth_error'`, exit 1.
- Error path: `notionFetch` throws 403 → `error.code: 'auth_error'`, exit 1.
- Error path: `notionFetch` throws 400 (malformed body) → `error.code: 'notion_api'`, exit 1.
- Integration: `runMain` in JSON mode ALWAYS produces a parseable JSON object on stdout — test with a fixture that throws synchronously inside `run`.

**Verification:**
- All `recover-inception.js` exit paths in JSON mode produce a JSON object on stdout.
- `clearAudit.status !== 'ok'` branch in `run()` is reachable.
- `error.code: 'auth_error'` distinct from `error.code: 'notion_api'` in classified output.
- clearAuditRows aborts on first error (rowsCleared < rowsScanned in failure scenario).

---

- U4. **Transient network errors don't trigger destructive recovery; AbortSignal.timeout + fetch-layer retry (PR A)**

**Goal:** Distinguish "Activity Log says Failed" (legit recovery trigger) from "couldn't reach Notion" (do not auto-recover). Add new exit code 4 to `check-inception` for inconclusive reads. Wrapper recognizes 4 and surfaces it without firing `/webhook/deletion`. Retry-with-backoff lives **inside `makeDefaultNotionFetch`** (Q7) so all callers benefit. `AbortSignal.timeout(30000)` makes hung connections detectable.

**Requirements:** R2, R16, R17.

**Dependencies:** U2 (uncaught-throw catch path).

**Files:**
- Modify: `scripts/batch-migrate/check-inception.js` (`makeDefaultNotionFetch` with retry + timeout + `classifyError`)
- Modify: `scripts/batch-migrate/recover-inception.js` (same wrapper changes)
- Modify: `scripts/batch-migrate/migrate-with-recovery.sh` (case statement for exit 4)
- Test: `test/scripts/batch-migrate/check-inception.test.js`
- Test: `test/scripts/batch-migrate/recover-inception.test.js`

**Approach:**
- **Inside `makeDefaultNotionFetch`** (Q7): wrap the `fetch()` call with a retry loop. Default 2 retries × 5s backoff on 5xx, network timeout, ECONNRESET. On retry exhaustion, throw a categorized error.
- **Add `AbortSignal.timeout(30000)`** to the `fetch()` opts (R16). Without this, retry-with-backoff cannot detect hung TCP-level connections.
- Tests inject a non-retrying mock `notionFetch` (so retry doesn't slow tests). Production `makeDefaultNotionFetch` includes retry + timeout.
- `classifyError` discriminates per R8.
- Wrapper: add `case 4) banner "⚠ check-inception inconclusive — do NOT auto-recover; investigate"; exit 2 ;;` before the wildcard.

**Test scenarios:**
- Error path: `notionFetch` throws 5xx three times (exceeds retry budget) → `{ exitCode: 4, result.state: 'inconclusive', error.code: 'transient' }`.
- Error path: `notionFetch` throws once then succeeds → eventually returns `{ exitCode: 0 }`.
- Error path: `notionFetch` hangs → `AbortSignal.timeout(30000)` fires → retry triggered → eventually exhausts → `error.code: 'transient'`.
- Error path: `notionFetch` throws 4xx → classified as `auth_error` (401/403) or `notion_api` (other 4xx), exit 1, NOT 4.
- Integration: wrapper sees exit 4 → does NOT fire `/webhook/deletion`. Outcome `inconclusive`.

**Verification:**
- Retry-with-backoff is in `makeDefaultNotionFetch`, NOT at each call-site.
- `AbortSignal.timeout(30000)` present in both `makeDefaultNotionFetch` definitions.
- All test scenarios pass.

---

- U5. **Manual-task guard before `/webhook/deletion` — refuse-and-surface, no override (PR A)**

**Goal:** Honor [runbook Step 3](projects/engine/docs/runbooks/inception-batch-incomplete.md). Before firing `/webhook/deletion`, query Study Tasks where `Study=prodId AND [Do Not Edit] Template Source ID is_empty`. Refuse if count > 0; do NOT add an override flag.

**Requirements:** R4.

**Dependencies:** U2.

**Files:**
- Modify: `scripts/batch-migrate/recover-inception.js` (`fireDeletionAndPoll`)
- Test: `test/scripts/batch-migrate/recover-inception.test.js`

**Approach:**
- `fireDeletionAndPoll` pre-flight query for manual tasks. Filter shape:
  ```
  {
    and: [
      { property: 'Study', relation: { contains: prodId } },
      { property: '[Do Not Edit] Template Source ID', rich_text: { is_empty: true } },
    ],
  }
  ```
  Bare `is_empty` is not a valid Notion filter; the `rich_text:` wrapper is required.
- If `count > 0`, return `{ name: 'deletion', status: 'failed', error: { code: 'manual_tasks_present', message: 'N manual Study Tasks present; archive in Notion UI before re-running', manualTaskIds: [...] } }`. Webhook NOT fired.
- Pre-flight check fires immediately before `await fireWebhook('/webhook/deletion', ...)`.
- TOCTOU race (Q9) acknowledged: PM can add a task between check and fire. Add a comment in the code; document in README/runbook follow-up; engine-side filter narrowing is the durable mitigation (Deferred Follow-Up).

**Test scenarios:**
- Happy path: zero manual tasks → deletion proceeds normally.
- Refuse path: 5 manual tasks present → returns `{ status: 'failed', error.code: 'manual_tasks_present', error.manualTaskIds: [...] }`. Webhook NOT fired. Exit 1.
- Filter shape correctness: assert the filter object has `rich_text: { is_empty: true }`, not bare `is_empty`.
- Integration: full `run()` with manual tasks present → exit 1, envelope reflects `manual_tasks_present`, no destructive side effects.

**Verification:**
- Manual-task pre-check fires BEFORE `await fireWebhook('/webhook/deletion', ...)`.
- Manual-task IDs captured in deletion stage's result.
- No `--include-manual-tasks` flag exists in the script's arg parsing.

---

- U7. **Port `queryAll` cursor-retry into `recover-inception.js` (PR A)**

**Goal:** `recover-inception`'s local `queryAll` survives Notion cursor invalidation. Same root cause as the [GSK SLE BEACON 61-row loss](projects/engine/docs/solutions/silent-partial-failure-in-async-batches.md). Local port — endpoints differ from `notion.js`'s `queryDb`.

**Requirements:** R11.

**Dependencies:** U2.

**Files:**
- Modify: `scripts/batch-migrate/recover-inception.js` (`queryAll`)
- Test: `test/scripts/batch-migrate/recover-inception.test.js`

**Approach:**
- **Port locally, do NOT import from `notion.js`.** Endpoint divergence: `/v1/databases/${id}/query` (legacy, 2022-06-28) vs `/v1/data_sources/${ds}/query` (2025-09-03).
- Pattern: on cursor invalidation (`object: 'error'`, `code: 'validation_error'` with cursor-related message), restart from page 1, max 3 attempts. Mirror [src/notion/client.js:264-301](projects/engine/src/notion/client.js:264) with a `// see notion.js queryDb for canonical pattern` reference comment.
- On retry exhaustion: throw a categorized error (`code: 'cursor_exhausted'`).
- Always return a structured value at every loop exit (CodeBase review P1 #3).

**Patterns to follow:**
- [src/notion/client.js:264-301](projects/engine/src/notion/client.js:264).

**Test scenarios:**
- Happy path: `queryAll` paginates 3 pages, returns the union — no retry needed.
- Error path: cursor invalidation on page 2 → restart from page 1 → succeed on attempt 2.
- Error path: cursor invalidation on every attempt → throw `cursor_exhausted` error caught by `runMain`.
- Edge: cursor invalidation with no `next_cursor` returned — handled gracefully.

**Verification:**
- Stub Notion to return cursor invalidation on the second page; `queryAll` returns full result on retry.
- No silent truncation: `queryAll` either returns all results or throws.

---

### PR B — Contract

- U11. **Branch off PR A's tip; cherry-pick Contract changes; create PR B**

**Goal:** Set up the Contract PR branch. Stack on PR A.

**Dependencies:** PR A merged into main, OR PR A's branch tip stable enough to stack on.

**Approach:**
- `git checkout main && git pull` (or wait for PR A merge).
- `git checkout -b chore/batch-migrate-contract-unification`.
- Cherry-pick the Contract-relevant chunks from the original `6455a78` (or re-implement per the spec below).
- Push and open PR B with PR A as the merge target if not yet merged.

**Verification:**
- PR B's diff is ONLY `compose-envelope.js` + JSON shapes in `check-inception.js` / `recover-inception.js` + test assertions.

---

- U6.0. **schemaVersion bump policy docblock (PR B, standalone commit) (Q8)**

**Goal:** Add the schemaVersion bump policy as a 4-line docblock at the top of `compose-envelope.js`. **Lands as its own commit** before the larger U6 work for cleaner review history.

**Requirements:** R6.

**Dependencies:** U11.

**Files:**
- Modify: `scripts/batch-migrate/compose-envelope.js` (header docblock only)

**Approach:**
- Add docblock at the top of the file:
  ```
  // schemaVersion bump policy:
  //   - Additive changes (new fields, new error codes, new outcome values): no bump.
  //   - Field rename or removal, or change to existing field semantics: bump (1 → 2).
  //   - Future versions MAY include `compatibleWith: ['1']` for back-compat reading.
  ```
- Commit alone with message: `docs(batch-migrate): document schemaVersion bump policy in compose-envelope`.

**Test scenarios:** none — comment-only change.

**Verification:**
- Diff is exactly the 4-line docblock addition.
- Commit lands in PR B before U6's commit.

---

- U6. **Unify JSON contract: discriminator + state enum + casing + outcome map (PR B)**

**Goal:** One discrimination pattern (`ok: true | false`), one casing convention (snake_case), exhaustive `state` enum, conditional outcome derivation per Q5/Q10/R18.

**Requirements:** R5, R7, R8, R12, R18.

**Dependencies:** U6.0 (the docblock commit precedes this).

**Files:**
- Modify: `scripts/batch-migrate/check-inception.js` (`run()` result shape)
- Modify: `scripts/batch-migrate/recover-inception.js` (`run()` result shape + stage shapes)
- Modify: `scripts/batch-migrate/compose-envelope.js` (envelope shape + outcome map)
- Modify: tests across all 3 test files

**Approach:**
- All success returns get `ok: true`; all failure returns get `ok: false` + `error: { code, message }`.
- Replace `state: 'other'` with explicit tokens: `in_progress`, `unknown`, `cancelled` (snake_case). Map from Activity Log status names: `In Progress` → `in_progress`, etc.
- Rename kebab-case state tokens to snake_case: `no-entry` → `no_entry`, etc.
- `compose-envelope` outcome map (conditional per Q5/Q10):
  - `state: success` → outcome `clean` (regardless of orch_exit)
  - `state: failed` → (depends on recovery → `recovered` / `failed`)
  - `state: in_progress | unknown | cancelled`:
    - if `orch_exit ≠ 0` → outcome `failed`
    - if `orch_exit == 0` → outcome `inconclusive`
  - `state: no_entry | no_exported_row | no_production_study` → outcome `failed`
  - `state: inconclusive` (transient from U4) → outcome `inconclusive`
  - `recovery.alreadySuccess: true`:
    - if `orch_exit == 0` → outcome `already_success`
    - if `orch_exit ≠ 0` → outcome `failed` (Q10)

**Test scenarios:**
- All existing tests' state-token assertions updated to snake_case.
- New test: `state: 'in_progress'` when Activity Log returns `In Progress`.
- New test: outcome map correctness:
  - `{ state: 'in_progress', orch_exit: 0 }` → `outcome: 'inconclusive'`
  - `{ state: 'in_progress', orch_exit: 1 }` → `outcome: 'failed'` (Q5 conditional)
  - `{ recovery: { alreadySuccess: true }, orch_exit: 0 }` → `outcome: 'already_success'`
  - `{ recovery: { alreadySuccess: true }, orch_exit: 1 }` → `outcome: 'failed'` (Q10)
- New test: `compose-envelope` envelope always has `ok` field.
- Backwards-compat: `--format=status` still emits human-readable tokens.

**Verification:**
- Grep for `state:` and `error.code:` strings; all are snake_case.
- Every JSON success and failure return has `ok: true | false`.
- Outcome map honors orch_exit conditional.

---

- U3. **Wrapper exit code mirrors envelope outcome (PR B)**

**Goal:** `migrate-with-recovery.sh --json` final exit reads from `envelope.exitCode`. No parallel exit-code logic in shell.

**Requirements:** R1, R15.

**Dependencies:** U6 (envelope's outcome map is stable).

**Files:**
- Modify: `scripts/batch-migrate/migrate-with-recovery.sh`
- Modify: `scripts/batch-migrate/compose-envelope.js`

**Approach:**
- `compose-envelope.js`: add `exitCode` field to the envelope, derived from `outcome`:
  - `clean` / `recovered` / `already_success` → 0
  - `inconclusive` → 2
  - `failed` → 1
- Bash wrapper: capture compose-envelope's stdout into `ENVELOPE_JSON`. Final step: parse `.exitCode` and `exit "$ENVELOPE_EXIT"`.
- Remove ad-hoc final-exit guards.

**Test scenarios:**
- Happy path: clean → exitCode 0.
- Failure: `state: no_entry` → outcome `failed` → exitCode 1.
- Failure: `state: inconclusive` → outcome `inconclusive` → exitCode 2.
- Recovery: success → outcome `recovered` → exitCode 0.
- Recovery: failed final check → outcome `failed` → exitCode 1.
- alreadySuccess + clean orch → outcome `already_success` → exitCode 0.
- alreadySuccess + failed orch → outcome `failed` → exitCode 1 (Q10).

**Verification:**
- For each test scenario, `bash migrate-with-recovery.sh study --json; echo $?` matches `envelope.exitCode`.
- No parallel exit-code derivation logic remains in bash.

---

- U8. **`compose-envelope` honors `alreadySuccess` recovery (PR B)**

**Goal:** When `recover-inception` returns `alreadySuccess: true`, outcome derivation is correct per Q10.

**Requirements:** R12.

**Dependencies:** U6.

**Files:**
- Modify: `scripts/batch-migrate/compose-envelope.js`
- Test: `test/scripts/batch-migrate/compose-envelope.test.js`

**Approach:**
- Outcome derivation (already specified in U6's outcome map):
  - `recovery?.alreadySuccess === true` AND `orch_exit == 0` → `outcome: 'already_success'`
  - `recovery?.alreadySuccess === true` AND `orch_exit ≠ 0` → `outcome: 'failed'` (Q10)
- `recoveryPerformed` semantics: `true` if `RECOVERY_JSON` is non-empty AND parsed successfully. The `alreadySuccess` case is `recoveryPerformed: false` (recovery checked but didn't run).

**Test scenarios:**
- Happy path: check failed, recovery returns alreadySuccess, orch clean → outcome `already_success`, exit 0.
- Edge: check failed, recovery returns ok with stages → outcome `recovered`, exit 0.
- Error: check failed, recovery returns `ok: false` → outcome `failed`, exit 1.
- Q10 edge: alreadySuccess + orch_failed → outcome `failed`, exit 1.

**Verification:**
- Tests above all pass.
- Bash wrapper's exit code matches outcome for all alreadySuccess scenarios.

---

### PR C — Polish

- U12. **Branch off PR B's tip; cherry-pick Polish changes; create PR C**

**Goal:** Set up the Polish PR branch.

**Dependencies:** PR B merged into main, OR PR B's branch tip stable.

**Approach:** Same pattern as U11 but for Polish-relevant changes only.

**Verification:** PR C's diff is ONLY test files + parity fixes in `check-inception.js` / `recover-inception.js`.

---

- U9. **Cover untested branches; replace brittle test dispatch (PR C)**

**Goal:** Close the three coverage gaps the review flagged. Replace filter-shape dispatch with stable discriminator.

**Requirements:** R10, R13.

**Dependencies:** U12.

**Files:**
- Modify: `test/scripts/batch-migrate/check-inception.test.js`
- Modify: `test/scripts/batch-migrate/recover-inception.test.js`

**Approach:**
- `check-inception.test.js`: add tests for `state: 'in_progress'`, `'unknown'`, `'cancelled'`. Mock Notion to return Activity Log entry with corresponding Status. Assert exit 2, state matches.
- `recover-inception.test.js`: add test for `no_production_study` failure path. Assert exit 1, error.code `no_production_study`, no webhook fired.
- `recover-inception.test.js`: add test for `reInceptionAndVerify` Activity Log empty. Mock the post-stabilization AL query to return `results: []`. Assert `activityLogStatus: null`, status `failed`, error.code `inception_not_success`.
- Replace `!body.filter.and` filter-shape dispatch with stable dispatch on data-source ID in path.

**Test scenarios:** (covered by the bullets above).

**Verification:**
- Code-coverage report shows previously-dead branches as exercised.
- All new tests pass; no false dispatch in the all-stages test.

---

- U10. **Default-mode parity polish (PR C)**

**Goal:** Fix the small parity drifts (P3 findings).

**Requirements:** R14.

**Dependencies:** U12.

**Files:**
- Modify: `scripts/batch-migrate/check-inception.js` (human path: `'[null]'` fallback; docblock for `NoExportedRow` token)
- Modify: `scripts/batch-migrate/recover-inception.js` (webhook-banner ordering: print before await; emit `0/0` line when `dirty.length === 0`)

**Approach:**
- check-inception human path: `[${result.createdTime || 'Z'}]` instead of `[${result.createdTime}]`. Docblock at the top of the file lists all `--format=status` tokens including `NoExportedRow`.
- recover-inception onProgress callback: split `deletion-fired` into `deletion-firing` (banner before await) and `deletion-fired` (✓ after await). clearAudit progress: emit `0/0\n` when `dirty.length === 0`.

**Test scenarios:**
- Test expectation: none — covered by manual default-mode verification.

**Verification:**
- Run each script in default mode against ionis-hae-001; output matches pre-polish behavior byte-for-byte (modulo the parity fixes).

---

## System-Wide Impact

- **Interaction graph:** The wrapper bash script orchestrates 4 sub-processes. Changes to the JSON contract in any sub-helper propagate to the wrapper's envelope. compose-envelope.js is the integration point.
- **Error propagation:** The "uncaught throws → JSON envelope" rule (U2) reshapes the error path. Every sub-helper now produces a parseable JSON object on stdout regardless of failure mode.
- **State lifecycle risks:** U5's manual-task guard prevents the most dangerous state transition (silent archival of PM-added tasks). U2 + U7 prevent silent partial deletion when polling truncates. TOCTOU race in U5 (Q9) acknowledged but not fully closed.
- **API surface parity:** The new contract conventions (snake_case error codes, `ok` discriminator, schemaVersion bump policy, conditional outcome derivation) become the engine's CLI standard. Other scripts in `scripts/` follow when next polished.
- **Integration coverage:** Bash wrapper is hard to unit-test; cross-layer behavior verified by live integration runs. Per-stage Vitest coverage covers the JS modules in isolation.
- **Unchanged invariants:** Default mode (no `--json`) output remains byte-identical for the success path. `--format=status` continues to emit human-readable tokens. Exit codes 0/1/2/3 retain their existing semantics; exit 4 is additive.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Re-applying the polish during fixes regresses default-mode parity | Live verification on Ionis HAE 001 before merging — diff stdout against pre-polish baseline. U10 covers the parity fixes. |
| U4's transient-error retry adds latency to the agent path | Bound retries (2 attempts × 5s = max 10s additional). `AbortSignal.timeout(30000)` caps individual request hangs. Tunable via dep injection. |
| U5 refuses recovery when manual tasks present, blocking legit recoveries | Per the runbook, this is correct behavior. `error.message` includes manual-task IDs. |
| TOCTOU race in U5 (PM adds task between pre-flight and webhook fire) | Engine-side filter narrowing is the durable fix (Deferred Follow-Up). README and runbook to call out timing risk. |
| U7's local cursor-retry diverges from `notion.js`'s | Source comment points at canonical pattern. Endpoint divergence documented inline. |
| U6's snake_case rename is a contract change | PR #100 is OPEN; verify no consumers via `git grep` before merge. Note in PR description. |
| Rebase conflicts in U1 | Use `git rebase -i` or `--empty=drop`. Verify post-rebase diff matches expected file list. |
| U2's `runMain` catch could swallow programmer errors | `classifyError` returns `unknown` for un-categorized errors → exit 1 + envelope error.code `unknown` + actual error message. |
| 3-PR stack — coordination overhead | PR A independently mergeable; B depends on A; C depends on B. Each smaller PR easier to review. Mitigate with stack tooling (`gh pr review`, etc.). |
| Q5 conditional outcome rule requires compose-envelope to read orch_exit | Bash wrapper already passes `ORCH_EXIT_CODE` env var to compose-envelope (existing behavior). New work: just consume it in outcome derivation. |

---

## Sources & References

- **Origin (code review):** ce-code-review run `/tmp/compound-engineering/ce-code-review/20260506-121021-f8e639d0/`.
- **Origin (doc review):** ce-doc-review run on this plan completed 2026-05-06; 6 personas, 19 actionable findings, 12 FYI; all 10 deferred questions (Q1-Q10) resolved interactively.
- **Reference pattern:** [scripts/repair-task-blocks.js](projects/engine/scripts/repair-task-blocks.js), [test/scripts/repair-task-blocks.test.js](projects/engine/test/scripts/repair-task-blocks.test.js).
- **Cursor-retry source:** [src/notion/client.js:264-301](projects/engine/src/notion/client.js:264). Mirror in [scripts/batch-migrate/notion.js](projects/engine/scripts/batch-migrate/notion.js) (post-`0cde3e0`, but for legacy `databases` endpoint).
- **Runbook:** [docs/runbooks/inception-batch-incomplete.md](projects/engine/docs/runbooks/inception-batch-incomplete.md).
- **Property reference:** [src/notion/property-names.js](projects/engine/src/notion/property-names.js).
- **Institutional learnings:** [docs/solutions/silent-partial-failure-in-async-batches.md](projects/engine/docs/solutions/silent-partial-failure-in-async-batches.md), [docs/plans/2026-05-04-001-fix-inception-silent-batch-abort-plan.md](projects/engine/docs/plans/2026-05-04-001-fix-inception-silent-batch-abort-plan.md), [docs/CODEBASE-REVIEW-2026-04-07.md](projects/engine/docs/CODEBASE-REVIEW-2026-04-07.md).
- **Original polish plan:** `~/.claude/plans/you-re-polishing-the-3-compressed-rocket.md`.
- **Open PR:** [picnic-cascade-engine#100](https://github.com/optemization-tech/picnic-cascade-engine/pull/100).
