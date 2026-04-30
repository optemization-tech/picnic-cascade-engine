import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotionClient } from '../../src/notion/client.js';
import { STUDY_TASKS_PROPS as ST } from '../../src/notion/property-names.js';

describe('NotionClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rotates tokens between requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: '1' }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: '2' }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({ tokens: ['t1', 't2'], rateLimit: { maxPerSecond: 100 } });
    await client.getPage('a');
    await client.getPage('b');

    const firstAuth = fetchMock.mock.calls[0][1].headers.Authorization;
    const secondAuth = fetchMock.mock.calls[1][1].headers.Authorization;
    expect(firstAuth).toBe('Bearer t1');
    expect(secondAuth).toBe('Bearer t2');
  });

  it('retries on 429 then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        text: async () => JSON.stringify({ message: 'rate limited' }),
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: 'ok' }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 2, baseMs: 1 },
    });
    const page = await client.getPage('abc');

    expect(page.id).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('patchPage only sends the properties provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: 'page-1' }),
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 2, baseMs: 1 },
    });
    await client.patchPage('page-1', {
      [ST.STATUS.id]: { status: { name: 'Done' } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      properties: {
        [ST.STATUS.id]: { status: { name: 'Done' } },
      },
    });
  });

  it('createPages preserves input order while distributing work across tokens', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      const templateId = body.properties?.[ST.TEMPLATE_SOURCE_ID.id]?.rich_text?.[0]?.text?.content;
      const delayMs = templateId === 'b' ? 1 : 10;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        ok: true,
        text: async () => JSON.stringify({ id: `page-${templateId}` }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1', 't2'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 2, baseMs: 1 },
    });

    const pages = await client.createPages([
      { properties: { [ST.TEMPLATE_SOURCE_ID.id]: { rich_text: [{ type: 'text', text: { content: 'a' } }] } } },
      { properties: { [ST.TEMPLATE_SOURCE_ID.id]: { rich_text: [{ type: 'text', text: { content: 'b' } }] } } },
    ]);

    expect(pages.map((page) => page.id)).toEqual(['page-a', 'page-b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('patchPages returns task IDs in input order', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: 'ok' }),
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1', 't2'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 2, baseMs: 1 },
    });

    const result = await client.patchPages([
      { taskId: 'task-1', properties: { [ST.STATUS.id]: { status: { name: 'Done' } } } },
      { taskId: 'task-2', properties: { [ST.STATUS.id]: { status: { name: 'In Progress' } } } },
    ]);

    expect(result).toEqual({
      updatedCount: 2,
      taskIds: ['task-1', 'task-2'],
    });
  });

  it('patchPages forwards an `icon` field on the request body when present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: 'ok' }),
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 2, baseMs: 1 },
    });

    await client.patchPages([
      {
        taskId: 'task-iconed',
        properties: { [ST.STATUS.id]: { status: { name: 'Done' } } },
        icon: { type: 'emoji', emoji: '🔶' },
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      properties: { [ST.STATUS.id]: { status: { name: 'Done' } } },
      icon: { type: 'emoji', emoji: '🔶' },
    });
  });

  it('patchPages omits the `icon` key entirely when the update has no icon', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: 'ok' }),
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 2, baseMs: 1 },
    });

    await client.patchPages([
      { taskId: 'task-1', properties: { [ST.STATUS.id]: { status: { name: 'Done' } } } },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      properties: { [ST.STATUS.id]: { status: { name: 'Done' } } },
    });
    expect(Object.prototype.hasOwnProperty.call(body, 'icon')).toBe(false);
  });

  // @behavior BEH-AUTOMATION-REPORTING
  it('reportStatus patches Automation Reporting with formatted rich text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: 'study-1' }),
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 2, baseMs: 1 },
    });
    await client.reportStatus('study-1', 'success', 'Cascade complete');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain('/pages/study-1');
    const body = JSON.parse(call[1].body);
    // reportStatus is the documented D2b carve-out: cross-DB writer keys by name.
    const rich = body.properties['Automation Reporting'].rich_text[0];
    expect(rich.text.content).toContain('❇️');
    expect(rich.text.content).toContain('Cascade complete');
    expect(rich.annotations.color).toBe('green_background');
  });

  it('does not over-retry timeout errors (caps at 2 attempts)', async () => {
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 5, baseMs: 1 },
    });

    await expect(client.getPage('abc')).rejects.toThrow('aborted');
    // Should attempt 1 (original) + 1 (retry) = 2 total, not 5
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not over-retry AbortError (caps at 2 attempts)', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 5, baseMs: 1 },
    });

    await expect(client.getPage('abc')).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('queryDatabase throws on cursor exhaustion instead of returning empty', async () => {
    const fetchMock = vi.fn()
      // First attempt: page 1 succeeds, page 2 cursor fails
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ results: [{ id: '1' }], has_more: true, next_cursor: 'cur1' }),
        status: 200, statusText: 'OK', headers: { get: () => null },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('start_cursor is not valid'), { status: 400 }),
      )
      // Retry 1: page 1 succeeds, page 2 cursor fails again
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ results: [{ id: '1' }], has_more: true, next_cursor: 'cur2' }),
        status: 200, statusText: 'OK', headers: { get: () => null },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('start_cursor is not valid'), { status: 400 }),
      )
      // Retry 2: same failure
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ results: [{ id: '1' }], has_more: true, next_cursor: 'cur3' }),
        status: 200, statusText: 'OK', headers: { get: () => null },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('start_cursor is not valid'), { status: 400 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 100 },
      retry: { maxAttempts: 1, baseMs: 1 },
    });

    await expect(client.queryDatabase('db-1', {})).rejects.toThrow('cursor retry attempts exhausted');
  });

  it('throttle safety valve records usage and allows request through', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: 'ok' }),
      status: 200, statusText: 'OK', headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({
      tokens: ['t1'],
      rateLimit: { maxPerSecond: 1 },
      retry: { maxAttempts: 1, baseMs: 1 },
    });

    // Saturate the rate limit window so _throttleSlot spins
    const usage = [];
    const now = Date.now();
    for (let i = 0; i < 100; i++) usage.push(now);
    client.tokenUsage.set('token_1', usage);

    // Should still complete (safety valve fires) rather than hanging
    const result = await client.getPage('abc');
    expect(result.id).toBe('ok');
  });

  describe('narrow retry for non-idempotent writes', () => {
    /**
     * Minimal tracer stub that records the suppression-counter and retry
     * events so the retry-loop assertions can diff before/after state.
     */
    function makeTracer() {
      return {
        suppressedCalls: 0,
        retries: [],
        recordNarrowRetrySuppressed() {
          this.suppressedCalls += 1;
        },
        recordRetry(entry) {
          this.retries.push(entry);
        },
      };
    }

    function httpError(status, body = {}) {
      return {
        ok: false,
        status,
        statusText: `status-${status}`,
        text: async () => JSON.stringify(body),
        headers: { get: () => null },
      };
    }

    function ok(body) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(body),
        headers: { get: () => null },
      };
    }

    it('nonIdempotent POST /pages surfaces 502 immediately (no retry)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(httpError(502));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 5, baseMs: 1 },
      });

      await expect(
        client.request('POST', '/pages', { parent: {} }, { tracer }),
      ).rejects.toThrow(/502/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tracer.suppressedCalls).toBe(1);
      expect(tracer.retries).toHaveLength(0);
    });

    it('nonIdempotent POST /pages surfaces post-send timeout immediately', async () => {
      const timeoutErr = new Error('timeout');
      timeoutErr.name = 'TimeoutError';
      const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 5, baseMs: 1 },
      });

      await expect(
        client.request('POST', '/pages', { parent: {} }, { tracer }),
      ).rejects.toThrow(/timeout/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tracer.suppressedCalls).toBe(1);
    });

    it('nonIdempotent POST /pages retries on 429 (safe_retry)', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(httpError(429, { message: 'rate limited' }))
        .mockResolvedValueOnce(ok({ id: 'page-1' }));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.request('POST', '/pages', { parent: {} }, { tracer });
      expect(result.id).toBe('page-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tracer.suppressedCalls).toBe(0);
      expect(tracer.retries).toHaveLength(1);
    });

    it('nonIdempotent POST /pages retries on ECONNREFUSED (safe_retry, pre-send)', async () => {
      const err = new Error('connect refused');
      err.code = 'ECONNREFUSED';
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(ok({ id: 'page-1' }));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.request('POST', '/pages', { parent: {} }, { tracer });
      expect(result.id).toBe('page-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tracer.suppressedCalls).toBe(0);
    });

    it('nonIdempotent PATCH /blocks/:id/children surfaces 502 immediately', async () => {
      const fetchMock = vi.fn().mockResolvedValue(httpError(502));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 5, baseMs: 1 },
      });

      await expect(
        client.request('PATCH', '/blocks/abc-123/children', { children: [] }, { tracer }),
      ).rejects.toThrow(/502/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tracer.suppressedCalls).toBe(1);
    });

    it('idempotent PATCH /blocks/:id (no /children suffix) retries on 502 (wide retry preserved)', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(httpError(502))
        .mockResolvedValueOnce(ok({ id: 'block-1' }));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.request('PATCH', '/blocks/abc-123', { paragraph: {} }, { tracer });
      expect(result.id).toBe('block-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tracer.suppressedCalls).toBe(0);
    });

    it('idempotent PATCH /pages/:id retries on 502 (wide retry preserved)', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(httpError(502))
        .mockResolvedValueOnce(ok({ id: 'page-1' }));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.patchPage('page-1', { [ST.STATUS.id]: { status: { name: 'Done' } } }, { tracer });
      expect(result.id).toBe('page-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tracer.suppressedCalls).toBe(0);
      expect(tracer.retries).toHaveLength(1);
    });

    it('idempotent GET retries on 429 (safe_retry, unchanged)', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(httpError(429))
        .mockResolvedValueOnce(ok({ id: 'ok' }));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.getPage('abc');
      // getPage doesn't accept tracer, so spot-check fetchMock calls only
      expect(result.id).toBe('ok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('nonIdempotent POST /pages throws on 400 (non_retryable)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(httpError(400, { message: 'bad request' }));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      await expect(
        client.request('POST', '/pages', { parent: {} }, { tracer }),
      ).rejects.toThrow(/400/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // non_retryable does NOT count as narrow-retry suppression
      expect(tracer.suppressedCalls).toBe(0);
    });

    it('idempotent post-send timeout respects PR #43 2-attempt cap', async () => {
      const timeoutErr = new Error('timeout');
      timeoutErr.name = 'TimeoutError';
      const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 5, baseMs: 1 },
      });

      // patchPage → PATCH /pages/:id (idempotent). Timeout cap still applies.
      await expect(
        client.patchPage('page-1', { [ST.STATUS.id]: { status: { name: 'Done' } } }, { tracer }),
      ).rejects.toThrow(/timeout/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tracer.suppressedCalls).toBe(0);
    });

    it('nonIdempotent unknown error shape surfaces (counter increments)', async () => {
      const weirdErr = new Error('something weird');
      const fetchMock = vi.fn().mockRejectedValue(weirdErr);
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      await expect(
        client.request('POST', '/pages', { parent: {} }, { tracer }),
      ).rejects.toThrow(/something weird/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tracer.suppressedCalls).toBe(1);
    });

    it('idempotent unknown error shape retries (conservative default for unknown)', async () => {
      const weirdErr = new Error('something weird');
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(weirdErr)
        .mockResolvedValueOnce(ok({ id: 'page-1' }));
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.patchPage('page-1', { [ST.STATUS.id]: { status: { name: 'Done' } } }, { tracer });
      expect(result.id).toBe('page-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tracer.suppressedCalls).toBe(0);
    });

    it('_requestWithSlot does not throw when tracer is absent', async () => {
      const fetchMock = vi.fn().mockResolvedValue(httpError(502));
      vi.stubGlobal('fetch', fetchMock);

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      await expect(
        client.request('POST', '/pages', { parent: {} }),
      ).rejects.toThrow(/502/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch abort semantics (Unit 4)', () => {
    function makeTracer() {
      return {
        suppressedCalls: 0,
        retries: [],
        recordNarrowRetrySuppressed() { this.suppressedCalls += 1; },
        recordRetry(entry) { this.retries.push(entry); },
      };
    }

    it('all-success createPages returns page objects in input order', async () => {
      const fetchMock = vi.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        const templateId = body.properties?.[ST.TEMPLATE_SOURCE_ID.id]?.rich_text?.[0]?.text?.content;
        return {
          ok: true,
          status: 200, statusText: 'OK', headers: { get: () => null },
          text: async () => JSON.stringify({ id: `page-${templateId}` }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.createPages([
        { properties: { [ST.TEMPLATE_SOURCE_ID.id]: { rich_text: [{ type: 'text', text: { content: 'a' } }] } } },
        { properties: { [ST.TEMPLATE_SOURCE_ID.id]: { rich_text: [{ type: 'text', text: { content: 'b' } }] } } },
      ], { tracer });

      expect(result.length).toBe(2);
      expect(result[0].id).toBe('page-a');
      expect(result[1].id).toBe('page-b');
      expect(tracer.suppressedCalls).toBe(0);
    });

    it('all-fail createPages throws the first error (preserves prior behavior)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 502, statusText: 'Bad Gateway', headers: { get: () => null },
        text: async () => JSON.stringify({ message: 'bad gateway' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      await expect(client.createPages([
        { properties: {} },
        { properties: {} },
      ], { tracer })).rejects.toThrow(/502/);
    });

    it('partial-fail createPages returns mixed array (errors + pages)', async () => {
      // Two workers run slots 0 and 1 concurrently. Slot 0 is slow-success,
      // slot 1 is fast-fail. Abort fires, slot 2 (queued) never starts.
      let callCount = 0;
      const fetchMock = vi.fn(async () => {
        const myCall = ++callCount;
        if (myCall === 1) {
          // slow success
          await new Promise((r) => setTimeout(r, 30));
          return {
            ok: true,
            status: 200, statusText: 'OK', headers: { get: () => null },
            text: async () => JSON.stringify({ id: 'page-1' }),
          };
        }
        if (myCall === 2) {
          // immediate 502 → suppression → abort
          return {
            ok: false,
            status: 502, statusText: 'Bad Gateway', headers: { get: () => null },
            text: async () => JSON.stringify({ message: 'bad gateway' }),
          };
        }
        return {
          ok: true,
          status: 200, statusText: 'OK', headers: { get: () => null },
          text: async () => JSON.stringify({ id: `page-${myCall}` }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1', 't2'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.createPages([
        { properties: { name: '1' } },
        { properties: { name: '2' } },
        { properties: { name: '3' } },
      ], { tracer, workersPerToken: 1 });

      expect(result.length).toBe(3);
      // Slot 0 is slow-success; slot 1 is the error; slot 2 never started.
      expect(result[0]?.id).toBe('page-1');
      expect(result[1]).toBeInstanceOf(Error);
      expect(result[1].message).toMatch(/502/);
      expect(result[2]).toBeUndefined();
      expect(tracer.suppressedCalls).toBe(1);
    });

    it('non_retryable (400) does not increment narrowRetrySuppressed counter', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400, statusText: 'Bad Request', headers: { get: () => null },
        text: async () => JSON.stringify({ message: 'invalid' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      await expect(client.createPages([
        { properties: {} },
      ], { tracer })).rejects.toThrow(/400/);
      // non_retryable should NOT count as a narrow-retry suppression
      expect(tracer.suppressedCalls).toBe(0);
    });

    it('in-flight workers complete after another worker aborts', async () => {
      let callCount = 0;
      const calls = [];
      const fetchMock = vi.fn(async (url, options) => {
        callCount += 1;
        const myCall = callCount;
        calls.push(myCall);
        // First call: slow, succeeds. Second call: fast, fails.
        // This simulates a scenario where worker 2 throws while worker 1 is in-flight.
        if (myCall === 1) {
          await new Promise((r) => setTimeout(r, 25));
          return {
            ok: true,
            status: 200, statusText: 'OK', headers: { get: () => null },
            text: async () => JSON.stringify({ id: 'page-slow' }),
          };
        }
        // Immediate 502
        return {
          ok: false,
          status: 502, statusText: 'Bad Gateway', headers: { get: () => null },
          text: async () => JSON.stringify({ message: 'bad gateway' }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1', 't2'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.createPages([
        { properties: { name: '1' } },
        { properties: { name: '2' } },
        { properties: { name: '3' } },
      ], { tracer, workersPerToken: 1 });

      expect(result.length).toBe(3);
      // Slot 0 should be the slow success.
      expect(result[0]?.id).toBe('page-slow');
      // Slot 1 should be the error that triggered abort.
      expect(result[1]).toBeInstanceOf(Error);
      // Slot 2 should never have started.
      expect(result[2]).toBeUndefined();
      expect(tracer.suppressedCalls).toBe(1);
    });

    it('requestBatch returns mixed array and does not throw on partial success', async () => {
      // Two workers: slow-success on slot 0, fast-fail on slot 1, slot 2 never starts.
      let callCount = 0;
      const fetchMock = vi.fn(async () => {
        const myCall = ++callCount;
        if (myCall === 1) {
          await new Promise((r) => setTimeout(r, 30));
          return {
            ok: true,
            status: 200, statusText: 'OK', headers: { get: () => null },
            text: async () => JSON.stringify({ id: 'page-1' }),
          };
        }
        return {
          ok: false,
          status: 502, statusText: 'Bad Gateway', headers: { get: () => null },
          text: async () => JSON.stringify({ message: 'bad gateway' }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      const tracer = makeTracer();

      const client = new NotionClient({
        tokens: ['t1', 't2'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 3, baseMs: 1 },
      });

      const result = await client.requestBatch([
        { method: 'POST', path: '/pages', body: {} },
        { method: 'POST', path: '/pages', body: {} },
        { method: 'POST', path: '/pages', body: {} },
      ], { tracer, workersPerToken: 1 });

      expect(result.length).toBe(3);
      expect(result[0]?.id).toBe('page-1');
      expect(result[1]).toBeInstanceOf(Error);
      expect(result[2]).toBeUndefined();
      expect(tracer.suppressedCalls).toBe(1);
    });
  });

  describe('runParallel bubbleErrors option', () => {
    it('default behavior (bubbleErrors=false) traps errors into results array', async () => {
      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 1, baseMs: 1 },
      });

      const boom = new Error('boom');
      const results = await client.runParallel(
        ['a', 'b', 'c'],
        async (item) => {
          if (item === 'b') throw boom;
          return `ok-${item}`;
        },
        { workersPerToken: 1, maxWorkers: 1 },
      );

      // Default trap-into-results behavior: results array holds a mix of
      // success values and the Error object, and runParallel resolves
      // normally (does not throw).
      expect(results.length).toBe(3);
      expect(results[0]).toBe('ok-a');
      expect(results[1]).toBe(boom);
      // Slot 2 never runs after abort.
      expect(results[2]).toBeUndefined();
    });

    it('bubbleErrors=true rethrows the first inner error (restores throw-propagation semantics)', async () => {
      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 1, baseMs: 1 },
      });

      const boom = new Error('boom');
      await expect(
        client.runParallel(
          ['a', 'b', 'c'],
          async (item) => {
            if (item === 'b') throw boom;
            return `ok-${item}`;
          },
          { workersPerToken: 1, maxWorkers: 1, bubbleErrors: true },
        ),
      ).rejects.toBe(boom);
    });

    it('bubbleErrors=true with no errors returns results normally', async () => {
      const client = new NotionClient({
        tokens: ['t1'],
        rateLimit: { maxPerSecond: 100 },
        retry: { maxAttempts: 1, baseMs: 1 },
      });

      const results = await client.runParallel(
        ['a', 'b', 'c'],
        async (item) => `ok-${item}`,
        { workersPerToken: 1, maxWorkers: 1, bubbleErrors: true },
      );

      expect(results).toEqual(['ok-a', 'ok-b', 'ok-c']);
    });
  });
});
