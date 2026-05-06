/**
 * Safety-path tests for recover-inception's exported helpers.
 *
 * Scope: PR A safety primitives only.
 *   - queryAll cursor-invalidation retry (U7)
 *   - clearAuditRows abort-on-error (Q6 / U2)
 *   - fireDeletionAndPoll manual-task guard (R4 / U5)
 *
 * Out of scope (deferred to PR B/C):
 *   - state token rename (kebab → snake_case)
 *   - alreadySuccess outcome handling
 *   - Full run() orchestrator coverage
 */
import { describe, it, expect, vi } from 'vitest';
import {
  queryAll,
  clearAuditRows,
  fireDeletionAndPoll,
} from '../../../scripts/batch-migrate/recover-inception.js';

const STUDY_TASKS_DS = 'eb823867-60c2-83a6-b067-07cd54089367';
const ASANA_TASKS_DS = '82ae00bc-5cad-4f48-bd35-3d4e216a6a4b';
const PROD_ID = 'prod-uuid-1';
const EXPORTED_ID = 'exported-uuid-1';

const TEST_POLL_LIMITS = {
  deletion: { maxIterations: 5, intervalMs: 1 },
  reInception: { maxIterations: 6, intervalMs: 1, stableTarget: 2, minTasksFloor: 100 },
  clearAudit: { batchSize: 10, throttleMs: 1 },
  activityLogSettleMs: 1,
};

const instantSleep = () => Promise.resolve();

/**
 * Minimal route-driven mock for notionFetch. Routes are matched on
 * (method, pathPrefix) — handler function receives (body, path, callIndex).
 */
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

// ──────────────────────────────────────────────────────────────────────────
// queryAll — cursor-invalidation retry (U7)
// ──────────────────────────────────────────────────────────────────────────
describe('queryAll cursor retry', () => {
  it('returns full result on a single-page response (baseline)', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ results: [{ id: '1' }, { id: '2' }], has_more: false, next_cursor: null }),
    });
    const result = await queryAll(notionFetch, STUDY_TASKS_DS, { property: 'Study', relation: { contains: PROD_ID } });
    expect(result).toHaveLength(2);
    expect(notionFetch.calls).toHaveLength(1);
  });

  it('paginates across multiple pages cleanly when no cursor invalidation', async () => {
    let pageCount = 0;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => {
        pageCount++;
        if (pageCount === 1) return { results: [{ id: '1' }, { id: '2' }], has_more: true, next_cursor: 'cursor-2' };
        if (pageCount === 2) return { results: [{ id: '3' }], has_more: false, next_cursor: null };
      },
    });
    const result = await queryAll(notionFetch, STUDY_TASKS_DS, { property: 'Study', relation: { contains: PROD_ID } });
    expect(result.map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('restarts from page 1 on cursor invalidation, returns full result on retry', async () => {
    let attempt = 0;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': (body) => {
        // Two-attempt scenario. Attempt 1: page 1 OK with cursor, page 2 throws cursor invalidation.
        // Attempt 2: page 1 OK, page 2 OK (no more invalidation).
        const isFirstPage = !body.start_cursor;
        if (isFirstPage) {
          attempt++;
          return { results: [{ id: 'a' }, { id: 'b' }], has_more: true, next_cursor: 'page-2' };
        }
        // Second page request
        if (attempt === 1) {
          return { object: 'error', code: 'validation_error', message: 'start_cursor is not valid' };
        }
        return { results: [{ id: 'c' }, { id: 'd' }], has_more: false, next_cursor: null };
      },
    });
    const result = await queryAll(notionFetch, STUDY_TASKS_DS, { property: 'Study', relation: { contains: PROD_ID } });
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(attempt).toBe(2); // first-page query happened twice
  });

  it('throws cursor_exhausted error after max attempts', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ object: 'error', code: 'validation_error', message: 'cursor invalid' }),
    });
    await expect(
      queryAll(notionFetch, STUDY_TASKS_DS, {}, { maxAttempts: 3 })
    ).rejects.toMatchObject({
      code: 'cursor_exhausted',
      message: expect.stringContaining('cursor retries exhausted'),
    });
  });

  it('does NOT retry on non-cursor errors — propagates immediately', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ object: 'error', code: 'unauthorized', message: 'API token is invalid' }),
    });
    await expect(
      queryAll(notionFetch, STUDY_TASKS_DS, {})
    ).rejects.toThrow(/query error/);
    expect(notionFetch.calls).toHaveLength(1); // only one attempt — no retry
  });

  it('emits cursor-invalidated progress event on retry', async () => {
    const events = [];
    let attempt = 0;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': (body) => {
        const isFirstPage = !body.start_cursor;
        if (isFirstPage) {
          attempt++;
          return { results: [{ id: 'a' }], has_more: true, next_cursor: 'page-2' };
        }
        if (attempt === 1) return { object: 'error', code: 'validation_error', message: 'cursor invalid' };
        return { results: [{ id: 'b' }], has_more: false, next_cursor: null };
      },
    });
    await queryAll(notionFetch, STUDY_TASKS_DS, {}, { onProgress: (e) => events.push(e) });
    expect(events.find((e) => e.type === 'cursor-invalidated')).toBeDefined();
    expect(events.find((e) => e.type === 'cursor-invalidated').attempt).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// clearAuditRows — abort-on-error (Q6 / R9)
