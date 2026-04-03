import { describe, it, expect, vi } from 'vitest';
import { wireRemainingRelations } from '../../src/provisioning/wire-relations.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a mock client with a spied patchBatch method.
 * Records all updates passed to patchBatch for assertion.
 */
function mockClient() {
  const allUpdates = [];
  const client = {
    optimalBatchSize: 50,
    allUpdates,
    patchBatch: vi.fn(async (updates) => {
      allUpdates.push(...updates);
      return { updatedCount: updates.length, taskIds: updates.map((u) => u.taskId) };
    }),
  };
  return client;
}

// ── Parent patching ───────────────────────────────────────────────────────

describe('wireRemainingRelations — parent patching', () => {
  it('resolves template IDs to production IDs for parent relations', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-child': 'prod-child',
      'tpl-parent': 'prod-parent',
    };
    const parentTracking = [
      { templateId: 'tpl-child', templateParentId: 'tpl-parent' },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking: [],
      parentTracking,
    });

    expect(result.parentsPatchedCount).toBe(1);
    expect(result.depsPatchedCount).toBe(0);
    expect(client.patchBatch).toHaveBeenCalledTimes(1);

    const updates = client.allUpdates;
    expect(updates).toHaveLength(1);
    expect(updates[0].taskId).toBe('prod-child');
    expect(updates[0].properties).toEqual({
      'Parent Task': { relation: [{ id: 'prod-parent' }] },
    });
  });

  it('patches multiple parent relations', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-c1': 'prod-c1',
      'tpl-c2': 'prod-c2',
      'tpl-p1': 'prod-p1',
      'tpl-p2': 'prod-p2',
    };
    const parentTracking = [
      { templateId: 'tpl-c1', templateParentId: 'tpl-p1' },
      { templateId: 'tpl-c2', templateParentId: 'tpl-p2' },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking: [],
      parentTracking,
    });

    expect(result.parentsPatchedCount).toBe(2);
    expect(client.allUpdates).toHaveLength(2);
  });
});

// ── Dependency patching ───────────────────────────────────────────────────

describe('wireRemainingRelations — dependency patching', () => {
  it('merges resolved + newly-resolved IDs and deduplicates', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-task': 'prod-task',
      'tpl-blocker-b': 'prod-blocker-b',
    };
    const depTracking = [
      {
        templateId: 'tpl-task',
        resolvedBlockedByIds: ['prod-blocker-a'],
        unresolvedBlockedByTemplateIds: ['tpl-blocker-b'],
      },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking,
      parentTracking: [],
    });

    expect(result.depsPatchedCount).toBe(1);
    expect(result.parentsPatchedCount).toBe(0);

    const updates = client.allUpdates;
    expect(updates).toHaveLength(1);
    expect(updates[0].taskId).toBe('prod-task');
    expect(updates[0].properties).toEqual({
      'Blocked by': {
        relation: [{ id: 'prod-blocker-a' }, { id: 'prod-blocker-b' }],
      },
    });
  });

  it('resolves multiple unresolved blockers', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-task': 'prod-task',
      'tpl-b1': 'prod-b1',
      'tpl-b2': 'prod-b2',
      'tpl-b3': 'prod-b3',
    };
    const depTracking = [
      {
        templateId: 'tpl-task',
        resolvedBlockedByIds: [],
        unresolvedBlockedByTemplateIds: ['tpl-b1', 'tpl-b2', 'tpl-b3'],
      },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking,
      parentTracking: [],
    });

    expect(result.depsPatchedCount).toBe(1);
    const relation = client.allUpdates[0].properties['Blocked by'].relation;
    expect(relation).toHaveLength(3);
    expect(relation).toEqual([
      { id: 'prod-b1' },
      { id: 'prod-b2' },
      { id: 'prod-b3' },
    ]);
  });
});

// ── Mixed patches ─────────────────────────────────────────────────────────

