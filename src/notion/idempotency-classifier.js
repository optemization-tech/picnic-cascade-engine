/**
 * classifyIdempotency — path-based classifier for Notion endpoints.
 *
 * Returns 'nonIdempotent' for endpoints where Notion may commit a write
 * before acknowledging (so retry-after-error risks duplicates). Returns
 * 'idempotent' for everything else.
 *
 * Path table (source of truth):
 *   POST   /pages                        → nonIdempotent (creates a new page each call)
 *   POST   /comments                     → nonIdempotent (creates a new comment each call)
 *   PATCH  /blocks/{uuid}/children       → nonIdempotent (appends blocks positionally)
 *   everything else                      → idempotent (default; preserves current behavior)
 *
 * Default is intentionally idempotent so adding a new caller does not
 * accidentally change retry behavior. Adding a new non-idempotent endpoint
 * is a single-line edit to this table.
 */

const BLOCK_CHILDREN_PATH = /^\/blocks\/[^/]+\/children(\?.*)?$/;

export function classifyIdempotency(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') {
    return 'idempotent';
  }
  const upperMethod = method.toUpperCase();

  if (upperMethod === 'POST' && path === '/pages') {
    return 'nonIdempotent';
  }
  if (upperMethod === 'POST' && path === '/comments') {
    return 'nonIdempotent';
  }
  if (upperMethod === 'PATCH' && BLOCK_CHILDREN_PATH.test(path)) {
    return 'nonIdempotent';
  }
  return 'idempotent';
}