// ──────────────────────────────────────────────────────────────────────────
describe('clearAuditRows abort behavior', () => {
  it('processes all dirty rows when PATCHes succeed', async () => {
    const dirty = [{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }];
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ results: dirty, has_more: false, next_cursor: null }),
      'PATCH /v1/pages/': () => ({ id: 'patched' }),
    });
    const stage = await clearAuditRows({
      exportedId: EXPORTED_ID,
      deps: { notionFetch, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });
    expect(stage.status).toBe('ok');
    expect(stage.rowsScanned).toBe(3);
    expect(stage.rowsCleared).toBe(3);
    expect(notionFetch.calls.filter((c) => c.method === 'PATCH')).toHaveLength(3);
  });

  it('aborts on first PATCH error and reports rowsCleared accurately', async () => {
    const dirty = [{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }, { id: 'row-4' }];
    let patchCount = 0;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ results: dirty, has_more: false, next_cursor: null }),
      'PATCH /v1/pages/': (body, path) => {
        patchCount++;
        if (patchCount === 3) {
          // Simulate a hard failure (post-fetch-layer-retry exhaustion)
          throw new Error('PATCH /v1/pages/row-3 502: gateway timeout');
        }
        return { id: 'patched' };
      },
    });
    const stage = await clearAuditRows({
      exportedId: EXPORTED_ID,
      deps: { notionFetch, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });
    expect(stage.status).toBe('failed');
    expect(stage.error.code).toBe('patch_failed');
    expect(stage.error.rowId).toBe('row-3');
    expect(stage.rowsScanned).toBe(4);
    expect(stage.rowsCleared).toBe(2); // rows 1 + 2 succeeded; loop aborted before 4
    // Critical: row-4 was NEVER attempted (Q6 abort behavior)
    const patchPaths = notionFetch.calls.filter((c) => c.method === 'PATCH').map((c) => c.path);
    expect(patchPaths).not.toContain('/v1/pages/row-4');
  });

  it('handles zero dirty rows cleanly', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ results: [], has_more: false, next_cursor: null }),
    });
    const stage = await clearAuditRows({
      exportedId: EXPORTED_ID,
      deps: { notionFetch, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });
    expect(stage.status).toBe('ok');
    expect(stage.rowsScanned).toBe(0);
    expect(stage.rowsCleared).toBe(0);
  });

  it('emits clear-audit-error event on abort path', async () => {
    const events = [];
    const dirty = [{ id: 'row-1' }, { id: 'row-2' }];
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ results: dirty, has_more: false, next_cursor: null }),
      'PATCH /v1/pages/': (body, path) => {
        if (path.includes('row-2')) throw new Error('rate limited');
        return { id: 'patched' };
      },
    });
    await clearAuditRows({
      exportedId: EXPORTED_ID,
      deps: {
        notionFetch, sleep: instantSleep,
        pollLimits: TEST_POLL_LIMITS,
        onProgress: (e) => events.push(e),
      },
    });
    const errorEvent = events.find((e) => e.type === 'clear-audit-error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.rowId).toBe('row-2');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// fireDeletionAndPoll — manual-task guard (R4 / U5)
// ──────────────────────────────────────────────────────────────────────────
describe('fireDeletionAndPoll manual-task guard', () => {
  it('refuses deletion when manual tasks are present and surfaces task IDs', async () => {
    const manualTasks = [
      { id: 'manual-1' },
      { id: 'manual-2' },
      { id: 'manual-3' },
    ];
    let queryCount = 0;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': (body) => {
        queryCount++;
        // First query is the manual-task pre-flight (filter has is_empty: true)
        const isManualTaskQuery = body?.filter?.and?.some((f) => f?.rich_text?.is_empty === true);
        if (isManualTaskQuery) return { results: manualTasks, has_more: false, next_cursor: null };
        return { results: [], has_more: false, next_cursor: null };
      },
    });
    const fireWebhook = vi.fn(async () => ({ ok: true }));

    const stage = await fireDeletionAndPoll({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.status).toBe('failed');
    expect(stage.error.code).toBe('manual_tasks_present');
    expect(stage.error.message).toContain('3 manual Study Tasks present');
    expect(stage.manualTaskIds).toEqual(['manual-1', 'manual-2', 'manual-3']);
    // Critical: webhook was NEVER fired because the guard refused
    expect(fireWebhook).not.toHaveBeenCalled();
  });

  it('uses the correct rich_text filter shape for manual-task pre-flight', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ results: [], has_more: false, next_cursor: null }),
    });
    const fireWebhook = vi.fn(async () => ({}));

    await fireDeletionAndPoll({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    const preflightCall = notionFetch.calls[0];
    expect(preflightCall.body.filter.and).toBeDefined();
    const templateFilter = preflightCall.body.filter.and.find((f) => f.property === '[Do Not Edit] Template Source ID');
    expect(templateFilter).toBeDefined();
    // Verify the rich_text wrapper is present (bare `is_empty: true` would not be a valid Notion filter)
    expect(templateFilter.rich_text).toEqual({ is_empty: true });
  });

  it('proceeds to deletion when zero manual tasks present', async () => {
    let queryCount = 0;
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': (body) => {
        queryCount++;
        // First call is manual-task pre-flight (returns 0)
        // Subsequent calls are deletion-progress polls — return 0 immediately to end
        return { results: [], has_more: false, next_cursor: null };
      },
    });
    const fireWebhook = vi.fn(async () => ({}));

    const stage = await fireDeletionAndPoll({
      prodId: PROD_ID,
      deps: { notionFetch, fireWebhook, sleep: instantSleep, pollLimits: TEST_POLL_LIMITS },
    });

    expect(stage.status).toBe('ok');
    expect(fireWebhook).toHaveBeenCalledWith('/webhook/deletion', { data: { id: PROD_ID } });
  });

  it('emits manual-tasks-detected progress event on refuse path', async () => {
    const events = [];
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/': () => ({ results: [{ id: 'm-1' }], has_more: false, next_cursor: null }),
    });
    const fireWebhook = vi.fn();

    await fireDeletionAndPoll({
      prodId: PROD_ID,
      deps: {
        notionFetch, fireWebhook, sleep: instantSleep,
        pollLimits: TEST_POLL_LIMITS,
        onProgress: (e) => events.push(e),
      },
    });

    const detected = events.find((e) => e.type === 'manual-tasks-detected');
    expect(detected).toBeDefined();
    expect(detected.count).toBe(1);
  });
});