describe('wireRemainingRelations — mixed patches', () => {
  it('handles both parent and dep patches in one call', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-child': 'prod-child',
      'tpl-parent': 'prod-parent',
      'tpl-task': 'prod-task',
      'tpl-blocker': 'prod-blocker',
    };
    const parentTracking = [
      { templateId: 'tpl-child', templateParentId: 'tpl-parent' },
    ];
    const depTracking = [
      {
        templateId: 'tpl-task',
        resolvedBlockedByIds: [],
        unresolvedBlockedByTemplateIds: ['tpl-blocker'],
      },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking,
      parentTracking,
    });

    expect(result.parentsPatchedCount).toBe(1);
    expect(result.depsPatchedCount).toBe(1);
    expect(client.patchBatch).toHaveBeenCalledTimes(1);
    expect(client.allUpdates).toHaveLength(2);

    // Parent patch first, then dep patch
    expect(client.allUpdates[0].properties['Parent Task']).toBeDefined();
    expect(client.allUpdates[1].properties['Blocked by']).toBeDefined();
  });
});

// ── Empty inputs ──────────────────────────────────────────────────────────

describe('wireRemainingRelations — empty inputs', () => {
  it('returns 0/0 when no patches needed', async () => {
    const client = mockClient();

    const result = await wireRemainingRelations(client, {
      idMapping: {},
      depTracking: [],
      parentTracking: [],
    });

    expect(result.parentsPatchedCount).toBe(0);
    expect(result.depsPatchedCount).toBe(0);
    expect(client.patchBatch).not.toHaveBeenCalled();
  });

  it('does not call patchBatch when all tracking entries fail to resolve', async () => {
    const client = mockClient();

    const result = await wireRemainingRelations(client, {
      idMapping: {},
      depTracking: [
        {
          templateId: 'tpl-task',
          resolvedBlockedByIds: [],
          unresolvedBlockedByTemplateIds: ['tpl-missing'],
        },
      ],
      parentTracking: [
        { templateId: 'tpl-child', templateParentId: 'tpl-missing-parent' },
      ],
    });

    expect(result.parentsPatchedCount).toBe(0);
    expect(result.depsPatchedCount).toBe(0);
    expect(client.patchBatch).not.toHaveBeenCalled();
  });
});

// ── Missing mappings ──────────────────────────────────────────────────────

describe('wireRemainingRelations — missing mappings', () => {
  it('skips parent patch when child templateId not in idMapping', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-parent': 'prod-parent',
      // tpl-child intentionally missing
    };
    const parentTracking = [
      { templateId: 'tpl-child', templateParentId: 'tpl-parent' },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking: [],
      parentTracking,
    });

    expect(result.parentsPatchedCount).toBe(0);
    expect(client.patchBatch).not.toHaveBeenCalled();
  });

  it('skips parent patch when parent templateId not in idMapping', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-child': 'prod-child',
      // tpl-parent intentionally missing
    };
    const parentTracking = [
      { templateId: 'tpl-child', templateParentId: 'tpl-parent' },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking: [],
      parentTracking,
    });

    expect(result.parentsPatchedCount).toBe(0);
    expect(client.patchBatch).not.toHaveBeenCalled();
  });

  it('skips dep patch when task templateId not in idMapping', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-blocker': 'prod-blocker',
      // tpl-task intentionally missing
    };
    const depTracking = [
      {
        templateId: 'tpl-task',
        resolvedBlockedByIds: [],
        unresolvedBlockedByTemplateIds: ['tpl-blocker'],
      },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking,
      parentTracking: [],
    });

    expect(result.depsPatchedCount).toBe(0);
    expect(client.patchBatch).not.toHaveBeenCalled();
  });

  it('skips dep patch when no unresolved blockers can be resolved', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-task': 'prod-task',
      // tpl-blocker-x intentionally missing
    };
    const depTracking = [
      {
        templateId: 'tpl-task',
        resolvedBlockedByIds: ['prod-existing'],
        unresolvedBlockedByTemplateIds: ['tpl-blocker-x'],
      },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking,
      parentTracking: [],
    });

    // No newly resolved IDs means no patch needed
    expect(result.depsPatchedCount).toBe(0);
    expect(client.patchBatch).not.toHaveBeenCalled();
  });

  it('resolves some blockers even when others are missing', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-task': 'prod-task',
      'tpl-b1': 'prod-b1',
      // tpl-b2 intentionally missing
    };
    const depTracking = [
      {
        templateId: 'tpl-task',
        resolvedBlockedByIds: [],
        unresolvedBlockedByTemplateIds: ['tpl-b1', 'tpl-b2'],
      },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking,
      parentTracking: [],
    });

    expect(result.depsPatchedCount).toBe(1);
    const relation = client.allUpdates[0].properties['Blocked by'].relation;
    expect(relation).toEqual([{ id: 'prod-b1' }]);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────

