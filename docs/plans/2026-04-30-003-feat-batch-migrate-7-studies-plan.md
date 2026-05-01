# Batch Migrate 7 Studies — Plan

**Created:** 2026-04-30 (evening)
**Engagement:** PicnicHealth — picnic-cascade-engine
**Authoring path:** when adopted, copy to `engagements/picnic-health/projects/engine/docs/plans/2026-04-30-003-feat-batch-migrate-7-studies-plan.md` (plan-mode file lives at `~/.claude/plans/prancy-churning-zephyr.md`).

## Context

Yesterday 8 PRs (#86–#95) shipped the Migrate Study webhook end-to-end for **Alexion PNH PLEDGE**. Meg approved on call. Today she wants the same pipeline applied to 7 more studies.

Constraint: **Moderna MMA PA COMPASS by morning** (Group A, schema-clean). The other 6 follow over the next days.

Confirmed prerequisite state for all 7 (per Tem):
- **Production Studies do not exist yet** in the cascade Studies DB
- **Inception has not run** for any of them
- **Source data is already in per-study "X migrated" Notion DBs** visible on the [Migration Approach Notion page](https://www.notion.so/picnichealth/Migration-Approach-Prompt-CSVs-32e2386760c2805295c1f3e977f89991) — NOT yet consolidated into the unified Asana Exported Tasks DB the engine reads from

So the script must own the **full pipeline per study**: create Production Study → Inception → wire Exported Studies relation → consolidate per-study rows into Asana Exported Tasks (with `Study` relation) → trigger Migrate Study webhook → poll for completion.

## Studies in scope

| # | Study | Group | Per-study migrated DB | Schema-mismatch shape |
|---|---|---|---|---|
| 1 | **Moderna MMA PA COMPASS** *(priority)* | A | `34d23867-60c2-8199-bfb2-da403739bc8a` | None (direct carryover) |
| 2 | argenx CIDP 001 | A | `34d23867-60c2-8165-a5ea-ca7c49acf132` | None |
| 3 | Amgen NMOSD OBSERVE-NMO | TBD | TBD — *not visible in scanned blocks; verify at runtime* | TBD |
| 4 | Sanofi Pre-T1D Tepli-QUEST | B | `34d23867-60c2-819e-8775-fdf79ea83f5a` | Missing `Task Type Tags` |
| 5 | Ionis HAE 001 | C | `34d23867-60c2-8142-b0fc-e41bb671d84d` | mini-Gantt: title=`Priority`, completion=`DONE` (select), end=`End Date`, assignee=`Assigned To` |
| 6 | Pfizer Heme 002 | C | `34d23867-60c2-8169-8e69-dfd9f8c178e7` | mini-Gantt: title=`Risk level`, completion=`Complete` (select), end=`End Date`, assignee=`Assigned To` |
| 7 | Ipsen PBC 001 | C | `34d23867-60c2-81fa-b227-d899e465e1c6` | bare-bones: title=`Task`, no `Workstream`, completion=`Status` (select), assignee=`Assigned To` |

## Approach — move-first, PATCH-after

Tem flagged Notion's **move-page endpoint** (`POST /pages/move` on API version 2025-09-03; `PATCH /pages/{id}` with parent change on older versions) as the safer choice over read→transform→create. The script uses it as the default consolidation primitive.

**Why move beats create for this:**

| Concern | Read → create new row | **Move (chosen)** |
|---|---|---|
| Page ID stability | New ID, breaks any inbound relation | Page ID preserved — inbound relations survive |
| Schema-matching properties | Hand-mapped per property | Notion auto-maps name+type matches |
| Atomicity | 2 ops (POST + delete) — partial-failure window | 1 op |
| Duplicate-row risk on retry | Real (must dedupe by some key) | Zero — page is in dest after first call |
| Deletion of source row | Manual archive step | Handled by the move |

**Tradeoff:** moving doesn't auto-fill properties whose names or types differ between source and dest DBs (Group B/C). Post-move PATCH closes that gap with per-group transformers we read from the source rows *before* moving.

For Group A (Moderna, argenx, likely Amgen): move alone is sufficient for property carryover; only the `Study` relation needs post-move PATCH (it doesn't exist on the source DB).

For Group B (Sanofi): move + post-move PATCH `Task Type Tags` derived from the source `Workstream`.

For Group C (Ionis, Pfizer Heme 002, Ipsen): move + post-move PATCH for `Name` (already covered — title is special-cased by Notion), `Completed` (boolean derived from source select), `Due Date` (from source `End Date`), `Assignee` (from source `Assigned To`), and per-study one-offs.

## Pipeline per study (idempotent)

```
function migrateStudy(cfg) {
  1. resolveOrCreateProductionStudy(cfg)
       → set Contract Sign Date if missing
       → returns productionStudyId
  2. ensureInception(productionStudyId)
       → if existing Study Tasks ≥ 100: skip
       → else POST /webhook/inception { data: { id: productionStudyId } }
       → poll cascade Study Tasks DB until count ≥ 100, timeout 5 min
  3. resolveOrCreateExportedStudiesRow(cfg, productionStudyId)
       → if row exists with Production Study relation pointing to productionStudyId: reuse
       → else create row with title = study name, Production Study = productionStudyId
       → verify round-trip 1:1 (Production Study row's Exported Study relation points back)
       → returns exportedStudyRowId
  4. consolidateMigratedTasks(cfg, exportedStudyRowId)
       → query per-study migrated DB for all rows
       → for each row:
           a) read source properties needed for post-move PATCH (group-specific)
           b) POST /pages/move → parent = Asana Exported Tasks DB
           c) PATCH moved row: { Study: exportedStudyRowId, ...groupTransforms }
       → throttle to ≤ 3 req/s shared with Notion rate budget
       → idempotency: skip rows whose current parent is already Asana Exported Tasks
  5. triggerMigrator(exportedStudyRowId)
       → POST /webhook/migrate-study { data: { id: exportedStudyRowId } }
            with X-Webhook-Secret header
  6. waitForCompletion(productionStudyId)
       → poll Automation Reporting on Production Study page
       → terminal states: success | error
       → timeout 10 min
  7. log result, continue or halt on failure
}
```

Each step short-circuits when its post-condition is already met. Rerunning the script on a partially-migrated study is safe.

## Files to add (script-only — no engine PR)

```
projects/engine/scripts/batch-migrate/
├── batch-migrate.js              # CLI entry point
├── config.js                     # per-study config (DB IDs, Contract Sign Date, group)
├── notion.js                     # thin wrapper: getPage, queryDb, movePages, patchPage, throttle
├── webhook.js                    # POST helpers for /webhook/inception + /webhook/migrate-study
├── poll.js                       # polling helpers (study tasks count, automation reporting)
├── transforms/
│   ├── group-a.js                # noop (move alone is enough; only sets Study relation)
│   ├── sanofi-pre-t1d.js         # Group B — derives Task Type Tags from Workstream
│   ├── ionis-hae-001.js          # Group C — Priority→Name carries via title special case; DONE→Completed; End Date→Due Date; Assigned To→Assignee
│   ├── pfizer-heme-002.js        # Group C — analogous mapping
│   └── ipsen-pbc-001.js          # Group C — Task→Name (title); Status→Completed; Assigned To→Assignee; no Workstream backfill
└── README.md                     # how to run, env vars needed, dry-run conventions
```

CLI shape (mirrors existing `scripts/fire-date-webhook.js` pattern):

```bash
node scripts/batch-migrate/batch-migrate.js \
  --study moderna-mma-pa-compass \
  [--dry-run] \
  [--skip-inception] \
  [--skip-migrator] \
  [--engine-url https://picnic-cascade-engine-production.up.railway.app] \
  [--token $NOTION_TOKEN_1]

# or run all 7 in priority order
node scripts/batch-migrate/batch-migrate.js --all
```

`--dry-run` prints planned moves + PATCHes + webhook bodies, exits without writes.

## Critical files I read or referenced

- `projects/engine/src/migration/constants.js` — `MIGRATED_TASKS_DB_ID = aaa4397d-…`, `MIGRATED_STUDIES_DB_ID = a75fd9ee-…`, `MIGRATED_TASK_PROP` and `MIGRATED_STUDIES_PROP` namespaces
- `projects/engine/src/routes/migrate-study.js` — webhook handler, payload contract `{ data: { id } }`, async response
- `projects/engine/src/routes/inception.js` — webhook handler, requires Contract Sign Date, blocks double-inception
- `projects/engine/docs/MIGRATE-STUDY-WEBHOOK.md` — full prerequisite contract and gate list for the Migrator
- `projects/engine/.env.example` — `STUDY_TASKS_DB_ID`, `STUDIES_DB_ID`, `BLUEPRINT_DB_ID`, `WEBHOOK_SECRET`
- `projects/engine/scripts/fire-date-webhook.js` — pattern to follow (env-loading, getArg, fetch with X-Webhook-Secret)
- `projects/migration/prompts/carryover-study.md` (and `…-agent-dispatch.md`) — institutional spec for what makes a study "ready for Migrator"
- `pulse-log/04.30/007-migrate-study-end-to-end-shipped-jot.md` — yesterday's full PR chain context

## Reusable engine surface (do not reinvent)

- `MIGRATED_TASKS_DB_ID` / `MIGRATED_STUDIES_DB_ID` from `src/migration/constants.js` — the script should import these so DB IDs aren't duplicated
- `MIGRATED_TASK_PROP` and `MIGRATED_STUDIES_PROP` — same
- The match-quality counters in the Migrator's success summary already report unmatched/low-confidence — the script just relays that summary to stdout
- `withStudyLock` (in `src/services/study-lock.js`) is engine-side; the script does not need its own lock since it processes studies serially

## Verification (Moderna-first)

Tonight, in this order:

1. **Dry-run Moderna**
   ```bash
   node scripts/batch-migrate/batch-migrate.js --study moderna-mma-pa-compass --dry-run
   ```
   Confirms: Production Study creation payload, Inception trigger payload, count of source rows in Moderna's migrated DB, planned moves, planned PATCHes, Migrator trigger payload. No writes happen.

2. **Spot-check** the dry-run output against the Notion source (Moderna's per-study migrated DB) — count matches, no surprise rows.

3. **Live run for Moderna**
   ```bash
   node scripts/batch-migrate/batch-migrate.js --study moderna-mma-pa-compass
   ```

4. **Verify in Notion**:
   - Production Study page exists with Contract Sign Date and ≥ 100 Study Tasks
   - Exported Studies row exists with `Production Study` relation set 1:1
   - Asana Exported Tasks contains all the Moderna rows with `Study` relation set
   - Migrator's success summary appears on the Production Study Automation Reporting (match counts, low-confidence count)
   - Migration Support callout looks clean

5. **If Moderna passes**, run the other 6 in priority order Tem chooses. Group A (argenx, Amgen) before Group B (Sanofi) before Group C (Ionis, Pfizer Heme 002, Ipsen) — easier shapes first so transformers are battle-tested before edge-case studies.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Inception async — script polls forever | 5-min timeout; surfaces partial state for manual completion |
| Notion 3 req/s rate limit shared across pool | Script throttles to ≤ 2 req/s to leave headroom for cascade engine traffic |
| Move-page drops a property the matcher needs | Pre-move read captures every source property the transformer might use; post-move PATCH restores it |
| Source rows include test/junk rows | Dry-run shows full row list per study before any write — Tem can flag exclusions |
| Pfizer Heme 002 vs Pfizer Heme A 001 name confusion (different studies, different groups) | Config keys studies by Notion DB ID, not by name — wrong-study mistake structurally impossible |
| Amgen NMOSD per-study migrated DB ID unknown | Script's first action when Amgen's turn comes: search Notion for `Amgen NMOSD OBSERVE-NMO migrated` and surface the DB ID for confirmation before proceeding |
| Race against Tem manually clicking buttons mid-run | Engine's `withStudyLock` already serializes per-study; script and human clicks won't collide |
| Webhook secret leaks to logs | Script reads from env, never echoes; logs strip Authorization headers |

## Open questions to resolve before tonight's run

1. **Contract Sign Date** for each of the 7 studies. Source: Meg or the per-study brief? Where do we read it from? Suggest config-file-driven with a fallback comment block citing where each date came from.
2. **Amgen NMOSD OBSERVE-NMO** group classification + per-study DB ID — `mcp__notion-picnichealth__API-post-search` for the DB title at run time should resolve this.
3. **Existing carryover state**: are any of these per-study migrated DBs *already* partially consolidated (some rows already moved to Asana Exported Tasks)? Script's idempotency makes this safe but the dry-run will surface it.
4. **Test rows**: any of the per-study migrated DBs include "test/sample" rows that should not migrate? Dry-run lists rows; Tem flags exclusions.
5. **Whether to short-circuit step 1** if Tem is creating Production Studies manually (faster for him to fill Contract Sign Date in Notion UI than feed it through CLI args). The `--skip-create-study` flag handles either path.

## Out of scope

- Engine code changes (no PR to `picnic-cascade-engine`)
- Refactoring the matcher or the Migrator itself
- Migration of any studies beyond these 7
- Backfilling the 14 Group A studies in `Migration Approach` page that aren't on Tem's tonight list (they're queued, not in scope today)
- A new engine endpoint `/webhook/batch-migrate` — explicitly rejected as too heavy for the deadline

## What ships when

- **Tonight:** Moderna live + the script in a PR (titled e.g. `feat(scripts): batch-migrate orchestrator for 7-study migration`). PR contains the script, config skeleton with Moderna filled in, README. Other 6 study configs added in subsequent commits as they run.
- **Next day(s):** argenx, Amgen, Sanofi, Ionis, Pfizer Heme 002, Ipsen — one or two per day, each adding its config + transformer to the same PR or follow-up PRs.

## Compoundable lessons (post-run, after Tem confirms)

- A capture under `docs/solutions/` (currently missing in engine) on the move-page-as-consolidation pattern — when to choose it vs read→create
- A capture on the Notion title-property special case (carries on move regardless of source name) — saves the next person 20 minutes of doc-spelunking
