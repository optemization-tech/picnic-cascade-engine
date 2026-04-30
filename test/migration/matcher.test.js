import { describe, expect, it } from 'vitest';
import { STUDY_TASKS_PROPS } from '../../src/notion/property-names.js';
import { MIGRATED_TASK_PROP } from '../../src/migration/constants.js';
import {
  buildStudyTaskNameIndex,
  collectCascadeMilestoneOptions,
  inferMilestoneFromTitle,
  resolveCascadeTwin,
  contributorCompletionDate,
  isRepeatDeliveryRow,
  isCompletedRow,
  hasManualWorkstreamTag,
} from '../../src/migration/matcher.js';
import { cleanTitleByStrippingStudyPrefix, stripStudyPrefix } from '../../src/migration/normalize.js';

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

  describe('stripStudyPrefix', () => {
    it('strips a multi-token study name from the leading position', () => {
      expect(stripStudyPrefix('Alexion PNH PLEDGE External Kickoff', 'Alexion PNH PLEDGE')).toBe(
        'External Kickoff',
      );
    });

    it('strips after leading emoji marker', () => {
      expect(stripStudyPrefix('🔶 Alexion PNH PLEDGE External Kickoff', 'Alexion PNH PLEDGE')).toBe(
        'External Kickoff',
      );
    });

    it('handles separators like colons and commas between study tokens and the rest', () => {
      expect(stripStudyPrefix('Alexion PNH: Submit IRB', 'Alexion PNH PLEDGE')).toBe('Submit IRB');
    });

    it('does not strip study tokens that appear mid-title', () => {
      // "PNH" appears in the body, not as a leading token sequence — leave it.
      expect(stripStudyPrefix('Configure PNH dataset', 'Alexion PNH PLEDGE')).toBe(
        'Configure PNH dataset',
      );
    });

    it('returns the input unchanged when studyName is missing or empty', () => {
      expect(stripStudyPrefix('Some Task', '')).toBe('Some Task');
      expect(stripStudyPrefix('Some Task', null)).toBe('Some Task');
      expect(stripStudyPrefix('Some Task', undefined)).toBe('Some Task');
    });

    it('handles tokens in any order in the leading prefix', () => {
      // "PNH PLEDGE Alexion" peels in any order since study tokens form a set.
      expect(stripStudyPrefix('PNH PLEDGE Alexion: External Kickoff', 'Alexion PNH PLEDGE')).toBe(
        'External Kickoff',
      );
    });

    it('eats the entire title when it is only the study name', () => {
      expect(stripStudyPrefix('Alexion PNH PLEDGE', 'Alexion PNH PLEDGE')).toBe('');
    });
  });

  describe('cleanTitleByStrippingStudyPrefix', () => {
    it('preserves the leading emoji marker and strips study tokens', () => {
      expect(
        cleanTitleByStrippingStudyPrefix('🔶  Alexion PNH PLEDGE Final SAP Delivery', 'Alexion PNH PLEDGE'),
      ).toBe('🔶 Final SAP Delivery');
    });

    it('strips study tokens with no emoji marker', () => {
      expect(
        cleanTitleByStrippingStudyPrefix('Alexion PNH: Submit IRB', 'Alexion PNH PLEDGE'),
      ).toBe('Submit IRB');
    });

    it('returns the input unchanged when title is already clean', () => {
      expect(
        cleanTitleByStrippingStudyPrefix('Final SAP Delivery', 'Alexion PNH PLEDGE'),
      ).toBe('Final SAP Delivery');
    });

    it('returns the input unchanged when title is only the study name (no reduce-to-empty)', () => {
      expect(
        cleanTitleByStrippingStudyPrefix('Alexion PNH PLEDGE', 'Alexion PNH PLEDGE'),
      ).toBe('Alexion PNH PLEDGE');
    });

    it('returns the input unchanged when studyName is missing', () => {
      expect(cleanTitleByStrippingStudyPrefix('Some Task', null)).toBe('Some Task');
      expect(cleanTitleByStrippingStudyPrefix('Some Task', '')).toBe('Some Task');
    });

    it('handles each recognized emoji marker', () => {
      expect(
        cleanTitleByStrippingStudyPrefix('✅ Alexion PNH PLEDGE Done Item', 'Alexion PNH PLEDGE'),
      ).toBe('✅ Done Item');
      expect(
        cleanTitleByStrippingStudyPrefix('🔷 Alexion PNH PLEDGE Future', 'Alexion PNH PLEDGE'),
      ).toBe('🔷 Future');
    });
  });

  describe('inferMilestoneFromTitle', () => {
    const cascadeMilestones = new Set([
      'External Kickoff',
      'Contract Signed',
      'IRB Approval',
      'IRB Submission',
      'First Site Activated',
      'Last Site Activated',
    ]);

    it('returns the canonical option when the title contains exactly one option', () => {
      expect(inferMilestoneFromTitle('External Kickoff', cascadeMilestones)).toBe('External Kickoff');
    });

    it('prefers the longest matching option when multiple substring-match', () => {
      // "First Site Activated" and "Last Site Activated" both contain "Site Activated"
      // but the cascadeMilestones set has them as full labels — longest match wins.
      expect(
        inferMilestoneFromTitle('First Site Activated, then Onboarding', cascadeMilestones),
      ).toBe('First Site Activated');
    });

    it('matches case-insensitively at word boundaries', () => {
      expect(inferMilestoneFromTitle('IRB approval received', cascadeMilestones)).toBe('IRB Approval');
    });

    it('returns null when no option appears in the title', () => {
      expect(inferMilestoneFromTitle('Random task name', cascadeMilestones)).toBeNull();
    });

    it('returns null on empty title or empty option set', () => {
      expect(inferMilestoneFromTitle('', cascadeMilestones)).toBeNull();
      expect(inferMilestoneFromTitle('IRB Approval', new Set())).toBeNull();
    });
  });

  describe('collectCascadeMilestoneOptions', () => {
    it('returns the union of Milestone multi_select values across cascade tasks', () => {
      const pages = [
        studyTask('a', 'Task A', {
          [STUDY_TASKS_PROPS.MILESTONE.name]: { multi_select: [{ name: 'Contract Signed' }] },
        }),
        studyTask('b', 'Task B', {
          [STUDY_TASKS_PROPS.MILESTONE.name]: {
            multi_select: [{ name: 'External Kickoff' }, { name: 'Contract Signed' }],
          },
        }),
        studyTask('c', 'Task C'),
      ];
      const set = collectCascadeMilestoneOptions(pages);
      expect(set.size).toBe(2);
      expect(set.has('Contract Signed')).toBe(true);
      expect(set.has('External Kickoff')).toBe(true);
    });
  });

  describe('resolveCascadeTwin — study-prefix and milestone-inference extensions', () => {
    const studyPages = [
      studyTask('cascade-ek', 'External Kickoff'),
      studyTask('cascade-ms-irb', 'Submit IRB Application', {
        [STUDY_TASKS_PROPS.MILESTONE.name]: {
          multi_select: [{ name: 'IRB Approval' }],
        },
      }),
    ];
    const index = buildStudyTaskNameIndex(studyPages);
    const milestoneOpts = collectCascadeMilestoneOptions(studyPages);

    it('matches name-tier on a study-prefixed source title (study name peeled)', () => {
      const result = resolveCascadeTwin({
        migratedProps: {
          [MIGRATED_TASK_PROP.NAME]: titleValue('🔶 Alexion PNH PLEDGE External Kickoff'),
        },
        studyTaskPages: studyPages,
        nameIndex: index,
        requireMilestoneTagForFallback: false,
        jaccardMin: 0.45,
        studyName: 'Alexion PNH PLEDGE',
        cascadeMilestoneOptions: milestoneOpts,
      });
      expect(result).toEqual({ cascadeId: 'cascade-ek', source: 'name-matched', tier: 'high' });
    });

    it('infers milestone from title when source Milestone select is empty but Task Type Tags includes Milestone', () => {
      const result = resolveCascadeTwin({
        migratedProps: {
          [MIGRATED_TASK_PROP.NAME]: titleValue('🔶 Alexion PNH PLEDGE IRB Approval'),
          [MIGRATED_TASK_PROP.TASK_TYPE_TAGS]: { multi_select: [{ name: 'Milestone' }] },
          // No Milestone select set.
        },
        studyTaskPages: studyPages,
        nameIndex: index,
        requireMilestoneTagForFallback: true,
        jaccardMin: 0.45,
        studyName: 'Alexion PNH PLEDGE',
        cascadeMilestoneOptions: milestoneOpts,
      });
      expect(result).toEqual({
        cascadeId: 'cascade-ms-irb',
        source: 'milestone-inferred',
        tier: 'medium',
      });
    });

    it('does not infer milestone when Task Type Tags lacks Milestone tag', () => {
      const result = resolveCascadeTwin({
        migratedProps: {
          [MIGRATED_TASK_PROP.NAME]: titleValue('🔶 Alexion PNH PLEDGE IRB Approval'),
          [MIGRATED_TASK_PROP.TASK_TYPE_TAGS]: { multi_select: [] },
        },
        studyTaskPages: studyPages,
        nameIndex: index,
        requireMilestoneTagForFallback: true,
        jaccardMin: 0.45,
        studyName: 'Alexion PNH PLEDGE',
        cascadeMilestoneOptions: milestoneOpts,
      });
      // No tag → no inference. Falls through to Jaccard, which won't find a strong-enough match here.
      expect(result).toBeNull();
    });
  });
});
