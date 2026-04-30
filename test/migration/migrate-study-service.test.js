import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMigrationPlan,
  MigrateStudyGateError,
  runMigrateStudyPipeline,
} from '../../src/migration/migrate-study-service.js';
import { tierToMatchConfidence } from '../../src/migration/constants.js';
import { STUDIES_PROPS as S } from '../../src/notion/property-names.js';

function prop(type, id, value) {
  return { id, type, ...value };
}

/**
 * Returns a Production Study page with Import Mode set per `importMode` and
 * the round-trip Exported Study relation pointing back at `exportedStudyId`.
 */
function studyPageFixture({ importMode, exportedStudyId }) {
  return {
    properties: {
      [S.STUDY_NAME.name]: prop('title', S.STUDY_NAME.id, {
        title: [{ plain_text: 'Test Study', text: { content: 'Test Study' } }],
      }),
      [S.CONTRACT_SIGN_DATE.name]: prop('date', S.CONTRACT_SIGN_DATE.id, {
        date: { start: '2026-01-10' },
      }),
      [S.IMPORT_MODE.name]: prop('checkbox', S.IMPORT_MODE.id, { checkbox: importMode }),
      [S.MIGRATED_STUDY.name]: prop('relation', S.MIGRATED_STUDY.id, {
        relation: [{ id: exportedStudyId }],
      }),
    },
  };
}

/** Returns an Exported Studies row pointing at `studyId`. */
function exportedStudyFixture({ studyId, migratedTaskIds = ['mt-1'] }) {
  return {
    properties: {
      'Production Study': {
        id: 'x',
        type: 'relation',
        relation: [{ id: studyId }],
      },
      'Migrated Tasks': {
        id: 'y',
        type: 'relation',
        relation: migratedTaskIds.map((id) => ({ id })),
      },
    },
  };
}

