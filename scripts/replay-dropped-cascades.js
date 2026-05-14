#!/usr/bin/env node
/**
 * Replay cascades that were dropped during the 2026-05-08 → 2026-05-12
 * window because Notion's automation builder omits `last_edited_by.type`
 * from webhook bodies and the classifier (pre-fix) treated missing-type
 * as unknown → bot → drop.
 *
 * Two-phase invocation:
 *   (default) — diagnose only, read-only: queries Study Tasks where
 *     Reference Start/End diverge from Dates (signature of a dropped
 *     cascade), groups by connected dependency component, and reports
 *     {study, components, seedTask, divergentCount} per affected study.
 *   --apply --confirm-notified — applies the replay: synthesizes a
 *     webhook payload per component, POSTs to /webhook/date-cascade,
 *     polls Activity Log for terminal status, throttles 5s between
 *     components.
 *
 * Pre-flight safety:
 *   - Requires WEBHOOK_SECRET env var (engine auth header).
 *   - Requires BACKFILL_ACTOR_USER_ID env var (real Notion person user;
 *     used in synthesized last_edited_by so downstream mention writes
 *     don't 400 on a fake UUID). Treat as sensitive — same hygiene as
 *     WEBHOOK_SECRET.
 *   - Requires at least one NOTION_TOKEN_* env var.
 *   - --apply requires --confirm-notified (operator must have notified
 *     PicnicHealth eng Slack channel before running).
 *
 * Idempotency:
 *   Filter-driven. A successful cascade writes `Reference = Dates`
 *   (src/routes/date-cascade.js:174-175), so Phase 1's divergence query
 *   excludes already-replayed studies on subsequent runs. Failed cascades
 *   leave divergence unchanged, so retry safely re-attempts those
 *   components. Each Phase 2 batch logs a `backfill_replay_id` for
 *   post-hoc audit.
 *
 * Usage:
 *   node scripts/replay-dropped-cascades.js                           # diagnose all studies
 *   node scripts/replay-dropped-cascades.js --study <pageId>          # diagnose one study
 *   node scripts/replay-dropped-cascades.js --apply --confirm-notified
 *   node scripts/replay-dropped-cascades.js --apply --confirm-notified --study <pageId>
 *   node scripts/replay-dropped-cascades.js --json                    # JSON envelope output
 *
 * Exit codes:
 *   0 = success (diagnose printed; or apply completed with no failures)
 *   1 = some replays failed (final report lists failures)
 *   2 = nothing to replay (no divergent studies found)
 *   3 = usage / config error (missing env vars, bad args)
 *   4 = transient (Notion 5xx or timeout — operator may retry)
 *
 * See docs/runbooks/replay-dropped-cascades.md for the operator runbook.
 *
 * Plan: docs/plans/2026-05-12-001-fix-classify-webhook-actor-edit-first-knownbots-fallback-plan.md (U6)
 */

import { config as dotenvConfig } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { STUDY_TASKS_PROPS, STUDIES_PROPS, findById } from '../src/notion/property-names.js';

dotenvConfig();

const SCHEMA_VERSION = 1;
const DEFAULT_ENGINE_URL = 'https://picnic-cascade-engine-production.up.railway.app';
const DEFAULT_THROTTLE_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

// ─── Arg parsing ────────────────────────────────────────────────────────────

export function getArg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.split('=').slice(1).join('=');
    return fallback;
  }
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

export function getFlag(name) {
  return process.argv.indexOf(`--${name}`) !== -1
    || process.argv.some((a) => a === `--${name}=true`);
}

// ─── Divergence detection ───────────────────────────────────────────────────

/**
 * Returns true if the task's Reference Start/End disagree with its Dates.
 * A successful cascade aligns them; divergence is the signature of a
 * dropped cascade.
 */
