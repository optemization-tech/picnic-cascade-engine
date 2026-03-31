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

  it('clearStudyLmbsFlags queries study-wide LMBS and clears all matches', async () => {
    const fetchMock = vi.fn()
      // queryDatabase call
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          results: [{ id: 't1' }, { id: 't2' }],
          has_more: false,
          next_cursor: null,
        }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      })
      // patch t1
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: 't1' }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      })
      // patch t2
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: 't2' }),
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
    const result = await client.clearStudyLmbsFlags({
      studyTasksDbId: 'db-1',
      studyId: 'study-1',
      batchSize: 3,
      interval: 1,
    });

    expect(result.updatedCount).toBe(2);
    expect(result.taskIds).toEqual(['t1', 't2']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Ensure first request is study-wide LMBS filter query.
    const queryBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(queryBody.filter).toEqual({
      and: [
        { property: 'Study', relation: { contains: 'study-1' } },
        { property: 'Last Modified By System', checkbox: { equals: true } },
      ],
    });
  });

  it('clearStudyLmbsFlags paginates query results before clearing all matches', async () => {
    const fetchMock = vi.fn()
      // page 1 query
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          results: [{ id: 't1' }, { id: 't2' }],
          has_more: true,
          next_cursor: 'cursor-2',
        }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      })
      // page 2 query
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          results: [{ id: 't3' }],
          has_more: false,
          next_cursor: null,
        }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      })
      // patch t1
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: 't1' }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      })
      // patch t2
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: 't2' }),
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
      })
      // patch t3
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: 't3' }),
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
    const result = await client.clearStudyLmbsFlags({
      studyTasksDbId: 'db-1',
      studyId: 'study-1',
      batchSize: 3,
      interval: 1,
    });

    expect(result.updatedCount).toBe(3);
    expect(result.taskIds).toEqual(['t1', 't2', 't3']);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const page1Body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const page2Body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(page1Body.filter).toEqual({
      and: [
        { property: 'Study', relation: { contains: 'study-1' } },
        { property: 'Last Modified By System', checkbox: { equals: true } },
      ],
    });
    expect(page2Body.start_cursor).toBe('cursor-2');
  });
});
