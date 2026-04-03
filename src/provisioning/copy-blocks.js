/**
 * copy-blocks — copies page content blocks from Blueprint template pages
 * to newly created production task pages.
 *
 * Ported from n8n "Process All Blocks" Code node (v3 2026-04-02).
 * Key behaviors:
 *   - Resolves synced blocks by fetching their children and inlining them
 *   - Shared syncCache across all pages (avoids re-fetching same source block)
 *   - Handles nested synced blocks (one level deep)
 *   - Renames block.text -> block.rich_text for rich text block types
 *   - Processes pages in parallel batches for token rotation utilization
 */

const UNSUPPORTED_BLOCK_TYPES = new Set([
  'child_database',
  'child_page',
  'link_preview',
  'unsupported',
  'table_of_contents',
  'breadcrumb',
  'column_list',
  'column',
  // NOTE: synced_block is NOT here — we resolve them into real blocks
]);

const RICH_TEXT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
]);

const MAX_BLOCKS_PER_APPEND = 100;
const PROGRESS_INTERVAL = 50;
const DEFAULT_CONCURRENCY = 5;

/**
 * Recursively strips null and undefined values from an object.
 * Fixes the "icon should be object or undefined, instead was null" 400 error
 * from the Notion API.
 */
export function stripNullValues(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    return obj.map(stripNullValues).filter((v) => v !== undefined);
  }
  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      const stripped = stripNullValues(value);
      if (stripped !== undefined) {
        cleaned[key] = stripped;
      }
    }
    return cleaned;
  }
  return obj;
}

/**
 * Cleans a single block for the Notion append API:
 * - Keeps only { type, [type]: blockData }
 * - Strips the block-level `id`
 * - Strips null values recursively
 * - Renames `text` -> `rich_text` for rich text block types (Notion API inconsistency)
 * - Provides minimum valid structure for empty blocks
 */
export function cleanBlock(block) {
  const cleaned = { type: block.type };
  const blockData = block[block.type];

  if (blockData && typeof blockData === 'object' && Object.keys(blockData).length > 0) {
    const data = { ...blockData };
    delete data.id;

    // Notion API returns `text` but append API expects `rich_text` for these types
    if (RICH_TEXT_BLOCK_TYPES.has(block.type) && data.text && !data.rich_text) {
      data.rich_text = data.text;
      delete data.text;
    }

    cleaned[block.type] = stripNullValues(data);
  } else {
    // Empty block — provide minimum valid structure for Notion API
    cleaned[block.type] = block.type === 'divider' ? {} : { rich_text: [] };
  }

  return cleaned;
}

/**
 * Fetches all child blocks of a page, handling pagination.
 */
async function fetchAllBlocks(client, pageId, { tracer } = {}) {
  const blocks = [];
  let cursor = undefined;
  let hasMore = true;

  while (hasMore) {
    const path = cursor
      ? `/blocks/${pageId}/children?page_size=100&start_cursor=${cursor}`
      : `/blocks/${pageId}/children?page_size=100`;

    const data = await client.request('GET', path, undefined, { tracer });
    blocks.push(...(data.results || []));
    hasMore = Boolean(data.has_more);
    cursor = data.next_cursor || undefined;
  }

  return blocks;
}

/**
 * Resolves synced blocks in a block list by fetching their children
 * and inlining them as regular blocks.
 *
 * Two-pass approach (ported from n8n "Process All Blocks"):
 *   1. First pass: fetch all synced block children into syncCache
 *   2. Second pass: replace synced_blocks with their cached children
 *
 * Handles one level of nesting (synced block inside a synced block).
 *
 * @param {import('../notion/client.js').NotionClient} client
 * @param {object[]} rawBlocks - blocks from fetchAllBlocks
 * @param {Record<string, object[]>} syncCache - shared cache across pages
 * @param {{ tracer?: object }} opts
 * @returns {Promise<object[]>} resolved block list with synced blocks replaced
 */
