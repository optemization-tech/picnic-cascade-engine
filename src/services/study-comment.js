// Formats and posts Notion page comments on study pages after automations.
// Mirrors ActivityLogService pattern: constructor injection, try/catch, { posted, reason } return.
// Comments are posted ONLY for errors (status === 'failed').

import { config } from '../config.js';

function buildRichText(event) {
  const text = `❌ ${event.summary || event.workflow || 'Automation complete'}`;

  const richText = [];
  const mentionIds = config.comment.errorMentionIds;

  if (mentionIds.length > 0) {
    for (const id of mentionIds) {
      richText.push({
        type: 'mention',
        mention: { type: 'user', user: { id } },
      });
      richText.push({ type: 'text', text: { content: ' ' } });
    }
    richText.push({ type: 'text', text: { content: text } });
  } else {
    richText.push({ type: 'text', text: { content: text } });
  }

  return richText;
}

export class StudyCommentService {
  constructor({ notionClient, logger = console }) {
    this.notionClient = notionClient;
    this.logger = logger;
  }

  async postComment(event) {
    if (!event.studyId) {
      return { posted: false, reason: 'no-study-id' };
    }

    if (event.status !== 'failed') {
      return { posted: false, reason: 'not-error' };
    }

    try {
      const richText = buildRichText(event);
      await this.notionClient.request('POST', '/comments', {
        parent: { page_id: event.studyId },
        rich_text: richText,
      });
      return { posted: true };
    } catch (error) {
      const msg = error?.message ?? String(error);
      this.logger.warn('[study-comment] failed to post comment:', msg);
      return { posted: false, reason: 'notion-api-error', error: msg };
    }
  }
}
