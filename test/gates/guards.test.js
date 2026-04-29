import { describe, it, expect } from 'vitest';
import { parseWebhookPayload, isImportMode, isFrozen } from '../../src/gates/guards.js';
import { STUDY_TASKS_PROPS as ST } from '../../src/notion/property-names.js';

function buildPayload(overrides = {}) {
  return {
    body: {
      data: {
        id: 'task-1',
        last_edited_by: { id: 'user-1', type: 'person' },
        properties: {
          [ST.TASK_NAME.name]:           { id: ST.TASK_NAME.id,           type: 'title',    title: [{ text: { content: 'Task One' } }] },
          [ST.DATES.name]:               { id: ST.DATES.id,               type: 'date',     date: { start: '2026-04-01', end: '2026-04-02' } },
          [ST.REF_START.name]:           { id: ST.REF_START.id,           type: 'date',     date: { start: '2026-04-01' } },
          [ST.REF_END.name]:             { id: ST.REF_END.id,             type: 'date',     date: { start: '2026-04-02' } },
          [ST.STATUS.name]:              { id: ST.STATUS.id,              type: 'status',   status: { name: 'Not Started' } },
          [ST.IMPORT_MODE_ROLLUP.name]:  { id: ST.IMPORT_MODE_ROLLUP.id,  type: 'rollup',   rollup: { type: 'boolean', boolean: false } },
          [ST.STUDY.name]:               { id: ST.STUDY.id,               type: 'relation', relation: [{ id: 'study-1' }] },
          [ST.PARENT_TASK.name]:         { id: ST.PARENT_TASK.id,         type: 'relation', relation: [] },
          [ST.SUBTASKS.name]:            { id: ST.SUBTASKS.id,            type: 'relation', relation: [] },
          ...(overrides.properties || {}),
        },
      },
    },
  };
}

describe('guards parseWebhookPayload', () => {
  // @behavior BEH-GUARD-FREEZE
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

  // @behavior BEH-GUARD-IMPORT-MODE
  it('extracts import mode from rollup array', () => {
    const parsed = parseWebhookPayload(buildPayload({
      properties: {
        [ST.IMPORT_MODE_ROLLUP.name]: {
          id: ST.IMPORT_MODE_ROLLUP.id,
          type: 'rollup',
          rollup: { type: 'array', array: [{ checkbox: true }] },
        },
      },
    }));
    expect(parsed.importMode).toBe(true);
  });

  // @behavior BEH-GUARD-IMPORT-MODE
  it('extracts import mode from direct checkbox', () => {
    const parsed = parseWebhookPayload(buildPayload({
      properties: {
        [ST.IMPORT_MODE_ROLLUP.name]: {
          id: ST.IMPORT_MODE_ROLLUP.id,
          type: 'checkbox',
          checkbox: true,
        },
      },
    }));
    expect(parsed.importMode).toBe(true);
  });

  // @behavior BEH-GUARD-FREEZE
  it('captures frozen status from payload', () => {
    const parsed = parseWebhookPayload(buildPayload({
      properties: {
        [ST.STATUS.name]: { id: ST.STATUS.id, type: 'status', status: { name: 'Done' } },
      },
    }));
    expect(parsed.status).toBe('Done');
    expect(isFrozen(parsed)).toBe(true);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot true when last_edited_by type is bot', () => {
    const payload = buildPayload();
    payload.body.data.last_edited_by = { id: 'bot-1', type: 'bot' };
    expect(parseWebhookPayload(payload).editedByBot).toBe(true);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot false when last_edited_by type is person', () => {
    const payload = buildPayload();
    payload.body.data.last_edited_by = { id: 'user-1', type: 'person' };
    expect(parseWebhookPayload(payload).editedByBot).toBe(false);
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('sets editedByBot false when last_edited_by is missing', () => {
    const payload = buildPayload();
    delete payload.body.data.last_edited_by;
    expect(parseWebhookPayload(payload).editedByBot).toBe(false);
  });
});

describe('guards predicates', () => {
  it('import/frozen checks', () => {
    expect(isImportMode({ importMode: true })).toBe(true);
    expect(isFrozen({ status: 'Done' })).toBe(true);
    expect(isFrozen({ status: 'N/A' })).toBe(true);
    expect(isFrozen({ status: 'In Progress' })).toBe(false);
  });
});
