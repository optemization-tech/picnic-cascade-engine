import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockClient: {
    getPage: vi.fn(),
    queryDatabase: vi.fn(),
    patchPage: vi.fn(),
    reportStatus: vi.fn(),
  },
  parseWebhookPayload: vi.fn(),
  isSystemModified: vi.fn(),
  computeStatusRollup: vi.fn(),
  normalizeTask: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    notion: {
      tokens: ['token-1'],
      studyTasksDbId: 'db-study-tasks',
      studiesDbId: 'db-studies',
    },
    activityLogWebhookUrl: null,
  },
}));

vi.mock('../../src/notion/client.js', () => ({
  NotionClient: vi.fn(() => mocks.mockClient),
}));

vi.mock('../../src/gates/guards.js', () => ({
  parseWebhookPayload: mocks.parseWebhookPayload,
  isSystemModified: mocks.isSystemModified,
}));

vi.mock('../../src/engine/status-rollup.js', () => ({
  computeStatusRollup: mocks.computeStatusRollup,
}));

vi.mock('../../src/notion/properties.js', () => ({
  normalizeTask: mocks.normalizeTask,
}));

import { handleStatusRollup } from '../../src/routes/status-rollup.js';

describe('status-rollup route error reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // @behavior BEH-GUARD-IMPORT-MODE
  it('skips rollup side effects when study import mode is enabled', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task One',
      studyId: 'study-1',
    });
    mocks.isSystemModified.mockReturnValue(false);
    mocks.mockClient.getPage
      .mockResolvedValueOnce({
        id: 'task-1',
        properties: {
          'Parent Task': { relation: [{ id: 'parent-1' }] },
          Study: { relation: [{ id: 'study-1' }] },
          'Last Modified By System': { checkbox: false },
          'Task Name': { title: [{ plain_text: 'Task One' }] },
        },
      })
      .mockResolvedValueOnce({
        id: 'study-1',
        properties: { 'Import Mode': { checkbox: true } },
      });
    mocks.normalizeTask.mockReturnValue({
      id: 'task-1',
      name: 'Task One',
      parentId: 'parent-1',
      studyId: 'study-1',
      lastModifiedBySystem: false,
    });

    const req = { body: { data: { id: 'task-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.queryDatabase).not.toHaveBeenCalled();
    expect(mocks.mockClient.patchPage).not.toHaveBeenCalled();
    expect(mocks.mockClient.reportStatus).not.toHaveBeenCalled();
  });

  // @behavior BEH-AUTOMATION-REPORTING
  it('reports to study Automation Reporting when async processing fails', async () => {
    mocks.parseWebhookPayload.mockReturnValue({
      skip: false,
      taskId: 'task-1',
      taskName: 'Task One',
      studyId: 'study-1',
    });
    mocks.isSystemModified.mockReturnValue(false);
    mocks.mockClient.getPage.mockRejectedValue(new Error('status route boom'));
    mocks.mockClient.reportStatus.mockResolvedValue({});
    mocks.computeStatusRollup.mockReturnValue('Done');
    mocks.normalizeTask.mockReturnValue({});

    const req = { body: { data: { id: 'task-1' } } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleStatusRollup(req, res);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.mockClient.reportStatus).toHaveBeenCalledWith(
      'study-1',
      'error',
      expect.stringContaining('Status roll-up failed for Task One'),
    );
  });
});
