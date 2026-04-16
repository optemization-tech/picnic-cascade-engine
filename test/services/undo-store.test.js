import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UndoStore } from '../../src/services/undo-store.js';

describe('UndoStore', () => {
  let store;

  beforeEach(() => {
    store = new UndoStore();
  });

  afterEach(() => {
    store._clearAll();
  });

  const manifest = {
    'task-a': { oldStart: '2026-04-01', oldEnd: '2026-04-02', newStart: '2026-04-03', newEnd: '2026-04-04' },
    'task-b': { oldStart: '2026-04-05', oldEnd: '2026-04-06', newStart: '2026-04-07', newEnd: '2026-04-08' },
  };

  it('save + peek returns entry', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'Task 1', cascadeMode: 'push-right', manifest });
    const entry = store.peek('study-1');
    expect(entry).toEqual({
      cascadeId: 'c1',
      sourceTaskId: 't1',
      sourceTaskName: 'Task 1',
      cascadeMode: 'push-right',
      manifest,
      timestamp: expect.any(Number),
    });
  });

  it('save + pop returns entry and removes it', () => {
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
  });

  it('pop clears entry — second pop returns null', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });
    store.pop('study-1');
    expect(store.pop('study-1')).toBeNull();
  });

  it('peek returns null when no entry exists', () => {
    expect(store.peek('nonexistent')).toBeNull();
  });

  it('pop returns null when no entry exists', () => {
    expect(store.pop('nonexistent')).toBeNull();
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

  it('entry persists indefinitely — no TTL expiry', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });

    // Entry should still be available regardless of elapsed time
    const entry = store.peek('study-1');
    expect(entry).not.toBeNull();
    expect(entry.cascadeId).toBe('c1');
  });

  it('_clearAll removes all entries', () => {
    store.save('study-1', { cascadeId: 'c1', sourceTaskId: 't1', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });
    store.save('study-2', { cascadeId: 'c2', sourceTaskId: 't2', sourceTaskName: 'T', cascadeMode: 'push-right', manifest });
    store._clearAll();
    expect(store.pop('study-1')).toBeNull();
    expect(store.pop('study-2')).toBeNull();
  });
});
