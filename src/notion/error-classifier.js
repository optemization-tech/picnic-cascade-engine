/**
 * classifyNotionError — bucket an error into one of three retry classes.
 *
 *   'safe_retry'   — Notion never saw the request (or documented as
 *                    retry-safe). Retry is safe regardless of idempotency.
 *                    Examples: 429, ECONNREFUSED, ENOTFOUND, ETIMEDOUT
 *                    (connect-level).
 *   'unsafe_retry' — the request may have been received and committed
 *                    server-side. Retry is only safe for idempotent
 *                    operations. Examples: 5xx responses, TimeoutError /
 *                    AbortError (post-send indistinguishable from pre-send
 *                    in Node fetch), unknown error shapes (conservative
 *                    default).
 *   'non_retryable' — the request is malformed or unauthorized. Retrying
 *                     will not help. Examples: 4xx except 429.
 *
 * Decision rationale per branch is inline; the mapping is intentionally
 * explicit so future additions (new Notion API versions, new error shapes)
 * are reviewed one-by-one.
 */

export function classifyNotionError(err) {
  if (!err || typeof err !== 'object') return 'unsafe_retry';

  // 429 — rate limit. Notion's documented semantic is not-yet-committed.
  if (err.status === 429) return 'safe_retry';

  // Connect-level Node errors fire before the request body is sent.
  // Reliably detectable via err.code (libuv / Node net layer).
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    return 'safe_retry';
  }

  // HTTP 5xx — server-side error. The request may have been received and
  // committed before the failure. Classify as unsafe.
  if (typeof err.status === 'number' && err.status >= 500 && err.status <= 599) {
    return 'unsafe_retry';
  }

  // Node fetch TimeoutError / AbortError. In principle a timeout can fire
  // pre-send or post-send; Node fetch does not expose this distinction
  // reliably. Conservative: treat all timeouts as unsafe_retry. For
  // idempotent paths the retry loop continues with the 2-attempt cap; for
  // non-idempotent paths the error surfaces.
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return 'unsafe_retry';
  }

  // HTTP 4xx (except 429) — client error. Retrying with the same body will
  // keep failing. Surface to caller.
  if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    return 'non_retryable';
  }

  // Unknown error shape — conservative default. For idempotent paths the
  // existing retry-on-anything behavior is preserved (retry succeeds or
  // the attempt cap fires). For non-idempotent paths the error surfaces,
  // which matches the "fail loud not silent" principle.
  return 'unsafe_retry';
}
