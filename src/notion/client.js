import { buildReportingText } from '../utils/reporting.js';

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NotionClient {
  constructor({ tokens, rateLimit = { maxPerSecond: 9 }, retry = { maxAttempts: 5, baseMs: 500 } }) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      throw new Error('NotionClient requires at least one token');
    }
    this.tokens = tokens;
    this.tokenIndex = 0;
    this.rateLimit = rateLimit;
    this.retry = retry;
    this.tokenUsage = new Map(tokens.map((t) => [t, []]));
    // Optimal batch size: all tokens firing at max rate per second
    this.optimalBatchSize = tokens.length * (rateLimit.maxPerSecond || 9);
  }

  _nextToken() {
    const token = this.tokens[this.tokenIndex % this.tokens.length];
    this.tokenIndex = (this.tokenIndex + 1) % this.tokens.length;
    return token;
  }

  async _throttleToken(token) {
    const maxPerSecond = this.rateLimit.maxPerSecond || 9;
    const now = Date.now();
    const windowStart = now - 1000;
    const usage = (this.tokenUsage.get(token) || []).filter((ts) => ts > windowStart);

    if (usage.length >= maxPerSecond) {
      const waitMs = 1000 - (now - usage[0]) + 5;
      if (waitMs > 0) await sleep(waitMs);
    }

    const refreshedNow = Date.now();
    const refreshedWindow = refreshedNow - 1000;
    const updated = (this.tokenUsage.get(token) || []).filter((ts) => ts > refreshedWindow);
    updated.push(refreshedNow);
    this.tokenUsage.set(token, updated);
  }

  async request(method, path, body, { tracer } = {}) {
    const maxAttempts = this.retry.maxAttempts || 5;
    const baseMs = this.retry.baseMs || 500;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const token = this._nextToken();
      const tokenIndex = (this.tokenIndex + this.tokens.length - 1) % this.tokens.length;
      await this._throttleToken(token);

      try {
        const response = await fetch(`${NOTION_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (response.ok) return data;

        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? Number.parseFloat(retryAfterHeader) * 1000 : null;
        const retryable = response.status === 429 || response.status >= 500;

        const error = new Error(`Notion API ${response.status} ${response.statusText}: ${data?.message || text || 'unknown error'}`);
        error.status = response.status;
        error.data = data;
        lastError = error;

        if (!retryable || attempt === maxAttempts) throw error;
        const jitter = Math.floor(Math.random() * 100);
        const backoff = retryAfterMs ?? (baseMs * (2 ** (attempt - 1)) + jitter);
        if (tracer) tracer.recordRetry({ attempt, backoffMs: backoff, status: response.status, tokenIndex });
        console.log(JSON.stringify({ event: 'notion_retry', attempt, backoff, status: response.status, tokenIndex }));
        await sleep(backoff);
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts) break;
        // Don't retry non-retryable HTTP errors (4xx except 429)
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;
        const jitter = Math.floor(Math.random() * 100);
        const backoff = baseMs * (2 ** (attempt - 1)) + jitter;
        if (tracer) tracer.recordRetry({ attempt, backoffMs: backoff, status: err.status || 0, tokenIndex });
        console.log(JSON.stringify({ event: 'notion_retry', attempt, backoff, status: err.status || 0, tokenIndex }));
        await sleep(backoff);
      }
    }

    throw lastError || new Error('Notion request failed');
  }

  async getPage(pageId) {
    return this.request('GET', `/pages/${pageId}`);
  }

  async patchPage(pageId, properties, { tracer } = {}) {
    return this.request('PATCH', `/pages/${pageId}`, { properties }, { tracer });
  }

  async queryDatabase(dbId, filter, pageSize = 100, { tracer } = {}) {
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let hasMore = true;
      let cursor = undefined;
      const results = [];
      let cursorFailed = false;

      while (hasMore) {
        const body = { filter, page_size: pageSize };
        if (cursor) body.start_cursor = cursor;

        try {
          const data = await this.request('POST', `/databases/${dbId}/query`, body, { tracer });
          results.push(...(data.results || []));
          hasMore = Boolean(data.has_more);
          cursor = data.next_cursor || undefined;
        } catch (err) {
          // Notion can invalidate cursors when the dataset changes mid-pagination.
          // Retry the entire query from scratch rather than returning partial results.
          if (cursor && err.message?.includes('start_cursor') && attempt < maxRetries) {
            console.warn(`[queryDatabase] cursor invalidated after ${results.length} results (attempt ${attempt + 1}/${maxRetries + 1}), retrying from scratch`);
            cursorFailed = true;
            break;
          }
          throw err;
        }
      }

      if (!cursorFailed) return results;
    }
  }

  /**
   * updates: [{ taskId, properties }]
   */
  async patchBatch(updates, { batchSize, interval = 1000, tracer } = {}) {
    batchSize = batchSize ?? this.optimalBatchSize;
    const applied = [];
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (u) => {
          const res = await this.patchPage(u.taskId, u.properties, { tracer });
          applied.push(u.taskId);
          return res;
        }),
      );
      if (i + batchSize < updates.length) await sleep(interval);
      void batchResults;
    }
    return { updatedCount: applied.length, taskIds: applied };
  }

  async reportStatus(studyId, level, message, { tracer } = {}) {
    const richText = buildReportingText(level, message);
    return this.request('PATCH', `/pages/${studyId}`, {
      properties: {
        'Automation Reporting': { rich_text: richText },
      },
    }, { tracer });
  }
}
