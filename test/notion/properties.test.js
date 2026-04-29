import { describe, it, expect } from 'vitest';
import { normalizeTask } from '../../src/notion/properties.js';
import { STUDY_TASKS_PROPS as ST } from '../../src/notion/property-names.js';

describe('normalizeTask', () => {
  it('normalizes Notion page to flat task shape', () => {
    const page = {
      id: 'task-1',
      properties: {
        [ST.TASK_NAME.name]:    { id: ST.TASK_NAME.id,    type: 'title',    title: [{ text: { content: 'Task One' } }] },
        [ST.DATES.name]:        { id: ST.DATES.id,        type: 'date',     date: { start: '2026-04-01', end: '2026-04-02' } },
        [ST.STATUS.name]:       { id: ST.STATUS.id,       type: 'status',   status: { name: 'In Progress' } },
        [ST.BLOCKED_BY.name]:   { id: ST.BLOCKED_BY.id,   type: 'relation', relation: [{ id: 'a' }] },
        [ST.BLOCKING.name]:     { id: ST.BLOCKING.id,     type: 'relation', relation: [{ id: 'b' }] },
        [ST.PARENT_TASK.name]:  { id: ST.PARENT_TASK.id,  type: 'relation', relation: [{ id: 'p' }] },
        [ST.STUDY.name]:        { id: ST.STUDY.id,        type: 'relation', relation: [{ id: 's' }] },
        [ST.REF_START.name]:    { id: ST.REF_START.id,    type: 'date',     date: { start: '2026-03-31' } },
        [ST.REF_END.name]:      { id: ST.REF_END.id,      type: 'date',     date: { start: '2026-04-02' } },
      },
    };

    const task = normalizeTask(page);
    expect(task.id).toBe('task-1');
    expect(task.name).toBe('Task One');
    expect(task.status).toBe('In Progress');
    expect(task.blockedByIds).toEqual(['a']);
    expect(task.blockingIds).toEqual(['b']);
    expect(task.parentId).toBe('p');
    expect(task.studyId).toBe('s');
    expect(task.refStart).toBe('2026-03-31');
    expect(task.refEnd).toBe('2026-04-02');
  });
});
