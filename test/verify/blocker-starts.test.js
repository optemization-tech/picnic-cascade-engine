import { describe, expect, it } from 'vitest';
import { parseDate } from '../../src/utils/business-days.js';
import { extractStudyPageId, findBlockerStartViolations } from '../../src/verify/blocker-starts.js';

function task(id, name, start, end, blockedByIds = []) {
  return {
    id,
    name,
    start: start ? parseDate(start) : null,
    end: end ? parseDate(end) : null,
    blockedByIds,
  };
}

describe('extractStudyPageId', () => {
  it('parses a hyphenated page id', () => {
    expect(extractStudyPageId('34223867-60c2-8026-b602-d80197f9cde1')).toBe('34223867-60c2-8026-b602-d80197f9cde1');
  });

  it('parses a Notion URL with a compact page id suffix', () => {
    expect(extractStudyPageId('https://www.notion.so/picnichealth/Meg-Test-Apr-14-3422386760c28026b602d80197f9cde1')).toBe('34223867-60c2-8026-b602-d80197f9cde1');
  });
});

describe('findBlockerStartViolations', () => {
  it('passes when a task starts on the next business day after its latest blocker', () => {
    const tasks = [
      task('a', 'A', '2026-04-06', '2026-04-08'),
      task('b', 'B', '2026-04-09', '2026-04-10', ['a']),
    ];

    expect(findBlockerStartViolations(tasks)).toEqual([]);
  });

  it('flags a task whose start does not match the latest blocker end plus one business day', () => {
    const tasks = [
      task('a', 'A', '2026-04-06', '2026-04-08'),
      task('b', 'B', '2026-04-07', '2026-04-09'),
      task('c', 'C', '2026-04-09', '2026-04-10', ['a', 'b']),
    ];

    expect(findBlockerStartViolations(tasks)).toEqual([
      expect.objectContaining({
        type: 'start_mismatch',
        taskId: 'c',
        expectedStart: '2026-04-10',
        actualStart: '2026-04-09',
        bindingBlockerId: 'b',
      }),
    ]);
  });

  it('ignores a weekend start within two days of the expected business day', () => {
    const tasks = [
      task('a', 'A', '2026-04-06', '2026-04-10'),
      task('b', 'B', '2026-04-12', '2026-04-13', ['a']),
    ];

    expect(findBlockerStartViolations(tasks)).toEqual([]);
  });

  it('still flags a weekend start more than two days from the expected business day', () => {
    const tasks = [
      task('a', 'A', '2026-04-06', '2026-04-01'),
      task('b', 'B', '2026-04-12', '2026-04-13', ['a']),
    ];

    expect(findBlockerStartViolations(tasks)).toEqual([
      expect.objectContaining({
        type: 'start_mismatch',
        taskId: 'b',
        expectedStart: '2026-04-02',
        actualStart: '2026-04-12',
      }),
    ]);
  });

  it('reports blockers that are missing end dates', () => {
    const tasks = [
      task('a', 'A', '2026-04-06', null),
      task('b', 'B', '2026-04-09', '2026-04-10', ['a']),
    ];

    expect(findBlockerStartViolations(tasks)).toEqual([
      expect.objectContaining({
        type: 'missing_blocker_end',
        taskId: 'b',
      }),
    ]);
  });
});