async function resolveSyncedBlocks(client, rawBlocks, syncCache, { tracer } = {}) {
  // First pass: populate syncCache for any synced blocks we haven't seen
  for (const block of rawBlocks) {
    if (block.type === 'synced_block') {
      const fetchId = block.synced_block?.synced_from?.block_id || block.id;
      if (fetchId && syncCache[fetchId] === undefined) {
        try {
          const children = await fetchAllBlocks(client, fetchId, { tracer });
          syncCache[fetchId] = children;
        } catch {
          syncCache[fetchId] = [];
        }
      }
    }
  }

  // Second pass: resolve into flat list
  const resolved = [];
  for (const block of rawBlocks) {
    if (block.type === 'synced_block') {
      const fetchId = block.synced_block?.synced_from?.block_id || block.id;
      const children = syncCache[fetchId] || [];

      for (const child of children) {
        // Handle nested synced blocks (one level deep)
        if (child.type === 'synced_block') {
          const nestedId = child.synced_block?.synced_from?.block_id || child.id;
          if (nestedId && syncCache[nestedId] === undefined) {
            try {
              const nestedChildren = await fetchAllBlocks(client, nestedId, { tracer });
              syncCache[nestedId] = nestedChildren;
            } catch {
              syncCache[nestedId] = [];
            }
          }
          for (const nc of (syncCache[nestedId] || [])) {
            resolved.push(nc);
          }
        } else {
          resolved.push(child);
        }
      }
    } else {
      resolved.push(block);
    }
  }

  return resolved;
}

/**
 * Process a single page: fetch blocks, resolve synced blocks, clean, append.
 *
 * @returns {{ blocksWritten: number, success: boolean }}
 */
async function processOnePage(client, templateId, productionId, syncCache, { studyName, tracer } = {}) {
  // 1. Fetch all child blocks from the template page
  const rawBlocks = await fetchAllBlocks(client, templateId, { tracer });
  if (rawBlocks.length === 0) return { blocksWritten: 0, success: false };

  // 2. Resolve synced blocks into real blocks
  const resolved = await resolveSyncedBlocks(client, rawBlocks, syncCache, { tracer });

  // 3. Filter unsupported types + clean for append API
  const children = resolved
    .filter((b) => !UNSUPPORTED_BLOCK_TYPES.has(b.type))
    .map(cleanBlock)
    .slice(0, MAX_BLOCKS_PER_APPEND);

  if (children.length === 0) return { blocksWritten: 0, success: false };

  // 4. Append children to the production page
  await client.request('PATCH', `/blocks/${productionId}/children`, { children }, { tracer });

  return { blocksWritten: children.length, success: true };
}

/**
 * Copies page content blocks from Blueprint template pages to newly created
 * production task pages.
 *
 * @param {import('../notion/client.js').NotionClient} client
 * @param {Record<string, string>} idMapping - { [templateId]: productionId }
 * @param {object} opts
 * @param {string} opts.studyPageId - Study page ID for progress reporting
 * @param {string} opts.studyName - Study name for log messages
 * @param {number} [opts.concurrency] - Max pages processed in parallel (default: 5)
 * @param {import('../services/cascade-tracer.js').CascadeTracer} [opts.tracer]
 * @returns {Promise<{ blocksWrittenCount: number, pagesProcessed: number, pagesSkipped: number }>}
 */
export async function copyBlocks(client, idMapping, { studyPageId, studyName, concurrency, tracer } = {}) {
  const entries = Object.entries(idMapping || {});
  const total = entries.length;
  const maxConcurrency = concurrency ?? DEFAULT_CONCURRENCY;
  let blocksWrittenCount = 0;
  let pagesProcessed = 0;
  let pagesSkipped = 0;

  // Shared across all pages — avoids re-fetching the same synced block source
  const syncCache = {};

  if (tracer) tracer.startPhase('copyBlocks');

  // Process pages in batches for parallel token utilization
  for (let i = 0; i < entries.length; i += maxConcurrency) {
    const batch = entries.slice(i, i + maxConcurrency);

    const results = await Promise.allSettled(
      batch.map(async ([templateId, productionId]) => {
        try {
          return await processOnePage(client, templateId, productionId, syncCache, { studyName, tracer });
        } catch (err) {
          console.log(JSON.stringify({
            event: 'copy_blocks_page_error',
            templateId,
            productionId,
            error: String(err?.message || err).slice(0, 300),
            studyName,
          }));
          return { blocksWritten: 0, success: false };
        }
      }),
    );

    for (const result of results) {
      const value = result.status === 'fulfilled' ? result.value : { blocksWritten: 0, success: false };
      if (value.success) {
        blocksWrittenCount += value.blocksWritten;
        pagesProcessed++;
      } else {
        pagesSkipped++;
      }
    }

    // Progress reporting every PROGRESS_INTERVAL pages
    const processed = pagesProcessed + pagesSkipped;
    if (processed > 0 && processed % PROGRESS_INTERVAL === 0 && studyPageId) {
      try {
        await client.reportStatus(
          studyPageId,
          'info',
          `Copying content: ${processed}/${total} pages...`,
          { tracer },
        );
      } catch {
        // Don't let progress reporting failures kill the operation
      }
    }
  }

  if (tracer) tracer.endPhase('copyBlocks');

  return { blocksWrittenCount, pagesProcessed, pagesSkipped };
}
