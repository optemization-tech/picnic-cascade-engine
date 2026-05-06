---
title: Silent partial-failure in async batch flows
date: 2026-05-05
tags: [reliability, observability, batch, notion-api, anti-pattern]
related:
  - PR #98 (silent Inception batch-abort fix)
  - PR #96 (batch-migrate orchestrator)
  - .claude/plans/phase-5-silent-patch-failure-investigation.md
---

# Silent partial-failure in async batch flows

## Problem

Async batch flows in this engine have repeatedly silently dropped work without surfacing the loss. Two distinct incidents in 2 weeks (2026-04-30 → 2026-05-05) followed the same shape: a batch operation processed N items, M < N actually landed, and the caller reported success with no signal that M ≠ N. Recovery was only possible because external observability (Meg spot-checking, post-flight count audit) caught the discrepancy.

This is the most expensive class of bug in the engine right now — silent loss is unrecoverable without manual reconciliation, and it erodes trust in every subsequent batch run.

## Why it matters

- **Unrecoverable in real time.** A noisy failure can be retried; a silent failure can only be detected via downstream comparison, days or weeks later.
- **Compounds across batches.** The 2026-04-30 batch silently dropped 70 of 202 Inception tasks for Ionis; 5 days later the orchestrator silently dropped 61 of 210 Phase-5 PATCHes for GSK. Same anti-pattern, different layers.
- **Defeats the engine's own safety net.** The engine has gates (double-inception guard, withStudyLock, Migrator dry-run) that all assume callers report truthful counts. A caller that lies about success bypasses every gate.

## The anti-pattern

```
batch_op(N items) →
  for item in items:
    try { await do_one(item) } catch (silent or partial)
  return success_count   // ← reports the count it observed, NOT the count it expected
```

Variants in this codebase:

1. **Promise.all swallowing rejections** — one rejected slot becomes one undefined in the result array, and a downstream `.length` count of "successful" results equals the wrong number. (Fixed in PR #98 by partitioning runParallel's mixed return into successes / failedUnsafe / notAttempted buckets.)

2. **Pagination silently truncating** — `queryDb` paginates with `cursor`. If Notion invalidates the cursor mid-flight (workspace-wide schema mutation, concurrent batch traffic), the paginator can return `has_more: false` early. Caller sees a "complete" array of length M < N. (Diagnosed in `.claude/plans/phase-5-silent-patch-failure-investigation.md`. Fix: port engine's existing cursor-retry from `src/notion/client.js:264-301` to `scripts/batch-migrate/notion.js`.)

3. **Per-item catch + log + continue** — common in scripts. Each failure becomes a `console.error` line, but the loop completes and the script exits 0. Consumers see green.

## The pattern (load-bearing rule)

> **A batch caller reports `count_observed`, never `count_expected`. The reconciliation is the caller's job.**

Every async batch operation must:

1. **Track expected count up front** (`attempted`, `n_input`, `to_process.length`). This is the contract input.
2. **Partition outcomes into ≥3 buckets**: succeeded, failed-unsafe (work may have happened server-side), not-attempted (work was abandoned mid-batch). Two buckets isn't enough — `failedUnsafe` requires different recovery than `notAttempted`.
3. **Emit failure when `succeeded < attempted`**, even when the failure is "soft" (no exceptions thrown). Throw a structured Error with all four counts as own properties.
4. **Verify post-state, not just operation count.** When the batch's effect is a queryable state mutation, re-query the state and compare. The orchestrator's Phase 5 verification re-query is the canonical example.

## Detection recipe

When reviewing a new async batch flow, ask:

- **Q1: What's `attempted`?** If you can't point at a line that captures it before the loop runs, the flow can't tell whether it lost work.
- **Q2: What happens to a worker that throws?** If it's `try/catch`-wrapped silently, that's a smell. The catch should at least mark the slot as failed-unsafe.
- **Q3: What happens to work that's never picked up?** If `runParallel`-style cancellation can leave items un-attempted, those need a separate bucket.
- **Q4: Does the caller verify post-state?** Count operations succeeded ≠ count of state changes that landed. For Notion writes, "PATCH returned 200" doesn't guarantee "the property is now visible to subsequent queries." For paginated reads, "loop terminated" doesn't guarantee "all rows were fetched."
- **Q5: How would an operator notice a silent partial-failure today?** If the answer is "they wouldn't, until a downstream consumer flags it," the flow needs work.

## Fix recipe

1. **Always partition the outcome.** `Promise.allSettled` over `Promise.all`; explicit buckets over `.filter(Boolean)`.
2. **Throw on partial success.** Construct a structured Error with `kind`, `attempted`, `succeeded`, `failedUnsafe`, `notAttempted`, plus any per-item context the caller's reporter needs (e.g. `idMapping`).
3. **Surface the failure end-to-end.** Activity Log body line, Production Study `Automation Reporting`, study-page comment via `commentClient`. Each layer that wraps the batch must propagate the partial-failure signal up to the human.
4. **Verify post-state for state-changing batches.** Re-query the dest after the batch, count what's actually there, compare to expected. Warn (or throw) on mismatch.
5. **Document the recovery procedure.** Every silent-failure-detection signal needs a runbook (see `docs/runbooks/inception-batch-incomplete.md` for the template).

## Case study #1 — Inception silent batch-abort (PR #98)

**Symptom.** 2026-05-01: Ionis HAE 001 Inception reported `status: success` with `totalCreated: 131`. Blueprint count was 202. 70 tasks invisibly absent. Discovery: Meg noticed missing milestones in the cascade.

**Root cause.** `createStudyTasks` filtered `runParallel`'s mixed return (`page | Error | undefined`) and computed `successes = results.filter(r => r && !(r instanceof Error))`. Filtered out *both* error workers and not-attempted workers in one bucket — then `successes.length` (131) was reported as `totalCreated`. No surface anywhere said "we attempted 202, only 131 landed."

**Fix.** Partition into `successes / failedUnsafe / notAttempted`. Throw structured Error when either failure bucket is non-zero. Tracer + Activity Log render `Batch incomplete: created X of Y (Z failed transient, W not attempted)` body line. Two contract-drift guards: per-slot (rejects shapes that aren't `page | Error | undefined`) and array-length (bucket sums must equal entries.length).

**Detection signal post-fix.** Activity Log entry with `Status: Failed` + body line containing "Batch incomplete." Operator runs runbook (`docs/runbooks/inception-batch-incomplete.md`) and re-runs Inception.

**Validated 2026-05-05.** Biogen FA ARIES Inception silently aborted at 134/202 in the live batch. Activity Log surfaced it. Runbook recovery worked end-to-end. Same flow caught a second silent abort on a later GSK Inception attempt.

## Case study #2 — Phase 5 cursor pagination loss (orchestrator, ungated as of 2026-05-05)

**Symptom.** 2026-05-05: GSK SLE BEACON's batch-migrate Phase 5 reported `PATCHed 149 rows with Study relation` (green checkmark). Source DB had 210 rows. 61 rows ended up in the dest DB with empty `Study` relation. Reproduced exactly on a second attempt.

**Root cause.** `queryDb` (scripts/batch-migrate/notion.js:108-121) paginates Notion's `/v1/databases/{id}/query` without cursor-invalidation retry. Under concurrent batch traffic (other studies' Phase 5 ops mutating the dest schema simultaneously), Notion can silently terminate pagination at a short page. The orchestrator treats the truncated array as the full set; the PATCH loop completes cleanly on the truncated set; success log fires on `count_observed`, not `count_expected`.

**Why other studies were unaffected.** Pagination only had multiple-page risk for studies with >100 source rows. GSK's 210 rows hits a 3-page boundary (100+100+10) where Notion's smallest-final-page is most likely to be lost under concurrent load. Other studies in the batch were either single-page or shape-different.

**Fix (recommended, not yet shipped).** Port the engine's existing cursor-retry from `src/notion/client.js:264-301` into `scripts/batch-migrate/notion.js`. Throw on cursor-retries-exhausted. Add a Phase 5 verification re-query that counts dest-linked rows and warns if `< patched`.

**Recovery (manual, used 2026-05-05).** Filter dest DB for `Study is_empty`, PATCH each orphan with the correct Study relation, re-fire Migrator with `--skip-create-study --skip-inception`. See `pulse-log/05.05/002-gsk-sle-beacon-orphan-recovery.md`.

## What this learning closes

- Engineers writing new async batch flows have a checklist before shipping (the Detection recipe above).
- Reviewers know what to demand in code review (post-state verification, partition over filter, throw on partial).
- Operators know that "✓ batch complete" log lines from this codebase pre-2026-05-05 should not be trusted blindly when state divergence matters — audit via re-query.

## What it doesn't close

- Static / lint-level enforcement of the pattern. There's no current way to mechanically catch a missing post-state verification in CI.
- The orchestrator's Phase 5 fix itself (separate PR; this doc just describes the pattern).

## References

- PR #98 commit `8f309de` (Inception silent batch-abort fix)
- PR #98 description: full plan + autofix history
- `docs/runbooks/inception-batch-incomplete.md` (operator-facing recovery)
- `.claude/plans/phase-5-silent-patch-failure-investigation.md` (Session 8 diagnosis)
- `pulse-log/05.05/002-gsk-sle-beacon-orphan-recovery.md` (recovery dogfood)
- `pulse-log/04.30/008-moderna-batch-migrate-shipped-jot.md` (orchestrator architecture, schema-extension caveat)
