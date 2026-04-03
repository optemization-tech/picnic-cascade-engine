import { describe, it, expect, beforeEach, vi } from 'vitest';
import { copyBlocks, stripNullValues, cleanBlock } from '../../src/provisioning/copy-blocks.js';

// --- Helpers ---

function makeBlock(type, data = {}, overrides = {}) {
  return { id: overrides.id || 'block-id-will-be-stripped', type, [type]: data, ...overrides };
}

function mockClient({ blocksByPage = {}, appendErrors = {} } = {}) {
  const calls = { request: [], reportStatus: [] };

  return {
    calls,
    request: vi.fn(async (method, path, body) => {
      calls.request.push({ method, path, body });

      // GET blocks
      if (method === 'GET' && path.includes('/children')) {
        const pageId = path.split('/blocks/')[1].split('/')[0];
        const blocks = blocksByPage[pageId] || [];
        return { results: blocks, has_more: false, next_cursor: null };
      }

      // PATCH append children
      if (method === 'PATCH' && path.includes('/children')) {
        const pageId = path.split('/blocks/')[1].split('/')[0];
        if (appendErrors[pageId]) {
          throw new Error(appendErrors[pageId]);
        }
        return { results: body.children };
      }

      return {};
    }),
    reportStatus: vi.fn(async (studyId, level, message) => {
      calls.reportStatus.push({ studyId, level, message });
    }),
  };
}

// --- stripNullValues ---

