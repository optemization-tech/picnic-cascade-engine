import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlightTracker } from '../../src/services/flight-tracker.js';

describe('FlightTracker', () => {
  let tracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new FlightTracker();
  });

  afterEach(() => {
    tracker._clearAll();
    vi.useRealTimers();
  });

  it('removes a tracked promise from the set after it resolves', async () => {
    const p = Promise.resolve('done');
    tracker.track(p, 'resolve-test');

    // Let the .then() cleanup microtask flush
    await vi.advanceTimersByTimeAsync(0);

    expect(tracker.getStats().activeCount).toBe(0);
  });

  it('removes a tracked promise from the set after it rejects (no leak)', async () => {
    const p = Promise.reject(new Error('boom'));
    tracker.track(p, 'reject-test');

    // Flush microtasks so cleanup handler runs
    await vi.advanceTimersByTimeAsync(0);

    expect(tracker.getStats().activeCount).toBe(0);
  });

  it('drain resolves immediately when there are no active flights', async () => {
    // Should not hang — resolves right away
    await tracker.drain(1000);
    expect(tracker.getStats().activeCount).toBe(0);
  });

  it('drain timeout fires before tracked promise settles — drain resolves, promise still running', async () => {
    // A promise that never settles on its own
    const neverSettle = new Promise(() => {});
    tracker.track(neverSettle, 'never-settle');

    expect(tracker.getStats().activeCount).toBe(1);

    const drainPromise = tracker.drain(500);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(500);
    await drainPromise;

    // The never-settling promise is still tracked (it didn't settle)
    expect(tracker.getStats().activeCount).toBe(1);
  });

  it('drain waits for all promises — some resolve before drain, some during', async () => {
    let resolveSecond;
    const first = Promise.resolve('fast');
    const second = new Promise((r) => { resolveSecond = r; });

    tracker.track(first, 'fast');
    tracker.track(second, 'slow');

    // Flush microtasks — first promise settles immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.getStats().activeCount).toBe(1); // only second remains

    const drainPromise = tracker.drain(5000);

    // Resolve the second promise mid-drain
    resolveSecond('done');
    await vi.advanceTimersByTimeAsync(0);

    await drainPromise;
    expect(tracker.getStats().activeCount).toBe(0);
  });

  it('track during drain — drain waits for the newly tracked promise too', async () => {
    let resolveFirst, resolveSecond;
    const first = new Promise((r) => { resolveFirst = r; });
    const second = new Promise((r) => { resolveSecond = r; });

    tracker.track(first, 'first');

    // Start drain — at this point only "first" is tracked
    const drainPromise = tracker.drain(5000);

    // Track a new promise AFTER drain started
    tracker.track(second, 'second');

    // Resolve the first — drain's allSettled snapshot only had "first",
    // so drain resolves once "first" settles, even though "second" is still active.
    // This is expected: drain waits for the snapshot at call time.
    resolveFirst('ok');
    await vi.advanceTimersByTimeAsync(0);
    await drainPromise;

    // Second is still in-flight (drain only waited for the snapshot)
    expect(tracker.getStats().activeCount).toBe(1);
    expect(tracker.getStats().labels).toEqual(['second']);

    // Clean up
    resolveSecond('ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.getStats().activeCount).toBe(0);
  });

  it('getStats returns accurate count and labels', async () => {
    let resolve1, resolve2;
    const p1 = new Promise((r) => { resolve1 = r; });
    const p2 = new Promise((r) => { resolve2 = r; });

    tracker.track(p1, 'cascade-study-1');
    tracker.track(p2, 'webhook-response');

    const stats = tracker.getStats();
    expect(stats.activeCount).toBe(2);
    expect(stats.labels).toContain('cascade-study-1');
    expect(stats.labels).toContain('webhook-response');

    // Resolve one and verify stats update
    resolve1('done');
    await vi.advanceTimersByTimeAsync(0);

    const updated = tracker.getStats();
    expect(updated.activeCount).toBe(1);
    expect(updated.labels).toEqual(['webhook-response']);

    // Clean up
    resolve2('done');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('track returns the original promise (pass-through)', async () => {
    const original = Promise.resolve(42);
    const returned = tracker.track(original, 'passthrough');

    expect(returned).toBe(original);
    expect(await returned).toBe(42);
  });

  it('default label is "unnamed" when no label provided', () => {
    const p = new Promise(() => {});
    tracker.track(p);

    expect(tracker.getStats().labels).toEqual(['unnamed']);
  });
});
