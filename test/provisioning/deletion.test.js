import { describe, expect, it, vi } from 'vitest';
import { deleteStudyTasks } from '../../src/provisioning/deletion.js';

function makeMockClient({ tasks = [] } = {}) {
  const client = {
    request: vi.fn().mockResolvedValue({}),
  };
  // First request call is the query, rest are archive PATCHes
  client.request.mockResolvedValueOnce({ results: tasks, has_more: false });
  return client;
}

describe('deleteStudyTasks', () => {
  const studyTasksDbId = 'db-study-tasks';
  const studyId = 'study-123';

  it('archives all tasks returned by query', async () => {
    const tasks = [
      { id: 'task-1' },
      { id: 'task-2' },
      { id: 'task-3' },
    ];
    const client = makeMockClient({ tasks });

    const result = await deleteStudyTasks(client, { studyTasksDbId, studyId });

    expect(client.request).toHaveBeenCalledWith(
      'POST',
      `/databases/${studyTasksDbId}/query`,
      { filter: { property: 'Study', relation: { contains: studyId } }, page_size: 100 },
      { tracer: undefined },
    );
    expect(client.request).toHaveBeenCalledWith('PATCH', '/pages/task-1', { archived: true }, { tracer: undefined });
    expect(client.request).toHaveBeenCalledWith('PATCH', '/pages/task-2', { archived: true }, { tracer: undefined });
    expect(client.request).toHaveBeenCalledWith('PATCH', '/pages/task-3', { archived: true }, { tracer: undefined });
    // 1 query + 3 archives + 1 empty query (loop termination)
    expect(result).toEqual({ archivedCount: 3 });
  });

  it('returns correct count for a single task', async () => {
    const tasks = [{ id: 'only-task' }];
    const client = makeMockClient({ tasks });

    const result = await deleteStudyTasks(client, { studyTasksDbId, studyId });

    expect(result).toEqual({ archivedCount: 1 });
  });

  it('handles empty study (0 tasks) without archiving', async () => {
    const client = makeMockClient({ tasks: [] });

    const result = await deleteStudyTasks(client, { studyTasksDbId, studyId });

    expect(result).toEqual({ archivedCount: 0 });
    // Only the query call, no PATCH calls
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('passes tracer through to client methods', async () => {
    const tasks = [{ id: 'task-1' }];
    const client = makeMockClient({ tasks });
    const tracer = {
      startPhase: vi.fn(),
      endPhase: vi.fn(),
    };

    await deleteStudyTasks(client, { studyTasksDbId, studyId, tracer });

    expect(tracer.startPhase).toHaveBeenCalledWith('query');
    expect(tracer.endPhase).toHaveBeenCalledWith('query');
    expect(tracer.startPhase).toHaveBeenCalledWith('archive');
    expect(tracer.endPhase).toHaveBeenCalledWith('archive');
    expect(client.request).toHaveBeenCalledWith('PATCH', '/pages/task-1', { archived: true }, { tracer });
  });

  it('loops through multiple batches when has_more is true', async () => {
    const batch1 = Array.from({ length: 100 }, (_, i) => ({ id: `t-${i}` }));
    const batch2 = [{ id: 't-100' }, { id: 't-101' }];
    const client = {
      request: vi.fn().mockResolvedValue({}),
    };
    client.request
      .mockResolvedValueOnce({ results: batch1, has_more: true })
      .mockResolvedValueOnce({}) // archive calls get default {}
    ;
    // After batch1 archives, next query returns batch2
    // We need to handle the sequence: query → 100 archives → query → 2 archives
    // Reset to handle this properly:
    let queryCount = 0;
    client.request.mockReset();
    client.request.mockImplementation((method, path) => {
      if (method === 'POST' && path.includes('/query')) {
        queryCount++;
        if (queryCount === 1) return Promise.resolve({ results: batch1, has_more: true });
        if (queryCount === 2) return Promise.resolve({ results: batch2, has_more: false });
        return Promise.resolve({ results: [], has_more: false });
      }
      return Promise.resolve({});
    });

    const result = await deleteStudyTasks(client, { studyTasksDbId, studyId });

    expect(queryCount).toBe(2);
    expect(result).toEqual({ archivedCount: 102 });
  });
});
