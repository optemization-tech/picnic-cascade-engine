import { describe, it, expect } from 'vitest';
import { normalizeTask } from '../../src/notion/properties.js';

describe('normalizeTask', () => {
  it('normalizes Notion page to flat task shape', () => {
    const page = {
      id: 'task-1',
      properties: {
        'Task Name': { title: [{ text: { content: 'Task One' } }] },
        'Dates': { date: { start: '2026-04-01', end: '2026-04-02' } },
        'Status': { status: { name: 'In Progress' } },
        'Blocked by': { relation: [{ id: 'a' }] },
        'Blocking': { relation: [{ id: 'b' }] },
        'Parent Task': { relation: [{ id: 'p' }] },
        'Study': { relation: [{ id: 's' }] },
        'Reference Start Date': { date: { start: '2026-03-31' } },
        'Reference End Date': { date: { start: '2026-04-02' } },
        'Last Modified By System': { checkbox: true },
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
    expect(task.lastModifiedBySystem).toBe(true);
  });
});
