import { describe, it, expect } from 'vitest';
import { classifyIdempotency } from '../../src/notion/idempotency-classifier.js';

/**
 * Unit 6 verification test — enumerates every (method, path) pair used
 * by engine/src/ callers and asserts the classifier returns the intended
 * idempotency class.
 *
 * If you add a new call site to engine/src/ that hits _requestWithSlot,
 * add the corresponding entry here. If the entry forces a new path to
 * become 'nonIdempotent', update the path-table in
 * src/notion/idempotency-classifier.js and Unit 6 of
 * docs/plans/2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md.
 *
 * The intent of this test is to catch any accidental misclassification
 * during review. Grep was exhaustive at plan time — keep it so.
 */

const callSites = [
  // ── Non-idempotent writes (PR E1 changes behavior here) ──────────────
  {
    caller: 'src/provisioning/create-tasks.js:152',
    via: 'client.createPages → POST /pages',
    method: 'POST',
    path: '/pages',
    expected: 'nonIdempotent',
  },
  {
    caller: 'src/provisioning/copy-blocks.js:248',
    via: 'client.request PATCH /blocks/{id}/children',
    method: 'PATCH',
    path: '/blocks/00000000-0000-0000-0000-000000000000/children',
    expected: 'nonIdempotent',
  },
  {
    caller: 'src/provisioning/copy-blocks.js:298',
    via: 'client.request PATCH /blocks/{id}/children',
    method: 'PATCH',
    path: '/blocks/00000000-0000-0000-0000-000000000000/children',
    expected: 'nonIdempotent',
  },

  // ── POST that is NOT a page-create (queries, comments, activity log) ─
  {
    caller: 'src/provisioning/deletion.js:19',
    via: 'client.request POST /databases/:id/query (read, not write)',
    method: 'POST',
    path: '/databases/abc-123/query',
    expected: 'idempotent',
  },
  {
    caller: 'src/services/study-comment.js:66',
    via: 'client.request POST /comments (not /pages)',
    method: 'POST',
    path: '/comments',
    expected: 'idempotent',
  },
  {
    caller: 'src/services/activity-log.js:171',
    via: 'client.request POST /pages (activity-log entry creation)',
    method: 'POST',
    path: '/pages',
    expected: 'nonIdempotent',
  },

  // ── PATCH /pages/:id — property updates, all idempotent ──────────────
  {
    caller: 'src/provisioning/deletion.js:29 (via requestBatch)',
    via: 'archive PATCH /pages/:id with {archived: true}',
    method: 'PATCH',
    path: '/pages/abc-123',
    expected: 'idempotent',
  },
  {
    caller: 'src/provisioning/wire-relations.js:74 (via patchPages)',
    via: 'patchPages → PATCH /pages/:id',
    method: 'PATCH',
    path: '/pages/abc-123',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/add-task-set.js:127',
    via: 'PATCH /pages/{studyPageId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/add-task-set.js:540',
    via: 'PATCH /pages/{studyPageId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/add-task-set.js:636',
    via: 'PATCH /pages/{studyPageId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/inception.js:38',
    via: 'PATCH /pages/{studyPageId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/inception.js:208',
    via: 'PATCH /pages/{studyPageId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/inception.js:301',
    via: 'PATCH /pages/{studyPageId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/undo-cascade.js:42',
    via: 'PATCH /pages/{studyId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/undo-cascade.js:77 (via patchPages)',
    via: 'patchPages → PATCH /pages/:id',
    method: 'PATCH',
    path: '/pages/abc-123',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/undo-cascade.js:85',
    via: 'PATCH /pages/{studyId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/undo-cascade.js:154',
    via: 'PATCH /pages/{studyId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/date-cascade.js:113',
    via: 'PATCH /pages/{studyId}',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/date-cascade.js:128 (via patchPage)',
    via: 'patchPage → PATCH /pages/:id',
    method: 'PATCH',
    path: '/pages/task-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/date-cascade.js:361 (via patchPages)',
    via: 'patchPages → PATCH /pages/:id',
    method: 'PATCH',
    path: '/pages/task-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/status-rollup.js:58 (via patchPage)',
    via: 'patchPage → PATCH /pages/:id',
    method: 'PATCH',
    path: '/pages/task-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/startup/import-mode-sweep.js:28 (via patchPage)',
    via: 'patchPage → PATCH /pages/:id',
    method: 'PATCH',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  // reportStatus is PATCH /pages/{studyId} under the hood, always idempotent.

  // ── GET — all idempotent ─────────────────────────────────────────────
  {
    caller: 'src/provisioning/copy-blocks.js:112',
    via: 'GET /blocks/{id}/children (read)',
    method: 'GET',
    path: '/blocks/abc-123/children?page_size=100',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/add-task-set.js:135 (via getPage)',
    via: 'getPage → GET /pages/:id',
    method: 'GET',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/inception.js:46 (via getPage)',
    via: 'getPage → GET /pages/:id',
    method: 'GET',
    path: '/pages/study-1',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/status-rollup.js:26-40 (via getPage)',
    via: 'getPage → GET /pages/:id',
    method: 'GET',
    path: '/pages/task-1',
    expected: 'idempotent',
  },

  // ── queryDatabase internally calls POST /databases/:id/query ─────────
  {
    caller: 'src/provisioning/blueprint.js:20 (via queryDatabase)',
    via: 'queryDatabase → POST /databases/:id/query',
    method: 'POST',
    path: '/databases/abc-123/query',
    expected: 'idempotent',
  },
  {
    caller: 'src/notion/queries.js:11 (via queryDatabase)',
    via: 'queryDatabase → POST /databases/:id/query',
    method: 'POST',
    path: '/databases/abc-123/query',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/add-task-set.js:146 (via queryDatabase)',
    via: 'queryDatabase → POST /databases/:id/query',
    method: 'POST',
    path: '/databases/abc-123/query',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/inception.js:55 (via queryDatabase)',
    via: 'queryDatabase → POST /databases/:id/query',
    method: 'POST',
    path: '/databases/abc-123/query',
    expected: 'idempotent',
  },
  {
    caller: 'src/routes/status-rollup.js:41 (via queryDatabase)',
    via: 'queryDatabase → POST /databases/:id/query',
    method: 'POST',
    path: '/databases/abc-123/query',
    expected: 'idempotent',
  },
  {
    caller: 'src/startup/import-mode-sweep.js:20 (via queryDatabase)',
    via: 'queryDatabase → POST /databases/:id/query',
    method: 'POST',
    path: '/databases/abc-123/query',
    expected: 'idempotent',
  },
];

describe('Unit 6: classifier matches every existing call site', () => {
  for (const site of callSites) {
    it(`${site.method} ${site.path} (${site.caller}) → ${site.expected}`, () => {
      expect(classifyIdempotency(site.method, site.path)).toBe(site.expected);
    });
  }

  it('covers the only three non-idempotent call sites', () => {
    const nonIdempotent = callSites.filter((s) => s.expected === 'nonIdempotent');
    // Two copy-blocks PATCH sites + one createPages (create-tasks) + one
    // activity-log POST /pages = four total.
    expect(nonIdempotent).toHaveLength(4);
    // All must be either POST /pages or PATCH /blocks/{id}/children.
    for (const site of nonIdempotent) {
      const isPagesPost = site.method === 'POST' && site.path === '/pages';
      const isBlocksChildrenPatch =
        site.method === 'PATCH' && /^\/blocks\/[^/]+\/children/.test(site.path);
      expect(isPagesPost || isBlocksChildrenPatch).toBe(true);
    }
  });
});
