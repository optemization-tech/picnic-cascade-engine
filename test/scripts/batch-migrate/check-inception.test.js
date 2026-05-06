import { describe, it, expect, vi } from 'vitest';
import { run } from '../../../scripts/batch-migrate/check-inception.js';

const STUDY_KEY = 'ionis-hae-001'; // exists in batch-migrate config
const STUDY_NAME = 'Ionis HAE 001';
const PROD_ID = 'prod-study-uuid-1';
const EXPORTED_ROW_ID = 'exported-row-uuid-1';

// ──────────────────────────────────────────────────────────────────────────
// Mock notionFetch keyed on (method, path) → handler. Handler can be a fn or
// a static value. Used by both check-inception and recover-inception tests.
// ──────────────────────────────────────────────────────────────────────────
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
    return typeof handler === 'function' ? handler(body, path) : handler;
  });
  fn.calls = calls;
  return fn;
}

// Canonical responses
const exportedStudiesRow = (overrides = {}) => ({
  id: EXPORTED_ROW_ID,
  properties: {
    'Production Study': { relation: [{ id: PROD_ID }] },
    ...overrides.properties,
  },
});

const activityLogEntry = ({ status, summary = 'Inception complete: 202 tasks created, 200 linked, 198 matched', created = '2026-05-05T07:19:00.000Z' } = {}) => ({
  created_time: created,
  properties: {
    'Status': { select: { name: status } },
    'Summary': { rich_text: [{ plain_text: summary }] },
    'Created time': { created_time: created },
  },
});

describe('check-inception run()', () => {
  it('returns success with full fields + exit 0 when Activity Log shows Success', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({ status: 'Success' })] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });

    expect(exitCode).toBe(0);
    expect(result.schemaVersion).toBe(1);
    expect(result.study).toBe(STUDY_KEY);
    expect(result.studyName).toBe(STUDY_NAME);
    expect(result.exportedRowId).toBe(EXPORTED_ROW_ID);
    expect(result.productionStudyId).toBe(PROD_ID);
    expect(result.inceptionStatus).toBe('Success');
    expect(result.inceptionSummary).toContain('Inception complete');
    expect(result.createdTime).toMatch(/Z$/);
    expect(result.state).toBe('success');
  });

  it('returns failed with exit 1 on Activity Log Failed status', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({
        status: 'Failed',
        summary: 'Batch incomplete: 132 tasks created (expected 202)',
      })] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });

    expect(exitCode).toBe(1);
    expect(result.state).toBe('failed');
    expect(result.inceptionStatus).toBe('Failed');
    expect(result.inceptionSummary).toContain('Batch incomplete');
  });

  it('returns no-entry with exit 2 + null status fields when no Inception entry', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });

    expect(exitCode).toBe(2);
    expect(result.state).toBe('no-entry');
    expect(result.inceptionStatus).toBeNull();
    expect(result.inceptionSummary).toBeNull();
    expect(result.createdTime).toBeNull();
    expect(result.productionStudyId).toBe(PROD_ID); // still resolved
  });

  it('returns no-production-study with exit 2 when relation is empty', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow({
        properties: { 'Production Study': { relation: [] } },
      })] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });

    expect(exitCode).toBe(2);
    expect(result.state).toBe('no-production-study');
    expect(result.productionStudyId).toBeNull();
    expect(result.exportedRowId).toBe(EXPORTED_ROW_ID);
    // notionFetch should have been called only once (no Activity Log query needed)
    expect(notionFetch.calls).toHaveLength(1);
  });

  it('returns no-exported-row with exit 2 when Exported Studies query returns empty', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });

    expect(exitCode).toBe(2);
    expect(result.state).toBe('no-exported-row');
    expect(result.exportedRowId).toBeNull();
    expect(result.productionStudyId).toBeNull();
    expect(result.studyName).toBe(STUDY_NAME);
  });

  it('returns exit 3 with unknown_study error for invalid study key', async () => {
    const notionFetch = makeNotionFetch({});

    const { exitCode, result } = await run({ studyKey: 'never-heard-of-it', deps: { notionFetch } });

    expect(exitCode).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown_study');
    expect(notionFetch.calls).toHaveLength(0); // never queries Notion on bad key
  });

  it('emits schemaVersion: 1 on every result', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({ status: 'Success' })] }),
    });
    const { result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });
    expect(result.schemaVersion).toBe(1);
  });

  it('passes the right filter to the Activity Log query', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({ status: 'Success' })] }),
    });
    await run({ studyKey: STUDY_KEY, deps: { notionFetch } });

    const alCall = notionFetch.calls.find((c) => c.path.includes('ba423867'));
    expect(alCall.body.filter.and[0].relation.contains).toBe(PROD_ID);
    expect(alCall.body.filter.and[1].select.equals).toBe('Inception');
    expect(alCall.body.sorts[0].direction).toBe('descending');
  });
});