describe('stripNullValues', () => {
  it('strips null values from flat object', () => {
    expect(stripNullValues({ a: 1, b: null, c: 'ok' })).toEqual({ a: 1, c: 'ok' });
  });

  it('strips undefined values from flat object', () => {
    expect(stripNullValues({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('recursively strips nulls from nested objects', () => {
    const input = {
      icon: null,
      heading_2: {
        rich_text: [{ text: { content: 'Hello' } }],
        color: null,
        is_toggleable: false,
      },
    };
    const result = stripNullValues(input);
    expect(result).toEqual({
      heading_2: {
        rich_text: [{ text: { content: 'Hello' } }],
        is_toggleable: false,
      },
    });
  });

  it('handles arrays (filters undefined elements from map)', () => {
    const input = [1, null, 3, undefined];
    expect(stripNullValues(input)).toEqual([1, 3]);
  });

  it('returns undefined for null input', () => {
    expect(stripNullValues(null)).toBeUndefined();
  });

  it('passes through primitives', () => {
    expect(stripNullValues(42)).toBe(42);
    expect(stripNullValues('hello')).toBe('hello');
    expect(stripNullValues(false)).toBe(false);
  });
});

// --- cleanBlock ---

describe('cleanBlock', () => {
  it('strips the block id from block data', () => {
    const block = makeBlock('paragraph', {
      id: 'inner-id',
      rich_text: [{ text: { content: 'Hello' } }],
      color: 'default',
    });
    const result = cleanBlock(block);
    expect(result.type).toBe('paragraph');
    expect(result.paragraph.id).toBeUndefined();
    expect(result.paragraph.rich_text).toEqual([{ text: { content: 'Hello' } }]);
  });

  it('strips null values from block data (icon:null fix)', () => {
    const block = makeBlock('callout', {
      rich_text: [{ text: { content: 'Note' } }],
      icon: null,
      color: 'gray_background',
    });
    const result = cleanBlock(block);
    expect(result.callout.icon).toBeUndefined();
    expect(result.callout.rich_text).toEqual([{ text: { content: 'Note' } }]);
    expect(result.callout.color).toBe('gray_background');
  });

  it('provides { rich_text: [] } for empty block data', () => {
    const block = makeBlock('paragraph', {});
    const result = cleanBlock(block);
    expect(result.paragraph).toEqual({ rich_text: [] });
  });

  it('provides {} for empty divider block', () => {
    const block = makeBlock('divider', {});
    const result = cleanBlock(block);
    expect(result.divider).toEqual({});
  });

  it('provides { rich_text: [] } for block with null data', () => {
    const block = { type: 'heading_1', heading_1: null };
    const result = cleanBlock(block);
    expect(result.heading_1).toEqual({ rich_text: [] });
  });

  it('renames text -> rich_text for rich text block types', () => {
    const block = makeBlock('paragraph', {
      text: [{ text: { content: 'Hello' } }],
    });
    const result = cleanBlock(block);
    expect(result.paragraph.rich_text).toEqual([{ text: { content: 'Hello' } }]);
    expect(result.paragraph.text).toBeUndefined();
  });

  it('does NOT rename text -> rich_text if rich_text already exists', () => {
    const block = makeBlock('paragraph', {
      rich_text: [{ text: { content: 'Real' } }],
      text: [{ text: { content: 'Old' } }],
    });
    const result = cleanBlock(block);
    expect(result.paragraph.rich_text).toEqual([{ text: { content: 'Real' } }]);
  });

  it('renames text -> rich_text for heading types', () => {
    for (const type of ['heading_1', 'heading_2', 'heading_3']) {
      const block = makeBlock(type, { text: [{ text: { content: 'Title' } }] });
      const result = cleanBlock(block);
      expect(result[type].rich_text).toEqual([{ text: { content: 'Title' } }]);
      expect(result[type].text).toBeUndefined();
    }
  });

  it('does NOT rename text for non-rich-text block types', () => {
    const block = makeBlock('image', { text: 'something', file: { url: 'https://x.com' } });
    const result = cleanBlock(block);
    // text should remain since image is not a rich text block type
    expect(result.image.text).toBe('something');
  });
});

// --- copyBlocks ---

describe('copyBlocks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('copies blocks from template pages to production pages', async () => {
    const blocks = [
      makeBlock('paragraph', { rich_text: [{ text: { content: 'Hello' } }] }),
      makeBlock('heading_2', { rich_text: [{ text: { content: 'Title' } }] }),
    ];
    const client = mockClient({
      blocksByPage: { 'tpl-1': blocks },
    });

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test Study',
    });

    expect(result.blocksWrittenCount).toBe(2);
    expect(result.pagesProcessed).toBe(1);
    expect(result.pagesSkipped).toBe(0);

    // Verify the append call
    const appendCall = client.calls.request.find(
      (c) => c.method === 'PATCH' && c.path.includes('prod-1'),
    );
    expect(appendCall).toBeTruthy();
    expect(appendCall.body.children).toHaveLength(2);
    // Block IDs should be stripped
    for (const child of appendCall.body.children) {
      expect(child[child.type].id).toBeUndefined();
    }
  });

  it('filters out unsupported block types but resolves synced_block', async () => {
    const syncedSourceBlocks = [
      makeBlock('paragraph', { rich_text: [{ text: { content: 'From synced' } }] }),
    ];
    const blocks = [
      makeBlock('paragraph', { rich_text: [{ text: { content: 'Keep me' } }] }),
      makeBlock('child_database', { title: 'DB' }),
      makeBlock('child_page', { title: 'Page' }),
      makeBlock('link_preview', { url: 'https://example.com' }),
      makeBlock('unsupported', {}),
      makeBlock('table_of_contents', {}),
      makeBlock('breadcrumb', {}),
      makeBlock('column_list', {}),
      makeBlock('column', {}),
      makeBlock('synced_block', { synced_from: { block_id: 'sync-source' } }, { id: 'sb-1' }),
      makeBlock('heading_1', { rich_text: [{ text: { content: 'Also keep' } }] }),
    ];
    const client = mockClient({
      blocksByPage: {
        'tpl-1': blocks,
        'sync-source': syncedSourceBlocks,
      },
    });

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    // 3 blocks: paragraph + synced paragraph + heading_1
    expect(result.blocksWrittenCount).toBe(3);
    const appendCall = client.calls.request.find(
      (c) => c.method === 'PATCH' && c.path.includes('prod-1'),
    );
    expect(appendCall.body.children).toHaveLength(3);
    expect(appendCall.body.children[0].type).toBe('paragraph');
    expect(appendCall.body.children[1].type).toBe('paragraph');
    expect(appendCall.body.children[1].paragraph.rich_text[0].text.content).toBe('From synced');
    expect(appendCall.body.children[2].type).toBe('heading_1');
  });

  it('resolves synced blocks with syncCache (shared across pages)', async () => {
    const syncedSourceBlocks = [
      makeBlock('paragraph', { rich_text: [{ text: { content: 'Shared content' } }] }),
    ];
    // Both pages reference the same synced block source
    const blocks1 = [
      makeBlock('synced_block', { synced_from: { block_id: 'shared-sync' } }, { id: 'sb-1' }),
    ];
    const blocks2 = [
      makeBlock('synced_block', { synced_from: { block_id: 'shared-sync' } }, { id: 'sb-2' }),
    ];
    const client = mockClient({
      blocksByPage: {
        'tpl-1': blocks1,
        'tpl-2': blocks2,
        'shared-sync': syncedSourceBlocks,
      },
    });

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1', 'tpl-2': 'prod-2' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
      concurrency: 1, // Sequential to test cache correctly
    });

    expect(result.blocksWrittenCount).toBe(2);
    expect(result.pagesProcessed).toBe(2);

    // The sync source should only be fetched ONCE (cached)
    const syncFetches = client.calls.request.filter(
      (c) => c.method === 'GET' && c.path.includes('shared-sync'),
    );
    expect(syncFetches).toHaveLength(1);
  });

  it('handles nested synced blocks (one level deep)', async () => {
    const innerBlocks = [
      makeBlock('paragraph', { rich_text: [{ text: { content: 'Nested content' } }] }),
    ];
    const outerBlocks = [
      makeBlock('synced_block', { synced_from: { block_id: 'inner-sync' } }, { id: 'nested-sb' }),
    ];
    const pageBlocks = [
      makeBlock('synced_block', { synced_from: { block_id: 'outer-sync' } }, { id: 'page-sb' }),
    ];
    const client = mockClient({
      blocksByPage: {
        'tpl-1': pageBlocks,
        'outer-sync': outerBlocks,
        'inner-sync': innerBlocks,
      },
    });

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    expect(result.blocksWrittenCount).toBe(1);
    expect(result.pagesProcessed).toBe(1);
    const appendCall = client.calls.request.find(
      (c) => c.method === 'PATCH' && c.path.includes('prod-1'),
    );
    expect(appendCall.body.children[0].paragraph.rich_text[0].text.content).toBe('Nested content');
  });

  it('handles original synced blocks (synced_from is null, uses block.id)', async () => {
    const originalChildren = [
      makeBlock('paragraph', { rich_text: [{ text: { content: 'Original content' } }] }),
    ];
    const pageBlocks = [
      makeBlock('synced_block', { synced_from: null }, { id: 'original-sync-id' }),
    ];
    const client = mockClient({
      blocksByPage: {
        'tpl-1': pageBlocks,
        'original-sync-id': originalChildren,
      },
    });

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    expect(result.blocksWrittenCount).toBe(1);
    expect(result.pagesProcessed).toBe(1);
  });

  it('gracefully handles synced block fetch failure', async () => {
    const pageBlocks = [
      makeBlock('synced_block', { synced_from: { block_id: 'missing-sync' } }, { id: 'sb-1' }),
      makeBlock('paragraph', { rich_text: [{ text: { content: 'Still here' } }] }),
    ];
    // missing-sync is NOT in blocksByPage — fetchAllBlocks will return []
    const client = mockClient({
      blocksByPage: {
        'tpl-1': pageBlocks,
        // 'missing-sync' intentionally missing — will return empty
      },
    });

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    // Only the paragraph survives (synced block resolved to empty)
    expect(result.blocksWrittenCount).toBe(1);
    expect(result.pagesProcessed).toBe(1);
  });

  it('caps blocks at 100 per page', async () => {
    const blocks = Array.from({ length: 120 }, (_, i) =>
      makeBlock('paragraph', { rich_text: [{ text: { content: `Block ${i}` } }] }),
    );
    const client = mockClient({ blocksByPage: { 'tpl-1': blocks } });

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    expect(result.blocksWrittenCount).toBe(100);
    const appendCall = client.calls.request.find(
      (c) => c.method === 'PATCH' && c.path.includes('prod-1'),
    );
    expect(appendCall.body.children).toHaveLength(100);
  });

  it('isolates errors — one page fails, others succeed', async () => {
    const goodBlocks = [makeBlock('paragraph', { rich_text: [{ text: { content: 'Good' } }] })];
    const badBlocks = [makeBlock('paragraph', { rich_text: [{ text: { content: 'Bad' } }] })];

    const client = mockClient({
      blocksByPage: {
        'tpl-good': goodBlocks,
        'tpl-bad': badBlocks,
        'tpl-also-good': goodBlocks,
      },
      appendErrors: {
        'prod-bad': 'Notion API 400: validation_error',
      },
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await copyBlocks(client, {
      'tpl-good': 'prod-good',
      'tpl-bad': 'prod-bad',
      'tpl-also-good': 'prod-also-good',
    }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    expect(result.pagesProcessed).toBe(2);
    expect(result.pagesSkipped).toBe(1);
    expect(result.blocksWrittenCount).toBe(2);

    // Verify error was logged
    const errorLog = consoleSpy.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('copy_blocks_page_error'),
    );
    expect(errorLog).toBeTruthy();

    consoleSpy.mockRestore();
  });

  it('skips pages with empty blocks', async () => {
    const client = mockClient({ blocksByPage: { 'tpl-1': [] } });

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    expect(result.pagesProcessed).toBe(0);
    expect(result.pagesSkipped).toBe(1);
    expect(result.blocksWrittenCount).toBe(0);
  });

  it('reports progress every 50 pages', async () => {
    const idMapping = {};
    const blocksByPage = {};
    for (let i = 0; i < 51; i++) {
      const tplId = `tpl-${i}`;
      const prodId = `prod-${i}`;
      idMapping[tplId] = prodId;
      blocksByPage[tplId] = [
        makeBlock('paragraph', { rich_text: [{ text: { content: `Block ${i}` } }] }),
      ];
    }
    const client = mockClient({ blocksByPage });

    const result = await copyBlocks(client, idMapping, {
      studyPageId: 'study-1',
      studyName: 'Test',
      concurrency: 10,
    });

    expect(result.pagesProcessed).toBe(51);
    expect(result.blocksWrittenCount).toBe(51);

    // reportStatus should have been called at the 50-page mark
    expect(client.reportStatus).toHaveBeenCalledTimes(1);
    expect(client.reportStatus.mock.calls[0][2]).toContain('50/51');
  });

  it('returns correct counts with empty idMapping', async () => {
    const client = mockClient();
    const result = await copyBlocks(client, {}, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    expect(result.blocksWrittenCount).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.pagesSkipped).toBe(0);
  });

  it('handles null idMapping gracefully', async () => {
    const client = mockClient();
    const result = await copyBlocks(client, null, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    expect(result.blocksWrittenCount).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.pagesSkipped).toBe(0);
  });

  it('handles pagination when fetching blocks', async () => {
    const page1Blocks = [
      makeBlock('paragraph', { rich_text: [{ text: { content: 'Page 1' } }] }),
    ];
    const page2Blocks = [
      makeBlock('heading_1', { rich_text: [{ text: { content: 'Page 2' } }] }),
    ];

    let callCount = 0;
    const client = {
      request: vi.fn(async (method, path) => {
        if (method === 'GET' && path.includes('/children')) {
          callCount++;
          if (callCount === 1) {
            return { results: page1Blocks, has_more: true, next_cursor: 'cursor-2' };
          }
          return { results: page2Blocks, has_more: false, next_cursor: null };
        }
        // PATCH append
        return { results: [] };
      }),
      reportStatus: vi.fn(),
    };

    const result = await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    expect(result.blocksWrittenCount).toBe(2);
    expect(result.pagesProcessed).toBe(1);

    // Should have made 2 GET calls (paginated) + 1 PATCH call
    const getCalls = client.request.mock.calls.filter((c) => c[0] === 'GET');
    expect(getCalls).toHaveLength(2);
    expect(getCalls[1][1]).toContain('start_cursor=cursor-2');
  });

  it('uses tracer copyBlocks phase', async () => {
    const blocks = [makeBlock('paragraph', { rich_text: [] })];
    const client = mockClient({ blocksByPage: { 'tpl-1': blocks } });
    const tracer = { startPhase: vi.fn(), endPhase: vi.fn(), recordRetry: vi.fn() };

    await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
      tracer,
    });

    expect(tracer.startPhase).toHaveBeenCalledWith('copyBlocks');
    expect(tracer.endPhase).toHaveBeenCalledWith('copyBlocks');
  });

  it('null-strips block data before appending (icon:null regression)', async () => {
    const blocks = [
      makeBlock('callout', {
        rich_text: [{ text: { content: 'Important' } }],
        icon: null,
        color: 'gray_background',
      }),
    ];
    const client = mockClient({ blocksByPage: { 'tpl-1': blocks } });

    await copyBlocks(client, { 'tpl-1': 'prod-1' }, {
      studyPageId: 'study-1',
      studyName: 'Test',
    });

    const appendCall = client.calls.request.find(
      (c) => c.method === 'PATCH' && c.path.includes('prod-1'),
    );
    const calloutData = appendCall.body.children[0].callout;
    expect(calloutData.icon).toBeUndefined();
    expect(calloutData.rich_text).toEqual([{ text: { content: 'Important' } }]);
  });

  it('processes pages in parallel batches with concurrency', async () => {
    const blocksByPage = {};
    const idMapping = {};
    for (let i = 0; i < 10; i++) {
      blocksByPage[`tpl-${i}`] = [
        makeBlock('paragraph', { rich_text: [{ text: { content: `Block ${i}` } }] }),
      ];
      idMapping[`tpl-${i}`] = `prod-${i}`;
    }

    const client = mockClient({ blocksByPage });

    const result = await copyBlocks(client, idMapping, {
      studyPageId: 'study-1',
      studyName: 'Test',
      concurrency: 3,
    });

    expect(result.pagesProcessed).toBe(10);
    expect(result.blocksWrittenCount).toBe(10);
  });
});
