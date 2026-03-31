// ============================================================
// Business Day Utilities
// Ported from WF-D Resolve Cascade + WF-R Router Code nodes
// All dates are UTC — no timezone ambiguity
// ============================================================

/**
 * Parse 'YYYY-MM-DD' string to UTC Date.
 * Returns null for falsy input.
 */
export function parseDate(s) {
  return s ? new Date(s + 'T00:00:00Z') : null;
}

/**
 * Format UTC Date to 'YYYY-MM-DD' string.
 */
export function formatDate(d) {
  return d.toISOString().split('T')[0];
}

/**
 * True if d is Mon–Fri (UTC).
 */
export function isBusinessDay(d) {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * Advance to the next business day (always moves at least 1 day).
 */
export function nextBusinessDay(d) {
  const n = new Date(d);
  do { n.setUTCDate(n.getUTCDate() + 1); } while (!isBusinessDay(n));
  return n;
}

/**
 * Retreat to the previous business day (always moves at least 1 day).
 */
export function prevBusinessDay(d) {
  const p = new Date(d);
  do { p.setUTCDate(p.getUTCDate() - 1); } while (!isBusinessDay(p));
  return p;
}

/**
 * Add (or subtract) business days from a date.
 * When count is 0: if d is a weekend, snaps to next business day.
 * This fixes the zero-offset weekend bug from the original n8n code.
 */
export function addBusinessDays(d, count) {
  const c = new Date(d);
  if (count === 0) {
    // Snap weekends to next business day — a task can't sit on a weekend
    if (!isBusinessDay(c)) return nextBusinessDay(c);
    return c;
  }
  let remaining = Math.abs(count);
  const dir = count > 0 ? 1 : -1;
  while (remaining > 0) {
    c.setUTCDate(c.getUTCDate() + dir);
    if (isBusinessDay(c)) remaining--;
  }
  return c;
}

/**
 * Count business days between start and end (inclusive).
 * Returns minimum 1.
 */
export function countBDInclusive(start, end) {
  if (!start || !end || end < start) return 1;
  let count = 0;
  const c = new Date(start);
  while (c <= end) {
    if (isBusinessDay(c)) count++;
    c.setUTCDate(c.getUTCDate() + 1);
  }
  return Math.max(count, 1);
}

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') return parseDate(value);
  return null;
}

/**
 * Signed business day difference from -> to.
 * Positive = to is after from, negative = to is before from, 0 = same day.
 * Accepts either Date instances or YYYY-MM-DD strings.
 */
export function signedBDDelta(from, to) {
  const fromDate = asDate(from);
  const toDate = asDate(to);
  if (!fromDate || !toDate) return 0;
  from = fromDate;
  to = toDate;
  if (!from || !to || from.getTime() === to.getTime()) return 0;
  const dir = to > from ? 1 : -1;
  let count = 0;
  const cursor = new Date(from);
  if (dir === 1) {
    while (cursor < to) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (isBusinessDay(cursor)) count++;
    }
  } else {
    while (cursor > to) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (isBusinessDay(cursor)) count++;
    }
  }
  return count * dir;
}
