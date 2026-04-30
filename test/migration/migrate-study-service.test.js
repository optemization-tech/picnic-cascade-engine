import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMigrationPlan,
  runMigrateStudyPipeline,
} from '../../src/migration/migrate-study-service.js';
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
    });

    it('throws when Migrated Tasks query is below Exported Studies relation count', async () => {
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

      await expect(buildMigrationPlan(notionClient, 'exported-1', {})).rejects.toMatchObject({
        name: 'MigrateStudyGateError',
        details: { code: 'migrated_count_mismatch' },
      });
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
  });
});
