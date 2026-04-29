import { describe, it, expect, vi } from 'vitest';
import { ActivityLogService } from '../../src/services/activity-log.js';
import { ACTIVITY_LOG_PROPS as AL } from '../../src/notion/property-names.js';

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
        [AL.SUMMARY.id]: {
          rich_text: [{ type: 'text', text: { content: 'pull-left: Task One (4 updates)' } }],
        },
        [AL.STATUS.id]: { select: { name: 'Success' } },
        [AL.WORKFLOW.id]: { select: { name: 'Date Cascade' } },
        [AL.TRIGGER_TYPE.id]: { select: { name: 'Automation' } },
        [AL.CASCADE_MODE.id]: { select: { name: 'pull-left' } },
        [AL.EXECUTION_ID.id]: { rich_text: [{ type: 'text', text: { content: 'exec-1' } }] },
        [AL.STUDY.id]: { relation: [{ id: 'study-1' }] },
        [AL.STUDY_TASKS.id]: { relation: [{ id: 'task-1' }] },
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

    const first = notionClient.request.mock.calls[0][2].properties[AL.STATUS.id].select.name;
    const second = notionClient.request.mock.calls[1][2].properties[AL.STATUS.id].select.name;
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

  it('sets Tested by for real person user IDs', async () => {
    const { service, notionClient } = makeService();

    await service.logTerminalEvent({
      workflow: 'Date Cascade',
      status: 'success',
      summary: 'ok',
      triggeredByUserId: 'person-user-id',
      editedByBot: false,
      details: {},
    });

    expect(notionClient.request).toHaveBeenCalledTimes(1);
    const payload = notionClient.request.mock.calls[0][2];
    expect(payload.properties[AL.TESTED_BY.id]).toEqual({
      people: [{ id: 'person-user-id' }],
    });
  });

  it('omits Tested by for bot/integration user IDs', async () => {
    const { service, notionClient } = makeService();

    await service.logTerminalEvent({
      workflow: 'Date Cascade',
      status: 'success',
      summary: 'ok',
      triggeredByUserId: 'bot-integration-id',
      editedByBot: true,
      details: {},
    });

    expect(notionClient.request).toHaveBeenCalledTimes(1);
    const payload = notionClient.request.mock.calls[0][2];
    expect(payload.properties[AL.TESTED_BY.id]).toBeUndefined();
  });

  it('omits Tested by when triggeredByUserId is absent', async () => {
    const { service, notionClient } = makeService();

    await service.logTerminalEvent({
      workflow: 'Date Cascade',
      status: 'success',
      summary: 'ok',
      details: {},
    });

    expect(notionClient.request).toHaveBeenCalledTimes(1);
    const payload = notionClient.request.mock.calls[0][2];
    expect(payload.properties[AL.TESTED_BY.id]).toBeUndefined();
  });

  it('renders narrowRetrySuppressed line in body when present', async () => {
    const { service, notionClient } = makeService();

    await service.logTerminalEvent({
      workflow: 'Provisioning',
      status: 'failed',
      summary: 'createPages partial failure',
      details: {
        narrowRetrySuppressed: 3,
        retryStats: { count: 1, totalBackoffMs: 500 },
      },
    });

    const payload = notionClient.request.mock.calls[0][2];
    const children = payload.children || [];
    const bodyText = JSON.stringify(children);
    expect(bodyText).toContain('Narrow retry suppressed: 3');
  });

  it('omits narrowRetrySuppressed line when zero or missing', async () => {
    const { service, notionClient } = makeService();

    await service.logTerminalEvent({
      workflow: 'Provisioning',
      status: 'success',
      summary: 'clean run',
      details: { narrowRetrySuppressed: 0 },
    });

    const payload = notionClient.request.mock.calls[0][2];
    const children = payload.children || [];
    const bodyText = JSON.stringify(children);
    expect(bodyText).not.toContain('Narrow retry suppressed');
  });

  // Regression lock — narrow retry for non-idempotent writes (PR E1) surfaces
  // post-send 5xx errors from POST /pages instead of retrying. The activity
  // log is a graceful-degradation caller: it must catch the error and return
  // { logged: false, reason: 'notion-write-failed', ... } rather than
  // propagating. This test fails fast if a future refactor removes the
  // try/catch wrapper in logTerminalEvent.
  it('degrades gracefully when notionClient throws a post-send 5xx (narrow retry surface)', async () => {
    const notionClient = {
      request: vi.fn().mockRejectedValue(
        Object.assign(new Error('Notion API 502 Bad Gateway: upstream failed'), {
          status: 502,
        }),
      ),
    };
    const logger = { warn: vi.fn() };
    const service = new ActivityLogService({
      notionClient,
      activityLogDbId: 'db-activity',
      logger,
    });

    const result = await service.logTerminalEvent({
      workflow: 'Date Cascade',
      status: 'success',
      summary: 'ok despite log failure',
      details: {},
    });

    expect(result).toEqual({
      logged: false,
      reason: 'notion-write-failed',
      error: 'Notion API 502 Bad Gateway: upstream failed',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[activity-log] failed to create entry:',
      'Notion API 502 Bad Gateway: upstream failed',
    );
    expect(notionClient.request).toHaveBeenCalledTimes(1);
  });
});
