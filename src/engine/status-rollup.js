function normalizeStatus(s) {
  if (!s) return 'Not Started';
  const v = String(s).trim().toLowerCase();
  if (v === 'done' || v === 'n/a') return 'Done';
  if (v === 'in progress') return 'In Progress';
  if (v === 'not started' || v === 'not-started' || v === 'not started.') return 'Not Started';
  return 'Not Started';
}

/**
 * Roll-up precedence ladder:
 *   - all Done/N/A           => Done
 *   - any In Progress        => In Progress
 *   - any Done (partial)     => In Progress  (BEH-STATUS-ROLLUP-PARTIAL-DONE)
 *   - else                   => Not Started
 *
 * Accepts siblings as status strings or sibling objects with `status`.
 */
export function computeStatusRollup(siblings) {
  const statuses = (siblings || []).map((s) => normalizeStatus(typeof s === 'string' ? s : s?.status));
  if (statuses.length === 0) return 'Not Started';

  const allComplete = statuses.every((s) => s === 'Done');
  if (allComplete) return 'Done';

  const anyInProgress = statuses.some((s) => s === 'In Progress');
  if (anyInProgress) return 'In Progress';

  const anyDone = statuses.some((s) => s === 'Done');
  if (anyDone) return 'In Progress';

  return 'Not Started';
}
