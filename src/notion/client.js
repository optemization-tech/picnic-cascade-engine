import { buildReportingText } from '../utils/reporting.js';

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DEFAULT_WORKERS_PER_TOKEN = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NotionClient {
  constructor({ tokens, rateLimit = { maxPerSecond: 9 }, retry = { maxAttempts: 5, baseMs: 500 } }) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      throw new Error('NotionClient requires at least one token');
    }
    this.tokens = tokens;
    this.slots = tokens.map((token, index) => ({
      token,
      key: `token_${index + 1}`,
      index,
    }));
    this.slotIndex = 0;
    this.rateLimit = rateLimit;
    this.retry = retry;
    this.tokenUsage = new Map(this.slots.map((slot) => [slot.key, []]));
    this.workersPerToken = Math.max(1, Math.min(
      DEFAULT_WORKERS_PER_TOKEN,
      this.rateLimit.maxPerSecond || DEFAULT_WORKERS_PER_TOKEN,
    ));
    // Optimal batch size: all tokens firing at max rate per second
    this.optimalBatchSize = tokens.length * (rateLimit.maxPerSecond || 9);
  }

  _nextSlot() {
    const slot = this.slots[this.slotIndex % this.slots.length];
    this.slotIndex = (this.slotIndex + 1) % this.slots.length;
    return slot;
  }

  async _throttleSlot(slotKey) {
    const maxPerSecond = this.rateLimit.maxPerSecond || 9;
    for (;;) {
      const now = Date.now();
      const windowStart = now - 1000;
      const usage = (this.tokenUsage.get(slotKey) || []).filter((ts) => ts > windowStart);

      if (usage.length < maxPerSecond) {
        usage.push(now);
        this.tokenUsage.set(slotKey, usage);
        return;
      }

      const waitMs = 1000 - (now - usage[0]) + 5;
      await sleep(Math.max(1, waitMs));
    }
  }

  async _requestWithSlot(slot, method, path, body, { tracer } = {}) {
    const maxAttempts = this.retry.maxAttempts || 5;
    const baseMs = this.retry.baseMs || 500;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const tokenIndex = slot.index;
      await this._throttleSlot(slot.key);

      try {
        const response = await fetch(`${NOTION_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${slot.token}`,
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

  async request(method, path, body, { tracer } = {}) {
    return this._requestWithSlot(this._nextSlot(), method, path, body, { tracer });
  }

  async runParallel(items, processItem, { workersPerToken = this.workersPerToken, maxWorkers } = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const results = new Array(items.length);
    let nextIndex = 0;

    const worker = async (slot) => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await processItem(items[index], slot, index);
      }
    };

    const workers = [];
    const availableWorkers = this.slots.length * workersPerToken;
    const totalWorkers = Math.max(1, Math.min(maxWorkers ?? availableWorkers, availableWorkers));
    for (let i = 0; i < totalWorkers; i++) {
      workers.push(worker(this.slots[i % this.slots.length]));
    }

    await Promise.all(workers);
    return results;
  }

  async getPage(pageId) {
    return this.request('GET', `/pages/${pageId}`);
  }

  async patchPage(pageId, properties, { tracer } = {}) {
    return this.request('PATCH', `/pages/${pageId}`, { properties }, { tracer });
  }

  async createPages(pageBodies, { tracer, workersPerToken } = {}) {
    return this.requestBatch(
      pageBodies.map((pageBody) => ({ method: 'POST', path: '/pages', body: pageBody })),
      { tracer, workersPerToken },
    );
  }

  async requestBatch(operations, { tracer, workersPerToken, maxWorkers } = {}) {
    return this.runParallel(
      operations,
      async (operation, slot) => this._requestWithSlot(slot, operation.method, operation.path, operation.body, {
        tracer: operation.tracer ?? tracer,
      }),
      { workersPerToken, maxWorkers },
    );
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
  async patchPages(updates, { tracer, workersPerToken } = {}) {
    if (!Array.isArray(updates) || updates.length === 0) {
      return { updatedCount: 0, taskIds: [] };
    }

    await this.requestBatch(
      updates.map((update) => ({
        method: 'PATCH',
        path: `/pages/${update.taskId}`,
        body: { properties: update.properties },
      })),
      { tracer, workersPerToken },
    );

    return { updatedCount: updates.length, taskIds: updates.map((update) => update.taskId) };
  }

  // Backward-compatible alias for routes that still call the old helper name.
  async patchBatch(updates, options = {}) {
    return this.patchPages(updates, options);
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
