import { describe, it, expect, vi } from 'vitest';
import {
  run,
  fireDeletionAndPoll,
  clearAuditRows,
  reInceptionAndVerify,
} from '../../../scripts/batch-migrate/recover-inception.js';

const STUDY_KEY = 'ionis-hae-001';
const STUDY_NAME = 'Ionis HAE 001';
const PROD_ID = 'prod-uuid-1';
const EXPORTED_ID = 'exported-uuid-1';

// Tight pollLimits for tests — instant sleep, ample iterations.
const TEST_POLL_LIMITS = {
  deletion: { maxIterations: 5, intervalMs: 1 },
  reInception: { maxIterations: 6, intervalMs: 1, stableTarget: 2, minTasksFloor: 100 },
  clearAudit: { batchSize: 10, throttleMs: 1 },
  activityLogSettleMs: 1,
};

const instantSleep = () => Promise.resolve();

function makeNotionFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (method, path, body) => {
    calls.push({ method, path, body });
    const key = Object.keys(routes).find((r) => {
      const [m, p] = r.split(' ');
      return m === method && path.startsWith(p);
    });
    if (!key) throw new Error(`unmocked notionFetch: ${method} ${path}`);
    const handler = routes[key];
    return typeof handler === 'function' ? handler(body, path, calls.length) : handler;
  });
  fn.calls = calls;
  return fn;
}

const exportedStudiesRow = () => ({
  id: EXPORTED_ID,
  properties: { 'Production Study': { relation: [{ id: PROD_ID }] } },
});

const alEntry = (status) => ({
  created_time: '2026-05-05T07:00:00.000Z',
  properties: {
    'Status': { select: { name: status } },
    'Summary': { rich_text: [{ plain_text: `Inception ${status} summary` }] },
  },
});

