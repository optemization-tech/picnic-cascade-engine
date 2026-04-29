import { describe, it, expect } from 'vitest';
import { queryStudyTasks } from '../../src/notion/queries.js';
import { STUDY_TASKS_PROPS as ST } from '../../src/notion/property-names.js';

describe('queryStudyTasks', () => {
  it('queries by study relation and normalizes pages', async () => {
    const calls = [];
    const client = {
      async queryDatabase(dbId, filter) {
        calls.push({ dbId, filter });
        return [{
          id: 'task-1',
          properties: {
            [ST.TASK_NAME.name]:   { id: ST.TASK_NAME.id,   type: 'title',    title: [{ text: { content: 'Task One' } }] },
            [ST.DATES.name]:       { id: ST.DATES.id,       type: 'date',     date: { start: '2026-04-01', end: '2026-04-02' } },
            [ST.STATUS.name]:      { id: ST.STATUS.id,      type: 'status',   status: { name: 'Not Started' } },
            [ST.BLOCKED_BY.name]:  { id: ST.BLOCKED_BY.id,  type: 'relation', relation: [] },
            [ST.BLOCKING.name]:    { id: ST.BLOCKING.id,    type: 'relation', relation: [] },
            [ST.PARENT_TASK.name]: { id: ST.PARENT_TASK.id, type: 'relation', relation: [] },
            [ST.STUDY.name]:       { id: ST.STUDY.id,       type: 'relation', relation: [{ id: 'study-1' }] },
          },
        }];
      },
    };

    const tasks = await queryStudyTasks(client, 'db-1', 'study-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].dbId).toBe('db-1');
    expect(calls[0].filter).toEqual({ property: ST.STUDY.id, relation: { contains: 'study-1' } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-1');
    expect(tasks[0].studyId).toBe('study-1');
  });
});
