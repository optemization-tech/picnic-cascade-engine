import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UndoStore } from '../../src/services/undo-store.js';

describe('UndoStore', () => {
  let store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new UndoStore({ ttlMs: 5000 });
  });

  afterEach(() => {
    store._clearAll();
    vi.useRealTimers();
  });

  const manifest = {
    'task-a': { oldStart: '2026-04-01', oldEnd: '2026-04-02', newStart: '2026-04-03', newEnd: '2026-04-04' },
    'task-b': { oldStart: '2026-04-05', oldEnd: '2026-04-06', newStart: '2026-04-07', newEnd: '2026-04-08' },
  };

  it('save + pop returns manifest without timer', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'Task 1', cascadeMode: 'push-right', manifest });
    const entry = store.pop('study-1');
    expect(entry).toEqual({
      cascadeId: 'c1',
      sourceTaskId: 't1',
      sourceTaskName: 'Task 1',
      cascadeMode: 'push-right',
      manifest,
      timestamp: expect.any(Number),
    });
    expect(entry).not.toHaveProperty('timer');
  });

  it('pop clears entry — second pop returns null', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });
    store.pop('study-1');
    expect(store.pop('study-1')).toBeNull();
  });

  it('pop returns null when no entry exists', () => {
    expect(store.pop('nonexistent')).toBeNull();
  });

  it('TTL expiry removes entry', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });
    vi.advanceTimersByTime(5001);
    expect(store.pop('study-1')).toBeNull();
  });

  it('new cascade overwrites previous (only latest undoable)', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'First', cascadeMode: 'push-right', manifest });
    const newManifest = { 'task-x': { oldStart: '2026-05-01', oldEnd: '2026-05-02', newStart: '2026-05-03', newEnd: '2026-05-04' } };
    store.save('study-1', { cascadeId: 'c2', sourceTaskId: 't2', sourceTaskName: 'Second', cascadeMode: 'pull-left', manifest: newManifest });

    const entry = store.pop('study-1');
    expect(entry.cascadeId).toBe('c2');
    expect(entry.sourceTaskName).toBe('Second');
    expect(entry.manifest).toEqual(newManifest);
  });

  it('different studies are independent', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'S1', cascadeMode: 'push-right', manifest });
    store.save('study-2', { cascadeId: 'c2', sourceTaskId: 't2', sourceTaskName: 'S2', cascadeMode: 'pull-left', manifest });

    const e1 = store.pop('study-1');
    expect(e1.cascadeId).toBe('c1');
    const e2 = store.pop('study-2');
    expect(e2.cascadeId).toBe('c2');
  });

  it('overwrite clears previous timer (no double-delete)', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });
    // Save again at t=3s — should reset the 5s TTL
    vi.advanceTimersByTime(3000);
    store.save('study-1', { cascadeId: 'c2', sourceTaskId: 't2', sourceTaskName: 'T2', cascadeMode: 'pull-left', manifest });

    // At t=5s (original TTL would fire), entry should still exist
    vi.advanceTimersByTime(2000);
    expect(store.pop('study-1')).not.toBeNull();

    // Re-save since pop consumed it, advance past new TTL
    store.save('study-1', { cascadeId: 'c3', sourceTaskId: 't3', sourceTaskName: 'T3', cascadeMode: 'pull-left', manifest });
    vi.advanceTimersByTime(5001);
    expect(store.pop('study-1')).toBeNull();
  });

  it('_clearAll removes all entries and timers', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });
    store.save('study-2', { cascadeId: 'c2', sourceTaskId: 't2', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });
    store._clearAll();
    expect(store.pop('study-1')).toBeNull();
    expect(store.pop('study-2')).toBeNull();
  });
});
