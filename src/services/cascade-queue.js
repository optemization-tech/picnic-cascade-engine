import { config } from '../config.js';

export class CascadeQueue {
  constructor({ debounceMs = 5000 } = {}) {
    this._debounceMs = debounceMs;
    // Per-task debounce: taskId -> { timer, payload, studyId, taskName, processFn }
    this._debounce = new Map();
    // Per-study serialization: studyId -> { running, queue: [{ payload, processFn }] }
    this._studyLocks = new Map();
  }

  /**
   * Enqueue a webhook payload for debounced, study-serialized processing.
   * @param {object} payload - Raw webhook body
   * @param {function} parseFn - Pure function to extract taskId/studyId (parseWebhookPayload)
   * @param {function} processFn - Async cascade processor (processDateCascade)
   */
  enqueue(payload, parseFn, processFn) {
    let parsed;
    try {
      parsed = parseFn(payload);
    } catch {
      console.log(JSON.stringify({ event: 'debounce_bypass', reason: 'parse_error' }));
      void processFn(payload).catch((err) =>
        console.error('[cascade-queue] processFn failed:', err),
      );
      return;
    }

    const { taskId, studyId, taskName } = parsed;

    // Fall through for unparseable or skip payloads — let processDateCascade's guard chain handle them
    if (parsed.skip || !taskId || !studyId) {
      const reason = parsed.skip ? 'skip' : !taskId ? 'no_task_id' : 'no_study_id';
      console.log(JSON.stringify({ event: 'debounce_bypass', reason, taskId, taskName }));
      void processFn(payload).catch((err) =>
        console.error('[cascade-queue] processFn failed:', err),
      );
      return;
    }

    // Cancel existing debounce timer for this task
    const existing = this._debounce.get(taskId);
    if (existing) {
      if (parsed.editedByBot) {
        // Bot-edited webhook = cascade echo. Don't replace the user's original edit.
        console.log(JSON.stringify({ event: 'debounce_echo_ignored', taskId, taskName, studyId }));
        return;
      }
      clearTimeout(existing.timer);
      console.log(JSON.stringify({ event: 'debounce_replaced', taskId, taskName, studyId }));
    } else {
      console.log(JSON.stringify({ event: 'debounce_new', taskId, taskName, studyId }));
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this._debounce.delete(taskId);
      console.log(JSON.stringify({ event: 'debounce_fired', taskId, taskName, studyId }));
      this._enqueueToStudy(studyId, payload, processFn, { taskId, taskName });
    }, this._debounceMs);

    this._debounce.set(taskId, { timer, payload, studyId, taskName, processFn });
  }

  _enqueueToStudy(studyId, payload, processFn, meta) {
    let lock = this._studyLocks.get(studyId);
    if (!lock) {
      lock = { running: false, queue: [] };
      this._studyLocks.set(studyId, lock);
    }

    lock.queue.push({ payload, processFn, meta });
    console.log(JSON.stringify({
      event: 'study_queue_enqueued',
      studyId,
      taskId: meta.taskId,
      taskName: meta.taskName,
      queueDepth: lock.queue.length,
    }));

    if (!lock.running) {
      this._drainStudy(studyId).catch((err) => {
        console.error(`[cascade-queue] _drainStudy failed for ${studyId}:`, err);
        const lock = this._studyLocks.get(studyId);
        if (lock) {
          lock.running = false;
          this._studyLocks.delete(studyId);
        }
      });
    }
  }

  async _drainStudy(studyId) {
    const lock = this._studyLocks.get(studyId);
    if (!lock) return;

    lock.running = true;

    try {
      while (lock.queue.length > 0) {
        const { payload, processFn, meta } = lock.queue.shift();
        const startMs = Date.now();

        console.log(JSON.stringify({
          event: 'study_cascade_started',
          studyId,
          taskId: meta.taskId,
          taskName: meta.taskName,
          queueDepth: lock.queue.length,
        }));

        try {
          await processFn(payload);
        } catch (err) {
          console.error('[cascade-queue] processFn failed:', err);
        }

        console.log(JSON.stringify({
          event: 'study_cascade_completed',
          studyId,
          taskId: meta.taskId,
          taskName: meta.taskName,
          durationMs: Date.now() - startMs,
          queueDepth: lock.queue.length,
        }));
      }
    } finally {
      lock.running = false;
      this._studyLocks.delete(studyId);
      console.log(JSON.stringify({ event: 'study_queue_drained', studyId }));
    }
  }

  getStats() {
    return {
      debounceSize: this._debounce.size,
      studyLockCount: this._studyLocks.size,
      studies: Object.fromEntries(
        [...this._studyLocks].map(([id, lock]) => [id, {
          running: lock.running,
          queueDepth: lock.queue.length,
        }]),
      ),
    };
  }

  /**
   * Drain in-flight work for graceful shutdown.
   * Clears all debounce timers, then waits for any currently-running study to finish.
   */
  async drain() {
    for (const entry of this._debounce.values()) {
      clearTimeout(entry.timer);
    }
    this._debounce.clear();

    const running = [...this._studyLocks.entries()]
      .filter(([, lock]) => lock.running);
    if (running.length === 0) return;

    console.log(`[cascade-queue] Draining ${running.length} in-flight study cascade(s)...`);
    const DRAIN_TIMEOUT_MS = 8000;
    const watchers = Promise.all(
      running.map(([studyId]) => new Promise((resolve) => {
        const check = () => {
          const lock = this._studyLocks.get(studyId);
          if (!lock || !lock.running) return resolve();
          setTimeout(check, 100);
        };
        check();
      })),
    );
    await Promise.race([
      watchers,
      new Promise((resolve) => setTimeout(() => {
        console.warn(`[cascade-queue] Drain timeout after ${DRAIN_TIMEOUT_MS}ms, proceeding with shutdown`);
        resolve();
      }, DRAIN_TIMEOUT_MS)),
    ]);
  }

  _clearAll() {
    for (const entry of this._debounce.values()) {
      clearTimeout(entry.timer);
    }
    this._debounce.clear();
    this._studyLocks.clear();
  }
}

export const cascadeQueue = new CascadeQueue({
  debounceMs: config.cascadeDebounceMs,
});
