import { describe, it, expect, vi, afterEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting — safe to reference in factory
const mockConfig = vi.hoisted(() => ({ comment: { errorMentionIds: [] } }));
vi.mock('../../src/config.js', () => ({ config: mockConfig }));

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
    status: 'failed',
    studyId: 'study-1',
    sourceTaskName: 'Task One',
    triggeredByUserId: 'user-1',
    editedByBot: false,
    summary: 'Date cascade failed: timeout',
    ...overrides,
  };
}

describe('StudyCommentService', () => {
  afterEach(() => {
    mockConfig.comment.errorMentionIds = [];
  });

  it('posts comment with 2 mentions when status=failed and 2 IDs configured', async () => {
    mockConfig.comment.errorMentionIds = ['user-a', 'user-b'];
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent());

    expect(result).toEqual({ posted: true });
    expect(notionClient.request).toHaveBeenCalledTimes(1);
    const payload = notionClient.request.mock.calls[0][2];
    expect(payload.parent).toEqual({ page_id: 'study-1' });

    // Should have: mention, space, mention, space, text
    expect(payload.rich_text).toHaveLength(5);
    expect(payload.rich_text[0]).toEqual({
      type: 'mention',
      mention: { type: 'user', user: { id: 'user-a' } },
    });
    expect(payload.rich_text[1]).toEqual({
      type: 'text',
      text: { content: ' ' },
    });
    expect(payload.rich_text[2]).toEqual({
      type: 'mention',
      mention: { type: 'user', user: { id: 'user-b' } },
    });
    expect(payload.rich_text[3]).toEqual({
      type: 'text',
      text: { content: ' ' },
    });
    expect(payload.rich_text[4].type).toBe('text');
    expect(payload.rich_text[4].text.content).toContain('❌');
    expect(payload.rich_text[4].text.content).toContain('Date cascade failed: timeout');
  });

  it('posts plain text (no mentions) when status=failed and 0 IDs configured', async () => {
    mockConfig.comment.errorMentionIds = [];
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent());

    expect(result).toEqual({ posted: true });
    expect(notionClient.request).toHaveBeenCalledTimes(1);
    const payload = notionClient.request.mock.calls[0][2];
    expect(payload.rich_text).toHaveLength(1);
    expect(payload.rich_text[0].type).toBe('text');
    expect(payload.rich_text[0].text.content).toContain('❌');
    expect(payload.rich_text[0].text.content).toContain('Date cascade failed: timeout');
  });

  it('returns not-error for status=success', async () => {
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent({ status: 'success' }));

    expect(result).toEqual({ posted: false, reason: 'not-error' });
    expect(notionClient.request).not.toHaveBeenCalled();
  });

  it('returns not-error for status=no_action even with forceComment', async () => {
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent({
      status: 'no_action',
      forceComment: true,
    }));

    expect(result).toEqual({ posted: false, reason: 'not-error' });
    expect(notionClient.request).not.toHaveBeenCalled();
  });

  it('skips when studyId is null', async () => {
    const { service, notionClient } = makeService();

    const result = await service.postComment(baseEvent({ studyId: null }));

    expect(result).toEqual({ posted: false, reason: 'no-study-id' });
    expect(notionClient.request).not.toHaveBeenCalled();
  });

  it('trims whitespace and filters empty entries from COMMENT_ERROR_MENTION_IDS', async () => {
    // Simulate what config.js produces from ' user-a , , user-b , '
    mockConfig.comment.errorMentionIds = ['user-a', 'user-b'];
    const { service, notionClient } = makeService();

    await service.postComment(baseEvent());

    const payload = notionClient.request.mock.calls[0][2];
    const mentions = payload.rich_text.filter(r => r.type === 'mention');
    expect(mentions).toHaveLength(2);
    expect(mentions[0].mention.user.id).toBe('user-a');
    expect(mentions[1].mention.user.id).toBe('user-b');
  });

  it('still posts and warns when Notion API rejects mention', async () => {
    mockConfig.comment.errorMentionIds = ['bad-user-id'];
    const { service, notionClient, logger } = makeService();
    notionClient.request.mockRejectedValue(new Error('validation_error: user not found'));

    const result = await service.postComment(baseEvent());

    expect(result).toEqual({
      posted: false,
      reason: 'notion-api-error',
      error: 'validation_error: user not found',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[study-comment] failed to post comment:',
      'validation_error: user not found',
    );
  });

  it('falls back to workflow name when summary is missing', async () => {
    const { service, notionClient } = makeService();

    await service.postComment(baseEvent({ summary: null }));

    const payload = notionClient.request.mock.calls[0][2];
    const textContent = payload.rich_text.find(r => r.type === 'text').text.content;
    expect(textContent).toContain('Date Cascade');
  });

  it('falls back to "Automation complete" when both summary and workflow are missing', async () => {
    const { service, notionClient } = makeService();

    await service.postComment(baseEvent({ summary: null, workflow: null }));

    const payload = notionClient.request.mock.calls[0][2];
    const textContent = payload.rich_text.find(r => r.type === 'text').text.content;
    expect(textContent).toContain('Automation complete');
  });
});
