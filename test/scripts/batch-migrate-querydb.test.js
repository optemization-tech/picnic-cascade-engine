/**
 * Unit tests for queryDb cursor-invalidation retry.
 *
 * Mirrors the engine's queryDatabase coverage at test/notion/client.test.js:274,
 * stubbing global fetch to drive the underlying request() helper. Verifies the
 * Phase-5-hardening behavior added in response to the GSK SLE BEACON incident
 * (PR #96): port of the engine's cursor-retry stance into the orchestrator's
 * standalone Notion wrapper.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { queryDb } from '../../scripts/batch-migrate/notion.js';

function okResponse(json) {
  return {
    ok: true,
    text: async () => JSON.stringify(json),
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
  };
}

function errorResponse(status, body) {
  return {
    ok: false,
    status,
    statusText: status === 400 ? 'Bad Request' : 'Error',
    headers: { get: () => null },
    text: async () => body,
  };
}

const CURSOR_ERROR_BODY = JSON.stringify({
  object: 'error',
  status: 400,
  code: 'validation_error',
  message: 'start_cursor is not valid',
});

describe('queryDb cursor retry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns full result on a single-page response (baseline)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okResponse({ results: [{ id: '1' }, { id: '2' }], has_more: false, next_cursor: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await queryDb('db-1', {}, { token: 't' });

    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries from scratch when page 2 throws cursor error, returns full result on 2nd attempt', async () => {
    const fetchMock = vi.fn()
      // attempt 1: page 1 OK, page 2 cursor-invalid
      .mockResolvedValueOnce(okResponse({ results: [{ id: '1' }], has_more: true, next_cursor: 'cur1' }))
      .mockResolvedValueOnce(errorResponse(400, CURSOR_ERROR_BODY))
      // attempt 2 (retry from scratch): page 1 OK, page 2 OK end
      .mockResolvedValueOnce(okResponse({ results: [{ id: '1' }], has_more: true, next_cursor: 'cur2' }))
      .mockResolvedValueOnce(okResponse({ results: [{ id: '2' }], has_more: false, next_cursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await queryDb('db-1', {}, { token: 't' });

    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('throws "cursor retries exhausted" after maxRetries cursor failures', async () => {
    const fetchMock = vi.fn();
    // 3 attempts (1 initial + 2 retries) × 2 calls each = 6 fetches, all the same shape
    for (let i = 0; i < 3; i++) {
      fetchMock
        .mockResolvedValueOnce(okResponse({ results: [{ id: '1' }], has_more: true, next_cursor: `cur${i}` }))
        .mockResolvedValueOnce(errorResponse(400, CURSOR_ERROR_BODY));
    }
    vi.stubGlobal('fetch', fetchMock);

    await expect(queryDb('db-1', {}, { token: 't' })).rejects.toThrow(
      '[notion] queryDb cursor retries exhausted for db db-1',
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('does NOT retry on non-cursor errors (e.g., 401) — propagates immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      errorResponse(401, JSON.stringify({ code: 'unauthorized', message: 'Invalid token' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(queryDb('db-1', {}, { token: 't' })).rejects.toThrow(/401|Unauthorized/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
