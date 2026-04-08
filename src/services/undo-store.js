const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class UndoStore {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this._ttlMs = ttlMs;
    this._store = new Map(); // studyId → { manifest, cascadeId, sourceTaskId, sourceTaskName, cascadeMode, timestamp, timer }
  }

  save(studyId, { cascadeId, sourceTaskId, sourceTaskName, cascadeMode, manifest }) {
    const prev = this._store.get(studyId);
    if (prev?.timer) clearTimeout(prev.timer);

    const entry = {
      cascadeId,
      sourceTaskId,
      sourceTaskName,
      cascadeMode,
      manifest, // { taskId: { oldStart, oldEnd, newStart, newEnd } }
      timestamp: Date.now(),
      timer: setTimeout(() => this._store.delete(studyId), this._ttlMs).unref(),
    };
    this._store.set(studyId, entry);
  }

  peek(studyId) {
    const entry = this._store.get(studyId);
    if (!entry) return null;
    const { timer: _, ...data } = entry;
    return data;
  }

  pop(studyId) {
    const entry = this._store.get(studyId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this._store.delete(studyId);
    const { timer: _, ...data } = entry;
    return data;
  }

  _clearAll() {
    for (const entry of this._store.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this._store.clear();
  }
}

export const undoStore = new UndoStore();
