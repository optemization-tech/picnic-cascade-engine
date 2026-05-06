/**
 * Safety-path tests for check-inception's run() function.
 *
 * Scope: PR A safety primitives only.
 *   - Happy path (Activity Log Success)
 *   - state enum coverage (success / failed / no-entry / no-production-study /
 *     no-exported-row)
 *   - classifyError + exit-code routing for transient (R2/U4)
 *
 * Out of scope (deferred to PR B/C):
 *   - state token rename to snake_case
 *   - Conditional outcome rule
 */
import { describe, it, expect, vi } from 'vitest';
import { run } from '../../../scripts/batch-migrate/check-inception.js';

const STUDY_KEY = 'ionis-hae-001';
const STUDY_NAME = 'Ionis HAE 001';
const PROD_ID = 'prod-uuid-1';
const EXPORTED_ROW_ID = 'exported-uuid-1';

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

const exportedStudiesRow = (overrides = {}) => ({
  id: EXPORTED_ROW_ID,
  properties: {
    'Production Study': { relation: [{ id: PROD_ID }] },
    ...overrides.properties,
  },
});

const activityLogEntry = ({ status, summary = 'Inception complete: 202 tasks created', created = '2026-05-05T07:19:00.000Z' } = {}) => ({
  created_time: created,
  properties: {
    'Status': { select: { name: status } },
    'Summary': { rich_text: [{ plain_text: summary }] },
    'Created time': { created_time: created },
  },
});

describe('check-inception run()', () => {
  it('returns success with exit 0 when Activity Log shows Success', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({ status: 'Success' })] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.state).toBe('success');
    expect(result.inceptionStatus).toBe('Success');
    expect(result.schemaVersion).toBe(1);
  });

  it('returns failed with exit 1 when Activity Log shows Failed', async () => {
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
  });

  it('returns no-entry with exit 2 + null status fields when no Inception entry', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });
    expect(exitCode).toBe(2);
    expect(result.state).toBe('no_entry');
    expect(result.inceptionStatus).toBeNull();
    expect(result.productionStudyId).toBe(PROD_ID);
  });

  it('returns no-production-study with exit 2 when relation is empty', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow({
        properties: { 'Production Study': { relation: [] } },
      })] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });
    expect(exitCode).toBe(2);
    expect(result.state).toBe('no_production_study');
    expect(result.productionStudyId).toBeNull();
    // Notion should only have been queried once (no AL query needed)
    expect(notionFetch.calls).toHaveLength(1);
  });

  it('returns no-exported-row with exit 2 when Exported Studies query is empty', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });
    expect(exitCode).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.state).toBe('no_exported_row');
    expect(result.error.code).toBe('no_exported_row');
    expect(result.studyName).toBe(STUDY_NAME);
  });

  it('returns exit 3 with unknown_study error for invalid study key', async () => {
    const notionFetch = makeNotionFetch({});

    const { exitCode, result } = await run({ studyKey: 'never-heard-of-it', deps: { notionFetch } });
    expect(exitCode).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown_study');
    expect(notionFetch.calls).toHaveLength(0);
  });

  it('result includes schemaVersion: 1 on every path', async () => {
    const cases = [
      // success
      makeNotionFetch({
        'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
        'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({ status: 'Success' })] }),
      }),
      // no-exported-row
      makeNotionFetch({ 'POST /v1/data_sources/cb785052': () => ({ results: [] }) }),
    ];
    for (const fetch of cases) {
      const { result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch: fetch } });
      expect(result.schemaVersion).toBe(1);
    }
  });

  it('passes correct filter to Activity Log query', async () => {
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

  // ────────────────────────────────────────────────────────────────────
  // U9 — In-flight state coverage (R5 / PR C). The 'other' state was
  // retired in PR B; verify each replacement token (in_progress / unknown
  // / cancelled) is emitted correctly per the Activity Log Status name.
  // ────────────────────────────────────────────────────────────────────
  it('returns state in_progress with exit 2 when Activity Log shows In Progress', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({ status: 'In Progress' })] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });
    expect(exitCode).toBe(2);
    expect(result.state).toBe('in_progress');
    expect(result.inceptionStatus).toBe('In Progress');
    expect(result.ok).toBe(true); // not an error — just inconclusive
  });

  it('returns state cancelled with exit 2 when Activity Log shows Cancelled', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({ status: 'Cancelled' })] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });
    expect(exitCode).toBe(2);
    expect(result.state).toBe('cancelled');
    expect(result.inceptionStatus).toBe('Cancelled');
  });

  it('returns state unknown with exit 2 for any other Activity Log status', async () => {
    const notionFetch = makeNotionFetch({
      'POST /v1/data_sources/cb785052': () => ({ results: [exportedStudiesRow()] }),
      'POST /v1/data_sources/ba423867': () => ({ results: [activityLogEntry({ status: 'PartialRetry' })] }),
    });

    const { exitCode, result } = await run({ studyKey: STUDY_KEY, deps: { notionFetch } });
    expect(exitCode).toBe(2);
    expect(result.state).toBe('unknown');
    // inceptionStatus preserves the raw Notion value for diagnostics
    expect(result.inceptionStatus).toBe('PartialRetry');
  });
});