// ──────────────────────────────────────────────────────────────────────────
// run() orchestrator
// ──────────────────────────────────────────────────────────────────────────
describe('recover-inception run()', () => {
  it('exits 2 with already-success state when last Inception is already Success', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [alEntry('Success')] }),
    });
    const fireWebhook = vi.fn();

    const { exitCode, result } = await run({
      studyKey: STUDY_KEY,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(exitCode).toBe(2);
    expect(result.state).toBe('already-success');
    expect(result.alreadySuccess).toBe(true);
    expect(fireWebhook).not.toHaveBeenCalled();
  });

  it('exits 1 with no_exported_row error when Exported Studies query is empty', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [] }),
    });

    const { exitCode, result } = await run({
      studyKey: STUDY_KEY,
      deps: { notionFetch, fireWebhook: vi.fn(), sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('no_exported_row');
  });

  it('runs all 3 stages on Failed input and returns ready string + 3-stage shape', async () => {
    let stPollCount = 0;
    const studyTasksHandler = (body) => {
      stPollCount++;
      // Deletion polls (filter has no Template Source ID and is not an `and`):
      const isDeletionPoll = !body.filter.and; // deletion uses simple filter, not `and`
      if (isDeletionPoll) {
        // First call returns 132 tasks, then 0 (deletion happened mid-poll).
        return { results: stPollCount === 1 ? new Array(132).fill({}) : [] };
      }
      // Re-inception polls — return 202 tasks consistently to stabilize after 2 polls.
      return { results: new Array(202).fill({}) };
    };

    let alPollCount = 0;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => {
        alPollCount++;
        // First AL call is the pre-check (must be Failed to trigger recovery).
        // Second AL call is the post-stabilization verify (must be Success).
        return { results: [alEntry(alPollCount === 1 ? 'Failed' : 'Success')] };
      },
      'POST /v1/data_sources/eb823867': studyTasksHandler,
      // Asana exported tasks query (clear audit step) — return 62 dirty rows.
      'POST /v1/data_sources/82ae00bc': () => ({
        results: new Array(62).fill(0).map((_, i) => ({ id: `asana-row-${i}` })),
      }),
      // Page PATCHes for clearing audit rows.
      'PATCH /v1/pages/': () => ({ id: 'patched' }),
    });
    const fireWebhook = vi.fn(async () => ({ ok: true }));

    const { exitCode, result } = await run({
      studyKey: STUDY_KEY,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(exitCode).toBe(0);
    expect(result.schemaVersion).toBe(1);
    expect(result.study).toBe(STUDY_KEY);
    expect(result.studyName).toBe(STUDY_NAME);
    expect(result.exportedRowId).toBe(EXPORTED_ID);
    expect(result.productionStudyId).toBe(PROD_ID);
    expect(result.ready).toContain('--skip-create-study --skip-inception');
    expect(result.stages).toHaveLength(3);

    const [deletion, clearAudit, reInception] = result.stages;
    expect(deletion.name).toBe('deletion');
    expect(deletion.status).toBe('ok');
    expect(deletion.tasksArchivedAtStart).toBe(132);
    expect(clearAudit.name).toBe('clearAudit');
    expect(clearAudit.status).toBe('ok');
    expect(clearAudit.rowsScanned).toBe(62);
    expect(clearAudit.rowsCleared).toBe(62);
    expect(reInception.name).toBe('reInception');
    expect(reInception.status).toBe('ok');
    expect(reInception.cascadeCount).toBe(202);
    expect(reInception.activityLogStatus).toBe('Success');
    expect(reInception.stabilizedAt).toBeGreaterThanOrEqual(2);

    // Webhook fired twice: deletion + inception.
    expect(fireWebhook).toHaveBeenCalledTimes(2);
    const paths = fireWebhook.mock.calls.map((c) => c[0]);
    expect(paths).toContain('/webhook/deletion');
    expect(paths).toContain('/webhook/inception');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// fireDeletionAndPoll — stage helper
// ──────────────────────────────────────────────────────────────────────────
describe('fireDeletionAndPoll', () => {
  it('returns ok with tasksArchivedAtStart from first poll + final pollIterations', async () => {
    let pollCount = 0;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/eb823867': () => {
        pollCount++;
        if (pollCount === 1) return { results: new Array(132).fill({}) };
        if (pollCount === 2) return { results: new Array(60).fill({}) };
        return { results: [] };
      },
    });
    const fireWebhook = vi.fn(async () => ({}));

    const stage = await fireDeletionAndPoll({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.name).toBe('deletion');
    expect(stage.status).toBe('ok');
    expect(stage.tasksArchivedAtStart).toBe(132);
    expect(stage.pollIterations).toBe(3);
    expect(fireWebhook).toHaveBeenCalledWith('/webhook/deletion', { data: { id: PROD_ID } });
  });

  it('returns failed with deletion_timeout when polls never reach 0', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/eb823867': () => ({ results: new Array(50).fill({}) }),
    });
    const fireWebhook = vi.fn(async () => ({}));

    const stage = await fireDeletionAndPoll({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.status).toBe('failed');
    expect(stage.error.code).toBe('deletion_timeout');
    expect(stage.pollIterations).toBe(TEST_POLL_LIMITS.deletion.maxIterations);
  });

  it('emits structured progress events to onProgress', async () => {
    const events = [];
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/eb823867': () => ({ results: [] }),
    });
    const fireWebhook = vi.fn(async () => ({}));

    await fireDeletionAndPoll({
      prodId: PROD_ID,
      deps: {
        notionFetch, fireWebhook, sleep: instantSleep,
        pollLimits: TEST_POLL_LIMITS,
        onProgress: (e) => events.push(e),
      },
    });

    expect(events.map((e) => e.type)).toContain('deletion-fired');
    expect(events.map((e) => e.type)).toContain('deletion-poll');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// clearAuditRows — stage helper
// ──────────────────────────────────────────────────────────────────────────
describe('clearAuditRows', () => {
  it('reports both rowsScanned and rowsCleared and PATCHes each row', async () => {
    const dirty = new Array(15).fill(0).map((_, i) => ({ id: `row-${i}` }));
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/82ae00bc': () => ({ results: dirty }),
      'PATCH /v1/pages/': () => ({ id: 'patched' }),
    });

    const stage = await clearAuditRows({
      exportedId: EXPORTED_ID,
      deps: { notionFetch, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.status).toBe('ok');
    expect(stage.rowsScanned).toBe(15);
    expect(stage.rowsCleared).toBe(15);

    const patches = notionFetch.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(15);
    expect(patches[0].body.properties['Match Confidence']).toEqual({ select: null });
    expect(patches[0].body.properties['Notion Task']).toEqual({ relation: [] });
  });

  it('handles zero dirty rows cleanly', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/82ae00bc': () => ({ results: [] }),
    });

    const stage = await clearAuditRows({
      exportedId: EXPORTED_ID,
      deps: { notionFetch, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.rowsScanned).toBe(0);
    expect(stage.rowsCleared).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// reInceptionAndVerify — stage helper
// ──────────────────────────────────────────────────────────────────────────
describe('reInceptionAndVerify', () => {
  it('returns ok with cascadeCount + stabilizedAt + activityLogStatus on success', async () => {
    const notionFetch = makeNotionFetch({
      // Re-inception poll: stable count of 202 every time.
      'POST /v1/data_sources/eb823867': () => ({ results: new Array(202).fill({}) }),
      // Activity Log post-stabilization.
      'POST /v1/data_sources/ba423867': () => ({ results: [alEntry('Success')] }),
    });
    const fireWebhook = vi.fn(async () => ({}));

    const stage = await reInceptionAndVerify({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.status).toBe('ok');
    expect(stage.cascadeCount).toBe(202);
    expect(stage.activityLogStatus).toBe('Success');
    expect(stage.stabilizedAt).toBeGreaterThanOrEqual(2);
  });

  it('records pollIterations + stabilizedAt accurately', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/eb823867': () => ({ results: new Array(202).fill({}) }),
      'POST /v1/data_sources/ba423867': () => ({ results: [alEntry('Success')] }),
    });
    const fireWebhook = vi.fn(async () => ({}));

    const stage = await reInceptionAndVerify({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.stabilizedAt).toBe(3);
    expect(stage.pollIterations).toBe(3);
  });

  it('returns failed with inception_timeout when count never stabilizes', async () => {
    let n = 100;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/eb823867': () => ({ results: new Array(++n).fill({}) }), // count grows every poll
      'POST /v1/data_sources/ba423867': () => ({ results: [alEntry('Success')] }),
    });
    const fireWebhook = vi.fn(async () => ({}));

    const stage = await reInceptionAndVerify({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.status).toBe('failed');
    expect(stage.error.code).toBe('inception_timeout');
    expect(stage.stabilizedAt).toBeNull();
  });

  it('returns failed with inception_not_success when count stabilizes but Activity Log says Failed', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/eb823867': () => ({ results: new Array(202).fill({}) }),
      'POST /v1/data_sources/ba423867': () => ({ results: [alEntry('Failed')] }),
    });
    const fireWebhook = vi.fn(async () => ({}));

    const stage = await reInceptionAndVerify({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.status).toBe('failed');
    expect(stage.error.code).toBe('inception_not_success');
    expect(stage.activityLogStatus).toBe('Failed');
    expect(stage.cascadeCount).toBe(202);
  });
});
