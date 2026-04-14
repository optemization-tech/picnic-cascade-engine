import { describe, it, expect, vi } from 'vitest';
import { StudyCommentService } from '../../src/services/study-comment.js';

function makeService() {
  const notionClient = { request: vi.fn().mockResolvedValue({}) };
  const logger = { warn: vi.fn() };
  const service = new StudyCommentService({ notionClient, logger });
  return { service, notionClient, logger };
}

function baseEvent(overrides = {}) {
  return {
    workflow: 'Date Cascade',
    status: 'success',
    studyId: 'study-1',
    sourceTaskName: 'Task One',
    triggeredByUserId: 'user-1',
    editedByBot: false,
    summary: 'Task One updated — 4 dependent task(s) rescheduled',
    ...overrides,
  };
}

describe('StudyCommentService', () => {
  it('posts comment with @-mention for real person user', async () => {
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent());

    expect(result).toEqual({ posted: true });
    expect(notionClient.request).toHaveBeenCalledTimes(1);
    expect(notionClient.request).toHaveBeenCalledWith('POST', '/comments', {
      parent: { page_id: 'study-1' },
      rich_text: [
        { type: 'mention', mention: { type: 'user', user: { id: 'user-1' } } },
        { type: 'text', text: { content: ': ✅ Task One updated — 4 dependent task(s) rescheduled' } },
      ],
    });
  });

  it('posts comment without mention when triggeredByUserId is absent', async () => {
    const { service, notionClient } = makeService();

    await service.postComment(baseEvent({ triggeredByUserId: null }));

    const payload = notionClient.request.mock.calls[0][2];
    expect(payload.rich_text).toEqual([
      { type: 'text', text: { content: '✅ Task One updated — 4 dependent task(s) rescheduled' } },
    ]);
  });

  it('posts comment without mention when user is a bot', async () => {
    const { service, notionClient } = makeService();

    await service.postComment(baseEvent({ editedByBot: true }));

    const payload = notionClient.request.mock.calls[0][2];
    // No mention element — text starts directly
    expect(payload.rich_text).toHaveLength(1);
    expect(payload.rich_text[0].type).toBe('text');
  });

  it('posts comment with failure emoji for failed status', async () => {
    const { service, notionClient } = makeService();

    await service.postComment(baseEvent({
      status: 'failed',
      summary: 'Date cascade failed: timeout',
    }));

    const payload = notionClient.request.mock.calls[0][2];
    const textContent = payload.rich_text.find((r) => r.type === 'text').text.content;
    expect(textContent).toContain('❌');
    expect(textContent).toContain('Date cascade failed: timeout');
  });

  it('skips when studyId is null', async () => {
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent({ studyId: null }));

    expect(result).toEqual({ posted: false, reason: 'no-study-id' });
    expect(notionClient.request).not.toHaveBeenCalled();
  });

  it('silently skips no_action status without forceComment', async () => {
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent({ status: 'no_action' }));

    expect(result).toEqual({ posted: false, reason: 'no-action-silent' });
    expect(notionClient.request).not.toHaveBeenCalled();
  });

  it('posts comment for no_action when forceComment is true (undo exception)', async () => {
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent({
      status: 'no_action',
      forceComment: true,
      summary: 'No recent cascade to undo',
    }));

    expect(result).toEqual({ posted: true });
    expect(notionClient.request).toHaveBeenCalledTimes(1);
    const payload = notionClient.request.mock.calls[0][2];
    const textContent = payload.rich_text.find((r) => r.type === 'text').text.content;
    expect(textContent).toContain('ℹ️');
    expect(textContent).toContain('No recent cascade to undo');
  });

  it('catches Notion API errors and returns failure without throwing', async () => {
    const { service, notionClient, logger } = makeService();
    notionClient.request.mockRejectedValue(new Error('429 rate limited'));

    const result = await service.postComment(baseEvent());

    expect(result).toEqual({
      posted: false,
      reason: 'notion-api-error',
      error: '429 rate limited',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[study-comment] failed to post comment:',
      '429 rate limited',
    );
  });

  it('builds correct rich_text structure matching Notion Comments API spec', async () => {
    const { service, notionClient } = makeService();

    await service.postComment(baseEvent());

    const payload = notionClient.request.mock.calls[0][2];
    // Verify parent uses page_id (not database_id)
    expect(payload.parent).toEqual({ page_id: 'study-1' });
    // Verify mention object shape
    const mention = payload.rich_text[0];
    expect(mention.type).toBe('mention');
    expect(mention.mention.type).toBe('user');
    expect(mention.mention.user.id).toBe('user-1');
    // Verify text element follows mention
    const text = payload.rich_text[1];
    expect(text.type).toBe('text');
    expect(text.text.content).toMatch(/^: /);
  });

  it('falls back to summary when sourceTaskName is missing', async () => {
    const { service, notionClient } = makeService();

    await service.postComment(baseEvent({ sourceTaskName: null }));

    const payload = notionClient.request.mock.calls[0][2];
    const textContent = payload.rich_text.find((r) => r.type === 'text').text.content;
    // Summary is used directly — no "Unknown" fallback needed since format no longer includes task name
    expect(textContent).toContain('Task One updated');
  });
});