describe('migrate-study-service', () => {
  beforeEach(() => {
    vi.stubEnv('MIGRATE_MIN_MIGRATED_TASKS', '1');
    vi.stubEnv('MIGRATE_MIN_STUDY_TASKS', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('tierToMatchConfidence', () => {
    it('maps prefilled and high tiers to "High"', () => {
      expect(tierToMatchConfidence('prefilled')).toBe('High');
      expect(tierToMatchConfidence('high')).toBe('High');
    });

    it('maps medium tier to "Medium"', () => {
      expect(tierToMatchConfidence('medium')).toBe('Medium');
    });

    it('maps low tier to "Low"', () => {
      expect(tierToMatchConfidence('low')).toBe('Low');
    });

    it('returns null for unknown / missing tiers', () => {
      expect(tierToMatchConfidence(undefined)).toBeNull();
      expect(tierToMatchConfidence(null)).toBeNull();
      expect(tierToMatchConfidence('mystery')).toBeNull();
    });
  });

  describe('MigrateStudyGateError', () => {
    it('exposes studyPageId when constructed with one', () => {
      const err = new MigrateStudyGateError('boom', { code: 'test' }, 'study-42');
      expect(err.name).toBe('MigrateStudyGateError');
      expect(err.message).toBe('boom');
      expect(err.details).toEqual({ code: 'test' });
      expect(err.studyPageId).toBe('study-42');
    });

    it('leaves studyPageId undefined for pre-resolution gates (two-arg signature)', () => {
      // The pre-resolution `production_study_relation` gate uses this shape
      // intentionally — Production Study isn't resolvable yet, so the catch
      // falls back to the Exported Studies row.
      const err = new MigrateStudyGateError('boom', { code: 'test' });
      expect(err.studyPageId).toBeUndefined();
    });

    it('leaves studyPageId undefined when explicitly passed undefined', () => {
      const err = new MigrateStudyGateError('boom', { code: 'test' }, undefined);
      expect(err.studyPageId).toBeUndefined();
    });
  });

  describe('buildMigrationPlan', () => {
    const notionClient = {
      getPage: vi.fn(),
      retrieveDatabase: vi.fn(),
      queryDatabase: vi.fn(),
      listAllUsers: vi.fn(),
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('throws when Exported Studies row has !=1 Production Study relation', async () => {
      notionClient.getPage.mockResolvedValueOnce({
        properties: {
          'Production Study': { id: 'x', type: 'relation', relation: [] },
          'Migrated Tasks': { id: 'y', type: 'relation', relation: [] },
        },
      });

      await expect(buildMigrationPlan(notionClient, 'exported-1', {})).rejects.toMatchObject({
        name: 'MigrateStudyGateError',
        details: { code: 'production_study_relation' },
      });
    });

    it('throws when Production Study Import Mode is already ON', async () => {
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') return studyPageFixture({ importMode: true, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });

      await expect(buildMigrationPlan(notionClient, 'exported-1', {})).rejects.toMatchObject({
        name: 'MigrateStudyGateError',
        details: { code: 'import_mode_on' },
        studyPageId: 'study-1',
      });
    });

    it('throws when Contract Sign Date is empty on the Production Study', async () => {
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') {
          const page = studyPageFixture({ importMode: false, exportedStudyId: 'exported-1' });
          page.properties[S.CONTRACT_SIGN_DATE.name] = prop('date', S.CONTRACT_SIGN_DATE.id, {
            date: null,
          });
          return page;
        }
        return { properties: {} };
      });

      await expect(buildMigrationPlan(notionClient, 'exported-1', {})).rejects.toMatchObject({
        name: 'MigrateStudyGateError',
        details: { code: 'contract_sign_empty' },
        studyPageId: 'study-1',
      });
    });

    it('throws when Production Study Exported Study relation does not point back', async () => {
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') {
          return studyPageFixture({ importMode: false, exportedStudyId: 'wrong-exported' });
        }
        return { properties: {} };
      });

      await expect(buildMigrationPlan(notionClient, 'exported-1', {})).rejects.toMatchObject({
        name: 'MigrateStudyGateError',
        details: { code: 'exported_study_relation_mismatch' },
        studyPageId: 'study-1',
      });
    });

    it('throws with studyPageId when Migrated Tasks relation is empty', async () => {
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') {
          return exportedStudyFixture({ studyId: 'study-1', migratedTaskIds: [] });
        }
        if (id === 'study-1') return studyPageFixture({ importMode: false, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });
      notionClient.retrieveDatabase.mockResolvedValue({
        properties: {
          Study: { id: 'sch-study' },
          'Production Task': { id: 'sch-pt' },
        },
      });
      notionClient.queryDatabase.mockResolvedValue([]);

      await expect(buildMigrationPlan(notionClient, 'exported-1', {})).rejects.toMatchObject({
        name: 'MigrateStudyGateError',
        details: { code: 'migrated_tasks_empty' },
        studyPageId: 'study-1',
      });
    });

    it('warns when Migrated Tasks query exceeds Exported Studies relation count', async () => {
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') {
          return exportedStudyFixture({ studyId: 'study-1', migratedTaskIds: ['mt-1'] });
        }
        if (id === 'study-1') return studyPageFixture({ importMode: false, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });
      notionClient.retrieveDatabase.mockResolvedValue({
        properties: {
          Study: { id: 'sch-study' },
          'Production Task': { id: 'sch-pt' },
        },
      });
      let q = 0;
      notionClient.queryDatabase.mockImplementation(async () => {
        q += 1;
        if (q === 1) {
          return [
            {
              id: 'mt-1',
              properties: {
                Study: { relation: [{ id: 'exported-1' }] },
                Name: { title: [{ plain_text: 'T', text: { content: 'T' } }] },
                'Production Task': { relation: [{ id: 'cascade-1' }] },
                Completed: { checkbox: false },
                Milestone: { select: { name: 'Contract Signed' } },
                Assignee: { rich_text: [] },
              },
            },
            {
              id: 'mt-2',
              properties: {
                Study: { relation: [{ id: 'exported-1' }] },
                Name: { title: [{ plain_text: 'Twin Task', text: { content: 'Twin Task' } }] },
                'Production Task': { relation: [] },
                Completed: { checkbox: false },
                Milestone: { select: { name: 'Contract Signed' } },
                Assignee: { rich_text: [] },
              },
            },
          ];
        }
        return [
          {
            id: 'cascade-1',
            properties: {
              'Task Name': {
                title: [{ plain_text: 'Twin Task', text: { content: 'Twin Task' } }],
              },
              Study: { relation: [{ id: 'study-1' }] },
              Milestone: { multi_select: [] },
              Tags: { multi_select: [] },
            },
          },
        ];
      });
      notionClient.listAllUsers.mockResolvedValue([]);

      const plan = await buildMigrationPlan(notionClient, 'exported-1', {});
      expect(plan.warnings.some((w) => w.category === 'migrated-tasks-relation-underfilled')).toBe(true);
      expect(plan.summary.migratedRows).toBe(2);
    });

    it('queues Production Task link for completed non-repeat rows with a twin', async () => {
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') return studyPageFixture({ importMode: false, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });
      notionClient.retrieveDatabase.mockResolvedValue({
        properties: {
          Study: { id: 'sch-study' },
          'Production Task': { id: 'sch-pt' },
          'Match Confidence': { id: 'sch-mc' },
        },
      });
      let q = 0;
      notionClient.queryDatabase.mockImplementation(async () => {
        q += 1;
        if (q === 1) {
          return [
            {
              id: 'mt-done',
              properties: {
                Study: { relation: [{ id: 'exported-1' }] },
                Name: { title: [{ plain_text: 'Twin Task', text: { content: 'Twin Task' } }] },
                'Production Task': { relation: [] },
                Completed: { checkbox: true },
                Milestone: { select: { name: 'Contract Signed' } },
                Assignee: { rich_text: [] },
              },
            },
          ];
        }
        return [
          {
            id: 'cascade-1',
            properties: {
              'Task Name': {
                title: [{ plain_text: 'Twin Task', text: { content: 'Twin Task' } }],
              },
              Study: { relation: [{ id: 'study-1' }] },
              Milestone: { multi_select: [] },
              Tags: { multi_select: [] },
            },
          },
        ];
      });
      notionClient.listAllUsers.mockResolvedValue([]);

      const plan = await buildMigrationPlan(notionClient, 'exported-1', {});
      expect(plan.migratedPatches.length).toBe(1);
      expect(plan.migratedPatches[0].taskId).toBe('mt-done');
      // Exact-name match → tier 'high' → Match Confidence "High".
      expect(plan.migratedPatches[0].properties['sch-mc']).toEqual({ select: { name: 'High' } });
      expect(plan.migratedPatches[0].properties['sch-pt']).toEqual({ relation: [{ id: 'cascade-1' }] });
    });

    it('skips Match Confidence write when the Migrated Tasks DB does not expose the column', async () => {
      // Best-effort: older Migrated Tasks DBs without the Match Confidence column
      // should still complete a migration; the cascade-side rollup just stays empty.
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') return studyPageFixture({ importMode: false, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });
      notionClient.retrieveDatabase.mockResolvedValue({
        properties: {
          Study: { id: 'sch-study' },
          'Production Task': { id: 'sch-pt' },
          // No 'Match Confidence' here — older schema.
        },
      });
      let q = 0;
      notionClient.queryDatabase.mockImplementation(async () => {
        q += 1;
        if (q === 1) {
          return [
            {
              id: 'mt-done',
              properties: {
                Study: { relation: [{ id: 'exported-1' }] },
                Name: { title: [{ plain_text: 'Twin Task', text: { content: 'Twin Task' } }] },
                'Production Task': { relation: [] },
                Completed: { checkbox: true },
                Milestone: { select: { name: 'Contract Signed' } },
                Assignee: { rich_text: [] },
              },
            },
          ];
        }
        return [
          {
            id: 'cascade-1',
            properties: {
              'Task Name': { title: [{ plain_text: 'Twin Task', text: { content: 'Twin Task' } }] },
              Study: { relation: [{ id: 'study-1' }] },
              Milestone: { multi_select: [] },
              Tags: { multi_select: [] },
            },
          },
        ];
      });
      notionClient.listAllUsers.mockResolvedValue([]);

      const plan = await buildMigrationPlan(notionClient, 'exported-1', {});
      expect(plan.migratedPatches.length).toBe(1);
      // Production Task still written; Match Confidence absent (no schema id resolved).
      expect(plan.migratedPatches[0].properties).toHaveProperty('sch-pt');
      expect(Object.keys(plan.migratedPatches[0].properties)).toEqual(['sch-pt']);
    });

    it('warns (does not throw) when Migrated Tasks query is below Exported Studies relation count', async () => {
      // Quality-threshold gates were removed in favor of "match what we can" —
      // a query/relation count mismatch is now a warning, not a halt.
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') {
          return exportedStudyFixture({ studyId: 'study-1', migratedTaskIds: ['mt-1', 'mt-2'] });
        }
        if (id === 'study-1') return studyPageFixture({ importMode: false, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });
      notionClient.retrieveDatabase.mockResolvedValue({
        properties: {
          Study: { id: 'sch-study' },
          'Production Task': { id: 'sch-pt' },
        },
      });
      let q = 0;
      notionClient.queryDatabase.mockImplementation(async () => {
        q += 1;
        if (q === 1) {
          return [
            {
              id: 'mt-1',
              properties: {
                Study: { relation: [{ id: 'exported-1' }] },
                Name: { title: [{ plain_text: 'T', text: { content: 'T' } }] },
                'Production Task': { relation: [{ id: 'cascade-1' }] },
                Completed: { checkbox: false },
                Milestone: { select: { name: 'Contract Signed' } },
                Assignee: { rich_text: [] },
              },
            },
          ];
        }
        return [
          {
            id: 'cascade-1',
            properties: {
              'Task Name': {
                title: [{ plain_text: 'Twin Task', text: { content: 'Twin Task' } }],
              },
              Study: { relation: [{ id: 'study-1' }] },
              Milestone: { multi_select: [] },
              Tags: { multi_select: [] },
            },
          },
        ];
      });
      notionClient.listAllUsers.mockResolvedValue([]);

      const plan = await buildMigrationPlan(notionClient, 'exported-1', {});
      expect(plan.warnings.some((w) => w.category === 'migrated-tasks-relation-overfilled')).toBe(true);
      expect(plan.summary.migratedRows).toBe(1);
    });

    it('does not throw on extreme unmatched-completed ratio — quality thresholds removed', async () => {
      // The 25% unmatched-ratio gate was removed. Even 100% unmatched should not
      // halt; PMs reconcile via the Migration Support callout.
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') return studyPageFixture({ importMode: false, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });
      notionClient.retrieveDatabase.mockResolvedValue({
        properties: {
          Study: { id: 'sch-study' },
          'Production Task': { id: 'sch-pt' },
        },
      });
      let q = 0;
      notionClient.queryDatabase.mockImplementation(async () => {
        q += 1;
        if (q === 1) {
          // One completed-non-repeat row whose name will not match any cascade task.
          return [
            {
              id: 'mt-orphan',
              properties: {
                Study: { relation: [{ id: 'exported-1' }] },
                Name: { title: [{ plain_text: 'No Match Here', text: { content: 'No Match Here' } }] },
                'Production Task': { relation: [] },
                Completed: { checkbox: true },
                Milestone: { select: { name: 'Some Other Milestone' } },
                'Task Type Tags': { multi_select: [] },
                Assignee: { rich_text: [] },
                'Date Completed': { date: { start: '2026-01-01' } },
              },
            },
          ];
        }
        return [
          {
            id: 'cascade-1',
            properties: {
              'Task Name': { title: [{ plain_text: 'Different Task', text: { content: 'Different Task' } }] },
              Study: { relation: [{ id: 'study-1' }] },
              Milestone: { multi_select: [] },
              Tags: { multi_select: [] },
            },
          },
        ];
      });
      notionClient.listAllUsers.mockResolvedValue([]);

      const plan = await buildMigrationPlan(notionClient, 'exported-1', {});
      expect(plan.summary.unmatchedRatio).toBe(1);
      expect(plan.summary.unmatchedCompletedNonRepeat).toBe(1);
      expect(plan.summary.completedNonRepeatDenom).toBe(1);
      expect(plan.warnings.some((w) => w.category === 'unmatched-completed-row')).toBe(true);
    });
  });

  describe('runMigrateStudyPipeline', () => {
    const notionClient = {
      getPage: vi.fn(),
      retrieveDatabase: vi.fn(),
      queryDatabase: vi.fn(),
      listAllUsers: vi.fn(),
      reportStatus: vi.fn().mockResolvedValue({}),
      request: vi.fn().mockResolvedValue({}),
      patchPages: vi.fn().mockResolvedValue({}),
    };
    const studyCommentService = { postComment: vi.fn().mockResolvedValue({}) };

    beforeEach(() => {
      vi.clearAllMocks();
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') return studyPageFixture({ importMode: false, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });

      notionClient.retrieveDatabase.mockResolvedValue({
        properties: {
          Study: { id: 'sch-study' },
          'Production Task': { id: 'sch-pt' },
        },
      });

      let migratedQueryDone = false;
      notionClient.queryDatabase.mockImplementation(async () => {
        if (!migratedQueryDone) {
          migratedQueryDone = true;
          return [
            {
              id: 'mt-1',
              properties: {
                Study: { relation: [{ id: 'exported-1' }] },
                Name: { title: [{ plain_text: 'T', text: { content: 'T' } }] },
                'Production Task': { relation: [{ id: 'cascade-1' }] },
                Completed: { checkbox: false },
                Milestone: { select: { name: 'Contract Signed' } },
                Assignee: { rich_text: [] },
              },
            },
          ];
        }
        return [
          {
            id: 'cascade-1',
            properties: {
              'Task Name': {
                title: [{ plain_text: 'Twin Task', text: { content: 'Twin Task' } }],
              },
              Study: { relation: [{ id: 'study-1' }] },
              Milestone: { multi_select: [] },
              Tags: { multi_select: [] },
            },
          },
        ];
      });

      notionClient.listAllUsers.mockResolvedValue([]);
    });

    it('reports + toggles Import Mode on the resolved Production Study, then off in finally', async () => {
      await runMigrateStudyPipeline(
        { data: { id: 'exported-1' } },
        notionClient,
        {
          tracer: { set: vi.fn() },
          studyCommentService,
          triggeredByUserId: null,
          editedByBot: false,
          studyNameFallback: null,
        },
      );

      // Import Mode PATCHes target the Production Study page, not the
      // Exported Studies row.
      const importPatches = notionClient.request.mock.calls.filter(
        (c) => c[0] === 'PATCH'
          && c[1] === '/pages/study-1'
          && c[2]?.properties?.[S.IMPORT_MODE.id],
      );
      expect(importPatches.length).toBeGreaterThanOrEqual(2);
      const last = importPatches[importPatches.length - 1][2].properties[S.IMPORT_MODE.id];
      expect(last.checkbox).toBe(false);

      // Reporting also targets the Production Study page.
      const reportTargets = notionClient.reportStatus.mock.calls.map((c) => c[0]);
      expect(reportTargets).toContain('study-1');
      expect(reportTargets).not.toContain('exported-1');

      expect(notionClient.patchPages).toHaveBeenCalled();
    });

    it('reports gate failure on the Exported Studies row when Production Study cannot be resolved', async () => {
      // Override: Exported Studies row has 0 Production Study relations.
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') {
          return {
            properties: {
              'Production Study': { id: 'x', type: 'relation', relation: [] },
              'Migrated Tasks': { id: 'y', type: 'relation', relation: [] },
            },
          };
        }
        return { properties: {} };
      });

      await expect(
        runMigrateStudyPipeline(
          { data: { id: 'exported-1' } },
          notionClient,
          {
            tracer: { set: vi.fn() },
            studyCommentService,
            triggeredByUserId: null,
            editedByBot: false,
            studyNameFallback: null,
          },
        ),
      ).rejects.toMatchObject({ details: { code: 'production_study_relation' } });

      const reportTargets = notionClient.reportStatus.mock.calls.map((c) => c[0]);
      expect(reportTargets).toContain('exported-1');
    });

    it('routes post-resolution gate failure (study_tasks_low) to the Production Study — the gate observed in production', async () => {
      // The study_tasks_low gate is what fired at 2026-04-30T14:58:24Z when the
      // bug surfaced (Production Study had 0 Study Tasks; Inception not run).
      // Override queryDatabase: first call returns Migrated Tasks (carryover OK),
      // second call returns empty Study Tasks → study_tasks_low throws.
      let queryCount = 0;
      notionClient.queryDatabase.mockImplementation(async () => {
        queryCount += 1;
        if (queryCount === 1) {
          return [
            {
              id: 'mt-1',
              properties: {
                Study: { relation: [{ id: 'exported-1' }] },
                Name: { title: [{ plain_text: 'T', text: { content: 'T' } }] },
                'Production Task': { relation: [] },
                Completed: { checkbox: false },
                Milestone: { select: { name: 'Contract Signed' } },
                Assignee: { rich_text: [] },
              },
            },
          ];
        }
        return [];
      });

      await expect(
        runMigrateStudyPipeline(
          { data: { id: 'exported-1' } },
          notionClient,
          {
            tracer: { set: vi.fn() },
            studyCommentService,
            triggeredByUserId: null,
            editedByBot: false,
            studyNameFallback: null,
          },
        ),
      ).rejects.toMatchObject({ details: { code: 'study_tasks_low' }, studyPageId: 'study-1' });

      const reportTargets = notionClient.reportStatus.mock.calls.map((c) => c[0]);
      expect(reportTargets).toContain('study-1');
      expect(reportTargets).not.toContain('exported-1');

      const commentTargets = studyCommentService.postComment.mock.calls.map((c) => c[0]?.studyId);
      expect(commentTargets).toContain('study-1');
      expect(commentTargets).not.toContain('exported-1');
    });

    it('routes post-resolution gate failure (import_mode_on) to the Production Study', async () => {
      // Override: Production Study has Import Mode already on.
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') return studyPageFixture({ importMode: true, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });

      await expect(
        runMigrateStudyPipeline(
          { data: { id: 'exported-1' } },
          notionClient,
          {
            tracer: { set: vi.fn() },
            studyCommentService,
            triggeredByUserId: null,
            editedByBot: false,
            studyNameFallback: null,
          },
        ),
      ).rejects.toMatchObject({ details: { code: 'import_mode_on' }, studyPageId: 'study-1' });

      const reportTargets = notionClient.reportStatus.mock.calls.map((c) => c[0]);
      expect(reportTargets).toContain('study-1');
      expect(reportTargets).not.toContain('exported-1');

      const commentTargets = studyCommentService.postComment.mock.calls.map((c) => c[0]?.studyId);
      expect(commentTargets).toContain('study-1');
      expect(commentTargets).not.toContain('exported-1');
    });

    it('warns and continues when reportStatus rejects mid-catch (gate error still surfaces)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') return studyPageFixture({ importMode: true, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });
      notionClient.reportStatus.mockRejectedValueOnce(new Error('Notion 400: property missing'));

      await expect(
        runMigrateStudyPipeline(
          { data: { id: 'exported-1' } },
          notionClient,
          {
            tracer: { set: vi.fn() },
            studyCommentService,
            triggeredByUserId: null,
            editedByBot: false,
            studyNameFallback: null,
          },
        ),
      ).rejects.toMatchObject({ details: { code: 'import_mode_on' } });

      // The swallow-warn is the load-bearing assertion: no longer a silent .catch(() => {}).
      const warnCall = warnSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('[migrate-study]') && call[0].includes('reportStatus'),
      );
      expect(warnCall).toBeTruthy();
      expect(warnCall.join(' ')).toContain('study-1');
      expect(warnCall.join(' ')).toContain('import_mode_on');

      // postComment still fires even when reportStatus rejected.
      expect(studyCommentService.postComment).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('warns and continues when postComment rejects mid-catch (gate error still surfaces)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      notionClient.getPage.mockImplementation(async (id) => {
        if (id === 'exported-1') return exportedStudyFixture({ studyId: 'study-1' });
        if (id === 'study-1') return studyPageFixture({ importMode: true, exportedStudyId: 'exported-1' });
        return { properties: {} };
      });
      studyCommentService.postComment.mockRejectedValueOnce(new Error('study-comment failed'));

      await expect(
        runMigrateStudyPipeline(
          { data: { id: 'exported-1' } },
          notionClient,
          {
            tracer: { set: vi.fn() },
            studyCommentService,
            triggeredByUserId: null,
            editedByBot: false,
            studyNameFallback: null,
          },
        ),
      ).rejects.toMatchObject({ details: { code: 'import_mode_on' } });

      const warnCall = warnSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('[migrate-study]') && call[0].includes('postComment'),
      );
      expect(warnCall).toBeTruthy();
      expect(warnCall.join(' ')).toContain('study-1');

      warnSpy.mockRestore();
    });
  });
});
