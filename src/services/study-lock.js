// Per-study serialization — prevents concurrent operations on the same study
// from racing on Notion's eventually-consistent database queries, which causes
// duplicate numbering (e.g., two "TLF #2" instead of #2 and #3) or parallel
// inception runs that each create the full task set.
//
// Shared across routes at module scope: both add-task-set and inception lock
// the same study-scoped key, serializing cross-route work for a given study.
const _studyLocks = new Map();

function withStudyLock(studyId, fn) {
  const prev = _studyLocks.get(studyId) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  _studyLocks.set(studyId, next);
  // Clean up lock entry; .catch suppresses the floating rejection since the
  // caller handles errors via the returned `next` promise.
  next.finally(() => {
    if (_studyLocks.get(studyId) === next) _studyLocks.delete(studyId);
  }).catch(() => {});
  return next;
}

// Exposed for test cleanup
function _resetStudyLocks() { _studyLocks.clear(); }

export { withStudyLock, _resetStudyLocks };
