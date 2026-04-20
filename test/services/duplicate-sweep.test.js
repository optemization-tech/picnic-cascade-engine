import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    // sweepGraceMs is explicitly overridden in each run() call via graceMs: 0,
    // so the value here only matters as a safety net if a test omits graceMs.
    sweepGraceMs: 45000,
  },
}));

const { run } = await import('../../src/services/duplicate-sweep.js');
const { CascadeTracer } = await import('../../src/services/cascade-tracer.js');

// Test harness note: passing `graceMs: 0` bypasses the 45s grace delay. Tests
// never touch `config.sweepGraceMs` directly because it's validated in other
// paths (config tests). The public `run({ graceMs })` param is the explicit
// override per document-review finding on test harness mechanism.

function makePage(id, tsid) {
  return {
    id,
    properties: {
      'Template Source ID': {
        rich_text: [{ plain_text: tsid, text: { content: tsid } }],
      },
    },
  };
}

describe('duplicate-sweep service', () => {
  let notionClient;
  let tracer;

  beforeEach(() => {
    vi.useFakeTimers();
    notionClient = {
      queryDatabase: vi.fn(),
      archivePage: vi.fn().mockResolvedValue({ archived: true }),
    };
    tracer = new CascadeTracer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // Happy — no duplicates
  it('no duplicates: queries but archives nothing', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
      makePage('page-b', 'tsid-2'),
    ]);

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a', 'page-b']),
      tsids: ['tsid-1', 'tsid-2'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.queryDatabase).toHaveBeenCalledWith(
      'db-tasks',
      { property: 'Study', relation: { contains: 'study-1' } },
      100,
      expect.objectContaining({ tracer }),
    );
    expect(notionClient.archivePage).not.toHaveBeenCalled();
    expect(tracer.counters.get('sweepDuplicatesFound') || 0).toBe(0);
    expect(tracer.counters.get('sweepDuplicatesArchived') || 0).toBe(0);
  });

  // Happy — one duplicate
  it('one duplicate: archives the extra and records tracer', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
      makePage('page-a-dup', 'tsid-1'),
      makePage('page-b', 'tsid-2'),
    ]);

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a', 'page-b']),
      tsids: ['tsid-1', 'tsid-2'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.archivePage).toHaveBeenCalledTimes(1);
    expect(notionClient.archivePage).toHaveBeenCalledWith('page-a-dup', expect.objectContaining({ tracer }));
    expect(tracer.counters.get('sweepDuplicatesFound')).toBe(1);
    expect(tracer.counters.get('sweepDuplicatesArchived')).toBe(1);
    expect(tracer.sweepArchivedIds).toEqual([{ tsid: 'tsid-1', pageId: 'page-a-dup' }]);
  });

  // Happy — multiple TSIDs with duplicates
  it('multiple TSIDs with duplicates: archives all extras', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
      makePage('page-a-dup', 'tsid-1'),
      makePage('page-b', 'tsid-2'),
      makePage('page-b-dup', 'tsid-2'),
      makePage('page-c', 'tsid-3'),
      makePage('page-c-dup', 'tsid-3'),
    ]);

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a', 'page-b', 'page-c']),
      tsids: ['tsid-1', 'tsid-2', 'tsid-3'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.archivePage).toHaveBeenCalledTimes(3);
    expect(tracer.counters.get('sweepDuplicatesFound')).toBe(3);
    expect(tracer.counters.get('sweepDuplicatesArchived')).toBe(3);
    expect(tracer.sweepArchivedIds.map((r) => r.pageId).sort()).toEqual([
      'page-a-dup', 'page-b-dup', 'page-c-dup',
    ]);
  });

  // Edge — duplicate's ID happens to be in trackedIds (defensive)
  it('defensively: does not archive pages in trackedIds even if multiple exist', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
      makePage('page-a-alt', 'tsid-1'),
    ]);

    // Both IDs are tracked — e.g., race in tests — nothing archived
    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a', 'page-a-alt']),
      tsids: ['tsid-1'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.archivePage).not.toHaveBeenCalled();
  });

  // Edge — TSID not in tsids (stale DB entry from a different run)
  it('skips TSIDs not in the runs tsids param', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
      makePage('page-a-dup', 'tsid-1'),
      // tsid-999 belongs to a previous run; not this sweeps concern
      makePage('page-stale', 'tsid-999'),
      makePage('page-stale-dup', 'tsid-999'),
    ]);

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a']),
      tsids: ['tsid-1'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.archivePage).toHaveBeenCalledTimes(1);
    expect(notionClient.archivePage).toHaveBeenCalledWith('page-a-dup', expect.any(Object));
    // tsid-999 duplicates left alone
  });

  // Error — query fails
  it('query fails: records sweepQueryFailed and returns (non-fatal)', async () => {
    notionClient.queryDatabase.mockRejectedValue(new Error('Notion 500'));

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a']),
      tsids: ['tsid-1'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.archivePage).not.toHaveBeenCalled();
    expect(tracer.counters.get('sweepQueryFailed')).toBe(1);
    expect(tracer.metadata.get('sweepQueryError')).toContain('Notion 500');
  });

  // Error — archive fails for one, others succeed
  it('archive fails for one: records sweepDuplicatesFailed, continues with others', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
      makePage('page-a-dup', 'tsid-1'),
      makePage('page-b', 'tsid-2'),
      makePage('page-b-dup', 'tsid-2'),
    ]);
    notionClient.archivePage
      .mockRejectedValueOnce(new Error('Notion 403'))
      .mockResolvedValueOnce({ archived: true });

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a', 'page-b']),
      tsids: ['tsid-1', 'tsid-2'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.archivePage).toHaveBeenCalledTimes(2);
    expect(tracer.counters.get('sweepDuplicatesFound')).toBe(2);
    expect(tracer.counters.get('sweepDuplicatesArchived')).toBe(1);
    expect(tracer.counters.get('sweepDuplicatesFailed')).toBe(1);
    expect(tracer.sweepFailedArchives[0].error).toContain('Notion 403');
  });

  // Edge — empty tsids: no query
  it('empty tsids: does not query or archive', async () => {
    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(),
      tsids: [],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.queryDatabase).not.toHaveBeenCalled();
    expect(notionClient.archivePage).not.toHaveBeenCalled();
  });

  // Edge — missing TSID on a page (ignored gracefully)
  it('pages with no TSID are ignored when grouping', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
      makePage('page-a-dup', 'tsid-1'),
      { id: 'page-orphan', properties: {} }, // No Template Source ID
    ]);

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a']),
      tsids: ['tsid-1'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    expect(notionClient.archivePage).toHaveBeenCalledTimes(1);
    expect(notionClient.archivePage).toHaveBeenCalledWith('page-a-dup', expect.any(Object));
  });

  // Edge — graceMs=0 completes fast (verified by fake timers not being advanced)
  it('graceMs=0 completes without waiting', async () => {
    notionClient.queryDatabase.mockResolvedValue([]);

    // Use real timers for this test — we want to confirm sleep is skipped
    vi.useRealTimers();
    const start = Date.now();
    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(),
      tsids: ['tsid-x'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200); // Way under 45s, and under any reasonable grace delay
  });

  // Edge — tracer emits sweepStats in Activity Log details when sweep acted
  it('tracer.toActivityLogDetails includes sweepStats when duplicates found', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
      makePage('page-a-dup', 'tsid-1'),
    ]);

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a']),
      tsids: ['tsid-1'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    const details = tracer.toActivityLogDetails();
    expect(details.sweepStats).toBeDefined();
    expect(details.sweepStats.duplicatesFound).toBe(1);
    expect(details.sweepStats.duplicatesArchived).toBe(1);
    expect(details.sweepStats.archivedIds).toEqual([{ tsid: 'tsid-1', pageId: 'page-a-dup' }]);
  });

  it('tracer.toActivityLogDetails omits sweepStats when sweep was clean', async () => {
    notionClient.queryDatabase.mockResolvedValue([
      makePage('page-a', 'tsid-1'),
    ]);

    await run({
      studyPageId: 'study-1',
      trackedIds: new Set(['page-a']),
      tsids: ['tsid-1'],
      tracer,
      notionClient,
      studyTasksDbId: 'db-tasks',
      graceMs: 0,
    });

    const details = tracer.toActivityLogDetails();
    expect(details.sweepStats).toBeUndefined();
  });
});
