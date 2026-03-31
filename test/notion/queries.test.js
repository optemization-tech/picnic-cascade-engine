import { describe, it, expect } from 'vitest';
import { queryStudyTasks } from '../../src/notion/queries.js';

describe('queryStudyTasks', () => {
  it('queries by study relation and normalizes pages', async () => {
    const calls = [];
    const client = {
      async queryDatabase(dbId, filter) {
        calls.push({ dbId, filter });
        return [{
          id: 'task-1',
          properties: {
            'Task Name': { title: [{ text: { content: 'Task One' } }] },
            'Dates': { date: { start: '2026-04-01', end: '2026-04-02' } },
            'Status': { status: { name: 'Not Started' } },
            'Blocked by': { relation: [] },
            'Blocking': { relation: [] },
            'Parent Task': { relation: [] },
            'Study': { relation: [{ id: 'study-1' }] },
          },
        }];
      },
    };

    const tasks = await queryStudyTasks(client, 'db-1', 'study-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].dbId).toBe('db-1');
    expect(calls[0].filter).toEqual({ property: 'Study', relation: { contains: 'study-1' } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-1');
    expect(tasks[0].studyId).toBe('study-1');
  });
});
