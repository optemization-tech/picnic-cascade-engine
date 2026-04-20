import { beforeEach, describe, expect, it } from 'vitest';
import { withStudyLock, _resetStudyLocks } from '../../src/services/study-lock.js';

describe('study-lock service', () => {
  beforeEach(() => {
    _resetStudyLocks();
  });

  it('serializes two calls on the same study id (FIFO)', async () => {
    const order = [];
    let resolveFirst;
    const firstGate = new Promise(r => { resolveFirst = r; });

    const p1 = withStudyLock('study-X', async () => {
      order.push('1-start');
      await firstGate;
      order.push('1-end');
    });
    const p2 = withStudyLock('study-X', async () => {
      order.push('2-start');
      order.push('2-end');
    });

    // Second call is queued — only '1-start' should be observed so far.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual(['1-start']);

    resolveFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  it('runs calls on different study ids in parallel', async () => {
    const order = [];
    let resolveA;
    const aGate = new Promise(r => { resolveA = r; });

    const pA = withStudyLock('study-A', async () => {
      order.push('A-start');
      await aGate;
      order.push('A-end');
    });
    const pB = withStudyLock('study-B', async () => {
      order.push('B-start');
      order.push('B-end');
    });

    // study-B should progress while study-A is still blocked.
    await pB;
    expect(order).toContain('B-start');
    expect(order).toContain('B-end');
    expect(order).not.toContain('A-end');

    resolveA();
    await pA;
    expect(order).toContain('A-end');
  });

  it('releases the lock when the inner fn rejects; queued work still runs', async () => {
    const order = [];

    const p1 = withStudyLock('study-X', async () => {
      order.push('1-start');
      throw new Error('boom');
    });
    const p2 = withStudyLock('study-X', async () => {
      order.push('2-start');
    });

    await expect(p1).rejects.toThrow('boom');
    await p2;
    expect(order).toEqual(['1-start', '2-start']);
  });

  it('is shared across routes — both inception and add-task-set see the same lock map', async () => {
    // Import both routes' withStudyLock references. They should be the same
    // function (same module) and share the internal _studyLocks Map — so a
    // study acquired by one "caller" blocks the other.
    const { withStudyLock: wsl1 } = await import('../../src/services/study-lock.js');
    const { withStudyLock: wsl2 } = await import('../../src/services/study-lock.js');
    expect(wsl1).toBe(wsl2);

    const order = [];
    let resolveFirst;
    const firstGate = new Promise(r => { resolveFirst = r; });

    // "Route 1" acquires the lock
    const p1 = wsl1('study-shared', async () => {
      order.push('route1-start');
      await firstGate;
      order.push('route1-end');
    });
    // "Route 2" tries the same study via a separate import site
    const p2 = wsl2('study-shared', async () => {
      order.push('route2-start');
    });

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual(['route1-start']);

    resolveFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['route1-start', 'route1-end', 'route2-start']);
  });
});
