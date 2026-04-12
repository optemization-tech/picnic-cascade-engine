import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotionClient } from '../../src/notion/client.js';

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
      Status: { status: { name: 'Done' } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      properties: {
        Status: { status: { name: 'Done' } },
      },
    });
  });

  it('createPages preserves input order while distributing work across tokens', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      const templateId = body.properties?.['Template Source ID']?.rich_text?.[0]?.text?.content;
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
      { properties: { 'Template Source ID': { rich_text: [{ type: 'text', text: { content: 'a' } }] } } },
      { properties: { 'Template Source ID': { rich_text: [{ type: 'text', text: { content: 'b' } }] } } },
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
      { taskId: 'task-1', properties: { Status: { status: { name: 'Done' } } } },
      { taskId: 'task-2', properties: { Status: { status: { name: 'In Progress' } } } },
    ]);

    expect(result).toEqual({
      updatedCount: 2,
      taskIds: ['task-1', 'task-2'],
    });
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
});
