/**
 * FlightTracker — tracks in-flight promises for graceful shutdown.
 *
 * Any async work that must complete before the process exits should be
 * wrapped with `flightTracker.track(promise, label)`. During shutdown,
 * `drain(timeoutMs)` waits for all tracked promises to settle (or gives
 * up after the timeout — best-effort, never rejects).
 */
export class FlightTracker {
  constructor() {
    // Each entry: { promise, label }
    this._flights = new Set();
  }

  /**
   * Register a promise as in-flight work. The promise is auto-removed
   * from the set once it settles (resolve or reject).
   *
   * @param {Promise} promise - The async work to track
   * @param {string}  label  - Human-readable label for observability
   * @returns {Promise} The original promise (pass-through so callers can still await it)
   */
  track(promise, label = 'unnamed') {
    const entry = { promise, label };
    this._flights.add(entry);

    // Auto-remove on settle — .then() with identical resolve/reject handlers
    // ensures we clean up regardless of outcome, without swallowing errors.
    const cleanup = () => this._flights.delete(entry);
    promise.then(cleanup, cleanup);

    return promise;
  }

  /**
   * Wait for all currently-tracked promises to settle.
   * Resolves when everything is done, or when timeoutMs elapses —
   * whichever comes first. Never rejects (best-effort drain).
   *
   * @param {number} timeoutMs - Max milliseconds to wait (default 5000)
   * @returns {Promise<void>}
   */
  async drain(timeoutMs = 5000) {
    if (this._flights.size === 0) return;

    const pending = [...this._flights].map((entry) => entry.promise);
    console.log(`[flight-tracker] Draining ${pending.length} in-flight promise(s)...`);

    // Promise.allSettled never rejects — one failure won't abort the wait.
    // Promise.race with a timeout ensures we don't hang forever.
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) =>
        setTimeout(() => {
          console.warn(`[flight-tracker] Drain timeout after ${timeoutMs}ms, proceeding with shutdown`);
          resolve();
        }, timeoutMs),
      ),
    ]);
  }

  /**
   * Observability snapshot of current in-flight work.
   * @returns {{ activeCount: number, labels: string[] }}
   */
  getStats() {
    return {
      activeCount: this._flights.size,
      labels: [...this._flights].map((entry) => entry.label),
    };
  }

  /** Clear all tracked flights — used in tests to reset state. */
  _clearAll() {
    this._flights.clear();
  }
}

export const flightTracker = new FlightTracker();
