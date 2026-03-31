import { describe, it, expect } from 'vitest';
import { parseWebhookPayload, isSystemModified, isImportMode, isFrozen } from '../../src/gates/guards.js';

function buildPayload(overrides = {}) {
  return {
    body: {
      data: {
        id: 'task-1',
        last_edited_by: { id: 'user-1' },
        properties: {
          'Task Name': { title: [{ text: { content: 'Task One' } }] },
          'Dates': { date: { start: '2026-04-01', end: '2026-04-02' } },
          'Reference Start Date': { date: { start: '2026-04-01' } },
          'Reference End Date': { date: { start: '2026-04-02' } },
          'Status': { status: { name: 'Not Started' } },
          'Last Modified By System': { checkbox: false },
          'Import Mode': { rollup: { type: 'boolean', boolean: false } },
          'Study': { relation: [{ id: 'study-1' }] },
          'Parent Task': { relation: [] },
          'Subtask(s)': { relation: [] },
          ...(overrides.properties || {}),
        },
      },
    },
  };
}

describe('guards parseWebhookPayload', () => {
  it('parses core fields and deltas', () => {
    const parsed = parseWebhookPayload(buildPayload());
    expect(parsed.skip).toBe(false);
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.taskName).toBe('Task One');
    expect(parsed.studyId).toBe('study-1');
    expect(parsed.startDelta).toBe(0);
    expect(parsed.endDelta).toBe(0);
  });

  it('handles missing page id as skip', () => {
    const parsed = parseWebhookPayload({ body: { data: { properties: {} } } });
    expect(parsed.skip).toBe(true);
  });

  it('extracts import mode from rollup array', () => {
    const parsed = parseWebhookPayload(buildPayload({
      properties: {
        'Import Mode': { rollup: { type: 'array', array: [{ checkbox: true }] } },
      },
    }));
    expect(parsed.importMode).toBe(true);
  });
});

describe('guards predicates', () => {
  it('system/import/frozen checks', () => {
    expect(isSystemModified({ lastModifiedBySystem: true })).toBe(true);
    expect(isImportMode({ importMode: true })).toBe(true);
    expect(isFrozen({ status: 'Done' })).toBe(true);
    expect(isFrozen({ status: 'N/A' })).toBe(true);
    expect(isFrozen({ status: 'In Progress' })).toBe(false);
  });
});
