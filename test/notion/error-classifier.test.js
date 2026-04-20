import { describe, it, expect } from 'vitest';
import { classifyNotionError } from '../../src/notion/error-classifier.js';

describe('classifyNotionError', () => {
  describe('safe_retry', () => {
    it('429 rate limit is safe_retry', () => {
      const err = new Error('rate limited');
      err.status = 429;
      expect(classifyNotionError(err)).toBe('safe_retry');
    });

    it('ECONNREFUSED is safe_retry (connect-level)', () => {
      const err = new Error('connect refused');
      err.code = 'ECONNREFUSED';
      expect(classifyNotionError(err)).toBe('safe_retry');
    });

    it('ENOTFOUND is safe_retry (DNS, pre-send)', () => {
      const err = new Error('dns failure');
      err.code = 'ENOTFOUND';
      expect(classifyNotionError(err)).toBe('safe_retry');
    });

    it('ETIMEDOUT is safe_retry (connect-level timeout, pre-send)', () => {
      const err = new Error('connect timeout');
      err.code = 'ETIMEDOUT';
      expect(classifyNotionError(err)).toBe('safe_retry');
    });
  });

  describe('unsafe_retry', () => {
    it('500 Internal Server Error is unsafe_retry', () => {
      const err = new Error('server error');
      err.status = 500;
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });

    it('502 Bad Gateway is unsafe_retry', () => {
      const err = new Error('bad gateway');
      err.status = 502;
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });

    it('503 Service Unavailable is unsafe_retry', () => {
      const err = new Error('unavailable');
      err.status = 503;
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });

    it('504 Gateway Timeout is unsafe_retry', () => {
      const err = new Error('gateway timeout');
      err.status = 504;
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });

    it('599 (edge of 5xx) is unsafe_retry', () => {
      const err = new Error('edge 5xx');
      err.status = 599;
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });

    it('TimeoutError is unsafe_retry (post-send indistinguishable)', () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });

    it('AbortError is unsafe_retry (post-send indistinguishable)', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });

    it('unknown error shape (plain Error) is unsafe_retry (conservative default)', () => {
      const err = new Error('who knows');
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });

    it('null error returns unsafe_retry (defensive default)', () => {
      expect(classifyNotionError(null)).toBe('unsafe_retry');
    });

    it('undefined error returns unsafe_retry (defensive default)', () => {
      expect(classifyNotionError(undefined)).toBe('unsafe_retry');
    });

    it('5xx dominates even if error has unusual shape', () => {
      const err = { status: 503, data: { code: 'rate_limited' } };
      expect(classifyNotionError(err)).toBe('unsafe_retry');
    });
  });

  describe('non_retryable', () => {
    it('400 Bad Request is non_retryable', () => {
      const err = new Error('bad');
      err.status = 400;
      expect(classifyNotionError(err)).toBe('non_retryable');
    });

    it('401 Unauthorized is non_retryable', () => {
      const err = new Error('unauthorized');
      err.status = 401;
      expect(classifyNotionError(err)).toBe('non_retryable');
    });

    it('403 Forbidden is non_retryable', () => {
      const err = new Error('forbidden');
      err.status = 403;
      expect(classifyNotionError(err)).toBe('non_retryable');
    });

    it('404 Not Found is non_retryable', () => {
      const err = new Error('not found');
      err.status = 404;
      expect(classifyNotionError(err)).toBe('non_retryable');
    });

    it('409 Conflict is non_retryable', () => {
      const err = new Error('conflict');
      err.status = 409;
      expect(classifyNotionError(err)).toBe('non_retryable');
    });
  });

  describe('precedence', () => {
    it('429 takes precedence over a TimeoutError name (hypothetical)', () => {
      const err = new Error('mixed');
      err.status = 429;
      err.name = 'TimeoutError';
      expect(classifyNotionError(err)).toBe('safe_retry');
    });

    it('ECONNREFUSED takes precedence over absent status', () => {
      const err = new Error('connection refused');
      err.code = 'ECONNREFUSED';
      expect(classifyNotionError(err)).toBe('safe_retry');
    });
  });
});
