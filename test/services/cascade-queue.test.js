import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    cascadeDebounceMs: 5000,
    notion: { tokens: ['t1'], studyTasksDbId: 'db', studiesDbId: 'db2' },
  },
}));

import { CascadeQueue } from '../../src/services/cascade-queue.js';

function makeParseFn(overrides = {}) {
  return vi.fn((payload) => ({
    skip: false,
    taskId: payload.taskId || 'task-1',
    studyId: payload.studyId || 'study-1',
    taskName: payload.taskName || 'Test Task',
    editedByBot: payload.editedByBot || false,
    ...overrides,
  }));
}

describe('CascadeQueue', () => {
  let queue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new CascadeQueue({ debounceMs: 5000 });
  });

  afterEach(() => {
    queue._clearAll();
    vi.useRealTimers();
  });

  it('passes payload through to processFn after debounce delay', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, processFn);

    expect(processFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith({ taskId: 'task-1', studyId: 'study-1' });
  });

  it('replaces payload when second webhook arrives for same task', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 1 }, parseFn, processFn);
    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 2 }, parseFn, processFn);

    await vi.advanceTimersByTimeAsync(5000);

    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith({ taskId: 'task-1', studyId: 'study-1', v: 2 });
  });

  it('resets timer on replacement — fires debounceMs after last webhook', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 1 }, parseFn, processFn);

    // Advance 3 seconds, then send replacement
    await vi.advanceTimersByTimeAsync(3000);
    expect(processFn).not.toHaveBeenCalled();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 2 }, parseFn, processFn);

    // 2 more seconds (5s from first, 2s from replacement) — should NOT have fired
    await vi.advanceTimersByTimeAsync(2000);
    expect(processFn).not.toHaveBeenCalled();

    // 3 more seconds (5s from replacement) — should fire
    await vi.advanceTimersByTimeAsync(3000);
    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith({ taskId: 'task-1', studyId: 'study-1', v: 2 });
  });

  it('debounces different tasks independently', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, processFn);
    queue.enqueue({ taskId: 'task-2', studyId: 'study-1' }, parseFn, processFn);

    await vi.advanceTimersByTimeAsync(5000);

    expect(processFn).toHaveBeenCalledTimes(2);
  });

  it('serializes cascades within the same study', async () => {
    const callOrder = [];
    const processFn1 = vi.fn(async () => {
      callOrder.push('start-1');
      await new Promise((r) => setTimeout(r, 100));
      callOrder.push('end-1');
    });
    const processFn2 = vi.fn(async () => {
      callOrder.push('start-2');
      await new Promise((r) => setTimeout(r, 100));
      callOrder.push('end-2');
    });
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, processFn1);
    queue.enqueue({ taskId: 'task-2', studyId: 'study-1' }, parseFn, processFn2);

    // Fire both debounce timers
    await vi.advanceTimersByTimeAsync(5000);

    // First cascade is running, second is queued
    expect(callOrder).toContain('start-1');
    expect(callOrder).not.toContain('start-2');

    // Let first cascade complete
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Now second should have started
    expect(callOrder).toContain('start-2');

    // Let second complete
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(callOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('runs different studies concurrently', async () => {
    const callOrder = [];
    const makeSlow = (label) =>
      vi.fn(async () => {
        callOrder.push(`start-${label}`);
        await new Promise((r) => setTimeout(r, 100));
        callOrder.push(`end-${label}`);
      });

    const fnA = makeSlow('A');
    const fnB = makeSlow('B');
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-A' }, parseFn, fnA);
    queue.enqueue({ taskId: 'task-2', studyId: 'study-B' }, parseFn, fnB);

    await vi.advanceTimersByTimeAsync(5000);

    // Both should have started (different studies = no serialization)
    expect(callOrder).toContain('start-A');
    expect(callOrder).toContain('start-B');
  });

  it('falls through immediately for skip payloads', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = vi.fn(() => ({ skip: true, taskId: 'task-1', studyId: 'study-1' }));

    queue.enqueue({ taskId: 'task-1' }, parseFn, processFn);

    // processFn called immediately, no debounce wait
    // Need to flush microtask for void promise
    await vi.advanceTimersByTimeAsync(0);
    expect(processFn).toHaveBeenCalledTimes(1);
  });

  it('falls through immediately when no taskId', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = vi.fn(() => ({ skip: false, taskId: null, studyId: 'study-1' }));

    queue.enqueue({}, parseFn, processFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(processFn).toHaveBeenCalledTimes(1);
  });

  it('falls through immediately when no studyId', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = vi.fn(() => ({ skip: false, taskId: 'task-1', studyId: null }));

    queue.enqueue({}, parseFn, processFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(processFn).toHaveBeenCalledTimes(1);
  });

  it('continues draining study queue after processFn error', async () => {
    const callOrder = [];
    const failFn = vi.fn(async () => {
      callOrder.push('fail');
      throw new Error('cascade exploded');
    });
    const successFn = vi.fn(async () => {
      callOrder.push('success');
    });
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, failFn);
    queue.enqueue({ taskId: 'task-2', studyId: 'study-1' }, parseFn, successFn);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    expect(callOrder).toEqual(['fail', 'success']);
  });

  it('cleans up maps after all cascades complete', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, processFn);

    expect(queue._debounce.size).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    expect(queue._debounce.size).toBe(0);
    expect(queue._studyLocks.size).toBe(0);
  });

  it('works with debounceMs=0 — immediate queue, serialization still applies', async () => {
    const zeroQueue = new CascadeQueue({ debounceMs: 0 });
    const callOrder = [];
    const slow = vi.fn(async () => {
      callOrder.push('start');
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push('end');
    });
    const parseFn = makeParseFn();

    zeroQueue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, slow);
    zeroQueue.enqueue({ taskId: 'task-2', studyId: 'study-1' }, parseFn, slow);

    // Both timers fire immediately
    await vi.advanceTimersByTimeAsync(0);

    // First started, second queued
    expect(callOrder).toEqual(['start']);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);

    expect(callOrder).toEqual(['start', 'end', 'start']);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);

    expect(callOrder).toEqual(['start', 'end', 'start', 'end']);
    zeroQueue._clearAll();
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('does NOT replace user webhook with bot echo', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'user-edit' }, parseFn, processFn);
    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'bot-echo', editedByBot: true }, parseFn, processFn);

    await vi.advanceTimersByTimeAsync(5000);

    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith(
      expect.objectContaining({ v: 'user-edit' }),
    );
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('DOES replace user webhook with another user webhook', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'edit-1' }, parseFn, processFn);
    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'edit-2' }, parseFn, processFn);

    await vi.advanceTimersByTimeAsync(5000);

    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith(
      expect.objectContaining({ v: 'edit-2' }),
    );
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('bot echo does NOT reset the debounce timer', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'user-edit' }, parseFn, processFn);

    // 3s in, bot echo arrives — should be ignored
    await vi.advanceTimersByTimeAsync(3000);
    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'bot-echo', editedByBot: true }, parseFn, processFn);

    // 2s more (5s total from user edit) — timer should fire with user payload
    await vi.advanceTimersByTimeAsync(2000);

    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith(
      expect.objectContaining({ v: 'user-edit' }),
    );
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('drops consecutive bot echoes — only first enters buffer', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'echo-1', editedByBot: true }, parseFn, processFn);
    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'echo-2', editedByBot: true }, parseFn, processFn);
    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'echo-3', editedByBot: true }, parseFn, processFn);

    await vi.advanceTimersByTimeAsync(5000);

    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith(
      expect.objectContaining({ v: 'echo-1' }),
    );
  });

  // @behavior BEH-DEBOUNCE-ECHO
  it('user webhook replaces a bot webhook in the debounce buffer', async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const parseFn = makeParseFn();

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'bot-first', editedByBot: true }, parseFn, processFn);
    queue.enqueue({ taskId: 'task-1', studyId: 'study-1', v: 'user-edit' }, parseFn, processFn);

    await vi.advanceTimersByTimeAsync(5000);

    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith(
      expect.objectContaining({ v: 'user-edit' }),
    );
  });

  it('getStats reflects current state', () => {
    const parseFn = makeParseFn();
    const processFn = vi.fn().mockResolvedValue(undefined);

    queue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, processFn);
    queue.enqueue({ taskId: 'task-2', studyId: 'study-2' }, parseFn, processFn);

    const stats = queue.getStats();
    expect(stats.debounceSize).toBe(2);
    expect(stats.studyLockCount).toBe(0); // not yet fired
  });

  describe('_drainStudy error recovery (deadlock prevention)', () => {
    it('resets lock.running and deletes study lock when _drainStudy throws', async () => {
      const processFn = vi.fn().mockResolvedValue(undefined);
      const parseFn = makeParseFn();

      queue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, processFn);

      // Before the debounce fires, sabotage _drainStudy so it throws on first call
      const original = queue._drainStudy.bind(queue);
      let callCount = 0;
      queue._drainStudy = async (studyId) => {
        callCount++;
        if (callCount === 1) {
          // Simulate a throw before the while loop — the try/finally inside
          // _drainStudy won't help here because we bypass it entirely,
          // but the outer .catch() on the call site will catch this.
          throw new Error('simulated _drainStudy explosion');
        }
        return original(studyId);
      };

      // Fire the debounce timer — _drainStudy will throw
      await vi.advanceTimersByTimeAsync(5000);
      // Flush microtasks so the .catch() handler runs
      await vi.advanceTimersByTimeAsync(0);

      // The outer .catch() should have cleaned up the lock
      const lock = queue._studyLocks.get('study-1');
      expect(lock).toBeUndefined();
    });

    it('processes new enqueue for the same study after _drainStudy error (no deadlock)', async () => {
      const processFn1 = vi.fn().mockResolvedValue(undefined);
      const processFn2 = vi.fn().mockResolvedValue(undefined);
      const parseFn = makeParseFn();

      queue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, processFn1);

      // Sabotage _drainStudy to throw on first call, then restore normal behavior
      const original = queue._drainStudy.bind(queue);
      let callCount = 0;
      queue._drainStudy = async (studyId) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('simulated _drainStudy explosion');
        }
        return original(studyId);
      };

      // Fire first debounce — _drainStudy throws, .catch() cleans up lock
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);

      // First processFn should NOT have been called (drain blew up before processing)
      expect(processFn1).not.toHaveBeenCalled();

      // Now enqueue a new task for the SAME study — this is the deadlock test.
      // If lock.running was stuck at true, this enqueue would never drain.
      queue.enqueue({ taskId: 'task-2', studyId: 'study-1' }, parseFn, processFn2);

      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);

      // Second processFn should have been called — study is NOT deadlocked
      expect(processFn2).toHaveBeenCalledTimes(1);
      expect(queue._studyLocks.size).toBe(0);
    });
  });

  describe('drain()', () => {
    it('clears pending debounce timers and waits for running cascades', async () => {
      vi.useRealTimers();
      const realQueue = new CascadeQueue({ debounceMs: 0 });
      let resolve1;
      const blocker = new Promise((r) => { resolve1 = r; });
      const slowFn = vi.fn(async () => { await blocker; });
      const parseFn = makeParseFn();

      realQueue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, slowFn);
      // Let the setTimeout(0) fire
      await new Promise((r) => setTimeout(r, 10));

      // task-1 is now running
      expect(realQueue._studyLocks.get('study-1')?.running).toBe(true);

      // Start drain in background
      const drainPromise = realQueue.drain();

      // All debounce timers should be cleared
      expect(realQueue._debounce.size).toBe(0);

      // Unblock the running cascade
      resolve1();
      await drainPromise;

      // Study lock cleaned up
      expect(realQueue._studyLocks.size).toBe(0);
    });

    it('resolves immediately when nothing is running', async () => {
      vi.useRealTimers();
      const emptyQueue = new CascadeQueue({ debounceMs: 5000 });
      await emptyQueue.drain(); // should not hang
    });

    it('respects 8s timeout when cascade hangs', async () => {
      vi.useRealTimers();
      const realQueue = new CascadeQueue({ debounceMs: 0 });
      // Create a cascade that never resolves
      const neverFn = vi.fn(() => new Promise(() => {}));
      const parseFn = makeParseFn();

      realQueue.enqueue({ taskId: 'task-1', studyId: 'study-1' }, parseFn, neverFn);
      await new Promise((r) => setTimeout(r, 10));

      const start = Date.now();
      await realQueue.drain();
      const elapsed = Date.now() - start;

      // Should complete around 8s (drain timeout), not hang forever
      expect(elapsed).toBeGreaterThan(7000);
      expect(elapsed).toBeLessThan(12000);
      realQueue._clearAll();
    }, 15000);
  });
});
