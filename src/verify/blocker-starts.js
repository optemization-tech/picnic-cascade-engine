import { formatDate, isBusinessDay, nextBusinessDay } from '../utils/business-days.js';

const STUDY_ID_RE = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function extractStudyPageId(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const match = value.match(STUDY_ID_RE);
  if (!match) return null;

  const raw = match[1].toLowerCase();
  if (raw.includes('-')) return raw;

  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ].join('-');
}

function diffCalendarDays(left, right) {
  return Math.round((left.getTime() - right.getTime()) / (1000 * 60 * 60 * 24));
}

function isIgnorableWeekendNearExpected(actualStart, expectedStart) {
  if (isBusinessDay(actualStart)) return false;
  return Math.abs(diffCalendarDays(actualStart, expectedStart)) <= 2;
}

export function findBlockerStartViolations(tasks) {
  const taskMap = new Map((tasks || []).map((task) => [task.id, task]));
  const violations = [];

  for (const task of tasks || []) {
    const blockerIds = task.blockedByIds || [];
    if (blockerIds.length === 0) continue;

    if (!task.start) {
      violations.push({
        type: 'missing_task_start',
        taskId: task.id,
        taskName: task.name,
        blockerIds,
      });
      continue;
    }

    let latestBlocker = null;
    const missingBlockers = [];
    const blockersMissingEnd = [];

    for (const blockerId of blockerIds) {
      const blocker = taskMap.get(blockerId);
      if (!blocker) {
        missingBlockers.push(blockerId);
        continue;
      }
      if (!blocker.end) {
        blockersMissingEnd.push({
          blockerId,
          blockerName: blocker.name,
        });
        continue;
      }
      if (!latestBlocker || blocker.end > latestBlocker.end) {
        latestBlocker = blocker;
      }
    }

    if (missingBlockers.length > 0) {
      violations.push({
        type: 'missing_blocker',
        taskId: task.id,
        taskName: task.name,
        missingBlockerIds: missingBlockers,
      });
      continue;
    }

    if (blockersMissingEnd.length > 0) {
      violations.push({
        type: 'missing_blocker_end',
        taskId: task.id,
        taskName: task.name,
        blockersMissingEnd,
      });
      continue;
    }

    if (!latestBlocker) continue;

    const expectedStart = nextBusinessDay(latestBlocker.end);
    if (task.start.getTime() === expectedStart.getTime()) continue;
    if (isIgnorableWeekendNearExpected(task.start, expectedStart)) continue;

    violations.push({
      type: 'start_mismatch',
      taskId: task.id,
      taskName: task.name,
      actualStart: formatDate(task.start),
      expectedStart: formatDate(expectedStart),
      bindingBlockerId: latestBlocker.id,
      bindingBlockerName: latestBlocker.name,
      bindingBlockerEnd: formatDate(latestBlocker.end),
      blockerIds,
    });
  }

  return violations;
}
