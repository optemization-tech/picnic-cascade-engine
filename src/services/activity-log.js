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

  const timing = details.timing;
  if (timing && typeof timing.totalMs === 'number') {
    lines.push(`Total duration: ${timing.totalMs}ms`);
    if (timing.phases) {
      const p = timing.phases;
      const parts = [];
      if (p.query != null) parts.push(`Query: ${p.query}ms`);
      if (p.patchUpdates != null) parts.push(`Patch: ${p.patchUpdates}ms`);
      if (p.patchUnlock != null) parts.push(`Unlock: ${p.patchUnlock}ms`);
      if (p.cleanup != null) parts.push(`Cleanup: ${p.cleanup}ms`);
      if (parts.length > 0) lines.push(parts.join(' | '));
    }
  }

  const retryStats = details.retryStats;
  if (retryStats && retryStats.count > 0) {
    lines.push(`API retries: ${retryStats.count} (${retryStats.totalBackoffMs}ms total backoff)`);
  }

  if (typeof details.narrowRetrySuppressed === 'number' && details.narrowRetrySuppressed > 0) {
    lines.push(`Narrow retry suppressed: ${details.narrowRetrySuppressed} (non-idempotent write surfaced on unsafe error)`);
  }

  return lines;
}

function buildChildren(event) {
  const lines = detailLines(event.details);
  // Strip movedTaskIds from the JSON block — it's an array of UUIDs that
  // can easily exceed the 2000-char Notion limit and push timing/retry
  // data off the end. The update count is still in the bullet points.
  const detailsForJson = { ...(event.details || {}) };
  if (detailsForJson.movement) {
    detailsForJson.movement = { ...detailsForJson.movement, movedTaskIds: `[${detailsForJson.movement.movedTaskIds?.length || 0} tasks]` };
  }
  const rawDetails = JSON.stringify(detailsForJson, null, 2);

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

    const properties = {
      Entry: { title: richText(toTitle(event.workflow, event.sourceTaskName)) },
      Summary: { rich_text: richText(event.summary || 'No summary') },
      Details: { rich_text: richText('See page body for diagnostics.') },
      Status: { select: { name: statusName } },
      Workflow: { select: { name: truncate(event.workflow || 'Unknown', 100) } },
      'Trigger Type': { select: { name: truncate(event.triggerType || 'Unknown', 100) } },
      'Cascade Mode': { select: { name: truncate(event.cascadeMode || 'N/A', 100) } },
      'Execution ID': { rich_text: richText(event.executionId || 'N/A') },
    };

    if (event.sourceTaskId) properties['Study Tasks'] = { relation: [{ id: event.sourceTaskId }] };
    if (event.studyId) properties.Study = { relation: [{ id: event.studyId }] };
    // 'Tested by' — only set for real person IDs. Bot/integration user IDs
    // cause Notion 400 errors (wasting ~8s in retries with exponential backoff).
    if (event.triggeredByUserId && !event.editedByBot) {
      properties['Tested by'] = { people: [{ id: event.triggeredByUserId }] };
    }
    const totalMs = event.details?.timing?.totalMs;
    if (typeof totalMs === 'number') properties['Duration (ms)'] = { number: totalMs };
    if (sourceDates.originalStart || sourceDates.originalEnd) {
      properties['Original Dates'] = { date: { start: sourceDates.originalStart || sourceDates.originalEnd, end: sourceDates.originalEnd || null } };
    }
    if (sourceDates.modifiedStart || sourceDates.modifiedEnd) {
      properties['Modified Dates'] = { date: { start: sourceDates.modifiedStart || sourceDates.modifiedEnd, end: sourceDates.modifiedEnd || null } };
    }

    const payload = {
      parent: { database_id: this.activityLogDbId },
      properties,
      children: buildChildren(event),
    };

    try {
      const response = await this.notionClient.request('POST', '/pages', payload);
      return { logged: true, pageId: response?.id || null };
    } catch (error) {
      this.logger.warn('[activity-log] failed to create entry:', error.message);
      return { logged: false, reason: 'notion-write-failed', error: error.message };
    }
  }
}
