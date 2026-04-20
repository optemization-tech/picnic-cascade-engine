import { describe, it, expect } from 'vitest';
import { classifyIdempotency } from '../../src/notion/idempotency-classifier.js';

describe('classifyIdempotency', () => {
  describe('non-idempotent endpoints', () => {
    it('POST /pages is nonIdempotent', () => {
      expect(classifyIdempotency('POST', '/pages')).toBe('nonIdempotent');
    });

    it('PATCH /blocks/{uuid}/children is nonIdempotent (hyphenated uuid)', () => {
      expect(
        classifyIdempotency('PATCH', '/blocks/abc-123-def-456/children'),
      ).toBe('nonIdempotent');
    });

    it('PATCH /blocks/{uuid}/children is nonIdempotent (real-looking uuid)', () => {
      expect(
        classifyIdempotency('PATCH', '/blocks/11111111-2222-3333-4444-555555555555/children'),
      ).toBe('nonIdempotent');
    });

    it('PATCH /blocks/{id}/children with query string is nonIdempotent', () => {
      expect(
        classifyIdempotency('PATCH', '/blocks/abc-123/children?page_size=100'),
      ).toBe('nonIdempotent');
    });
  });

  describe('idempotent endpoints', () => {
    it('PATCH /pages/:id is idempotent', () => {
      expect(classifyIdempotency('PATCH', '/pages/abc-123')).toBe('idempotent');
    });

    it('GET /pages/:id is idempotent', () => {
      expect(classifyIdempotency('GET', '/pages/abc-123')).toBe('idempotent');
    });

    it('GET /databases/:id is idempotent', () => {
      expect(classifyIdempotency('GET', '/databases/abc-123')).toBe('idempotent');
    });

    it('POST /databases/:id/query is idempotent (query, not write)', () => {
      expect(classifyIdempotency('POST', '/databases/abc-123/query')).toBe('idempotent');
    });

    it('DELETE /pages/:id is idempotent (hypothetical)', () => {
      expect(classifyIdempotency('DELETE', '/pages/abc-123')).toBe('idempotent');
    });

    it('GET /blocks/{id}/children is idempotent (read, not append)', () => {
      expect(classifyIdempotency('GET', '/blocks/abc-123/children')).toBe('idempotent');
    });
  });

  describe('edge cases', () => {
    it('PATCH /blocks/abc-123 (no /children suffix) is idempotent', () => {
      expect(classifyIdempotency('PATCH', '/blocks/abc-123')).toBe('idempotent');
    });

    it('POST /pages/something-weird is idempotent (path is not exactly /pages)', () => {
      expect(classifyIdempotency('POST', '/pages/something-weird')).toBe('idempotent');
    });

    it('POST /pages/ (trailing slash) is idempotent (defensive exact match)', () => {
      expect(classifyIdempotency('POST', '/pages/')).toBe('idempotent');
    });

    it('lowercase method "post" still classified as POST (defensive)', () => {
      expect(classifyIdempotency('post', '/pages')).toBe('nonIdempotent');
    });

    it('mixed-case method "Patch" still matches PATCH', () => {
      expect(
        classifyIdempotency('Patch', '/blocks/abc-123/children'),
      ).toBe('nonIdempotent');
    });

    it('empty path returns idempotent (safe default)', () => {
      expect(classifyIdempotency('POST', '')).toBe('idempotent');
    });

    it('null method returns idempotent (safe default)', () => {
      expect(classifyIdempotency(null, '/pages')).toBe('idempotent');
    });

    it('undefined path returns idempotent (safe default)', () => {
      expect(classifyIdempotency('POST', undefined)).toBe('idempotent');
    });

    it('PATCH /blocks//children (empty uuid) is idempotent (not matched)', () => {
      expect(classifyIdempotency('PATCH', '/blocks//children')).toBe('idempotent');
    });
  });
});
