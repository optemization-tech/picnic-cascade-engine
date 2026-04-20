import { buildReportingText } from '../utils/reporting.js';
import { classifyIdempotency } from './idempotency-classifier.js';
import { classifyNotionError } from './error-classifier.js';

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
    const MAX_ITERATIONS = 100;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
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
    // Safety valve — allow request through rather than blocking forever, but record usage
    const now = Date.now();
    const usage = this.tokenUsage.get(slotKey) || [];
    usage.push(now);
    this.tokenUsage.set(slotKey, usage);
    console.warn(`[_throttleSlot] hit ${MAX_ITERATIONS} iterations for ${slotKey}, allowing request through`);
  }

  async _requestWithSlot(slot, method, path, body, { tracer } = {}) {
    const maxAttempts = this.retry.maxAttempts || 5;
    const baseMs = this.retry.baseMs || 500;
    const idempotency = classifyIdempotency(method, path);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const tokenIndex = slot.index;
      await this._throttleSlot(slot.key);

      let retryAfterMs = null;

      try {
        const response = await fetch(`${NOTION_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${slot.token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });

        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (response.ok) return data;

        const retryAfterHeader = response.headers.get('retry-after');
        retryAfterMs = retryAfterHeader ? Number.parseFloat(retryAfterHeader) * 1000 : null;

        const error = new Error(`Notion API ${response.status} ${response.statusText}: ${data?.message || text || 'unknown error'}`);
        error.status = response.status;
        error.data = data;
        throw error;
      } catch (err) {
        lastError = err;
        const errClass = classifyNotionError(err);

        // non_retryable — 4xx except 429. Surface immediately regardless
        // of idempotency. Matches prior behavior.
        if (errClass === 'non_retryable') break;

        // unsafe_retry — 5xx, post-send timeouts, unknown shapes. For
        // non-idempotent paths (POST /pages, PATCH /blocks/:id/children)
        // surface immediately to avoid creating duplicates. For idempotent
        // paths preserve prior behavior: retry with the PR #43 2-attempt
        // cap on TimeoutError/AbortError.
        if (errClass === 'unsafe_retry') {
          if (idempotency === 'nonIdempotent') {
            if (tracer) tracer.recordNarrowRetrySuppressed();
            console.log(JSON.stringify({
              event: 'notion_narrow_retry_suppressed',
              attempt,
              method,
              path,
              status: err.status || 0,
              errorName: err.name || null,
              tokenIndex,
            }));
            break;
          }
          // idempotent + unsafe_retry: preserve the 2-attempt timeout cap
          // from PR #43 (30s × 5 = 150s was user-hostile).
          if ((err.name === 'TimeoutError' || err.name === 'AbortError') && attempt >= 2) break;
        }

        // safe_retry (429, ECONNREFUSED/ENOTFOUND/ETIMEDOUT) and
        // idempotent + unsafe_retry both fall through here.
        if (attempt === maxAttempts) break;

        const jitter = Math.floor(Math.random() * 100);
        const backoff = retryAfterMs ?? (baseMs * (2 ** (attempt - 1)) + jitter);
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
    let aborted = false;

    const worker = async (slot) => {
      for (;;) {
        // Stop scheduling new items after any worker has thrown. In-flight
        // items continue to run — they have their own fate. This is the
        // R1-7 batch semantics: abort-on-first-unsafe, let in-flight
        // complete, return per-operation outcomes.
        if (aborted) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          results[index] = await processItem(items[index], slot, index);
        } catch (err) {
          results[index] = err;
          aborted = true;
          return;
        }
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
    const results = await this.runParallel(
      operations,
      async (operation, slot) => this._requestWithSlot(slot, operation.method, operation.path, operation.body, {
        tracer: operation.tracer ?? tracer,
      }),
      { workersPerToken, maxWorkers },
    );

    // Full-batch failure: every slot is either undefined (never picked up
    // after abort) or an Error. Throw the first real error so callers that
    // treat the entire batch as atomic (today's behavior) keep working.
    const errors = results.filter((r) => r instanceof Error);
    const successes = results.filter((r) => r !== undefined && !(r instanceof Error));
    if (successes.length === 0 && errors.length > 0) {
      throw errors[0];
    }

    // Partial success: return the array as-is. Callers inspect each slot
    // and decide what to do. See R1-7 / Unit 4 in
    // docs/plans/2026-04-20-002-refactor-narrow-retry-non-idempotent-writes-plan.md
    return results;
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
          if (cursor && err.message?.includes('start_cursor')) {
            if (attempt < maxRetries) {
              console.warn(`[queryDatabase] cursor invalidated after ${results.length} results (attempt ${attempt + 1}/${maxRetries + 1}), retrying from scratch`);
            }
            cursorFailed = true;
            break;
          }
          throw err;
        }
      }

      if (!cursorFailed) return results;
    }
    // All cursor retries exhausted — throw rather than returning [] which callers
    // would misinterpret as "no tasks exist" (enables double-inception, phantom cascades)
    throw new Error(`[queryDatabase] all ${maxRetries + 1} cursor retry attempts exhausted for db ${dbId}`);
  }

  /**
   * updates: [{ taskId, properties }]
   */
  async patchPages(updates, { tracer, workersPerToken } = {}) {
    if (!Array.isArray(updates) || updates.length === 0) {
      return { updatedCount: 0, taskIds: [] };
    }

    const results = await this.requestBatch(
      updates.map((update) => ({
        method: 'PATCH',
        path: `/pages/${update.taskId}`,
        body: { properties: update.properties },
      })),
      { tracer, workersPerToken },
    );

    // PATCH /pages/:id is idempotent — errors only happen after the retry
    // loop exhausts. Preserve today's fail-loudly semantics for this
    // caller: if any slot errored, throw so the route handler surfaces it.
    // Unlike createPages, partial success here isn't useful (the remaining
    // updates are desired invariants, not a creation log).
    const firstError = results.find((r) => r instanceof Error);
    if (firstError) throw firstError;

    return { updatedCount: updates.length, taskIds: updates.map((update) => update.taskId) };
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
