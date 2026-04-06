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

  async wrapAsync(name, fn) {
    this.startPhase(name);
    try {
      return await fn();
    } finally {
      this.endPhase(name);
    }
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
    return {
      timing: {
        totalMs: Date.now() - this.startTime,
        phases,
      },
      retryStats: {
        count: this.retries.length,
        totalBackoffMs,
      },
    };
  }
}
