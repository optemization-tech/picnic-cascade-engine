const UNSUPPORTED_BLOCK_TYPES = [
  'child_database',
  'child_page',
  'link_preview',
  'unsupported',
  'table_of_contents',
  'breadcrumb',
  'column_list',
  'column',
  'synced_block',
];

const MAX_BLOCKS_PER_APPEND = 100;
const PROGRESS_INTERVAL = 50;

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
 * - Provides minimum valid structure for empty blocks
 */
export function cleanBlock(block) {
  const cleaned = { type: block.type };
  const blockData = block[block.type];

  if (blockData && typeof blockData === 'object' && Object.keys(blockData).length > 0) {
    const data = { ...blockData };
    delete data.id;
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
 * Copies page content blocks from Blueprint template pages to newly created
 * production task pages.
 *
 * @param {import('../notion/client.js').NotionClient} client
 * @param {Record<string, string>} idMapping - { [templateId]: productionId }
 * @param {object} opts
 * @param {string} opts.studyPageId - Study page ID for progress reporting
 * @param {string} opts.studyName - Study name for log messages
 * @param {import('../services/cascade-tracer.js').CascadeTracer} [opts.tracer]
 * @returns {Promise<{ blocksWrittenCount: number, pagesProcessed: number, pagesSkipped: number }>}
 */
export async function copyBlocks(client, idMapping, { studyPageId, studyName, tracer } = {}) {
  const entries = Object.entries(idMapping || {});
  const total = entries.length;
  let blocksWrittenCount = 0;
  let pagesProcessed = 0;
  let pagesSkipped = 0;

  for (let i = 0; i < entries.length; i++) {
    const [templateId, productionId] = entries[i];

    try {
      // 1. Fetch all child blocks from the template page
      if (tracer) tracer.startPhase('fetchBlocks');
      const rawBlocks = await fetchAllBlocks(client, templateId, { tracer });
      if (tracer) tracer.endPhase('fetchBlocks');

      // 2. Filter out unsupported block types
      const supported = rawBlocks.filter((b) => !UNSUPPORTED_BLOCK_TYPES.includes(b.type));

      // 3. Clean each block
      const children = supported.map(cleanBlock).slice(0, MAX_BLOCKS_PER_APPEND);

      if (children.length === 0) {
        pagesSkipped++;
        continue;
      }

      // 4. Append children to the production page
      if (tracer) tracer.startPhase('appendBlocks');
      await client.request('PATCH', `/blocks/${productionId}/children`, { children }, { tracer });
      if (tracer) tracer.endPhase('appendBlocks');

      blocksWrittenCount += children.length;
      pagesProcessed++;
    } catch (err) {
      pagesSkipped++;
      console.log(JSON.stringify({
        event: 'copy_blocks_page_error',
        templateId,
        productionId,
        error: String(err?.message || err).slice(0, 300),
        studyName,
      }));
      if (tracer) {
        // End any open phases so timing doesn't leak
        tracer.endPhase('fetchBlocks');
        tracer.endPhase('appendBlocks');
      }
      // Error isolation: continue with next page
      continue;
    }

    // 5. Progress reporting every PROGRESS_INTERVAL pages
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

  return { blocksWrittenCount, pagesProcessed, pagesSkipped };
}
