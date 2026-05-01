# `scripts/batch-migrate/` — orchestrator for the 7-study batch

Plan: [`docs/plans/2026-04-30-003-feat-batch-migrate-7-studies-plan.md`](../../docs/plans/2026-04-30-003-feat-batch-migrate-7-studies-plan.md).

Applies the just-shipped Migrate Study pipeline ([PRs #86–#95](../../docs/MIGRATE-STUDY-WEBHOOK.md)) to a list of studies, end-to-end. Per study it:

1. **Resolves / creates** the cascade Production Study (with Contract Sign Date)
2. **Triggers Inception** (`POST /webhook/inception`) and polls Study Tasks until ≥ 100
3. **Wires** the Exported Studies row ↔ Production Study 1:1 relation
4. **Consolidates** per-study migrated rows into Asana Exported Tasks (`POST /v1/pages/move` — Notion auto-maps schema-matching properties), then PATCHes the `Study` relation
5. **Triggers Migrator** (`POST /webhook/migrate-study`) and polls Automation Reporting for terminal state

Each phase short-circuits when its post-condition is already met, so re-running a partially-migrated study is safe.

## Run

```bash
cd projects/engine

# dry-run (no writes, prints planned operations)
node scripts/batch-migrate/batch-migrate.js --study moderna-mma-pa-compass --dry-run

# live, single study
node scripts/batch-migrate/batch-migrate.js --study moderna-mma-pa-compass

# all 7 in priority order (halts on first failure)
node scripts/batch-migrate/batch-migrate.js --all

# override Contract Sign Date at the CLI (overrides config.js value)
node scripts/batch-migrate/batch-migrate.js --study moderna-mma-pa-compass --contract-sign 2026-03-15
```

### Flags

| Flag | Effect |
|---|---|
| `--study <key>` | Single-study run. Available keys printed by `--help` (or any unknown `--study` value). |
| `--all` | Run every study in `config.js`. Halts on first failure. |
| `--dry-run` | Print planned writes; no Notion or webhook traffic. Use first to spot-check. |
| `--skip-create-study` | Resolve Production Study by title only — fail if it doesn't exist. Use when Tem creates it manually in Notion. |
| `--skip-inception` | Skip the Inception trigger + wait. Use when Study Tasks are already populated. |
| `--skip-migrator` | Stop after consolidation; don't fire Migrate Study. Useful for staging multiple studies before letting them run. |
| `--contract-sign YYYY-MM-DD` | Override the Contract Sign Date in `config.js` (or supply it when missing). |
| `--engine-url <url>` | Override the engine base URL (default `https://picnic-cascade-engine-production.up.railway.app`). |
| `--token <notion-token>` | Override `NOTION_TOKEN_1` from `.env`. |

## Required env (loaded from `engine/.env`)

```
NOTION_TOKEN_1=ntn_…              # Notion integration with access to source + dest DBs
WEBHOOK_SECRET=…                  # engine webhook X-Webhook-Secret value
ENGINE_URL=https://…              # optional override of the engine base URL
```

DB IDs fall back to defaults from `src/migration/constants.js` and `.env.example`. To override:

```
MIGRATED_TASKS_DB_ID=…       # "Asana Exported Tasks" — the consolidated migrate dest
MIGRATED_STUDIES_DB_ID=…     # "Exported Studies" — Migrator entry point
STUDIES_DB_ID=…              # cascade Studies (Production)
STUDY_TASKS_DB_ID=…          # cascade Study Tasks (created by Inception)
MIGRATE_MIN_STUDY_TASKS=100  # Inception success threshold (matches engine env)
```

## Studies

| Key | Group | Schema mismatch | Per-study DB |
|---|---|---|---|
| `moderna-mma-pa-compass` | A | none | `34d23867-60c2-8199-…` |
| `argenx-cidp-001` | A | none | `34d23867-60c2-8165-…` |
| `amgen-nmosd-observe-nmo` | A* | TBD — verified at runtime | resolved via search |
| `sanofi-pre-t1d-tepli-quest` | B | missing `Task Type Tags` | `34d23867-60c2-819e-…` |
| `ionis-hae-001` | C | mini-Gantt (Priority/DONE/End Date/Assigned To) | `34d23867-60c2-8142-…` |
| `pfizer-heme-002` | C | mini-Gantt (Risk level/Complete/End Date/Assigned To) | `34d23867-60c2-8169-…` |
| `ipsen-pbc-001` | C | bare-bones (Task/Status/Assigned To, no Workstream) | `34d23867-60c2-81fa-…` |

\* Amgen NMOSD's group is assumed A pending verification.

## Group transforms

`transforms/group-a.js` is the only transform shipped initially — it's a no-op (Notion's move-page handles property carryover when source and destination schemas match by name + type). The orchestrator always merges `Study` relation → Exported Studies row id into the post-move PATCH.

Group B and Group C transforms (Sanofi, Ionis, Pfizer Heme 002, Ipsen) ship in follow-up commits as their per-study DB columns get fully audited. Until those land, the corresponding entries in `config.js` use `groupATransform` as a placeholder — moves will work, but missing-name properties (e.g., Sanofi's `Task Type Tags`) won't be backfilled and the Migrator will treat those rows as low-confidence.

## Why move-page beats read-then-create

The single most useful insight here: Notion's `POST /v1/pages/move` endpoint relocates a page atomically while preserving the page id, body blocks, comments, and any property whose name + type matches the destination schema (per `~/Documents/Claude/memory/notion-api-guide.md` §Page Moves). For consolidation, that beats reading source → POSTing new dest rows + archiving the source on every dimension that matters: page id stability (relations from elsewhere keep working), schema mapping (Notion does it), atomicity (one call vs two), idempotency (a moved page is a no-op on retry), source cleanup (handled).

The endpoint requires `Notion-Version: 2025-09-03` and accepts a `data_source_id` (not `database_id`). The orchestrator resolves the destination data source id at start by calling `GET /v1/databases/{id}` with the new API version.

## Verification (Moderna-first)

1. **Dry-run**: `node scripts/batch-migrate/batch-migrate.js --study moderna-mma-pa-compass --dry-run`. Spot-check the source row count + sample titles; confirm Contract Sign Date in config.
2. **Live**: drop `--dry-run`. Watch the per-phase output.
3. **In Notion**, verify:
   - Production Study has Contract Sign Date + ≥ 100 Study Tasks
   - Exported Studies row's `Production Study` relation is set 1:1 (round-trip)
   - Asana Exported Tasks contains all Moderna rows with `Study` relation set
   - Production Study's Automation Reporting shows the Migrate Study success summary (match counts, low-confidence count)
   - Migration Support callout reads cleanly

## Troubleshooting

- **Inception polls forever**: 5-min timeout; if blueprint is large or Notion is slow, the script logs the partial count and exits. Re-run with `--skip-inception` after manually verifying.
- **Move endpoint returns 400 about `data_source_id`**: the destination DB has multiple data sources, or the script is using a stale id. Inspect `GET /v1/databases/{ASANA_EXPORTED_TASKS_DB_ID}` with `Notion-Version: 2025-09-03` and confirm.
- **Migrator returns "carryover_study_missing"**: post-move PATCH didn't set the `Study` relation on a row. Re-run the script — it's idempotent; will re-PATCH any rows missing the relation.
- **Migrator returns "study_tasks_low"**: Inception didn't land enough Study Tasks. Verify in cascade Study Tasks DB; the engine's `MIGRATE_MIN_STUDY_TASKS` (default 100) is the threshold.
