# Runbook: Missing task body content

**When this fires.** A PM reports that one or more tasks in their study show
no body content (no checklist, instructions, SOPs) where the Blueprint template
clearly has content. The Activity Log entry for `Inception — <Study Name>` shows
`Status: Success` but the diagnostic JSON includes `pagesSkipped > 0`.

**What it means.** The inception webhook ran to completion and created all task
rows with the right properties, but the asynchronous copy-blocks phase skipped
some pages. Most skips are legitimate (Blueprint templates with empty bodies),
but a small fraction can be true failures (BL-L16's `body.children undefined`
on template `df123867-60c2-82fe-9c51-816ddf061fe9`, transient Notion 5xx, etc.).

The script `scripts/repair-task-blocks.js` distinguishes the two and re-runs
copy-blocks for the targeted subset only — without disturbing dates, relations,
or any other property.

This runbook covers the **partial M2 case** only (≤ 10 affected tasks per study).
For the **batch-incomplete case** (inception's runParallel aborted mid-flight,
leaving entirely missing tasks), follow [`inception-batch-incomplete.md`](inception-batch-incomplete.md)
instead.

---

## Decision tree

```
Activity Log shows partial inception state for the study?
├── Status = Failed, summary "Batch incomplete: created X of Y …"
│      → inception-batch-incomplete.md  (M1 — full archive + re-run)
│
├── Status = Success, but tasks visibly missing body content
│      → repair-task-blocks.js  (M2 — this runbook)
│
├── Tasks have wrong dates, broken relations, missing References
│      → escalate to engineering — write a follow-up plan
│         (the failure shape determines the safe repair)
│
└── More than ~10 affected tasks per study
       → repair-task-blocks.js's hard gate refuses the run.
         For Migration Asana studies: scripts/batch-migrate/recover-inception.js.
         For Playgrounds: archive partial via inception-batch-incomplete.md
                           + manual /webhook/inception re-fire.
```

---

## How to invoke

### 1. Diagnose (always run first — read-only)

```bash
node scripts/repair-task-blocks.js --study <studyPageId>
```

Prints a per-category breakdown:

```
Diagnose results:
  Tasks scanned (Template Source ID set):  202
  Present (body has content):              193
  Missing body, repair candidate:          1
  Known-broken skip (BL-L16):              1
  Empty-template skip (legitimate):        7
  Probe errors (investigate):              0

Repair list (1):
  - Some Task Name (35723867-…) ← template 4abc…

Known-broken skips (1):
  - The BL-L16 task (35723867-…) — template df123867-… (BL-L16: manually paste from Blueprint)
```

What each category means:

| Category | Meaning | What to do |
|---|---|---|
| `Present (body has content)` | Task has body — nothing wrong | nothing |
| `Missing body, repair candidate` | Task body empty AND template has content. **Real failure.** | repair via `--apply` |
| `Known-broken skip (BL-L16)` | Template `df123867-…` always errors on copy-blocks. Skip-listed. | manually paste from Blueprint until BL-L16 root cause lands |
| `Empty-template skip (legitimate)` | Template body is empty by design. Not a failure. | nothing |
| `Probe errors (investigate)` | Notion API error during diagnose. Could be a new known-broken template or transient issue. | investigate; rerun diagnose; if persistent, add the template to the skip-list |

### 2. Apply (writes — toggles Import Mode + calls copyBlocks)

```bash
node scripts/repair-task-blocks.js --study <studyPageId> --apply
```

The script will:

1. Verify the study's `[Do Not Edit] Import Mode` is **false** (aborts if true — see "Stuck Import Mode" below).
2. Print the study name and ask `Continue? [y/N]`. (Use `--yes` to skip the prompt for automation.)
3. PATCH the study's `[Do Not Edit] Import Mode` to **true**.
4. Call `copyBlocks(client, idMapping, opts)` for the repair subset only.
5. PATCH the study's `[Do Not Edit] Import Mode` back to **false** in `finally`.
6. Write one Activity Log entry: Workflow `Copy Blocks`, Trigger `Manual`, Summary `Manual block repair: …`.

### 3. Verify

After `--apply`:

- ✅ Activity Log shows a new `Copy Blocks — <Study Name>` entry with Status `Success` and `Trigger Type = Manual`.
- ✅ Study's `[Do Not Edit] Import Mode` is `false` (Notion UI checkbox unchecked).
- ✅ Open one of the repaired tasks — body now matches the Blueprint template's body.
- ✅ (Optional cascade test) Move dates on a non-leaf task in the study and confirm the cascade propagates as expected.

---

## Hard gate (`--max`)

Default: **10 tasks per run.** If diagnose flags more than 10 tasks for repair,
the script aborts before any write. This is intentional — large failure rates
suggest a systemic issue that warrants investigation, not bulk repair.

