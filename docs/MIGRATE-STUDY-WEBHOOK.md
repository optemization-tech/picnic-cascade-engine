# Migrate Study webhook (`POST /webhook/migrate-study`)

One-button replacement for interactive Claude+MCP sessions that follow [`migrate-study.md`](../../migration/prompts/migrate-study.md) v2.4 and shared matching rules. The engine runs a **full dry-run gate** first (no writes); only when gates pass does it turn **`[Do Not Edit] Import Mode`** on, apply batched PATCHes, report success, and turn Import Mode **off** in a `finally` block.

## Railway URL

Use the same base URL as other engine webhooks, for example:

`https://<picnic-cascade-engine-production>.up.railway.app/webhook/migrate-study`

(Exact hostname matches `ENGINE-BEHAVIOR-REFERENCE` / existing Inception automation.)

## Authentication

Identical to `POST /webhook/inception` and other `/webhook/*` routes:

- Header **`X-Webhook-Secret`** must match Railway **`WEBHOOK_SECRET`** (same secret as other notion→engine automations).

Unauthorized requests return **401** (see `src/middleware/webhook-auth.js`).

## Notion automation recipe

The button lives on the **Exported Studies DB row** (one row per Study). The
webhook receives the Exported Studies page id as `data.id` and resolves the
Production Study from there — see "Pipeline shape" below.

1. **Trigger:** Notion button on the Exported Studies row (`a75fd9ee-f39e-442c-b55c-3d1175fba7cb`).
2. **Action — Send webhook:** **POST** `/webhook/migrate-study`.
3. **Headers:**
   - `Content-Type: application/json`
   - `X-Webhook-Secret`: `<Railway WEBHOOK_SECRET>`
4. **Body:** `{ "data": { "id": "{{This page.ID}}" } }` — `{{This page.ID}}` resolves to the Exported Studies row id at click time.
5. **Import Mode:** The migration pipeline owns `[Do Not Edit] Import Mode` on the **Production Study** during execution; avoid separate automations that toggle Import Mode for the same study at the same time. Align with Meg on whether any existing "Activate Plan" flow pre-enables Import Mode.

### Payload shape

```json
{
  "data": { "id": "<exported-studies-row-uuid>" },
  "source": { "user_id": "<notion-user-id>" }
}
```

`exportedStudyPageId` and the legacy `studyPageId` keys are also accepted at
the top level for ergonomic dry-run scripts. The handler responds
**`200 { ok: true }` immediately**; processing continues in the background
with **`withStudyLock` on the resolved Production Study page id** (prefetched
from the Exported Studies row; falls back to the exported row id if the relation
is not exactly one or prefetch fails) so Migrate Study serializes against
Inception and add-task-set on the same study. Flight tracker wraps the async run
(same pattern as Inception).

## Pipeline shape

1. **Receive** Exported Studies row id from `body.data.id`.
2. **Resolve** Production Study via the row's `Production Study` relation (must be exactly 1).
3. **Round-trip safety:** the Production Study's `Exported Study` relation must point back at the Exported Studies row (defense in depth against misconfigured 1:1 wiring).
4. **Run remaining gates** against the Production Study (Import Mode, Contract Sign Date, Study Tasks count, Migrated Tasks count, matcher, threshold ratios).
5. **If gates pass:** turn `[Do Not Edit] Import Mode` ON on the Production Study, apply chunked PATCHes, write the success message to **Automation Reporting**.
6. **`finally`:** turn Import Mode OFF on the Production Study.

## Prerequisites (PM-facing)

| Prerequisite | Notes |
|----------------|-------|
| **Inception complete** | Study Tasks DB populated for the Production Study (`minStudyTasks` gate uses env default `100`). |
| **Carryover complete** | Per [`carryover-study.md`](../../migration/prompts/carryover-study.md): Migrated Tasks rows exist, Study relation on each row points at the Exported Studies row; **Study ↔ Exported Study** relation wired 1:1. |
| **Contract Sign Date** | Must be set on the Production Study page. |
| **Import Mode OFF** | Gate aborts if `[Do Not Edit] Import Mode` is already **true** on the Production Study. |
| **1:1 Study guard** | The Exported Studies row's `Production Study` relation must contain exactly one entry, and the Production Study's `Exported Study` relation must point back at this Exported Studies row. |

The webhook **does not** replace carryover; it assumes migrated rows already exist.

## Dry-run gates (abort before any write)

Hard failures include: `production_study_relation` (Exported Studies row has 0 or >1 Production Study links), `import_mode_on` (Production Study Import Mode already true), `contract_sign_empty`, `exported_study_relation_mismatch` / `exported_study_relation_count` (round-trip 1:1 broken), `schema_migrated_tasks` (couldn't resolve Migrated Tasks DB property ids for Study + Production Task / Notion Task), `migrated_tasks_empty` / `migrated_count_low` / `migrated_count_high`, `migrated_count_mismatch` (Migrated Tasks **query** count is **less** than the Exported Studies `Migrated Tasks` relation count — not the reverse: an under-filled parent relation logs warning `migrated-tasks-relation-underfilled` and continues), `study_tasks_low`, `carryover_study_missing` (a Migrated Task row missing its Study relation), `unmatched_completed_ratio`, `low_tier_cap`.

Configurable thresholds (defaults in `src/migration/thresholds.js`; override via env):

| Env | Default | Meaning |
|-----|---------|---------|
| `MIGRATE_MIN_STUDY_TASKS` | `100` | Minimum Study Tasks linked to the study. |
| `MIGRATE_MIN_MIGRATED_TASKS` | `10` | Minimum Migrated Tasks rows for carryover sanity. |
| `MIGRATE_MAX_MIGRATED_TASKS` | `500` | Maximum rows (wrong-filter guardrail). |
| `MIGRATE_MAX_UNMATCHED_COMPLETED_RATIO` | `0.25` | Max share of completed non–Repeat Delivery rows that fail matching / are ambiguous. |
| `MIGRATE_MAX_LOW_TIER_MATCHES` | `50` | Max Jaccard-based “low tier” matches. |
| `MIGRATE_JACCARD_MIN` | `0.6` | Minimum score for low-tier name match. |

If any gate fails: **Automation Reporting** on the Study shows an error and a Study comment is posted with the failure summary.

## Success path

1. Gate passes (planned PATCH counts computed in memory).
2. `PATCH` Study page: `[Do Not Edit] Import Mode` **checkbox true**.
3. Chunked `patchPages` for migrated + cascade tasks (rate-limit pacing between chunks).
4. Automation Reporting success message on the Study page.
5. **`finally`:** Import Mode **checkbox false** (always attempted if step 2 armed).

## Safe re-run

Operations are designed to be **idempotent**: relation targets and completion overlay converge toward desired state. Re-running after a partial failure is supported once gates pass; PMs should read Automation Reporting on the Production Study for the last outcome before retrying.

## PM one-pager

**What the button does:** After carryover + inception, wires **Production Task** relations, applies completion overlay (max **Date Completed** across contributors per cascade task, skipping **Manual Workstream / Item** where applicable), assigns owners when assignee text resolves to a workspace user, sets **Migration Status**, and marks remaining unmatched cascade tasks **Blueprint-default**.

**What errors mean:** Red banner in **Automation Reporting** + a comment on the Study page → gate failed or unexpected exception. **No live writes** occurred unless Import Mode was armed (if armed, `finally` attempts to clear Import Mode).

**Who to ask:** Meg/Tem for threshold tuning (`MIGRATE_*` env vars on Railway).