export function datesDiverge(task) {
  const refStart = findById(task, STUDY_TASKS_PROPS.REF_START)?.date?.start;
  const refEnd = findById(task, STUDY_TASKS_PROPS.REF_END)?.date?.start;
  const dates = findById(task, STUDY_TASKS_PROPS.DATES)?.date;
  const datesStart = dates?.start;
  const datesEnd = dates?.end ?? dates?.start;

  // Skip if Reference is not yet bootstrapped — the engine's Fill Refs
  // automation hasn't run yet, so divergence here is expected and benign.
  if (!refStart || !refEnd) return false;
  if (!datesStart) return false;

  return refStart !== datesStart || refEnd !== datesEnd;
}

/**
 * Returns true if the task's Status places it in a frozen state
 * (cascades skip frozen tasks per Section 5 invariants). Frozen tasks
 * cannot be used as a seed because the cascade would no-op.
 */
export function isTaskFrozen(task) {
  const status = findById(task, STUDY_TASKS_PROPS.STATUS)?.status?.name;
  return status === 'Done' || status === 'N/A';
}

// ─── Connected component grouping ──────────────────────────────────────────

/**
 * Builds an undirected graph from Blocked-by + Blocking relations and
 * returns the connected components as arrays of task references.
 *
 * Treats relations as undirected so a divergent task A connected to
 * non-divergent B which is connected to divergent C lands all three in
 * the same component. The cascade walks the graph from one seed regardless
 * of direction.
 */
export function findConnectedComponents(tasks) {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const neighbors = new Map();

  for (const task of tasks) {
    const blockedBy = (findById(task, STUDY_TASKS_PROPS.BLOCKED_BY)?.relation || []).map((r) => r.id);
    const blocking = (findById(task, STUDY_TASKS_PROPS.BLOCKING)?.relation || []).map((r) => r.id);
    const adj = new Set([...blockedBy, ...blocking].filter((id) => tasksById.has(id)));
    neighbors.set(task.id, adj);
  }

  // Make symmetric — if A says it's blocked by B but B doesn't list A as blocking,
  // we still treat them as connected (Notion's dual-relation sync may have drift).
  for (const [id, adj] of neighbors) {
    for (const nb of adj) {
      neighbors.get(nb)?.add(id);
    }
  }

  const visited = new Set();
  const components = [];

  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    const component = [];
    const queue = [task.id];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      const curTask = tasksById.get(cur);
      if (curTask) component.push(curTask);
      for (const nb of neighbors.get(cur) || []) {
        if (!visited.has(nb)) queue.push(nb);
      }
    }
    components.push(component);
  }

  return components;
}

// ─── Seed selection ─────────────────────────────────────────────────────────

/**
 * Picks a single seed from a list of divergent tasks. Returns the
 * most-recently-edited task; tie-break on largest Reference→Dates delta;
 * tertiary tie-break on alphabetical task UUID for determinism.
 *
 * Returns null if all divergent tasks in the list are frozen (caller
 * reports `skipped: all_frozen_component`).
 */
export function pickSeed(divergentTasks) {
  const nonFrozen = divergentTasks.filter((t) => !isTaskFrozen(t));
  if (nonFrozen.length === 0) return null;

  return [...nonFrozen].sort((a, b) => {
    // Primary: most recently edited first (descending).
    const aEdit = a.last_edited_time || '';
    const bEdit = b.last_edited_time || '';
    if (aEdit !== bEdit) return bEdit.localeCompare(aEdit);

    // Secondary: largest delta first (descending). Use end-date delta
    // as the magnitude (cascades primarily react to end shifts).
    const aDelta = computeDelta(a);
    const bDelta = computeDelta(b);
    if (aDelta !== bDelta) return Math.abs(bDelta) - Math.abs(aDelta);

    // Tertiary: alphabetical task UUID for full determinism.
    return a.id.localeCompare(b.id);
  })[0];
}