To override (after engineering review):

```bash
node scripts/repair-task-blocks.js --study <id> --apply --max 25
```

Tune `--max` consciously; do not raise it as a workaround.

---

## Lock-domain caveat (read this before every run)

`scripts/repair-task-blocks.js` runs locally on an operator's machine, while
`/webhook/inception`, `/webhook/add-task-set`, and `/webhook/migrate-study`
run on Railway. Their `withStudyLock` is **process-local** — the laptop
process and the Railway process do **not** share lock state. If a PM clicks
an inception/add-task-set/migrate button on the same study while this script
is mid-`--apply`, both processes will write concurrently.

The script's safety relies on:

1. **Pre-flight Import Mode check** — aborts if `[Do Not Edit] Import Mode = true` on entry.
2. **Operator coordination** — the operator MUST confirm no buttons on this study will be clicked during the run. Coordinate via Slack/DM with the PM if needed.
3. **Body-only writes** — the script only PATCHes `/blocks/{taskId}/children` and the study Import Mode toggle. It does not touch dates, relations, or any other property, so even a worst-case race doesn't corrupt the cascade graph.

If the failure cost is high (large study, public-facing PM), consider running
during a low-activity window (early morning, end of day).

A future engine PR will add a distributed lock (Notion `[Do Not Edit] Recovery
In Progress` property checked by all webhook handlers AND local CLIs). Until
then, this is operator-side hygiene.

---

## Stuck Import Mode

If a prior `--apply` run was killed by `SIGKILL`, OOM, or a `process.exit()`
that bypassed the `finally` block, the study's `[Do Not Edit] Import Mode`
may be stuck at `true`. The script's pre-flight will refuse to run:

```
[abort] Study "Foo" has [Do Not Edit] Import Mode = true.
  Either (a) another inception/migrate/add-task-set is in progress (wait + retry),
  or (b) a prior run was killed (SIGKILL/OOM) and Import Mode is stuck.
```

Recovery:

1. Confirm no Railway operation is in progress (check Activity Log for the most recent entry on this study within the last ~5 minutes).
2. If safe to proceed, manually clear Import Mode in Notion: open the Study page, find the `[Do Not Edit] Import Mode` checkbox in the property panel, uncheck it.
3. (Or via API)
   ```bash
   curl -X PATCH "https://api.notion.com/v1/pages/<studyPageId>" \
     -H "Authorization: Bearer $NOTION_PROVISION_TOKEN_1" \
     -H "Notion-Version: 2025-09-03" \
     -H "Content-Type: application/json" \
     -d '{"properties": {"[Do Not Edit] Import Mode": {"checkbox": false}}}'
   ```
4. Re-run the script.

Note: there's also a startup sweep at `src/startup/import-mode-sweep.js` that
clears stuck Import Mode on engine boot, but it doesn't run for laptop scripts.

---

## BL-L16 manual workaround

Until the BL-L16 root cause fix lands, template `df123867-60c2-82fe-9c51-816ddf061fe9`
will always appear in the `Known-broken skip` category. To fill the missing
body content for tasks created from this template:

1. Open the Blueprint template page in Notion (use the templateId reported in diagnose).
2. Select all body content (`Cmd-A` inside the page body).
3. Copy (`Cmd-C`).
4. Open the affected study task page.
5. Paste (`Cmd-V`) into the body.

This is a one-time per study task. Track via the BACKLOG entry for BL-L16 to
know when it's no longer needed.

---

## Idempotency

Re-running `--apply` on an already-repaired study finds 0 tasks needing repair
and exits with code 2 (`nothing to repair`). The script is safe to retry on
transient failures or if you're unsure whether the previous run completed.

Note: Notion eventual consistency means a PATCH made in the first run may not
be visible to a second run for up to ~30 seconds. Wait that long between runs
to avoid spurious re-flagging.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success — diagnose printed, or apply completed |
| `1` | Error — pre-flight abort, gate exceeded, copyBlocks threw, or operator cancelled |
| `2` | Nothing to repair — diagnose found 0 missing-body tasks |
| `3` | Usage / config error — bad args, missing env vars, study not found |

---

## Related runbooks and code

- [`inception-batch-incomplete.md`](inception-batch-incomplete.md) — partial inception (runParallel aborted mid-batch). Different failure mode, different recovery.
- [`scripts/repair-task-blocks.js`](../../scripts/repair-task-blocks.js) — the script.
- [`scripts/verify-inception.js`](../../scripts/verify-inception.js) — broader post-inception verification (dates, relations, References, LMBS, content sample). Useful for detecting issues this runbook doesn't cover.
- [`src/provisioning/copy-blocks.js`](../../src/provisioning/copy-blocks.js) — the engine primitive `repair-task-blocks.js` delegates to.