describe('wireRemainingRelations — deduplication', () => {
  it('deduplicates when same ID appears in both resolvedBlockedByIds and newly resolved', async () => {
    const client = mockClient();
    // Simulate: prod-blocker was already set inline AND the same blocker
    // template re-resolves to the same production ID
    const idMapping = {
      'tpl-task': 'prod-task',
      'tpl-blocker': 'prod-blocker',
    };
    const depTracking = [
      {
        templateId: 'tpl-task',
        resolvedBlockedByIds: ['prod-blocker'], // already set inline
        unresolvedBlockedByTemplateIds: ['tpl-blocker'], // resolves to same prod-blocker
      },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking,
      parentTracking: [],
    });

    expect(result.depsPatchedCount).toBe(1);
    const relation = client.allUpdates[0].properties['Blocked by'].relation;
    // Should appear only once despite being in both arrays
    expect(relation).toEqual([{ id: 'prod-blocker' }]);
  });

  it('deduplicates across multiple resolved and newly-resolved IDs', async () => {
    const client = mockClient();
    const idMapping = {
      'tpl-task': 'prod-task',
      'tpl-b2': 'prod-b2',
      'tpl-b3': 'prod-b3',
    };
    const depTracking = [
      {
        templateId: 'tpl-task',
        resolvedBlockedByIds: ['prod-b1', 'prod-b2'], // b2 already set
        unresolvedBlockedByTemplateIds: ['tpl-b2', 'tpl-b3'], // b2 resolves to same, b3 is new
      },
    ];

    const result = await wireRemainingRelations(client, {
      idMapping,
      depTracking,
      parentTracking: [],
    });

    expect(result.depsPatchedCount).toBe(1);
    const relation = client.allUpdates[0].properties['Blocked by'].relation;
    const ids = relation.map((r) => r.id);
    // prod-b2 should appear only once
    expect(ids).toEqual(['prod-b1', 'prod-b2', 'prod-b3']);
    expect(ids).toHaveLength(3);
  });
});

// ── Tracer integration ────────────────────────────────────────────────────

describe('wireRemainingRelations — tracer', () => {
  it('calls tracer startPhase/endPhase', async () => {
    const phases = [];
    const tracer = {
      startPhase(name) { phases.push(`start:${name}`); },
      endPhase(name) { phases.push(`end:${name}`); },
    };
    const client = mockClient();

    await wireRemainingRelations(client, {
      idMapping: {},
      depTracking: [],
      parentTracking: [],
      tracer,
    });

    expect(phases).toEqual(['start:wireRemainingRelations', 'end:wireRemainingRelations']);
  });

  it('passes tracer to patchBatch', async () => {
    const tracer = {
      startPhase() {},
      endPhase() {},
    };
    const client = mockClient();
    const idMapping = {
      'tpl-child': 'prod-child',
      'tpl-parent': 'prod-parent',
    };

    await wireRemainingRelations(client, {
      idMapping,
      depTracking: [],
      parentTracking: [{ templateId: 'tpl-child', templateParentId: 'tpl-parent' }],
      tracer,
    });

    expect(client.patchBatch).toHaveBeenCalledWith(
      expect.any(Array),
      { tracer },
    );
  });

  it('works without tracer', async () => {
    const client = mockClient();

    const result = await wireRemainingRelations(client, {
      idMapping: {},
      depTracking: [],
      parentTracking: [],
    });

    expect(result.parentsPatchedCount).toBe(0);
    expect(result.depsPatchedCount).toBe(0);
  });
});
