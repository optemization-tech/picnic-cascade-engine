function truncate(text, max = 2000) {
  if (!text) return '';
  const normalized = String(text);
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function richText(content) {
  return [{ type: 'text', text: { content: truncate(content) } }];
}

function toTitle(workflow, sourceTaskName) {
  const base = `${workflow || 'Workflow'} — ${sourceTaskName || 'N/A'}`;
  return truncate(base, 100);
}

function toStatusName(status) {
  if (status === 'failed') return 'Failed';
  if (status === 'no_action') return 'No Action';
  return 'Success';
}

function isPeoplePropertyError(message = '') {
  const lower = String(message).toLowerCase();
  return lower.includes('tested by') || lower.includes('people[0].id') || lower.includes('cannot mention bots');
}

function detailLines(details = {}) {
  const movement = details.movement || {};
  const sourceDates = details.sourceDates || {};
  const crossChain = details.crossChain || {};
  const error = details.error || {};

  const lines = [];
  if (typeof movement.updatedCount === 'number') {
    lines.push(`Updated tasks: ${movement.updatedCount}`);
  }
  if (typeof crossChain.residueCount === 'number') {
    lines.push(`Unresolved residue count: ${crossChain.residueCount}`);
  }
  if (crossChain.capHit === true) {
    lines.push('Cross-chain cap hit: true');
  }
  if (sourceDates.originalStart || sourceDates.originalEnd) {
    lines.push(`Original source dates: ${sourceDates.originalStart || 'n/a'} -> ${sourceDates.originalEnd || 'n/a'}`);
  }
  if (sourceDates.modifiedStart || sourceDates.modifiedEnd) {
    lines.push(`Modified source dates: ${sourceDates.modifiedStart || 'n/a'} -> ${sourceDates.modifiedEnd || 'n/a'}`);
  }
  if (error.errorMessage) {
    lines.push(`Error: ${error.errorMessage}`);
  }
  return lines;
}

function buildChildren(event) {
  const lines = detailLines(event.details);
  const rawDetails = JSON.stringify(event.details || {}, null, 2);

  const children = [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: richText('Outcome') },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText(event.summary || 'No summary') },
    },
  ];

  for (const line of lines) {
    children.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(line) },
    });
  }

  children.push({
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: richText('Details') },
  });
  children.push({
    object: 'block',
    type: 'code',
    code: {
      language: 'json',
      rich_text: richText(truncate(rawDetails, 1800)),
    },
  });
  return children;
}

export class ActivityLogService {
  constructor({ notionClient, activityLogDbId, logger = console }) {
    this.notionClient = notionClient;
    this.activityLogDbId = activityLogDbId;
    this.logger = logger;
  }

  async logTerminalEvent(event) {
    if (!this.activityLogDbId) return { logged: false, reason: 'activity-log-db-not-configured' };

    const statusName = toStatusName(event.status);
    const nowIso = new Date().toISOString();

    const sourceDates = event.details?.sourceDates || {};
    const originalDateStart = sourceDates.originalStart || sourceDates.originalEnd || null;
    const modifiedDateStart = sourceDates.modifiedStart || sourceDates.modifiedEnd || null;

    const properties = {
      Entry: { title: richText(toTitle(event.workflow, event.sourceTaskName)) },
      Summary: { rich_text: richText(event.summary || 'No summary') },
      Details: { rich_text: richText('See page body for diagnostics.') },
      Status: { select: { name: statusName } },
      Workflow: { select: { name: truncate(event.workflow || 'Unknown', 100) } },
      'Trigger Type': { select: { name: truncate(event.triggerType || 'Unknown', 100) } },
      'Cascade Mode': { select: { name: truncate(event.cascadeMode || 'N/A', 100) } },
      'Execution ID': { rich_text: richText(event.executionId || 'N/A') },
      Timestamp: { date: { start: event.timestamp || nowIso } },
      'Tested at': { date: { start: nowIso } },
    };

    if (event.sourceTaskId) properties['Study Tasks'] = { relation: [{ id: event.sourceTaskId }] };
    if (event.studyId) properties.Study = { relation: [{ id: event.studyId }] };
    if (event.triggeredByUserId) properties['Tested by'] = { people: [{ id: event.triggeredByUserId }] };
    if (originalDateStart) properties['Original Dates'] = { date: { start: originalDateStart } };
    if (modifiedDateStart) properties['Modified Dates'] = { date: { start: modifiedDateStart } };

    const payload = {
      parent: { database_id: this.activityLogDbId },
      properties,
      children: buildChildren(event),
    };

    try {
      const response = await this.notionClient.request('POST', '/pages', payload);
      return { logged: true, pageId: response?.id || null };
    } catch (error) {
      if (properties['Tested by'] && isPeoplePropertyError(error?.message)) {
        try {
          const fallbackProperties = { ...properties };
          delete fallbackProperties['Tested by'];
          const response = await this.notionClient.request('POST', '/pages', {
            ...payload,
            properties: fallbackProperties,
          });
          return { logged: true, pageId: response?.id || null, warning: 'tested-by-omitted' };
        } catch (fallbackError) {
          this.logger.warn('[activity-log] failed to create entry:', fallbackError.message);
          return { logged: false, reason: 'notion-write-failed', error: fallbackError.message };
        }
      }

      this.logger.warn('[activity-log] failed to create entry:', error.message);
      return { logged: false, reason: 'notion-write-failed', error: error.message };
    }
  }
}