function computeDelta(task) {
  const refEnd = findById(task, STUDY_TASKS_PROPS.REF_END)?.date?.start;
  const dates = findById(task, STUDY_TASKS_PROPS.DATES)?.date;
  const datesEnd = dates?.end ?? dates?.start;
  if (!refEnd || !datesEnd) return 0;
  return (new Date(datesEnd).getTime() - new Date(refEnd).getTime()) / 86_400_000;
}

// ─── Webhook payload synthesis ──────────────────────────────────────────────

/**
 * Builds a webhook body matching the shape parseWebhookPayload accepts.
 * The synthesized `last_edited_by` uses BACKFILL_ACTOR_USER_ID (a real
 * Notion person user) so downstream Notion mention writes don't fail.
 */
export function synthesizeWebhookPayload(seedTask, actorUserId) {
  return {
    body: {
      _replayTrustRef: true,
      data: {
        id: seedTask.id,
        properties: seedTask.properties,
        last_edited_by: {
          id: actorUserId,
          type: 'person',
        },
      },
    },
  };
}

// ─── Engine webhook POST ────────────────────────────────────────────────────

/**
 * POSTs the synthesized payload to /webhook/date-cascade. Returns
 * {ok, status, body} — never throws on non-2xx; classifier callers
 * decide retry vs abort.
 */
export async function postWebhook({ engineUrl, secret, payload, fetchImpl = fetch }) {
  const url = `${engineUrl}/webhook/date-cascade`;
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': secret,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text().catch(() => '');
  return { ok: resp.ok, status: resp.status, body: text };
}

/**
 * Classifies a webhook POST response into a terminal outcome the
 * orchestrator can act on. 401 = auth fail (abort run); 5xx = transient
 * (operator may retry); otherwise = applied (proceed to Activity Log poll).
 */
export function classifyWebhookResponse(resp) {
  if (resp.status === 401 || resp.status === 403) return { kind: 'auth_error' };
  if (resp.status >= 500) return { kind: 'transient' };
  if (!resp.ok) return { kind: 'engine_error', status: resp.status, body: resp.body?.slice(0, 200) };
  return { kind: 'applied' };
}

// ─── Phase 1: Diagnose ──────────────────────────────────────────────────────

/**
 * Diagnoses one study: queries Study Tasks, finds divergent ones, groups
 * into components, picks seeds. Returns a structured report.
 */
export async function diagnoseStudy({ client, studyTasksDbId, studyPageId, studyName }) {
  const tasks = await client.queryDatabase(studyTasksDbId, {
    property: STUDY_TASKS_PROPS.STUDY.id,
    relation: { contains: studyPageId },
  });

  const divergentTasks = tasks.filter(datesDiverge);
  if (divergentTasks.length === 0) {
    return { studyPageId, studyName, divergentCount: 0, components: [] };
  }

  const allComponents = findConnectedComponents(tasks);
  const affectedComponents = allComponents.filter((c) =>
    c.some((t) => divergentTasks.includes(t)),
  );

  const componentReports = affectedComponents.map((component) => {
    const divergentInComponent = component.filter((t) => divergentTasks.includes(t));
    const seed = pickSeed(divergentInComponent);
    return {
      divergentInComponent: divergentInComponent.length,
      seedTaskId: seed?.id ?? null,
      seedTaskName: seed ? (findById(seed, STUDY_TASKS_PROPS.TASK_NAME)?.title?.[0]?.plain_text || '(no name)') : null,
      skipped: seed ? null : 'all_frozen_component',
    };
  });

  return {
    studyPageId,
    studyName,
    divergentCount: divergentTasks.length,
    components: componentReports,
  };
}

// ─── Phase 2: Apply ─────────────────────────────────────────────────────────

