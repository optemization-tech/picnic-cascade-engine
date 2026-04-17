// Formats and posts Notion page comments on study pages after automations.
// Mirrors ActivityLogService pattern: constructor injection, try/catch, { posted, reason } return.
// Comments are posted ONLY for errors (status === 'failed').

import { config } from '../config.js';

function buildRichText(event) {
  const text = `❌ ${event.summary || event.workflow || 'Automation complete'}`;

  // Build the mention list:
  //   1. Prepend `triggeredByUserId` (button presser) when present AND not a bot.
  //   2. Append configured `errorMentionIds` (Tem/Meg/Seb, typically).
  //   3. Dedup the combined list so a presser who is also configured is only
  //      mentioned once. Dedup also tolerates malformed env vars with duplicate
  //      IDs.
  //   4. Filter falsy entries defensively.
  const rawIds = [];
  if (event.triggeredByUserId && !event.editedByBot) {
    rawIds.push(event.triggeredByUserId);
  }
  rawIds.push(...config.comment.errorMentionIds);

  const uniqueIds = [];
  const seen = new Set();
  for (const id of rawIds) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }

  const richText = [];
  if (uniqueIds.length > 0) {
    for (const id of uniqueIds) {
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
