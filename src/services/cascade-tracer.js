import { randomUUID } from 'node:crypto';

/**
 * CascadeTracer — structured observability for cascade runs.
 *
 * Instantiated at the top of processDateCascade(), collects timing,
 * counters, metadata, and retry info. Outputs to:
 *   1. Railway console (structured JSON line)
 *   2. Notion Activity Log (enriched details object)
 */
export class CascadeTracer {
  constructor(cascadeId) {
    this.cascadeId = cascadeId || randomUUID();
    this.startTime = Date.now();
    this.phases = new Map();
    this.counters = new Map();
    this.metadata = new Map();
    this.retries = [];
    this._activePhases = new Map();
    // Sweep-specific details — lets support un-archive if mis-archived.
    // Keeps sweep payload structured in Activity Log without colliding with
    // free-form metadata via set().
    this.sweepArchivedIds = [];
    this.sweepFailedArchives = [];
  }

  startPhase(name) {
    this._activePhases.set(name, Date.now());
  }

  endPhase(name) {
    const start = this._activePhases.get(name);
    if (start === undefined) return;
    this._activePhases.delete(name);
    const duration = Date.now() - start;
    this.phases.set(name, (this.phases.get(name) || 0) + duration);
  }


  count(key) {
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
  }

  set(key, value) {
    this.metadata.set(key, value);
  }

  get(key) {
    return this.metadata.get(key);
  }

  recordRetry({ attempt, backoffMs, status, tokenIndex }) {
    this.retries.push({ attempt, backoffMs, status, tokenIndex, ts: Date.now() });
  }

  recordSweepArchived({ tsid, pageId }) {
    this.count('sweepDuplicatesFound');
    this.count('sweepDuplicatesArchived');
    this.sweepArchivedIds.push({ tsid, pageId });
  }

  recordSweepArchiveFailed({ tsid, pageId, error }) {
    this.count('sweepDuplicatesFound');
    this.count('sweepDuplicatesFailed');
    this.sweepFailedArchives.push({
      tsid,
      pageId,
      error: String(error?.message || error).slice(0, 200),
    });
  }

  recordSweepQueryFailed(error) {
    this.count('sweepQueryFailed');
    this.set(
      'sweepQueryError',
      String(error?.message || error).slice(0, 200),
    );
  }

  toJSON() {
    const phases = {};
    for (const [name, duration] of this.phases) {
      phases[name] = duration;
    }
    return {
      cascadeId: this.cascadeId,
      taskName: this.metadata.get('task_name') || null,
      mode: this.metadata.get('cascade_mode') || null,
      totalDurationMs: Date.now() - this.startTime,
      phases,
      updateCount: this.metadata.get('update_count') ?? 0,
      retryCount: this.retries.length,
      retries: this.retries.slice(0, 20),
    };
  }

  toConsoleLog() {
    return JSON.stringify(this.toJSON());
  }

  toActivityLogDetails() {
    const phases = {};
    for (const [name, duration] of this.phases) {
      phases[name] = duration;
    }
    const totalBackoffMs = this.retries.reduce((sum, r) => sum + (r.backoffMs || 0), 0);
    const details = {
      timing: {
        totalMs: Date.now() - this.startTime,
        phases,
      },
      retryStats: {
        count: this.retries.length,
        totalBackoffMs,
      },
    };
    // Sweep details — only include when sweep emitted anything. Keeps the
    // happy-path Activity Log body clean.
    const sweepFound = this.counters.get('sweepDuplicatesFound') || 0;
    const sweepArchived = this.counters.get('sweepDuplicatesArchived') || 0;
    const sweepFailed = this.counters.get('sweepDuplicatesFailed') || 0;
    const sweepQueryFailed = this.counters.get('sweepQueryFailed') || 0;
    if (sweepFound > 0 || sweepFailed > 0 || sweepQueryFailed > 0) {
      details.sweepStats = {
        duplicatesFound: sweepFound,
        duplicatesArchived: sweepArchived,
        duplicatesFailed: sweepFailed,
        queryFailed: sweepQueryFailed,
        archivedIds: this.sweepArchivedIds.slice(0, 50),
        failedArchives: this.sweepFailedArchives.slice(0, 50),
      };
    }
    return details;
  }
}
