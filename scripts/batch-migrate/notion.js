/**
 * Notion API wrapper for batch-migrate orchestrator.
 *
 * Standalone — no dependency on src/notion/client.js. Direct fetch() to the
 * public Notion API. Throttled to ≤ 2 req/s to leave headroom for the live
 * cascade-engine traffic that shares this 3 req/s budget.
 *
 * API version policy:
 *   - default 2022-06-28 (matches the engine's runtime client; queries by `database_id`)
 *   - 2025-09-03 only for the move endpoint, which needs `data_source_id`
 *     (per docs/MIGRATE-STUDY-WEBHOOK.md and ~/memory/notion-api-guide.md §Page Moves)
 */

const NOTION_BASE = 'https://api.notion.com';
const DEFAULT_VERSION = '2022-06-28';
const MOVE_VERSION = '2025-09-03';
const MIN_INTERVAL_MS = 500; // 2 req/s ceiling

let lastRequestAt = 0;

async function throttle() {
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function authHeaders(token, version = DEFAULT_VERSION) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': version,
    'Content-Type': 'application/json',
  };
}

/**
 * Single fetch with throttle, 429 retry-after, and 5xx backoff.
 * Throws structured errors on non-2xx after retries.
 */
async function request(method, url, { token, body, version = DEFAULT_VERSION, retries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    await throttle();
    let resp;
    try {
      resp = await fetch(`${NOTION_BASE}${url}`, {
        method,
        headers: authHeaders(token, version),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (fetchErr) {
      // Connection-level errors (TypeError: fetch failed / terminated /
      // ECONNRESET / socket hang up). Retry with backoff before giving up.
      if (attempt < retries) {
        const wait = 2 ** attempt * 1000;
        console.warn(`[notion] fetch ${url} threw ${fetchErr.message} — retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      throw fetchErr;
    }

    if (resp.ok) {
      const text = await resp.text();
      return text ? JSON.parse(text) : null;
    }

    const errorText = await resp.text().catch(() => '');

    // 429 — honor retry-after
    if (resp.status === 429 && attempt < retries) {
      const retryAfter = Number(resp.headers.get('retry-after')) || 1;
      console.warn(`[notion] 429 ${url} — retrying in ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      attempt++;
      continue;
    }

    // 5xx — exponential backoff
    if (resp.status >= 500 && attempt < retries) {
      const wait = 2 ** attempt * 1000;
      console.warn(`[notion] ${resp.status} ${url} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
      continue;
    }

    const err = new Error(`Notion ${method} ${url} failed: ${resp.status} ${resp.statusText}\n${errorText}`);
    err.status = resp.status;
    err.body = errorText;
    throw err;
  }
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function getPage(pageId, opts) {
  return request('GET', `/v1/pages/${pageId}`, opts);
}

export async function retrieveDb(databaseId, opts) {
  // Use 2025-09-03 so the response includes `data_sources` (needed for move-page).
  return request('GET', `/v1/databases/${databaseId}`, { ...opts, version: MOVE_VERSION });
}

/**
 * Query a database, paginating until exhausted. Returns the full list.
 *
 * Retries from scratch on cursor invalidation (Notion can invalidate cursors
 * mid-pagination under concurrent load — see PR #96 GSK SLE BEACON incident
 * and the engine's parallel implementation at src/notion/client.js#queryDatabase).
 * Throws if all retries are exhausted; never returns partial results, since
 * callers would misinterpret silent undercount as "the dataset is small."
 */
export async function queryDb(databaseId, { filter, sorts } = {}, opts) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const all = [];
    let cursor;
    let cursorFailed = false;
    do {
      const body = { page_size: 100 };
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      if (cursor) body.start_cursor = cursor;
      try {
        const resp = await request('POST', `/v1/databases/${databaseId}/query`, { ...opts, body });
        all.push(...(resp.results || []));
        cursor = resp.has_more ? resp.next_cursor : null;
      } catch (err) {
        if (cursor && err.body && err.body.includes('start_cursor')) {
          if (attempt < maxRetries) {
            console.warn(`[notion] cursor invalidated after ${all.length} results (attempt ${attempt + 1}/${maxRetries + 1}), retrying from scratch`);
          }
          cursorFailed = true;
          break;
        }
        throw err;
      }
    } while (cursor);
    if (!cursorFailed) return all;
  }
  throw new Error(`[notion] queryDb cursor retries exhausted for db ${databaseId}`);
}

export async function search(query, opts) {
  return request('POST', `/v1/search`, { ...opts, body: { query, page_size: 50 } });
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function patchPage(pageId, body, opts) {
  return request('PATCH', `/v1/pages/${pageId}`, { ...opts, body });
}

export async function createPage(parentDatabaseId, properties, opts) {
  return request('POST', `/v1/pages`, {
    ...opts,
    body: { parent: { database_id: parentDatabaseId }, properties },
  });
}

/**
 * Move pages to a different data source — single-page endpoint, called per page.
 *
 * Empirically verified live 2026-04-30: the correct shape is
 *   POST /v1/pages/{page_id}/move
 *   Notion-Version: 2025-09-03
 *   body: { parent: { type: 'data_source_id', data_source_id: '...' } }
 *
 * The body shape `{ data_source_id: '...' }` documented in
 * ~/memory/notion-api-guide.md §Page Moves is INCORRECT — Notion responds with
 * `body failed validation: body.parent should be defined, instead was undefined`.
 * The correct shape uses a parent wrapper, like createPage. notion-api-guide.md
 * has been corrected in the same change that landed this fix.
 *
 * - Properties auto-map by name + type to the target schema
 * - Properties without name+type match in the target are added as new schema
 *   columns (source columns "schema-extend" the destination — be aware)
 * - Page IDs, body blocks, and comments are preserved
 * - Throttled to 2 req/s by `request()`, so 100 pages takes ~50s
 *
 * @param {string[]} pageIds
 * @param {string} destDataSourceId  data_source_id of the target DB
 */
export async function movePages(pageIds, destDataSourceId, opts) {
  if (!pageIds.length) return { moved: [] };
  const moved = [];
  const parentBody = {
    parent: { type: 'data_source_id', data_source_id: destDataSourceId },
  };
  for (const pageId of pageIds) {
    const resp = await request('POST', `/v1/pages/${pageId}/move`, {
      ...opts,
      version: MOVE_VERSION,
      body: parentBody,
    });
    moved.push(resp || { id: pageId });
  }
  return { moved };
}

// ─── Property builders ──────────────────────────────────────────────────────

export const prop = {
  title: (text) => ({ title: [{ type: 'text', text: { content: String(text ?? '') } }] }),
  rich_text: (text) => ({ rich_text: [{ type: 'text', text: { content: String(text ?? '') } }] }),
  relation: (idOrIds) => ({
    relation: (Array.isArray(idOrIds) ? idOrIds : [idOrIds]).filter(Boolean).map((id) => ({ id })),
  }),
  select: (name) => (name ? { select: { name: String(name) } } : { select: null }),
  multi_select: (names) => ({
    multi_select: (names || []).filter(Boolean).map((name) => ({ name: String(name) })),
  }),
  date: (start, end) => (start ? { date: { start, ...(end ? { end } : {}) } } : { date: null }),
  checkbox: (b) => ({ checkbox: !!b }),
  people: (ids) => ({ people: (ids || []).filter(Boolean).map((id) => ({ id })) }),
  url: (u) => ({ url: u || null }),
  number: (n) => ({ number: n == null ? null : Number(n) }),
};

// ─── Property readers ───────────────────────────────────────────────────────

export function readTitle(page, propName = 'Name') {
  const p = page?.properties?.[propName];
  if (!p?.title) return '';
  return p.title.map((t) => t.plain_text || '').join('');
}

export function readRichText(page, propName) {
  const p = page?.properties?.[propName];
  if (!p?.rich_text) return '';
  return p.rich_text.map((t) => t.plain_text || '').join('');
}

export function readRelation(page, propName) {
  const p = page?.properties?.[propName];
  return p?.relation?.map((r) => r.id) || [];
}

export function readSelect(page, propName) {
  return page?.properties?.[propName]?.select?.name || null;
}

export function readMultiSelect(page, propName) {
  return page?.properties?.[propName]?.multi_select?.map((s) => s.name) || [];
}

export function readDate(page, propName) {
  return page?.properties?.[propName]?.date || null;
}

export function readCheckbox(page, propName) {
  return !!page?.properties?.[propName]?.checkbox;
}
