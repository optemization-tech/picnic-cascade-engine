import { describe, it, expect, vi } from 'vitest';
import { ActivityLogService } from '../../src/services/activity-log.js';

function makeService() {
  const notionClient = { request: vi.fn().mockResolvedValue({ id: 'page-123' }) };
  const logger = { warn: vi.fn() };
  const service = new ActivityLogService({
    notionClient,
    activityLogDbId: 'db-activity',
    logger,
  });
  return { service, notionClient, logger };
}

describe('ActivityLogService', () => {
  it('writes summary to properties and details to page children blocks', async () => {
    const { service, notionClient } = makeService();

    await service.logTerminalEvent({
      workflow: 'Date Cascade',
      status: 'success',
      triggerType: 'Automation',
      executionId: 'exec-1',
      timestamp: '2026-03-31T17:00:00.000Z',
      cascadeMode: 'pull-left',
      sourceTaskId: 'task-1',
      sourceTaskName: 'Task One',
      studyId: 'study-1',
      triggeredByUserId: 'user-1',
      summary: 'pull-left: Task One (4 updates)',
      details: {
        movement: { updatedCount: 4 },
        crossChain: { capHit: false, residueCount: 0 },
      },
    });

    expect(notionClient.request).toHaveBeenCalledTimes(1);
    expect(notionClient.request).toHaveBeenCalledWith('POST', '/pages', expect.objectContaining({
      parent: { database_id: 'db-activity' },
      properties: expect.objectContaining({
        Summary: {
          rich_text: [{ type: 'text', text: { content: 'pull-left: Task One (4 updates)' } }],
        },
        Status: { select: { name: 'Success' } },
        Workflow: { select: { name: 'Date Cascade' } },
        'Trigger Type': { select: { name: 'Automation' } },
        'Cascade Mode': { select: { name: 'pull-left' } },
        'Execution ID': { rich_text: [{ type: 'text', text: { content: 'exec-1' } }] },
        Study: { relation: [{ id: 'study-1' }] },
        'Study Tasks': { relation: [{ id: 'task-1' }] },
      }),
      children: expect.any(Array),
    }));

    const payload = notionClient.request.mock.calls[0][2];
    const children = payload.children || [];
    expect(children.some((c) => c.type === 'heading_2')).toBe(true);
    expect(children.some((c) => c.type === 'code')).toBe(true);
  });

  it('maps no_action and failed status names for Notion status property', async () => {
    const { service, notionClient } = makeService();

    await service.logTerminalEvent({
      workflow: 'Date Cascade',
      status: 'no_action',
      summary: 'No action: frozen status',
      details: {},
    });
    await service.logTerminalEvent({
      workflow: 'Date Cascade',
      status: 'failed',
      summary: 'Cascade failed: unresolved residue',
      details: {},
    });

    const first = notionClient.request.mock.calls[0][2].properties.Status.select.name;
    const second = notionClient.request.mock.calls[1][2].properties.Status.select.name;
    expect(first).toBe('No Action');
    expect(second).toBe('Failed');
  });

  it('returns a non-throwing disabled result when db id is missing', async () => {
    const notionClient = { request: vi.fn() };
    const service = new ActivityLogService({ notionClient, activityLogDbId: null });
    const result = await service.logTerminalEvent({ workflow: 'Date Cascade', status: 'success', summary: 'ok' });

    expect(result.logged).toBe(false);
    expect(result.reason).toBe('activity-log-db-not-configured');
    expect(notionClient.request).not.toHaveBeenCalled();
  });

  it('retries without Tested by when Notion rejects bot mentions', async () => {
    const notionClient = {
      request: vi.fn()
        .mockRejectedValueOnce(new Error('Cannot mention bots. Mentioned bot id: abc'))
        .mockResolvedValueOnce({ id: 'page-fallback' }),
    };
    const service = new ActivityLogService({
      notionClient,
      activityLogDbId: 'db-activity',
      logger: { warn: vi.fn() },
    });

    const result = await service.logTerminalEvent({
      workflow: 'Date Cascade',
      status: 'success',
      summary: 'ok',
      triggeredByUserId: '33423867-60c2-818e-99ce-00271a790f0a',
      details: {},
    });

    expect(result.logged).toBe(true);
    expect(result.warning).toBe('tested-by-omitted');
    expect(notionClient.request).toHaveBeenCalledTimes(2);
    const secondPayload = notionClient.request.mock.calls[1][2];
    expect(secondPayload.properties['Tested by']).toBeUndefined();
  });
});
