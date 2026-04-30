import { describe, expect, it } from 'vitest';
import { STUDY_TASKS_PROPS } from '../../src/notion/property-names.js';
import { MIGRATED_TASK_PROP } from '../../src/migration/constants.js';
import {
  buildStudyTaskNameIndex,
  resolveCascadeTwin,
  contributorCompletionDate,
  isRepeatDeliveryRow,
  isCompletedRow,
  hasManualWorkstreamTag,
} from '../../src/migration/matcher.js';

const TN = STUDY_TASKS_PROPS.TASK_NAME.name;

function titleValue(text) {
  return { title: [{ plain_text: text, text: { content: text } }] };
}

function studyTask(id, taskName, extras = {}) {
  return {
    id,
    properties: {
      [TN]: titleValue(taskName),
      ...extras,
    },
  };
}

describe('migration/matcher', () => {
  describe('buildStudyTaskNameIndex', () => {
    it('maps normalized name to cascade page id', () => {
      const pages = [studyTask('c1', 'Contract Signed')];
      const idx = buildStudyTaskNameIndex(pages);
      expect(idx.get('contract signed')).toBe('c1');
    });

    it('stores multiple ids when duplicate normalized names', () => {
      const pages = [studyTask('a', 'Foo Task'), studyTask('b', 'Foo Task')];
      const idx = buildStudyTaskNameIndex(pages);
      const v = idx.get('foo task');
      expect(Array.isArray(v)).toBe(true);
      expect(v.sort()).toEqual(['a', 'b']);
    });
  });

  describe('resolveCascadeTwin', () => {
    const jaccardMin = 0.6;
    const studyPages = [
      studyTask('st1', 'Unique Alpha Task'),
      studyTask('st2', 'Beta Something'),
      studyTask('st3', 'Gamma', {
        [STUDY_TASKS_PROPS.MILESTONE.name]: {
          multi_select: [{ name: 'Contract Signed' }],
        },
      }),
    ];
    const index = buildStudyTaskNameIndex(studyPages);

    it('prefills from Production Task relation', () => {
      const migratedProps = {
        [MIGRATED_TASK_PROP.NAME]: titleValue('anything'),
        [MIGRATED_TASK_PROP.PRODUCTION_TASK]: { relation: [{ id: 'st1' }] },
      };
      const r = resolveCascadeTwin({
        migratedProps,
        studyTaskPages: studyPages,
        nameIndex: index,
        requireMilestoneTagForFallback: false,
        jaccardMin,
      });
      expect(r).toEqual({ cascadeId: 'st1', source: 'pre-filled', tier: 'prefilled' });
    });

    it('prefills from Notion Task relation when Production Task absent', () => {
      const migratedProps = {
        [MIGRATED_TASK_PROP.NAME]: titleValue('anything'),
        [MIGRATED_TASK_PROP.NOTION_TASK]: { relation: [{ id: 'st1' }] },
      };
      const r = resolveCascadeTwin({
        migratedProps,
        studyTaskPages: studyPages,
        nameIndex: index,
        requireMilestoneTagForFallback: false,
        jaccardMin,
      });
      expect(r).toEqual({ cascadeId: 'st1', source: 'pre-filled', tier: 'prefilled' });
    });

    it('exact normalized name → high tier', () => {
      const migratedProps = {
        [MIGRATED_TASK_PROP.NAME]: titleValue('Unique Alpha Task'),
        [MIGRATED_TASK_PROP.PRODUCTION_TASK]: { relation: [] },
      };
      const r = resolveCascadeTwin({
        migratedProps,
        studyTaskPages: studyPages,
        nameIndex: index,
        requireMilestoneTagForFallback: false,
        jaccardMin,
      });
      expect(r?.cascadeId).toBe('st1');
      expect(r?.tier).toBe('high');
    });

    it('returns ambiguous when duplicate cascade titles', () => {
      const dupPages = [studyTask('x', 'Dup'), studyTask('y', 'Dup')];
      const idx = buildStudyTaskNameIndex(dupPages);
      const migratedProps = {
        [MIGRATED_TASK_PROP.NAME]: titleValue('Dup'),
        [MIGRATED_TASK_PROP.PRODUCTION_TASK]: { relation: [] },
      };
      const r = resolveCascadeTwin({
        migratedProps,
        studyTaskPages: dupPages,
        nameIndex: idx,
        requireMilestoneTagForFallback: false,
        jaccardMin,
      });
      expect(r).toEqual({ ambiguous: true });
    });

    it('milestone fallback when milestone tag not required', () => {
      const migratedProps = {
        [MIGRATED_TASK_PROP.NAME]: titleValue('NoSuchName'),
        [MIGRATED_TASK_PROP.PRODUCTION_TASK]: { relation: [] },
        [MIGRATED_TASK_PROP.MILESTONE]: { select: { name: 'Contract Signed' } },
        [MIGRATED_TASK_PROP.TASK_TYPE_TAGS]: { multi_select: [] },
      };
      const r = resolveCascadeTwin({
        migratedProps,
        studyTaskPages: studyPages,
        nameIndex: buildStudyTaskNameIndex(studyPages),
        requireMilestoneTagForFallback: false,
        jaccardMin,
      });
      expect(r?.cascadeId).toBe('st3');
      expect(r?.source).toBe('milestone-fallback');
    });

    it('skips milestone fallback without Milestone tag when strict completed row', () => {
      const migratedProps = {
        [MIGRATED_TASK_PROP.NAME]: titleValue('NoSuchName'),
        [MIGRATED_TASK_PROP.PRODUCTION_TASK]: { relation: [] },
        [MIGRATED_TASK_PROP.MILESTONE]: { select: { name: 'Contract Signed' } },
        [MIGRATED_TASK_PROP.TASK_TYPE_TAGS]: { multi_select: [] },
      };
      const r = resolveCascadeTwin({
        migratedProps,
        studyTaskPages: studyPages,
        nameIndex: buildStudyTaskNameIndex(studyPages),
        requireMilestoneTagForFallback: true,
        jaccardMin,
      });
      expect(r?.source).not.toBe('milestone-fallback');
      expect(r === null || r?.tier === 'low').toBe(true);
    });
  });

  describe('contributorCompletionDate', () => {
    it('prefers Date Completed over Due Date', () => {
      const props = {
        [MIGRATED_TASK_PROP.DATE_COMPLETED]: { date: { start: '2026-02-01' } },
        [MIGRATED_TASK_PROP.DUE_DATE]: { date: { start: '2026-01-01' } },
      };
      expect(contributorCompletionDate(props)).toBe('2026-02-01');
    });

    it('falls back to Due Date', () => {
      const props = {
        [MIGRATED_TASK_PROP.DUE_DATE]: { date: { start: '2026-03-15' } },
      };
      expect(contributorCompletionDate(props)).toBe('2026-03-15');
    });
  });

  describe('row kinds', () => {
    it('detects Repeat Delivery milestone', () => {
      expect(
        isRepeatDeliveryRow({
          [MIGRATED_TASK_PROP.MILESTONE]: { select: { name: 'Repeat Delivery' } },
        }),
      ).toBe(true);
    });

    it('detects completed checkbox', () => {
      expect(isCompletedRow({ [MIGRATED_TASK_PROP.COMPLETED]: { checkbox: true } })).toBe(true);
    });

    it('detects Manual Workstream tag on cascade props', () => {
      expect(
        hasManualWorkstreamTag({
          [STUDY_TASKS_PROPS.TAGS.name]: {
            multi_select: [{ name: 'Manual Workstream / Item' }],
          },
        }),
      ).toBe(true);
    });
  });
});
