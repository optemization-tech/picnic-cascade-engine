import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nukeStudyTasks } from '../../src/provisioning/nuke.js';

function makeMockClient({ tasks = [] } = {}) {
  return {
    queryDatabase: vi.fn().mockResolvedValue(tasks),
    request: vi.fn().mockResolvedValue({}),
  };
}

describe('nukeStudyTasks', () => {
  const studyTasksDbId = 'db-study-tasks';
  const studyId = 'study-123';

  it('archives all tasks returned by queryDatabase', async () => {
    const tasks = [
      { id: 'task-1' },
      { id: 'task-2' },
      { id: 'task-3' },
    ];
    const client = makeMockClient({ tasks });

    const result = await nukeStudyTasks(client, { studyTasksDbId, studyId });

    expect(client.queryDatabase).toHaveBeenCalledWith(
      studyTasksDbId,
      { property: 'Study', relation: { contains: studyId } },
      100,
      { tracer: undefined },
    );
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).toHaveBeenCalledWith('PATCH', '/pages/task-1', { archived: true }, { tracer: undefined });
    expect(client.request).toHaveBeenCalledWith('PATCH', '/pages/task-2', { archived: true }, { tracer: undefined });
    expect(client.request).toHaveBeenCalledWith('PATCH', '/pages/task-3', { archived: true }, { tracer: undefined });
    expect(result).toEqual({ archivedCount: 3 });
  });

  it('returns correct count for a single task', async () => {
    const tasks = [{ id: 'only-task' }];
    const client = makeMockClient({ tasks });

    const result = await nukeStudyTasks(client, { studyTasksDbId, studyId });

    expect(result).toEqual({ archivedCount: 1 });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('handles empty study (0 tasks) without calling request', async () => {
    const client = makeMockClient({ tasks: [] });

    const result = await nukeStudyTasks(client, { studyTasksDbId, studyId });

    expect(result).toEqual({ archivedCount: 0 });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('passes tracer through to client methods', async () => {
    const tasks = [{ id: 'task-1' }];
    const client = makeMockClient({ tasks });
    const tracer = {
      startPhase: vi.fn(),
      endPhase: vi.fn(),
    };

    await nukeStudyTasks(client, { studyTasksDbId, studyId, tracer });

    expect(tracer.startPhase).toHaveBeenCalledWith('query');
    expect(tracer.endPhase).toHaveBeenCalledWith('query');
    expect(tracer.startPhase).toHaveBeenCalledWith('archive');
    expect(tracer.endPhase).toHaveBeenCalledWith('archive');
    expect(client.queryDatabase).toHaveBeenCalledWith(
      studyTasksDbId,
      expect.any(Object),
      100,
      { tracer },
    );
    expect(client.request).toHaveBeenCalledWith('PATCH', '/pages/task-1', { archived: true }, { tracer });
  });
});
