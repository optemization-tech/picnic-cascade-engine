import { describe, it, expect } from 'vitest';
import { computeStatusRollup } from '../../src/engine/status-rollup.js';

describe('computeStatusRollup', () => {
  it('returns Done when all siblings are Done/N/A', () => {
    expect(computeStatusRollup([
      { status: 'Done' },
      { status: 'N/A' },
      { status: 'Done' },
    ])).toBe('Done');
  });

  it('returns In Progress when any sibling is In Progress', () => {
    expect(computeStatusRollup([
      { status: 'Done' },
      { status: 'In Progress' },
      { status: 'Not Started' },
    ])).toBe('In Progress');
  });

  it('returns Not Started otherwise', () => {
    expect(computeStatusRollup([
      { status: 'Not Started' },
      { status: 'Not started' },
    ])).toBe('Not Started');
  });

  // @behavior BEH-STATUS-ROLLUP-PARTIAL-DONE
  it('returns In Progress when at least one sibling is Done but not all are', () => {
    expect(computeStatusRollup([
      { status: 'Done' },
      { status: 'Not Started' },
    ])).toBe('In Progress');
  });

  // @behavior BEH-STATUS-ROLLUP-PARTIAL-DONE
  it('returns In Progress for Meg Apr 30 / May 1 repro (one Done + two Not Started)', () => {
    expect(computeStatusRollup([
      { status: 'Done' },
      { status: 'Not Started' },
      { status: 'Not Started' },
    ])).toBe('In Progress');
  });

  // @behavior BEH-STATUS-ROLLUP-PARTIAL-DONE
  it('treats N/A as Done for partial-done rollup (any N/A + non-complete -> In Progress)', () => {
    expect(computeStatusRollup([
      { status: 'N/A' },
      { status: 'Not Started' },
    ])).toBe('In Progress');
  });

  // @behavior BEH-STATUS-ROLLUP-PARTIAL-DONE
  it('returns In Progress when most siblings are Done but at least one is Not Started', () => {
    expect(computeStatusRollup([
      { status: 'Done' },
      { status: 'Done' },
      { status: 'Not Started' },
    ])).toBe('In Progress');
  });

  it('returns Not Started for empty siblings list', () => {
    expect(computeStatusRollup([])).toBe('Not Started');
  });
});
