export class UndoStore {
  constructor() {
    this._store = new Map(); // studyId → { manifest, cascadeId, sourceTaskId, sourceTaskName, cascadeMode, timestamp }
  }

  save(studyId, { cascadeId, sourceTaskId, sourceTaskName, cascadeMode, manifest }) {
    const entry = {
      cascadeId,
      sourceTaskId,
      sourceTaskName,
      cascadeMode,
      manifest, // { taskId: { oldStart, oldEnd, newStart, newEnd } }
      timestamp: Date.now(),
    };
    this._store.set(studyId, entry);
  }

  peek(studyId) {
    const entry = this._store.get(studyId);
    if (!entry) return null;
    return { ...entry };
  }

  pop(studyId) {
    const entry = this._store.get(studyId);
    if (!entry) return null;
    this._store.delete(studyId);
    return { ...entry };
  }

  _clearAll() {
    this._store.clear();
  }
}

export const undoStore = new UndoStore();