export async function applyComponentReplay({
  component,
  seedTask,
  studyPageId,
  studyName,
  engineUrl,
  webhookSecret,
  actorUserId,
  fetchImpl = fetch,
  pollImpl,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const { seedTaskId, seedTaskName, skipped } = component;
  if (skipped) {
    return { seedTaskId: null, seedTaskName: null, studyPageId, studyName, outcome: 'skipped', reason: skipped };
  }
  if (!seedTaskId) {
    return { seedTaskId: null, seedTaskName: null, studyPageId, studyName, outcome: 'skipped', reason: 'no_seed' };
  }
  if (!seedTask) {
    // Defensive guard: caller is expected to pass the live task fetched via
    // client.getPage(). If null/undefined arrives (e.g., seed was archived
    // between diagnose and apply), surface as failed rather than producing
    // a malformed payload.
    return { seedTaskId, seedTaskName, studyPageId, studyName, outcome: 'engine_error', body: 'seed task not found (archived or 404)' };
  }

  const payload = synthesizeWebhookPayload(seedTask, actorUserId);
  const resp = await postWebhook({ engineUrl, secret: webhookSecret, payload, fetchImpl });
  const classified = classifyWebhookResponse(resp);

  // For non-applied outcomes, return immediately — no terminal status to poll.
  if (classified.kind !== 'applied') {
    return {
      seedTaskId,
      seedTaskName,
      studyPageId,
      studyName,
      outcome: classified.kind,
      httpStatus: resp.status,
      body: classified.kind === 'engine_error' ? classified.body : undefined,
    };
  }

  // For accepted webhooks, poll the Activity Log for a terminal entry on
  // the seed task. HTTP 200 only means the engine accepted the webhook;
  // the actual cascade may still be running (5s debounce + processing).
  // Without this poll, the script can't tell whether cascades actually
  // landed in Notion before moving on to the next component.
  if (pollImpl) {
    try {
      const terminal = await pollImpl({
        studyPageId,
        sourceTaskId: seedTaskId,
        timeoutMs: pollTimeoutMs,
        intervalMs: pollIntervalMs,
      });
      return {
        seedTaskId,
        seedTaskName,
        studyPageId,
        studyName,
        outcome: terminal.status === 'success' || terminal.status === 'no_shifts' || terminal.status === 'no_action'
          ? 'applied'
          : 'cascade_failed',
        httpStatus: resp.status,
        terminalStatus: terminal.status,
        terminalSummary: terminal.summary,
      };
    } catch (err) {
      // Poll timeout or fetch error — webhook was accepted but we can't
      // confirm the cascade finished. Report as transient so the operator
      // can re-run diagnose and decide.
      return {
        seedTaskId,
        seedTaskName,
        studyPageId,
        studyName,
        outcome: 'poll_timeout',
        httpStatus: resp.status,
        body: String(err?.message || err).slice(0, 200),
      };
    }
  }

  // No pollImpl provided (e.g., tests with mocked fetch) — return applied
  // based on the HTTP 200 alone. The runbook + Coverage will flag that
  // operator verification via Railway logs is required when polling is
  // skipped.
  return {
    seedTaskId,
    seedTaskName,
    studyPageId,
    studyName,
    outcome: classified.kind,
    httpStatus: resp.status,
  };
}

/**
 * Polls Notion's Activity Log for a terminal entry from the seed task's
 * cascade. The engine writes one Activity Log entry per cascade run, with
 * Source Task ID set to the seed task and Status set to the terminal
 * outcome (success, no_shifts, no_action, failed). We filter by both
 * fields and wait until at least one entry exists.
 *
 * Returns the most recent matching entry's status + summary on success.
 * Throws on timeout — caller decides how to report.
 */
export async function pollActivityLog({
  client,
  activityLogDbId,
  studyPageId,
  sourceTaskId,
  startedAt,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleepImpl = sleep,
}) {
  const deadline = Date.now() + timeoutMs;
  const startedAtIso = startedAt || new Date().toISOString();

  while (Date.now() < deadline) {
    const entries = await client.queryDatabase(activityLogDbId, {
      and: [
        { property: 'Workflow', select: { equals: 'Date Cascade' } },
        { property: 'Source Task ID', formula: { string: { equals: sourceTaskId } } },
        { timestamp: 'created_time', created_time: { on_or_after: startedAtIso } },
      ],
    });
    if (entries && entries.length > 0) {
      // Take the most recent entry (queryDatabase returns newest-first by default
      // for Activity Log; if not, sort by created_time descending).
      const latest = entries.sort((a, b) =>
        (b.created_time || '').localeCompare(a.created_time || ''),
      )[0];
      const statusProp = latest.properties?.['Status']?.status?.name
        || latest.properties?.['Status']?.select?.name
        || 'unknown';
      const summaryProp = latest.properties?.['Summary']?.rich_text?.[0]?.plain_text || '';
      return {
        status: statusProp.toLowerCase().replace(/\s+/g, '_'),
        summary: summaryProp,
      };
    }
    await sleepImpl(intervalMs);
  }

  const err = new Error(`Activity Log poll timed out after ${Math.round(timeoutMs / 1000)}s for source task ${sourceTaskId}`);
  err.code = 'poll_timeout';
  throw err;
}

// ─── Main entry: run() / runMain pattern ────────────────────────────────────

export async function run({
  apply = false,
  confirmNotified = false,
  studyFilter = null,
  env = process.env,
  clientFactory,
  fetchImpl = fetch,
  studyTasksDbId,
  studiesDbId,
  activityLogDbId = null,
} = {}) {
  // Pre-flight: env vars are validated BEFORE any Notion reads so a
  // missing-secret abort is cheap and obvious.
  const webhookSecret = env.WEBHOOK_SECRET;
  const actorUserId = env.BACKFILL_ACTOR_USER_ID;
  const engineUrl = env.ENGINE_URL || DEFAULT_ENGINE_URL;

  // --study=true means the operator passed `--study` with no value (getArg
  // returns true for bare flags). Treat as a usage error rather than letting
  // it propagate as a filter into Notion.
  if (studyFilter === true) {
    return { ok: false, exitCode: 3, error: { code: 'invalid_study_filter', message: '--study requires a value (Notion page id)' } };
  }

  if (apply && !webhookSecret) {
    return { ok: false, exitCode: 3, error: { code: 'missing_webhook_secret', message: 'WEBHOOK_SECRET env var required for --apply' } };
  }
  if (apply && !actorUserId) {
    return { ok: false, exitCode: 3, error: { code: 'missing_backfill_actor', message: 'BACKFILL_ACTOR_USER_ID env var required for --apply (real Notion person user)' } };
  }
  if (apply && !confirmNotified) {
    return { ok: false, exitCode: 3, error: { code: 'missing_notification_confirmation', message: '--apply requires --confirm-notified; notify PicnicHealth eng Slack channel first' } };
  }

  const client = await clientFactory();
  const replayId = randomUUID();
  const applyStartedAt = new Date().toISOString();

  // Collect studies to diagnose. If --study is given, just that one;
  // otherwise iterate all studies in the Studies DB.
  const studiesToScan = studyFilter
    ? [{ id: studyFilter, name: '(scoped to --study)' }]
    : await listAllStudies({ client, studiesDbId });

  const diagnoseReports = [];
  for (const study of studiesToScan) {
    const report = await diagnoseStudy({
      client,
      studyTasksDbId,
      studyPageId: study.id,
      studyName: study.name,
    });
    if (report.divergentCount > 0) diagnoseReports.push(report);
  }

  if (diagnoseReports.length === 0) {
    return { ok: true, exitCode: 2, state: 'no_divergence', replayId };
  }

  if (!apply) {
    return { ok: true, exitCode: 0, state: 'diagnose_only', replayId, studies: diagnoseReports };
  }

  // Apply phase. Iterate components in dependency order across studies.
  const applyReports = [];
  let anyFailures = false;
  let anyTransient = false;

  for (const study of diagnoseReports) {
    for (const component of study.components) {
      // Re-fetch the seed task to get fresh properties before synthesizing.
      // The diagnose snapshot may be seconds stale; we want the latest dates.
      const seedTask = component.seedTaskId
        ? await safeNotionRead(() => client.getPage(component.seedTaskId))
        : null;

      const pollImpl = activityLogDbId
        ? ({ sourceTaskId, timeoutMs, intervalMs }) => pollActivityLog({
            client,
            activityLogDbId,
            studyPageId: study.studyPageId,
            sourceTaskId,
            startedAt: applyStartedAt,
            timeoutMs,
            intervalMs,
          })
        : null;

      const result = await applyComponentReplay({
        component,
        seedTask,
        studyPageId: study.studyPageId,
        studyName: study.studyName,
        engineUrl,
        webhookSecret,
        actorUserId,
        fetchImpl,
        pollImpl,
      });
      applyReports.push(result);

      if (result.outcome === 'auth_error') {
        // Abort the whole run — secret is wrong, every subsequent POST will
        // fail too. Exit 3 (usage/config) per the documented exit code table;
        // operator should fix WEBHOOK_SECRET before re-running.
        return {
          ok: false,
          exitCode: 3,
          state: 'auth_error',
          replayId,
          error: { code: 'webhook_auth_failed', message: 'Engine returned 401/403 — fix WEBHOOK_SECRET before re-running' },
          completedComponents: applyReports,
        };
      }
      if (result.outcome === 'transient' || result.outcome === 'poll_timeout') anyTransient = true;
      if (result.outcome !== 'applied' && result.outcome !== 'skipped') anyFailures = true;

      await sleep(DEFAULT_THROTTLE_MS);
    }
  }

  return {
    ok: !anyFailures,
    exitCode: anyTransient ? 4 : (anyFailures ? 1 : 0),
    state: anyFailures ? 'partial' : 'success',
    replayId,
    components: applyReports,
  };
}

async function listAllStudies({ client, studiesDbId }) {
  const studies = await client.queryDatabase(studiesDbId);
  return studies.map((s) => ({
    id: s.id,
    name: findById(s, STUDIES_PROPS.STUDY_NAME)?.title?.[0]?.plain_text || '(no name)',
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a Notion read so transient failures return null instead of throwing.
 * Use for non-critical reads where a failure should skip the component rather
 * than abort the whole run. Critical reads (e.g., listAllStudies, diagnoseStudy)
 * still throw — those failures are surfaced at the top of run() and reported
 * as exit code 4 (transient) so the operator can re-run.
 */
async function safeNotionRead(fn) {
  try {
    return await fn();
  } catch (err) {
    console.log(JSON.stringify({
      event: 'replay_seed_fetch_failed',
      error: String(err?.message || err).slice(0, 200),
    }));
    return null;
  }
}

// ─── runMain — invoked when script is run directly, not imported ────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;

const USAGE = `
Replay cascades dropped during the 2026-05-08 → 2026-05-12 window.

Usage:
  node scripts/replay-dropped-cascades.js [--study <pageId>] [--json]
  node scripts/replay-dropped-cascades.js --apply --confirm-notified [--study <pageId>] [--json]
  node scripts/replay-dropped-cascades.js --help

Flags:
  --apply                 Apply replay (synthesize webhooks, POST, poll Activity Log).
                          Default is diagnose only (read-only).
  --confirm-notified      Required with --apply. Operator must have notified the
                          PicnicHealth eng Slack channel before running.
  --study <pageId>        Scope to a single study by Notion page id.
  --json                  Emit structured JSON envelope to stdout (compact, single-line).
  --help                  Print this message and exit.

Required env vars (--apply only):
  WEBHOOK_SECRET             Engine auth header.
  BACKFILL_ACTOR_USER_ID     Real Notion person user id for synthesized last_edited_by.
                             SENSITIVE — same hygiene as WEBHOOK_SECRET.
  NOTION_TOKEN_1, ...        Notion integration token(s) for diagnose reads.
  ENGINE_URL                 (Optional) Override engine URL. Defaults to production.

Exit codes:
  0 = success (diagnose printed; or apply completed with no failures)
  1 = some replays failed
  2 = nothing to replay (no divergent studies found)
  3 = usage / config error (missing env vars, bad args, auth failure)
  4 = transient (Notion 5xx, timeout, poll exhaustion) — operator may retry

See docs/runbooks/replay-dropped-cascades.md for the operator runbook.
`;

export async function runMain() {
  if (getFlag('help') || getFlag('h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const apply = getFlag('apply');
  const confirmNotified = getFlag('confirm-notified');
  const studyFilter = getArg('study');
  const json = getFlag('json');

  // Late-bound imports to keep the test surface clean. The script depends
  // on env-vars and a runtime Notion client; tests inject these.
  const { NotionClient } = await import('../src/notion/client.js');
  const { config } = await import('../src/config.js');

  let result;
  try {
    result = await run({
      apply,
      confirmNotified,
      studyFilter,
      clientFactory: async () => new NotionClient({ tokens: config.notion.tokens }),
      studyTasksDbId: config.notion.studyTasksDbId,
      studiesDbId: config.notion.studiesDbId,
      activityLogDbId: config.notion.activityLogDbId || null,
    });
  } catch (err) {
    // Notion read errors during listAllStudies or diagnoseStudy bubble up
    // here — emit as transient (exit 4) so operators can retry rather than
    // confusing exit 1 (partial apply failure) with infrastructure outage.
    const errorEnvelope = {
      ok: false,
      exitCode: 4,
      state: 'transient',
      error: { code: 'notion_read_failed', message: String(err?.message || err).slice(0, 200) },
    };
    if (json) {
      console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...errorEnvelope }));
    } else {
      console.error(`[replay-dropped-cascades] transient failure (exit 4): ${errorEnvelope.error.message}`);
    }
    process.exit(4);
  }

  if (json) {
    // Compact single-line JSON for shell $() capture + jq parsing.
    console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...result }));
  } else {
    console.log(formatHumanReport(result));
  }

  process.exit(result.exitCode);
}

function formatHumanReport(result) {
  const lines = [];
  if (result.error) {
    lines.push(`Error (exit ${result.exitCode}): ${result.error.message}`);
  } else if (result.state === 'no_divergence') {
    lines.push('No divergent studies found. Nothing to replay.');
  } else if (result.state === 'diagnose_only') {
    lines.push(`Diagnose: ${result.studies.length} studies affected (replay id ${result.replayId})`);
    for (const study of result.studies) {
      lines.push(`  ${study.studyName} (${study.studyPageId})`);
      lines.push(`    ${study.divergentCount} divergent tasks across ${study.components.length} components`);
      for (const c of study.components) {
        const status = c.skipped ? `SKIPPED: ${c.skipped}` : `seed: ${c.seedTaskName}`;
        lines.push(`      - ${status} (${c.divergentInComponent} divergent)`);
      }
    }
    lines.push('');
    lines.push('To apply: re-run with --apply --confirm-notified');
  } else {
    lines.push(`Apply complete (replay id ${result.replayId}, state: ${result.state})`);
    const components = result.components || result.completedComponents || [];
    const byOutcome = components.reduce((acc, c) => {
      acc[c.outcome] = (acc[c.outcome] || 0) + 1;
      return acc;
    }, {});
    for (const [outcome, count] of Object.entries(byOutcome)) {
      lines.push(`  ${outcome}: ${count}`);
    }
    const failures = components.filter((c) => c.outcome !== 'applied' && c.outcome !== 'skipped');
    if (failures.length > 0) {
      lines.push('');
      lines.push('Failures:');
      for (const f of failures) {
        lines.push(`  - ${f.studyName} / ${f.seedTaskName}: ${f.outcome}${f.body ? ' — ' + f.body : ''}`);
      }
    }
  }
  return lines.join('\n');
}

if (isMain) {
  runMain().catch((err) => {
    console.error('[replay-dropped-cascades] fatal:', err);
    process.exit(1);
  });
}
