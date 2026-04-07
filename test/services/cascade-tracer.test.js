import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CascadeTracer } from '../../src/services/cascade-tracer.js';

describe('CascadeTracer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates a cascadeId when none provided', () => {
    const tracer = new CascadeTracer();
    expect(tracer.cascadeId).toBeTruthy();
    expect(typeof tracer.cascadeId).toBe('string');
  });

  it('uses provided cascadeId', () => {
    const tracer = new CascadeTracer('exec-123');
    expect(tracer.cascadeId).toBe('exec-123');
  });

  describe('phase timing', () => {
    it('records phase duration', () => {
      const tracer = new CascadeTracer('t1');
      tracer.startPhase('query');
      vi.advanceTimersByTime(1200);
      tracer.endPhase('query');

      const json = tracer.toJSON();
      expect(json.phases.query).toBe(1200);
    });

    it('accumulates duration for repeated phases', () => {
      const tracer = new CascadeTracer('t2');
      tracer.startPhase('query');
      vi.advanceTimersByTime(500);
      tracer.endPhase('query');

      tracer.startPhase('query');
      vi.advanceTimersByTime(300);
      tracer.endPhase('query');

      expect(tracer.toJSON().phases.query).toBe(800);
    });

    it('endPhase without startPhase does not throw', () => {
      const tracer = new CascadeTracer('t3');
      expect(() => tracer.endPhase('nonexistent')).not.toThrow();
      expect(tracer.toJSON().phases).toEqual({});
    });

    it('records multiple phases independently', () => {
      const tracer = new CascadeTracer('t4');

      tracer.startPhase('query');
      vi.advanceTimersByTime(100);
      tracer.endPhase('query');

      tracer.startPhase('cascade');
      vi.advanceTimersByTime(5);
      tracer.endPhase('cascade');

      tracer.startPhase('patchUpdates');
      vi.advanceTimersByTime(4500);
      tracer.endPhase('patchUpdates');

      const { phases } = tracer.toJSON();
      expect(phases.query).toBe(100);
      expect(phases.cascade).toBe(5);
      expect(phases.patchUpdates).toBe(4500);
    });
  });

  describe('wrapAsync', () => {
    it('records phase and returns result', async () => {
      const tracer = new CascadeTracer('t5');
      const result = await tracer.wrapAsync('query', async () => {
        vi.advanceTimersByTime(200);
        return 'tasks';
      });

      expect(result).toBe('tasks');
      expect(tracer.toJSON().phases.query).toBe(200);
    });

    it('records phase even on error', async () => {
      const tracer = new CascadeTracer('t6');
      await expect(
        tracer.wrapAsync('query', async () => {
          vi.advanceTimersByTime(50);
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');

      expect(tracer.toJSON().phases.query).toBe(50);
    });
  });

  describe('metadata', () => {
    it('set and get', () => {
      const tracer = new CascadeTracer('t9');
      tracer.set('cascade_mode', 'push-right');
      tracer.set('task_name', 'Contract Signed');

      expect(tracer.get('cascade_mode')).toBe('push-right');
      expect(tracer.get('task_name')).toBe('Contract Signed');
    });

    it('metadata appears in toJSON', () => {
      const tracer = new CascadeTracer('t10');
      tracer.set('task_name', 'My Task');
      tracer.set('cascade_mode', 'pull-left');
      tracer.set('update_count', 12);

      const json = tracer.toJSON();
      expect(json.taskName).toBe('My Task');
      expect(json.mode).toBe('pull-left');
      expect(json.updateCount).toBe(12);
    });

    it('returns null for unset metadata in toJSON', () => {
      const tracer = new CascadeTracer('t11');
      const json = tracer.toJSON();
      expect(json.taskName).toBeNull();
      expect(json.mode).toBeNull();
      expect(json.updateCount).toBe(0);
    });
  });

  describe('retries', () => {
    it('records retry entries', () => {
      const tracer = new CascadeTracer('t12');
      tracer.recordRetry({ attempt: 1, backoffMs: 500, status: 429, tokenIndex: 0 });
      tracer.recordRetry({ attempt: 2, backoffMs: 1100, status: 429, tokenIndex: 0 });

      const json = tracer.toJSON();
      expect(json.retryCount).toBe(2);
      expect(json.retries).toHaveLength(2);
      expect(json.retries[0].attempt).toBe(1);
      expect(json.retries[0].backoffMs).toBe(500);
      expect(json.retries[1].backoffMs).toBe(1100);
    });

    it('defaults to 0 retries', () => {
      const tracer = new CascadeTracer('t13');
      expect(tracer.toJSON().retryCount).toBe(0);
      expect(tracer.toJSON().retries).toEqual([]);
    });
  });

  describe('toConsoleLog', () => {
    it('returns valid JSON string', () => {
      const tracer = new CascadeTracer('t14');
      tracer.set('task_name', 'Test');
      tracer.set('cascade_mode', 'push-right');

      const line = tracer.toConsoleLog();
      const parsed = JSON.parse(line);
      expect(parsed.cascadeId).toBe('t14');
      expect(parsed.taskName).toBe('Test');
      expect(parsed.mode).toBe('push-right');
      expect(typeof parsed.totalDurationMs).toBe('number');
    });
  });

  describe('toActivityLogDetails', () => {
    it('returns correct shape', () => {
      const tracer = new CascadeTracer('t15');

      tracer.startPhase('query');
      vi.advanceTimersByTime(1000);
      tracer.endPhase('query');

      tracer.startPhase('patchUpdates');
      vi.advanceTimersByTime(3000);
      tracer.endPhase('patchUpdates');

      tracer.recordRetry({ attempt: 1, backoffMs: 500, status: 429, tokenIndex: 0 });

      const details = tracer.toActivityLogDetails();

      expect(details.timing.totalMs).toBeGreaterThanOrEqual(4000);
      expect(details.timing.phases.query).toBe(1000);
      expect(details.timing.phases.patchUpdates).toBe(3000);
      expect(details.retryStats.count).toBe(1);
      expect(details.retryStats.totalBackoffMs).toBe(500);
    });

    it('returns zeroes when nothing recorded', () => {
      const tracer = new CascadeTracer('t16');
      const details = tracer.toActivityLogDetails();

      expect(details.timing.phases).toEqual({});
      expect(details.retryStats.count).toBe(0);
      expect(details.retryStats.totalBackoffMs).toBe(0);
    });
  });

  describe('totalDurationMs', () => {
    it('measures wall clock from construction', () => {
      const tracer = new CascadeTracer('t17');
      vi.advanceTimersByTime(5000);
      expect(tracer.toJSON().totalDurationMs).toBe(5000);
    });
  });
});
