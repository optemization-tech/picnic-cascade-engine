// Formats and posts Notion page comments on study pages after automations.
// Mirrors ActivityLogService pattern: constructor injection, try/catch, { posted, reason } return.

function statusLabel(status) {
  if (status === 'failed') return 'Failed';
  if (status === 'no_action') return 'No Action';
  return 'Success';
}

function buildRichText(event) {
  const label = statusLabel(event.status);
  const text = `${event.workflow} — ${event.sourceTaskName || 'Unknown'}: ${label}. ${event.summary || ''}`.trim();

  const richText = [];

  // @-mention the triggering user if they're a real person (not a bot, not absent)
  if (event.triggeredByUserId && !event.editedByBot) {
    richText.push({
      type: 'mention',
      mention: { type: 'user', user: { id: event.triggeredByUserId } },
    });
    richText.push({ type: 'text', text: { content: `: ${text}` } });
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

    // Silent skip for no_action unless the caller explicitly forces (undo-cascade exception)
    if (event.status === 'no_action' && !event.forceComment) {
      return { posted: false, reason: 'no-action-silent' };
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
