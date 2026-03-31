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
});
